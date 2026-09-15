import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/* ─────────────── 真实 cordis 运行时：人工纠正检测（DE-03）─────────────── */

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
 * 按真实 DSH 'session/event' firehose 语义喂一条事件：
 * listener 以 (session, event) 双参派发（dsh-session/lib/index.js:1196-1202），
 * 事件为 {type, seq, time, data} 信封；'user/message' 的 data 即 UserMessage 本体
 * （dsh-session/lib/types/types.d.ts:281），turn/end reason 形状见 :165-201。
 */
function emitEvent(
  ctx: Cordis4ContextLike,
  session: { id: string },
  type: string,
  data: Record<string, unknown>,
  seqRef: { n: number },
) {
  ctx.emit('session/event', session, { type, seq: seqRef.n++, time: Date.now(), data })
}

/** memory store 查询句柄（opc.memory 服务） */
interface MemoryHandle {
  write(e: { scope: string; category: string; content: string; confidence: number }): { id: string }
  query(c: { category?: string }): Array<{ scope: string; category: string; content: string; confidence: number }>
}

test('runtime: aborted turn + 后续用户消息 → 写入可解析 lesson（真实 cordis）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opc-memory-de03-'))
  try {
    const Context = await loadCordis()
    const ctx = new Context()
    const fiber = ctx.plugin(plugin, {
      memoriesFile: join(dir, 'memories.jsonl'),
      instinctsFile: join(dir, 'instincts.jsonl'),
    })
    await Promise.resolve(fiber)

    const session = { id: 'sess-de' }
    const seqRef = { n: 0 }
    // turn 1：工具调用 → assistant 正文 → 用户打断（aborted，取消因 user）→ 新指令
    emitEvent(ctx, session, 'turn/start', { turn: 1 }, seqRef)
    emitEvent(ctx, session, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'db.delete', arguments: '{}' }, seqRef)
    emitEvent(ctx, session, 'tool/result', {
      turn: 1,
      step: 1,
      message: { callId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false },
    }, seqRef)
    emitEvent(ctx, session, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: '好的，我已经删除了整张订单表' }], source: { kind: 'model' } },
      stream: [],
    }, seqRef)
    emitEvent(ctx, session, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, seqRef)
    emitEvent(ctx, session, 'user/message', {
      content: [{ type: 'text', text: '谁让你删的？改成归档！' }],
      source: { kind: 'user', rpcId: 'r1' },
      role: 'user',
      id: 'u1',
    }, seqRef)

    const memory = ctx.get('opc.memory') as MemoryHandle
    const lessons = memory.query({ category: 'lesson' })
    assert.equal(lessons.length, 1, '一次纠正恰好写一条 lesson')

    const lesson = lessons[0]
    assert.equal(lesson.scope, 'workflow') // session 未声明 scope 时回退
    assert.equal(lesson.confidence, 0.9)
    const parsed = JSON.parse(lesson.content) as {
      originalScenario: string
      correctionSignal: string
      cancelCause?: string
      sessionId: string
      turn: number
      timestamp: number
    }
    assert.equal(parsed.sessionId, 'sess-de')
    assert.equal(parsed.turn, 1)
    assert.equal(parsed.correctionSignal, 'turn/end:aborted+user/message')
    assert.equal(parsed.cancelCause, 'user') // 真实 turn/end reason.reason 载荷
    assert.equal(typeof parsed.timestamp, 'number')
    assert.ok(parsed.originalScenario.includes('db.delete'), 'originalScenario 含被打断轮的工具序列')
    assert.ok(parsed.originalScenario.includes('删除了整张订单表'), 'assistant 正文可得时作为摘要进入')

    await fiber.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runtime: 同一 (sessionId,turn) 去重，新 turn 另记（真实 cordis）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opc-memory-dedupe-'))
  try {
    const Context = await loadCordis()
    const ctx = new Context()
    const fiber = ctx.plugin(plugin, {
      memoriesFile: join(dir, 'memories.jsonl'),
      instinctsFile: join(dir, 'instincts.jsonl'),
    })
    await Promise.resolve(fiber)

    const session = { id: 'sess-dup', scope: 'agent' } // scope 声明透传到 lesson
    const seqRef = { n: 0 }
    const abortTurn = (turn: number) => {
      emitEvent(ctx, session, 'turn/start', { turn }, seqRef)
      emitEvent(ctx, session, 'tool/call', { turn, step: 1, callId: `c${turn}`, name: 'mail.send', arguments: '{}' }, seqRef)
      emitEvent(ctx, session, 'turn/end', { turn, reason: { kind: 'aborted', reason: { kind: 'user' } } }, seqRef)
      emitEvent(ctx, session, 'user/message', {
        content: [{ type: 'text', text: '别发，收件人错了' }],
        source: { kind: 'user' },
        role: 'user',
        id: `u${turn}`,
      }, seqRef)
    }

    abortTurn(1)
    abortTurn(1) // 同一 turn 的重复纠正信号：去重，只记一次
    assert.equal((ctx.get('opc.memory') as MemoryHandle).query({ category: 'lesson' }).length, 1)

    abortTurn(2) // 不同 (sessionId,turn)：正常另记
    const lessons = (ctx.get('opc.memory') as MemoryHandle).query({ category: 'lesson' })
    assert.equal(lessons.length, 2)
    const turns = lessons.map((l) => (JSON.parse(l.content) as { turn: number }).turn).sort()
    assert.deepEqual(turns, [1, 2])
    assert.ok(lessons.every((l) => l.scope === 'agent'), 'session.scope 合法值透传为 lesson scope')

    await fiber.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runtime: correctionDetection=false 零监听零写入（真实 cordis）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opc-memory-off-'))
  try {
    const Context = await loadCordis()
    const ctx = new Context()
    const fiber = ctx.plugin(plugin, {
      memoriesFile: join(dir, 'memories.jsonl'),
      instinctsFile: join(dir, 'instincts.jsonl'),
      correctionDetection: false,
    })
    await Promise.resolve(fiber)

    const session = { id: 'sess-off' }
    const seqRef = { n: 0 }
    emitEvent(ctx, session, 'turn/start', { turn: 1 }, seqRef)
    emitEvent(ctx, session, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'db.delete', arguments: '{}' }, seqRef)
    emitEvent(ctx, session, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, seqRef)
    emitEvent(ctx, session, 'user/message', {
      content: [{ type: 'text', text: '谁让你删的？' }],
      source: { kind: 'user' },
      role: 'user',
      id: 'u1',
    }, seqRef)

    const memory = ctx.get('opc.memory') as MemoryHandle
    assert.equal(memory.query({ category: 'lesson' }).length, 0, '关闭后纠正信号不写任何 lesson')

    await fiber.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runtime: 正常完成的 turn + 用户消息不误报（真实 cordis）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opc-memory-clean-'))
  try {
    const Context = await loadCordis()
    const ctx = new Context()
    const fiber = ctx.plugin(plugin, {
      memoriesFile: join(dir, 'memories.jsonl'),
      instinctsFile: join(dir, 'instincts.jsonl'),
    })
    await Promise.resolve(fiber)

    const session = { id: 'sess-ok' }
    const seqRef = { n: 0 }
    // 正常轮 + 用户追问：无 aborted，不得写 lesson
    emitEvent(ctx, session, 'turn/start', { turn: 1 }, seqRef)
    emitEvent(ctx, session, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: '已归档完成' }], source: { kind: 'model' } },
      stream: [],
    }, seqRef)
    emitEvent(ctx, session, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, seqRef)
    emitEvent(ctx, session, 'user/message', {
      content: [{ type: 'text', text: '归档到哪个目录了？' }],
      source: { kind: 'user' },
      role: 'user',
      id: 'u1',
    }, seqRef)
    // 注入上下文（plugin 来源）不算人工输入：即使有 pending 也不触发
    emitEvent(ctx, session, 'turn/start', { turn: 2 }, seqRef)
    emitEvent(ctx, session, 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'hook' } } }, seqRef)
    emitEvent(ctx, session, 'user/message', {
      content: [{ type: 'text', text: '（自动注入的文件变更通知）' }],
      source: { kind: 'plugin' },
      role: 'user',
      id: 'u2',
    }, seqRef)

    const memory = ctx.get('opc.memory') as MemoryHandle
    assert.equal(memory.query({ category: 'lesson' }).length, 0, 'completed turn 与注入消息都不构成纠正')

    await fiber.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
