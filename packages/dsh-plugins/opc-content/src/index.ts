/**
 * Content Engine 插件（PRD 6.3 系统三 MVP）：封装 ContentPipeline 为 'opc.content' 服务，
 * 埋点总线暴露为 'opc.content.events'（TD-04 统一约定）。
 *
 * 真实智能层接线（CE-02/CE-03 + CE-01 热点）：
 * - 配置 deepseekApiKey（config/env）→ DeepSeek 撰写+分析策略，模板策略作回退
 * - hotSearch（默认 true）且 ctx 存在 'web' 服务（ctx.web WebRuntime）→ 注入热点话题源，
 *   候选并入热点（source:'hot'）；web 服务缺失/形状不符 → 不注入，常青库兜底
 * - 无 key → 纯模板策略（与既有行为一致）
 * - mode() 返回生效模式供健康检查；API Key 只参与客户端构造，绝不回读/打日志
 *
 * 说明：core 的内容模块以深路径引入；层级数与 opc-team 一致（../../../ → packages/）。
 */
import { ContentPipeline, type PipelineRunResult } from '../../../core/src/content/pipeline.js'
import {
  DeepSeekAnalysisStrategy,
  DeepSeekChatClient,
  DeepSeekWriteStrategy,
} from '../../../core/src/content/llm.js'
import { TemplateTopicStrategy, TemplateWriteStrategy, type PublishAdapter, type ReviewStrategy, type TopicStrategy, type WriteStrategy } from '../../../core/src/content/strategy.js'
import { WebSearchTopicSource, looksLikeWebSearchService } from '../../../core/src/content/web-topic.js'
import { JsonlMemoryStore, type MemoryStore } from '../../../core/src/index.js'
import { createTelemetryBus, defineOpcPlugin, type OpcContext, type TelemetryBus } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-content'

export interface Config {
  /** 人设记忆落盘路径（JsonlMemoryStore；缺省纯内存） */
  memoriesFile?: string
  /** 流水线 run 结果追加落盘路径（JSONL，可选） */
  runsFile?: string
  /** DeepSeek API Key（或任意 OpenAI 兼容服务密钥）；缺省回退纯模板策略。也读 env.DEEPSEEK_API_KEY */
  deepseekApiKey?: string
  /** OpenAI 兼容服务地址（默认 https://api.deepseek.com） */
  deepseekBaseUrl?: string
  /** 模型名（默认 deepseek-chat） */
  deepseekModel?: string
  /** 热点搜索（经 ctx.web），默认开启；'web' 服务缺失时自动降级为常青库 */
  hotSearch?: boolean
}

export interface StrategySet {
  topicStrategy?: TopicStrategy
  writeStrategy?: WriteStrategy
  reviewStrategy?: ReviewStrategy
  publishAdapter?: PublishAdapter
}

export interface ContentMode {
  /** true = DeepSeek LLM 撰写/分析策略已生效（配置了 API Key） */
  llm: boolean
  /** true = 热点话题源已注入（hotSearch 开启且 ctx.web 服务可用） */
  hotSearch: boolean
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
  /** 生效模式（健康检查用；不回传任何密钥） */
  mode(): ContentMode
}

/** API Key 注入顺序：config 优先，环境变量兜底（运营覆盖走同一字段，不做隐藏优先链） */
function resolveApiKey(config: Config): string {
  return (config.deepseekApiKey ?? process.env['DEEPSEEK_API_KEY'] ?? '').trim()
}

export function apply(ctx: OpcContext, config: Config) {
  // 人设记忆：七类 MemoryCategory 直接复用 JsonlMemoryStore（PRD 6.3.2 记忆表）
  const memory = new JsonlMemoryStore(config.memoriesFile)
  const events = createTelemetryBus()

  // 热点源：ctx.getService('web') 可能 undefined（宿主未装 dsh-web）→ 不注入，常青库兜底
  const hotSearchEnabled = config.hotSearch !== false
  let topicSource: WebSearchTopicSource | undefined
  if (hotSearchEnabled) {
    const web = ctx.getService('web')
    if (looksLikeWebSearchService(web)) topicSource = new WebSearchTopicSource(web)
  }

  // LLM 策略：有 key → DeepSeek 撰写/分析（模板策略为回退）；无 key → 纯模板（现状）
  const apiKey = resolveApiKey(config)
  const templateTopic = new TemplateTopicStrategy(topicSource)
  const templateWrite = new TemplateWriteStrategy()
  let topicStrategy: TopicStrategy = templateTopic
  let writeStrategy: WriteStrategy = templateWrite
  if (apiKey.length > 0) {
    const client = new DeepSeekChatClient(apiKey, {
      baseUrl: config.deepseekBaseUrl,
      model: config.deepseekModel,
    })
    writeStrategy = new DeepSeekWriteStrategy(client, templateWrite)
    topicStrategy = new DeepSeekAnalysisStrategy(client, templateTopic)
  }

  const pipeline = new ContentPipeline({
    memory,
    telemetry: events,
    runsFile: config.runsFile,
    topicStrategy,
    writeStrategy,
  })

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
    mode: () => ({ llm: apiKey.length > 0, hotSearch: topicSource !== undefined }),
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
