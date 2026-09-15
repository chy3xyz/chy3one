/**
 * Content Engine 流水线编排（PRD 6.3.2：选题 → 撰写 → 审核 → 分发，MVP 单平台公众号）。
 *
 * - 审核不通过 → 携带 violations 重写，最多 2 轮，仍不过抛 OpcError('CONTENT_REVIEW_REJECTED')
 * - 发布成功写 fact 记忆（爆款特征）、被拒写 lesson 记忆（失败教训）——七类人设记忆表更新触发条件
 * - 每次发布经 TelemetryBus 发 'content_publish' 埋点（PRD 7.5：platform, content_type, duration）
 * - run 结果可选追加落盘到注入的 runsFile（JSONL）
 *
 * 零外部运行时依赖：Telemetry 以结构化最小契约注入（与 dsh-adapter TelemetryBus 结构兼容，
 * core 不反向依赖 adapter）。
 */
import { appendFileSync } from 'node:fs'
import { OpcError } from '../errors.js'
import type { MemoryStore } from '../memory/memory.js'
import {
  MockWechatAdapter,
  RuleReviewStrategy,
  TemplateTopicStrategy,
  TemplateWriteStrategy,
  type PublishAdapter,
  type ReviewStrategy,
  type TopicStrategy,
  type WriteStrategy,
} from './strategy.js'
import type { Brief, Draft, PlatformContent, PublishResult, ReviewResult } from './types.js'

/** 埋点最小契约（结构兼容 dsh-adapter 的 TelemetryBus.emit） */
export interface ContentTelemetry {
  emit(event: { type: string; payload?: Record<string, unknown>; timestamp: number }): void
}

/** 审核重写上限（PRD 6.3.4：检出违规自动触发重写，最多 2 轮） */
export const MAX_REWRITE_ROUNDS = 2

/** 审核多轮重写仍不通过的稳定错误码 */
export const CONTENT_REVIEW_REJECTED = 'CONTENT_REVIEW_REJECTED'

/** 分发限流重试上限（PRD 6.3.4：指数退避重试，最多 3 次） */
export const MAX_PUBLISH_ATTEMPTS = 3

/** 单次 run 的全链路结果 */
export interface PipelineRunResult {
  brief: Brief
  draft: Draft
  review: ReviewResult
  content: PlatformContent
  publish: PublishResult
  /** 触发的重写轮数（0 = 初稿一次过审） */
  rewrites: number
  /** 撰写阶段触发的扩写次数（透传策略统计，非模板策略为 0） */
  expansions: number
  durationMs: number
  /** 全链路成功 = 已过审且发布成功 */
  success: boolean
}

export interface ContentPipelineOptions {
  /** 七类人设记忆（soul/user/project/fact/lesson/topic/rules），直接复用 MemoryStore */
  memory: MemoryStore
  /** 'content_publish' 埋点出口（PRD 7.5） */
  telemetry?: ContentTelemetry
  /** 可选：每次 run 结果追加落盘（JSONL，一行一条） */
  runsFile?: string
  topicStrategy?: TopicStrategy
  writeStrategy?: WriteStrategy
  reviewStrategy?: ReviewStrategy
  publishAdapter?: PublishAdapter
}

/** 策略替换口（真实 LLM 注入位），全部可独立覆盖 */
export interface StrategyOverrides {
  topicStrategy?: TopicStrategy
  writeStrategy?: WriteStrategy
  reviewStrategy?: ReviewStrategy
  publishAdapter?: PublishAdapter
}

/** 草稿 → 平台适配产物：正文分段包 <p>，标签取标题/角度截断 + 平台名 */
export function toPlatformContent(draft: Draft, brief: Brief): PlatformContent {
  const htmlBody = draft.body
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${p}</p>`)
    .join('')
  const tags = [...new Set([draft.platform, brief.title.slice(0, 8), brief.angle.slice(0, 8)])]
  return { platform: draft.platform, title: draft.title, htmlBody, tags }
}

/** 模板策略携带扩写统计；其他实现按 0 处理（鸭子类型探测，不强制接口耦合） */
function expansionsOf(strategy: WriteStrategy): number {
  const value = (strategy as { lastExpansions?: unknown }).lastExpansions
  return typeof value === 'number' ? value : 0
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class ContentPipeline {
  private topicStrategy: TopicStrategy
  private writeStrategy: WriteStrategy
  private reviewStrategy: ReviewStrategy
  private publishAdapter: PublishAdapter

  constructor(private readonly options: ContentPipelineOptions) {
    this.topicStrategy = options.topicStrategy ?? new TemplateTopicStrategy()
    this.writeStrategy = options.writeStrategy ?? new TemplateWriteStrategy()
    this.reviewStrategy = options.reviewStrategy ?? new RuleReviewStrategy()
    this.publishAdapter = options.publishAdapter ?? new MockWechatAdapter()
  }

  /** 运行期替换策略（插件层 'opc.content' 服务的注入口） */
  setStrategies(overrides: StrategyOverrides): void {
    if (overrides.topicStrategy) this.topicStrategy = overrides.topicStrategy
    if (overrides.writeStrategy) this.writeStrategy = overrides.writeStrategy
    if (overrides.reviewStrategy) this.reviewStrategy = overrides.reviewStrategy
    if (overrides.publishAdapter) this.publishAdapter = overrides.publishAdapter
  }

  /** 选题 → 撰写 → 审核（重写≤2轮）→ 分发 → 记忆沉淀 → 埋点 → 落盘 */
  async run(): Promise<PipelineRunResult> {
    const startedAt = Date.now()
    const memory = this.options.memory

    // CE-01 选题
    const brief = await this.topicStrategy.pick(memory)

    // CE-03 撰写 + CE-04 审核（检出违规 → 带 violations 重写，最多 2 轮）
    let draft = await this.writeStrategy.write(brief, memory)
    let review = await this.reviewStrategy.review(draft)
    let rewrites = 0
    while (!review.pass && rewrites < MAX_REWRITE_ROUNDS) {
      rewrites++
      draft = await this.writeStrategy.write(brief, memory, review)
      review = await this.reviewStrategy.review(draft)
    }
    if (!review.pass) {
      // lesson：失败教训落库（记忆表更新触发条件：被拒原因）
      memory.write({
        scope: 'global',
        category: 'lesson',
        content: `审核驳回: ${draft.title} | 违规: ${review.violations.map((v) => `${v.type}:${v.detail}`).join('; ')} | 重写 ${rewrites} 轮仍未过`,
        confidence: 0.8,
      })
      const summary = review.violations.map((v) => v.type).join(',')
      throw new OpcError(
        CONTENT_REVIEW_REJECTED,
        `内容审核未通过（重写 ${rewrites} 轮）: ${summary}`,
      )
    }

    // CE-05 适配 + 分发（限流指数退避，最多 3 次尝试）
    const content = toPlatformContent(draft, brief)
    const publish = await this.publishWithRetry(content)

    // fact：发布成功特征落库（记忆表更新触发条件：每次内容发布后）
    memory.write({
      scope: 'global',
      category: 'fact',
      content: `发布成功: ${draft.title} | 角度: ${brief.angle} | 人设分: ${brief.personaScore} | 审核分: ${review.score} | ${publish.url}`,
      confidence: Math.min(1, review.score / 100),
    })

    const result: PipelineRunResult = {
      brief,
      draft,
      review,
      content,
      publish,
      rewrites,
      expansions: expansionsOf(this.writeStrategy),
      durationMs: Date.now() - startedAt,
      success: publish.success,
    }

    // PRD 7.5 content_publish：platform, content_type, duration（+title 便于归因）
    this.options.telemetry?.emit({
      type: 'content_publish',
      payload: {
        platform: publish.platform,
        title: draft.title,
        content_type: 'article',
        durationMs: result.durationMs,
      },
      timestamp: Date.now(),
    })

    this.appendRun(result)
    return result
  }

  /** PRD 6.3.4：分发平台 API 限流 → 指数退避重试，最多 3 次尝试 */
  private async publishWithRetry(content: PlatformContent): Promise<PublishResult> {
    let last: PublishResult | undefined
    for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt++) {
      last = await this.publishAdapter.publish(content)
      if (last.success) return last
      if (attempt < MAX_PUBLISH_ATTEMPTS) await sleep(25 * 2 ** (attempt - 1))
    }
    return last as PublishResult
  }

  private appendRun(result: PipelineRunResult): void {
    if (!this.options.runsFile) return
    appendFileSync(this.options.runsFile, JSON.stringify({ ...result, ranAt: Date.now() }) + '\n')
  }
}
