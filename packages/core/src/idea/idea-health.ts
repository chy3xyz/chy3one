import type { Idea } from './store.js'

/**
 * 创意健康评分——变现准备度四维诊断（prd2.md 差异化能力）：
 * 每个创意自动计算「描述完备度 / 验证强度 / 内容产出 / 资产沉淀」四维分数与建议，
 * 详情页一目了然该创意离「可变现」还差什么。
 */

export interface HealthDimension {
  key: 'description' | 'validation' | 'content' | 'assets'
  label: string
  score: number
  max: number
  /** 未满分的改进建议 */
  suggestions: string[]
}

export interface IdeaHealthReport {
  ideaId: string
  /** 总分 0..100 */
  score: number
  dimensions: HealthDimension[]
  /** 一句话诊断（最低分维度 → 最优先动作） */
  verdict: string
}

export interface HealthInput {
  idea: Idea
  /** decisions 流中 MVP 方案条数 */
  planCount: number
  /** 验证记录条数与平均分 */
  validations: number
  avgValidationScore?: number
  /** analytics 流中 content-metrics 条数（已发布内容） */
  contentCount: number
  /** 账本收入合计（分） */
  financeTotalCents: number
  /** Token 已发放 */
  tokensDistributed: number
  /** 是否已发布到市场 */
  published: boolean
}

/** 四维评分：描述 25 / 验证 25 / 内容 25 / 资产 25，各维独立打分后加总 */
export function computeHealthScore(input: HealthInput): IdeaHealthReport {
  const dims: HealthDimension[] = []

  // 一、描述完备度（25 分）：三域 summary 非空 + 要点 ≥1 + 问题域有量化描述
  {
    const d = input.idea.domains
    let score = 0
    const tips: string[] = []
    for (const key of ['problem', 'solution', 'spacetime'] as const) {
      if ((d[key].summary || '').trim().length >= 10) score += 5
      else tips.push(`完善${key === 'problem' ? '问题域' : key === 'solution' ? '解决域' : '时空域'}的概述`)
    }
    const pointCount = d.problem.points.length + d.solution.points.length
    if (pointCount >= 2) score += 5
    else tips.push('补充问题域/解决域的要点（至少各 1 条）')
    if ((d.problem.summary || '').length + (d.solution.summary || '').length >= 60) score += 5
    else tips.push('丰富问题域与解决域的描述细节（合计 ≥60 字）')
    dims.push({ key: 'description', label: '描述完备度', score, max: 25, suggestions: tips })
  }

  // 二、验证强度（25 分）：有 MVP 方案 + 验证 ≥3 条 + 平均分 ≥3.5
  {
    let score = 0
    const tips: string[] = []
    if (input.planCount > 0) score += 10
    else tips.push('先生成 MVP 方案（基于三域自动推荐）')
    if (input.validations >= 3) score += 10
    else tips.push(`补 ${3 - input.validations} 条验证记录（用户反馈或数据指标，≥3 条）`)
    if (input.avgValidationScore !== undefined && input.avgValidationScore >= 3.5) score += 5
    else tips.push('提升验证评分（平均 ≥3.5 表示市场验证充分）')
    dims.push({ key: 'validation', label: '验证强度', score, max: 25, suggestions: tips })
  }

  // 三、内容产出（25 分）：已发布内容 ≥1 + 互动率 ≥5% + 多平台
  {
    let score = 0
    const tips: string[] = []
    if (input.contentCount >= 1) score += 10
    else tips.push('发布第一篇内容（出作品 → 内容引擎）')
    if (input.contentCount >= 3) score += 5
    else tips.push('累计发布 ≥3 篇内容建立存在感')
    if (input.financeTotalCents > 0) score += 5
    else tips.push('变现通道未打通——尝试订单/订阅/RaaS 任一通道')
    if (input.published) score += 5
    else tips.push('发布到创意市场获得曝光')
    dims.push({ key: 'content', label: '内容产出', score, max: 25, suggestions: tips })
  }

  // 四、资产沉淀（25 分）：Token 发放 + 收入 + 发布到市场
  {
    let score = 0
    const tips: string[] = []
    if (input.tokensDistributed > 0) score += 10
    else tips.push('发放 Token 给贡献者（协同激励）')
    if (input.financeTotalCents >= 100000) score += 10
    else tips.push('累计收入 ≥¥1000（资产沉淀的量化基础）')
    if (input.published) score += 5
    else tips.push('发布到创意市场获得曝光')
    dims.push({ key: 'assets', label: '资产沉淀', score, max: 25, suggestions: tips })
  }

  const total = dims.reduce((sum, d) => sum + d.score, 0)
  const lowest = [...dims].sort((a, b) => a.score - b.score)[0]
  const verdict = total >= 80 ? '变现准备充分——可加大投入'
    : total >= 60 ? '基础良好——按建议补短板'
    : total >= 40 ? '早期阶段——优先补最低维度'
    : '起步阶段——先完善三域描述'
  return {
    ideaId: input.idea.id,
    score: total,
    dimensions: dims,
    verdict: `${verdict}（最短板：${lowest?.label ?? '—'}）`,
  }
}
