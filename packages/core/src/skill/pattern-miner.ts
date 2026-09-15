/** Instinct 侧输入：一次任务中的工具调用观测（SF-01） */
export interface ToolObservation {
  /** 任务分组键：同一业务任务的观测才可能构成同一模式 */
  taskSignature: string
  tools: string[]
  success: boolean
  timestamp: number
}

export interface ToolPattern {
  taskSignature: string
  toolSequence: string[]
  repetitions: number
  successRate: number
  /** 质量门控结果（SF-02 / PRD 6.1.3） */
  confidence: 'high' | 'low'
}

export interface PatternMinerConfig {
  /** 触发蒸馏的最小重复次数 */
  minRepetitions: number
  /** 序列视为“成功达标”的最低成功率 */
  minSuccessRate: number
}

export const DEFAULT_MINER_CONFIG: PatternMinerConfig = {
  minRepetitions: 3,
  minSuccessRate: 0.8,
}

/**
 * 模式识别（SF-02）：按任务签名 + 工具序列精确聚类，
 * 重复≥minRepetitions 且成功率达标 → high；序列长度不一致 → low（不蒸馏）。
 */
export class PatternMiner {
  constructor(private readonly config: PatternMinerConfig = DEFAULT_MINER_CONFIG) {}

  mine(observations: ToolObservation[]): ToolPattern[] {
    const groups = new Map<string, { seq: string[]; total: number; ok: number; lengths: Set<number> }>()
    for (const ob of observations) {
      const seqKey = `${ob.taskSignature}::${ob.tools.join('>')}`
      const g = groups.get(seqKey) ?? { seq: ob.tools, total: 0, ok: 0, lengths: new Set<number>() }
      g.total += 1
      g.ok += ob.success ? 1 : 0
      g.lengths.add(ob.tools.length)
      groups.set(seqKey, g)
    }

    const patterns: ToolPattern[] = []
    for (const [seqKey, g] of groups) {
      const taskSignature = seqKey.split('::')[0]
      const successRate = g.ok / g.total
      if (g.total < this.config.minRepetitions) continue
      patterns.push({
        taskSignature,
        toolSequence: g.seq,
        repetitions: g.total,
        successRate,
        confidence:
          successRate >= this.config.minSuccessRate && g.lengths.size === 1 ? 'high' : 'low',
      })
    }
    return patterns.sort((a, b) => b.repetitions - a.repetitions)
  }
}
