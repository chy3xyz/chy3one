import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteBlackboard } from './sqlite-blackboard.js'
import { PermissionError } from '../errors.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-sqlite-blackboard-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('sqlite blackboard: global 仅 orchestrator 可写', () => {
  const bb = new SqliteBlackboard(join(dir, 'perm.db'))
  assert.throws(
    () => bb.write({ scope: 'global', key: 'rules', value: 'v', writer: 'agent-a', role: 'agent', expectedVersion: 0 }),
    PermissionError,
  )
  const r = bb.write({ scope: 'global', key: 'rules', value: 'v', writer: 'orch', role: 'orchestrator', expectedVersion: 0 })
  assert.equal(r.status, 'ok')
  bb.close()
})

test('sqlite blackboard: workflow scope agent 可写且乐观锁正常升级版本', () => {
  const bb = new SqliteBlackboard(join(dir, 'cas.db'))
  bb.write({ scope: 'workflow', key: 'site-copy', value: 'draft1', writer: 'a', role: 'agent', expectedVersion: 0 })
  const r = bb.write({ scope: 'workflow', key: 'site-copy', value: 'draft2', writer: 'a', role: 'agent', expectedVersion: 1 })
  assert.equal(r.status, 'ok')
  assert.equal(r.status === 'ok' && r.entry.version, 2)
  bb.close()
})

test('sqlite blackboard: 版本冲突按置信度仲裁 (AR-P04)', () => {
  let clock = 1000
  const bb = new SqliteBlackboard(join(dir, 'arb.db'), () => clock)
  bb.write({ scope: 'workflow', key: 'k', value: 'base', writer: 'a', role: 'agent', expectedVersion: 0, confidence: 0.5 })
  // 过期版本写入：低置信度 → 冲突被拒绝，现任保留
  const low = bb.write({ scope: 'workflow', key: 'k', value: 'low', writer: 'b', role: 'agent', expectedVersion: 0, confidence: 0.3 })
  assert.equal(low.status, 'conflict')
  if (low.status === 'conflict') {
    assert.equal(low.resolvedBy, 'timestamp+confidence')
    assert.equal(low.winner.value, 'base')
    assert.equal(low.winner.version, 1)
  }
  // 过期版本写入：高置信度 → 接管成功
  clock += 10
  const high = bb.write({ scope: 'workflow', key: 'k', value: 'high', writer: 'c', role: 'agent', expectedVersion: 0, confidence: 0.9 })
  assert.equal(high.status, 'ok')
  assert.equal(high.status === 'ok' && high.entry.version, 2)
  assert.equal(bb.read('workflow', 'k')[0].value, 'high')
  bb.close()
})

test('sqlite blackboard: 并发 5 写者无数据丢失 (AC-03)', () => {
  const bb = new SqliteBlackboard(join(dir, 'conc.db'))
  const writers = ['a', 'b', 'c', 'd', 'e'].map((w, i) =>
    bb.write({ scope: 'workflow', key: `task-${i}`, value: { from: w }, writer: w, role: 'agent', expectedVersion: 0 }),
  )
  assert.equal(writers.filter((r) => r.status === 'ok').length, 5)
  assert.equal(bb.read('workflow').length, 5)
  // 对象 value 经 JSON 序列化往返后保持等值
  assert.deepEqual(bb.read('workflow', 'task-2')[0].value, { from: 'c' })
  bb.close()
})

test('sqlite blackboard: 重启恢复后版本号延续（(scope,key,version) 版本链）', () => {
  const path = join(dir, 'restart.db')
  let clock = 5_000
  const first = new SqliteBlackboard(path, () => clock)
  first.write({ scope: 'workflow', key: 'plan', value: 'v1', writer: 'a', role: 'agent', expectedVersion: 0, confidence: 0.5 })
  clock += 1
  first.write({ scope: 'workflow', key: 'plan', value: 'v2', writer: 'a', role: 'agent', expectedVersion: 1, confidence: 0.6 })
  clock += 1
  const r3 = first.write({ scope: 'workflow', key: 'plan', value: 'v3', writer: 'a', role: 'agent', expectedVersion: 2, confidence: 0.7 })
  first.close()

  clock += 1
  const reopened = new SqliteBlackboard(path, () => clock)
  // 恢复当前值与版本号
  const [restored] = reopened.read('workflow', 'plan')
  assert.equal(restored.value, 'v3')
  assert.equal(restored.version, 3)
  assert.equal(restored.id, r3.status === 'ok' ? r3.entry.id : undefined)

  // 基于恢复版本继续乐观锁链：v3 → v4，id 延续同一条目
  const r4 = reopened.write({ scope: 'workflow', key: 'plan', value: 'v4', writer: 'b', role: 'agent', expectedVersion: 3 })
  assert.equal(r4.status, 'ok')
  assert.equal(r4.status === 'ok' && r4.entry.version, 4)
  assert.equal(r4.status === 'ok' && r4.entry.id, restored.id)

  // 重启后用过期 expectedVersion 走仲裁：低置信度挑战 → conflict，胜者为 v4
  const stale = reopened.write({ scope: 'workflow', key: 'plan', value: 'stale', writer: 'c', role: 'agent', expectedVersion: 1, confidence: 0.1 })
  assert.equal(stale.status, 'conflict')
  if (stale.status === 'conflict') {
    assert.equal(stale.winner.value, 'v4')
    assert.equal(stale.winner.version, 4)
  }

  // read 只返回每个 key 的最新版本，按 updatedAt 倒序
  clock += 1
  reopened.write({ scope: 'workflow', key: 'other', value: 1, writer: 'd', role: 'agent', expectedVersion: 0 })
  const all = reopened.read('workflow')
  assert.equal(all.length, 2)
  assert.equal(all[0].key, 'other')
  assert.equal(all[1].key, 'plan')
  assert.equal(all[1].version, 4)
  reopened.close()
})
