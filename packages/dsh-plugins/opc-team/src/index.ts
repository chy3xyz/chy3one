import { randomUUID } from 'node:crypto'
import { OpcError, TaskBoard } from '../../../core/src/index.js'
import { createTelemetryBus, defineOpcPlugin, type OpcContext } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-team'

/** 真实拉起模式：'off'（默认，记录式）| 'auto'（依赖可用即真拉起，否则回退）| 'on'（显式要求真拉起） */
export type SpawnMode = 'off' | 'auto' | 'on'

export interface Config {
  tokenBudget: number
  /** 子代理真实拉起模式（默认 'off' 保持记录式行为，见评估建议 #2） */
  spawn?: SpawnMode
}

/** 团队角色标识（对应 dsh-team 拉起的命名队友） */
export type TeamRole =
  | 'researcher'
  | 'site-builder'
  | 'copywriter'
  | 'marketer'
  | 'planner'
  | 'writer'
  | 'reviewer'
  | 'distributor'

export interface TeamPlan {
  /** 推荐角色列表（顺序即分工链路） */
  roles: TeamRole[]
  teamSize: number
  createdAt: number
  goal: string
}

export interface TeamTemplate {
  id: string
  label: string
  roles: TeamRole[]
}

/* ─────────────── 真实拉起（评估建议 #2）─────────────── */

/** 单角色子代理执行请求（传入 executor 的规范化输入） */
export interface RoleSpawnRequest {
  role: TeamRole
  /** 角色化 prompt：角色职责 + 团队目标 */
  task: string
  /** 子代理展示标签，如 `opc-team:researcher` */
  label: string
  signal?: AbortSignal
}

/** 单角色子代理执行产出 */
export interface RoleSpawnOutput {
  /** 子代理最终 assistant 文本 */
  output: string
  /** 子代理会话 id（宿主运行时提供时） */
  sessionId?: string
}

/**
 * 可注入的真实执行器：由宿主（或测试）注入，把一个角色请求拉起为真实
 * Agent 会话并返回最终文本。默认实现（native）经 ctx 服务表 duck-type
 * 解析 dsh-agent 的 `agents` 服务（AR-C06：禁止编译期硬依赖）。
 */
export type RoleExecutor = (req: RoleSpawnRequest) => Promise<RoleSpawnOutput>

/** 单角色 spawn 结果（allSettled 语义：拒绝不抛出，落 status） */
export type BlackboardOutcome = 'written' | 'conflict' | 'error' | 'skipped'

export type RoleSpawnResult =
  | {
      role: TeamRole
      status: 'fulfilled'
      output: string
      sessionId?: string
      /** 黑板写入结果：written=成功 / conflict=乐观锁冲突 / error=异常 / skipped=无黑板或空产出 */
      blackboard: BlackboardOutcome
      durationMs: number
    }
  | { role: TeamRole; status: 'rejected'; reason: string; durationMs: number }

/** spawnTeam 总结果：recorded=记录式回退（spawn:'off' 或执行器依赖缺失） */
export type SpawnTeamResult =
  | { mode: 'recorded'; plan: TeamPlan; fallbackReason?: 'spawn-off' | 'executor-unavailable' }
  | { mode: 'spawned'; plan: TeamPlan; results: RoleSpawnResult[]; durationMs: number }

/** opc.blackboard 服务的最小 duck-type 面（core InMemoryBlackboard / opc-blackboard 均满足） */
interface BlackboardLike {
  read(scope: 'global' | 'workflow', key?: string): Array<{ version: number }>
  write(op: {
    scope: 'global' | 'workflow'
    key: string
    value: unknown
    writer: string
    role: 'orchestrator' | 'agent'
    expectedVersion: number
    confidence?: number
  }): unknown
}

/* ─────────────── 角色职责（角色化 prompt 素材）─────────────── */

const ROLE_DUTIES: Record<TeamRole, string> = {
  researcher: '负责市场与竞品调研，输出机会点与风险清单',
  'site-builder': '负责独立站/落地页搭建，输出站点结构与搭建要点',
  copywriter: '负责核心卖点文案创作，输出主文案与变体',
  marketer: '负责获客与投放策略，输出渠道与预算建议',
  planner: '负责内容选题与排期规划，输出选题清单与排期表',
  writer: '负责内容成稿撰写，输出完整稿件',
  reviewer: '负责质量审核，输出审核意见与修改建议',
  distributor: '负责分发与渠道运营，输出分发渠道清单',
}

/** 目标关键词 → 角色映射表（AS-01：解析准确率 ≥ 85% 的内置规则基线） */
const GOAL_ROLE_RULES: Array<{ pattern: RegExp; roles: TeamRole[]; templateId: string }> = [
  { pattern: /电商|跨境|独立站/u, roles: ['researcher', 'site-builder', 'copywriter', 'marketer'], templateId: 'cross-border-ecommerce' },
  { pattern: /内容|自媒体/u, roles: ['planner', 'writer', 'reviewer', 'distributor'], templateId: 'content-creator' },
]

/** 可手动选择的降级模板（PRD 6.2.3：目标解析失败 → 手动选择角色模板） */
const FALLBACK_TEMPLATES: TeamTemplate[] = [
  { id: 'cross-border-ecommerce', label: '跨境电商创业团队', roles: ['researcher', 'site-builder', 'copywriter', 'marketer'] },
  { id: 'content-creator', label: '内容自媒体团队', roles: ['planner', 'writer', 'reviewer', 'distributor'] },
  { id: 'indie-hacker', label: '独立开发者团队', roles: ['researcher', 'site-builder', 'marketer'] },
]

export interface TeamService {
  formTeam(goal: string): TeamPlan
  fallbackTemplates(): TeamTemplate[]
  recordUsage(member: string, tokens: number): void
  /** 测试/观测用：当前累计 token 消耗 */
  usage(): number
  /**
   * 真实模式逐角色拉起子代理（Promise.allSettled 并发）；'off'/依赖缺失时
   * 回退记录式并返回 {mode:'recorded'}，真实成功返回 {mode:'spawned', results}。
   * @param goal 创业目标（复用 formTeam 的目标解析规则）
   * @param blackboard 可选黑板服务（缺省从 ctx 服务表解析 'opc.blackboard'）
   */
  spawnTeam(goal: string, blackboard?: BlackboardLike): Promise<SpawnTeamResult>
  /** 注入/清除宿主侧真实执行器（清除传 undefined）；注入后优先于 native 途径 */
  setExecutor(executor: RoleExecutor | undefined): void
}

/* ─────────────── 真实拉起：内部实现（证据先行，见包内注释）─────────────── */

/**
 * 官方途径调研结论（2026-09，node_modules 源码证据）：
 * - `ctx.subagents.start`（dsh-subagent/lib/types/index.d.ts:296）要求
 *   `SubagentStartRequest.parent: Agent`（types.d.ts:146），apply 级无父会话不可独立调用。
 * - 官方最小可编程运行样例 dsh-headless（lib/index.js:127-168）证明 apply 级独立
 *   spawn 是支持的：inject ['agentDefaultModel','agents','sessions'] →
 *   `agents.create({sessionId, meta:{cwd}, agentOptions})`（:134-147）→
 *   `agent.followup(createUserMessage(...))`（:152-158）→ `await agent.whenIdle()`（:159）→
 *   `sessions.flush(agent.session)`（:163）→ 读 session 事件汇总最终文本（:33-56）。
 * - dsh-web-app 的 api-session-controller 走同一原语：`ctx.agents.create`（:446）+
 *   `agent.followup(message)`（:774）。
 * 据此：native 执行器按 headless 形状对 ctx 服务表做 duck-type 解析（无编译期硬依赖）；
 * `createUserMessage` 仅铸造 uuid id + role:'user' + freeze（dsh-llm/lib/types/message.js:34-50），
 * 故内联构造同形消息即可，无需 import dsh-llm。
 */

/** dsh-agent AgentRegistry.create 的最小 duck-type 面（dsh-agent/lib/types/index.d.ts:279） */
interface NativeRegistryLike {
  create(options: {
    sessionId: string
    meta?: { cwd?: string }
    agentOptions?: { provider: string; model: string }
  }): Promise<{ agent: NativeAgentLike; dispose?: () => Promise<void> }>
}

/** dsh-agent Agent 的最小 duck-type 面（runtime-types.d.ts:116/164/192） */
interface NativeAgentLike {
  followup(message: unknown): void
  whenIdle(): Promise<void>
  session: {
    id?: unknown
    seq?: number
    eventAt?(seq: number): { type: string; data?: { message?: { content?: Array<{ type: string; text?: string }> }; reason?: unknown } } | undefined
  }
}

/** dsh-session SessionStore.flush 的最小 duck-type 面（dsh-session/lib/index.js:1526） */
interface NativeSessionsLike {
  flush(session: unknown): Promise<void>
}

/** dsh-agent-default-model 服务的最小 duck-type 面（dsh-headless/lib/index.js:130,133） */
interface NativeDefaultModelLike {
  currentSelection?(): { provider: string; model: string }
}

/** 复刻 dsh-headless summarize（lib/index.js:33-56）：取最后一条非空 assistant 文本与结束原因 */
function summarizeSession(
  session: NativeAgentLike['session'],
  firstSeq: number,
): { text: string; reason: unknown } {
  let started = false
  let text = ''
  let reason: unknown
  const length = session.seq ?? firstSeq
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt?.(seq)
    if (!event) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = (event.data?.message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data?.reason
  }
  return { text, reason }
}

/**
 * 从宿主 cordis 服务表解析 native 执行器（dsh-headless 同款原语）。
 * 任一必需依赖（`agents` 服务）缺失或形状不符 → undefined（调用方回退记录式）。
 */
function resolveNativeExecutor(ctx: OpcContext): RoleExecutor | undefined {
  const agents = ctx.getService<NativeRegistryLike>('agents')
  if (!agents || typeof agents.create !== 'function') return undefined
  const sessions = ctx.getService<NativeSessionsLike>('sessions')
  const canFlush = !!sessions && typeof sessions.flush === 'function'
  const defaultModel = ctx.getService<NativeDefaultModelLike>('agentDefaultModel')
  const selection = defaultModel?.currentSelection?.()
  const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : undefined

  return async (req) => {
    const handle = await agents.create({
      sessionId: `session-opc-team-${req.role}-${randomUUID()}`,
      ...(cwd === undefined ? {} : { meta: { cwd } }),
      ...(selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
    })
    const agent = handle.agent
    let output = ''
    try {
      // 与 headless 一致：先取基线 seq，再投递角色化用户消息并等待 turn 静默
      const firstSeq = agent.session.seq ?? 0
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: req.task }],
        source: { kind: 'user' },
      })
      await agent.whenIdle()
      output = summarizeSession(agent.session, firstSeq).text
      if (canFlush) await sessions!.flush(agent.session)
    } finally {
      if (typeof handle.dispose === 'function') await handle.dispose()
    }
    const sessionId = agent.session.id === undefined || agent.session.id === null ? undefined : String(agent.session.id)
    return { output, sessionId }
  }
}

/** 角色化 prompt：角色职责 + 团队目标（要求最终回复给出结论与产出摘要） */
function buildRoleTask(goal: string, role: TeamRole): string {
  return [
    `你是创业团队的一名「${role}」角色成员。职责：${ROLE_DUTIES[role]}。`,
    `团队目标：${goal}`,
    '请以该角色身份独立完成分内工作，并在最终回复中给出你的结论与产出摘要。',
  ].join('\n')
}

/** 产出黑板写入器：scope 'workflow'，key `task-<role>`，乐观锁版本经 read 解析 */
function makeBoardWriter(board: BlackboardLike | undefined) {
  return (role: TeamRole, output: string, sessionId?: string): BlackboardOutcome => {
    if (!board) return 'skipped'
    const key = `task-${role}`
    let expectedVersion = 0
    try {
      const current = board.read('workflow', key)
      expectedVersion = current.length > 0 ? (current[0]?.version ?? 0) : 0
    } catch {
      expectedVersion = 0
    }
    try {
      const result = board.write({
        scope: 'workflow',
        key,
        value: { role, output, ...(sessionId ? { sessionId } : {}), at: Date.now() },
        writer: `opc-team:${role}`,
        role: 'agent',
        expectedVersion,
        confidence: 0.8,
      })
      const status = (result as { status?: string } | undefined)?.status
      return status === 'ok' ? 'written' : 'conflict'
    } catch {
      return 'error'
    }
  }
}

/** 单角色拉起：执行器跑通后产出落黑板；拒绝不抛出（allSettled 语义在 spawnTeam 收敛） */
async function spawnRoleAgent(
  role: TeamRole,
  task: string,
  deps: { executor: RoleExecutor; writeBoard: ReturnType<typeof makeBoardWriter> },
): Promise<RoleSpawnResult> {
  const start = Date.now()
  try {
    const out = await deps.executor({ role, task, label: `opc-team:${role}` })
    const blackboard = deps.writeBoard(role, out.output, out.sessionId)
    return {
      role,
      status: 'fulfilled',
      output: out.output,
      ...(out.sessionId === undefined ? {} : { sessionId: out.sessionId }),
      blackboard,
      durationMs: Date.now() - start,
    }
  } catch (err) {
    return {
      role,
      status: 'rejected',
      reason: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    }
  }
}

export function apply(ctx: OpcContext, config: Config) {
  const tokenBudget = config.tokenBudget > 0 ? config.tokenBudget : 1_000_000
  // spawn 模式校验（fail loud：非法值拒绝装载而非静默降级）
  const spawnMode: SpawnMode = config.spawn ?? 'off'
  if (spawnMode !== 'off' && spawnMode !== 'auto' && spawnMode !== 'on') {
    throw new OpcError('SPAWN_CONFIG_INVALID', `spawn 配置非法: ${JSON.stringify(config.spawn)}（仅允许 'off'|'auto'|'on'）`)
  }
  /** 宿主侧注入的真实执行器（setExecutor）；优先于 native 途径 */
  let injectedExecutor: RoleExecutor | undefined
  let usedTokens = 0
  let budgetWarned = false
  /** 已拉起的团队成员（mock：仅记录，不真实 spawn） */
  const spawnedMembers: Array<{ member: string; role: TeamRole; spawnedAt: number }> = []

  // 埋点总线（TD-04：统一 TelemetryBus 订阅约定），事件 type 与载荷保持原约定
  const events = createTelemetryBus()
  const emitTeamEvent = (type: string, payload: Record<string, unknown>) => {
    events.emit({ type, payload, timestamp: Date.now() })
  }
  ctx.provideService('opc.team.events', events)

  /** 共享任务板（AS-04）：全队认领同一份清单，状态经 onChange 事件同步 */
  const board = new TaskBoard()
  ctx.provideService('opc.team.board', {
    add: board.addTask.bind(board),
    list: board.list.bind(board),
    claim: board.claim.bind(board),
    complete: board.complete.bind(board),
    block: board.block.bind(board),
    stats: board.stats.bind(board),
    onChange: board.onChange.bind(board),
    snapshot: board.snapshot.bind(board),
    restore: board.restore.bind(board),
  })

  /** 目标 → 计划（formTeam 与 spawnTeam 共用的解析规则，AS-01） */
  const resolvePlan = (goal: string): TeamPlan => {
    if (typeof goal !== 'string' || goal.trim().length === 0) {
      throw new OpcError('GOAL_PARSE_FAILED', `无法解析创业目标: ${JSON.stringify(goal)}`)
    }
    const rule = GOAL_ROLE_RULES.find((r) => r.pattern.test(goal))
    if (!rule) {
      throw new OpcError('GOAL_PARSE_FAILED', `无法识别目标关键词，可改用 fallbackTemplates() 手动选择: ${goal}`)
    }
    return {
      roles: [...rule.roles],
      teamSize: rule.roles.length,
      createdAt: Date.now(),
      goal,
    }
  }

  const service: TeamService = {
    formTeam(goal: string): TeamPlan {
      const plan = resolvePlan(goal)
      // 埋点：agent_team_create（PRD 数据事件表：team_size, roles, goal）
      emitTeamEvent('agent_team_create', { team_size: plan.teamSize, roles: plan.roles, goal: plan.goal })
      return plan
    },

    async spawnTeam(goal: string, blackboard?: BlackboardLike): Promise<SpawnTeamResult> {
      const plan = resolvePlan(goal)
      const board = blackboard ?? (ctx.getService('opc.blackboard') as BlackboardLike | undefined)
      const writeBoard = makeBoardWriter(board)
      const executor = injectedExecutor ?? (spawnMode === 'off' ? undefined : resolveNativeExecutor(ctx))
      if (spawnMode === 'off' || executor === undefined) {
        const fallbackReason = spawnMode === 'off' ? 'spawn-off' : 'executor-unavailable'
        // 回退可观测：即使记录式也发 fallback 埋点（'on' 强制模式下降级必留痕）
        emitTeamEvent('team_spawn_fallback', { goal, spawn: spawnMode, reason: fallbackReason, roles: plan.roles })
        return { mode: 'recorded', plan, fallbackReason }
      }
      // 真实模式：逐角色并发 spawn（Promise.allSettled：单角色失败不拖垮整队）
      const start = Date.now()
      const settled = await Promise.allSettled(
        plan.roles.map((role) => spawnRoleAgent(role, buildRoleTask(goal, role), { executor, writeBoard })),
      )
      const results: RoleSpawnResult[] = settled.map((outcome, i) => {
        const role = plan.roles[i]
        if (outcome.status === 'fulfilled') return outcome.value
        // spawnRoleAgent 内部已捕获异常；此分支防御 executor 同步 throw 等极端情况
        return {
          role,
          status: 'rejected',
          reason: outcome.status === 'rejected' ? String(outcome.reason) : 'unknown',
          durationMs: -1,
        }
      })
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length
      const rejected = results.length - fulfilled
      const durationMs = Date.now() - start
      // 埋点：team_spawn_real（真实模式，AS-02 组建时间随 durationMs 可测）
      emitTeamEvent('team_spawn_real', {
        goal,
        team_size: plan.teamSize,
        roles: plan.roles,
        fulfilled,
        rejected,
        durationMs,
      })
      return { mode: 'spawned', plan, results, durationMs }
    },

    setExecutor(executor: RoleExecutor | undefined): void {
      injectedExecutor = executor
    },

    fallbackTemplates(): TeamTemplate[] {
      return FALLBACK_TEMPLATES.map((t) => ({ ...t, roles: [...t.roles] }))
    },

    recordUsage(member: string, tokens: number): void {
      if (usedTokens + tokens > tokenBudget) {
        // PRD 6.2.3：Token 消耗超预算 → 超支拦截（100%，严格超额才拦截，本次用量不记录）
        emitTeamEvent('token_budget_exceeded', { used: usedTokens, budget: tokenBudget, member })
        throw new OpcError('TOKEN_BUDGET_EXCEEDED', `token 预算已耗尽: ${usedTokens}/${tokenBudget}`)
      }
      usedTokens += tokens
      const ratio = usedTokens / tokenBudget
      if (ratio >= 0.8 && !budgetWarned) {
        budgetWarned = true
        // PRD 6.2.3：阈值告警（80%）
        emitTeamEvent('token_budget_warn', { used: usedTokens, budget: tokenBudget, ratio, member })
      }
    },

    usage(): number {
      return usedTokens
    },
  }

  ctx.provideService('opc.team', service)

  // 模拟 dsh-team 集成：'team/spawn' 事件入口拉起成员（mock 场景仅记录）
  ctx.onEvent('team/spawn', (payload) => {
    const req = payload as { member: string; role: TeamRole }
    spawnedMembers.push({ member: req.member, role: req.role, spawnedAt: Date.now() })
  })

  ctx.onDispose(() => {
    spawnedMembers.length = 0
    usedTokens = 0
    budgetWarned = false
    injectedExecutor = undefined // 注入执行器随插件卸载一并清除
    // 'opc.team.events' 服务由宿主 unload 时从注册表撤销
  })
}

/** cordis Plugin.Function 形状：可被真实 ctx.plugin(plugin, config) 加载 */
export const plugin = defineOpcPlugin<Config>({
  name,
  defaultConfig: { tokenBudget: 1_000_000, spawn: 'off' },
  apply,
})

export default plugin
