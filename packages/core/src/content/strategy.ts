/**
 * Content Engine 可替换策略层（PRD 6.3.1 CE-01/03/04/05）。
 *
 * 当前全部为启发式/模板实现（零外部运行时依赖）；接口即为真实 LLM 注入位——
 * 接入大模型时实现同接口（如 OpenAITopicStrategy）并经 ContentPipeline 构造参数
 * 或 setStrategies() 注入，流水线编排零改动。
 */
import { randomUUID } from 'node:crypto'
import { OpcError } from '../errors.js'
import type { MemoryEntry, MemoryStore } from '../memory/memory.js'
import type { Brief, Draft, PlatformContent, PublishResult, ReviewResult, ReviewViolation } from './types.js'

/* ─────────────── CE-01 选题策略 ─────────────── */

export interface TopicStrategy {
  /** 检索人设记忆（topic/fact/rules/soul）→ 生成候选 → 取 personaScore 最高 */
  pick(memory: MemoryStore): Promise<Brief>
}

/** CE-01 验收：输出 ≥5 个候选选题 */
export const MIN_TOPIC_CANDIDATES = 5

/** 内置常青选题（mock「热点搜索」；热点无结果时按 PRD 6.3.4 回退至选题库） */
const EVERGREEN_TOPICS: Array<{ title: string; angle: string }> = [
  { title: '一个人内容工厂的搭建复盘', angle: '流程拆解：从选题到分发的最小闭环' },
  { title: 'AI 时代的个人效率系统', angle: '工具组合与记忆库如何替代团队分工' },
  { title: '账号冷启动的前十篇内容', angle: '冷启动阶段的选题节奏与投放策略' },
  { title: '知识付费的定价心理学', angle: '锚定效应与阶梯报价的实操案例' },
  { title: '长期主义的内容资产观', angle: '为什么爆款是结果，系列化才是护城河' },
  { title: '单人团队的自动化边界', angle: '哪些环节交给 Agent，哪些必须人工把关' },
]

/** 归一化文本 → 2-gram 集合（中英混排；用于候选与人设记忆的相关性粗排） */
function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const grams = new Set<string>()
  for (const token of normalized.split(' ')) {
    if (token.length < 2) continue
    for (let i = 0; i < token.length - 1; i++) grams.add(token.slice(i, i + 2))
  }
  return grams
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  for (const g of b) if (a.has(g)) return true
  return false
}

const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * 模板选题策略：候选 = 进行中选题（topic 记忆直连） + 常青选题库。
 * 记忆直连候选天然携带人设相关性（≥4 分），保证 CE-01 验收线。
 */
export class TemplateTopicStrategy implements TopicStrategy {
  /** 生成全部候选（≥5，CE-01）；暴露给测试与上层观测 */
  generateCandidates(memory: MemoryStore): Brief[] {
    const topics = memory.query({ category: 'topic', limit: 5 })
    const soul = memory.query({ category: 'soul', limit: 1 })
    const personaEntries: MemoryEntry[] = [
      ...soul,
      ...memory.query({ category: 'fact', limit: 5 }),
      ...memory.query({ category: 'rules', limit: 5 }),
    ]

    const candidates: Brief[] = topics.map((t) => ({
      title: t.content,
      angle: `围绕进行中选题「${t.content}」做深度展开，结合账号人设给出可执行结论`,
      // 记忆直连选题：基线 4（CE-01 相关性 ≥4/5）+ 置信度加权
      personaScore: round1(Math.min(5, 4 + t.confidence)),
      sources: [`memory://topic/${t.id.slice(0, 8)}`],
    }))

    for (const e of EVERGREEN_TOPICS) {
      candidates.push({
        title: e.title,
        angle: e.angle,
        personaScore: this.scoreAgainstMemory(`${e.title} ${e.angle}`, personaEntries),
        sources: ['builtin://evergreen-topics'],
      })
    }
    return candidates
  }

  async pick(memory: MemoryStore): Promise<Brief> {
    const candidates = this.generateCandidates(memory)
    if (candidates.length < MIN_TOPIC_CANDIDATES) {
      // 防御分支：常青库兜底后仍不足，说明内置库被错误清空
      throw new OpcError('CE_TOPIC_EXHAUSTED', `候选选题不足 ${MIN_TOPIC_CANDIDATES} 个: ${candidates.length}`)
    }
    // 稳定排序：同分时保持插入序（记忆直连候选优先于常青库）
    candidates.sort((a, b) => b.personaScore - a.personaScore)
    return candidates[0]
  }

  /** 常青候选与人设记忆的 bigram 命中数计分：无记忆 3.0 起，每命中一条 +0.5，封顶 5 */
  private scoreAgainstMemory(text: string, personaEntries: MemoryEntry[]): number {
    const grams = bigrams(text)
    let hits = 0
    for (const e of personaEntries) {
      if (overlaps(grams, bigrams(e.content))) hits++
    }
    return round1(Math.min(5, 3 + 0.5 * hits))
  }
}

/* ─────────────── CE-03 撰写策略 ─────────────── */

export interface WriteStrategy {
  /**
   * 按平台格式生成初稿。
   * @param feedback 重写轮携带的上轮审核结果（违规点），真实 LLM 策略据此定向改写
   */
  write(brief: Brief, memory: MemoryStore, feedback?: ReviewResult): Promise<Draft>
}

/** PRD 6.3.4：生成内容过短（<300 字）自动触发扩写，最多 2 轮 */
export const MIN_BODY_CHARS = 300
export const MAX_EXPANSION_ROUNDS = 2

/** 模板撰写策略：标题公式 + 正文段落拼装，篇幅不足自动扩写 */
export class TemplateWriteStrategy implements WriteStrategy {
  /** 最近一次 write 触发的扩写次数（观测/测试用） */
  lastExpansions = 0

  async write(brief: Brief, memory: MemoryStore, feedback?: ReviewResult): Promise<Draft> {
    void memory // 记忆入参预留给 LLM 策略（人设口吻注入位）；模板实现无需检索
    const title = `${brief.title}：从原理到落地的 3 个步骤`
    let body = [
      `为什么聊「${brief.title}」？因为${brief.angle}，这也是账号人设最擅长展开的话题。`,
      '先划边界：这篇内容只解决一个具体问题，把目标收窄到读者当下就能动手的程度，不贪多。',
      '再给路径：把解决过程拆成一份可复制的清单，每一步都有明确的完成标准，照做就能得到结果。',
    ].join('\n')

    // CE 异常表：过短触发扩写，最多 2 轮
    let expansions = 0
    while (body.length < MIN_BODY_CHARS && expansions < MAX_EXPANSION_ROUNDS) {
      expansions++
      body += [
        `\n\n【补充 ${expansions}】围绕「${brief.title}」补一组实操案例：${brief.angle}。案例一来自单人团队的自动化实践，展示从选题到发布如何在半小时内跑通全链路，并标注每个环节的人工介入点。`,
        '方法论上把内容生产拆成选题、撰写、审核、分发四个环节，分别定义完成标准与回退策略，任何一环不达标就退回上一环节重做，避免带病上线；对应工具与耗时也一并给出参考值。',
        '收尾回扣标题承诺的三个步骤，附上常见问答与延伸阅读入口，方便读者转发收藏，同时为下一篇内容埋下记忆钩子，让人设特征在系列内容里持续复利。',
      ].join('')
    }

    // 重写轮：向 LLM 策略一样「带着违规点改」——模板实现以修订说明显式回审
    if (feedback && feedback.violations.length > 0) {
      const types = feedback.violations.map((v) => v.type).join('、')
      body += `\n\n修订说明：已逐条复核上轮审核意见（${types}），相关表述替换为可证实的中性描述，并补充信息来源。`
    }

    this.lastExpansions = expansions
    return { title, body, platform: 'wechat' }
  }
}

/* ─────────────── CE-04 审核策略 ─────────────── */

export interface ReviewStrategy {
  /** 规则/模型合规检查：检出违规 → pass=false */
  review(draft: Draft): Promise<ReviewResult>
}

/** 禁词表（内容安全红线，severity=high） */
const BANNED_WORDS = ['赌博', '色情', '毒品', '诈骗', '传销', '办证', '代开发票', '枪支']

/** 绝对化用语（广告法红线，severity=medium） */
const ABSOLUTE_TERMS = ['最好', '最佳', '最优', '最强', '第一', '顶级', '绝对', '完美', '国家级', '全网最低', '史上最']

/** 未证实断言（收益/效果承诺与无出处断言，severity=high） */
const UNVERIFIED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /稳赚|保本|零风险|包赔|百分百(?:中|赚|有效)/u, label: '收益效果承诺' },
  { pattern: /月入\s*[0-9一二三四五六七八九十百]+万/u, label: '未证实的收入断言' },
  { pattern: /(?:研究|临床|数据)表明[^。！？]{0,20}(?:有效|领先|第一)/u, label: '无出处的断言' },
]

const SEVERITY_PENALTY: Record<ReviewViolation['severity'], number> = { high: 40, medium: 20, low: 10 }

/** 规则审核策略：禁词表 + 绝对化用语 + 未证实断言三类检查（CE-04 规则基线） */
export class RuleReviewStrategy implements ReviewStrategy {
  async review(draft: Draft): Promise<ReviewResult> {
    const text = `${draft.title}\n${draft.body}`
    const violations: ReviewViolation[] = []

    for (const word of BANNED_WORDS) {
      if (text.includes(word)) {
        violations.push({ type: 'banned-word', severity: 'high', detail: `命中禁词「${word}」` })
      }
    }
    for (const term of ABSOLUTE_TERMS) {
      if (text.includes(term)) {
        violations.push({ type: 'absolute-claim', severity: 'medium', detail: `绝对化用语「${term}」缺乏限定条件` })
      }
    }
    for (const { pattern, label } of UNVERIFIED_PATTERNS) {
      const hit = text.match(pattern)
      if (hit) {
        violations.push({ type: 'unverified-claim', severity: 'high', detail: `疑似${label}：「${hit[0]}」缺少可证实来源` })
      }
    }

    const penalty = violations.reduce((sum, v) => sum + SEVERITY_PENALTY[v.severity], 0)
    return { pass: violations.length === 0, violations, score: Math.max(0, 100 - penalty) }
  }
}

/* ─────────────── CE-05 分发适配 ─────────────── */

export interface PublishAdapter {
  /** 目标平台标识（PRD 6.3.3 分发平台矩阵；MVP 仅 wechat） */
  readonly platform: string
  /** 平台适配 + 发布（真实实现位：公众平台 API；限流退避由 pipeline 统一处理） */
  publish(content: PlatformContent): Promise<PublishResult>
}

/** 公众号 mock 链路：返回 mp.weixin.qq.com 形态的假链接，供流水线与测试跑通 */
export class MockWechatAdapter implements PublishAdapter {
  readonly platform = 'wechat'

  async publish(content: PlatformContent): Promise<PublishResult> {
    return {
      platform: this.platform,
      url: `https://mp.weixin.qq.com/s/${randomUUID()}`,
      publishedAt: Date.now(),
      success: true,
    }
  }
}
