/**
 * opc-console —— OPC-OS 统一控制台的 DSH 插件形态。
 *
 * 复用 packages/opcos-console/src/api.ts 的请求处理层（12 个 REST 端点 + 静态资源 +
 * OpcError 错误映射），按 Config.mode 决定挂载方式：
 *
 * - hosted：注册 DSH 官方 webServer 的 `{ kind: 'prefix', path: '/opcos' }` 路由
 *   （完整响应生命周期的 node:http req/res；官方 `/api` 前缀被 DSH 占用，本插件
 *   只用 `/opcos` 顶层前缀）。路由经 ctx.onDispose 挂 register 返回的注销函数，
 *   插件卸载自动撤销；webServer 缺席时仅告警不启动（hosted 显式模式不回退）。
 *   并订阅官方 `webserver/index-inject` 事件，向官方 GUI 每个页面的 index.html
 *   注入「⚡ OPC-OS」启动器按钮 + 全屏 iframe 遮罩（buildLauncherInjections，
 *   Config.launcher=false 可关闭；standalone 无官方 GUI，不注入）。
 * - standalone：自建 node:http（config.port/config.host），行为同 startConsole。
 * - auto（默认）：探测 `webServer` 服务——有走 hosted，没有回退 standalone。
 *
 * 服务依赖全部经 ctx.getService 运行时软解析（opc.team / opc.blackboard /
 * opc.memory / opc.skillforge / opc.billing / opc.billing.complete /
 * opc.marketplace.orders / opc.marketplace.pay），市场索引与签名包仓库自建
 * （createMarketCatalog：SqliteSkillIndex + 库空预置 3 条示例 + createPackage 密钥），
 * 埋点订阅三个 TelemetryBus（subscribeTelemetry）。
 *
 * 推荐在 dsh profile 中使用 `hostedPlugin` 入口：`inject: ['webServer']` 使 cordis
 * 响应式等待官方 web server 就绪后再挂载。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'

import { defineOpcPlugin, type OpcContext, type TelemetryEvent } from '../../../dsh-adapter/src/index.js'
import {
  createApiSetup,
  createMarketCatalog,
  handleApiRequest,
  handleConsoleRequest,
  serveStatic,
  subscribeTelemetry,
  type ConsoleSetup,
} from '../../../opcos-console/src/api.js'

export const name = 'opc-console'

export interface Config {
  /** 挂载模式（默认 'auto'：有 webServer 走 hosted，否则 standalone） */
  mode?: 'auto' | 'standalone' | 'hosted'
  /** standalone 监听端口（默认 3000；0 = 随机可用端口） */
  port?: number
  /** 数据目录：skills.db / installed/ / 隔离清单 / 计费日志（默认 ./opcos-console-data） */
  dataDir?: string
  /** standalone 监听地址（默认 '127.0.0.1'） */
  host?: '127.0.0.1' | '0.0.0.0'
  /** hosted 模式是否向官方 GUI 注入 OPC-OS 启动器（默认 true；standalone 下无意义） */
  launcher?: boolean
  /**
   * hosted 挂载鉴权（standalone 无官方 web 会话，不适用）：
   * - 'inherit'（默认）：每个请求校验官方 DSH web 会话 cookie 的存在性——
   *   cookie 名前缀 `dsh-auth-`（dsh-client-connection BrowserAuth 铸造，名为
   *   `dsh-auth-` + base64url(sha256(host authority))），存在且值非空才放行，
   *   否则 401（对齐官方 writeUnauthorized：no-store + text/plain）。
   *   注意：存在性校验不等于验签——HMAC 校验需要宿主 credentials 里的会话密钥，
   *   插件侧不可得；本校验只挡未登录浏览器的顺手访问，生产环境仍需反向代理
   *   或网关完成真正的鉴权。
   * - 'off'：不校验（已有反代/网关鉴权，或纯内网部署时使用）。
   */
  auth?: 'inherit' | 'off'
}

/** DSH webServer 路由（结构子集，见 @deepseek-ai/dsh-host-webserver 的 register 契约） */
interface DshWebServerRoute {
  /** 'exact' 精确匹配 | 'prefix' 最长前缀胜出 */
  kind: 'exact' | 'prefix'
  /** 绝对路径、无尾斜杠 */
  path: string
  /** 标准 node:http req/res，拥有完整响应生命周期 */
  handler(req: IncomingMessage, res: ServerResponse): Promise<void> | void
}

/** DSH webServer 服务（结构子集）：注册路由返回注销函数；同名 (kind,path) 重复注册抛错 */
interface DshWebServer {
  register(route: DshWebServerRoute): () => void
}

/** 运行状态服务（ctx.getService('opc.console')）：测试与宿主可观测 */
export interface ConsoleStatus {
  readonly mode: 'standalone' | 'hosted'
  /** standalone 监听地址（hosted 恒 undefined：URL 由 DSH webServer 决定） */
  readonly url?: string
  /** standalone 在 listen 成功后 resolve（失败 reject）；hosted 立即 resolve */
  readonly whenReady: Promise<{ mode: 'standalone' | 'hosted'; url?: string }>
  /** 端口/路由完全释放后 resolve（hosted 注册即视为无自有端口，立即 resolve） */
  readonly whenClosed: Promise<void>
}

const PREFIX = '/opcos'
const DEFAULT_PORT = 3000
const DEFAULT_DATA_DIR = './opcos-console-data'
const DEFAULT_HOST = '127.0.0.1'
const HOSTED_BASE = 'http://opcos-console.hosted'
/** 官方 web 会话 cookie 名前缀（dsh-client-connection BrowserAuth：`dsh-auth-` + base64url(sha256(authority))） */
const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/**
 * hosted 鉴权（auth='inherit'）：cookie 存在性校验——cookie 头中存在名字以
 * `dsh-auth-` 开头且值非空的条目即放行。这不是验签（HMAC 校验需要宿主持有的
 * 会话密钥，插件侧拿不到），生产仍需反代/网关（见 Config.auth 注释）。
 */
function hasDshAuthCookie(req: IncomingMessage): boolean {
  const header = req.headers.cookie
  if (typeof header !== 'string' || header.length === 0) return false
  for (const segment of header.split(';')) {
    const eq = segment.indexOf('=')
    if (eq === -1) continue
    if (segment.slice(0, eq).trim().startsWith(AUTH_COOKIE_PREFIX) && segment.slice(eq + 1).trim().length > 0) {
      return true
    }
  }
  return false
}

/** 401 响应（对齐官方 writeUnauthorized：no-store + text/plain，HEAD 无响应体） */
function writeUnauthorized(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(401, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
  })
  res.end(req.method === 'HEAD' ? undefined : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
}

function isWebServer(value: unknown): value is DshWebServer {
  return typeof value === 'object' && value !== null && typeof (value as DshWebServer).register === 'function'
}

/**
 * 组装 ConsoleDeps → ConsoleSetup（服务软解析 + 自建市场目录 + 埋点环形数组）。
 * 一次性副作用（skills.db、示例技能）在此发生；埋点退订与 index.close 的
 * 清理一并注册进 ctx.onDispose。
 */
function createSetup(ctx: OpcContext, dataDir: string): ConsoleSetup {
  const getService = (serviceName: string): unknown => ctx.getService(serviceName)

  // 一次性初始化：市场索引 + 库空预置 3 条示例 + createPackage 密钥（照搬 server.ts）
  const { index, pkgStore, publicKeyPem } = createMarketCatalog(join(dataDir, 'skills.db'))

  // 埋点：订阅三个 TelemetryBus，收集环形数组
  const ring: TelemetryEvent[] = []
  const telemetryUnsubs = subscribeTelemetry(getService, ring)

  // 关停（LIFO）：市场索引最后关——先撤路由/HTTP server，再退订埋点，最后 close 索引
  ctx.onDispose(() => index.close())
  ctx.onDispose(() => {
    for (const off of telemetryUnsubs) off()
    telemetryUnsubs.length = 0
  })

  return createApiSetup({
    getService,
    skillsIndex: index,
    pkgStore,
    publicKeyPem,
    installedDir: join(dataDir, 'installed'),
    billingLogFile: join(dataDir, 'billing.jsonl'),
    quarantineFile: join(dataDir, 'opcos-quarantine.json'),
    telemetry: ring,
    // handshake 缺省 → /api/health 按服务可用性实时探测（probeHandshake）
  })
}

/** hosted：注册 /opcos prefix 路由（/opcos/api/* → API，其余剥前缀走静态）并挂注销；
 * auth='inherit'（默认）时每个请求先做 dsh-auth-* cookie 存在性校验（'off' 跳过） */
function mountHosted(ctx: OpcContext, setup: ConsoleSetup, webServer: DshWebServer, auth: 'inherit' | 'off'): void {
  const route: DshWebServerRoute = {
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => {
      if (auth !== 'off' && !hasDshAuthCookie(req)) {
        writeUnauthorized(req, res)
        return
      }
      const pathname = new URL(req.url ?? '/', HOSTED_BASE).pathname
      if (pathname === `${PREFIX}/api` || pathname.startsWith(`${PREFIX}/api/`)) {
        return handleApiRequest(req, res, setup, PREFIX)
      }
      // /opcos 与 /opcos/ 剥前缀后得 '/' → index.html/占位页；/opcos/app.js → static/app.js
      return serveStatic(req, res, setup, PREFIX)
    },
  }
  // 官方范式（dsh-client-connection）：webCtx.effect(() => webServer.register(route))；
  // 适配层等价写法：注册拿注销函数，onDispose 挂到插件卸载链
  const unregister = webServer.register(route)
  ctx.onDispose(unregister)
  console.log(`[opc-console] hosted: ${PREFIX} 路由已挂载 DSH webServer`)
}

/* ─────────────── 官方 GUI 启动器注入（webserver/index-inject） ─────────────── */

/** index.html 注入区域（官方 IndexInjectionPlacement 结构子集） */
export type IndexInjectionPlacement = 'head' | 'body'

/**
 * DSH 官方 `webserver/index-inject` 事件表行（照
 * @deepseek-ai/dsh-host-webserver injections.d.ts 的 union 写结构子集，
 * 不 import 官方包；行须 JSON 可序列化）。
 */
export type InjectionRow =
  | { kind: 'global'; name: string; value: unknown }
  | { kind: 'script'; placement: IndexInjectionPlacement; text: string }
  | { kind: 'script-src'; placement: IndexInjectionPlacement; src: string }
  | { kind: 'script-preload'; src: string }
  | { kind: 'style'; text: string }
  | { kind: 'html'; placement: IndexInjectionPlacement; html: string }

export interface LauncherInjectionOptions {
  /** 控制台挂载前缀（默认 '/opcos'；iframe 指向 `${basePath}/`） */
  basePath?: string
}

const LAUNCHER_BTN_ID = 'opc-launcher-btn'
const LAUNCHER_OVERLAY_ID = 'opc-launcher-overlay'
/** 高于一切官方 UI 的 z-index（0x7FFFFFF0 级，留余量给调试层） */
const LAUNCHER_Z_INDEX = 2147483000

/** 启动器样式：类名全部 `opc-launcher-` 前缀防冲突；深色主题右下角按钮 + 全屏 iframe 遮罩 */
const LAUNCHER_STYLE_TEXT = [
  `.opc-launcher-btn{position:fixed;right:24px;bottom:24px;z-index:${LAUNCHER_Z_INDEX};margin:0;padding:10px 18px;`,
  'border:none;border-radius:999px;background:#0f172a;color:#e2e8f0;font:600 14px/1 system-ui,-apple-system,sans-serif;',
  'letter-spacing:.02em;box-shadow:0 6px 20px rgba(2,6,23,.4);cursor:pointer;opacity:.88;',
  'transition:opacity .15s ease,transform .15s ease,box-shadow .15s ease;}',
  `.opc-launcher-btn:hover{opacity:1;transform:translateY(-2px);box-shadow:0 10px 28px rgba(2,6,23,.55);}`,
  '.opc-launcher-btn:active{transform:translateY(0);}',
  '.opc-launcher-btn:focus-visible{outline:2px solid #38bdf8;outline-offset:2px;}',
  `.opc-launcher-overlay{position:fixed;inset:0;z-index:${LAUNCHER_Z_INDEX};display:none;background:rgba(2,6,23,.72);}`,
  '.opc-launcher-overlay.opc-launcher-open{display:block;}',
  '.opc-launcher-frame{position:absolute;inset:0;width:100%;height:100%;border:none;background:#0b1120;}',
  '.opc-launcher-close{position:absolute;top:14px;right:18px;z-index:1;width:32px;height:32px;padding:0;border:none;',
  'border-radius:8px;background:#1e293b;color:#e2e8f0;font:600 15px/1 system-ui,sans-serif;cursor:pointer;',
  'transition:background .15s ease;}',
  '.opc-launcher-close:hover{background:#334155;}',
  /* 浅色宿主（.opc-light 由脚本按宿主主题标记切换）：按钮/遮罩/关闭按钮浅色变体 */
  '.opc-launcher-btn.opc-light{background:#eef1f8;color:#1c2333;box-shadow:0 6px 20px rgba(28,35,51,.22);}',
  '.opc-launcher-btn.opc-light:hover{box-shadow:0 10px 28px rgba(28,35,51,.3);}',
  '.opc-launcher-overlay.opc-light{background:rgba(28,35,51,.45);}',
  '.opc-launcher-overlay.opc-light .opc-launcher-frame{background:#f5f7fb;}',
  '.opc-launcher-overlay.opc-light .opc-launcher-close{background:#e2e7f2;color:#1c2333;}',
  '.opc-launcher-overlay.opc-light .opc-launcher-close:hover{background:#cfd6e8;}',
].join('')

/**
 * 构造启动器注入行（纯函数，便于单测）：style + body 内联 script 两行。
 *
 * - 脚本幂等：经 getElementById(id) 检测，重复注入不重复创建按钮/遮罩；
 * - 深链：按钮创建时读官方页面 URL 的 ?opcos-panel=<name>（缺省 overview），
 *   打开遮罩时 iframe src = basePath + '/?panel=' + encodeURIComponent(panel)，
 *   控制台前端（app.js）读自己的 ?panel= 初始路由到对应面板；
 * - 主题联动（best-effort）：检测宿主 html/body 的官方深浅色标记
 *   （body[data-ds-dark-theme] 与 html style.colorScheme，见 dsh-client-ui-theme
 *   bootThemeScript），其余宿主按 class/data-theme 的 light/dark 词匹配，
 *   找不到浅色标记保持深色默认；命中浅色给按钮与遮罩加 'opc-light' 类
 *   （style 行含浅色变体）；
 * - a11y：打开遮罩焦点移入关闭按钮、Esc 关闭、关闭后焦点还原启动器按钮；
 * - 遮罩含全屏 iframe（懒创建：首次点击才建，平时不发起任何对 /opcos 的请求）；
 * - 内联文本不含闭合标签序列（basePath 剔除 '<'，JSON.stringify 转义引号）。
 */
export function buildLauncherInjections(options?: LauncherInjectionOptions): InjectionRow[] {
  const basePath = (options?.basePath ?? PREFIX).replace(/\/+$/, '').replace(/</g, '')
  const consoleUrl = `${basePath}/`
  const scriptText = `(function () {
  'use strict';
  var CONSOLE_URL = ${JSON.stringify(consoleUrl)};
  var BTN_ID = ${JSON.stringify(LAUNCHER_BTN_ID)};
  var OVERLAY_ID = ${JSON.stringify(LAUNCHER_OVERLAY_ID)};
  /* 深链：官方 GUI 页面 URL 的 ?opcos-panel=<name>（无参数默认 overview） */
  var PANEL = 'overview';
  try {
    var requested = new URLSearchParams(location.search).get('opcos-panel');
    if (typeof requested === 'string' && requested.length > 0) PANEL = requested;
  } catch (error) { /* 无 URLSearchParams 的环境：保持默认面板 */ }
  function isOpen(overlay) {
    return !!(overlay && overlay.classList.contains('opc-launcher-open'));
  }
  function hostPrefersLight() {
    var root = document.documentElement;
    var body = document.body;
    if (body && body.hasAttribute('data-ds-dark-theme')) return false; /* 官方深色标记 */
    var scheme = (root && root.style && root.style.colorScheme) || '';
    if (!scheme && root && typeof getComputedStyle === 'function') {
      try { scheme = getComputedStyle(root).colorScheme || ''; } catch (error) { /* 忽略 */ }
    }
    if (scheme === 'light') return true; /* 官方 boot 脚本写 html style.colorScheme */
    if (scheme === 'dark') return false;
    var marker = ' ';
    if (root) marker += (root.getAttribute('data-theme') || '') + ' ' + String(root.className || '') + ' ';
    if (body) marker += (body.getAttribute('data-theme') || '') + ' ' + String(body.className || '') + ' ';
    marker = marker.toLowerCase().replace(/[^a-z0-9_-]+/g, ' ');
    if (marker.indexOf(' light ') !== -1 || marker.indexOf('light-theme') !== -1 || marker.indexOf('theme-light') !== -1) return true;
    if (marker.indexOf(' dark ') !== -1 || marker.indexOf('dark-theme') !== -1 || marker.indexOf('theme-dark') !== -1) return false;
    return false; /* 找不到浅色标记：保持深色默认 */
  }
  function applyHostTheme(el) {
    if (el) el.classList.toggle('opc-light', hostPrefersLight());
  }
  function ensureOverlay() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'opc-launcher-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'OPC-OS console');
    var frame = document.createElement('iframe');
    frame.className = 'opc-launcher-frame';
    frame.src = CONSOLE_URL + '?panel=' + encodeURIComponent(PANEL);
    frame.setAttribute('title', 'OPC-OS console');
    overlay.appendChild(frame);
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'opc-launcher-close';
    close.textContent = '\\u2715';
    close.setAttribute('aria-label', 'Close OPC-OS console');
    close.addEventListener('click', function () { setOpen(false); });
    overlay.appendChild(close);
    /* Esc 关闭（打开时焦点已移入遮罩内，keydown 可达） */
    overlay.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setOpen(false);
    });
    document.body.appendChild(overlay);
    return overlay;
  }
  function setOpen(open) {
    var overlay = open ? ensureOverlay() : document.getElementById(OVERLAY_ID);
    if (overlay) {
      overlay.classList.toggle('opc-launcher-open', open);
      applyHostTheme(overlay);
    }
    var btn = document.getElementById(BTN_ID);
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      applyHostTheme(btn);
    }
    /* a11y：打开遮罩焦点移入关闭按钮；关闭后焦点还原启动器按钮 */
    if (open) {
      var close = overlay ? overlay.querySelector('.opc-launcher-close') : null;
      if (close) close.focus();
    } else if (overlay && btn) {
      btn.focus();
    }
  }
  function mountButton() {
    if (document.getElementById(BTN_ID)) return; /* 幂等：id 检测，重复注入不重复创建 */
    var btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'opc-launcher-btn';
    btn.textContent = '⚡ OPC-OS';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', function () { setOpen(!isOpen(document.getElementById(OVERLAY_ID))); });
    applyHostTheme(btn);
    document.body.appendChild(btn);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountButton);
  } else {
    mountButton();
  }
})();`
  return [
    { kind: 'style', text: LAUNCHER_STYLE_TEXT },
    { kind: 'script', placement: 'body', text: scriptText },
  ]
}

/**
 * hosted：订阅官方 `webserver/index-inject`（emit 型：每次 index.html 渲染触发，
 * 监听器向行数组 push；官方用例见 dsh-client-connection lib/index.js 758-766）。
 *
 * 已知边界：若本插件晚于官方 GUI 首次渲染加载，注入从下一次渲染起生效——
 * 每次渲染 emit 读取的是注册时点的监听器集合。退订经 onDispose 挂链，
 * 插件卸载后 emit 不再注入。
 */
function mountLauncherInjection(ctx: OpcContext): void {
  const offInject = ctx.onEvent('webserver/index-inject', (payload: unknown) => {
    ;(payload as InjectionRow[]).push(...buildLauncherInjections({ basePath: PREFIX }))
  })
  ctx.onDispose(offInject)
  console.log('[opc-console] hosted: OPC-OS 启动器已订阅 webserver/index-inject（官方 GUI 每页注入）')
}

/** standalone：自建 node:http（行为同 startConsole），listen 成功/失败经 whenReady 上报 */
function startStandalone(
  ctx: OpcContext,
  setup: ConsoleSetup,
  config: Config,
  reportReady: (info: { mode: 'standalone'; url?: string }, error?: unknown) => void,
  reportClosed: () => void,
): void {
  const server: Server = createServer((req, res) => {
    void handleConsoleRequest(req, res, setup)
  })
  server.on('error', (error) => {
    console.error('[opc-console] standalone server error:', error)
    reportReady({ mode: 'standalone' }, error)
  })
  server.listen(config.port ?? DEFAULT_PORT, config.host ?? DEFAULT_HOST, () => {
    const address = server.address() as AddressInfo | null
    if (address === null || typeof address === 'string') {
      const error = new Error('opc-console: failed to determine listening address (unix socket unsupported)')
      console.error('[opc-console]', error.message)
      reportReady({ mode: 'standalone' }, error)
      return
    }
    const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address
    reportReady({ mode: 'standalone', url: `http://${displayHost}:${address.port}/` })
  })
  ctx.onDispose(() => {
    void new Promise<void>((resolveClose) => {
      server.close(() => resolveClose())
      server.closeAllConnections()
    }).then(reportClosed)
  })
}

export function apply(ctx: OpcContext, config: Config): void {
  const mode = config.mode ?? 'auto'
  const dataDir = resolve(config.dataDir ?? DEFAULT_DATA_DIR)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  const setup = createSetup(ctx, dataDir)

  // 运行状态服务（供测试与宿主观测；unload 后随服务表一并撤销）
  let status: { mode: 'standalone' | 'hosted'; url?: string } = { mode: 'hosted' }
  let readyResolve: (info: { mode: 'standalone' | 'hosted'; url?: string }) => void = () => undefined
  let readyReject: (error: unknown) => void = () => undefined
  let markClosed: () => void = () => undefined
  const whenReady = new Promise<{ mode: 'standalone' | 'hosted'; url?: string }>((res, rej) => {
    readyResolve = res
    readyReject = rej
  })
  const whenClosed = new Promise<void>((res) => {
    markClosed = res
  })
  whenReady.catch(() => undefined) // 无人 await 时避免 unhandledRejection
  ctx.provideService('opc.console', {
    get mode(): 'standalone' | 'hosted' {
      return status.mode
    },
    get url(): string | undefined {
      return status.url
    },
    whenReady,
    whenClosed,
  } satisfies ConsoleStatus)

  const reportReady = (info: { mode: 'standalone'; url?: string }, error?: unknown): void => {
    if (error !== undefined) readyReject(error)
    else readyResolve(info)
  }

  // 模式裁决：hosted 优先探测，webServer 缺席时按显式/自动分派
  const auth = config.auth ?? 'inherit'
  const webServer = mode === 'standalone' ? undefined : ctx.getService('webServer')
  if (isWebServer(webServer)) {
    mountHosted(ctx, setup, webServer, auth)
    if (config.launcher !== false) mountLauncherInjection(ctx) // 官方 GUI 每页注入启动器
    status = { mode: 'hosted' }
    readyResolve({ mode: 'hosted' })
    markClosed() // 无自有端口，注册即视为无端口可关
  } else if (mode === 'hosted') {
    console.warn(
      `[opc-console] mode=hosted 但宿主未提供 webServer 服务：控制台不启动（hosted 显式模式不做 standalone 回退）。` +
        `可改用 mode='auto'，或使用 hostedPlugin（inject: ['webServer'] 响应式等待 web server 就绪）。`,
    )
    readyResolve({ mode: 'hosted' })
    markClosed()
  } else {
    // mode === 'standalone'，或 auto 且宿主无 webServer → standalone 回退
    status = { mode: 'standalone' }
    startStandalone(
      ctx,
      setup,
      config,
      (info, error) => {
        if (error === undefined) status = info
        reportReady(info, error)
      },
      markClosed,
    )
  }
}

/** 默认插件：standalone 优先（mode='auto' 探测 webServer，缺席回退自建 node:http） */
export const plugin = defineOpcPlugin<Config>({
  name,
  defaultConfig: { mode: 'auto', port: DEFAULT_PORT, launcher: true, auth: 'inherit' },
  apply,
})

/** hosted 专用入口：inject: ['webServer'] 响应式等待 DSH web server 就绪后再挂载（推荐 profile 用法） */
export const hostedPlugin = defineOpcPlugin<Config>({
  name: 'opc-console-hosted',
  inject: ['webServer'],
  defaultConfig: { mode: 'hosted', port: DEFAULT_PORT, launcher: true, auth: 'inherit' },
  apply: (ctx, config) => apply(ctx, { ...config, mode: 'hosted' }),
})

// 模块 default 导出供 cordis-plugin-loader 取用（exports.default ?? exports）。
// DSH profile 场景用 hostedPlugin（inject:['webServer'] 响应式等待官方 web server）；
// 无 headless 回退需求——headless profile 下 dormant 即可。auto 变体保留为具名导出。
export default hostedPlugin
