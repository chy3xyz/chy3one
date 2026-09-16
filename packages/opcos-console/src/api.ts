/**
 * opcos-console 可复用请求处理层 —— "给定 deps 就能处理请求"的部分。
 *
 * 两个入口共用本模块，行为与错误映射（OpcError → {error:{code,message}} + 4xx/500）完全一致：
 * - server.ts（standalone 全家桶：自带 cordis 宿主 + 六插件握手装载 + node:http）；
 * - packages/dsh-plugins/opc-console（插件形态：hosted 模式挂 DSH 官方 webServer
 *   的 `/opcos` prefix 路由，或 standalone 回退自建 node:http）。
 *
 * 约定：handleApiRequest / serveStatic / handleConsoleRequest 均自捕获异常并完成
 * 响应（含 res.headersSent 防护），调用方无需再兜底 catch。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import {
  OpcError,
  SqliteIdeaStore,
  SqliteSkillIndex,
  MemoryBodyHub,
  installFromMarket,
  GUIDING_QUESTIONS,
  DOMAIN_KEYS,
  DOMAIN_LABELS,
  IDEA_MEMORY_STREAMS,
  validateDomains,
  type BillingRecord,
  type BlackboardEntry,
  type BlackboardScope,
  type BlackboardWrite,
  type BillingEngine,
  type DomainKey,
  type Idea,
  type IdeaMemoryStream,
  type MarketSkill,
  type MemoryEntry,
  type MemoryQuery,
  type NewMemoryEntry,
  type Order,
  type OrderEngine,
  type SkillDefinition,
  type SplitEntry,
  type Task,
  type ThreeDomains,
  type WriteResult,
} from '../../core/src/index.js'
import type { PipelineRunResult } from '../../core/src/content/pipeline.js'
import { createPackage, type SkillPackage } from '../../core/src/skill/packager.js'
import type { TelemetryBus, TelemetryEvent } from '../../dsh-adapter/src/index.js'
import { detectDshRuntime } from '../../dsh-adapter/src/index.js'
import { readQuarantineList, type HandshakeReport, type HandshakeStatus } from '../../opcos-bundle/src/health.js'
import type { SkillForgeService } from '../../dsh-plugins/opc-skill-forge/src/index.js'
import type { TeamService } from '../../dsh-plugins/opc-team/src/index.js'

/* ─────────────── 共享常量 ─────────────── */

const TELEMETRY_RING_CAPACITY = 100
/** content_publish 环形缓冲容量（GET /api/content/events） */
const CONTENT_EVENTS_RING_CAPACITY = 50
const MAX_BODY_BYTES = 1_000_000
const DEFAULT_SKILL_PAGE_SIZE = 20
const MAX_SKILL_PAGE_SIZE = 200
/** 计算 total 时的扫描上限（compat 过滤需内存分页前的全量语义） */
const TOTAL_SCAN_LIMIT = 1000

const REQUEST_BASE = 'http://opcos-console.internal'

/** gzip 阈值：响应体 > 1KB 才压缩（更小的包压缩后常不降反升） */
const GZIP_MIN_BYTES = 1024
/** 值得压缩的静态文本扩展名（图片/字体本就压缩，跳过） */
const GZIPPABLE_EXT = /\.(?:html|js|mjs|css|json|map|svg|txt)$/

/* ─────────────── 插件服务的结构子集（运行时经 getService 解析） ─────────────── */

interface BlackboardService {
  read(scope: BlackboardScope, key?: string): BlackboardEntry[]
  write(op: BlackboardWrite): WriteResult
}

interface MemoryService {
  write(entry: NewMemoryEntry): MemoryEntry
  query(criteria: MemoryQuery): MemoryEntry[]
}

type MarketplacePay = (orderId: string) => Promise<{ order: Order; split: SplitEntry }>

type BillingComplete = (event: {
  taskId: string
  agentId: string
  resolution: 'resolved' | 'escalated'
}) => BillingRecord

/** 分成 ledger 服务（opc.marketplace.revenue：RevenueSplitter 的结构子集，SF-07） */
interface RevenueLedger {
  /** 创作者累计未提取余额（分） */
  creatorBalance(authorId: string): number
  /** 全量分成流水（只读快照） */
  listEntries(): readonly SplitEntry[]
}

/** Content Engine 服务（opc.content 的结构子集，PRD 6.3 系统三） */
interface ContentService {
  /** 选题 → 撰写 → 审核 → 分发 全流程（LLM 模式下可能耗时数秒） */
  run(): Promise<PipelineRunResult>
  /** 观测用：run 调用计数（含失败） */
  stats(): { runs: number }
  /** 生效模式（不回传任何密钥） */
  mode(): { llm: boolean; hotSearch: boolean }
  /**
   * 人设记忆直通（与 opc.memory 服务同形的 MemoryStore，opc-content 插件实有字段）。
   * Content Engine 持有独立的人设记忆实例，TemplateTopicStrategy 把其中的 topic 记忆
   * 直连为选题候选（core content/strategy.ts）——创意→内容通路的桥接写入口。
   */
  readonly memory: MemoryService
}

/** 共享任务板服务（opc.team.board 的结构子集，core TaskBoard 同形，AS-04） */
interface TeamBoardService {
  /** 新增 pending 任务（版本从 1 起） */
  add(title: string, expectedListVersion?: number): Task
  /** 任务清单，按 createdAt 升序 */
  list(): Task[]
  /** 认领：pending→claimed；非 pending 或版本过期抛 ConflictError */
  claim(taskId: string, member: string, expectedVersion: number): Task
  /** 完成：claimed→done；仅认领者本人可完成（他人抛 PermissionError） */
  complete(taskId: string, member: string, result: string, expectedVersion: number): Task
  /** 阻塞：任意状态→blocked，原因存 result */
  block(taskId: string, member: string, reason: string, expectedVersion: number): Task
  stats(): { total: number; pending: number; claimed: number; done: number; blocked: number }
}

/* ─────────────── 预置示例技能（库空时灌入市场索引 + 签名包仓库） ─────────────── */

interface SampleSkill {
  entry: MarketSkill
  definition: SkillDefinition
}

const SAMPLE_CREATED_AT = 1_750_000_000_000

const SAMPLE_SKILLS: SampleSkill[] = [
  {
    entry: {
      id: 'photo-studio-pro',
      name: 'Product Photo Studio',
      version: '1.2.0',
      authorId: 'creator-alice',
      price: 990,
      category: 'ecommerce',
      downloads: 128,
      rating: 4.6,
      createdAt: SAMPLE_CREATED_AT,
      compat: { dsh: '>=0.1.0-rc.7' },
    },
    definition: {
      name: 'photo-studio-pro',
      version: '1.2.0',
      memorySnapshot: [
        { layer: 'soul', content: '电商产品图拍摄与精修执行者人格' },
        { layer: 'lesson', content: '白底图→场景图→精修→导出 共执行 42 次，成功率 95%' },
      ],
      skillDefinition: {
        trigger: '任务签名匹配 ecommerce/product-photo',
        toolSequence: ['shot-plan', 'bg-remove', 'retouch', 'export'],
        postConditions: '产出一套可直接上架的产品图',
      },
    },
  },
  {
    entry: {
      id: 'seo-copy-toolkit',
      name: 'SEO Copywriter Toolkit',
      version: '0.9.0',
      authorId: 'creator-bruno',
      price: 590,
      category: 'content',
      downloads: 86,
      rating: 4.2,
      createdAt: SAMPLE_CREATED_AT + 1,
      compat: { dsh: '>=0.1.0-rc.7' },
    },
    definition: {
      name: 'seo-copy-toolkit',
      version: '0.9.0',
      memorySnapshot: [
        { layer: 'soul', content: '搜索导向文案写手人格' },
        { layer: 'lesson', content: '关键词聚类→大纲→成稿→内链 共执行 31 次，成功率 90%' },
      ],
      skillDefinition: {
        trigger: '任务签名匹配 content/seo-copy',
        toolSequence: ['keyword-cluster', 'outline', 'draft', 'interlink'],
        postConditions: '产出带内链结构的 SEO 文章',
      },
    },
  },
  {
    entry: {
      id: 'repo-sentinel-ci',
      name: 'Repo Sentinel CI',
      version: '1.0.0',
      authorId: 'creator-cara',
      price: 1290,
      category: 'dev-tools',
      downloads: 45,
      rating: 4.9,
      createdAt: SAMPLE_CREATED_AT + 2,
      compat: { dsh: '>=0.1.0-rc.7' },
    },
    definition: {
      name: 'repo-sentinel-ci',
      version: '1.0.0',
      memorySnapshot: [
        { layer: 'soul', content: '代码仓库守夜人人格' },
        { layer: 'lesson', content: 'lint→typecheck→test→report 共执行 57 次，成功率 97%' },
      ],
      skillDefinition: {
        trigger: '任务签名匹配 dev-tools/repo-check',
        toolSequence: ['lint', 'typecheck', 'test', 'report'],
        postConditions: '产出仓库健康报告并回写黑板',
      },
    },
  },
]

/* ─────────────── 错误码 → HTTP 状态映射（OpcError 统一处理） ─────────────── */

const ERROR_STATUS: Record<string, number> = {
  GOAL_PARSE_FAILED: 400,
  VALIDATION_ERROR: 400,
  INVALID_JSON: 400,
  ORDER_INPUT_INVALID: 400,
  ORDER_AMOUNT_INVALID: 400,
  SPLIT_AMOUNT_INVALID: 400,
  BILLING_EVENT_INVALID: 400,
  SIGNATURE_INVALID: 400,
  CURRENCY_UNSUPPORTED: 400,
  DISTILL_QUALITY_GATE: 400,
  PAYMENT_FAILED: 402,
  PERMISSION_DENIED: 403,
  ORDER_NOT_FOUND: 404,
  SKILL_NOT_FOUND: 404,
  IDEA_NOT_FOUND: 404,
  NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  VERSION_CONFLICT: 409,
  ORDER_STATE_INVALID: 409,
  NO_DRAFTS: 409,
  CONTENT_REVIEW_REJECTED: 422,
  PAYLOAD_TOO_LARGE: 413,
  TOKEN_BUDGET_EXCEEDED: 429,
  SERVICE_UNAVAILABLE: 503,
}

/* ─────────────── 静态资源 ─────────────── */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

/** static/index.html 缺失时对 / 返回的内置占位页（200，不 500） */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OPC-OS Console</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 3rem auto; max-width: 40rem; color: #1f2430; line-height: 1.6; }
  code { background: #f2f3f7; padding: 2px 6px; border-radius: 4px; }
  #app { border: 1px dashed #b9bfcc; border-radius: 8px; padding: 1rem 1.5rem; }
</style>
</head>
<body>
<h1>OPC-OS Console</h1>
<div id="app">
  <p>前端资源尚未就绪：当前返回内置占位页（static/index.html 缺失时不返回 500）。</p>
  <p>REST API 前缀为 <code>/api/</code>，健康检查：<code>GET /api/health</code>，总览：<code>GET /api/overview</code>。</p>
</div>
</body>
</html>
`

/**
 * 静态目录：优先 import.meta.url 相对的 ../static/；
 * dist 运行时（tsc 不拷贝静态资源）回退到源码包的 static/。
 * 以 index.html 为准裁决：dist 形态下 ../static/ 可能只含编译落地的 *.test.js
 * （static/ 目录同样被 node:test 收纳），缺前端文件时必须回退源码目录。
 */
export function resolveStaticDir(): string {
  const primary = fileURLToPath(new URL('../static', import.meta.url))
  if (existsSync(join(primary, 'index.html'))) return primary
  const fromDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/opcos-console/static')
  if (existsSync(join(fromDist, 'index.html'))) return fromDist
  return primary
}

function sendFile(req: IncomingMessage, res: ServerResponse, status: number, filePath: string): void {
  const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  const raw = readFileSync(filePath)
  // 控制台追求即时生效：禁用浏览器启发式缓存（曾发生 app.js 陈旧事故），
  // hosted 模式下静态文件热读源码目录，禁存保证 API 代码重启后前端立刻同步；
  // >1KB 的文本类型在客户端接受时 gzip（app.js/style.css 约数十 KB，收益明显）
  const compress =
    raw.length > GZIP_MIN_BYTES && GZIPPABLE_EXT.test(extname(filePath).toLowerCase()) && acceptsGzip(req)
  const payload = compress ? gzipSync(raw) : raw
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    ...(compress ? { 'content-length': String(payload.length) } : {}),
    ...gzipHeaders(compress),
  })
  res.end(payload)
}

function sendStaticNotFound(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  sendJson(req, res, 404, { error: { code: 'NOT_FOUND', message: `no such path: ${pathname}` } })
}

/* ─────────────── 运行时组装（deps → setup） ─────────────── */

/** 健康来源：静态握手报告（startConsole）或实时探测函数（hosted 插件） */
export type HandshakeSource = HandshakeReport | (() => HandshakeReport)

/**
 * 请求处理所需的全部依赖。standalone 入口用 `ctx.get` 实现 getService，
 * hosted 插件用 OpcContext.getService —— 其余字段以 server.ts 原闭包变量为准。
 */
export interface ConsoleDeps {
  /** 服务解析（/api/* 处理器按名取 opc.team 等六插件服务） */
  getService(name: string): unknown
  /** 市场索引（SqliteSkillIndex） */
  skillsIndex: SqliteSkillIndex
  /** 签名技能包仓库（skillId → .dshpkg，启动时重建） */
  pkgStore: Map<string, SkillPackage>
  /** 验签公钥 PEM（与 pkgStore 内签名包同批生成） */
  publicKeyPem: string
  /** 市场安装落盘目录 */
  installedDir: string
  /** 计费 write-ahead 日志（每行 {event, record}） */
  billingLogFile: string
  /** 隔离清单文件路径（/api/health 读取） */
  quarantineFile: string
  /** 埋点环形数组（由 subscribeTelemetry 维护，owner 负责生命周期） */
  telemetry: TelemetryEvent[]
  /**
   * content_publish 环形数组（可选）：createApiSetup 阶段订阅 'opc.content.events'
   * 维护，容量 CONTENT_EVENTS_RING_CAPACITY；owner 经 setup.disposeContentEvents() 退订。
   */
  contentEvents?: TelemetryEvent[]
  /** 健康来源：缺省时按服务可用性实时探测（probeHandshake） */
  handshake?: HandshakeSource
  /** 静态目录：缺省 resolveStaticDir() */
  staticDir?: string
  /**
   * 创意实体存储（可选，两入口按 dataDir 构造）。缺省时 /api/ideas 保持
   * v1 行为（topic 记忆直写），创意实体端点返回 503。
   */
  ideaStore?: SqliteIdeaStore
  /** 创意记忆体枢纽（可选，与 ideaStore 同批构造：FTS5 检索 + 会话级挂载） */
  memoryHub?: MemoryBodyHub
}

/** 请求处理层的就绪形态（deps 经默认值补全后的冻结视图） */
export interface ConsoleSetup {
  getService(name: string): unknown
  handshake(): HandshakeReport
  quarantineFile: string
  skillsIndex: SqliteSkillIndex
  pkgStore: Map<string, SkillPackage>
  publicKeyPem: string
  installedDir: string
  billingLogFile: string
  telemetry: TelemetryEvent[]
  /** content_publish 环形数组（createApiSetup 阶段开始订阅维护） */
  contentEvents: TelemetryEvent[]
  /** 退订 content_publish 订阅（owner 关停时调用；幂等） */
  disposeContentEvents(): void
  staticDir: string
  /** 创意实体存储（缺省 undefined：创意实体端点降级） */
  readonly ideaStore?: SqliteIdeaStore
  /** 创意记忆体枢纽（缺省 undefined：挂载/记忆体端点降级） */
  readonly memoryHub?: MemoryBodyHub
}

/**
 * 组装请求处理层：补全 staticDir 默认解析与健康来源。
 * 一次性初始化（预置技能市场）在 createMarketCatalog 中，由 owner 先行调用。
 */
export function createApiSetup(deps: ConsoleDeps): ConsoleSetup {
  const handshake: () => HandshakeReport =
    typeof deps.handshake === 'function'
      ? deps.handshake
      : deps.handshake
        ? () => deps.handshake as HandshakeReport
        : () => probeHandshake(deps.getService)
  // content_publish 环形缓冲：此处订阅（宿主装载插件先行，'opc.content.events' 已就位；
  // 插件缺席时 subscribeContentEvents 返回幂等退订，端点降级为空列表而非 503）
  const contentEvents = deps.contentEvents ?? []
  const offContentEvents = subscribeContentEvents(deps.getService, contentEvents)
  return {
    getService: deps.getService,
    handshake,
    quarantineFile: deps.quarantineFile,
    skillsIndex: deps.skillsIndex,
    pkgStore: deps.pkgStore,
    publicKeyPem: deps.publicKeyPem,
    installedDir: deps.installedDir,
    billingLogFile: deps.billingLogFile,
    telemetry: deps.telemetry,
    contentEvents,
    disposeContentEvents: () => {
      offContentEvents()
    },
    staticDir: deps.staticDir ?? resolveStaticDir(),
    ideaStore: deps.ideaStore,
    memoryHub: deps.memoryHub,
  }
}

/** hosted 插件的健康探测：六插件各取一个标记服务，缺席即 quarantined */
const PROBED_PLUGIN_SERVICES: ReadonlyArray<readonly [plugin: string, service: string]> = [
  ['opc-team', 'opc.team'],
  ['opc-blackboard', 'opc.blackboard'],
  ['opc-memory', 'opc.memory'],
  ['opc-skill-forge', 'opc.skillforge'],
  ['opc-billing', 'opc.billing'],
  ['opc-marketplace', 'opc.marketplace.orders'],
]

/** 按服务可用性实时构造握手报告（与 HandshakeReport 同形，degradedBoot 恒 false） */
export function probeHandshake(getService: (name: string) => unknown): HandshakeReport {
  const outcomes = PROBED_PLUGIN_SERVICES.map(([name, service]) => ({
    name,
    status: (getService(service) !== undefined ? 'loaded' : 'quarantined') as HandshakeStatus,
  }))
  return {
    degradedBoot: false,
    criticalNames: [],
    outcomes,
    allFailed: outcomes.length > 0 && outcomes.every((o) => o.status === 'quarantined'),
  }
}

/**
 * 市场目录初始化（server.ts 原第 3 步原样搬入）：
 * SqliteSkillIndex + 首技能生成密钥对 + 其余技能共用私钥签名入 pkgStore；
 * 库空时预置 3 条示例 MarketSkill。
 */
export function createMarketCatalog(skillsDbPath: string): {
  index: SqliteSkillIndex
  pkgStore: Map<string, SkillPackage>
  publicKeyPem: string
} {
  const index = new SqliteSkillIndex(skillsDbPath)
  const [firstSample, ...restSamples] = SAMPLE_SKILLS
  const firstBuild = createPackage(firstSample.definition, firstSample.entry.authorId)
  const publicKeyPem = firstBuild.keys.publicKeyPem
  const pkgStore = new Map<string, SkillPackage>([[firstSample.entry.id, firstBuild.pkg]])
  for (const sample of restSamples) {
    pkgStore.set(sample.entry.id, createPackage(sample.definition, sample.entry.authorId, firstBuild.keys).pkg)
  }
  if (index.count() === 0) {
    index.upsertAll(SAMPLE_SKILLS.map((s) => s.entry))
  }
  return { index, pkgStore, publicKeyPem }
}

/**
 * 埋点初始化（server.ts 原第 4 步原样搬入）：订阅三个 TelemetryBus，
 * 收集进调用方给的环形数组。返回退订函数数组（owner 在关停时逐个调用）。
 */
export function subscribeTelemetry(
  getService: (name: string) => unknown,
  ring: TelemetryEvent[],
  capacity: number = TELEMETRY_RING_CAPACITY,
): Array<() => void> {
  const recordTelemetry = (event: TelemetryEvent): void => {
    ring.push(event)
    if (ring.length > capacity) ring.shift()
  }
  const unsubs: Array<() => void> = []
  for (const busName of ['opc.team.events', 'opc.blackboard.events', 'opc.skillforge.events']) {
    const bus = getService(busName) as TelemetryBus | undefined
    if (bus && typeof bus.subscribe === 'function') unsubs.push(bus.subscribe(recordTelemetry))
  }
  return unsubs
}

/**
 * content_publish 订阅（PRD 7.5）：订阅 'opc.content.events' 总线进环形数组，
 * 供 GET /api/content/events 展示最近发布事件。总线缺席（插件隔离）→ 幂等退订。
 */
export function subscribeContentEvents(
  getService: (name: string) => unknown,
  ring: TelemetryEvent[],
  capacity: number = CONTENT_EVENTS_RING_CAPACITY,
): () => void {
  const bus = getService('opc.content.events') as TelemetryBus | undefined
  if (!bus || typeof bus.subscribe !== 'function') return () => {}
  return bus.subscribe((event) => {
    ring.push(event)
    if (ring.length > capacity) ring.shift()
  })
}

/* ─────────────── 请求级辅助 ─────────────── */

/** 请求 Accept-Encoding 是否明确接受 gzip（仅认显式 gzip 与 x-gzip 条目；通配符星号与 identity 均视为不接受） */
function acceptsGzip(req: IncomingMessage): boolean {
  const header = req.headers['accept-encoding']
  if (typeof header !== 'string') return false
  return header.split(',').some((part) => {
    const token = (part.split(';')[0] ?? '').trim().toLowerCase()
    return token === 'gzip' || token === 'x-gzip'
  })
}

/** gzip 条件压缩头：仅压缩时带 content-encoding；vary 恒带（响应随 Accept-Encoding 变化） */
function gzipHeaders(compressed: boolean): Record<string, string> {
  return compressed ? { 'content-encoding': 'gzip', vary: 'Accept-Encoding' } : { vary: 'Accept-Encoding' }
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const raw = Buffer.from(JSON.stringify(body), 'utf8')
  // >1KB 且客户端接受 gzip → gzipSync 压缩（一次性缓冲，控制台响应体量级足够）
  const compress = raw.length > GZIP_MIN_BYTES && acceptsGzip(req)
  const payload = compress ? gzipSync(raw) : raw
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...(compress ? { 'content-length': String(payload.length) } : {}),
    ...gzipHeaders(compress),
  })
  res.end(payload)
}

function sendError(req: IncomingMessage, res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (error instanceof OpcError) {
    sendJson(req, res, ERROR_STATUS[error.code] ?? 500, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof RangeError) {
    sendJson(req, res, 400, { error: { code: 'VALIDATION_ERROR', message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(req, res, 500, { error: { code: 'INTERNAL_ERROR', message } })
}

function requireService<T>(setup: ConsoleSetup, name: string): T {
  const service = setup.getService(name) as T | undefined
  if (service === undefined) {
    throw new OpcError('SERVICE_UNAVAILABLE', `service ${name} is not available (plugin quarantined or unloaded)`)
  }
  return service
}

/** 创意实体存储必取（入口未配置时 503——两入口默认都配置，仅手工裁剪 deps 才会命中） */
function requireIdeaStore(setup: ConsoleSetup): SqliteIdeaStore {
  if (!setup.ideaStore) {
    throw new OpcError('SERVICE_UNAVAILABLE', 'idea store is not configured in console deps')
  }
  return setup.ideaStore
}

/** 创意记忆体必取 */
function requireMemoryHub(setup: ConsoleSetup): MemoryBodyHub {
  if (!setup.memoryHub) {
    throw new OpcError('SERVICE_UNAVAILABLE', 'memory hub is not configured in console deps')
  }
  return setup.memoryHub
}

function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        reject(new OpcError('PAYLOAD_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim().length === 0) {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new OpcError('INVALID_JSON', 'request body must be a JSON object'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject(new OpcError('INVALID_JSON', 'request body is not valid JSON'))
      }
    })
    req.on('error', (err: Error) => {
      reject(new OpcError('INVALID_JSON', `failed to read request body: ${err.message}`))
    })
  })
}

function nonEmptyParam(value: string | null): string | undefined {
  if (value === null || value.length === 0) return undefined
  return value
}

function parseLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return fallback
  return Math.min(n, max)
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new OpcError('VALIDATION_ERROR', `field ${field} must be a non-empty string`)
  }
  return value
}

function requirePositiveInt(body: Record<string, unknown>, field: string): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new OpcError('VALIDATION_ERROR', `field ${field} must be a positive integer`)
  }
  return value
}

function requireNonNegativeInt(body: Record<string, unknown>, field: string): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new OpcError('VALIDATION_ERROR', `field ${field} must be a non-negative integer`)
  }
  return value
}

function requireOneOf<T extends string>(body: Record<string, unknown>, field: string, allowed: readonly T[]): T {
  const value = body[field]
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new OpcError('VALIDATION_ERROR', `field ${field} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function queryOneOf<T extends string>(url: URL, name: string, allowed: readonly T[], fallback: T): T {
  const value = url.searchParams.get(name)
  if (value === null || value.length === 0) return fallback
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new OpcError('VALIDATION_ERROR', `query parameter ${name} must be one of: ${allowed.join(', ')}`)
}

function optionalConfidence(body: Record<string, unknown>): { confidence?: number } {
  const raw = body.confidence
  if (raw === undefined) return {}
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new OpcError('VALIDATION_ERROR', 'field confidence must be a number within [0,1]')
  }
  return { confidence: raw }
}

function requireConfidence(body: Record<string, unknown>): number {
  const { confidence } = optionalConfidence(body)
  if (confidence === undefined) {
    throw new OpcError('VALIDATION_ERROR', 'field confidence is required and must be within [0,1]')
  }
  return confidence
}

/** 从计费 write-ahead 日志（每行 {event, record}）解析记录，坏行跳过 */
function readBillingRecords(logFile: string): BillingRecord[] {
  if (!existsSync(logFile)) return []
  const records: BillingRecord[] = []
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line) as { record?: BillingRecord }
      if (parsed && typeof parsed === 'object' && parsed.record) records.push(parsed.record)
    } catch {
      // write-ahead 日志以行为单位，损坏行不影响其余记录
    }
  }
  return records
}

/** 路径段解码：空段或非法百分号编码 → VALIDATION_ERROR */
function decodePathSegment(raw: string, field: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(raw)
    } catch {
      throw new OpcError('VALIDATION_ERROR', `path parameter ${field} is not valid percent-encoding: ${raw}`)
    }
  })()
  if (decoded.length === 0) {
    throw new OpcError('VALIDATION_ERROR', `path parameter ${field} must be a non-empty string`)
  }
  return decoded
}

/** SF-07 聚合口径：paid+delivered 才计入净额（对齐 OrderEngine.stats().netRevenue 笔数口径） */
function isNetPositive(status: Order['status']): boolean {
  return status === 'paid' || status === 'delivered'
}

/**
 * 订单净额聚合（SF-07/DE-08 与 /api/funnel 共用口径）：分成 ledger join 订单状态，
 * 仅 paid+delivered 计入净额（单位：分）。/api/bills/summary 的买家维度聚合与
 * 创意变现漏斗的收入段同源于此，保证两处数字永不漂移。
 */
function orderNetAggregates(
  orders: OrderEngine,
  revenue: RevenueLedger | undefined,
): { byBuyer: Map<string, { orders: number; spent: number }>; totalCents: number } {
  const byBuyer = new Map<string, { orders: number; spent: number }>()
  let totalCents = 0
  for (const entry of revenue ? revenue.listEntries() : []) {
    const order = orders.get(entry.orderId)
    if (!order || !isNetPositive(order.status)) continue
    const agg = byBuyer.get(order.buyerId) ?? { orders: 0, spent: 0 }
    agg.orders += 1
    agg.spent += order.amount
    byBuyer.set(order.buyerId, agg)
    totalCents += order.amount
  }
  return { byBuyer, totalCents }
}

/**
 * 任务板变更统一出口：成功回 Task；VERSION_CONFLICT → 409 并在 error.current 附
 * 当前任务快照（前端据此展示胜者并回填版本）；PermissionError 等其余错误原样上抛，
 * 走 ERROR_STATUS 映射（PERMISSION_DENIED → 403、TASK_NOT_FOUND → 404）。
 */
async function respondBoardMutation(
  req: IncomingMessage,
  res: ServerResponse,
  taskBoard: TeamBoardService,
  taskId: string,
  mutate: () => Task,
): Promise<void> {
  try {
    sendJson(req, res, 200, mutate())
  } catch (error) {
    if (error instanceof OpcError && error.code === 'VERSION_CONFLICT') {
      sendJson(req, res, 409, {
        error: {
          code: 'VERSION_CONFLICT',
          message: error.message,
          current: taskBoard.list().find((t) => t.id === taskId) ?? null,
        },
      })
      return
    }
    throw error
  }
}

/* ─────────────── 路由 ─────────────── */

const API_PATHS = new Set([
  '/api/health',
  '/api/team',
  '/api/team/templates',
  '/api/blackboard',
  '/api/board',
  '/api/board/add',
  '/api/board/claim',
  '/api/board/complete',
  '/api/board/block',
  '/api/content/run',
  '/api/content/stats',
  '/api/content/events',
  '/api/skills',
  '/api/skills/install',
  '/api/skills/publish-draft',
  '/api/skillforge/drafts',
  '/api/orders',
  '/api/orders/pay',
  '/api/creators',
  '/api/bills',
  '/api/bills/summary',
  '/api/billing/summary',
  '/api/billing/complete',
  '/api/memory',
  '/api/ideas',
  '/api/memory-bodies',
  '/api/memory-bodies/mount',
  '/api/guiding-questions',
  '/api/funnel',
  '/api/overview',
])

/**
 * 剥离 URL 前缀：'/opcos' 精确命中 → '/'；'/opcos/x' → '/x'；
 * 前缀为空串或不匹配时原样返回。
 */
function stripUrlPrefix(pathname: string, prefix: string): string {
  if (prefix.length === 0) return pathname
  if (pathname === prefix) return '/'
  if (pathname.startsWith(prefix + '/')) return pathname.slice(prefix.length)
  return pathname
}

async function dispatchApi(
  url: URL,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  setup: ConsoleSetup,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  switch (`${method} ${path}`) {
    case 'GET /api/health': {
      const outcomes = setup.handshake().outcomes
      sendJson(req, res, 200, {
        ok: outcomes.every((o) => o.status === 'loaded'),
        runtime: detectDshRuntime(),
        plugins: outcomes.map((o) => ({ name: o.name, ok: o.status === 'loaded' })),
        quarantined: readQuarantineList(setup.quarantineFile),
      })
      return
    }

    case 'POST /api/team': {
      const body = await readJsonObject(req)
      const goal = body.goal
      if (typeof goal !== 'string' || goal.trim().length === 0) {
        throw new OpcError('GOAL_PARSE_FAILED', `无法解析创业目标: ${JSON.stringify(goal)}`)
      }
      const team = requireService<TeamService>(setup, 'opc.team')
      sendJson(req, res, 200, team.formTeam(goal))
      return
    }

    case 'GET /api/team/templates': {
      const team = requireService<TeamService>(setup, 'opc.team')
      sendJson(req, res, 200, { templates: team.fallbackTemplates() })
      return
    }

    case 'GET /api/blackboard': {
      const scope = queryOneOf(url, 'scope', ['global', 'workflow'] as const, 'global')
      const board = requireService<BlackboardService>(setup, 'opc.blackboard')
      sendJson(req, res, 200, { entries: board.read(scope) })
      return
    }

    case 'POST /api/blackboard': {
      const body = await readJsonObject(req)
      const board = requireService<BlackboardService>(setup, 'opc.blackboard')
      const op: BlackboardWrite = {
        scope: requireOneOf(body, 'scope', ['global', 'workflow'] as const),
        key: requireString(body, 'key'),
        value: body.value,
        writer: requireString(body, 'writer'),
        role: requireOneOf(body, 'role', ['orchestrator', 'agent'] as const),
        expectedVersion: requireNonNegativeInt(body, 'expectedVersion'),
        ...optionalConfidence(body),
      }
      sendJson(req, res, 200, board.write(op))
      return
    }

    case 'GET /api/board': {
      const taskBoard = requireService<TeamBoardService>(setup, 'opc.team.board')
      sendJson(req, res, 200, { tasks: taskBoard.list(), stats: taskBoard.stats() })
      return
    }

    case 'POST /api/board/add': {
      const body = await readJsonObject(req)
      const taskBoard = requireService<TeamBoardService>(setup, 'opc.team.board')
      sendJson(req, res, 200, taskBoard.add(requireString(body, 'title')))
      return
    }

    case 'POST /api/board/claim': {
      const body = await readJsonObject(req)
      const taskBoard = requireService<TeamBoardService>(setup, 'opc.team.board')
      const taskId = requireString(body, 'taskId')
      await respondBoardMutation(req, res, taskBoard, taskId, () =>
        taskBoard.claim(taskId, requireString(body, 'member'), requireNonNegativeInt(body, 'expectedVersion')),
      )
      return
    }

    case 'POST /api/board/complete': {
      const body = await readJsonObject(req)
      const taskBoard = requireService<TeamBoardService>(setup, 'opc.team.board')
      const taskId = requireString(body, 'taskId')
      await respondBoardMutation(req, res, taskBoard, taskId, () =>
        taskBoard.complete(
          taskId,
          requireString(body, 'member'),
          requireString(body, 'result'),
          requireNonNegativeInt(body, 'expectedVersion'),
        ),
      )
      return
    }

    case 'POST /api/board/block': {
      const body = await readJsonObject(req)
      const taskBoard = requireService<TeamBoardService>(setup, 'opc.team.board')
      const taskId = requireString(body, 'taskId')
      await respondBoardMutation(req, res, taskBoard, taskId, () =>
        taskBoard.block(
          taskId,
          requireString(body, 'member'),
          requireString(body, 'reason'),
          requireNonNegativeInt(body, 'expectedVersion'),
        ),
      )
      return
    }

    case 'POST /api/content/run': {
      // 选题→撰写→审核→分发全链路（LLM 模式可能耗时数秒，直接 await 由前端 loading）
      const content = requireService<ContentService>(setup, 'opc.content')
      sendJson(req, res, 200, await content.run())
      return
    }

    case 'GET /api/content/stats': {
      const content = requireService<ContentService>(setup, 'opc.content')
      sendJson(req, res, 200, { ...content.stats(), mode: content.mode() })
      return
    }

    case 'GET /api/content/events': {
      // 最近 content_publish 事件（环形缓冲，createApiSetup 阶段订阅维护；时间正序）
      sendJson(req, res, 200, { events: [...setup.contentEvents] })
      return
    }

    case 'GET /api/skills': {
      const keyword = nonEmptyParam(url.searchParams.get('q'))
      const category = nonEmptyParam(url.searchParams.get('category'))
      const compatDsh = nonEmptyParam(url.searchParams.get('compat'))
      const limit = parseLimit(url.searchParams.get('limit'), DEFAULT_SKILL_PAGE_SIZE, MAX_SKILL_PAGE_SIZE)
      // 先取全量命中（受 TOTAL_SCAN_LIMIT 上限约束）以计算 total，再切页
      const matched = setup.skillsIndex.search({ keyword, category, compatDsh, limit: TOTAL_SCAN_LIMIT })
      sendJson(req, res, 200, { results: matched.slice(0, limit), total: matched.length })
      return
    }

    case 'POST /api/skills/install': {
      const body = await readJsonObject(req)
      const skillId = requireString(body, 'skillId')
      const installedPath = await installFromMarket(
        setup.skillsIndex,
        setup.pkgStore,
        setup.publicKeyPem,
        skillId,
        setup.installedDir,
      )
      sendJson(req, res, 200, { installedPath })
      return
    }

    case 'POST /api/skills/publish-draft': {
      // 草案→上架工作流：skillforge 首个草案 → 打包 → Ed25519 重新签名取公钥 → 市场索引
      const body = await readJsonObject(req)
      const forge = requireService<SkillForgeService>(setup, 'opc.skillforge')
      const draft = forge.listDrafts()[0]
      if (!draft) {
        throw new OpcError('NO_DRAFTS', 'skillforge has no distilled drafts (repeat similar workflows to create one)')
      }
      const authorId = typeof body.authorId === 'string' && body.authorId.length > 0 ? body.authorId : 'console-creator'
      // SF-04 打包信封（走 forge 路径）；再按示例 Skill 同模式重新签名取得本次公钥
      forge.packageDraft(draft, authorId)
      const { pkg, keys } = createPackage(draft, authorId)
      const entry: MarketSkill = {
        id: pkg.manifest.skillId,
        name: pkg.manifest.name,
        version: pkg.manifest.version,
        authorId,
        price: 990,
        category: 'community',
        downloads: 0,
        rating: 0,
        createdAt: pkg.manifest.createdAt,
        compat: { dsh: '>=0.1.0-rc.7' },
      }
      setup.skillsIndex.upsert(entry)
      sendJson(req, res, 200, {
        skillId: entry.id,
        name: entry.name,
        version: entry.version,
        authorId,
        price: entry.price,
        category: entry.category,
        publicKeyPem: keys.publicKeyPem,
      })
      return
    }

    case 'GET /api/skillforge/drafts': {
      const forge = requireService<SkillForgeService>(setup, 'opc.skillforge')
      sendJson(req, res, 200, { drafts: forge.listDrafts() })
      return
    }

    case 'POST /api/orders': {
      const body = await readJsonObject(req)
      const orders = requireService<OrderEngine>(setup, 'opc.marketplace.orders')
      const skillId = requireString(body, 'skillId')
      const marketEntry = setup.skillsIndex.get(skillId)
      const order = orders.createOrder({
        skillId,
        version: requireString(body, 'version'),
        buyerId: requireString(body, 'buyerId'),
        amount: requirePositiveInt(body, 'amountCents'),
        ...(marketEntry ? { authorId: marketEntry.authorId } : {}),
      })
      sendJson(req, res, 200, order)
      return
    }

    case 'POST /api/orders/pay': {
      const body = await readJsonObject(req)
      const pay = requireService<MarketplacePay>(setup, 'opc.marketplace.pay')
      const { order, split } = await pay(requireString(body, 'orderId'))
      sendJson(req, res, 200, { order, split })
      return
    }

    case 'GET /api/orders': {
      const buyerId = nonEmptyParam(url.searchParams.get('buyerId'))
      if (!buyerId) throw new OpcError('VALIDATION_ERROR', 'query parameter buyerId is required')
      const orders = requireService<OrderEngine>(setup, 'opc.marketplace.orders')
      sendJson(req, res, 200, { orders: orders.listByBuyer(buyerId) })
      return
    }

    case 'GET /api/creators': {
      // SF-07 创作者中心：分成 ledger 全量流水按 authorId 聚合（金额单位：分）
      const revenue = requireService<RevenueLedger>(setup, 'opc.marketplace.revenue')
      const byAuthor = new Map<string, { balance: number; splits: number; lastAt: number }>()
      for (const entry of revenue.listEntries()) {
        const agg = byAuthor.get(entry.authorId) ?? { balance: 0, splits: 0, lastAt: 0 }
        agg.balance += entry.creator
        agg.splits += 1
        agg.lastAt = Math.max(agg.lastAt, entry.recordedAt)
        byAuthor.set(entry.authorId, agg)
      }
      const creators = [...byAuthor.entries()]
        .map(([authorId, agg]) => ({ authorId, balance: agg.balance, splits: agg.splits, lastAt: agg.lastAt }))
        .sort((a, b) => b.balance - a.balance || a.authorId.localeCompare(b.authorId))
      sendJson(req, res, 200, { creators, unit: 'cents' })
      return
    }

    case 'GET /api/bills': {
      // DE-08 客户账单：买家维度订单 + 总消费（口径：paid+delivered 计入，pending/refunded/cancelled 不计；单位：分）
      const buyerId = nonEmptyParam(url.searchParams.get('buyerId'))
      if (!buyerId) throw new OpcError('VALIDATION_ERROR', 'query parameter buyerId is required')
      const orders = requireService<OrderEngine>(setup, 'opc.marketplace.orders')
      const list = orders.listByBuyer(buyerId).sort((a, b) => b.createdAt - a.createdAt)
      const totalSpentCents = list.filter((o) => isNetPositive(o.status)).reduce((sum, o) => sum + o.amount, 0)
      sendJson(req, res, 200, {
        buyerId,
        orders: list,
        totalSpent: totalSpentCents,
        totalSpentYuan: Math.round(totalSpentCents) / 100,
        unit: 'cents',
      })
      return
    }

    case 'GET /api/bills/summary': {
      // DE-08 汇总：买家/净额从分成 ledger join 订单状态推导（支付成功即入账，paid+delivered 计净额）；
      // 口径标注：订单金额单位为"分"，RaaS 计费与总收入单位为"元"（BillingEngine.unitPrice 语义）
      const orders = requireService<OrderEngine>(setup, 'opc.marketplace.orders')
      const revenue = setup.getService('opc.marketplace.revenue') as RevenueLedger | undefined
      const billing = setup.getService('opc.billing') as BillingEngine | undefined
      const stats = orders.stats()
      const { byBuyer, totalCents: orderNetAmountCents } = orderNetAggregates(orders, revenue)
      const raasRevenueYuan = billing ? billing.totalRevenue() : 0
      sendJson(req, res, 200, {
        buyers: [...byBuyer.entries()]
          .map(([buyerId, agg]) => ({ buyerId, orders: agg.orders, spent: agg.spent }))
          .sort((a, b) => b.spent - a.spent || a.buyerId.localeCompare(b.buyerId)),
        totalBuyers: byBuyer.size,
        totalOrders: stats.totalPaid,
        orderNetCount: stats.netRevenue,
        orderNetAmountCents,
        raasRevenueYuan,
        totalRevenueYuan: Math.round((orderNetAmountCents / 100 + raasRevenueYuan) * 100) / 100,
        units: {
          orderAmounts: 'cents(分)',
          raasAndTotalRevenue: 'yuan(元)',
          notes: 'spent/orderNetAmountCents 为分；raasRevenueYuan/totalRevenueYuan 为元；totalOrders 为支付成功笔数（stats.totalPaid，含其后退款），orderNetCount 为 paid+delivered 笔数（stats.netRevenue）',
        },
      })
      return
    }

    case 'GET /api/billing/summary': {
      const engine = requireService<BillingEngine>(setup, 'opc.billing')
      sendJson(req, res, 200, {
        records: readBillingRecords(setup.billingLogFile).slice(-20).reverse(),
        totalRevenue: engine.totalRevenue(),
      })
      return
    }

    case 'POST /api/billing/complete': {
      const body = await readJsonObject(req)
      const complete = requireService<BillingComplete>(setup, 'opc.billing.complete')
      const record = complete({
        taskId: requireString(body, 'taskId'),
        agentId: requireString(body, 'agentId'),
        resolution: requireOneOf(body, 'resolution', ['resolved', 'escalated'] as const),
      })
      sendJson(req, res, 200, record)
      return
    }

    case 'GET /api/memory': {
      const memory = requireService<MemoryService>(setup, 'opc.memory')
      const entries = memory.query({
        keyword: nonEmptyParam(url.searchParams.get('q')),
        category: nonEmptyParam(url.searchParams.get('category')) as MemoryQuery['category'],
        limit: 50,
      })
      sendJson(req, res, 200, { entries })
      return
    }

    case 'POST /api/memory': {
      const body = await readJsonObject(req)
      const memory = requireService<MemoryService>(setup, 'opc.memory')
      const entry = memory.write({
        scope: requireOneOf(body, 'scope', ['global', 'workflow', 'agent'] as const),
        category: requireOneOf(body, 'category', ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'] as const),
        content: requireString(body, 'content'),
        confidence: requireConfidence(body),
      })
      sendJson(req, res, 200, entry)
      return
    }

    case 'POST /api/ideas': {
      // 创意录入（一等入口，prd2.md ID-01/ID-03）：文本 → Idea 实体（自动三域草案）
      // + 目录初始化（memory-body/ledger/token/profile/meta）+ 描述写入记忆体正本。
      // topic 记忆镜像保留：Content Engine 的选题策略仍从 topic 记忆直连候选，
      // 「创意 → 内容流水线」通路不变；镜像插件缺席（隔离）时静默跳过。
      const body = await readJsonObject(req)
      const text = requireString(body, 'text').trim()
      if (text.length === 0) {
        throw new OpcError('VALIDATION_ERROR', 'field text must be a non-empty string')
      }
      const store = setup.ideaStore
      if (!store) {
        // 降级：未配置创意库时保持 v1 行为（topic 记忆直写）
        const memory = requireService<MemoryService>(setup, 'opc.memory')
        const entry = memory.write({ scope: 'global', category: 'topic', content: text, confidence: 0.8 })
        const content = setup.getService('opc.content') as ContentService | undefined
        content?.memory.write({ scope: 'global', category: 'topic', content: text, confidence: 0.8 })
        sendJson(req, res, 200, { entry, hint: '已进入选题记忆，运行内容流水线时将驱动选题' })
        return
      }
      const optionalName =
        typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : undefined
      const idea = store.create({ text, name: optionalName })
      const memory = setup.getService('opc.memory') as MemoryService | undefined
      memory?.write({ scope: 'global', category: 'topic', content: text, confidence: 0.8 })
      const content = setup.getService('opc.content') as ContentService | undefined
      content?.memory.write({ scope: 'global', category: 'topic', content: text, confidence: 0.8 })
      setup.memoryHub?.write(idea.id, 'description', { content: text, confidence: 0.8, authority: 'user' })
      sendJson(req, res, 200, {
        idea,
        hint: '已生成三域草案并初始化独立记忆体，去「我的创意」迭代三域或运行内容流水线',
      })
      return
    }

    case 'GET /api/ideas': {
      // 创意列表：实体库新建在前；未配置实体库时降级为 topic 记忆伪实体（前端同构渲染）
      const store = setup.ideaStore
      if (store) {
        sendJson(req, res, 200, { ideas: store.list() })
        return
      }
      const memory = requireService<MemoryService>(setup, 'opc.memory')
      const ideas = memory
        .query({ category: 'topic', limit: 1000 })
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((entry) => ({
          id: entry.id,
          name: entry.content,
          stage: 'description' as const,
          domains: null,
          createdAt: entry.createdAt,
          updatedAt: entry.createdAt,
        }))
      sendJson(req, res, 200, { ideas })
      return
    }

    case 'GET /api/guiding-questions': {
      // ID-02 三域引导问题（每域 ≥3 个）
      sendJson(req, res, 200, { questions: GUIDING_QUESTIONS })
      return
    }

    case 'POST /api/memory-bodies/mount': {
      // 挂载协议（prd2.md 2.4 / 8.3）：/mount <idea-id>... 的控制台等价面
      const body = await readJsonObject(req)
      const hub = requireMemoryHub(setup)
      const rawIds = body.ideaIds
      if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.some((v) => typeof v !== 'string' || v.trim().length === 0)) {
        throw new OpcError('VALIDATION_ERROR', 'field ideaIds must be a non-empty array of idea ids')
      }
      const ideaIds = [...new Set((rawIds as string[]).map((v) => v.trim()))]
      const actionRaw = body.action
      if (actionRaw !== undefined && actionRaw !== 'mount' && actionRaw !== 'unmount') {
        throw new OpcError('VALIDATION_ERROR', 'field action must be one of: mount, unmount')
      }
      const action = actionRaw ?? 'mount'
      const mounted = action === 'unmount' ? hub.unmount(...ideaIds) : hub.mount(...ideaIds)
      sendJson(req, res, 200, {
        mounted,
        hint: action === 'unmount' ? '已卸载：卸载后其记忆不再被跨创意检索命中' : '已挂载：跨创意检索现在只命中挂载清单',
      })
      return
    }

    case 'GET /api/memory-bodies': {
      // 跨记忆体检索（默认限定已挂载集合）+ 当前挂载清单
      const hub = requireMemoryHub(setup)
      const keyword = nonEmptyParam(url.searchParams.get('q'))
      const limit = parseLimit(url.searchParams.get('limit'), 20, 200)
      const entries = hub.query({ keyword, limit })
      sendJson(req, res, 200, { mounted: hub.listMounted(), entries })
      return
    }

    case 'GET /api/funnel': {
      // 创意变现漏斗（创意 → 作品 → 收入）：一次请求全量返回四段计数；
      // 个别插件缺席（隔离）时该段降级计 0，不让漏斗整体 503
      const memory = setup.getService('opc.memory') as MemoryService | undefined
      const content = setup.getService('opc.content') as ContentService | undefined
      const forge = setup.getService('opc.skillforge') as SkillForgeService | undefined
      const orders = setup.getService('opc.marketplace.orders') as OrderEngine | undefined
      const billing = setup.getService('opc.billing') as BillingEngine | undefined
      const revenueLedger = setup.getService('opc.marketplace.revenue') as RevenueLedger | undefined
      sendJson(req, res, 200, {
        // 段1 创意：实体库优先（与 GET /api/ideas 同源），实体库缺席降级 topic 记忆计数
        ideas: setup.ideaStore
          ? setup.ideaStore.count()
          : memory
            ? memory.query({ category: 'topic', limit: 1000 }).length
            : 0,
        // 段2 作品：流水线运行次数 + 已发布篇数（contentEvents 环形缓冲中 content_publish 计数）
        contents: {
          runs: content ? content.stats().runs : 0,
          published: setup.contentEvents.filter((event) => event.type === 'content_publish').length,
        },
        // 段3 Skill：本能蒸馏草案数 / 市场在售数
        skills: {
          drafts: forge ? forge.listDrafts().length : 0,
          listed: setup.skillsIndex.count(),
        },
        // 段4 收入：订单净额（paid+delivered，与 /api/bills/summary 共用 orderNetAggregates 口径）+ RaaS 计费收入
        revenue: {
          orderNetCount: orders ? orders.stats().netRevenue : 0,
          orderNetCents: orders ? orderNetAggregates(orders, revenueLedger).totalCents : 0,
          raasRevenueYuan: billing ? billing.totalRevenue() : 0,
        },
      })
      return
    }

    case 'GET /api/overview': {
      // 聚合端点对个别插件缺席保持降级（计 0），不让 /api/overview 整体 503
      const team = setup.getService('opc.team') as TeamService | undefined
      const board = setup.getService('opc.blackboard') as BlackboardService | undefined
      const memory = setup.getService('opc.memory') as MemoryService | undefined
      const orders = setup.getService('opc.marketplace.orders') as OrderEngine | undefined
      const billing = setup.getService('opc.billing') as BillingEngine | undefined
      sendJson(req, res, 200, {
        team: { templates: team ? team.fallbackTemplates().length : 0 },
        blackboard: {
          global: board ? board.read('global').length : 0,
          workflow: board ? board.read('workflow').length : 0,
        },
        market: { skills: setup.skillsIndex.count() },
        orders: orders ? orders.stats() : { totalPaid: 0, refunded: 0, netRevenue: 0 },
        billing: { revenue: billing ? billing.totalRevenue() : 0 },
        memory: { count: memory ? memory.query({ limit: 1000 }).length : 0 },
        telemetry: { recent: setup.telemetry.slice(-20) },
      })
      return
    }

    default: {
      // 参数路由：创意实体（M1 创意一等公民）
      //   GET   /api/ideas/:id           详情（实体 + 目录 + 引导问题 + 记忆体近况 + 挂载态）
      //   PATCH /api/ideas/:id/domains   三域迭代（ID-02：整域或单域，同步写记忆体正本）
      //   GET  /api/ideas/:id/entries    单创意记忆体检索（?q=&stream=&limit=）
      //   POST /api/ideas/:id/entries    写入记忆体（stream/content/confidence/authority）
      if (path.startsWith('/api/ideas/')) {
        const store = requireIdeaStore(setup)
        const segments = path.slice('/api/ideas/'.length).split('/').filter((s) => s.length > 0)
        const ideaId = decodePathSegment(segments[0] ?? '', 'ideaId')
        const hub = setup.memoryHub
        if (segments.length === 1) {
          if (method !== 'GET') {
            throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id is not supported`)
          }
          const idea = store.require(ideaId)
          const homeDir = store.homeDir(ideaId) ?? null
          sendJson(req, res, 200, {
            idea,
            home: homeDir
              ? {
                  root: homeDir,
                  memoryBody: join(homeDir, 'memory-body'),
                  profile: join(homeDir, 'profile', 'cordis.patch.yml'),
                  ledger: join(homeDir, 'assets', 'ledger.json'),
                  token: join(homeDir, 'assets', 'token.json'),
                }
              : null,
            guidingQuestions: GUIDING_QUESTIONS,
            streams: IDEA_MEMORY_STREAMS,
            entries: hub ? hub.query({ ideaIds: [ideaId], limit: 20 }) : [],
            mounted: hub ? hub.isMounted(ideaId) : false,
          })
          return
        }
        if (segments.length === 2 && decodePathSegment(segments[1], 'sub') === 'domains') {
          if (method !== 'PATCH') {
            throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id/domains is not supported`)
          }
          const body = await readJsonObject(req)
          let updated: Idea
          if (typeof body.domain === 'string') {
            const key = requireOneOf(body, 'domain', DOMAIN_KEYS) as DomainKey
            const summary = typeof body.summary === 'string' ? body.summary : undefined
            const points = Array.isArray(body.points) ? body.points.map((p) => String(p)) : undefined
            updated = store.updateDomain(ideaId, key, { summary, points })
            hub?.write(ideaId, 'description', {
              content: `三域迭代[${DOMAIN_LABELS[key]}] ${updated.domains[key].summary}` +
                (updated.domains[key].points.length > 0 ? `（要点：${updated.domains[key].points.join('；')}）` : ''),
              confidence: 0.8,
              authority: 'user',
            })
          } else {
            const domains = validateDomains(body)
            updated = store.updateDomains(ideaId, domains)
            hub?.write(ideaId, 'description', {
              content: `三域整体迭代 ${JSON.stringify(domains)}`,
              confidence: 0.8,
              authority: 'user',
            })
          }
          sendJson(req, res, 200, { idea: updated })
          return
        }
        if (segments.length === 2 && decodePathSegment(segments[1], 'sub') === 'entries') {
          if (method === 'GET') {
            const keyword = nonEmptyParam(url.searchParams.get('q'))
            const stream = nonEmptyParam(url.searchParams.get('stream'))
            if (stream !== undefined && !(IDEA_MEMORY_STREAMS as readonly string[]).includes(stream)) {
              throw new OpcError('VALIDATION_ERROR', `query parameter stream must be one of: ${IDEA_MEMORY_STREAMS.join(', ')}`)
            }
            const limit = parseLimit(url.searchParams.get('limit'), 20, 200)
            const entries = requireMemoryHub(setup).query({
              keyword,
              stream: stream as IdeaMemoryStream | undefined,
              ideaIds: [ideaId],
              limit,
            })
            sendJson(req, res, 200, { entries })
            return
          }
          if (method === 'POST') {
            const body = await readJsonObject(req)
            const entry = requireMemoryHub(setup).write(ideaId, requireString(body, 'stream'), {
              content: requireString(body, 'content'),
              confidence: requireConfidence(body),
              ...(body.authority === undefined
                ? {}
                : { authority: requireOneOf(body, 'authority', ['user', 'model'] as const) }),
            })
            sendJson(req, res, 200, { entry })
            return
          }
          throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id/entries is not supported`)
        }
        throw new OpcError('NOT_FOUND', `no such path: ${path}`)
      }
      // 参数路由：GET /api/creators/:authorId → 该作者的累计余额与分成流水（时间倒序）
      if (method === 'GET' && path.startsWith('/api/creators/')) {
        const authorId = decodePathSegment(path.slice('/api/creators/'.length), 'authorId')
        const revenue = requireService<RevenueLedger>(setup, 'opc.marketplace.revenue')
        const entries = revenue
          .listEntries()
          .filter((e) => e.authorId === authorId)
          .sort((a, b) => b.recordedAt - a.recordedAt)
        sendJson(req, res, 200, { authorId, balance: revenue.creatorBalance(authorId), entries })
        return
      }
      if (API_PATHS.has(path) || (method !== 'GET' && path.startsWith('/api/creators/'))) {
        throw new OpcError('METHOD_NOT_ALLOWED', `${method} ${path} is not supported`)
      }
      throw new OpcError('NOT_FOUND', `no such path: ${path}`)
    }
  }
}

/**
 * REST 端点分发（市场/计费/创作者/账单 + Content Engine 3 条 + 任务板 5 条 + 草案上架 1 条
 * + 创意变现漏斗 3 条：POST/GET /api/ideas、GET /api/funnel）
 * + OpcError → {error:{code,message}} 映射
 * （原 handleRequest 的 API 半区）。
 * @param urlPrefix hosted 模式传挂载前缀（如 '/opcos'），从 pathname 剥离后再匹配 /api/*
 */
export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  setup: ConsoleSetup,
  urlPrefix = '',
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', REQUEST_BASE)
    const path = stripUrlPrefix(url.pathname, urlPrefix)
    if (!path.startsWith('/api/')) {
      throw new OpcError('NOT_FOUND', `no such path: ${path}`)
    }
    await dispatchApi(url, path, req, res, setup)
  } catch (error) {
    sendError(req, res, error)
  }
}

/** 静态资源（原 serveStatic：/ → index.html/占位页，其余按 safe 路径映射文件，缺失 404 JSON） */
function serveStaticPath(pathname: string, req: IncomingMessage, res: ServerResponse, setup: ConsoleSetup): void {
  if (pathname === '/') {
    const indexPath = join(setup.staticDir, 'index.html')
    if (existsSync(indexPath)) {
      sendFile(req, res, 200, indexPath)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PLACEHOLDER_HTML)
    return
  }
  const relative = pathname.replace(/^\/+/, '')
  if (relative.length === 0 || relative.includes('..') || relative.includes('\\') || relative.includes('\0')) {
    sendStaticNotFound(req, res, pathname)
    return
  }
  const filePath = join(setup.staticDir, relative)
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendStaticNotFound(req, res, pathname)
    return
  }
  sendFile(req, res, 200, filePath)
}

/**
 * 静态文件入口（自捕获异常）。
 * @param urlPrefix hosted 模式传挂载前缀：'/opcos/app.js' 剥前缀后映射 static/app.js
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  setup: ConsoleSetup,
  urlPrefix = '',
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', REQUEST_BASE)
    serveStaticPath(stripUrlPrefix(url.pathname, urlPrefix), req, res, setup)
  } catch (error) {
    sendError(req, res, error)
  }
}

/** standalone 全量分发（原 handleRequest 的路由半区）：/api/* → API，其余 → 静态 */
export async function handleConsoleRequest(req: IncomingMessage, res: ServerResponse, setup: ConsoleSetup): Promise<void> {
  try {
    const path = new URL(req.url ?? '/', REQUEST_BASE).pathname
    if (path.startsWith('/api/')) {
      await handleApiRequest(req, res, setup)
    } else {
      await serveStatic(req, res, setup)
    }
  } catch (error) {
    sendError(req, res, error)
  }
}
