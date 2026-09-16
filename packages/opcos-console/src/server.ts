/**
 * opcos-console —— OPC-OS 统一控制台 HTTP 服务（standalone 入口）。
 *
 * 启动链路（零外部运行时依赖，仅 node:http / node:sqlite / cordis）：
 * 1. 数据目录（默认 ./opcos-console-data，mkdir 0700，隔离清单与启动 marker 全部落在其中）；
 * 2. 真实 cordis 4.x `new Context()`，经 loadWithHandshake 守护装载七个 opc-* 插件
 *    （失败插件进隔离清单不阻断宿主，AR-R02）；
 * 3. createMarketCatalog（api.ts）：SqliteSkillIndex 市场索引；库空时预置 3 条示例
 *    MarketSkill，并用 createPackage 生成对应签名的 .dshpkg 存内存 pkgStore；
 * 4. subscribeTelemetry（api.ts）：订阅三个 TelemetryBus，收集环形数组；
 *    content_publish 事件由 createApiSetup 阶段订阅 'opc.content.events' 进独立环形数组；
 * 5. node:http 服务器（请求处理层在 ./api.ts）：/ 与 /app.js、/style.css 等静态资源
 *    自 ../static/ 读取，/api/* 提供 REST 契约，统一把 OpcError 映射为
 *    {error:{code,message}} + 4xx/500。
 *
 * 同一套请求处理层也被 DSH 插件形态复用（packages/dsh-plugins/opc-console）：
 * hosted 模式挂 DSH 官方 webServer 的 `/opcos` prefix 路由，standalone 回退
 * 自建 node:http。本文件是纯 standalone 的参考实现（npm run console）。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { TelemetryEvent } from '../../dsh-adapter/src/index.js'
import { MemoryBodyIndex, MemoryBodyHub, SqliteIdeaMarket, SqliteIdeaStore } from '../../core/src/index.js'
import {
  loadWithHandshake,
  type CordisFiberHandle,
  type HandshakeEntry,
} from '../../opcos-bundle/src/health.js'
import { plugin as billingPlugin } from '../../dsh-plugins/opc-billing/src/index.js'
import { plugin as blackboardPlugin } from '../../dsh-plugins/opc-blackboard/src/index.js'
import { plugin as contentPlugin } from '../../dsh-plugins/opc-content/src/index.js'
import { plugin as geoMonitorPlugin } from '../../dsh-plugins/opc-geo-monitor/src/index.js'
import { plugin as lifecyclePlugin } from '../../dsh-plugins/opc-lifecycle/src/index.js'
import { plugin as marketplacePlugin } from '../../dsh-plugins/opc-marketplace/src/index.js'
import { plugin as memoryPlugin } from '../../dsh-plugins/opc-memory/src/index.js'
import { plugin as skillForgePlugin } from '../../dsh-plugins/opc-skill-forge/src/index.js'
import { plugin as teamPlugin } from '../../dsh-plugins/opc-team/src/index.js'
import {
  createApiSetup,
  createMarketCatalog,
  handleConsoleRequest,
  subscribeTelemetry,
  type ConsoleDeps,
} from './api.js'

/* ─────────────── 对外选项与返回值 ─────────────── */

export interface ConsoleOptions {
  /** 监听端口（默认 3000；0 = 随机可用端口，测试用） */
  port?: number
  /** 监听地址（默认 127.0.0.1） */
  host?: string
  /** 数据目录：隔离清单 / 启动 marker / 黑板快照 / 记忆 JSONL / 计费日志 / skills.db / installed/（默认 ./opcos-console-data） */
  dataDir?: string
  /** 市场索引 SQLite 路径（默认 dataDir/skills.db） */
  skillsDbPath?: string
  /** 测试/内省钩子：启动完成后以宿主 getService 暴露服务表（生产不传） */
  onReady?: (getService: (name: string) => unknown) => void
}

export interface RunningConsole {
  /** 形如 http://127.0.0.1:34567/ 的根地址（以 / 结尾，可直接拼接 api 路径） */
  url: string
  /** 关停：HTTP server close → 插件 fiber dispose → 市场索引 close（幂等） */
  close(): Promise<void>
}

const DEFAULT_PORT = 3000
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_DATA_DIR = './opcos-console-data'

/* ─────────────── cordis 宿主（结构子集，与 boot.test.ts 同款） ─────────────── */

interface Cordis4Host {
  plugin(plugin: unknown, ...args: unknown[]): CordisFiberHandle
  get(name: string, strict?: boolean): unknown
  registry: { delete(plugin: unknown): unknown }
}

async function createCordisHost(): Promise<Cordis4Host> {
  const mod = (await import('@deepseek-ai/cordis')) as unknown as { Context: new () => Cordis4Host }
  return new mod.Context()
}

/* ─────────────── 启动 ─────────────── */

export async function startConsole(opts: ConsoleOptions = {}): Promise<RunningConsole> {
  // 1. 数据目录（0700）：隔离清单 / 启动 marker / 黑板快照 / 记忆 / 计费日志 / skills.db / installed/
  const dataDir = resolve(opts.dataDir ?? DEFAULT_DATA_DIR)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  // 2. 真实 cordis 宿主 + 七插件健康握手装载（失败插件隔离，不阻断宿主）
  const ctx = await createCordisHost()
  const entries: HandshakeEntry[] = [
    { plugin: teamPlugin },
    { plugin: blackboardPlugin, config: { persistFile: join(dataDir, 'blackboard.json') } },
    {
      plugin: memoryPlugin,
      config: { memoriesFile: join(dataDir, 'memories.jsonl'), instinctsFile: join(dataDir, 'instincts.jsonl') },
    },
    { plugin: skillForgePlugin },
    { plugin: billingPlugin, config: { resolvedUnitPrice: 2.5, logFile: join(dataDir, 'billing.jsonl') } },
    { plugin: marketplacePlugin },
    { plugin: contentPlugin },
    {
      // 创意生命周期编排（prd2.md 8.2 lifecycle-manager）：与控制台共享 ideas.db/
      // ideas/ 目录/memory-bodies.db（多连接经 WAL 并发），DSH 侧经 'opc.lifecycle' 服务迁移阶段
      plugin: lifecyclePlugin,
      config: {
        ideasDbPath: join(dataDir, 'ideas.db'),
        ideasRoot: join(dataDir, 'ideas'),
        bodiesDbPath: join(dataDir, 'memory-bodies.db'),
      },
    },
    {
      // GEO 监测（prd2.md 4.4）：7×24 平台可见性/引用/情感监测 + 下跌告警，
      // 快照正本写入创意记忆体 analytics 流；默认 Mock 探测源（UI 标注模拟口径）
      plugin: geoMonitorPlugin,
      config: {
        ideasDbPath: join(dataDir, 'ideas.db'),
        ideasRoot: join(dataDir, 'ideas'),
        bodiesDbPath: join(dataDir, 'memory-bodies.db'),
        geoDbPath: join(dataDir, 'geo.db'),
      },
    },
  ]
  const quarantineFile = join(dataDir, 'opcos-quarantine.json')
  const markerFile = join(dataDir, 'opcos-boot-marker.json')
  const handshake = await loadWithHandshake(ctx, entries, { quarantineFile, markerFile })

  // 3. 市场索引 + 示例技能（库空时灌入；签名包仓库每次启动重建，密钥对随启动生成）
  const skillsDbPath = resolve(opts.skillsDbPath ?? join(dataDir, 'skills.db'))
  const { index, pkgStore, publicKeyPem, signingKeys } = createMarketCatalog(skillsDbPath)

  // 4. 埋点：订阅三个 TelemetryBus（team / blackboard / skillforge），收集环形数组；
  //    content_publish 环形数组由 createApiSetup 阶段订阅 'opc.content.events' 进独立环形数组
  const recentTelemetry: TelemetryEvent[] = []
  const telemetryUnsubs = subscribeTelemetry((name) => ctx.get(name), recentTelemetry)
  const recentContentEvents: TelemetryEvent[] = []

  // 4.5 创意一等公民（prd2.md M1）：创意实体库（ideas.db + ideas/ 目录）+ 记忆体枢纽
  //     （memory-bodies.db FTS5 检索索引 + 会话级挂载）+ 创意市场索引（ideas-market.db）
  const ideaStore = new SqliteIdeaStore(join(dataDir, 'ideas.db'), join(dataDir, 'ideas'))
  const bodyIndex = new MemoryBodyIndex(join(dataDir, 'memory-bodies.db'))
  const memoryHub = new MemoryBodyHub(join(dataDir, 'ideas'), bodyIndex)
  const ideaMarket = new SqliteIdeaMarket(join(dataDir, 'ideas-market.db'), {
    marketRoot: join(dataDir, 'ideas-market'),
  })

  const deps: ConsoleDeps = {
    getService: (name) => ctx.get(name),
    skillsIndex: index,
    pkgStore,
    publicKeyPem,
    installedDir: join(dataDir, 'installed'),
    billingLogFile: join(dataDir, 'billing.jsonl'),
    quarantineFile,
    telemetry: recentTelemetry,
    contentEvents: recentContentEvents,
    handshake,
    ideaStore,
    memoryHub,
    ideaMarket,
    signingKeys,
  }
  const setup = createApiSetup(deps)

  // 5. HTTP 服务器（api.ts 内统一错误处理：OpcError → {error:{code,message}} + 4xx/500）
  const server: Server = createServer((req, res) => {
    void handleConsoleRequest(req, res, setup)
  })

  let closed = false
  const shutdown = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const off of telemetryUnsubs) off()
    telemetryUnsubs.length = 0
    setup.disposeContentEvents()
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose())
      server.closeAllConnections()
    })
    for (const outcome of handshake.outcomes) {
      if (outcome.status === 'loaded' && outcome.fiber) {
        await outcome.fiber.dispose().catch(() => undefined)
      } else if (outcome.status === 'quarantined') {
        // FAILED fiber 不经 dispose，从 registry 撤销（对齐 boot.test.ts 清理方式）
        const entry = entries.find((e) => (e.name ?? e.plugin.name ?? 'anonymous') === outcome.name)
        if (entry) ctx.registry.delete(entry.plugin)
      }
    }
    ideaStore.close()
    bodyIndex.close()
    ideaMarket.close()
    index.close()
  }

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(opts.port ?? DEFAULT_PORT, opts.host ?? DEFAULT_HOST, () => resolveListen())
    })
  } catch (error) {
    await shutdown()
    throw error
  }
  // listen 成功后兜底运行期 error 事件，避免进程崩溃
  server.on('error', (error) => console.error('[opcos-console] server error:', error))

  const address = server.address() as AddressInfo | null
  if (address === null || typeof address === 'string') {
    await shutdown()
    throw new Error('opcos-console: failed to determine listening address (unix socket unsupported)')
  }
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address
  const url = `http://${displayHost}:${address.port}/`
  opts.onReady?.((name) => ctx.get(name))

  return { url, close: shutdown }
}

/* ─────────────── main 入口（npm run console → dist/opcos-console/src/server.js） ─────────────── */

/** 直启判定：argv[1] 与 import.meta.url 一致；macOS /tmp 等符号链接场景回退 realpath 比较 */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  if (import.meta.url === pathToFileURL(entry).href) return true
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const { url: consoleUrl } = await startConsole()
  console.log(`[opcos-console] OPC-OS 统一控制台已启动: ${consoleUrl}`)
}
