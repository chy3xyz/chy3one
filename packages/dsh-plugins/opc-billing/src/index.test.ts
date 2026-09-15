import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, plugin } from './index.js'
import { createMockContext } from '../../../dsh-adapter/src/index.js'

test('plugin: 注册服务并通过 waterfall 埋点结算计费', () => {
  const ctx = createMockContext()
  apply(ctx, { resolvedUnitPrice: 2.5 })

  ctx.dispatch('agent/pre-step', { taskId: 'task_20260915_001' })
  ctx.dispatch('agent/request', { taskId: 'task_20260915_001', usage: { prompt: 12500, completion: 3200 } })

  const complete = ctx.getService('opc.billing.complete') as (
    e: { taskId: string; agentId: string; resolution: 'resolved' },
  ) => { amount: number }
  const record = complete({ taskId: 'task_20260915_001', agentId: 'customer-service-acme', resolution: 'resolved' })
  assert.equal(record.amount, 2.5)
  assert.equal(name, 'opc-billing')
  assert.equal(plugin.name, 'opc-billing') // cordis Plugin.Function 元数据
  assert.deepEqual(plugin.inject, [])
})

test('plugin: 真实载荷形状（无 taskId）回退会话桶仍可结算', () => {
  const ctx = createMockContext()
  apply(ctx, { resolvedUnitPrice: 2.5 })

  const real = { messages: [], turn: 1, signal: new AbortController().signal }
  assert.deepEqual(ctx.dispatch('agent/pre-step', real), real) // 放行不改载荷
  ctx.dispatch('agent/request', { provider: 'dsh', model: 'deepseek-chat', usage: { prompt: 12500, completion: 3200 } })

  const complete = ctx.getService('opc.billing.complete') as (
    e: { taskId: string; agentId: string; resolution: 'resolved' },
  ) => { amount: number }
  const record = complete({ taskId: 'session', agentId: 'customer-service-acme', resolution: 'resolved' })
  assert.equal(record.amount, 2.5)
})

test('plugin: 卸载时清理副作用 (AC-07)', () => {
  const ctx = createMockContext()
  apply(ctx, { resolvedUnitPrice: 2.5 })
  assert.ok(ctx.services.has('opc.billing.complete'))
  ctx.dispatch('agent/pre-step', { taskId: 'task_20260915_001' })
  ctx.unload() // LIFO 逆序执行清理：累计用量与服务注册表一并清空
  assert.equal(ctx.getService('opc.billing.complete'), undefined)
})
