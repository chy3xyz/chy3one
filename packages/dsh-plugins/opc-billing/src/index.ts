import { BillingEngine, type BillingEvent } from '../../../core/src/index.js'
import { defineOpcPlugin, type OpcContext } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-billing'

export interface Config {
  resolvedUnitPrice: number
  logFile?: string
  /**
   * 真实任务粒度（DE-07，默认开启）：订阅 DSH 'session/event' firehose（emit 模式），
   * 把用量桶按 `${sessionId}#turn${n}` 精确到真实任务（turn）。关闭后回退旧行为：
   * 仅 agent/pre-step / agent/request waterfall 建桶（taskId 或会话桶 'session'）。
   */
  granularBySession?: boolean
}

/**
 * 'agent/pre-step' waterfall 载荷：真实 dsh-agent-loop 形状优先，
 * 附测试所用简化字段的回退读取（taskId）。
 */
export interface AgentPreStepPayload {
  /** 真实字段：本轮消息序列 */
  messages?: unknown[]
  /** 真实字段：轮次序号 */
  turn?: number
  /** 真实字段：中止信号 */
  signal?: AbortSignal
  /** 简化测试载荷字段（回退）：任务标识 */
  taskId?: string
}

/** 'agent/request' waterfall 载荷：真实字段 provider/model 优先，taskId 为简化回退字段 */
export interface AgentRequestPayload {
  /** 真实字段：模型适配器插桩依据 */
  provider?: string
  model?: string
  usage?: { prompt: number; completion: number }
  /** 简化测试载荷字段（回退）：任务标识 */
  taskId?: string
}

/** 真实 DSH 'session/event' firehose 的事件切片（emit 模式，listener(session, event)） */
export interface SessionEventLike {
  type: string
  /** 事件落日志时间（ms），缺省时回退 Date.now() */
  time?: number
  data?: {
    /** 'turn/start' / 'tool/call' / 'tool/result' 均携带的轮次号 */
    turn?: number
    /** 'tool/call'：工具名 */
    name?: string
    [extra: string]: unknown
  }
}

/** 单个任务桶：token 用量（agent/request 点累计）+ 工具计数与起止时间（session/event 点累计） */
interface UsageBucket {
  prompt: number
  completion: number
  /** 桶创建时刻（turn/start 或首次触达的事件时间） */
  startedAt: number
  /** 最近活跃时刻（用于 durationMs 与 LRU 计量） */
  lastActiveAt: number
  provider?: string
  model?: string
  /** 该轮工具调用次数（firehose 'tool/call' 计数，展示用） */
  toolCalls: number
}

/** 桶容量上限：超出按最旧（LRU 迭代序队首）淘汰，防长会话/多会话累积泄漏 */
const MAX_BUCKETS = 512

export function apply(ctx: OpcContext, config: Config) {
  const engine = new BillingEngine(config.logFile)
  engine.setRule({ resolution: 'resolved', unitPrice: config.resolvedUnitPrice })

  ctx.provideService('opc.billing', engine)

  const granular = config.granularBySession !== false

  /** 会话内累计的用量桶，键为 taskId 或 `${sessionId}#turn${n}` */
  const usageByTask = new Map<string, UsageBucket>()
  /** 最近活跃桶：真实 'agent/request' 载荷无 taskId 时用量归属目标 */
  let lastActiveKey: string | undefined

  /** 取桶并在每次触达时刷新 LRU 位置（Map 迭代序 = 插入序，delete+set 即移到队尾） */
  const touchBucket = (key: string, at: number): UsageBucket => {
    let bucket = usageByTask.get(key)
    if (bucket === undefined) {
      bucket = { prompt: 0, completion: 0, startedAt: at, lastActiveAt: at, toolCalls: 0 }
      usageByTask.set(key, bucket)
      if (usageByTask.size > MAX_BUCKETS) {
        const oldest = usageByTask.keys().next()
        if (!oldest.done && oldest.value !== key) usageByTask.delete(oldest.value)
      }
    } else {
      usageByTask.delete(key)
      usageByTask.set(key, bucket)
      bucket.lastActiveAt = Math.max(bucket.lastActiveAt, at)
    }
    return bucket
  }

  /**
   * 任务桶键：真实 pre-step 载荷只有 messages/turn/signal，不含任务标识；
   * 携带 taskId 的（简化）载荷按 taskId 归桶，真实载荷归并到会话桶 'session'。
   */
  const taskKeyOf = (payload: { taskId?: string }): string => payload.taskId ?? 'session'

  const sessionKeyOf = (session: unknown): string => {
    const id = (session as { id?: unknown } | undefined)?.id
    return typeof id === 'string' && id.length > 0 ? id : 'unknown-session'
  }

  const bucketKeyOfTurn = (sessionId: string, turn: number | undefined): string =>
    `${sessionId}#turn${turn ?? 0}`

  // ── 真实任务粒度路径：DSH 'session/event' firehose（emit 模式）──────────────
  // 事实依据（node_modules 源码）：
  // - dsh-session/lib/types/index.d.ts:62 'session/event'(this, session, event)，
  //   @mode emit（观察即可，无 waterfall next 语义）；
  // - dsh-session/lib/index.js:1183-1202 append 提交后 emit，事件为
  //   {type, seq, time, data} 信封，监听器签名 (session, event)；
  // - dsh-session/lib/types/types.d.ts:249-251 'turn/start' {turn}；
  //   :333-339 'tool/call' {turn,step,callId,name,arguments}；
  //   :351-361 'tool/result' {turn,step,message,error?,meta?}。
  // 真实载荷不含 token 用量（usage 在 'assistant/message' 与请求返回上），故本路径
  // 只做桶定位 / 工具计数 / 计时；token 用量仍由 'agent/request' 路径累加。
  const offSessionEvents = granular
    ? ctx.onEvent('session/event', (...args: unknown[]) => {
        const session: unknown = args[0]
        const event = args[1] as SessionEventLike | undefined
        if (!event || typeof event.type !== 'string') return
        const data = event.data
        if (!data || typeof data.turn !== 'number') return
        const at = typeof event.time === 'number' ? event.time : Date.now()
        const key = bucketKeyOfTurn(sessionKeyOf(session), data.turn)
        if (event.type === 'turn/start') {
          lastActiveKey = key
          touchBucket(key, at)
          return
        }
        if (event.type === 'tool/call' || event.type === 'tool/result') {
          lastActiveKey = key
          if (event.type === 'tool/call') touchBucket(key, at).toolCalls += 1
          else touchBucket(key, at)
        }
      })
    : undefined

  ctx.onWaterfall('agent/pre-step', (raw) => {
    const step = raw as AgentPreStepPayload
    touchBucket(taskKeyOf(step), Date.now())
    return undefined // 放行（waterfall：undefined 不替换载荷）
  })

  ctx.onWaterfall('agent/request', (raw) => {
    const req = raw as AgentRequestPayload
    // 用量归属优先级：显式 taskId（既有契约/简化载荷）→ 最近活跃桶（firehose 粒度）→ 会话桶
    const key = req.taskId ?? (granular ? lastActiveKey : undefined) ?? taskKeyOf(req)
    const usage = usageByTask.get(key)
    if (usage && req.usage) {
      usage.prompt += req.usage.prompt
      usage.completion += req.usage.completion
      if (req.provider) usage.provider = req.provider
      if (req.model) usage.model = req.model
      usage.lastActiveAt = Math.max(usage.lastActiveAt, Date.now())
    }
    return undefined // 放行
  })

  ctx.provideService(
    'opc.billing.complete',
    (event: Pick<BillingEvent, 'taskId' | 'agentId' | 'resolution'>) => {
      // taskId 约定：调用方可传 `${sessionId}#turn${n}` 精确结算某个真实任务；
      // 未传（或键不存在）时回退最近活跃桶——真实场景下最后完成的 turn 即待结算任务。
      // 精确命中即删除该桶（一次性结算）；回退路径只读，不删除。
      let usage = usageByTask.get(event.taskId)
      let durationMs = 0
      if (usage !== undefined) {
        durationMs = Math.max(0, usage.lastActiveAt - usage.startedAt)
        usageByTask.delete(event.taskId)
        if (lastActiveKey === event.taskId) lastActiveKey = undefined
      } else if (lastActiveKey !== undefined) {
        usage = usageByTask.get(lastActiveKey)
        if (usage !== undefined) durationMs = Math.max(0, usage.lastActiveAt - usage.startedAt)
      }
      return engine.onTaskComplete({
        ...event,
        tokensUsed: usage
          ? { prompt: usage.prompt, completion: usage.completion }
          : { prompt: 0, completion: 0 },
        durationMs,
        timestamp: Date.now(),
      })
    },
  )

  ctx.onDispose(() => {
    offSessionEvents?.()
    usageByTask.clear()
    lastActiveKey = undefined
  })
}

/** cordis Plugin.Function 形状：可被真实 ctx.plugin(plugin, config) 加载 */
export const plugin = defineOpcPlugin<Config>({
  name,
  defaultConfig: { resolvedUnitPrice: 2.5, granularBySession: true },
  apply,
})

export default plugin
