/**
 * opc-console 插件测试（node:test）：
 * - mock ctx + standalone：port 0 自建 node:http，/api/health 可用，unload 后端口关闭；
 * - mock ctx + hosted 显式但无 webServer：apply 不抛、不监听、不做 standalone 回退；
 *   auto 模式同环境回退 standalone；
 * - mock ctx + hosted + fake webServer：捕获 {kind:'prefix', path:'/opcos'} 路由，
 *   /opcos/api/* → API（JSON + OpcError 映射），/opcos/ → 静态 HTML；unload 注销路由；
 * - 启动器注入：buildLauncherInjections 行结构（style/script、类名前缀、幂等、无闭合
 *   标签）；hosted emit `webserver/index-inject` 时 push 两行，launcher:false 不注入，
 *   卸载后退订生效（mock dispatch 与真实 cordis emit 双路径）；
 * - 真实 cordis 4.x：provide 前置与响应式等待（hostedPlugin inject）两种装载路径，
 *   fiber.dispose() 后注销函数被调。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMockContext, type MockContext } from '../../../dsh-adapter/src/index.js'
import {
  apply,
  buildLauncherInjections,
  hostedPlugin,
  name,
  plugin,
  type ConsoleStatus,
  type Config,
  type InjectionRow,
} from './index.js'

/* ─────────────── 测试基建 ─────────────── */

function tmpDataDir(t: import('node:test').TestContext): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'opc-console-plugin-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

/** 六插件服务的最小 stub：/api/health 探测全 loaded、部分端点可点 */
function installOpcServices(ctx: MockContext): void {
  ctx.provideService('opc.team', { formTeam: () => ({}), fallbackTemplates: () => [] })
  ctx.provideService('opc.blackboard', { read: () => [], write: () => ({ status: 'ok' }) })
  ctx.provideService('opc.memory', { write: () => ({}), query: () => [] })
  ctx.provideService('opc.skillforge', { listDrafts: () => [] })
  ctx.provideService('opc.billing', { totalRevenue: () => 0 })
  ctx.provideService('opc.billing.complete', () => ({}))
  ctx.provideService('opc.marketplace.orders', {
    createOrder: () => ({}),
    listByBuyer: () => [],
    stats: () => ({ totalPaid: 0, refunded: 0, netRevenue: 0 }),
  })
  ctx.provideService('opc.marketplace.pay', async () => ({}))
}

/** 捕获 register 调用的 fake DSH webServer（行为对齐 @deepseek-ai/dsh-host-webserver） */
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void> | void
}

function createFakeWebServer(): {
  routes: CapturedRoute[]
  service: { register(route: CapturedRoute): () => void }
  unregistered: () => boolean
} {
  const routes: CapturedRoute[] = []
  let disposed = false
  return {
    routes,
    service: {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => {
          disposed = true
        }
      },
    },
    unregistered: () => disposed,
  }
}

/** 最小 res stub：writeHead/end/setHeader/getHeader（api.ts 的 sendJson/sendFile 所需） */
function createResStub(): ServerResponse & {
  headers: Record<string, unknown>
  body: string
  status: number
} {
  const stub = {
    headers: {} as Record<string, unknown>,
    body: '',
    status: 0,
    headersSent: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      stub.status = status
      if (headers) for (const [k, v] of Object.entries(headers)) stub.headers[k.toLowerCase()] = v
      stub.headersSent = true
      return stub
    },
    setHeader(key: string, value: unknown) {
      stub.headers[key.toLowerCase()] = value
      return stub
    },
    getHeader(key: string) {
      return stub.headers[key.toLowerCase()]
    },
    end(body?: unknown) {
      if (body !== undefined) stub.body = String(body)
    },
    destroy() {
      // headersSent 防护分支，测试不触达
    },
  }
  return stub as unknown as ServerResponse & { headers: Record<string, unknown>; body: string; status: number }
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${message}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function statusOf(ctx: MockContext): ConsoleStatus {
  const status = ctx.getService('opc.console') as ConsoleStatus | undefined
  assert.ok(status, 'opc.console 状态服务应已注册')
  return status
}

/* ─────────────── 插件元数据 ─────────────── */

test('plugin 元数据：name 与 inject 注入声明（hostedPlugin 等待 webServer）', () => {
  assert.equal(name, 'opc-console')
  assert.equal(plugin.name, 'opc-console')
  assert.deepEqual(plugin.inject, [])
  assert.equal(hostedPlugin.name, 'opc-console-hosted')
  assert.deepEqual(hostedPlugin.inject, ['webServer'])
})

/* ─────────────── standalone（mock ctx） ─────────────── */

test('standalone：port 0 自建 http，/api/health 返回 ok；unload 后端口关闭', async (t) => {
  const dataDir = tmpDataDir(t)
  const ctx = createMockContext()
  installOpcServices(ctx)

  const config: Config = { mode: 'standalone', port: 0, host: '127.0.0.1', dataDir }
  apply(ctx, config)

  const status = statusOf(ctx)
  assert.equal(status.mode, 'standalone')
  const { url } = await status.whenReady
  assert.ok(url?.startsWith('http://127.0.0.1:'), `应拿到实际监听地址: ${url}`)

  const res = await fetch(`${url}api/health`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /^application\/json/)
  const body = (await res.json()) as { ok: boolean; plugins: Array<{ name: string; ok: boolean }> }
  assert.equal(body.ok, true, '六个 opc 服务均探测到 → ok')
  assert.deepEqual(
    body.plugins.map((p) => p.name).sort(),
    ['opc-billing', 'opc-blackboard', 'opc-marketplace', 'opc-memory', 'opc-skill-forge', 'opc-team'],
  )

  ctx.unload()
  await status.whenClosed // 端口完全释放
  await assert.rejects(() => fetch(`${url}api/health`), /fetch failed|ECONNREFUSED/, 'unload 后端口应关闭（fetch 拒绝）')
  assert.equal(ctx.getService('opc.console'), undefined, '状态服务应随 unload 撤销')
})

/* ─────────────── hosted 显式 / auto 回退（mock ctx，无 webServer） ─────────────── */

test('hosted 显式但无 webServer：apply 不抛、不监听、不做 standalone 回退', async (t) => {
  const dataDir = tmpDataDir(t)
  const ctx = createMockContext()
  apply(ctx, { mode: 'hosted', dataDir })

  const status = statusOf(ctx)
  assert.equal(status.mode, 'hosted')
  assert.equal(status.url, undefined)
  const info = await status.whenReady
  assert.equal(info.mode, 'hosted')
  assert.equal(info.url, undefined)
  await status.whenClosed // 无自有端口 → 立即 resolve

  ctx.unload()
})

test('auto 模式无 webServer：回退 standalone 并可服务请求', async (t) => {
  const dataDir = tmpDataDir(t)
  const ctx = createMockContext()
  installOpcServices(ctx)
  apply(ctx, { mode: 'auto', port: 0, host: '127.0.0.1', dataDir })

  const status = statusOf(ctx)
  assert.equal(status.mode, 'standalone', 'auto 无 webServer → standalone 回退')
  const { url } = await status.whenReady
  assert.ok(url)
  const res = await fetch(`${url}api/health`)
  assert.equal(res.status, 200)

  ctx.unload()
  await status.whenClosed
})

/* ─────────────── hosted + fake webServer（mock ctx） ─────────────── */

test('hosted：捕获 /opcos prefix 路由；api → JSON，静态 → HTML；unload 注销', async (t) => {
  const dataDir = tmpDataDir(t)
  const fake = createFakeWebServer()
  const ctx = createMockContext()
  installOpcServices(ctx)
  ctx.provideService('webServer', fake.service)

  apply(ctx, { mode: 'hosted', dataDir })

  assert.equal(fake.routes.length, 1, '应注册恰好一条路由')
  const route = fake.routes[0] as CapturedRoute
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/opcos')

  // /opcos/api/health → 剥前缀进 API 层，JSON + ok
  const jsonRes = createResStub()
  await route.handler({ url: '/opcos/api/health', headers: {} } as IncomingMessage, jsonRes)
  assert.match(jsonRes.body, /"ok":true/)
  assert.match(String(jsonRes.headers['content-type']), /^application\/json/)

  // /opcos/ → 剥前缀得 / → index.html/占位页
  const htmlRes = createResStub()
  await route.handler({ url: '/opcos/', headers: {} } as IncomingMessage, htmlRes)
  assert.match(String(htmlRes.headers['content-type']), /^text\/html/)
  assert.equal(htmlRes.status, 200)

  ctx.unload()
  assert.ok(fake.unregistered(), 'unload 后应调用 register 返回的注销函数')
})

/* ─────────────── 官方 GUI 启动器注入（webserver/index-inject） ─────────────── */

test('buildLauncherInjections：style+script 两行；类名前缀 / 按钮 id / basePath / 幂等标记 / 无闭合标签', () => {
  const rows = buildLauncherInjections()
  assert.equal(rows.length, 2, '按钮由脚本创建：仅 style + script 两行，无 html 行')
  const style = rows[0] as Extract<InjectionRow, { kind: 'style' }>
  const script = rows[1] as Extract<InjectionRow, { kind: 'script' }>
  assert.equal(style.kind, 'style')
  assert.equal(script.kind, 'script')
  assert.equal(script.placement, 'body', '内联脚本放 body')

  // style：opc-launcher- 前缀类名、右下角按钮、高 z-index、遮罩与关闭按钮样式
  assert.match(style.text, /\.opc-launcher-/, '类名全部 opc-launcher- 前缀（防冲突）')
  assert.match(style.text, /z-index:\s*2147483000/, 'z-index 高于官方 UI')
  assert.match(style.text, /\.opc-launcher-overlay/, '含全屏遮罩样式')
  assert.match(style.text, /\.opc-launcher-close/, '含关闭按钮样式')
  assert.ok(!style.text.includes('</style'), 'style.text 不得含闭合标签序列')

  // script：按钮/遮罩 id、默认 basePath、幂等（id 检测）、按钮文案、无闭合序列
  assert.ok(script.text.includes('opc-launcher-btn'), '按钮 id')
  assert.ok(script.text.includes('opc-launcher-overlay'), '遮罩 id')
  assert.ok(script.text.includes('getElementById'), '幂等：getElementById id 检测防重复创建')
  assert.ok(script.text.includes('/opcos/'), 'iframe 指向默认 basePath=/opcos')
  assert.ok(script.text.includes('⚡ OPC-OS'), '按钮文案')
  assert.ok(script.text.includes("createElement('iframe')"), 'iframe 经 DOM API 创建（脚本不拼 raw html、不发起外部请求）')
  assert.ok(!script.text.includes('</script'), 'script.text 不得含闭合序列')

  // 自定义 basePath：去尾斜杠后拼 '/xx/'，不再出现默认路径
  const custom = buildLauncherInjections({ basePath: '/custom-console///' })
  const customScript = custom[1] as Extract<InjectionRow, { kind: 'script' }>
  assert.ok(customScript.text.includes('"/custom-console/"'), `实际: ${customScript.text.match(/CONSOLE_URL = .*/)?.[0]}`)
  assert.ok(!customScript.text.includes('/opcos/'))
})

test('hosted 注入（mock）：emit webserver/index-inject push style+script；launcher:false 不注入；unload 后退订生效', async (t) => {
  const dataDir = tmpDataDir(t)
  const fake = createFakeWebServer()

  // 默认 launcher=true：emit 后数组获得两行
  const ctx = createMockContext()
  installOpcServices(ctx)
  ctx.provideService('webServer', fake.service)
  apply(ctx, { mode: 'hosted', dataDir })

  const table: unknown[] = []
  ctx.dispatch('webserver/index-inject', table)
  assert.equal(table.length, 2, 'emit 后应 push 恰好 style+script 两行')
  assert.equal((table[0] as InjectionRow).kind, 'style')
  assert.equal((table[1] as InjectionRow).kind, 'script')

  // 再次 emit（模拟下一页渲染）：每次渲染各得一份行，行为稳定
  const secondPage: unknown[] = []
  ctx.dispatch('webserver/index-inject', secondPage)
  assert.equal(secondPage.length, 2)

  // 卸载后退订生效：emit 不再注入
  ctx.unload()
  ctx.dispatch('webserver/index-inject', table)
  assert.equal(table.length, 2, 'unload 后 emit 不应继续注入')

  // launcher:false：跳过注入
  const ctxOff = createMockContext()
  installOpcServices(ctxOff)
  ctxOff.provideService('webServer', fake.service)
  apply(ctxOff, { mode: 'hosted', dataDir, launcher: false })
  const tableOff: unknown[] = []
  ctxOff.dispatch('webserver/index-inject', tableOff)
  assert.equal(tableOff.length, 0, 'launcher:false 时 emit 后数组应为空')
  ctxOff.unload()
})

/* ─────────────── 真实 cordis 4.x ─────────────── */

interface CordisContextLike {
  plugin(p: unknown, ...args: unknown[]): { dispose: () => Promise<void> } & PromiseLike<unknown>
  provide(name: string, value?: unknown): unknown
  /** 同步派发事件（监听器按注册序收到 emit 参数） */
  emit(name: string, ...args: unknown[]): unknown
}

async function loadCordis(): Promise<{ new (): CordisContextLike }> {
  const mod = (await import('@deepseek-ai/cordis')) as { Context: new () => CordisContextLike }
  return mod.Context
}

test('真实 cordis：webServer 先行 provide，plugin(mode=hosted) 挂载并在 dispose 时注销', async (t) => {
  const dataDir = tmpDataDir(t)
  const Context = await loadCordis()
  const ctx = new Context()
  const fake = createFakeWebServer()
  ctx.provide('webServer', fake.service)

  const fiber = ctx.plugin(plugin, { mode: 'hosted', dataDir })
  await waitUntil(() => fake.routes.length > 0, '真实 cordis 应将 /opcos 路由注册进 webServer')
  assert.equal(fake.routes.length, 1)
  assert.equal((fake.routes[0] as CapturedRoute).kind, 'prefix')
  assert.equal((fake.routes[0] as CapturedRoute).path, '/opcos')

  await fiber.dispose()
  assert.ok(fake.unregistered(), 'fiber.dispose 后注销函数应被调')
})

test('真实 cordis：hosted 下 emit webserver/index-inject 注入启动器；dispose 后退订生效', async (t) => {
  const dataDir = tmpDataDir(t)
  const Context = await loadCordis()
  const ctx = new Context()
  const fake = createFakeWebServer()
  ctx.provide('webServer', fake.service)

  const fiber = ctx.plugin(plugin, { mode: 'hosted', dataDir })
  await waitUntil(() => fake.routes.length > 0, '真实 cordis 应先完成 /opcos 路由挂载')

  // 官方 GUI 渲染路径：ctx.emit 把注入表发给监听器（每次渲染各得一份行）
  const table: unknown[] = []
  ctx.emit('webserver/index-inject', table)
  assert.equal(table.length, 2, 'emit 后应 push style+script 两行')
  assert.equal((table[0] as InjectionRow).kind, 'style')
  assert.equal((table[1] as InjectionRow).kind, 'script')

  // fiber.dispose → onEvent 监听器随插件卸载退订，之后 emit 不再注入
  await fiber.dispose()
  ctx.emit('webserver/index-inject', table)
  assert.equal(table.length, 2, 'dispose 后 emit 不应继续注入')
})

test('真实 cordis：hostedPlugin 在 webServer 就绪前装载 → provide 后响应式挂载', async (t) => {
  const dataDir = tmpDataDir(t)
  const Context = await loadCordis()
  const ctx = new Context()
  const fake = createFakeWebServer()

  // webServer 尚未提供：inject: ['webServer'] 使 fiber 等待（不 apply、不注册）
  const fiber = ctx.plugin(hostedPlugin, { dataDir })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(fake.routes.length, 0, 'webServer 未就绪时应保持等待')

  // 官方 web server 就绪 → cordis notify → 插件 apply → 路由挂载
  ctx.provide('webServer', fake.service)
  await waitUntil(() => fake.routes.length > 0, 'provide 后应响应式挂载 /opcos 路由')
  assert.equal(fake.routes.length, 1)
  assert.equal((fake.routes[0] as CapturedRoute).path, '/opcos')

  await fiber.dispose()
  assert.ok(fake.unregistered(), 'fiber.dispose 后注销函数应被调')
})
