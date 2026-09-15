import { PatternMiner, SkillDistiller, type SkillDefinition, type ToolObservation } from '../../../core/src/index.js'
import { createPackage, type SkillPackage } from '../../../core/src/skill/packager.js'
import { createTelemetryBus, defineOpcPlugin, type OpcContext } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-skill-forge'

export interface Config {
  minRepetitions: number
  minSuccessRate: number
  /**
   * 订阅真实 DSH 工具事件（默认开启）：监听 'session/event' firehose 中的
   * 'tool/call' / 'tool/result'（emit 模式），把真实工具名序列与成败聚合为
   * ToolObservation。关闭后仅保留 agent/request 载荷 toolObservation 回退。
   */
  observeRealEvents?: boolean
}

/**
 * 'agent/request' waterfall 载荷：真实 dsh-agent-loop 字段（provider/model）优先识别，
 * 工具调用观测读取简化回退字段 toolObservation（真实载荷未暴露观测字段时使用）。
 */
export interface AgentRequestPayload {
  /** 真实字段：模型适配器插桩依据 */
  provider?: string
  model?: string
  /** 简化测试载荷字段（回退）：本轮工具调用观测 */
  toolObservation?: ToolObservation
}

/** 埋点事件载荷（PRD 7.5）：skill_distill_start / skill_distill_complete（duration/qualityScore 仅 complete） */
export interface SkillForgeEventPayload {
  skillId: string
  duration?: number
  qualityScore?: number
  [extra: string]: unknown
}

export interface SkillForgeService {
  /** 累积观测并即时挖掘；发现 high 置信度模式时自动蒸馏草案（SF-01~SF-03） */
  observe(observation: ToolObservation): void
  listDrafts(): SkillDefinition[]
  /** 打包草案为 .dshpkg 信封（SF-04） */
  packageDraft(skill: SkillDefinition, authorId: string): SkillPackage
}

/** 真实 DSH 'session/event' firehose 的事件切片（emit 模式，listener(session, event)） */
export interface SessionEventLike {
  type: string
  /** 事件落日志时间（ms），缺省时回退 Date.now() */
  time?: number
  data?: {
    /** 'tool/call' / 'tool/result' 均携带的轮次号 */
    turn?: number
    /** 'tool/call'：工具名 */
    name?: string
    /** 'tool/call'：调用标识；'tool/result' 的 callId 在 message 内 */
    callId?: string
    /** 'tool/result'：模型可见结果（isError 即成败） */
    message?: { callId?: string; isError?: boolean }
    /** 'tool/result'：失败身份（仅 isError 时出现） */
    error?: unknown
    [extra: string]: unknown
  }
}

export function apply(ctx: OpcContext, config: Config) {
  const miner = new PatternMiner({
    minRepetitions: config.minRepetitions,
    minSuccessRate: config.minSuccessRate,
  })
  const distiller = new SkillDistiller()

  const observations: ToolObservation[] = []
  const drafts: SkillDefinition[] = []
  const distilledKeys = new Set<string>()
  // 埋点总线（TD-04：统一 TelemetryBus 订阅约定）
  const events = createTelemetryBus()

  const service: SkillForgeService = {
    observe(observation) {
      observations.push(observation)
      const patterns = miner.mine(observations)
      for (const pattern of patterns) {
        if (pattern.confidence !== 'high') continue // 质量门控：低置信度不蒸馏（PRD 6.1.3）
        const key = `${pattern.taskSignature}::${pattern.toolSequence.join('>')}`
        if (distilledKeys.has(key)) continue
        distilledKeys.add(key)
        const startedAt = Date.now()
        events.emit({
          type: 'skill_distill_start',
          payload: { skillId: pattern.taskSignature },
          timestamp: startedAt,
        })
        const draft = distiller.distill(pattern)
        drafts.push(draft)
        const payload: SkillForgeEventPayload = {
          skillId: pattern.taskSignature,
          duration: Date.now() - startedAt,
          qualityScore: pattern.successRate,
        }
        events.emit({ type: 'skill_distill_complete', payload, timestamp: Date.now() })
      }
    },
    listDrafts: () => [...drafts],
    packageDraft: (skill, authorId) => createPackage(skill, authorId).pkg,
  }

  ctx.provideService('opc.skillforge', service)
  // 埋点事件总线（PRD 7.5 / TD-04 统一约定），供计费/监控插件运行时解析
  ctx.provideService('opc.skillforge.events', events)

  // ── 真实观测路径：DSH 'session/event' firehose（emit 模式）─────────────────
  // 事实依据（node_modules 源码）：
  // - dsh-agent-loop/lib/index.js:687/697 以 session.append('tool/call',
  //   {turn,step,callId,name,arguments}) 与 session.append('tool/result',
  //   {turn,step,message,error?,meta?}) 落事件（name=工具名，isError=成败）；
  // - dsh-session/lib/index.js:1196-1202 在 append 提交后于 ctx 上 emit
  //   'session/event'，监听器签名 (session, event)；
  // - dsh-session/lib/types/index.d.ts:66 声明 '@mode emit'（观察即可，无 waterfall
  //   next 语义），官方消费者 dsh-session-telemetry/lib/index.js:75 即
  //   ctx.on('session/event', (session, event) => …)。
  const liveSequences = new Map<string, string>() // `${sessionId}#turn${turn}` -> 该轮已发生工具名（'>' 连接，增量拼接）
  const pendingCalls = new Map<string, { key: string; name: string }>() // callId -> 所属轮序列与工具名
  const sessionKeyOf = (session: unknown): string => {
    const id = (session as { id?: unknown } | undefined)?.id
    return typeof id === 'string' && id.length > 0 ? id : 'unknown-session'
  }

  const offSessionEvents =
    config.observeRealEvents === false
      ? undefined
      : ctx.onEvent('session/event', (...args: unknown[]) => {
          const session: unknown = args[0]
          const event = args[1] as SessionEventLike | undefined
          if (!event || typeof event.type !== 'string') return
          const data = event.data
          if (!data || typeof data.turn !== 'number') return
          const key = `${sessionKeyOf(session)}#turn${data.turn}`
          if (event.type === 'tool/call') {
            if (typeof data.name !== 'string') return
            const seq = liveSequences.get(key)
            liveSequences.set(key, seq === undefined ? data.name : `${seq}>${data.name}`)
            // 防御：超长会话限制驻留轮数（Map 迭代序即插入序，先到先淘汰）
            if (liveSequences.size > 256) {
              const oldest = liveSequences.keys().next()
              if (!oldest.done) liveSequences.delete(oldest.value)
            }
            if (typeof data.callId === 'string') pendingCalls.set(data.callId, { key, name: data.name })
            return
          }
          if (event.type === 'tool/result') {
            // 成败只有 result 到达才可知：仅在 result 时对整个当前序列记一次观测
            // （call→result 成对；被中止的调用由 dsh-agent-loop 以 isError 补 result）。
            const callId = typeof data.message?.callId === 'string' ? data.message.callId : undefined
            const pending = callId !== undefined ? pendingCalls.get(callId) : undefined
            if (callId !== undefined) pendingCalls.delete(callId)
            const seq = liveSequences.get(pending?.key ?? key)
            if (seq === undefined || seq.length === 0) return
            const failed = data.message?.isError === true || data.error != null
            service.observe({
              taskSignature: sessionKeyOf(session), // 会话标识：跨轮聚类（PatternMiner 按 taskSignature+序列分组）
              tools: seq.split('>'),
              success: !failed,
              timestamp: typeof event.time === 'number' ? event.time : Date.now(),
            })
          }
        })

  // 从 agent/request waterfall 载荷读取工具调用观测（回退路径，保留以兼容既有测试）：
  // 真实字段（provider/model）仅作插桩识别，观测取自 toolObservation（可选，缺失时跳过）
  ctx.onWaterfall('agent/request', (raw) => {
    const req = raw as AgentRequestPayload
    if (req?.toolObservation) service.observe(req.toolObservation)
    return undefined // 放行（waterfall：undefined 不替换载荷）
  })

  ctx.onDispose(() => {
    offSessionEvents?.()
    liveSequences.clear()
    pendingCalls.clear()
    observations.length = 0
    drafts.length = 0
    distilledKeys.clear() // 'opc.skillforge.events' 服务由宿主 unload 时从注册表撤销
  })
}

/** cordis Plugin.Function 形状：可被真实 ctx.plugin(plugin, config) 加载 */
export const plugin = defineOpcPlugin<Config>({
  name,
  defaultConfig: { minRepetitions: 3, minSuccessRate: 0.8, observeRealEvents: true },
  apply,
})

export default plugin
