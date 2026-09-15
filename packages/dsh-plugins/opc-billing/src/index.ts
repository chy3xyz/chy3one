import { BillingEngine, type BillingEvent } from '../../../core/src/index.js'
import { defineOpcPlugin, type OpcContext } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-billing'

export interface Config {
  resolvedUnitPrice: number
  logFile?: string
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

export function apply(ctx: OpcContext, config: Config) {
  const engine = new BillingEngine(config.logFile)
  engine.setRule({ resolution: 'resolved', unitPrice: config.resolvedUnitPrice })

  ctx.provideService('opc.billing', engine)

  /** 会话内累计的 token 用量，request 点累计、任务完成点结算 */
  const usageByTask = new Map<string, {
    prompt: number
    completion: number
    startedAt: number
    provider?: string
    model?: string
  }>()

  /**
   * 任务桶键：真实载荷只有 messages/turn/signal 与 provider/model，不含任务标识；
   * 携带 taskId 的（简化）载荷按 taskId 归桶，真实载荷归并到会话桶 'session'。
   */
  const taskKeyOf = (payload: { taskId?: string }): string => payload.taskId ?? 'session'

  ctx.onWaterfall('agent/pre-step', (raw) => {
    const step = raw as AgentPreStepPayload
    const key = taskKeyOf(step)
    if (!usageByTask.has(key)) {
      usageByTask.set(key, { prompt: 0, completion: 0, startedAt: Date.now() })
    }
    return undefined // 放行（waterfall：undefined 不替换载荷）
  })

  ctx.onWaterfall('agent/request', (raw) => {
    const req = raw as AgentRequestPayload
    const usage = usageByTask.get(taskKeyOf(req))
    if (usage && req.usage) {
      usage.prompt += req.usage.prompt
      usage.completion += req.usage.completion
      if (req.provider) usage.provider = req.provider
      if (req.model) usage.model = req.model
    }
    return undefined // 放行
  })

  ctx.provideService(
    'opc.billing.complete',
    (event: Pick<BillingEvent, 'taskId' | 'agentId' | 'resolution'>) => {
      const usage = usageByTask.get(event.taskId)
      return engine.onTaskComplete({
        ...event,
        tokensUsed: usage
          ? { prompt: usage.prompt, completion: usage.completion }
          : { prompt: 0, completion: 0 },
        durationMs: usage ? Date.now() - usage.startedAt : 0,
        timestamp: Date.now(),
      })
    },
  )

  ctx.onDispose(() => {
    usageByTask.clear()
  })
}

/** cordis Plugin.Function 形状：可被真实 ctx.plugin(plugin, config) 加载 */
export const plugin = defineOpcPlugin<Config>({
  name,
  defaultConfig: { resolvedUnitPrice: 2.5 },
  apply,
})

export default plugin
