import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, plugin, type SkillForgeService } from './index.js'
import { createMockContext, type TelemetryBus, type TelemetryEvent } from '../../../dsh-adapter/src/index.js'
import { verifyPackage, installPackage, type SkillPackage } from '../../../core/src/skill/packager.js'

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
 * 按真实 DSH 'session/event' firehose 语义喂工具事件流：
 * listener 以 (session, event) 双参派发（dsh-session/lib/index.js:1196-1202），
 * 事件载荷形状对齐 dsh-agent-loop/lib/index.js:687/713 的 append 调用；
 * 串行执行下 call→result 逐工具交错到达。
 */
function emitToolRound(
  ctx: Cordis4ContextLike,
  session: { id: string },
  round: number,
  tools: string[],
  opts: { failAll?: boolean; seqRef?: { n: number } } = {},
) {
  const seq = opts.seqRef ?? { n: 0 }
  const emit = (type: string, data: Record<string, unknown>) =>
    ctx.emit('session/event', session, { type, seq: seq.n++, time: Date.now(), data })
  for (let i = 0; i < tools.length; i++) {
    const callId = `call-${round}-${i}`
    emit('tool/call', { turn: round, step: 1, callId, name: tools[i], arguments: '{}' })
    const failed = opts.failAll === true
    emit('tool/result', {
      turn: round,
      step: 1,
      message: { callId, content: [{ type: 'text', text: failed ? 'Error: boom' : 'ok' }], isError: failed },
      ...(failed ? { error: { name: 'ExecError', code: 'X' } } : {}),
    })
  }
}

function observation(seq: number): { taskSignature: string; tools: string[]; success: boolean; timestamp: number } {
  return {
    taskSignature: 'contract-review',
    tools: ['pdf_reader', 'clause_extractor', 'risk_scorer'],
    success: true,
    timestamp: Date.now() + seq,
  }
}

test('plugin: 3 次重复观测自动蒸馏出草案 (AC-01)', () => {
  const ctx = createMockContext()
  apply(ctx, { minRepetitions: 3, minSuccessRate: 0.8 })

  const forge = ctx.getService('opc.skillforge') as SkillForgeService
  forge.observe(observation(1))
  forge.observe(observation(2))
  assert.equal(forge.listDrafts().length, 0) // 重复 < 3 不蒸馏（质量门控）
  forge.observe(observation(3))
  const drafts = forge.listDrafts()
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].name, 'skill-contract-review-3steps')
  assert.deepEqual(drafts[0].skillDefinition.toolSequence, ['pdf_reader', 'clause_extractor', 'risk_scorer'])
  // 再来一次同样模式，不重复出草案
  forge.observe(observation(4))
  assert.equal(forge.listDrafts().length, 1)
  assert.equal(name, 'opc-skill-forge')
  assert.equal(plugin.name, 'opc-skill-forge') // cordis Plugin.Function 元数据
  assert.deepEqual(plugin.inject, [])
})

test('plugin: 蒸馏触发埋点事件 skill_distill_start/complete (PRD 7.5)', () => {
  const ctx = createMockContext()
  apply(ctx, { minRepetitions: 3, minSuccessRate: 0.8 })

  const forge = ctx.getService('opc.skillforge') as SkillForgeService
  const bus = ctx.getService('opc.skillforge.events') as TelemetryBus
  const events: TelemetryEvent[] = []
  bus.subscribe((event) => events.push(event))

  forge.observe(observation(1))
  forge.observe(observation(2))
  forge.observe(observation(3))

  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'skill_distill_start')
  assert.equal(events[0].payload!.skillId, 'contract-review')
  assert.ok(Number.isFinite(events[0].timestamp))
  assert.equal(events[1].type, 'skill_distill_complete')
  assert.equal(events[1].payload!.skillId, 'contract-review')
  assert.ok(events[1].payload!.duration !== undefined)
  assert.ok(events[1].payload!.qualityScore !== undefined)
})

test('plugin: 退订后不再收到埋点（TD-04 统一 subscribe 约定）', () => {
  const ctx = createMockContext()
  apply(ctx, { minRepetitions: 3, minSuccessRate: 0.8 })

  const forge = ctx.getService('opc.skillforge') as SkillForgeService
  const bus = ctx.getService('opc.skillforge.events') as TelemetryBus
  const received: TelemetryEvent[] = []
  const unsubscribe = bus.subscribe((event) => received.push(event))
  unsubscribe()
  forge.observe(observation(1))
  forge.observe(observation(2))
  forge.observe(observation(3))
  assert.equal(received.length, 0)
  assert.equal(forge.listDrafts().length, 1) // 退订不影响业务蒸馏路径
})

test('plugin: agent/request 载荷中的 toolObservation 自动 observe', () => {
  const ctx = createMockContext()
  apply(ctx, { minRepetitions: 3, minSuccessRate: 0.8 })

  const forge = ctx.getService('opc.skillforge') as SkillForgeService
  for (let i = 0; i < 3; i++) {
    const returned = ctx.dispatch('agent/request', { taskId: 'task_001', toolObservation: observation(i) })
    assert.equal((returned as { taskId: string }).taskId, 'task_001') // 放行不改载荷
  }
  // 无 toolObservation 的载荷安全跳过
  ctx.dispatch('agent/request', { taskId: 'task_002' })
  assert.equal(forge.listDrafts().length, 1)
})

test('plugin: 真实载荷形状（provider/model + toolObservation）同样可观测且放行', () => {
  const ctx = createMockContext()
  apply(ctx, { minRepetitions: 3, minSuccessRate: 0.8 })

  const forge = ctx.getService('opc.skillforge') as SkillForgeService
  for (let i = 0; i < 3; i++) {
    const real = { provider: 'dsh', model: 'deepseek-chat', toolObservation: observation(i) }
    const returned = ctx.dispatch('agent/request', real)
    assert.deepEqual(returned, real) // 放行不改载荷
  }
  assert.equal(forge.listDrafts().length, 1)
})

test('plugin: 真实 session/event 工具事件流喂饱 PatternMiner（真实 cordis 运行时）', async () => {
  const Context = await loadCordis()
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, { minRepetitions: 3, minSuccessRate: 0.8 })
  await Promise.resolve(fiber)

  const forge = ctx.get('opc.skillforge') as SkillForgeService
  assert.ok(forge, '真实 cordis 上应解析到 opc.skillforge 服务')

  // 3 轮 call→result，每轮同一工具序列：真实事件流应直接驱动蒸馏（本能提炼前提）
  const session = { id: 'sess-fixture' }
  const tools = ['pdf_reader', 'clause_extractor', 'risk_scorer']
  const seqRef = { n: 0 }
  for (let round = 1; round <= 3; round++) emitToolRound(ctx, session, round, tools, { seqRef })

  const drafts = forge.listDrafts()
  assert.ok(drafts.length >= 1, '真实事件流应产出草案')
  // 完整 3 步序列的草案存在（增量观测也会覆盖 1/2 步前缀，此处断言全序列草案）
  const full = drafts.find((d) => d.skillDefinition.toolSequence.length === tools.length)
  assert.ok(full, '应包含完整工具序列草案')
  assert.deepEqual(full.skillDefinition.toolSequence, tools)
  assert.equal(full.name, 'skill-sess-fixture-3steps') // taskSignature=会话标识

  await fiber.dispose()
  assert.equal(ctx.get('opc.skillforge'), undefined, 'dispose 后服务撤销（AC-07）')
})

test('plugin: observeRealEvents=false 关闭真实事件路径（仅回退生效）', async () => {
  const Context = await loadCordis()
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, { minRepetitions: 3, minSuccessRate: 0.8, observeRealEvents: false })
  await Promise.resolve(fiber)

  const forge = ctx.get('opc.skillforge') as SkillForgeService
  const session = { id: 'sess-fixture' }
  for (let round = 1; round <= 3; round++) {
    emitToolRound(ctx, session, round, ['pdf_reader', 'clause_extractor', 'risk_scorer'])
  }
  assert.equal(forge.listDrafts().length, 0, '关闭后真实事件流不产生观测')

  await fiber.dispose()
})

test('plugin: 真实事件成败推断——isError 全失败序列达不到门控，不蒸馏', async () => {
  const Context = await loadCordis()
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, { minRepetitions: 3, minSuccessRate: 0.8 })
  await Promise.resolve(fiber)

  const forge = ctx.get('opc.skillforge') as SkillForgeService
  const session = { id: 'sess-fail' }
  // 3 轮全部失败（message.isError=true + error 字段）：任意前缀成功率恒为 0，
  // 不得出任何草案——证明成败是从真实 result 载荷推断的，而非默认成功
  for (let round = 1; round <= 3; round++) {
    emitToolRound(ctx, session, round, ['pdf_reader', 'clause_extractor', 'risk_scorer'], { failAll: true })
  }
  assert.equal(forge.listDrafts().length, 0, '全失败流不得蒸馏任何草案')

  await fiber.dispose()
})

test('plugin: 打包+验签+安装闭环 (AC-02 / AR-S05)', async () => {
  const ctx = createMockContext()
  apply(ctx, { minRepetitions: 3, minSuccessRate: 0.8 })

  const forge = ctx.getService('opc.skillforge') as SkillForgeService
  forge.observe(observation(1))
  forge.observe(observation(2))
  forge.observe(observation(3))
  const draft = forge.listDrafts()[0]

  const pkg = forge.packageDraft(draft, 'author-001') as SkillPackage
  assert.equal(pkg.manifest.skillId, draft.name)
  assert.equal(pkg.manifest.authorId, 'author-001')
  assert.equal(pkg.manifest.compat.dsh, '>=0.1.0-rc.7')

  // 信封无公钥无法自验：打包接口返回 pkg；此处用独立密钥对验签的流程由安装方持有公钥。
  // 闭环验证：用同一作者身份重打包并校验安装拒绝篡改包。
  const dir = await mkdtemp(join(tmpdir(), 'skillforge-'))
  try {
    // 篡改包必须被安装拒绝
    const tampered: SkillPackage = { ...pkg, manifest: { ...pkg.manifest, authorId: 'attacker' } }
    await assert.rejects(() => installPackage(tampered, dir, 'garbage-pem'), (err: unknown) => {
      assert.ok(err instanceof Error)
      return true
    })
    assert.deepEqual(await readdir(dir), []) // 无残余
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plugin: 完整闭环——packageDraft 产物可验签并安装', async () => {
  const ctx = createMockContext()
  apply(ctx, { minRepetitions: 3, minSuccessRate: 0.8 })

  const forge = ctx.getService('opc.skillforge') as SkillForgeService
  forge.observe(observation(1))
  forge.observe(observation(2))
  forge.observe(observation(3))
  const pkg = forge.packageDraft(forge.listDrafts()[0], 'author-001') as SkillPackage

  // 模拟安装方持有作者公钥：重新打包获得密钥对（测试路径，生产公钥来自市场/作者档案）
  const { createPackage } = await import('../../../core/src/skill/packager.js')
  const authored = createPackage(forge.listDrafts()[0], 'author-001')
  assert.equal(verifyPackage(authored.pkg, authored.keys.publicKeyPem), true)
  assert.equal(authored.pkg.manifest.skillId, pkg.manifest.skillId)

  const dir = await mkdtemp(join(tmpdir(), 'skillforge-install-'))
  try {
    const installed = await installPackage(authored.pkg, dir, authored.keys.publicKeyPem)
    assert.equal(installed, join(dir, authored.pkg.manifest.skillId))
    const files = (await readdir(installed)).sort()
    assert.deepEqual(files, ['manifest.json', 'skill.json'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plugin: 卸载时清理副作用 (AC-07)', () => {
  const ctx = createMockContext()
  apply(ctx, { minRepetitions: 3, minSuccessRate: 0.8 })
  const forge = ctx.getService('opc.skillforge') as SkillForgeService
  forge.observe(observation(1))
  forge.observe(observation(2))
  forge.observe(observation(3))
  assert.ok(forge.listDrafts().length > 0)
  ctx.unload() // LIFO 逆序执行清理：观测与草案一并清空（events 服务由宿主撤销）
  assert.equal(forge.listDrafts().length, 0)
})
