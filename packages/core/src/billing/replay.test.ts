import test from 'node:test'
import assert from 'node:assert/strict'
import { BillingEngine, type BillingEvent } from './billing.js'
import { replayFromSessionLog } from './replay.js'

function ev(taskId: string, resolution: 'resolved' | 'escalated'): BillingEvent {
  return {
    taskId,
    agentId: 'customer-service-acme',
    resolution,
    tokensUsed: { prompt: 12500, completion: 3200 },
    durationMs: 45000,
    timestamp: Date.now(),
  }
}

function taskLine(event: BillingEvent): string {
  return JSON.stringify({ type: 'task_complete', event })
}

function otherLine(): string {
  return JSON.stringify({ type: 'session_start', payload: { ts: Date.now() } })
}

test('replay: 1000 行日志回补后收入精确 (PRD 6.4.5 / DE 表格)', () => {
  const engine = new BillingEngine()
  const lines: string[] = []
  for (let i = 0; i < 1000; i++) lines.push(taskLine(ev(`task-${i}`, 'resolved')))

  const { replayed, recovered } = replayFromSessionLog(lines, engine)
  assert.equal(replayed, 1000)
  assert.equal(recovered, 1000)
  assert.equal(engine.totalRevenue(), 2500) // 1000 × ¥2.50，零误差
})

test('replay: 1000 行混合 resolved/escalated 回补，收入与免费记录数精确', () => {
  const engine = new BillingEngine()
  const lines: string[] = []
  for (let i = 0; i < 600; i++) lines.push(taskLine(ev(`r-${i}`, 'resolved')))
  for (let i = 0; i < 400; i++) lines.push(taskLine(ev(`e-${i}`, 'escalated')))

  const { replayed, recovered } = replayFromSessionLog(lines, engine)
  assert.equal(replayed, 1000)
  assert.equal(recovered, 1000)
  assert.equal(engine.totalRevenue(), 1500) // 600 × ¥2.50，escalated 免费
})

test('replay: 混合重复 taskId 幂等——重复行不重复计费', () => {
  const engine = new BillingEngine()
  const lines: string[] = [
    taskLine(ev('t1', 'resolved')),
    taskLine(ev('t2', 'resolved')),
    taskLine(ev('t1', 'resolved')), // 日志内重复（重放/断点续传）
    taskLine(ev('t3', 'escalated')),
    taskLine(ev('t3', 'escalated')), // 免费记录同样幂等
    taskLine(ev('t2', 'resolved')),
    taskLine(ev('t4', 'resolved')),
  ]

  const { replayed, recovered } = replayFromSessionLog(lines, engine)
  assert.equal(replayed, 7) // 所有合法 task_complete 行都被处理
  assert.equal(recovered, 4) // 但只有 4 条真实新增
  assert.equal(engine.totalRevenue(), 7.5) // t1 + t2 + t4 = 3 × 2.50，t3 免费
})

test('replay: 已部分入账的引擎再回补全量日志不重复计费（幂等跨批次）', () => {
  const engine = new BillingEngine()
  // 埋点正常工作时段：t1/t2 已入账
  engine.onTaskComplete(ev('t1', 'resolved'))
  engine.onTaskComplete(ev('t2', 'resolved'))
  assert.equal(engine.totalRevenue(), 5)

  // 埋点丢失后从 Session 日志全量回补（含已入账的 t1/t2 与丢失的 t3）
  const lines = [taskLine(ev('t1', 'resolved')), taskLine(ev('t2', 'resolved')), taskLine(ev('t3', 'resolved'))]
  const { replayed, recovered } = replayFromSessionLog(lines, engine)

  assert.equal(replayed, 3)
  assert.equal(recovered, 1) // 仅 t3 为新增
  assert.equal(engine.totalRevenue(), 7.5)
})

test('replay: 空行 / 坏 JSON / 非 task_complete 行 / 结构损坏事件均跳过且不抛错', () => {
  const engine = new BillingEngine()
  const lines: string[] = [
    '',
    '   ',
    'not-json-at-all',
    '{broken json',
    otherLine(),
    JSON.stringify({ type: 'task_complete' }), // 缺 event
    JSON.stringify({ type: 'task_complete', event: { taskId: 42 } }), // 字段损坏
    JSON.stringify({ type: 'task_complete', event: null }),
    'null',
    '"just a string"',
    taskLine(ev('good-1', 'resolved')),
    taskLine(ev('good-2', 'escalated')),
  ]

  const { replayed, recovered } = replayFromSessionLog(lines, engine)
  assert.equal(replayed, 2)
  assert.equal(recovered, 2)
  assert.equal(engine.totalRevenue(), 2.5)
})

test('replay: 空日志输入返回零值', () => {
  const engine = new BillingEngine()
  const result = replayFromSessionLog([], engine)
  assert.deepEqual(result, { replayed: 0, recovered: 0 })
  assert.equal(engine.totalRevenue(), 0)
})
