import test from 'node:test'
import assert from 'node:assert/strict'
import { planMvp, suggestGoNoGo, type MvpValidation } from './planner.js'
import type { ThreeDomains } from '../idea/types.js'

const DOMAINS: ThreeDomains = {
  problem: { summary: '独立开发者获客难，缺低价落地页工具', points: ['外包太贵', '建站工具学习成本高'] },
  solution: { summary: 'AI 落地页生成器，对话式配置直接上线', points: ['5 分钟生成落地页', '自带 SEO 检查'] },
  spacetime: { summary: '面向出海跨境电商市场', points: ['AI 流量红利期'] },
}

test('planMvp: 功能清单取解决域要点，技术栈按关键词命中（IP-01）', () => {
  const plan = planMvp('idea-1', DOMAINS)
  assert.deepEqual(plan.features, ['5 分钟生成落地页', '自带 SEO 检查'])
  assert.ok(plan.techStack.includes('静态站点生成 + 表单收集'), '落地页关键词应命中技术栈')
  assert.ok(plan.techStack.some((s) => s.includes('DeepSeek')), 'AI 关键词应命中 DeepSeek 建议')
  assert.equal(plan.milestones.length, 3, '开发计划三段式')
  assert.equal(plan.strategy, 'template')
})

test('planMvp: 解决域无要点时给三件套兜底；无关键词命中给通用技术栈', () => {
  const bare: ThreeDomains = {
    problem: { summary: '一个问题', points: [] },
    solution: { summary: '', points: [] },
    spacetime: { summary: '', points: [] },
  }
  const plan = planMvp('idea-2', bare)
  assert.equal(plan.features.length, 3)
  assert.deepEqual(plan.techStack, ['单服务 + SQLite 起步（能跑通再扩）'])
})

test('suggestGoNoGo: 无记录 / 记录不足 / 评分不足 / 达标四态（IP-04）', () => {
  assert.equal(suggestGoNoGo([]).suggestion, 'no-go')

  const one = (score: number): MvpValidation[] =>
    [{ kind: 'mvp-validation', source: 'feedback', score, content: 'x', at: 1 }]

  // 1 条高分：记录不足 → no-go 但理由明确
  const fewGood = suggestGoNoGo(one(4.5))
  assert.equal(fewGood.suggestion, 'no-go')
  assert.ok(fewGood.reasons[0]?.includes('<2'))

  // 2 条低分：评分不足 → no-go
  const low = suggestGoNoGo([...one(2), ...one(3)])
  assert.equal(low.suggestion, 'no-go')
  assert.ok(low.reasons.some((r) => r.includes('3.5')))

  // 2 条 ≥3.5：go
  const go = suggestGoNoGo([...one(4), ...one(4.5), ...one(3.8)])
  assert.equal(go.suggestion, 'go')
  assert.equal(go.validations, 3)

  // score 缺省按 3 计入
  const defaults = suggestGoNoGo([
    { kind: 'mvp-validation', source: 'metric', content: 'a', at: 1 },
    { kind: 'mvp-validation', source: 'metric', content: 'b', at: 2 },
  ])
  assert.equal(defaults.suggestion, 'no-go', '缺省分 3 < 3.5 → no-go')
})
