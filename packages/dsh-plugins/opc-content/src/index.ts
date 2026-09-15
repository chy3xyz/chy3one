/**
 * Content Engine 插件（PRD 6.3 系统三 MVP）：封装 ContentPipeline（默认模板策略）
 * 为 'opc.content' 服务，埋点总线暴露为 'opc.content.events'（TD-04 统一约定）。
 *
 * 说明：core 的内容模块以深路径引入（core/src/index.ts 桶文件暂未导出 content，
 * 遵循"不修改既有文件"约束）；层级数与 opc-team 一致（../../../ → packages/）。
 */
import { ContentPipeline, type PipelineRunResult } from '../../../core/src/content/pipeline.js'
import type { PublishAdapter, ReviewStrategy, TopicStrategy, WriteStrategy } from '../../../core/src/content/strategy.js'
import { JsonlMemoryStore, type MemoryStore } from '../../../core/src/index.js'
import { createTelemetryBus, defineOpcPlugin, type OpcContext, type TelemetryBus } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-content'

export interface Config {
  /** 人设记忆落盘路径（JsonlMemoryStore；缺省纯内存） */
  memoriesFile?: string
  /** 流水线 run 结果追加落盘路径（JSONL，可选） */
  runsFile?: string
}

export interface StrategySet {
  topicStrategy?: TopicStrategy
  writeStrategy?: WriteStrategy
  reviewStrategy?: ReviewStrategy
  publishAdapter?: PublishAdapter
}

export interface ContentService {
  /** 选题 → 撰写 → 审核 → 分发 全流程（含记忆沉淀与 content_publish 埋点） */
  run(): Promise<PipelineRunResult>
  /** 策略替换口（真实 LLM 注入位），可单独覆盖任一环节 */
  setStrategies(overrides: StrategySet): void
  /** 人设记忆直通（七类 MemoryCategory，与 core MemoryStore 同形） */
  readonly memory: MemoryStore
  /** 观测用：run 调用计数（含失败） */
  stats(): { runs: number }
}

export function apply(ctx: OpcContext, config: Config) {
  // 人设记忆：七类 MemoryCategory 直接复用 JsonlMemoryStore（PRD 6.3.2 记忆表）
  const memory = new JsonlMemoryStore(config.memoriesFile)
  const events = createTelemetryBus()
  const pipeline = new ContentPipeline({ memory, telemetry: events, runsFile: config.runsFile })

  let runs = 0
  const service: ContentService = {
    run() {
      return pipeline.run().finally(() => {
        runs++
      })
    },
    setStrategies(overrides) {
      pipeline.setStrategies(overrides)
    },
    memory,
    stats: () => ({ runs }),
  }

  ctx.provideService('opc.content', service)
  ctx.provideService('opc.content.events', events)

  ctx.onDispose(() => {
    runs = 0 // 订阅集与服务注册表由宿主 unload 时撤销（与 opc-team 卸载语义一致）
  })
}

/** cordis Plugin.Function 形状：可被真实 ctx.plugin(plugin, config) 加载 */
export const plugin = defineOpcPlugin<Config>({
  name,
  defaultConfig: {},
  apply,
})

export default plugin
