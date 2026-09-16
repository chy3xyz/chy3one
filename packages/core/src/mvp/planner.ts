import type { ThreeDomains } from '../idea/types.js'

/**
 * MVP 规划器（prd2.md 3.2 IP-01 / IP-04，8.2 creativeos/product-dev 的算法层）：
 * 三域分析 → MVP 功能清单 + 技术栈 + 开发计划（模板策略，零依赖可离线）；
 * LLM 精化策略沿用 content/llm.ts 的降级模式，留待插件层接入。
 */

export interface MvpPlan {
  ideaId: string
  /** MVP 功能清单（IP-01 验收三件套之一） */
  features: string[]
  /** 技术栈建议 */
  techStack: string[]
  /** 开发计划：三段式（核心可用 → 验证闭环 → 打磨扩散） */
  milestones: Array<{ title: string; items: string[] }>
  /** 生成方式（template=模板策略；llm=模型策略，预留） */
  strategy: 'template' | 'llm'
  createdAt: number
}

/** MVP 验证记录（IP-03：验证结果写入创意记忆体） */
export interface MvpValidation {
  kind: 'mvp-validation'
  /** feedback=用户反馈 / metric=数据指标（IP-03 两类来源） */
  source: 'feedback' | 'metric'
  /** 满意度/得分 0..5（metric 记录归一化后的值；缺省按 3 计入建议） */
  score?: number
  content: string
  at: number
}

/** Go/No-Go 建议（IP-04）：基于验证记录数量的确定性规则，不黑箱 */
export interface GoNoGoSuggestion {
  suggestion: 'go' | 'no-go'
  reasons: string[]
  /** 评估依据的记录数 */
  validations: number
}

const TECH_HINTS: ReadonlyArray<readonly [keyword: string, stack: string]> = [
  ['落地页', '静态站点生成 + 表单收集'],
  ['小程序', '微信小程序 + 云开发'],
  ['App', '跨端框架（Flutter/React Native）'],
  ['浏览器插件', 'WebExtension（Manifest V3）'],
  ['API', 'REST + Webhook 回调'],
  ['AI', 'DeepSeek API + 提示词模板'],
  ['数据', 'SQLite 起步，量大再上 PostgreSQL'],
  ['电商', '商品库 + 订单 + 支付沙箱'],
  ['内容', '内容管理 + 多平台分发适配'],
]

/**
 * 模板策略生成 MVP 方案：功能清单取解决域要点（不足补三问模板），
 * 技术栈按全文关键词命中推荐（未命中给通用建议），计划固定三段。
 */
export function planMvp(ideaId: string, domains: ThreeDomains, now: () => number = Date.now): MvpPlan {
  const solution = domains.solution
  const problem = domains.problem
  const features = solution.points.length > 0
    ? [...solution.points]
    : ['把解决域一句话变成最小可用页面', '收集 10 个目标用户的真实反馈', '记录一个可量化的验证指标']

  const haystack = [problem.summary, solution.summary, domains.spacetime.summary].join('\n')
  const techStack = TECH_HINTS.filter(([kw]) => haystack.includes(kw)).map(([, stack]) => stack)
  if (techStack.length === 0) techStack.push('单服务 + SQLite 起步（能跑通再扩）')
  if (!techStack.some((s) => s.includes('DeepSeek')) && haystack.includes('智能')) {
    techStack.push('DeepSeek API + 提示词模板')
  }

  return {
    ideaId,
    features,
    techStack: [...new Set(techStack)],
    milestones: [
      { title: '第一段 · 核心可用（1 周）', items: [features[0] ?? '打通主流程', '单用户跑通全流程'] },
      { title: '第二段 · 验证闭环（1-2 周）', items: ['邀请目标用户试用并回收反馈', '确定北极星指标并埋点'] },
      { title: '第三段 · 打磨扩散（2 周+）', items: ['按反馈排优先级修整', '准备产品化决策材料（Go/No-Go）'] },
    ],
    strategy: 'template',
    createdAt: now(),
  }
}

/**
 * Go/No-Go 建议（IP-04）：确定性规则，不黑箱——
 * 记录 ≥2 条 且 平均评分 ≥3.5 → go；否则 no-go 并给出缺什么。
 * 记录为空时明确说"还没有验证记录"，不给模糊乐观。
 */
export function suggestGoNoGo(validations: readonly MvpValidation[]): GoNoGoSuggestion {
  if (validations.length === 0) {
    return { suggestion: 'no-go', reasons: ['还没有任何验证记录：先收集用户反馈或数据指标'], validations: 0 }
  }
  const scores = validations.map((v) => v.score ?? 3)
  const average = scores.reduce((s, v) => s + v, 0) / scores.length
  if (validations.length >= 2 && average >= 3.5) {
    return {
      suggestion: 'go',
      reasons: [`验证记录 ${validations.length} 条，平均评分 ${average.toFixed(1)}/5——验证充分，建议推进`],
      validations: validations.length,
    }
  }
  const reasons: string[] = []
  if (validations.length < 2) reasons.push(`验证记录 ${validations.length} 条（<2）：再补一条反馈或指标`)
  if (average < 3.5) reasons.push(`平均评分 ${average.toFixed(1)}/5（<3.5）：按反馈打磨后再验证一轮`)
  return { suggestion: 'no-go', reasons, validations: validations.length }
}
