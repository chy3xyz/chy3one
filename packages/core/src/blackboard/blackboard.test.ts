import test from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryBlackboard } from './blackboard.js'
import { PermissionError } from '../errors.js'

test('blackboard: global 仅 orchestrator 可写', () => {
  const bb = new InMemoryBlackboard()
  assert.throws(
    () => bb.write({ scope: 'global', key: 'rules', value: 'v', writer: 'agent-a', role: 'agent', expectedVersion: 0 }),
    PermissionError,
  )
  const r = bb.write({ scope: 'global', key: 'rules', value: 'v', writer: 'orch', role: 'orchestrator', expectedVersion: 0 })
  assert.equal(r.status, 'ok')
})

test('blackboard: workflow scope agent 可写且乐观锁正常升级版本', () => {
  const bb = new InMemoryBlackboard()
  bb.write({ scope: 'workflow', key: 'site-copy', value: 'draft1', writer: 'a', role: 'agent', expectedVersion: 0 })
  const r = bb.write({ scope: 'workflow', key: 'site-copy', value: 'draft2', writer: 'a', role: 'agent', expectedVersion: 1 })
  assert.equal(r.status, 'ok')
  assert.equal(r.status === 'ok' && r.entry.version, 2)
})

test('blackboard: 版本冲突按置信度仲裁 (AR-P04)', () => {
  let clock = 1000
  const bb = new InMemoryBlackboard(() => clock)
  bb.write({ scope: 'workflow', key: 'k', value: 'base', writer: 'a', role: 'agent', expectedVersion: 0, confidence: 0.5 })
  // 过期版本写入：低置信度 → 冲突被拒绝
  const low = bb.write({ scope: 'workflow', key: 'k', value: 'low', writer: 'b', role: 'agent', expectedVersion: 0, confidence: 0.3 })
  assert.equal(low.status, 'conflict')
  // 过期版本写入：高置信度 → 接管成功
  clock += 10
  const high = bb.write({ scope: 'workflow', key: 'k', value: 'high', writer: 'c', role: 'agent', expectedVersion: 0, confidence: 0.9 })
  assert.equal(high.status, 'ok')
  assert.equal(bb.read('workflow', 'k')[0].value, 'high')
})

test('blackboard: 并发 5 写者无数据丢失 (AC-03)', () => {
  const bb = new InMemoryBlackboard()
  const writers = ['a', 'b', 'c', 'd', 'e'].map((w, i) =>
    bb.write({ scope: 'workflow', key: `task-${i}`, value: { from: w }, writer: w, role: 'agent', expectedVersion: 0 }),
  )
  assert.equal(writers.filter((r) => r.status === 'ok').length, 5)
  assert.equal(bb.read('workflow').length, 5)
})
