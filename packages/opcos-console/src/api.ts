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
  UserStore,
  SessionStore,
  TeamStore,
  extractSessionToken,
  SESSION_COOKIE,
  AUTH_FAIL_DELAY_MS,
  SqliteIdeaStore,
  SqliteSkillIndex,
  SqliteIdeaMarket,
  MemoryBodyHub,
  IdeaLifecycle,
  IdeaMemoryBridge,
  IdeaWorkspace,
  IdeaLedger,
  TokenLedger,
  SubscriptionStore,
  requirePeriod,
  TOKEN_ROLES,
  TOKEN_ROLE_LABELS,
  COLLAB_ROLES,
  MultiPlatformDispatcher,
  defaultPlatformAdapters,
  installFromMarket,
  planMvp,
  suggestGoNoGo,
  workspacePathFor,
  PLATFORMS,
  GUIDING_QUESTIONS,
  DOMAIN_KEYS,
  DOMAIN_LABELS,
  IDEA_MEMORY_STREAMS,
  IDEA_STAGES,
  validateDomains,
  type BillingRecord,
  type BlackboardEntry,
  type BlackboardScope,
  type BlackboardWrite,
  type BillingEngine,
  type CollabRole,
  type DomainKey,
  type Idea,
  type IdeaMemoryStream,
  type IdeaMarketSummary,
  type MarketSkill,
  type MemoryEntry,
  type MemoryQuery,
  type MvpValidation,
  type NewMemoryEntry,
  type Order,
  type OrderEngine,
  type Platform,
  type RankingKey,
  type SkillDefinition,
  type SplitEntry,
  type Task,
  type Team,
  type TeamMember,
  type TeamRole,
  type ThreeDomains,
  type User,
  type WriteResult,
} from '../../core/src/index.js'
import type { PipelineRunResult } from '../../core/src/content/pipeline.js'
import { createPackage, type Ed25519KeyPair, type SkillPackage } from '../../core/src/skill/packager.js'
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

/** Content Engine 服务（opc.content 的结构子集，PRD 6.3 系统三 + prd2.md M3） */
interface ContentService {
  /**
   * 选题 → 撰写 → 审核 → 分发 全流程（LLM 模式下可能耗时数秒）。
   * ideaId 指定创意时切换到该创意记忆体人设（CO-02，需 setIdeaMemoryResolver 先注入）。
   */
  run(ideaId?: string): Promise<PipelineRunResult>
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
  /** 每创意人设记忆解析器注入口（CO-02，插件缺席/旧版本时可选） */
  setIdeaMemoryResolver?(resolver: (ideaId: string) => unknown): void
}

/** GEO 监测服务（opc.geo 的结构子集，prd2.md 4.4） */
interface GeoService {
  refresh(ideaId: string, keywords?: readonly string[]): Promise<{
    ideaId: string
    snapshots: Array<{ platform: string; visibility: number; citationRate: number; sentiment: number; at: number }>
    alerts: Array<{ platform: string; drop: number; previous: number; value: number; threshold: number }>
    simulated: boolean
  }>
  history(ideaId: string, limit?: number): Array<{
    platform: string; visibility: number; citationRate: number; sentiment: number; at: number
  }>
  config(): { platforms: readonly string[]; alertThreshold: number; simulated: boolean }
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
  SUBSCRIPTION_REQUIRED: 402,
  PERMISSION_DENIED: 403,
  ORDER_NOT_FOUND: 404,
  SKILL_NOT_FOUND: 404,
  IDEA_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  TEAM_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  UNAUTHORIZED: 401,
  AUTH_FAILED: 401,
  VERSION_CONFLICT: 409,
  USERNAME_TAKEN: 409,
  ORDER_STATE_INVALID: 409,
  STAGE_TRANSITION_INVALID: 409,
  TOKEN_ALLOCATION_EXCEEDED: 409,
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
  /** 创意市场索引（可选：市场/关注/关联/排行端点依赖；缺省时相关端点 503） */
  ideaMarket?: SqliteIdeaMarket
  /** 订阅权益存储（可选：订阅激活与权益查询端点依赖；缺省时订阅支付不激活权益） */
  subscriptions?: SubscriptionStore
  /** 目录级签名密钥（可选：publish-draft 用它签名新包，保证验签公钥同源） */
  signingKeys?: Ed25519KeyPair
  /** 多用户身份层（可选：缺省时保持 v1 单用户无鉴权行为） */
  auth?: AuthStores
}

/** 多用户身份三件套（users/sessions/teams 同批构造） */
export interface AuthStores {
  users: UserStore
  sessions: SessionStore
  teams: TeamStore
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
  /** 创意市场索引（缺省 undefined：市场端点降级） */
  readonly ideaMarket?: SqliteIdeaMarket
  /** 订阅权益存储（缺省 undefined：订阅支付不激活权益） */
  readonly subscriptions?: SubscriptionStore
  /** 目录级签名密钥（publish-draft 签名新包用；缺省时每次生成独立密钥） */
  readonly signingKeys?: Ed25519KeyPair
  /** 多用户身份层（缺省 undefined：单用户无鉴权模式） */
  readonly auth?: AuthStores
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
    ideaMarket: deps.ideaMarket,
    signingKeys: deps.signingKeys,
    subscriptions: deps.subscriptions,
    auth: deps.auth,
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
  /** 目录级签名密钥（私钥仅内存持有）：后续上架的草案用它签名，保证与验签公钥同源 */
  signingKeys: Ed25519KeyPair
} {
  const index = new SqliteSkillIndex(skillsDbPath)
  const [firstSample, ...restSamples] = SAMPLE_SKILLS
  const firstBuild = createPackage(firstSample.definition, firstSample.entry.authorId)
  const publicKeyPem = firstBuild.keys.publicKeyPem
  const signingKeys = firstBuild.keys
  const pkgStore = new Map<string, SkillPackage>([[firstSample.entry.id, firstBuild.pkg]])
  for (const sample of restSamples) {
    pkgStore.set(sample.entry.id, createPackage(sample.definition, sample.entry.authorId, firstBuild.keys).pkg)
  }
  if (index.count() === 0) {
    index.upsertAll(SAMPLE_SKILLS.map((s) => s.entry))
  }
  return { index, pkgStore, publicKeyPem, signingKeys }
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

/** 订阅权益存储必取 */
function requireSubscriptions(setup: ConsoleSetup): SubscriptionStore {
  if (!setup.subscriptions) {
    throw new OpcError('SERVICE_UNAVAILABLE', 'subscription store is not configured in console deps')
  }
  return setup.subscriptions
}

/* ─────────────── 多用户鉴权（prd2.md 云操作系统） ─────────────── */

function requireAuthStores(setup: ConsoleSetup): AuthStores {
  if (!setup.auth) {
    throw new OpcError('SERVICE_UNAVAILABLE', 'auth stores are not configured in console deps')
  }
  return setup.auth
}

/** 从请求 Cookie 解析当前登录用户（会话滑动续期在 resolve 内发生） */
function resolveUser(setup: ConsoleSetup, req: IncomingMessage): User | undefined {
  if (!setup.auth) return undefined
  const token = extractSessionToken(req.headers.cookie)
  if (!token) return undefined
  const session = setup.auth.sessions.resolve(token)
  if (!session) return undefined
  return setup.auth.users.getById(session.userId)
}

/** 签发会话并写入 HttpOnly Cookie（反代 HTTPS 场景自动加 Secure） */
function issueSession(setup: ConsoleSetup, req: IncomingMessage, res: ServerResponse, userId: string): void {
  const { sessions } = requireAuthStores(setup)
  const { token, expiresAt } = sessions.create(userId)
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
  res.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure}`,
  )
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

/** 当前用户的团队 ID 列表（创意可见性口径） */
function userTeamIds(setup: ConsoleSetup, user: User): string[] {
  if (!setup.auth) return []
  return setup.auth.teams.listForUser(user.id).map((t) => t.id)
}

/** 创意访问控制：owner / 团队成员 / 存量无主（在 store.require 404 之后调用，命中不了抛 403） */
function requireIdeaAccess(setup: ConsoleSetup, user: User, ideaId: string): void {
  if (!setup.ideaStore) return
  if (!setup.ideaStore.canAccess(ideaId, user.id, userTeamIds(setup, user))) {
    throw new OpcError('PERMISSION_DENIED', `idea ${ideaId} is not accessible to ${user.username}`)
  }
}

/** 成员信息补充用户名/昵称（控制台展示用；查无此人保留 ID） */
function enrichMember(users: UserStore, member: TeamMember): TeamMember & { username?: string; displayName?: string } {
  const found = users.getById(member.userId)
  return {
    ...member,
    ...(found ? { username: found.username, displayName: found.displayName } : {}),
  }
}

/** 公开端点白名单：健康探针与登录/注册（其余一律需要会话） */
function isAnonymousAllowed(path: string): boolean {
  return path === '/api/health' || path.startsWith('/api/auth/')
}

/** 需要登录的端点取当前用户（鉴权闸门已保证 auth 开启时非匿名路径必有 user） */
function requireUser(user: User | undefined): User {
  if (!user) throw new OpcError('UNAUTHORIZED', 'login required')
  return user
}

/** 创意市场索引必取 */
function requireIdeaMarket(setup: ConsoleSetup): SqliteIdeaMarket {
  if (!setup.ideaMarket) {
    throw new OpcError('SERVICE_UNAVAILABLE', 'idea market is not configured in console deps')
  }
  return setup.ideaMarket
}

/** 由创意实体 + 资产账本构建公开摘要（IM-01：摘要、阶段、资产概况） */
function marketSummaryFor(setup: ConsoleSetup, idea: Idea): IdeaMarketSummary {
  let financeTotalCents = 0
  let geoVisibility = 0
  const home = setup.ideaStore?.homeDir(idea.id)
  if (home) {
    const assets = IdeaLedger.forIdeaHome(home, idea.id).read().assets
    financeTotalCents = assets.finance.total
    geoVisibility = assets.analytics.geo_visibility
  }
  return {
    ideaId: idea.id,
    name: idea.name,
    stage: idea.stage,
    problemSummary: idea.domains.problem.summary,
    solutionSummary: idea.domains.solution.summary,
    spacetimeSummary: idea.domains.spacetime.summary,
    financeTotalCents,
    geoVisibility,
    publishedAt: Date.now(),
    followers: 0,
  }
}

/** 创意资产账本必取（ideas/<id>/assets/ledger.json，prd2.md 5.5） */
function requireIdeaLedger(setup: ConsoleSetup, ideaId: string): IdeaLedger {
  const store = requireIdeaStore(setup)
  store.require(ideaId)
  const home = store.homeDir(ideaId)
  if (!home) throw new OpcError('SERVICE_UNAVAILABLE', 'ledger requires ideas root to be configured')
  return IdeaLedger.forIdeaHome(home, ideaId)
}

/** Token 积分账本必取（assets/token.json + distribution.json，R-02 积分定位） */
function requireTokenLedger(setup: ConsoleSetup, ideaId: string): TokenLedger {
  const store = requireIdeaStore(setup)
  store.require(ideaId)
  const home = store.homeDir(ideaId)
  if (!home) throw new OpcError('SERVICE_UNAVAILABLE', 'token ledger requires ideas root to be configured')
  return new TokenLedger(home, ideaId)
}

/** 生命周期编排器（无状态逻辑，按需组装；与 opc-lifecycle 插件共享同一 core 实现） */
function requireLifecycle(setup: ConsoleSetup): IdeaLifecycle {
  return new IdeaLifecycle(requireIdeaStore(setup), setup.memoryHub ?? undefined)
}

/**
 * 把"创意记忆体 → 人设记忆"解析器注给 Content Engine（CO-02 幂等接线）：
 * run(ideaId) 时选题/人设/沉淀全部落到该创意的记忆体；插件缺席（隔离）或
 * 创意不存在时静默回退全局人设记忆，run 本身不失败。
 */
function wireIdeaMemory(setup: ConsoleSetup, content: ContentService): void {
  if (!setup.ideaStore || !setup.memoryHub) return
  if (typeof content.setIdeaMemoryResolver !== 'function') return
  content.setIdeaMemoryResolver((ideaId: string) => {
    if (!setup.ideaStore?.get(ideaId)) return undefined
    return new IdeaMemoryBridge(setup.memoryHub!, ideaId)
  })
}

/** 从 research 流正本回读 MVP 验证记录（kind=mvp-validation 的结构化 JSON 条目） */
function listValidations(hub: MemoryBodyHub, ideaId: string): MvpValidation[] {
  return hub
    .query({ ideaIds: [ideaId], stream: 'research', limit: 200 })
    .map((entry) => {
      try {
        return JSON.parse(entry.content) as unknown
      } catch {
        return null
      }
    })
    .filter(
      (v): v is MvpValidation =>
        typeof v === 'object' && v !== null && (v as MvpValidation).kind === 'mvp-validation',
    )
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

/** MVP 验证评分（0..5，IP-03/IP-04 口径） */
function requireScore05(body: Record<string, unknown>): number {
  const score = body.score
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 5) {
    throw new OpcError('VALIDATION_ERROR', 'field score must be a number within [0,5]')
  }
  return score
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
  '/api/market/ideas',
  '/api/market/rankings',
  '/api/market/follows',
  '/api/notifications',
  '/api/revenue/daily',
  '/api/subscriptions',
  '/api/subscriptions/status',
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
  // 多用户鉴权闸门：未登录一律 401（健康探针与 /api/auth/* 除外；未配置 auth 库 = v1 单用户模式不拦）
  const user = resolveUser(setup, req)
  if (!user && !isAnonymousAllowed(path) && setup.auth) {
    throw new OpcError('UNAUTHORIZED', 'login required (POST /api/auth/login or /api/auth/register)')
  }
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
      // 选题→撰写→审核→分发全链路（LLM 模式可能耗时数秒，直接 await 由前端 loading）。
      // M3：body.ideaId 指定创意 → 人设切换到该创意记忆体（CO-02）；
      // body.platforms 指定分发矩阵（缺省全平台，CO-03），由发布产物多平台适配分发。
      const body = await readJsonObject(req)
      const content = requireService<ContentService>(setup, 'opc.content')
      wireIdeaMemory(setup, content)
      const ideaId =
        typeof body.ideaId === 'string' && body.ideaId.trim().length > 0 ? body.ideaId.trim() : undefined
      const result = await content.run(ideaId)
      let dispatch: unknown
      if (body.platforms !== false) {
        const requested = Array.isArray(body.platforms) ? body.platforms : undefined
        if (requested?.some((p) => typeof p !== 'string' || !(PLATFORMS as readonly string[]).includes(p))) {
          throw new OpcError('VALIDATION_ERROR', `field platforms must be a subset of: ${PLATFORMS.join(', ')}`)
        }
        const adapters = defaultPlatformAdapters(
          (requested as readonly Platform[] | undefined) ?? PLATFORMS,
        )
        dispatch = await new MultiPlatformDispatcher(adapters).dispatch(result.content)
      }
      sendJson(req, res, 200, { ...result, dispatch })
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
      const stage = nonEmptyParam(url.searchParams.get('stage'))
      const compatDsh = nonEmptyParam(url.searchParams.get('compat'))
      const limit = parseLimit(url.searchParams.get('limit'), DEFAULT_SKILL_PAGE_SIZE, MAX_SKILL_PAGE_SIZE)
      // 先取全量命中（受 TOTAL_SCAN_LIMIT 上限约束）以计算 total，再切页
      const matched = setup.skillsIndex.search({ keyword, category, stage, compatDsh, limit: TOTAL_SCAN_LIMIT })
      // SM-04 定价模型：metadata 里携带 pricing_model/period 的条目随结果回传
      const results = matched.slice(0, limit).map((skill) => {
        const pricingModel = setup.skillsIndex.getMetadata(skill.id, 'pricing_model')
        const stage = setup.skillsIndex.getMetadata(skill.id, 'stage')
        return {
          ...skill,
          ...(pricingModel
            ? { pricing: { model: pricingModel, period: setup.skillsIndex.getMetadata(skill.id, 'period') } }
            : {}),
          ...(stage ? { stage } : {}),
        }
      })
      sendJson(req, res, 200, { results, total: matched.length })
      return
    }

    case 'POST /api/skills/install': {
      const body = await readJsonObject(req)
      const skillId = requireString(body, 'skillId')
      // SM-04 订阅权益：订阅制技能安装需买家在订阅期内（免费/一次性不拦）
      let buyerId: string | undefined
      if (setup.skillsIndex.getMetadata(skillId, 'pricing_model') === 'subscription') {
        buyerId = typeof body.buyerId === 'string' && body.buyerId.trim().length > 0
          ? body.buyerId.trim()
          : user?.username
        if (!buyerId) throw new OpcError('SUBSCRIPTION_REQUIRED', '订阅制技能需要登录后安装（校验订阅权益）')
        if (setup.subscriptions && !setup.subscriptions.statusOf(buyerId, skillId).active) {
          throw new OpcError('SUBSCRIPTION_REQUIRED', `skill ${skillId} 需要有效订阅：请先订阅再安装`)
        }
      }
      // SM-02 安装到指定创意：body.ideaId → 落盘该创意目录 skills/（子操作系统内），
      // 并写记忆体决策正本；缺省安装到全局 installed/
      const ideaId = typeof body.ideaId === 'string' && body.ideaId.trim().length > 0 ? body.ideaId.trim() : undefined
      let targetDir = setup.installedDir
      if (ideaId) {
        const store = requireIdeaStore(setup)
        store.require(ideaId)
        const home = store.homeDir(ideaId)
        if (!home) throw new OpcError('SERVICE_UNAVAILABLE', 'install-to-idea requires ideas root to be configured')
        targetDir = join(home, 'skills')
      }
      const installedPath = await installFromMarket(
        setup.skillsIndex,
        setup.pkgStore,
        setup.publicKeyPem,
        skillId,
        targetDir,
      )
      if (ideaId) {
        setup.memoryHub?.write(ideaId, 'decisions', {
          content: `安装技能 ${skillId} 至本创意子操作系统（${installedPath}）`,
          confidence: 0.85,
          authority: 'user',
        })
      }
      sendJson(req, res, 200, { installedPath, ...(ideaId ? { ideaId } : {}) })
      return
    }

    case 'POST /api/skills/publish-draft': {
      // 草案→上架工作流：skillforge 首个草案 → 打包 → Ed25519 重新签名取公钥 → 市场索引。
      // M4（prd2.md 7.5/5.3）：body.ideaId 指定产出创意 → .skillpkg 元数据（stage/category）
      // + 作者记为该创意 + 创意资产账本记 Skill 沉淀。
      const body = await readJsonObject(req)
      const forge = requireService<SkillForgeService>(setup, 'opc.skillforge')
      const draft = forge.listDrafts()[0]
      if (!draft) {
        throw new OpcError('NO_DRAFTS', 'skillforge has no distilled drafts (repeat similar workflows to create one)')
      }
      const store = setup.ideaStore
      const ideaId =
        typeof body.ideaId === 'string' && body.ideaId.trim().length > 0 ? body.ideaId.trim() : undefined
      if (ideaId) requireIdeaStore(setup).require(ideaId) // 404 语义：创意必须存在
      const stage =
        body.stage === undefined ? undefined : requireOneOf(body, 'stage', IDEA_STAGES)
      const category = typeof body.category === 'string' && body.category.trim().length > 0 ? body.category.trim() : 'community'
      const authorId = ideaId ?? (typeof body.authorId === 'string' && body.authorId.length > 0 ? body.authorId : 'console-creator')
      // SF-04 打包信封（走 forge 路径）；用目录级密钥重新签名（与验签公钥同源，SM-02 可安装）
      forge.packageDraft(draft, authorId)
      const { pkg } = createPackage(draft, authorId, setup.signingKeys, ideaId ? { stage, category, ideaId } : undefined)
      const keys = { publicKeyPem: setup.publicKeyPem }
      const entry: MarketSkill = {
        id: pkg.manifest.skillId,
        name: pkg.manifest.name,
        version: pkg.manifest.version,
        authorId,
        price: 990,
        category,
        downloads: 0,
        rating: 0,
        createdAt: pkg.manifest.createdAt,
        compat: { dsh: '>=0.1.0-rc.7' },
      }
      setup.skillsIndex.upsert(entry)
      setup.pkgStore.set(entry.id, pkg) // 签名包入仓：后续验签安装（SM-02）必需
      if (ideaId) {
        setup.skillsIndex.setMetadata(entry.id, 'idea_id', ideaId)
        if (stage) setup.skillsIndex.setMetadata(entry.id, 'stage', stage)
        const home = store?.homeDir(ideaId)
        if (home) {
          IdeaLedger.forIdeaHome(home, ideaId).recordSkill({ id: entry.id, name: entry.name, status: 'listed' })
          setup.memoryHub?.write(ideaId, 'decisions', {
            content: `Skill 沉淀上架：${entry.name}（${category}${stage ? ` / ${stage}` : ''}），作者 ${authorId}`,
            confidence: 0.85,
            authority: 'model',
          })
        }
      }
      // SM-04 定价模型：free（直接安装）/ one_time（默认，下单购买）/ subscription（周期订阅）
      const pricingModel =
        body.pricingModel === undefined
          ? 'one_time'
          : requireOneOf(body, 'pricingModel', ['free', 'one_time', 'subscription'] as const)
      setup.skillsIndex.setMetadata(entry.id, 'pricing_model', pricingModel)
      if (pricingModel === 'subscription') {
        setup.skillsIndex.setMetadata(entry.id, 'period', requireString(body, 'period'))
      }
      sendJson(req, res, 200, {
        skillId: entry.id,
        name: entry.name,
        version: entry.version,
        authorId,
        price: entry.price,
        category: entry.category,
        pricing: { model: pricingModel, ...(pricingModel === 'subscription' ? { period: body.period } : {}) },
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
      // SM-04：免费技能无需下单——直接走 /api/skills/install 安装
      if (setup.skillsIndex.getMetadata(skillId, 'pricing_model') === 'free') {
        throw new OpcError('VALIDATION_ERROR', `skill ${skillId} is free: install it directly via /api/skills/install`)
      }
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
      // M4 资产联动：作者为某创意（authorId 即创意 ID）时，创作者分成（85%）入账
      // 该创意资产账本的 skill_revenue，财务收入自动归集到创意（prd2.md 5.2）。
      let creditedIdeaId: string | undefined
      const authorId = order.authorId ?? setup.skillsIndex.get(order.skillId)?.authorId
      if (authorId && setup.ideaStore?.get(authorId)) {
        const home = setup.ideaStore.homeDir(authorId)
        if (home) {
          IdeaLedger.forIdeaHome(home, authorId).recordSkill({
            id: order.skillId, name: setup.skillsIndex.get(order.skillId)?.name ?? order.skillId, status: 'listed', revenueCents: split.creator,
          })
          IdeaLedger.forIdeaHome(home, authorId).recordRevenue('skill', split.creator)
          setup.memoryHub?.write(authorId, 'research', {
            content: JSON.stringify({ kind: 'skill-revenue', skillId: order.skillId, orderId: order.id, creatorCents: split.creator }),
            confidence: 0.8,
            authority: 'model',
          })
          creditedIdeaId = authorId
        }
      }
      // SM-04 订阅语义：订阅技能支付成功 → 激活/顺延一个周期权益
      let subscription: unknown
      if (setup.skillsIndex.getMetadata(order.skillId, 'pricing_model') === 'subscription') {
        const period = requirePeriod(setup.skillsIndex.getMetadata(order.skillId, 'period') ?? 'monthly')
        subscription = setup.subscriptions?.activate({
          skillId: order.skillId,
          version: order.version,
          buyerId: order.buyerId,
          period,
          orderId: order.id,
        })
      }
      sendJson(req, res, 200, {
        order,
        split,
        ...(creditedIdeaId ? { creditedIdeaId } : {}),
        ...(subscription ? { subscription } : {}),
      })
      return
    }

    case 'GET /api/subscriptions': {
      // SM-04：买家订阅清单（懒判定 active）
      const subscriptions = requireSubscriptions(setup)
      const buyerId = nonEmptyParam(url.searchParams.get('buyerId'))
      if (buyerId === undefined) {
        throw new OpcError('VALIDATION_ERROR', 'query parameter buyerId is required')
      }
      sendJson(req, res, 200, { subscriptions: subscriptions.listByBuyer(buyerId) })
      return
    }

    case 'GET /api/subscriptions/status': {
      // SM-04：Agent 调用前的权益检查（active = 在订阅期内）
      const subscriptions = requireSubscriptions(setup)
      const buyerId = nonEmptyParam(url.searchParams.get('buyerId'))
      const skillId = nonEmptyParam(url.searchParams.get('skillId'))
      if (buyerId === undefined || skillId === undefined) {
        throw new OpcError('VALIDATION_ERROR', 'query parameters buyerId and skillId are required')
      }
      sendJson(req, res, 200, { buyerId, skillId, ...subscriptions.statusOf(buyerId, skillId) })
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
      // 多用户：创意归属当前登录者；teamId 归属需为该团队成员（v1 无鉴权模式不归属）
      const owner = setup.auth ? requireUser(user) : undefined
      let teamId: string | undefined
      if (owner && typeof body.teamId === 'string' && body.teamId.trim().length > 0) {
        teamId = body.teamId.trim()
        const teams = setup.auth?.teams
        if (!teams || !teams.isMember(teamId, owner.id)) {
          throw new OpcError('PERMISSION_DENIED', `team ${teamId} is not accessible to ${owner.username}`)
        }
      }
      const idea = store.create({
        text,
        name: optionalName,
        ...(owner ? { ownerId: owner.id } : {}),
        ...(teamId ? { teamId } : {}),
      })
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
      // 创意列表：实体库按登录者可见性过滤（我的 + 团队的 + 存量无主）；
      // 未配置实体库时降级为 topic 记忆伪实体（前端同构渲染）
      const store = setup.ideaStore
      if (store) {
        // 多用户：按登录者可见性过滤；v1 无鉴权模式保持全量列表
        if (setup.auth) {
          const owner = requireUser(user)
          sendJson(req, res, 200, { ideas: store.listForUser(owner.id, userTeamIds(setup, owner)) })
          return
        }
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

    case 'GET /api/market/ideas': {
      // IM-01/IM-05：创意市场浏览与检索（关键词 + 阶段过滤）
      const market = requireIdeaMarket(setup)
      const keyword = nonEmptyParam(url.searchParams.get('q'))
      const stage = nonEmptyParam(url.searchParams.get('stage'))
      if (stage !== undefined && !IDEA_STAGES.includes(stage as never)) {
        throw new OpcError('VALIDATION_ERROR', `query parameter stage must be one of: ${IDEA_STAGES.join(', ')}`)
      }
      const limit = parseLimit(url.searchParams.get('limit'), 20, 200)
      sendJson(req, res, 200, { ideas: market.search({ keyword, stage: stage as Idea['stage'] | undefined, limit }) })
      return
    }

    case 'GET /api/market/rankings': {
      // IM-06：三类排行一次返回（资产规模 / 社区活跃 / GEO 表现）
      const market = requireIdeaMarket(setup)
      const limit = parseLimit(url.searchParams.get('limit'), 10, 100)
      sendJson(req, res, 200, {
        assets: market.ranking('assets' satisfies RankingKey, limit),
        community: market.ranking('community' satisfies RankingKey, limit),
        geo: market.ranking('geo' satisfies RankingKey, limit),
      })
      return
    }

    case 'GET /api/market/follows': {
      // IM-02："我的关注"（登录态缺省查自己的，v1 模式显式传 follower）
      const market = requireIdeaMarket(setup)
      const follower = nonEmptyParam(url.searchParams.get('follower')) ?? user?.username
      if (follower === undefined) {
        throw new OpcError('VALIDATION_ERROR', 'query parameter follower is required')
      }
      const limit = parseLimit(url.searchParams.get('limit'), 50, 200)
      sendJson(req, res, 200, { follower, ideas: market.followedBy(follower, limit) })
      return
    }

    case 'POST /api/auth/password': {
      // 改密：旧密码校验 → 更新 → 全端会话失效（用户需重新登录）
      const owner = requireUser(user)
      const body = await readJsonObject(req)
      const auth = requireAuthStores(setup)
      auth.users.updatePassword(owner.id, requireString(body, 'oldPassword'), requireString(body, 'newPassword'))
      auth.sessions.revokeAllForUser(owner.id)
      clearSessionCookie(res)
      sendJson(req, res, 200, { ok: true, hint: '密码已更新，请重新登录' })
      return
    }

    case 'POST /api/auth/profile': {
      const owner = requireUser(user)
      const body = await readJsonObject(req)
      const updated = requireAuthStores(setup).users.updateDisplayName(owner.id, requireString(body, 'displayName'))
      sendJson(req, res, 200, { user: updated })
      return
    }

    case 'GET /api/revenue/daily': {
      // 收入趋势（按日聚合分成流水；供创作者中心趋势图）
      const revenue = requireService<RevenueLedger>(setup, 'opc.marketplace.revenue')
      const days = parseLimit(url.searchParams.get('days'), 30, 90)
      const buckets = new Map<string, { creator: number; platform: number; count: number }>()
      for (const entry of revenue.listEntries()) {
        const day = new Date(entry.recordedAt).toISOString().slice(0, 10)
        const bucket = buckets.get(day) ?? { creator: 0, platform: 0, count: 0 }
        bucket.creator += entry.creator
        bucket.platform += entry.platform
        bucket.count += 1
        buckets.set(day, bucket)
      }
      const series = [...buckets.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .slice(-days)
        .map(([day, v]) => ({ day, ...v }))
      sendJson(req, res, 200, { series, unit: 'cents' })
      return
    }

    case 'GET /api/notifications': {
      // IM-02：关注创意的阶段变更通知（登录态缺省查自己的，v1 模式显式传 follower）
      const market = requireIdeaMarket(setup)
      const follower = nonEmptyParam(url.searchParams.get('follower')) ?? user?.username
      if (follower === undefined) {
        throw new OpcError('VALIDATION_ERROR', 'query parameter follower is required')
      }
      const limit = parseLimit(url.searchParams.get('limit'), 20, 100)
      sendJson(req, res, 200, { notifications: market.notificationsFor(follower, limit) })
      return
    }

    case 'POST /api/auth/register': {
      // 注册即登录：成功后签发会话 Cookie，前端免二次输入
      const body = await readJsonObject(req)
      const { users } = requireAuthStores(setup)
      const user = users.register({
        username: requireString(body, 'username'),
        password: requireString(body, 'password'),
        ...(typeof body.displayName === 'string' && body.displayName.trim().length > 0
          ? { displayName: body.displayName }
          : {}),
      })
      issueSession(setup, req, res, user.id)
      sendJson(req, res, 200, { user })
      return
    }

    case 'POST /api/auth/login': {
      const body = await readJsonObject(req)
      const { users } = requireAuthStores(setup)
      const matched = users.verify(requireString(body, 'username'), requireString(body, 'password'))
      if (!matched) {
        // 统一失败延迟：钝化暴力枚举，且不泄露用户是否存在
        await new Promise((resolveDelay) => setTimeout(resolveDelay, AUTH_FAIL_DELAY_MS))
        throw new OpcError('AUTH_FAILED', '用户名或密码不正确')
      }
      issueSession(setup, req, res, matched.id)
      sendJson(req, res, 200, { user: matched })
      return
    }

    case 'POST /api/auth/logout': {
      const token = extractSessionToken(req.headers.cookie)
      if (token) requireAuthStores(setup).sessions.revoke(token)
      clearSessionCookie(res)
      sendJson(req, res, 200, { ok: true })
      return
    }

    case 'GET /api/auth/me': {
      // 探针端点：未登录返回 200 + user:null（前端据此渲染登录页），不触发 401
      sendJson(req, res, 200, { user: user ?? null })
      return
    }

    case 'POST /api/teams': {
      const body = await readJsonObject(req)
      const owner = requireUser(user)
      const team = requireAuthStores(setup).teams.create(owner.id, requireString(body, 'name'))
      sendJson(req, res, 200, { team })
      return
    }

    case 'GET /api/teams': {
      const owner = requireUser(user)
      const { teams, users } = requireAuthStores(setup)
      const mine = teams.listForUser(owner.id).map((team) => ({
        ...team,
        members: teams.members(team.id).map((member) => enrichMember(users, member)),
      }))
      sendJson(req, res, 200, { teams: mine })
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
        // 段1 创意：登录态按用户可见性口径（我的+团队的+存量无主，与 GET /api/ideas 同源），
        // 实体库缺席降级 topic 记忆计数
        ideas: setup.ideaStore
          ? user
            ? setup.ideaStore.listForUser(user.id, userTeamIds(setup, user)).length
            : setup.ideaStore.count()
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
      // 参数路由：GET /api/skills/:id → 条目 + 定价模型 + 元数据（订阅续订/安装校验用）
      if (path.startsWith('/api/skills/') && method === 'GET') {
        const skillId = decodePathSegment(path.slice('/api/skills/'.length), 'skillId')
        const entry = setup.skillsIndex.get(skillId)
        if (!entry) throw new OpcError('SKILL_NOT_FOUND', `skill ${skillId} not in market index`)
        const pricingModel = setup.skillsIndex.getMetadata(skillId, 'pricing_model') ?? 'one_time'
        const period = setup.skillsIndex.getMetadata(skillId, 'period')
        sendJson(req, res, 200, {
          skill: entry,
          pricing: { model: pricingModel, ...(period ? { period } : {}) },
          meta: {
            idea_id: setup.skillsIndex.getMetadata(skillId, 'idea_id'),
            stage: setup.skillsIndex.getMetadata(skillId, 'stage'),
          },
        })
        return
      }
      // 参数路由：协作团队（/api/teams/:id）
      //   GET  队伍详情（含成员昵称）；POST members 邀请；POST members/remove 移除
      if (path.startsWith('/api/teams/')) {
        const owner = requireUser(user)
        const { teams, users } = requireAuthStores(setup)
        const segments = path.slice('/api/teams/'.length).split('/').filter((s) => s.length > 0)
        const teamId = decodePathSegment(segments[0] ?? '', 'teamId')
        if (segments.length === 1 && method === 'GET') {
          const team = teams.require(teamId)
          if (!teams.isMember(teamId, owner.id)) {
            throw new OpcError('PERMISSION_DENIED', `team ${teamId} is not accessible to ${owner.username}`)
          }
          sendJson(req, res, 200, {
            team,
            members: teams.members(teamId).map((member) => enrichMember(users, member)),
          })
          return
        }
        if (segments.length === 2 && decodePathSegment(segments[1], 'sub') === 'members' && method === 'POST') {
          const body = await readJsonObject(req)
          const target = users.getByUsername(requireString(body, 'username'))
          if (!target) throw new OpcError('USER_NOT_FOUND', `user ${body.username} does not exist`)
          const member = teams.invite(teamId, owner.id, target.id)
          sendJson(req, res, 200, { member: enrichMember(users, member) })
          return
        }
        if (
          segments.length === 3 &&
          decodePathSegment(segments[1], 'sub') === 'members' &&
          decodePathSegment(segments[2], 'sub') === 'remove' &&
          method === 'POST'
        ) {
          const body = await readJsonObject(req)
          const target = users.getByUsername(requireString(body, 'username'))
          if (!target) throw new OpcError('USER_NOT_FOUND', `user ${body.username} does not exist`)
          teams.remove(teamId, owner.id, target.id)
          sendJson(req, res, 200, { ok: true, removed: target.username })
          return
        }
        throw new OpcError('NOT_FOUND', `no such path: ${path}`)
      }
      // 参数路由：创意市场（/api/market/ideas/:id）
      //   GET  详情（摘要 + 关联）；POST {follower, action?} 关注/取消关注（IM-02）
      if (path.startsWith('/api/market/ideas/')) {
        const market = requireIdeaMarket(setup)
        const segments = path.slice('/api/market/ideas/'.length).split('/').filter((s) => s.length > 0)
        const marketIdeaId = decodePathSegment(segments[0] ?? '', 'ideaId')
        if (segments.length === 1 && method === 'GET') {
          const summary = market.require(marketIdeaId)
          sendJson(req, res, 200, {
            summary,
            relations: market.relations(marketIdeaId),
            collaborators: market.collaborators(marketIdeaId),
          })
          return
        }
        if (segments.length === 2 && decodePathSegment(segments[1], 'sub') === 'follow' && method === 'POST') {
          const body = await readJsonObject(req)
          // 登录态下关注人强制为当前用户（防冒名）；v1 无鉴权模式沿用显式 follower
          const follower = user ? user.username : requireString(body, 'follower')
          const action = body.action === undefined ? 'follow' : requireOneOf(body, 'action', ['follow', 'unfollow'] as const)
          const result =
            action === 'unfollow' ? market.unfollow(marketIdeaId, follower) : market.follow(marketIdeaId, follower)
          sendJson(req, res, 200, { ideaId: marketIdeaId, follower, action, followers: result.followers })
          return
        }
        throw new OpcError('NOT_FOUND', `no such path: ${path}`)
      }
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
        // 多用户越权防护：不存在 404（require），存在但不可见 403
        if (user) requireIdeaAccess(setup, user, ideaId)
        else store.require(ideaId)
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
        if (segments.length === 2 && decodePathSegment(segments[1], 'sub') === 'persona') {
          // 品牌人设（CO-02 语义 UI 化）：以 JSON 标记存于 description 流，取最近一条
          const hub = requireMemoryHub(setup)
          if (method === 'GET') {
            const entry = hub
              .readStream(ideaId, 'description')
              .reverse()
              .find((e) => e.content.includes('"idea-persona"'))
            let persona: string | null = null
            if (entry) {
              try {
                persona = (JSON.parse(entry.content) as { persona?: string }).persona ?? null
              } catch {
                persona = null
              }
            }
            sendJson(req, res, 200, { persona })
            return
          }
          if (method === 'POST') {
            const body = await readJsonObject(req)
            const persona = requireString(body, 'persona').slice(0, 2000)
            hub.write(ideaId, 'description', {
              content: JSON.stringify({ kind: 'idea-persona', persona }),
              confidence: 0.9,
              authority: 'user',
            })
            sendJson(req, res, 200, { persona, hint: '人设已更新：内容流水线按该人设撰写与评分' })
            return
          }
          throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id/persona is not supported`)
        }
        if (segments.length === 2 && decodePathSegment(segments[1], 'sub') === 'transition') {
          // 阶段迁移（prd2.md 3.4/4.5）：线性单向，成功写 decisions 正本并重写子OS profile
          if (method !== 'POST') {
            throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id/transition is not supported`)
          }
          const body = await readJsonObject(req)
          const to = requireOneOf(body, 'to', IDEA_STAGES)
          const note = typeof body.note === 'string' ? body.note : undefined
          const result = requireLifecycle(setup).transition(ideaId, to, note)
          // IM-02：关注者收到阶段变更通知（市场未发布/未配置时静默跳过）
          setup.ideaMarket?.notifyStageChange(ideaId, result.transition.from, to)
          sendJson(req, res, 200, result)
          return
        }
        if (segments.length === 3 && decodePathSegment(segments[1], 'sub') === 'mvp') {
          const sub = decodePathSegment(segments[2], 'sub')
          const store = requireIdeaStore(setup)
          const idea = store.require(ideaId)
          const hub = setup.memoryHub
          if (sub === 'plan' && method === 'POST') {
            // IP-01：三域 → MVP 方案（模板策略），方案正本写入 decisions 流
            const plan = planMvp(idea.id, idea.domains)
            hub?.write(ideaId, 'decisions', {
              content: JSON.stringify({ kind: 'mvp-plan', plan }),
              confidence: 0.85,
              authority: 'model',
            })
            sendJson(req, res, 200, { plan })
            return
          }
          if (sub === 'validation' && method === 'POST') {
            // IP-03：验证记录（用户反馈/数据指标）写入创意记忆体 research 流
            const body = await readJsonObject(req)
            const score = body.score === undefined ? undefined : requireScore05(body)
            const record: MvpValidation = {
              kind: 'mvp-validation',
              source: requireOneOf(body, 'source', ['feedback', 'metric'] as const),
              ...(score !== undefined ? { score } : {}),
              content: requireString(body, 'content'),
              at: Date.now(),
            }
            requireMemoryHub(setup).write(ideaId, 'research', {
              content: JSON.stringify(record),
              confidence: 0.8,
              authority: 'user',
            })
            sendJson(req, res, 200, { record })
            return
          }
          if (sub === 'suggestion' && method === 'GET') {
            // IP-04：Go/No-Go 建议（确定性规则：≥2 条且均值 ≥3.5 → go）
            const validations = listValidations(requireMemoryHub(setup), ideaId)
            sendJson(req, res, 200, { suggestion: suggestGoNoGo(validations), validations })
            return
          }
          throw new OpcError('NOT_FOUND', `no such path: ${path}`)
        }
        if (segments.length >= 2 && decodePathSegment(segments[1], 'sub') === 'workspace') {
          // IP-02 工作区：Agent 读写根限定 ideas/<id>/workspace/，越界一律 PERMISSION_DENIED
          const store = requireIdeaStore(setup)
          store.require(ideaId)
          const ideaHome = store.homeDir(ideaId)
          if (!ideaHome) {
            throw new OpcError('SERVICE_UNAVAILABLE', 'workspace requires ideas root to be configured')
          }
          const ws = new IdeaWorkspace(workspacePathFor(ideaHome))
          if (segments.length === 2) {
            if (method !== 'GET') {
              throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id/workspace is not supported`)
            }
            sendJson(req, res, 200, { root: ws.path, files: ws.list() })
            return
          }
          if (segments.length === 3 && decodePathSegment(segments[2], 'sub') === 'file') {
            if (method === 'GET') {
              const relative = nonEmptyParam(url.searchParams.get('path'))
              if (relative === undefined) {
                throw new OpcError('VALIDATION_ERROR', 'query parameter path is required')
              }
              const content = ws.readFile(relative)
              if (content === undefined) throw new OpcError('NOT_FOUND', `workspace file not found: ${relative}`)
              sendJson(req, res, 200, { path: relative, content })
              return
            }
            if (method === 'POST') {
              const body = await readJsonObject(req)
              const written = ws.writeFile(requireString(body, 'path'), requireString(body, 'content'))
              sendJson(req, res, 200, { written })
              return
            }
            throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id/workspace/file is not supported`)
          }
          throw new OpcError('NOT_FOUND', `no such path: ${path}`)
        }
        if (segments.length === 2 && decodePathSegment(segments[1], 'sub') === 'ledger') {
          // 资产账本总览（prd2.md 5.5 五类资产）
          if (method !== 'GET') {
            throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id/ledger is not supported`)
          }
          sendJson(req, res, 200, { ledger: requireIdeaLedger(setup, ideaId).read() })
          return
        }
        if (segments.length === 3 && decodePathSegment(segments[1], 'sub') === 'ledger') {
          if (decodePathSegment(segments[2], 'sub') !== 'revenue' || method !== 'POST') {
            throw new OpcError('NOT_FOUND', `no such path: ${path}`)
          }
          const body = await readJsonObject(req)
          const source = requireOneOf(body, 'source', ['product', 'subscription', 'skill'] as const)
          const amountCents = requireNonNegativeInt(body, 'amountCents')
          if (amountCents === 0) {
            throw new OpcError('VALIDATION_ERROR', 'field amountCents must be a positive integer')
          }
          const ledger = requireIdeaLedger(setup, ideaId).recordRevenue(source, amountCents)
          requireMemoryHub(setup).write(ideaId, 'research', {
            content: JSON.stringify({ kind: 'revenue', source, amountCents, note: body.note ?? '' }),
            confidence: 0.8,
            authority: 'user',
          })
          sendJson(req, res, 200, { ledger })
          return
        }
        if (segments.length === 2 && decodePathSegment(segments[1], 'sub') === 'token') {
          // Meme Token 积分账本（prd2.md 5.4/6.5，R-02 积分定位）
          if (method !== 'GET') {
            throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id/token is not supported`)
          }
          const token = requireTokenLedger(setup, ideaId)
          sendJson(req, res, 200, {
            config: token.config(),
            stats: token.stats(),
            grants: token.list().slice(-50).reverse(),
            roles: TOKEN_ROLES.map((role) => ({ role, label: TOKEN_ROLE_LABELS[role] })),
          })
          return
        }
        if (segments.length === 3 && decodePathSegment(segments[1], 'sub') === 'token') {
          if (decodePathSegment(segments[2], 'sub') !== 'issue' || method !== 'POST') {
            throw new OpcError('NOT_FOUND', `no such path: ${path}`)
          }
          const body = await readJsonObject(req)
          const token = requireTokenLedger(setup, ideaId)
          const grant = token.issue(
            requireString(body, 'to'),
            requireOneOf(body, 'role', TOKEN_ROLES),
            requirePositiveInt(body, 'amount'),
            requireString(body, 'reason'),
          )
          // 配额/总量镜像回资产账本（单一展示源仍为 token.json）
          requireIdeaLedger(setup, ideaId).syncTokens(token.stats())
          requireMemoryHub(setup).write(ideaId, 'research', {
            content: JSON.stringify({ kind: 'token-grant', ...grant }),
            confidence: 0.8,
            authority: 'user',
          })
          sendJson(req, res, 200, { grant, stats: token.stats() })
          return
        }
        if (segments.length === 2 && decodePathSegment(segments[1], 'sub') === 'versions') {
          // ID-04：版本链（新版本在前）
          if (method !== 'GET') {
            throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id/versions is not supported`)
          }
          requireIdeaStore(setup).require(ideaId)
          sendJson(req, res, 200, { versions: requireIdeaStore(setup).listVersions(ideaId) })
          return
        }
        if (segments.length === 2 && decodePathSegment(segments[1], 'sub') === 'rollback') {
          // ID-04：回滚至任意历史版本（恢复态以新版本入链，可再撤销）
          if (method !== 'POST') {
            throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id/rollback is not supported`)
          }
          const body = await readJsonObject(req)
          const version = requirePositiveInt(body, 'version')
          const note = typeof body.note === 'string' ? body.note : undefined
          const store = requireIdeaStore(setup)
          const result = store.rollback(ideaId, version, note)
          requireMemoryHub(setup).write(ideaId, 'description', {
            content: `三域回滚至 v${version}（note：${note ?? '—'}），恢复态入链为 v${result.version.version}`,
            confidence: 0.8,
            authority: 'user',
          })
          sendJson(req, res, 200, result)
          return
        }
        if (segments.length === 2 && decodePathSegment(segments[1], 'sub') === 'publish') {
          // ID-05/IM-01：发布到创意市场（摘要 + 资产概况），发布即重算关联（IM-03）
          if (method !== 'POST') {
            throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id/publish is not supported`)
          }
          const market = requireIdeaMarket(setup)
          const idea = requireIdeaStore(setup).require(ideaId)
          const summary = marketSummaryFor(setup, idea)
          market.publish(summary)
          // 关联重算：新摘要入市场后，重算其自身与全市场已发布创意的关联（成对双行）
          const relations = market.recomputeRelations(ideaId)
          for (const other of market.list()) {
            if (other.ideaId !== ideaId) market.recomputeRelations(other.ideaId)
          }
          requireMemoryHub(setup).write(ideaId, 'decisions', {
            content: `发布到创意市场：${idea.name}（发现 ${relations.length} 条关联）`,
            confidence: 0.8,
            authority: 'user',
          })
          sendJson(req, res, 200, { summary, relations })
          return
        }
        if (segments.length === 2 && decodePathSegment(segments[1], 'sub') === 'collab') {
          // IM-04 协同参与（prd2.md 6.4）：贡献记录 + 按 Token 积分发放（默认 权重×100）
          if (method !== 'POST') {
            throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id/collab is not supported`)
          }
          const body = await readJsonObject(req)
          const market = requireIdeaMarket(setup)
          const role = requireOneOf(body, 'role', COLLAB_ROLES.map((r) => r.role))
          const weight = COLLAB_ROLES.find((r) => r.role === role)?.weight ?? 10
          const tokens = body.tokens === undefined ? weight * 100 : requirePositiveInt(body, 'tokens')
          // 登录态下贡献者强制为当前用户（防冒名）；v1 无鉴权模式沿用显式 userId
          const collabUserId =
            user !== undefined ? user.username : requireString(body, 'userId')
          const record = market.recordCollaboration({
            ideaId,
            userId: collabUserId,
            role: role as CollabRole,
            contribution: requireString(body, 'contribution'),
            tokensGranted: tokens,
          })
          const tokenLedger = requireTokenLedger(setup, ideaId)
          const grant = tokenLedger.issue(record.userId, 'collaborator', tokens, `协同贡献：${record.contribution}`)
          requireIdeaLedger(setup, ideaId).syncTokens(tokenLedger.stats())
          sendJson(req, res, 200, { record, grant, stats: tokenLedger.stats() })
          return
        }
        if (segments.length === 2 && decodePathSegment(segments[1], 'sub') === 'geo') {
          // GEO 监测历史（prd2.md 4.4）：快照时间倒序 + 生效配置（模拟口径显式标注）
          if (method !== 'GET') {
            throw new OpcError('METHOD_NOT_ALLOWED', `${method} /api/ideas/:id/geo is not supported`)
          }
          requireIdeaStore(setup).require(ideaId)
          const geo = requireService<GeoService>(setup, 'opc.geo')
          const limit = parseLimit(url.searchParams.get('limit'), 100, 500)
          sendJson(req, res, 200, { history: geo.history(ideaId, limit), config: geo.config() })
          return
        }
        if (segments.length === 3 && decodePathSegment(segments[1], 'sub') === 'geo') {
          if (decodePathSegment(segments[2], 'sub') !== 'refresh' || method !== 'POST') {
            throw new OpcError('NOT_FOUND', `no such path: ${path}`)
          }
          requireIdeaStore(setup).require(ideaId)
          const geo = requireService<GeoService>(setup, 'opc.geo')
          const body = await readJsonObject(req)
          const keywords = Array.isArray(body.keywords)
            ? body.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
            : undefined
          const result = await geo.refresh(ideaId, keywords)
          // 运营数据联动：最新一轮平均可见性写入资产账本 analytics（prd2.md 5.2 运营数据）
          const home = setup.ideaStore?.homeDir(ideaId)
          if (home && result.snapshots.length > 0) {
            const avg = result.snapshots.reduce((sum, s) => sum + s.visibility, 0) / result.snapshots.length
            IdeaLedger.forIdeaHome(home, ideaId).updateAnalytics({ geo_visibility: Math.round(avg * 100) / 100 })
          }
          sendJson(req, res, 200, result)
          return
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
