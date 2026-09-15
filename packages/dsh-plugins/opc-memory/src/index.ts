import { JsonlMemoryStore, type MemoryEntry, type MemoryQuery, type MemoryScope } from '../../../core/src/index.js'
import { defineOpcPlugin, type OpcContext } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-memory'

export interface Config {
  memoriesFile?: string
  instinctsFile?: string
  /**
   * 人工纠正检测（DE-03，默认开启）：订阅 DSH 'session/event' firehose，
   * 识别"turn 以 aborted（用户打断）结束 且 后续紧接用户新指令"的纠正信号，
   * 向 memory store 写入一条 lesson。false 时零监听、零写入。
   */
  correctionDetection?: boolean
}

/** Instinct 侧输入：工具调用观测记录（ARD-004，喂给 PatternMiner 做本能提炼） */
export interface InstinctObservation {
  taskSignature: string
  tools: string[]
  success: boolean
}

/** 'opc.instinct.observe' 埋点事件的订阅句柄 */
export interface InstinctObserve {
  subscribe(listener: (observation: InstinctObservation, entry: MemoryEntry) => void): () => void
}

/**
 * 'agent/pre-step' waterfall 载荷：真实 dsh-agent-loop 形状 { messages, turn, signal }
 * 优先；测试简化字段（taskId）作为回退同样放行。惰性加载不读取具体字段。
 */
interface AgentPreStepPayload {
  messages?: unknown[]
  turn?: number
  signal?: AbortSignal
  taskId?: string
}

/**
 * 真实 DSH 'session/event' firehose 的事件切片（emit 模式，listener(session, event)）。
 * 载荷事实（node_modules 源码，只消费实有字段，不虚构）：
 * - dsh-session/lib/types/types.d.ts:260-263 'turn/end' {turn, reason}；
 *   :165-201 reason.kind ∈ completed | aborted{reason:{kind}} | blocked | error | max-tokens | interrupted；
 *   :147-161 取消因 kind ∈ user | parent | hook | disposed | legacy；
 * - :275-281 'user/message' 载荷本体即 UserMessage（content 文本块 + source.kind 直挂 data，
 *   'user' = 直接人工输入，区别于 plugin 注入/目标续跑；dsh-llm message.d.ts:95-97）；
 * - :309-317 'assistant/message' {turn, step, message, stream, usage?, interrupted?}；
 * - :333-339 'tool/call' {turn, step, callId, name, arguments}。
 */
export interface SessionEventLike {
  type: string
  /** 事件落日志时间（ms），缺省时回退 Date.now() */
  time?: number
  data?: {
    turn?: number
    /** 'tool/call'：工具名 */
    name?: string
    /** 'turn/end'：结束原因（TurnEndReason） */
    reason?: {
      kind?: string
      /** aborted 时的取消因（TurnEndCancelCause） */
      reason?: { kind?: string } | string
      [extra: string]: unknown
    }
    /** 'assistant/message'：消息字段（content 文本块 + source） */
    message?: {
      content?: Array<{ type?: string; text?: string }>
      source?: { kind?: string }
      [extra: string]: unknown
    }
    /** 'user/message'：载荷本体无 message 包装，source/content 直挂 data */
    source?: { kind?: string }
    content?: Array<{ type?: string; text?: string }>
    [extra: string]: unknown
  }
}

/** 一条待确认的人工纠正：aborted 轮的现场快照，等后续用户消息确认 */
interface PendingCorrection {
  key: string
  sessionId: string
  turn: number
  /** 被打断轮次的工具名序列（真实 'tool/call' 载荷，不做正文虚构） */
  tools: string[]
  /** 被打断轮次最后一条 assistant 正文摘要（≤200 字，来自真实载荷） */
  assistantExcerpt?: string
  /** 取消因 kind（真实 turn/end reason.reason 载荷：user/parent/hook/disposed/legacy） */
  cancelCause?: string
  abortedAt: number
}

/** 正文摘要上限：assistant/message 正文截断 200 字后入 lesson */
const EXCERPT_MAX_CHARS = 200
/** 轮状态驻留上限：超出按最旧淘汰，防超长会话累积泄漏 */
const MAX_TURN_STATE = 512
/** 去重 Set 容量上限：同一 (sessionId,turn) 只记一次，超出按最旧淘汰 */
const MAX_REPORTED = 1024

/** 插入序即最旧序：超容量时淘汰队首（Map 与 Set 同理） */
function evictOldest(store: Map<unknown, unknown> | Set<unknown>, cap: number): void {
  if (store.size <= cap) return
  const oldest = store.keys().next()
  if (!oldest.done) store.delete(oldest.value)
}

const sessionKeyOf = (session: unknown): string => {
  const id = (session as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id.length > 0 ? id : 'unknown-session'
}

/** 会话所在 scope：session 载荷携带合法 MemoryScope 时采用，否则回退 'workflow' */
const scopeOf = (session: unknown): MemoryScope => {
  const scope = (session as { scope?: unknown } | undefined)?.scope
  return scope === 'global' || scope === 'workflow' || scope === 'agent' ? scope : 'workflow'
}

/** 取消因 kind：真实载荷为 {kind:'user'|'parent'|'hook'|'disposed'|'legacy'}，未知形状不猜 */
const cancelCauseOf = (reason: { kind?: string } | string | undefined): string | undefined => {
  if (typeof reason === 'string') return reason
  const kind = reason?.kind
  return typeof kind === 'string' ? kind : undefined
}

/** 提取文本块正文（真实 ContentBlock {type:'text', text}），非文本块忽略 */
const textOf = (blocks: Array<{ type?: string; text?: string }> | undefined): string => {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

export function apply(ctx: OpcContext, config: Config) {
  const memories = new JsonlMemoryStore(config.memoriesFile)
  const instincts = new JsonlMemoryStore(config.instinctsFile)

  let loaded = false
  const loadOnce = (payload: AgentPreStepPayload) => {
    // 真实字段（messages/turn/signal）与简化字段（taskId）均不参与加载决策
    if (!loaded) {
      loaded = true // JsonlMemoryStore 构造时已读盘，此处仅保证幂等标记
    }
    return undefined // 放行（waterfall：undefined 不替换载荷）
  }

  /** 'opc.instinct.observe' 埋点：本地广播，供 PatternMiner / Skill Forge 等下游消费 */
  const observers = new Set<(o: InstinctObservation, e: MemoryEntry) => void>()
  const observe: InstinctObserve = {
    subscribe(listener) {
      observers.add(listener)
      return () => observers.delete(listener)
    },
  }

  ctx.provideService('opc.memory', {
    write: (entry: Parameters<JsonlMemoryStore['write']>[0]) => memories.write(entry),
    query: (criteria: MemoryQuery) => memories.query(criteria),
  })

  ctx.provideService('opc.instinct', {
    record(observation: InstinctObservation): MemoryEntry {
      const entry = instincts.write({
        scope: 'global',
        category: observation.success ? 'lesson' : 'topic',
        content: JSON.stringify(observation),
        confidence: observation.success ? 1 : 0.5,
      })
      for (const listener of observers) listener(observation, entry)
      return entry
    },
  })
  ctx.provideService('opc.instinct.observe', observe)

  ctx.onWaterfall('agent/pre-step', loadOnce)

  // ── 人工纠正检测路径：DSH 'session/event' firehose（emit 模式，DE-03）───────
  // 纠正信号选型（以 types.d.ts 实际定义为准）：
  // 1) 主信号：'turn/end' 且 reason.kind === 'aborted'（types.d.ts:169-173），取
  //    reason.reason.kind（user/parent/hook/disposed/legacy，:147-161）记为 cancelCause；
  // 2) 确认信号：随后的 'user/message' 且 source.kind === 'user'（直接人工输入，
  //    types.d.ts:275-281、dsh-llm message.d.ts:95-97）——"打断后紧接的新指令"构成一次纠正；
  // 3) 备选信号（本插件未采用，理由）：'agent/inbox/spliced'（dsh-agent types.d.ts:80-86）
  //    载荷无 turn 字段且会话首条消息也走该事件（/tmp/s1.jsonl seq 3 实证），单独使用噪声大；
  //    'approval/decided' outcome==='rejected'（dsh-user-approval types.d.ts:48-51）是真实的
  //    工具级人工拒绝，但载荷无 turn，无法归属轮次去重。
  // 命中即向 memory store（非 instinct）写 lesson；摘要只用真实载荷：工具名序列
  // 优先，assistant 正文可得时截断 200 字。
  const turnTools = new Map<string, string[]>() // `${sessionId}#turn${n}` -> 工具名序列
  const turnAssistant = new Map<string, string>() // 同 key -> 最后一条 assistant 正文（≤200 字）
  const pendingAbort = new Map<string, PendingCorrection>() // sessionId -> 待确认纠正（取最新）
  const reportedCorrections = new Set<string>() // 已上报 `${sessionId}#turn${n}`，只记一次

  const offSessionEvents =
    config.correctionDetection === false
      ? undefined
      : ctx.onEvent('session/event', (...args: unknown[]) => {
          const session: unknown = args[0]
          const event = args[1] as SessionEventLike | undefined
          if (!event || typeof event.type !== 'string') return
          const data = event.data
          if (!data) return
          const sessionId = sessionKeyOf(session)

          // 'user/message' 载荷本体即 UserMessage（types.d.ts:281），无 turn 字段，
          // 归属靠 pendingAbort 的 sessionId 键，故须在 turn 守卫之前处理。
          if (event.type === 'user/message') {
            // 只认直接人工输入：注入上下文（plugin/agent.inject）与目标续跑不算纠正
            if (data.source?.kind !== 'user') return
            const pending = pendingAbort.get(sessionId)
            if (!pending) return
            pendingAbort.delete(sessionId)
            if (reportedCorrections.has(pending.key)) return // 同一 (sessionId,turn) 只记一次
            reportedCorrections.add(pending.key)
            evictOldest(reportedCorrections, MAX_REPORTED)

            memories.write({
              scope: scopeOf(session),
              category: 'lesson',
              content: JSON.stringify({
                originalScenario: buildOriginalScenario(pending),
                correctionSignal: 'turn/end:aborted+user/message',
                cancelCause: pending.cancelCause,
                sessionId: pending.sessionId,
                turn: pending.turn,
                timestamp: Date.now(),
              }),
              confidence: 0.9,
            })
            return
          }

          // 其余事件（tool/call、assistant/message、turn/end）均携带轮次号
          if (typeof data.turn !== 'number') return
          const key = `${sessionId}#turn${data.turn}`
          const at = typeof event.time === 'number' ? event.time : Date.now()

          if (event.type === 'tool/call') {
            if (typeof data.name !== 'string') return
            const tools = turnTools.get(key) ?? []
            tools.push(data.name)
            turnTools.set(key, tools)
            evictOldest(turnTools, MAX_TURN_STATE)
            return
          }

          if (event.type === 'assistant/message') {
            const text = textOf(data.message?.content)
            if (text.length > 0) {
              turnAssistant.set(key, text.slice(0, EXCERPT_MAX_CHARS))
              evictOldest(turnAssistant, MAX_TURN_STATE)
            }
            return
          }

          if (event.type === 'turn/end') {
            if (data.reason?.kind === 'aborted') {
              pendingAbort.set(sessionId, {
                key,
                sessionId,
                turn: data.turn,
                tools: turnTools.get(key) ?? [],
                assistantExcerpt: turnAssistant.get(key),
                cancelCause: cancelCauseOf(data.reason?.reason),
                abortedAt: at,
              })
            }
            // 轮已闭合：无论正常/中止，轮内明细状态不再需要
            turnTools.delete(key)
            turnAssistant.delete(key)
            return
          }
        })

  ctx.onDispose(() => {
    offSessionEvents?.()
    loaded = false
    observers.clear()
    turnTools.clear()
    turnAssistant.clear()
    pendingAbort.clear()
    reportedCorrections.clear()
  })
}

/** originalScenario：工具名序列优先（不做正文虚构），assistant 正文可得时附加 ≤200 字摘要 */
const buildOriginalScenario = (pending: PendingCorrection): string => {
  const parts: string[] = []
  if (pending.tools.length > 0) parts.push(`工具序列: ${pending.tools.join('>')}`)
  if (pending.assistantExcerpt !== undefined && pending.assistantExcerpt.length > 0) {
    parts.push(`被打断前 AI 正文(≤${EXCERPT_MAX_CHARS}字): ${pending.assistantExcerpt}`)
  }
  return parts.length > 0 ? parts.join(' | ') : '被打断轮次无可见输出'
}

/** cordis Plugin.Function 形状：可被真实 ctx.plugin(plugin, config) 加载 */
export const plugin = defineOpcPlugin<Config>({
  name,
  defaultConfig: {
    memoriesFile: './memories.jsonl',
    instinctsFile: './instincts.jsonl',
    correctionDetection: true,
  },
  apply,
})

export default plugin
