import test from 'node:test'
import assert from 'node:assert/strict'
import { draftThreeDomains, deriveIdeaName } from './three-domains.js'

test('three-domains: 线索词分桶（ID-01 草案）', () => {
  const draft = draftThreeDomains(
    '小团队周报太花时间。我们打算做一个AI周报生成器，通过接入仓库提交记录自动成稿。适合国内互联网公司，政策上无合规风险。',
  )
  assert.ok(draft.problem.summary.includes('周报太花时间'))
  assert.ok(draft.solution.summary.includes('AI周报生成器'))
  assert.ok(draft.spacetime.summary.includes('国内互联网公司'))
})

test('three-domains: 首句恒为问题陈述；时空线索优先于解决线索', () => {
  const draft = draftThreeDomains('跨境电商卖家缺选品数据。做一个选品工具。面向出海市场。')
  assert.ok(draft.problem.summary.includes('缺选品数据'))
  // "面向出海市场"同时命中 时空(面向/出海) 与 无解决线索 → spacetime
  assert.ok(draft.spacetime.summary.includes('面向出海市场'))
})

test('three-domains: 无可归类句子时全文兜底进问题域', () => {
  const draft = draftThreeDomains('一句话创意，没有任何线索词')
  assert.ok(draft.problem.summary.length > 0)
  assert.equal(draft.solution.summary, '')
  assert.equal(draft.spacetime.summary, '')
})

test('three-domains: 超长摘要截断（草案上限 400）', () => {
  const draft = draftThreeDomains('长'.repeat(1000))
  assert.ok(draft.problem.summary.length <= 401 + 1) // 400 + 省略号
})

test('deriveIdeaName: 前 16 字符截断', () => {
  assert.equal(deriveIdeaName('短的创意名'), '短的创意名')
  const long = deriveIdeaName('这是一个特别特别特别长的创意描述需要被截断处理才行')
  assert.equal(long.length, 17) // 16 + …
  assert.ok(long.endsWith('…'))
})
