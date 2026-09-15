import { OpcError } from '../errors.js'
import type { ToolPattern } from './pattern-miner.js'

export interface SkillDefinition {
  name: string
  version: string
  memorySnapshot: Array<{ layer: 'soul' | 'lesson'; content: string }>
  skillDefinition: {
    trigger: string
    toolSequence: string[]
    postConditions: string
  }
}

/** 蒸馏质量不达标：调用方应提示用户手动编辑（PRD 6.1.3） */
export class DistillQualityError extends OpcError {
  constructor(pattern: ToolPattern) {
    super('DISTILL_QUALITY_GATE', `pattern ${pattern.taskSignature} failed quality gate`)
  }
}

/**
 * Skill 蒸馏（SF-03）：把 high 置信度模式转为 PRD 6.1.2 定义的产物结构。
 */
export class SkillDistiller {
  distill(pattern: ToolPattern): SkillDefinition {
    if (pattern.confidence !== 'high') throw new DistillQualityError(pattern)
    return {
      name: `skill-${pattern.taskSignature}-${pattern.toolSequence.length}steps`,
      version: '0.1.0',
      memorySnapshot: [
        { layer: 'soul', content: `${pattern.taskSignature} 执行者人格` },
        {
          layer: 'lesson',
          content: `${pattern.toolSequence.join('→')} 共执行 ${pattern.repetitions} 次，成功率 ${(pattern.successRate * 100).toFixed(0)}%`,
        },
      ],
      skillDefinition: {
        trigger: `任务签名匹配 ${pattern.taskSignature}`,
        toolSequence: [...pattern.toolSequence],
        postConditions: '工具序列全部成功执行并产出结果',
      },
    }
  }
}
