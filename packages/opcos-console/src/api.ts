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

import {
  OpcError,
  SqliteSkillIndex,
  installFromMarket,
  type BillingRecord,
  type BlackboardEntry,
  type BlackboardScope,
  type BlackboardWrite,
  type BillingEngine,
  type MarketSkill,
  type MemoryEntry,
  type MemoryQuery,
  type NewMemoryEntry,
  type Order,
  type OrderEngine,
  type SkillDefinition,
  type SplitEntry,
  type WriteResult,
} from '../../core/src/index.js'
import { createPackage, type SkillPackage } from '../../core/src/skill/packager.js'
import type { TelemetryBus, TelemetryEvent } from '../../dsh-adapter/src/index.js'
import { detectDshRuntime } from '../../dsh-adapter/src/index.js'
import { readQuarantineList, type HandshakeReport, type HandshakeStatus } from '../../opcos-bundle/src/health.js'
import type { SkillForgeService } from '../../dsh-plugins/opc-skill-forge/src/index.js'
import type { TeamService } from '../../dsh-plugins/opc-team/src/index.js'

/* ─────────────── 共享常量 ─────────────── */

const TELEMETRY_RING_CAPACITY = 100
const MAX_BODY_BYTES = 1_000_000
const DEFAULT_SKILL_PAGE_SIZE = 20
const MAX_SKILL_PAGE_SIZE = 200
/** 计算 total 时的扫描上限（compat 过滤需内存分页前的全量语义） */
const TOTAL_SCAN_LIMIT = 1000

const REQUEST_BASE = 'http://opcos-console.internal'

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
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  VERSION_CONFLICT: 409,
  ORDER_STATE_INVALID: 409,
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
 */
export function resolveStaticDir(): string {
  const primary = fileURLToPath(new URL('../static', import.meta.url))
  if (existsSync(primary)) return primary
  const fromDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/opcos-console/static')
  if (existsSync(fromDist)) return fromDist
  return primary
}

function sendFile(res: ServerResponse, status: number, filePath: string): void {
  const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(status, { 'content-type': contentType })
  res.end(readFileSync(filePath))
}

function sendStaticNotFound(res: ServerResponse, pathname: string): void {
  sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `no such path: ${pathname}` } })
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
  /** 健康来源：缺省时按服务可用性实时探测（probeHandshake） */
  handshake?: HandshakeSource
  /** 静态目录：缺省 resolveStaticDir() */
  staticDir?: string
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
  staticDir: string
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
    staticDir: deps.staticDir ?? resolveStaticDir(),
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

/* ─────────────── 请求级辅助 ─────────────── */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (error instanceof OpcError) {
    sendJson(res, ERROR_STATUS[error.code] ?? 500, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof RangeError) {
    sendJson(res, 400, { error: { code: 'VALIDATION_ERROR', message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message } })
}

function requireService<T>(setup: ConsoleSetup, name: string): T {
  const service = setup.getService(name) as T | undefined
  if (service === undefined) {
    throw new OpcError('SERVICE_UNAVAILABLE', `service ${name} is not available (plugin quarantined or unloaded)`)
  }
  return service
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

/* ─────────────── 路由 ─────────────── */

const API_PATHS = new Set([
  '/api/health',
  '/api/team',
  '/api/team/templates',
  '/api/blackboard',
  '/api/skills',
  '/api/skills/install',
  '/api/skillforge/drafts',
  '/api/orders',
  '/api/orders/pay',
  '/api/billing/summary',
  '/api/billing/complete',
  '/api/memory',
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
      sendJson(res, 200, {
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
      sendJson(res, 200, team.formTeam(goal))
      return
    }

    case 'GET /api/team/templates': {
      const team = requireService<TeamService>(setup, 'opc.team')
      sendJson(res, 200, { templates: team.fallbackTemplates() })
      return
    }

    case 'GET /api/blackboard': {
      const scope = queryOneOf(url, 'scope', ['global', 'workflow'] as const, 'global')
      const board = requireService<BlackboardService>(setup, 'opc.blackboard')
      sendJson(res, 200, { entries: board.read(scope) })
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
      sendJson(res, 200, board.write(op))
      return
    }

    case 'GET /api/skills': {
      const keyword = nonEmptyParam(url.searchParams.get('q'))
      const category = nonEmptyParam(url.searchParams.get('category'))
      const compatDsh = nonEmptyParam(url.searchParams.get('compat'))
      const limit = parseLimit(url.searchParams.get('limit'), DEFAULT_SKILL_PAGE_SIZE, MAX_SKILL_PAGE_SIZE)
      // 先取全量命中（受 TOTAL_SCAN_LIMIT 上限约束）以计算 total，再切页
      const matched = setup.skillsIndex.search({ keyword, category, compatDsh, limit: TOTAL_SCAN_LIMIT })
      sendJson(res, 200, { results: matched.slice(0, limit), total: matched.length })
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
      sendJson(res, 200, { installedPath })
      return
    }

    case 'GET /api/skillforge/drafts': {
      const forge = requireService<SkillForgeService>(setup, 'opc.skillforge')
      sendJson(res, 200, { drafts: forge.listDrafts() })
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
      sendJson(res, 200, order)
      return
    }

    case 'POST /api/orders/pay': {
      const body = await readJsonObject(req)
      const pay = requireService<MarketplacePay>(setup, 'opc.marketplace.pay')
      const { order, split } = await pay(requireString(body, 'orderId'))
      sendJson(res, 200, { order, split })
      return
    }

    case 'GET /api/orders': {
      const buyerId = nonEmptyParam(url.searchParams.get('buyerId'))
      if (!buyerId) throw new OpcError('VALIDATION_ERROR', 'query parameter buyerId is required')
      const orders = requireService<OrderEngine>(setup, 'opc.marketplace.orders')
      sendJson(res, 200, { orders: orders.listByBuyer(buyerId) })
      return
    }

    case 'GET /api/billing/summary': {
      const engine = requireService<BillingEngine>(setup, 'opc.billing')
      sendJson(res, 200, {
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
      sendJson(res, 200, record)
      return
    }

    case 'GET /api/memory': {
      const memory = requireService<MemoryService>(setup, 'opc.memory')
      const entries = memory.query({
        keyword: nonEmptyParam(url.searchParams.get('q')),
        category: nonEmptyParam(url.searchParams.get('category')) as MemoryQuery['category'],
        limit: 50,
      })
      sendJson(res, 200, { entries })
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
      sendJson(res, 200, entry)
      return
    }

    case 'GET /api/overview': {
      // 聚合端点对个别插件缺席保持降级（计 0），不让 /api/overview 整体 503
      const team = setup.getService('opc.team') as TeamService | undefined
      const board = setup.getService('opc.blackboard') as BlackboardService | undefined
      const memory = setup.getService('opc.memory') as MemoryService | undefined
      const orders = setup.getService('opc.marketplace.orders') as OrderEngine | undefined
      const billing = setup.getService('opc.billing') as BillingEngine | undefined
      sendJson(res, 200, {
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

    default:
      if (API_PATHS.has(path)) {
        throw new OpcError('METHOD_NOT_ALLOWED', `${method} ${path} is not supported`)
      }
      throw new OpcError('NOT_FOUND', `no such path: ${path}`)
  }
}

/**
 * 12 个 REST 端点 + OpcError → {error:{code,message}} 映射（原 handleRequest 的 API 半区）。
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
    sendError(res, error)
  }
}

/** 静态资源（原 serveStatic：/ → index.html/占位页，其余按 safe 路径映射文件，缺失 404 JSON） */
function serveStaticPath(pathname: string, res: ServerResponse, setup: ConsoleSetup): void {
  if (pathname === '/') {
    const indexPath = join(setup.staticDir, 'index.html')
    if (existsSync(indexPath)) {
      sendFile(res, 200, indexPath)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PLACEHOLDER_HTML)
    return
  }
  const relative = pathname.replace(/^\/+/, '')
  if (relative.length === 0 || relative.includes('..') || relative.includes('\\') || relative.includes('\0')) {
    sendStaticNotFound(res, pathname)
    return
  }
  const filePath = join(setup.staticDir, relative)
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendStaticNotFound(res, pathname)
    return
  }
  sendFile(res, 200, filePath)
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
    serveStaticPath(stripUrlPrefix(url.pathname, urlPrefix), res, setup)
  } catch (error) {
    sendError(res, error)
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
    sendError(res, error)
  }
}
