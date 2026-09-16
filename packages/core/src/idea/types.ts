/**
 * 创意一等公民（PRD-OPCOS-2026-002 / docs/prd2.md 1.3）：
 * 创意（Idea）是 CreativeOS 的组织单元，拥有四阶段生命周期与三域描述框架。
 * 本模块只定义领域类型，不依赖 DSH/存储实现。
 */

/** 创意生命周期四阶段（prd2.md 1.2）：描述 → 产品 → 运营 → 资产 */
export type IdeaStage = 'description' | 'product' | 'operation' | 'asset'

export const IDEA_STAGES: readonly IdeaStage[] = ['description', 'product', 'operation', 'asset']

/** 阶段中文名（控制台与文案共用，prd2.md 1.2 阶段一~四） */
export const IDEA_STAGE_LABELS: Record<IdeaStage, string> = {
  description: '创意描述',
  product: '创意产品',
  operation: '产品运营',
  asset: '产品资产',
}

/** 三域维度标识（prd2.md 2.2） */
export type DomainKey = 'problem' | 'solution' | 'spacetime'

export const DOMAIN_KEYS: readonly DomainKey[] = ['problem', 'solution', 'spacetime']

/** 域中文名（控制台与文案共用） */
export const DOMAIN_LABELS: Record<DomainKey, string> = {
  problem: '问题域',
  solution: '解决域',
  spacetime: '时空域',
}

/** 单个域的结构化描述 */
export interface DomainDetail {
  /** 域概述：问题陈述 / 解决方案概述 / 时机分析 */
  summary: string
  /** 结构化要点：目标用户与替代方案 / 核心功能与差异化 / 市场窗口与约束条件 */
  points: string[]
}

/** 三域框架（prd2.md 2.2：问题域 / 解决域 / 时空域，共演化而非线性流程） */
export type ThreeDomains = Record<DomainKey, DomainDetail>

/**
 * ID-02 三域引导问题（验收：每个维度至少 3 个）。
 * 系统在创意详情中逐域抛出，引导用户完善对应域。
 */
export const GUIDING_QUESTIONS: Record<DomainKey, readonly string[]> = {
  problem: [
    '谁在什么场景下遇到这个问题？',
    '这个问题现在是怎么被解决的（现有替代方案）？',
    '现有方案为什么不够好？',
    '问题出现的频率和痛感有多高？',
  ],
  solution: [
    '你的方案是什么？用一句话讲清楚。',
    '核心功能是哪几个？',
    '与现有方案相比，核心差异化在哪里？',
  ],
  spacetime: [
    '这个创意在什么时间窗口内成立？',
    '面向什么地域、文化或人群？',
    '依赖什么技术或政策条件？有哪些约束？',
  ],
}

/**
 * 创意记忆体的固定流（prd2.md 2.4 目录结构 + 4.3 facts + 5.2 users/analytics）：
 * 每个 JSONL 流是创意记忆体的 append-only 正本，FTS5 索引为检索镜像。
 */
export const IDEA_MEMORY_STREAMS = [
  'description',
  'decisions',
  'research',
  'model-notes',
  'facts',
  'users',
  'analytics',
] as const

export type IdeaMemoryStream = (typeof IDEA_MEMORY_STREAMS)[number]

/** 三域完整性与结构校验（store 与 API 共用）；不合法抛 RangeError/Error */
export function validateDomains(value: unknown): ThreeDomains {
  if (typeof value !== 'object' || value === null) {
    throw new Error('domains must be an object with problem/solution/spacetime')
  }
  const result = {} as ThreeDomains
  for (const key of DOMAIN_KEYS) {
    const detail = (value as Record<string, unknown>)[key]
    if (typeof detail !== 'object' || detail === null) {
      throw new Error(`domains.${key} must be an object`)
    }
    const { summary, points } = detail as Record<string, unknown>
    if (typeof summary !== 'string') {
      throw new Error(`domains.${key}.summary must be a string`)
    }
    if (
      !Array.isArray(points) ||
      points.some((p) => typeof p !== 'string')
    ) {
      throw new Error(`domains.${key}.points must be an array of strings`)
    }
    result[key] = { summary, points: points as string[] }
  }
  return result
}
