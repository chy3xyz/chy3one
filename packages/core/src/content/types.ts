/**
 * Content Engine MVP 数据契约（PRD 6.3：选题 → 撰写 → 审核 → 分发 单平台流水线）。
 * 仅公众号（wechat）一种形态；多平台矩阵见 PRD 6.3.3，Phase 2 扩展。
 */

/** CE-01 选题产物：候选选题（含人设相关性评分） */
export interface Brief {
  title: string
  /** 差异化切入角度 */
  angle: string
  /** 人设相关性评分 0..5（CE-01 验收：≥ 4/5） */
  personaScore: number
  /** 选题依据来源（memory://、builtin://、hot:// 等可追溯标识） */
  sources: string[]
  /**
   * 差异化定位维度（CE-02 LLM 分析策略产出，可选：模板策略不产生）。
   * 每条为「维度：本文差异 vs 市场常见做法」的竞品拆解对比。
   */
  differentiation?: string[]
}

/** CE-03 撰写产物：平台初稿（MVP 仅公众号长文） */
export interface Draft {
  title: string
  body: string
  platform: 'wechat'
  /** LLM 撰写策略自拟标签（可选：模板策略不产生；分发适配时并入 PlatformContent.tags） */
  tags?: string[]
}

/** 审核违规条目（CE-04：检出违规需标记具体违规点，驱动重写） */
export interface ReviewViolation {
  type: string
  severity: 'low' | 'medium' | 'high'
  detail: string
}

/** CE-04 审核产物：检出违规 → pass=false（违规内容检出率基线见 PRD 验收标准） */
export interface ReviewResult {
  pass: boolean
  violations: ReviewViolation[]
  /** 合规分 0..100（扣分制，供记忆置信度与观测使用） */
  score: number
  /** E-E-A-T 四维检查（prd2.md 4.3，advisory：扣分不改 pass 语义；GEO 就绪时携带） */
  eeat?: import('./geo.js').EeatCheck[]
}

/** CE-05 平台适配产物：分发前最终形态 */
export interface PlatformContent {
  platform: string
  title: string
  htmlBody: string
  tags: string[]
  /** Schema JSON-LD（prd2.md 4.3 策略三：结构化标记提升被生成式引擎引用概率） */
  schemaJsonLd?: string
}

/** CE-05 分发产物 */
export interface PublishResult {
  platform: string
  url: string
  publishedAt: number
  success: boolean
}
