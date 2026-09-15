import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, plugin } from './index.js'
import { createMockContext } from '../../../dsh-adapter/src/index.js'

/** 不传 memoriesFile/instinctsFile：JsonlMemoryStore 以纯内存模式运行，测试无落盘副作用 */
const emptyConfig = {}

test('plugin: 注册 opc.memory 与 opc.instinct 服务', () => {
  const ctx = createMockContext()
  apply(ctx, emptyConfig)

  assert.equal(name, 'opc-memory')
  assert.equal(plugin.name, 'opc-memory') // cordis Plugin.Function 元数据
  assert.deepEqual(plugin.inject, [])
  assert.ok(ctx.services.has('opc.memory'))
  assert.ok(ctx.services.has('opc.instinct'))
  assert.ok(ctx.services.has('opc.instinct.observe'))
})

test('plugin: 写入后可按条件检索（R@5）', () => {
  const ctx = createMockContext()
  apply(ctx, emptyConfig)

  const memory = ctx.getService('opc.memory') as {
    write(e: { scope: string; category: string; content: string; confidence: number }): { id: string }
    query(c: { keyword?: string; limit?: number }): Array<{ content: string; id: string }>
  }

  const a = memory.write({ scope: 'global', category: 'fact', content: 'Acme 的 SLA 是 4 小时', confidence: 0.9 })
  memory.write({ scope: 'workflow', category: 'lesson', content: '退款前先核订单', confidence: 0.7 })

  const hits = memory.query({ keyword: 'sla' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, a.id)
  assert.ok(hits[0].content.includes('SLA'))
})

test('plugin: instinct.record 追加写入并触发 opc.instinct.observe 埋点', () => {
  const ctx = createMockContext()
  apply(ctx, emptyConfig)

  const observed: Array<{ taskSignature: string; tools: string[]; success: boolean }> = []
  const observe = ctx.getService('opc.instinct.observe') as {
    subscribe(l: (o: { taskSignature: string; tools: string[]; success: boolean }) => void): () => void
  }
  const unsubscribe = observe.subscribe((o) => observed.push(o))

  const instinct = ctx.getService('opc.instinct') as {
    record(o: { taskSignature: string; tools: string[]; success: boolean }): { content: string; confidence: number }
  }
  const entry = instinct.record({
    taskSignature: 'refund-flow',
    tools: ['order.lookup', 'refund.create'],
    success: true,
  })

  assert.equal(observed.length, 1)
  assert.equal(observed[0].taskSignature, 'refund-flow')
  assert.equal(entry.confidence, 1)
  assert.ok(entry.content.includes('refund.create'))

  // 埋点可在卸载前退订
  unsubscribe()
})

test('plugin: agent/pre-step 惰性加载幂等（简化与真实载荷均放行）', () => {
  const ctx = createMockContext()
  apply(ctx, emptyConfig)

  const step = { taskId: 'task_20260915_001' }
  assert.deepEqual(ctx.dispatch('agent/pre-step', step), step)
  assert.deepEqual(ctx.dispatch('agent/pre-step', step), step) // 二次触发不重复加载

  // 真实 dsh-agent-loop 载荷形状：同样放行且幂等
  const real = { messages: [], turn: 1, signal: new AbortController().signal }
  assert.deepEqual(ctx.dispatch('agent/pre-step', real), real)
})

test('plugin: 卸载时清理副作用 (AC-07)', () => {
  const ctx = createMockContext()
  apply(ctx, emptyConfig)
  assert.ok(ctx.services.has('opc.memory'))
  ctx.unload() // LIFO 逆序执行清理：订阅集与服务注册表一并清空
  assert.equal(ctx.getService('opc.memory'), undefined)
})
