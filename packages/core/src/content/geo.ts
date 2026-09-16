import type { Brief, Draft, ReviewResult, ReviewViolation } from './types.js'

/**
 * GEO 行销算法层（prd2.md 4.3 四策略的算法部分）：
 * - E-E-A-T 强化：审核阶段四维要素检查（advisory：扣分不阻塞过审，驱动重写阈值不变）
 * - Schema 标记：分发阶段生成 JSON-LD（Article），提升被生成式引擎引用概率
 * - 结构化知识内容：选题策略对 FAQ/指南/对比类选题加权（见 STRUCTURED_CONTENT_BOOST）
 * - 品牌事实库：创意记忆体 facts 流即事实源（写入走记忆体 API，无独立存储）
 */

/** E-E-A-T 四维定义与启发式检查（经验/专业/权威/可信） */
export interface EeatDimension {
  key: 'experience' | 'expertise' | 'authoritativeness' | 'trust'
  label: string
  /** 命中任一标记即视为该维度达标 */
  markers: string[]
}

export const EEAT_DIMENSIONS: readonly EeatDimension[] = [
  { key: 'experience', label: '经验', markers: ['实测', '亲测', '实操', '案例', '上手', '复盘', '踩坑'] },
  { key: 'expertise', label: '专业', markers: ['原理', '机制', '方法论', '步骤', '参数', '指标', '对比'] },
  { key: 'authoritativeness', label: '权威', markers: ['来源', '据', '报告', '标准', '官方', '文献'] },
  { key: 'trust', label: '可信', markers: ['免责', '数据截至', '参考文献', '更新于', '勘误'] },
]

export interface EeatCheck {
  dimension: EeatDimension['key']
  label: string
  present: boolean
  /** 未达标时的补强建议 */
  hint: string
}

/**
 * E-E-A-T 四维检查（prd2.md 4.3 策略一）：启发式标记命中。
 * 检查结果并入 ReviewResult.eeat 与 score（每缺一维 -5，advisory 不改 pass 语义——
 * E-E-A-T 是优化方向而非发布红线，避免审核重写循环被启发式误伤）。
 */
export function checkEeat(draft: Draft): EeatCheck[] {
  const text = `${draft.title}\n${draft.body}`
  return EEAT_DIMENSIONS.map((dim) => {
    const present = dim.markers.some((marker) => text.includes(marker))
    return {
      dimension: dim.key,
      label: dim.label,
      present,
      hint: present ? '' : `补强「${dim.label}」要素：加入${dim.markers.slice(0, 3).join('/')}等一手信息或出处`,
    }
  })
}

/** E-E-A-T 扣分：每缺一维 -5（0..100 内） */
export function eeatPenalty(checks: readonly EeatCheck[]): number {
  return checks.filter((c) => !c.present).length * 5
}

/** 把 E-E-A-T 检查并入规则审核结果（分数下调、eeat 字段挂载；pass 语义不变） */
export function withEeat(result: ReviewResult, checks: readonly EeatCheck[]): ReviewResult {
  return {
    ...result,
    score: Math.max(0, result.score - eeatPenalty(checks)),
    eeat: [...checks],
  }
}

/** GEO 可见性基准参考（prd2.md 4.3 效果指标：优化后可见性显著提升的公开案例） */
export const GEO_REFERENCE_CASES = [
  { industry: '美妆', platform: '豆包', before: 0.15, after: 0.89 },
  { industry: '金融科技', platform: 'AI 问答', before: 0, firstRate: 0.42 },
] as const

/**
 * Schema JSON-LD 生成（prd2.md 4.3 策略三）：分发阶段为内容生成 Article 结构化标记，
 * 提升生成式引擎的引用概率。内容为合法 JSON 字符串（<script type="application/ld+json"> 内联体）。
 */
export function buildSchemaJsonLd(draft: Draft, brief: Brief, now: () => number = Date.now): string {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: draft.title.slice(0, 110),
    description: brief.angle.slice(0, 200),
    keywords: [...new Set([...(draft.tags ?? []), ...(brief.differentiation ?? [])])].slice(0, 10),
    inLanguage: 'zh-CN',
    datePublished: new Date(now()).toISOString(),
    author: { '@type': 'Organization', name: 'CreativeOS Idea Publisher' },
  }
  return JSON.stringify(schema)
}

/** 结构化内容选题标记（prd2.md 4.3 策略二：FAQ/指南/对比等可直接回答问题的内容优先） */
export const STRUCTURED_TOPIC_MARKERS = [
  'FAQ', '指南', '攻略', '对比', '选购', '怎么选', '如何选', '避坑', '清单', '测评', '排行',
]

/** 选题是否为结构化知识内容（标题或角度命中标记） */
export function isStructuredTopic(brief: Pick<Brief, 'title' | 'angle'>): boolean {
  const text = `${brief.title} ${brief.angle}`
  return STRUCTURED_TOPIC_MARKERS.some((marker) => text.toUpperCase().includes(marker.toUpperCase()))
}

/** 结构化选题加权值（personaScore 加成，封顶由策略层控制） */
export const STRUCTURED_CONTENT_BOOST = 0.3
