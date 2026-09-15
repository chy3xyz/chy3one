import { JsonlMemoryStore, type MemoryEntry, type MemoryQuery } from '../../../core/src/index.js'
import { defineOpcPlugin, type OpcContext } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-memory'

export interface Config {
  memoriesFile?: string
  instinctsFile?: string
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

  ctx.onDispose(() => {
    loaded = false
    observers.clear()
  })
}

/** cordis Plugin.Function 形状：可被真实 ctx.plugin(plugin, config) 加载 */
export const plugin = defineOpcPlugin<Config>({
  name,
  defaultConfig: { memoriesFile: './memories.jsonl', instinctsFile: './instincts.jsonl' },
  apply,
})

export default plugin
