/**
 * Content Engine 真实智能层（PRD 6.3.1 CE-02 分析 / CE-03 撰写）：
 * DeepSeek（OpenAI 兼容 /chat/completions）LLM 策略，失败回退模板策略。
 *
 * - 零外部运行时依赖：HTTP 用全局 fetch；超时用 AbortController（默认 15s）
 * - API Key 由插件层 config/env 注入：绝不写死、绝不打日志；错误详情经本地脱敏
 *   （redactSecrets，与 dsh-adapter redact 同思路），失败统一抛 OpcError('LLM_REQUEST_FAILED')
 * - 解析失败/超时/契约不达标一律回退注入的模板策略（TemplateWriteStrategy /
 *   TemplateTopicStrategy），流水线编排零改动
 */
import { OpcError } from '../errors.js'
import type { MemoryEntry, MemoryStore } from '../memory/memory.js'
import {
  MIN_BODY_CHARS,
  type HotTopicSource,
  type TopicCandidate,
  type TopicStrategy,
  type WriteStrategy,
} from './strategy.js'
import { hotSourceRef } from './web-topic.js'
import type { Brief, Draft, ReviewResult } from './types.js'

/** LLM 请求失败（非 2xx/网络错误/超时/响应缺内容）的稳定错误码 */
export const LLM_REQUEST_FAILED = 'LLM_REQUEST_FAILED'

/** OpenAI 兼容对话客户端最小契约（CE-02/CE-03 共用；便于测试注入替身） */
export interface ChatClient {
  complete(system: string, user: string): Promise<string>
}

export interface ChatClientOptions {
  /** 默认 'https://api.deepseek.com'（可指向任意 OpenAI 兼容服务） */
  baseUrl?: string
  /** 默认 'deepseek-chat' */
  model?: string
  /** 请求超时毫秒数，默认 15000（AbortController） */
  timeoutMs?: number
  /** 采样温度，默认 0.7 */
  temperature?: number
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-chat'
const DEFAULT_TIMEOUT_MS = 15_000
const DETAIL_MAX_CHARS = 300

/** 本地日志脱敏：API Key 字面量、sk- 令牌、Bearer 凭证一律打码（RC-04 同思路） */
function redactSecrets(text: string, apiKey: string): string {
  let out = apiKey.length > 0 ? text.split(apiKey).join('***') : text
  out = out.replace(/sk-[A-Za-z0-9]{6,}/g, 'sk-***')
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
  return out
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/**
 * DeepSeek 对话客户端：POST {baseUrl}/chat/completions，
 * Authorization: Bearer <key>，body {model, messages, temperature}，
 * 响应取 choices[0].message.content。非 2xx/网络错误/超时 → OpcError('LLM_REQUEST_FAILED')。
 */
export class DeepSeekChatClient implements ChatClient {
  private readonly baseUrl: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly temperature: number

  constructor(
    private readonly apiKey: string,
    options: ChatClientOptions = {},
  ) {
    if (apiKey.length === 0) throw new OpcError(LLM_REQUEST_FAILED, 'DeepSeekChatClient: apiKey is required')
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.model = options.model ?? DEFAULT_MODEL
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.temperature = options.temperature ?? 0.7
  }

  async complete(system: string, user: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 凭证仅存在于请求头；任何错误路径都不得把它带进 message/日志
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: this.temperature,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const raw = await response.text().catch(() => '')
        throw new OpcError(
          LLM_REQUEST_FAILED,
          redactSecrets(`DeepSeek HTTP ${response.status}: ${raw.slice(0, DETAIL_MAX_CHARS)}`, this.apiKey),
        )
      }
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
      const content = data.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.length === 0) {
        throw new OpcError(LLM_REQUEST_FAILED, 'DeepSeek response missing choices[0].message.content')
      }
      return content
    } catch (err) {
      if (err instanceof OpcError) throw err
      throw new OpcError(
        LLM_REQUEST_FAILED,
        redactSecrets(`DeepSeek request failed (${describeError(err)})`, this.apiKey),
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

/* ─────────────── LLM 输出解析（宽容提取 + 严格契约校验） ─────────────── */

/**
 * 从模型回复中提取第一个 JSON 对象：容忍 ```json 围栏与前后缀说明文字。
 * 找不到或 JSON.parse 失败 → 抛错（由调用方回退模板策略）。
 */
export function extractJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('no JSON object in LLM response')
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>
}

/** 人设记忆摘要（soul/fact/rules/topic → 提示词材料），LLM 策略共用的记忆检索位 */
function personaDigest(memory: MemoryStore, limitPerCategory = 5): string {
  const categories: Array<'soul' | 'fact' | 'rules' | 'topic'> = ['soul', 'fact', 'rules', 'topic']
  return categories
    .flatMap((category) =>
      memory.query({ category, limit: limitPerCategory }).map((e: MemoryEntry) => `- [${category}] ${e.content}`),
    )
    .join('\n')
}

/* ─────────────── CE-03 撰写策略（DeepSeek） ─────────────── */

const WRITER_SYSTEM_PROMPT = `你是一位「一人内容工厂」主理人型的微信公众号写手：理性、务实、每段解决一个具体问题，输出可照做的结论而非空谈。
写作红线（必须遵守）：不使用绝对化用语（最好/第一/绝对等）；不做无出处的收益或效果承诺；不虚构数据来源。
输出要求：只输出一个 JSON 对象，不写代码围栏，不加任何解释：
{"title": "文章标题，不超过 30 字", "body": "正文，至少 300 字，段落间用 \\n 分隔", "tags": ["3-5 个内容标签"]}`

/** 撰写响应契约：{title, body, tags?}（tags 可缺省） */
interface WritePayload {
  title: string
  body: string
  tags?: string[]
}

function parseWritePayload(raw: string): WritePayload {
  const data = extractJson(raw)
  const title = typeof data.title === 'string' ? data.title.trim() : ''
  const body = typeof data.body === 'string' ? data.body.trim() : ''
  if (title.length === 0 || body.length === 0) throw new Error('write JSON missing title/body')
  let tags: string[] | undefined
  if (Array.isArray(data.tags)) {
    const list = data.tags
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim())
    if (list.length > 0) tags = list
  }
  return { title, body, tags }
}

function writeUserPrompt(brief: Brief, persona: string, feedback?: ReviewResult): string {
  const parts = [
    `选题：${brief.title}`,
    `切入角度：${brief.angle}`,
    brief.differentiation?.length ? `差异化维度：\n${brief.differentiation.map((d) => `- ${d}`).join('\n')}` : '',
    persona.length > 0 ? `账号人设记忆（口吻与素材以此为准）：\n${persona}` : '',
    feedback && feedback.violations.length > 0
      ? `改写要求：上一稿未过审（${feedback.violations.map((v) => `${v.type}:${v.detail}`).join('；')}），请逐条规避后重写。`
      : '',
  ]
  return parts.filter((p) => p.length > 0).join('\n\n')
}

/**
 * CE-03 LLM 撰写策略：正文不足 300 字时追加一轮扩写请求（PRD 6.3.4），
 * 仍不达标/解析失败/请求失败 → 回退注入的模板撰写策略（篇幅契约由模板保证）。
 */
export class DeepSeekWriteStrategy implements WriteStrategy {
  /** 最近一次 write 的扩写次数（0/1；回退模板时透传模板统计，供 pipeline 观测） */
  lastExpansions = 0

  constructor(
    private readonly client: ChatClient,
    private readonly fallback: WriteStrategy,
  ) {}

  async write(brief: Brief, memory: MemoryStore, feedback?: ReviewResult): Promise<Draft> {
    try {
      const system = WRITER_SYSTEM_PROMPT
      const user = writeUserPrompt(brief, personaDigest(memory), feedback)
      let payload = parseWritePayload(await this.client.complete(system, user))
      this.lastExpansions = 0
      if (payload.body.length < MIN_BODY_CHARS) {
        this.lastExpansions = 1
        payload = parseWritePayload(
          await this.client.complete(
            system,
            `上一篇初稿正文不足 ${MIN_BODY_CHARS} 字，请围绕同一选题扩写：补充 1 个实操案例与 1 组可复制清单，保持 JSON 输出格式不变。\n\n选题：${brief.title}\n初稿标题：${payload.title}\n初稿正文：\n${payload.body}`,
          ),
        )
      }
      if (payload.body.length < MIN_BODY_CHARS) {
        throw new Error(`LLM body ${payload.body.length} chars, below ${MIN_BODY_CHARS} after expansion`)
      }
      return { title: payload.title, body: payload.body, platform: 'wechat', tags: payload.tags }
    } catch {
      const draft = await this.fallback.write(brief, memory, feedback)
      const fallbackExpansions = (this.fallback as { lastExpansions?: unknown }).lastExpansions
      this.lastExpansions = typeof fallbackExpansions === 'number' ? fallbackExpansions : 0
      return draft
    }
  }
}

/* ─────────────── CE-02 分析策略（DeepSeek：竞品拆解 + 差异化定位） ─────────────── */

/** 差异化维度契约下限：竞品拆解至少给出 3 个对比维度 */
export const MIN_DIFFERENTIATION_DIMENSIONS = 3

const ANALYST_SYSTEM_PROMPT = `你是一位内容策略分析师，负责一人内容工厂的选题分析与差异化定位。
任务：对输入候选选题做竞品拆解视角的评估——同题内容市场上通常怎么写（谁在写、写了什么、漏了什么），再结合账号人设记忆给出差异化切入角度。
输出要求：只输出一个 JSON 对象，不写代码围栏，不加任何解释：
{"angle": "差异化切入角度，具体到可以直接开写", "differentiation": ["维度：本文差异 vs 市场常见做法（至少 3 个维度，如：受众颗粒度/证据形态/行动闭环）"], "personaScore": 4.5}
personaScore 为该选题与本账号人设的相关性评分，0 到 5 的一位小数。`

/** 分析响应契约：{angle, differentiation(≥3), personaScore} */
interface AnalysisPayload {
  angle: string
  differentiation: string[]
  personaScore: number
}

function parseAnalysisPayload(raw: string): AnalysisPayload {
  const data = extractJson(raw)
  const angle = typeof data.angle === 'string' ? data.angle.trim() : ''
  const differentiation = Array.isArray(data.differentiation)
    ? data.differentiation
        .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
        .map((d) => d.trim())
    : []
  const personaScore = Number(data.personaScore)
  if (angle.length === 0 || differentiation.length < MIN_DIFFERENTIATION_DIMENSIONS || !Number.isFinite(personaScore)) {
    throw new Error('analysis JSON violates contract {angle, differentiation>=3, personaScore}')
  }
  return { angle, differentiation, personaScore: Math.round(Math.min(5, Math.max(0, personaScore)) * 10) / 10 }
}

function analysisUserPrompt(candidates: TopicCandidate[], persona: string): string {
  const candidateLines = candidates
    .map((c, index) => `${index + 1}. [${c.source}] ${c.title} —— ${c.angle}（人设分 ${c.personaScore}）`)
    .join('\n')
  return [
    '候选选题（source 标注来源：memory=进行中选题 / builtin=常青库 / hot=实时热点）：',
    candidateLines,
    persona.length > 0 ? `\n账号人设记忆：\n${persona}` : '',
    '\n请按系统指令输出竞品拆解与差异化定位 JSON。',
  ].join('\n')
}

/** 通用回退路径下的最小候选集（fallback 非 TemplateTopicStrategy 时仍可喂给 LLM） */
function memoryCandidates(memory: MemoryStore): TopicCandidate[] {
  return memory.query({ category: 'topic', limit: 5 }).map((t) => ({
    title: t.content,
    angle: `围绕进行中选题「${t.content}」做深度展开`,
    personaScore: Math.round(Math.min(5, 4 + t.confidence) * 10) / 10,
    sources: [`memory://topic/${t.id.slice(0, 8)}`],
    source: 'memory' as const,
  }))
}

/**
 * CE-02 LLM 分析策略：候选（模板/热点）+ 人设记忆 → LLM 竞品拆解与差异化定位
 * → 产出 Brief（angle/differentiation/personaScore，sources 合并热点与 analysis 标注）。
 * 落题取输入候选中人设分最高者（与模板策略同序，保证 CE-01 相关性基线）；
 * 任何失败（请求/解析/契约）→ 回退注入的模板选题策略。
 */
export class DeepSeekAnalysisStrategy implements TopicStrategy {
  constructor(
    private readonly client: ChatClient,
    private readonly fallback: TopicStrategy,
    private readonly options: { topicSource?: HotTopicSource } = {},
  ) {}

  async pick(memory: MemoryStore): Promise<Brief> {
    try {
      const candidates = await this.inputCandidates(memory)
      if (candidates.length === 0) throw new Error('no input candidates for analysis')

      const user = analysisUserPrompt(candidates, personaDigest(memory))
      const parsed = parseAnalysisPayload(await this.client.complete(ANALYST_SYSTEM_PROMPT, user))

      // 落题：输入候选中人设分最高者（稳定排序，同分保持插入序 → 记忆直连优先）
      const chosen = [...candidates].sort((a, b) => b.personaScore - a.personaScore)[0]
      const hotSources = candidates
        .filter((c) => c.source === 'hot')
        .map((c) => c.sources[0])
        .filter((s): s is string => typeof s === 'string')
        .slice(0, 3)

      return {
        title: chosen.title,
        angle: parsed.angle,
        personaScore: parsed.personaScore,
        differentiation: parsed.differentiation,
        sources: [
          ...new Set([
            ...hotSources,
            ...(chosen.sources.length > 0 ? [chosen.sources[0]] : []),
            'analysis://deepseek',
          ]),
        ],
      }
    } catch {
      return this.fallback.pick(memory)
    }
  }

  /** 输入候选：模板策略的候选生成（含热点）优先；通用 fallback 则退化为记忆候选 + 自行并入热点 */
  private async inputCandidates(memory: MemoryStore): Promise<TopicCandidate[]> {
    const fb = this.fallback as {
      generateCandidatesWithHot?: (m: MemoryStore) => Promise<TopicCandidate[]>
      generateCandidates?: (m: MemoryStore) => TopicCandidate[]
    }
    if (typeof fb.generateCandidatesWithHot === 'function') {
      return fb.generateCandidatesWithHot(memory)
    }
    const candidates: TopicCandidate[] =
      typeof fb.generateCandidates === 'function' ? fb.generateCandidates(memory) : memoryCandidates(memory)
    const topicSource = this.options.topicSource
    if (topicSource) {
      try {
        const hot = await topicSource.hotTopics(memory.query({ category: 'topic', limit: 3 }).map((t) => t.content))
        for (const title of hot) {
          if (candidates.some((c) => c.title === title)) continue
          candidates.push({
            title,
            angle: `借势热点「${title}」，结合账号人设给出竞品拆解与差异化落点`,
            personaScore: 3,
            sources: [hotSourceRef(title)],
            source: 'hot',
          })
        }
      } catch {
        // 热点源违约抛错也不阻塞选题（与 WebSearchTopicSource 降级契约一致）
      }
    }
    return candidates
  }
}
