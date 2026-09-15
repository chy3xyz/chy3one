import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/* ─────────────── 真实 cordis 运行时：session/event firehose 粒度（DE-07）─────────────── */

/** 真实 cordis 4.x Context 结构子集（与 cordis-runtime.test.ts 同款解耦写法） */
interface Cordis4ContextLike {
  plugin(p: unknown, ...args: unknown[]): { dispose: () => Promise<void> } & PromiseLike<unknown>
  get(name: string, strict?: boolean): unknown
  on(name: string, listener: (...args: any[]) => unknown): () => boolean
  emit(name: string, ...args: unknown[]): void
}

async function loadCordis(): Promise<{ new (): Cordis4ContextLike }> {
  const mod = (await import('@deepseek-ai/cordis')) as { Context: new () => Cordis4ContextLike }
  return mod.Context
}

/**
 * 按真实 DSH 'session/event' firehose 语义喂一个完整 turn：
 * listener 以 (session, event) 双参派发（dsh-session/lib/index.js:1196-1202），
 * 事件为 {type, seq, time, data} 信封，载荷形状对齐
 * dsh-session/lib/types/types.d.ts（turn/start:249、tool/call:333、tool/result:351、turn/end:260）。
 */
function emitGranularTurn(
  ctx: Cordis4ContextLike,
  session: { id: string },
  turn: number,
  opts: { tools?: number; seqRef?: { n: number } } = {},
) {
  const seq = opts.seqRef ?? { n: 0 }
  const emit = (type: string, data: Record<string, unknown>) =>
    ctx.emit('session/event', session, { type, seq: seq.n++, time: Date.now(), data })
  emit('turn/start', { turn })
  for (let i = 0; i < (opts.tools ?? 1); i++) {
    const callId = `call-${session.id}-${turn}-${i}`
    emit('tool/call', { turn, step: 1, callId, name: `tool_${i}`, arguments: '{}' })
    emit('tool/result', {
      turn,
      step: 1,
      message: { callId, content: [{ type: 'text', text: 'ok' }], isError: false },
    })
  }
  emit('turn/end', { turn, reason: { kind: 'completed' } })
}

/** 读取 WAL 日志并按 taskId 索引 tokensUsed（BillingEngine write-ahead 落盘形状） */
async function readWalByTaskId(logFile: string): Promise<Map<string, { prompt: number; completion: number }>> {
  const text = await readFile(logFile, 'utf8')
  const byId = new Map<string, { prompt: number; completion: number }>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const parsed = JSON.parse(line) as { event: { taskId: string; tokensUsed: { prompt: number; completion: number } } }
    byId.set(parsed.event.taskId, parsed.event.tokensUsed)
  }
  return byId
}

test('runtime: 双 session 各 2 turn 按 sessionId#turn 精确分桶，结算互不串桶（真实 cordis）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opc-billing-granular-'))
  const logFile = join(dir, 'billing.jsonl')
  try {
    const Context = await loadCordis()
    const ctx = new Context()
    const fiber = ctx.plugin(plugin, { resolvedUnitPrice: 2.5, logFile })
    await Promise.resolve(fiber)

    // 两个会话各 2 turn，请求用量紧跟对应 turn（与真实交错一致），验证桶精确归属
    const sa = { id: 'sess-alfa' }
    const sb = { id: 'sess-beta' }
    const seqRef = { n: 0 }
    emitGranularTurn(ctx, sa, 1, { tools: 2, seqRef })
    ctx.emit('agent/request', { provider: 'dsh', model: 'deepseek-chat', usage: { prompt: 100, completion: 10 } })
    emitGranularTurn(ctx, sb, 1, { tools: 1, seqRef })
    ctx.emit('agent/request', { usage: { prompt: 200, completion: 20 } })
    emitGranularTurn(ctx, sa, 2, { tools: 1, seqRef })
    ctx.emit('agent/request', { usage: { prompt: 300, completion: 30 } })
    emitGranularTurn(ctx, sb, 2, { tools: 3, seqRef })
    ctx.emit('agent/request', { usage: { prompt: 400, completion: 40 } })

    const complete = ctx.get('opc.billing.complete') as (
      e: { taskId: string; agentId: string; resolution: 'resolved' },
    ) => { taskId: string; amount: number }
    for (const taskId of ['sess-alfa#turn1', 'sess-beta#turn1', 'sess-alfa#turn2', 'sess-beta#turn2']) {
      const record = complete({ taskId, agentId: 'customer-service-acme', resolution: 'resolved' })
      assert.equal(record.taskId, taskId)
      assert.equal(record.amount, 2.5) // 每个 (session,turn) 是一笔独立结算
    }

    const engine = ctx.get('opc.billing') as { totalRevenue(): number }
    assert.equal(engine.totalRevenue(), 10) // 4 × 2.5：四桶四笔，无合并

    // WAL 实证：token 用量按 `${sessionId}#turn${n}` 各归各桶，互不串桶
    const byId = await readWalByTaskId(logFile)
    assert.deepEqual(byId.get('sess-alfa#turn1'), { prompt: 100, completion: 10 })
    assert.deepEqual(byId.get('sess-beta#turn1'), { prompt: 200, completion: 20 })
    assert.deepEqual(byId.get('sess-alfa#turn2'), { prompt: 300, completion: 30 })
    assert.deepEqual(byId.get('sess-beta#turn2'), { prompt: 400, completion: 40 })

    await fiber.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runtime: 桶容量 512 上限 LRU 淘汰不崩，淘汰键回退最近活跃桶（真实 cordis）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opc-billing-lru-'))
  const logFile = join(dir, 'billing.jsonl')
  try {
    const Context = await loadCordis()
    const ctx = new Context()
    const fiber = ctx.plugin(plugin, { resolvedUnitPrice: 2.5, logFile })
    await Promise.resolve(fiber)

    // 600 个 (session,turn) 桶 > 512 上限：最旧者被淘汰，过程不得抛错
    const seqRef = { n: 0 }
    for (let i = 0; i < 600; i++) emitGranularTurn(ctx, { id: `s-${i}` }, 1, { seqRef })
    ctx.emit('agent/request', { usage: { prompt: 55, completion: 5 } }) // 归属最近活跃桶 s-599#turn1

    const complete = ctx.get('opc.billing.complete') as (
      e: { taskId: string; agentId: string; resolution: 'resolved' },
    ) => { taskId: string; amount: number }
    const evicted = complete({ taskId: 's-0#turn1', agentId: 'a', resolution: 'resolved' })
    assert.equal(evicted.amount, 2.5) // 淘汰键：回退最近活跃桶（真实场景语义），不崩
    const live = complete({ taskId: 's-599#turn1', agentId: 'a', resolution: 'resolved' })
    assert.equal(live.amount, 2.5)

    const byId = await readWalByTaskId(logFile)
    assert.deepEqual(byId.get('s-0#turn1'), { prompt: 55, completion: 5 }) // 回退取到最后活跃桶用量
    assert.deepEqual(byId.get('s-599#turn1'), { prompt: 55, completion: 5 }) // 精确命中仍在

    await fiber.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runtime: granularBySession=false 回退旧行为，firehose 事件不建桶（真实 cordis）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opc-billing-legacy-'))
  const logFile = join(dir, 'billing.jsonl')
  try {
    const Context = await loadCordis()
    const ctx = new Context()
    const fiber = ctx.plugin(plugin, { resolvedUnitPrice: 2.5, logFile, granularBySession: false })
    await Promise.resolve(fiber)

    // firehose 照发，但开关关闭：不建 granular 桶、不设最近活跃桶
    emitGranularTurn(ctx, { id: 'sess-x' }, 1)

    // 旧行为：pre-step 建会话桶，无 taskId 的 request 归 'session'
    ctx.emit('agent/pre-step', { messages: [], turn: 1 })
    ctx.emit('agent/request', { usage: { prompt: 42, completion: 7 } })

    const complete = ctx.get('opc.billing.complete') as (
      e: { taskId: string; agentId: string; resolution: 'resolved' },
    ) => { taskId: string; amount: number }
    const sessionRecord = complete({ taskId: 'session', agentId: 'a', resolution: 'resolved' })
    assert.equal(sessionRecord.amount, 2.5)

    const granularKey = complete({ taskId: 'sess-x#turn1', agentId: 'a', resolution: 'resolved' })
    assert.equal(granularKey.amount, 2.5)

    const byId = await readWalByTaskId(logFile)
    assert.deepEqual(byId.get('session'), { prompt: 42, completion: 7 }) // 旧行为保留
    assert.deepEqual(byId.get('sess-x#turn1'), { prompt: 0, completion: 0 }) // firehose 被忽略

    await fiber.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
