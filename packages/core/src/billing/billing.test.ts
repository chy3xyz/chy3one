import test from 'node:test'
import assert from 'node:assert/strict'
import { BillingEngine, type BillingEvent } from './billing.js'

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

test('billing: resolved 计费 2.50，escalated 免费并产出 lesson (AC-05)', () => {
  const engine = new BillingEngine()
  const ok = engine.onTaskComplete(ev('t1', 'resolved'))
  assert.equal(ok.amount, 2.5)
  const esc = engine.onTaskComplete(ev('t2', 'escalated'))
  assert.equal(esc.amount, 0)
  assert.ok(esc.lesson && esc.lesson.failureScenario.includes('t2'))
  assert.equal(engine.totalRevenue(), 2.5)
})

test('billing: 同一 taskId 幂等，不重复计费', () => {
  const engine = new BillingEngine()
  engine.onTaskComplete(ev('dup', 'resolved'))
  const again = engine.onTaskComplete(ev('dup', 'resolved'))
  assert.equal(engine.totalRevenue(), 2.5)
  assert.equal(again.taskId, 'dup')
})

test('billing: 批量 1000 笔计费零误差 (AC-05)', () => {
  const engine = new BillingEngine()
  for (let i = 0; i < 1000; i++) engine.onTaskComplete(ev(`task-${i}`, 'resolved'))
  for (let i = 0; i < 500; i++) engine.onTaskComplete(ev(`esc-${i}`, 'escalated'))
  assert.equal(engine.totalRevenue(), 2500)
})

test('billing: 规则可配置', () => {
  const engine = new BillingEngine()
  engine.setRule({ resolution: 'resolved', unitPrice: 4 })
  assert.equal(engine.onTaskComplete(ev('t9', 'resolved')).amount, 4)
})
