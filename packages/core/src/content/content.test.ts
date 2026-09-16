/**
 * Content Engine MVP 流水线测试（PRD 6.3 / CE-01/03/04/05）：
 * happy path、违规重写、过短扩写、记忆影响选题、规则审核。
 * 纯内存运行（不传文件路径），无落盘副作用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { OpcError } from '../errors.js'
import { JsonlMemoryStore } from '../memory/memory.js'
import { ContentPipeline, CONTENT_REVIEW_REJECTED, type ContentTelemetry } from './pipeline.js'
import {
  MockWechatAdapter,
  RuleReviewStrategy,
  TemplateTopicStrategy,
  TemplateWriteStrategy,
  type ReviewStrategy,
  type WriteStrategy,
} from './strategy.js'
import type { Brief, ReviewResult } from './types.js'

/** 测试用埋点收集器：实现 ContentTelemetry 结构契约（不依赖 dsh-adapter） */
function collectTelemetry() {
  const events: Array<{ type: string; payload?: Record<string, unknown>; timestamp: number }> = []
  const bus: ContentTelemetry = {
    emit(event) {
      events.push(event)
    },
  }
  return { events, bus }
}

test('pipeline: happy path — 候选≥5、发布成功、content_publish 埋点、fact 记忆落库 (CE-01/03/05)', async () => {
  const memory = new JsonlMemoryStore()
  memory.write({ scope: 'global', category: 'soul', content: '理性务实的独立开发者人设', confidence: 0.95 })
  const { events, bus } = collectTelemetry()
  const pipeline = new ContentPipeline({ memory, telemetry: bus })

  // CE-01：候选选题 ≥5
  const candidates = new TemplateTopicStrategy().generateCandidates(memory)
  assert.ok(candidates.length >= 5, `候选选题应 ≥5，实际 ${candidates.length}`)

  const result = await pipeline.run()

  // 撰写：扩写后正文达标，平台适配为公众号形态
  assert.equal(result.draft.platform, 'wechat')
  assert.ok(result.draft.body.length >= 300, '正文应达到 300 字下限')
  assert.equal(result.rewrites, 0)
  assert.ok(result.content.htmlBody.includes('<p>'))
  assert.deepEqual(result.content.tags, ['wechat', result.draft.title.slice(0, 8), result.brief.angle.slice(0, 8)])

  // CE-05：mock 公众号链路
  assert.equal(result.publish.success, true)
  assert.match(result.publish.url, /^https:\/\/mp\.weixin\.qq\.com\/s\/[0-9a-f-]{36}$/)
  assert.equal(result.success, true)

  // PRD 7.5 content_publish 埋点
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'content_publish')
  assert.equal(events[0].payload?.platform, 'wechat')
  assert.equal(events[0].payload?.title, result.draft.title)
  assert.equal(events[0].payload?.content_type, 'article')
  assert.equal(typeof events[0].payload?.durationMs, 'number')
  assert.ok(events[0].payload && (events[0].payload.durationMs as number) >= 0)

  // fact 记忆：发布成功特征落库
  const facts = memory.query({ category: 'fact' })
  assert.equal(facts.length, 1)
  assert.ok(facts[0].content.includes(result.draft.title))
  // 审核分（100 - E-E-A-T advisory 扣分，prd2.md 4.3）→ 置信度 min(1, score/100)
  assert.equal(facts[0].confidence, Math.min(1, result.review.score / 100))
  assert.ok(Array.isArray(result.review.eeat) && result.review.eeat.length === 4)
})

test('pipeline: 审核不通过 — 带 violations 重写 2 轮后抛 CONTENT_REVIEW_REJECTED 且 lesson 落库 (CE-04)', async () => {
  const memory = new JsonlMemoryStore()
  const { bus } = collectTelemetry()
  const pipeline = new ContentPipeline({ memory, telemetry: bus })

  // 注入必拒审核策略（真实场景：违规内容多轮重写仍不合规）
  const alwaysViolating: ReviewStrategy = {
    review: async () => ({
      pass: false,
      score: 20,
      violations: [{ type: 'banned-word', severity: 'high', detail: '命中禁词（模拟）' }],
    }),
  }
  // 计数撰写调用：初稿 + 2 轮重写 = 3 次，且重写轮携带上轮 feedback
  const base = new TemplateWriteStrategy()
  const writeCalls: Array<{ hasFeedback: boolean }> = []
  const countingWrite: WriteStrategy = {
    write: async (brief, mem, feedback) => {
      writeCalls.push({ hasFeedback: feedback !== undefined })
      return base.write(brief, mem, feedback)
    },
  }
  pipeline.setStrategies({ reviewStrategy: alwaysViolating, writeStrategy: countingWrite })

  await assert.rejects(
    () => pipeline.run(),
    (err: unknown) =>
      err instanceof OpcError && err.code === CONTENT_REVIEW_REJECTED && err.message.includes('重写 2 轮'),
  )

  assert.equal(writeCalls.length, 3)
  assert.equal(writeCalls[0].hasFeedback, false)
  assert.equal(writeCalls[1].hasFeedback, true)
  assert.equal(writeCalls[2].hasFeedback, true)

  // lesson：被拒原因落库，埋点与发布不发生
  const lessons = memory.query({ category: 'lesson' })
  assert.equal(lessons.length, 1)
  assert.ok(lessons[0].content.includes('审核驳回'))
  assert.ok(lessons[0].content.includes('banned-word'))
  assert.equal(memory.query({ category: 'fact' }).length, 0)
})

test('write: 短文触发一次扩写即达标（过短扩写，最多 2 轮）', async () => {
  const strategy = new TemplateWriteStrategy()
  const brief: Brief = { title: '测试选题', angle: '测试角度', personaScore: 4.5, sources: ['test'] }
  const draft = await strategy.write(brief, new JsonlMemoryStore())

  // 模板初稿 < 300 字 → 触发扩写；单轮扩写后达标 → 恰好 1 轮
  assert.ok(draft.body.length >= 300, `扩写后应 ≥300 字，实际 ${draft.body.length}`)
  assert.ok(draft.body.includes('【补充 1】'))
  assert.equal(strategy.lastExpansions, 1)
})

test('topic: 记忆检索影响选题 — 预写 topic 记忆后候选包含之且 personaScore ≥4 (CE-01/CE-07)', async () => {
  const memory = new JsonlMemoryStore()
  memory.write({ scope: 'global', category: 'topic', content: '跨境电商独立站SEO实战', confidence: 0.8 })

  const strategy = new TemplateTopicStrategy()
  const candidates = strategy.generateCandidates(memory)
  assert.ok(candidates.length >= 5)

  const hit = candidates.find((c) => c.angle.includes('跨境电商独立站SEO实战'))
  assert.ok(hit, '候选角度应包含预写的 topic 记忆')
  assert.equal(hit!.title, '跨境电商独立站SEO实战')
  assert.ok(hit!.personaScore >= 4, `记忆直连选题相关性应 ≥4/5，实际 ${hit!.personaScore}`)
  assert.ok(hit!.sources[0].startsWith('memory://topic/'))

  // pick 取 personaScore 最高：无其他人设记忆时，记忆直连候选（4.8）压过常青库（3.0）
  const best = await strategy.pick(memory)
  assert.equal(best.angle, hit!.angle)
})

test('review: 规则审核检出禁词、绝对化用语与未证实断言 (CE-04)', async () => {
  const review = new RuleReviewStrategy()
  const result = await review.review({
    title: '最好的赚钱项目',
    body: '这个项目稳赚不赔，全网最低价格，月入十万不是梦。',
    platform: 'wechat',
  })
  assert.equal(result.pass, false)
  // 最好（标题）+ 全网最低 → 绝对化用语；稳赚 + 月入十万 → 未证实断言
  const types = result.violations.map((v) => v.type).sort()
  assert.deepEqual(types, ['absolute-claim', 'absolute-claim', 'unverified-claim', 'unverified-claim'])
  assert.equal(result.score, 0) // 2×high + 2×medium 全扣
  assert.ok(result.violations.some((v) => v.detail.includes('稳赚')))

  // 干净内容一次过审（pipeline happy path 依赖此行为）
  const clean = await review.review({ title: '干净标题', body: '正常正文，无可证伪风险表述。', platform: 'wechat' })
  assert.equal(clean.pass, true)
  assert.deepEqual(clean.violations, [])
  assert.equal(clean.score, 100)
})

test('pipeline: setStrategies 可替换分发适配器，publish 失败按 PRD 指数退避重试 3 次', async () => {
  const memory = new JsonlMemoryStore()
  const pipeline = new ContentPipeline({ memory })

  let attempts = 0
  pipeline.setStrategies({
    publishAdapter: {
      platform: 'wechat',
      publish: async (content) => {
        attempts++
        void content
        return attempts < 3
          ? { platform: 'wechat', url: '', publishedAt: 0, success: false }
          : new MockWechatAdapter().publish(content)
      },
    },
  })

  const result = await pipeline.run()
  assert.equal(attempts, 3)
  assert.equal(result.success, true)
  assert.match(result.publish.url, /^https:\/\/mp\.weixin\.qq\.com\//)
})

/** 类型面冒烟：ReviewResult 形状契约（违规条目 type/severity/detail） */
test('types: ReviewResult 契约形状', async () => {
  const review: ReviewResult = {
    pass: false,
    violations: [{ type: 'banned-word', severity: 'high', detail: 'x' }],
    score: 60,
  }
  assert.equal(review.violations[0].severity, 'high')
})
