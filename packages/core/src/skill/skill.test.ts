import test from 'node:test'
import assert from 'node:assert/strict'
import { PatternMiner, type ToolObservation } from './pattern-miner.js'
import { SkillDistiller, DistillQualityError } from './distiller.js'

function ob(taskSignature: string, tools: string[], success = true, timestamp = 1): ToolObservation {
  return { taskSignature, tools, success, timestamp }
}

test('skill: 重复≥3 且成功率达标 → high 并可蒸馏 (AC-01)', () => {
  const miner = new PatternMiner()
  const observations = [
    ob('contract-review', ['pdf_reader', 'clause_extractor', 'risk_scorer']),
    ob('contract-review', ['pdf_reader', 'clause_extractor', 'risk_scorer']),
    ob('contract-review', ['pdf_reader', 'clause_extractor', 'risk_scorer']),
    ob('content-adapt', ['reader', 'rewriter'], false),
    ob('content-adapt', ['reader', 'rewriter']),
    ob('content-adapt', ['reader', 'rewriter'], false),
  ]
  const patterns = miner.mine(observations)
  const high = patterns.find((p) => p.taskSignature === 'contract-review')
  assert.ok(high)
  assert.equal(high.confidence, 'high')
  // low 置信度模式（成功率不达标）保留但不蒸馏
  const low = patterns.find((p) => p.taskSignature === 'content-adapt')
  assert.ok(low && low.confidence === 'low')

  const skill = new SkillDistiller().distill(high)
  assert.equal(skill.skillDefinition.toolSequence.length, 3)
  assert.ok(skill.memorySnapshot.some((m) => m.layer === 'lesson'))
})

test('skill: 蒸馏产物结构符合 PRD 6.1.2', () => {
  const pattern = new PatternMiner().mine([
    ob('site-deploy', ['scaffold', 'build', 'publish']),
    ob('site-deploy', ['scaffold', 'build', 'publish']),
    ob('site-deploy', ['scaffold', 'build', 'publish']),
  ])[0]
  const skill = new SkillDistiller().distill(pattern)
  assert.ok(skill.name.startsWith('skill-site-deploy'))
  assert.match(skill.version, /^\d+\.\d+\.\d+$/)
  assert.ok(skill.skillDefinition.trigger && skill.skillDefinition.postConditions)
})

test('skill: 重复不足 3 次不产生模式', () => {
  const patterns = new PatternMiner().mine([
    ob('one-off', ['a']),
    ob('one-off', ['a']),
  ])
  assert.equal(patterns.length, 0)
})

test('skill: 低置信度模式蒸馏被质量门控拦截 (PRD 6.1.3)', () => {
  const patterns = new PatternMiner().mine([
    ob('flaky', ['x'], false),
    ob('flaky', ['x'], false),
    ob('flaky', ['x']),
  ])
  assert.equal(patterns[0].confidence, 'low')
  assert.throws(() => new SkillDistiller().distill(patterns[0]), DistillQualityError)
})

test('skill: 多签名批量用例下识别准确 (AC-01 自动化≥20条)', () => {
  const miner = new PatternMiner()
  const signatures = ['sig-a', 'sig-b', 'sig-c', 'sig-d', 'sig-e']
  const observations: ToolObservation[] = []
  let caseCount = 0
  for (const sig of signatures) {
    for (let i = 0; i < 4; i++) {
      observations.push(ob(sig, ['t1', 't2', 't3']))
      caseCount++
    }
    for (let i = 0; i < 2; i++) observations.push(ob(`${sig}-noise`, ['n1']))
  }
  assert.ok(caseCount >= 20)
  const patterns = miner.mine(observations)
  assert.equal(patterns.filter((p) => p.confidence === 'high').length, 5)
  for (const p of patterns.filter((p) => p.confidence === 'high')) {
    assert.equal(p.repetitions, 4)
    assert.equal(p.successRate, 1)
  }
})
