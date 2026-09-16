import test from 'node:test'
import assert from 'node:assert/strict'
import { TemplateTopicStrategy } from './strategy.js'
import { buildSchemaJsonLd, checkEeat, eeatPenalty, isStructuredTopic, withEeat } from './geo.js'
import type { Brief, Draft, ReviewResult } from './types.js'

const DRAFT_RICH: Draft = {
  title: 'AI 建站工具横向对比：实测三款产品的真实数据',
  body: '本文基于实测复盘：上手机器、参数对比、方法论拆解；数据截至 2026-09，来源见文末参考文献；勘误通道见评论区。',
  platform: 'wechat',
}

const DRAFT_BARE: Draft = {
  title: '一款新工具',
  body: '很好用，推荐大家试试。',
  platform: 'wechat',
}

test('geo: E-E-A-T 四维检查（prd2.md 4.3 策略一）', () => {
  const rich = checkEeat(DRAFT_RICH)
  const bare = checkEeat(DRAFT_BARE)
  assert.equal(rich.filter((c) => c.present).length, 4, '要素齐全 → 四维全过')
  assert.equal(bare.filter((c) => !c.present).length >= 3, true, '要素缺失 → 至少三维未达标且带补强建议')
  assert.ok(bare.every((c) => c.present || c.hint.length > 0))
  assert.ok(eeatPenalty(rich) === 0)
  assert.ok(eeatPenalty(bare) >= 15)
})

test('geo: withEeat 扣分不改 pass 语义（advisory）', () => {
  const base: ReviewResult = { pass: true, violations: [], score: 100 }
  const merged = withEeat(base, checkEeat(DRAFT_BARE))
  assert.equal(merged.pass, true, 'E-E-A-T 缺失不阻塞过审')
  assert.ok(merged.score < 100)
  assert.equal(merged.eeat?.length, 4)
})

test('geo: Schema JSON-LD 生成（prd2.md 4.3 策略三）', () => {
  const brief: Brief = { title: DRAFT_RICH.title, angle: '选购指南与实测对比', personaScore: 4.5, sources: ['memory://x'] }
  const json = buildSchemaJsonLd(DRAFT_RICH, brief)
  const parsed = JSON.parse(json) as { '@type': string; headline: string; datePublished: string }
  assert.equal(parsed['@type'], 'Article')
  assert.equal(parsed.headline, DRAFT_RICH.title)
  assert.ok(parsed.datePublished.includes('T'))
})

test('geo: 结构化选题识别与加权（prd2.md 4.3 策略二）', async () => {
  assert.equal(isStructuredTopic({ title: 'AI 建站工具选购指南', angle: 'x' }), true)
  assert.equal(isStructuredTopic({ title: '宠物经济观察', angle: 'y' }), false)

  // TemplateTopicStrategy：常青库里的结构化选题（复盘/拆解/边界词）应比非结构化同分候选更靠前
  const strategy = new TemplateTopicStrategy()
  const candidates = strategy.generateCandidates({
    query: () => [],
    write: () => {
      throw new Error('not used')
    },
  } as never)
  assert.ok(candidates.length >= 5)
  const structured = candidates.filter((c) => isStructuredTopic(c))
  const plain = candidates.filter((c) => !isStructuredTopic(c))
  if (structured.length > 0 && plain.length > 0) {
    const bestStructured = Math.max(...structured.map((c) => c.personaScore))
    const sameSourcePlain = plain.filter((c) => c.source === 'builtin')
    const bestPlain = Math.max(...sameSourcePlain.map((c) => c.personaScore))
    assert.ok(bestStructured >= bestPlain, '同来源下结构化选题分数不低于普通选题')
  }
})
