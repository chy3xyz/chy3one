import type { DomainKey, ThreeDomains } from './types.js'

/**
 * ID-01 三域草案：自然语言创意描述 → 问题域/解决域/时空域 初稿。
 *
 * 规则策略（零依赖、可离线）：按线索词把句子归入三域——
 * 时空域线索（时间窗口/地域/约束）优先级最高（避免"面向市场"被误归解决域），
 * 其次解决域线索（方案/产品动作），其余归问题域；首句恒为问题陈述。
 * LLM 精化策略留待插件层（沿用 content/llm.ts 的降级模式），核心只保证
 * "录入后必有可迭代的三域草案"（ID-01 验收）。
 */

/** 单域摘要上限（超长截断，草案只求可用不求完备） */
const SUMMARY_MAX = 400

const SPACETIME_CUES = [
  '时间窗口', '窗口期', '时机', '风口', '趋势', '红利', '季节', '节点',
  '地域', '国内', '海外', '跨境', '出海', '中国', '美国', '市场环境',
  '面向', '针对', '政策', '监管', '技术条件', '基础设施', '行业',
]

const SOLUTION_CUES = [
  '方案', '打算', '计划做', '准备做', '做一个', '做一款', '开发', '搭建',
  '构建', '实现', '上线', '产品', '平台', '工具', '服务', '通过', '利用',
  '基于', '引入', '提供', '帮', '让用户',
]

function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?\n；;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function classify(sentence: string): DomainKey {
  if (SPACETIME_CUES.some((cue) => sentence.includes(cue))) return 'spacetime'
  if (SOLUTION_CUES.some((cue) => sentence.includes(cue))) return 'solution'
  return 'problem'
}

function truncate(text: string): string {
  return text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX) + '…' : text
}

/**
 * 生成三域草案：句子按线索词分桶，未命中的域留空 summary（引导问题接管）。
 * 全文无任何句子可分时（极端），整段文本落入问题域作为问题陈述。
 */
export function draftThreeDomains(text: string): ThreeDomains {
  const sentences = splitSentences(text)
  const buckets: Record<DomainKey, string[]> = { problem: [], solution: [], spacetime: [] }
  sentences.forEach((sentence, index) => {
    // 首句恒为问题陈述：三域共演化的锚点（prd2.md 2.2）
    buckets[index === 0 ? 'problem' : classify(sentence)].push(sentence)
  })
  // 问题域兜底：没有除首句外的归类结果时，把全文作为问题陈述，保证草案非空
  const problemSummary = buckets.problem.join('；')
  return {
    problem: {
      summary: truncate(problemSummary.length > 0 ? problemSummary : text),
      points: [],
    },
    solution: { summary: truncate(buckets.solution.join('；')), points: [] },
    spacetime: { summary: truncate(buckets.spacetime.join('；')), points: [] },
  }
}

/** 从描述文本派生默认创意名：去空白取前 16 字符（用户可随时改名） */
export function deriveIdeaName(text: string): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length > 16 ? flattened.slice(0, 16) + '…' : flattened
}
