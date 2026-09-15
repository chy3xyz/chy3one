/**
 * 启动健康握手与故障隔离（PRD 5.3 / AR-R02：上次启动未健康时自动隔离
 * 用户插件，保证宿主永远能回来；R-05：一次性 Profile，健康文件全部
 * 路径可注入，卸载 Profile 即清理干净）。
 *
 * 装载语义按真实 cordis 4.x 的 fiber 行为实现（见已安装包
 * @deepseek-ai/cordis 的 src/registry.ts 与 src/fiber.ts）：
 * `ctx.plugin()` 同步返回 fiber，插件 apply 在微任务之后才执行，启动
 * 错误被 fiber 捕获（state → FAILED）并在 `await fiber` 时以原错误拒绝
 * 冒出。因此 guardedLoad 的同一个 try/catch 同时覆盖 `ctx.plugin()` 的
 * 同步抛错（非法插件形状、失活上下文）与 apply 的异步启动错误。
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'

/** cordis 4.x fiber 的结构子集：可 dispose（卸载并撤销副作用） */
export interface CordisFiber {
  dispose(): Promise<void>
}

/** `ctx.plugin()` 的返回值：fiber 句柄（thenable，启动错误在此拒绝冒出） */
export interface CordisFiberHandle extends CordisFiber, PromiseLike<unknown> {}

/** 能装载插件的宿主上下文（真实 cordis 4.x Context 的结构子集） */
export interface CordisPluginHost {
  plugin(p: unknown, ...args: unknown[]): CordisFiberHandle
}

/**
 * defineOpcPlugin 产物（或任意 cordis 函数插件）的结构类型。
 * 形参以 never 声明以保持参数逆变兼容：任何 `(ctx, config?) => void`
 * 形状的具体插件都可赋给它（TypeScript strict 的函数参数检查）。
 */
export type OpcCordisPlugin = ((rawCtx: never, config?: never) => unknown) & { name?: string }

/** 隔离清单文件内容（按插件名追加去重） */
export interface QuarantineFile {
  version: 1
  quarantined: string[]
}

/** 启动健康 marker 文件内容 */
export interface BootMarker {
  lastBootUnhealthy: boolean
}

/** 隔离清单默认路径（相对 process.cwd()；生产部署应注入 $DSH_HOME 下的可写路径） */
export const DEFAULT_QUARANTINE_FILE = './opcos-quarantine.json'

/** 启动健康 marker 默认路径（相对 process.cwd()） */
export const DEFAULT_MARKER_FILE = './opcos-boot-marker.json'

export interface GuardedLoadOptions {
  /** 隔离清单文件路径（默认 DEFAULT_QUARANTINE_FILE） */
  quarantineFile?: string
  /** 覆盖插件名（默认取 plugin.name；匿名函数记为 'anonymous'） */
  name?: string
}

/** guardedLoad 成功：fiber 已 settle，插件服务可 get */
export interface GuardedLoadSuccess {
  ok: true
  fiber: CordisFiber
}

/** guardedLoad 失败：错误原样透传，插件名已计入隔离清单 */
export interface GuardedLoadFailure {
  ok: false
  error: unknown
  quarantined: true
}

export type GuardedLoadResult = GuardedLoadSuccess | GuardedLoadFailure

/* ─────────────── 健康文件读写（0600） ─────────────── */

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined // 文件不存在或损坏：按缺失处理（marker 缺失视为健康）
  }
}

function writeJsonPrivate(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  // writeFileSync 的 mode 只在创建时生效，覆盖已有文件需显式收紧到 0600
  chmodSync(path, 0o600)
}

function appendQuarantine(path: string, name: string): void {
  const current = readJson<Partial<QuarantineFile>>(path)
  const list = Array.isArray(current?.quarantined) ? current.quarantined : []
  if (!list.includes(name)) list.push(name)
  writeJsonPrivate(path, { version: 1, quarantined: list } satisfies QuarantineFile)
}

/** 读取隔离清单（不存在/损坏返回空列表） */
export function readQuarantineList(path: string = DEFAULT_QUARANTINE_FILE): string[] {
  const current = readJson<Partial<QuarantineFile>>(path)
  return Array.isArray(current?.quarantined) ? current.quarantined : []
}

/** 读取启动健康 marker（不存在/损坏视为健康） */
export function readBootMarker(path: string = DEFAULT_MARKER_FILE): BootMarker | undefined {
  return readJson<BootMarker>(path)
}

/* ─────────────── 单插件守护装载 ─────────────── */

/**
 * 用 try/catch 包裹真实 cordis 的 `ctx.plugin()` 装载：
 * - 成功：`await fiber` settle 后返回 `{ ok: true, fiber }`；
 * - 失败（同步抛错或 apply 启动错误经 fiber 拒绝冒出）：返回
 *   `{ ok: false, error, quarantined: true }`，并把插件名追加进隔离
 *   清单文件（JSON、0600、按名去重）。
 */
export async function guardedLoad(
  ctx: CordisPluginHost,
  plugin: OpcCordisPlugin,
  config?: Record<string, unknown>,
  opts?: GuardedLoadOptions,
): Promise<GuardedLoadResult> {
  const name = opts?.name ?? plugin.name ?? 'anonymous'
  try {
    const fiber = ctx.plugin(plugin, config)
    // cordis 4：apply 在微任务后执行，启动错误经 fiber promise 拒绝冒出
    await fiber
    return { ok: true, fiber }
  } catch (error) {
    try {
      appendQuarantine(opts?.quarantineFile ?? DEFAULT_QUARANTINE_FILE, name)
    } catch {
      // 隔离清单写入失败不改变装载判定：故障隔离的优先级是宿主可回（AR-R02）。
      // marker 写入（loadWithHandshake 收尾）不吞错——恢复契约必须可见。
    }
    return { ok: false, error, quarantined: true }
  }
}

/* ─────────────── 全量握手装载 ─────────────── */

/** 一个待装载插件条目 */
export interface HandshakeEntry {
  /** defineOpcPlugin 产物（或任意 cordis 函数插件） */
  plugin: OpcCordisPlugin
  /** 传给 ctx.plugin 的 config（由插件包装器与 defaultConfig 浅合并） */
  config?: Record<string, unknown>
  /** 条目名（默认取 plugin.name） */
  name?: string
}

export interface HandshakeOptions {
  /** 隔离清单路径（透传 guardedLoad，默认 DEFAULT_QUARANTINE_FILE） */
  quarantineFile?: string
  /** 启动健康 marker 路径（默认 DEFAULT_MARKER_FILE） */
  markerFile?: string
  /**
   * 降级启动时仍需装载的 core 必需项名单（默认 []：降级轮不装载任何
   * 用户插件，只保证空宿主可回来，等配置修复后自愈）。
   */
  criticalNames?: string[]
}

export type HandshakeStatus = 'loaded' | 'quarantined' | 'skipped'

export interface HandshakeOutcome {
  name: string
  status: HandshakeStatus
  /** 仅 status === 'loaded' 时存在 */
  fiber?: CordisFiber
  /** 仅 status === 'quarantined' 时存在：guardedLoad 捕获的错误原样透传 */
  error?: unknown
}

export interface HandshakeReport {
  /** 上次启动被标记为不健康 → 本轮降级（只装载 criticalNames） */
  degradedBoot: boolean
  /** 生效的 core 必需项名单（回显，便于诊断） */
  criticalNames: string[]
  /** 每个条目的结果（含降级轮的 skipped 项） */
  outcomes: HandshakeOutcome[]
  /** 本轮选中项全部失败（已写入 lastBootUnhealthy: true） */
  allFailed: boolean
}

/**
 * 启动健康握手（AR-R02）：
 * 1. 读上次启动 marker：`lastBootUnhealthy: true` → 本轮降级，只装载
 *    `criticalNames` 指定的 core 必需项，其余用户插件全部 skipped；
 * 2. 选中项逐一经 guardedLoad（失败进隔离清单，不阻断其余插件）；
 * 3. 收尾写 marker：
 *    - 选中项全部失败 → `{ lastBootUnhealthy: true }`（下一轮降级保宿主可回）；
 *    - 任一项成功 → `{ lastBootUnhealthy: false }`（下一轮恢复全量尝试，自愈）；
 *    - 降级轮无选中项（criticalNames 为空或不匹配）→ 不改写 marker，
 *      保持降级直到配置修复。
 */
export async function loadWithHandshake(
  ctx: CordisPluginHost,
  plugins: HandshakeEntry[],
  opts?: HandshakeOptions,
): Promise<HandshakeReport> {
  const quarantineFile = opts?.quarantineFile ?? DEFAULT_QUARANTINE_FILE
  const markerFile = opts?.markerFile ?? DEFAULT_MARKER_FILE
  const criticalNames = opts?.criticalNames ?? []
  const critical = new Set(criticalNames)

  const degradedBoot = readBootMarker(markerFile)?.lastBootUnhealthy === true

  const outcomes: HandshakeOutcome[] = []
  for (const entry of plugins) {
    const name = entry.name ?? entry.plugin.name ?? 'anonymous'
    if (degradedBoot && !critical.has(name)) {
      outcomes.push({ name, status: 'skipped' })
      continue
    }
    const result = await guardedLoad(ctx, entry.plugin, entry.config, { quarantineFile, name })
    if (result.ok) {
      outcomes.push({ name, status: 'loaded', fiber: result.fiber })
    } else {
      outcomes.push({ name, status: 'quarantined', error: result.error })
    }
  }

  const selected = outcomes.filter((o) => o.status !== 'skipped')
  const allFailed = selected.length > 0 && selected.every((o) => o.status === 'quarantined')

  if (selected.length > 0) {
    writeJsonPrivate(markerFile, { lastBootUnhealthy: allFailed })
  }

  return { degradedBoot, criticalNames: [...criticalNames], outcomes, allFailed }
}
