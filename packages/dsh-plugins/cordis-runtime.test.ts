/**
 * 真实 cordis 4.x 运行时验证（非 mock）：证明 adapter 化插件可被真实
 * `ctx.plugin()` 加载、提供服务、响应事件、并在卸载时撤销全部副作用（AC-07 真实环境版）。
 * 该文件同时是 DSH 升级流程的一环：升级后此测试失败说明插件装载语义漂移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { plugin as billingPlugin } from './opc-billing/src/index.js'

interface Cordis4ContextLike {
  plugin(p: unknown, ...args: unknown[]): { dispose: () => Promise<void> } & PromiseLike<unknown>
  get(name: string, strict?: boolean): unknown
  on(name: string, listener: (...args: any[]) => unknown): () => boolean
  emit(name: string, ...args: unknown[]): void
  provide(name: string, value?: unknown): unknown
  effect(execute: () => unknown, label?: string): unknown
}

async function loadCordis(): Promise<{ new (): Cordis4ContextLike }> {
  const mod = (await import('@deepseek-ai/cordis')) as { Context: new () => Cordis4ContextLike }
  return mod.Context
}

test('runtime: 真实 cordis ctx.plugin() 加载 opc-billing 并提供服务', async () => {
  const Context = await loadCordis()
  const ctx = new Context()

  const fiber = ctx.plugin(billingPlugin, { resolvedUnitPrice: 3 })
  await Promise.resolve(fiber)

  const engine = ctx.get('opc.billing') as { onTaskComplete(e: unknown): { amount: number } }
  assert.ok(engine, 'service opc.billing should be provided on real cordis')
  const record = engine.onTaskComplete({
    taskId: 'rt-1',
    agentId: 'acme',
    resolution: 'resolved',
    tokensUsed: { prompt: 1, completion: 1 },
    durationMs: 10,
    timestamp: Date.now(),
  })
  assert.equal(record.amount, 3)

  await fiber.dispose()
  assert.equal(ctx.get('opc.billing'), undefined, 'dispose 后服务应撤销（AC-07）')
})

test('runtime: 真实 cordis 事件总线驱动 waterfall 监听', async () => {
  const Context = await loadCordis()
  const ctx = new Context()
  const fiber = ctx.plugin(billingPlugin, {})
  await Promise.resolve(fiber)

  // opc-billing 在 agent/pre-step 建桶、agent/request 计量；emit 派发
  ctx.emit('agent/pre-step', { messages: [], turn: 1 })
  ctx.emit('agent/request', { provider: 'deepseek', model: 'x', taskId: 'rt-2', usage: { prompt: 100, completion: 20 } })

  const complete = ctx.get('opc.billing.complete') as (e: { taskId: string; agentId: string; resolution: 'resolved' }) => { amount: number }
  assert.equal(complete({ taskId: 'rt-2', agentId: 'acme', resolution: 'resolved' }).amount, 2.5)

  await fiber.dispose()
})
