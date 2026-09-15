import { PatternMiner, SkillDistiller, type SkillDefinition, type ToolObservation } from '../../../core/src/index.js'
import { createPackage, type SkillPackage } from '../../../core/src/skill/packager.js'
import { createTelemetryBus, defineOpcPlugin, type OpcContext } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-skill-forge'

export interface Config {
  minRepetitions: number
  minSuccessRate: number
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

  // 从 agent/request waterfall 载荷读取工具调用观测：
  // 真实字段（provider/model）仅作插桩识别，观测取自 toolObservation（可选，缺失时跳过）
  ctx.onWaterfall('agent/request', (raw) => {
    const req = raw as AgentRequestPayload
    if (req?.toolObservation) service.observe(req.toolObservation)
    return undefined // 放行（waterfall：undefined 不替换载荷）
  })

  ctx.onDispose(() => {
    observations.length = 0
    drafts.length = 0
    distilledKeys.clear() // 'opc.skillforge.events' 服务由宿主 unload 时从注册表撤销
  })
}

/** cordis Plugin.Function 形状：可被真实 ctx.plugin(plugin, config) 加载 */
export const plugin = defineOpcPlugin<Config>({
  name,
  defaultConfig: { minRepetitions: 3, minSuccessRate: 0.8 },
  apply,
})

export default plugin
