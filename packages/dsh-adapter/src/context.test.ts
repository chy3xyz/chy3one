import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  createMockContext,
  adaptContext,
  isCordis4Context,
  defineOpcPlugin,
  detectDshRuntime,
  redact,
} from './context.js'

test('compat: waterfall 行为语义——adapter 监听器放行必须走完官方链（回归锁：2026-09-15 turn/end reading kind 事故）', async () => {
  const mod = (await import('@deepseek-ai/cordis')) as { Context: new () => any }
  const raw = new mod.Context()
  const opc = adaptContext(raw)
  let observed: any
  // 返回 undefined（OPC 观察/放行语义）：官方 fallback 必须到达，decision 不得为 undefined
  opc.onWaterfall('agent/pre-step', (p) => {
    observed = p
  })
  const decision = await raw.events.waterfall(
    'agent/pre-step',
    { messages: ['P'] },
    async () => ({ kind: 'enter', messages: ['P', 'CTX'] }),
  )
  assert.equal(decision?.kind, 'enter', 'decision 为 undefined 即官方链被否决——waterfall 监听器必须调用 next()')
  assert.deepEqual(decision.messages, ['P', 'CTX'])
  assert.deepEqual(observed, { messages: ['P'] })
})

test('adapter: mock 上下文提供服务/事件/清理全链路', () => {
  const ctx = createMockContext()
  const off = ctx.provideService('opc.test', { hello: 1 })
  assert.deepEqual(ctx.getService('opc.test'), { hello: 1 })

  let seen: unknown
  const unsub = ctx.onEvent('x', (p) => {
    seen = p
  })
  ctx.dispatch('x', { a: 2 })
  assert.deepEqual(seen, { a: 2 })
  unsub()

  let cleaned = false
  ctx.onDispose(() => {
    cleaned = true
  })
  ctx.unload()
  assert.ok(cleaned)
  off()
  assert.equal(ctx.getService('opc.test'), undefined)
})

test('adapter: waterfall 语义——监听器返回值替换载荷', () => {
  const ctx = createMockContext()
  ctx.onWaterfall('agent/pre-step', (p) => ({ ...p, tagged: true }))
  const out = ctx.dispatch('agent/pre-step', { messages: [] })
  assert.equal((out as { tagged: boolean }).tagged, true)
})

test('adapter: defineOpcPlugin 产出 cordis 形状插件并可运行', () => {
  const plugin = defineOpcPlugin<{ greeting: string }>({
    name: 'opc-demo',
    defaultConfig: { greeting: 'hi' },
    apply: (ctx, config) => {
      ctx.provideService('opc.demo', config.greeting)
    },
  })
  assert.equal(plugin.name, 'opc-demo')
  assert.deepEqual(plugin.inject, [])

  // 结构符合 cordis Plugin.Function：可被 ctx.plugin() 调用
  const fakeCordis = {
    provide(name: string, value: unknown) {
      ;(fakeCordis as unknown as Map<string, unknown>).set?.(name, value)
      return () => {}
    },
    get: () => undefined,
    on: () => () => false,
    effect: () => undefined,
  }
  assert.ok(isCordis4Context(fakeCordis))
  plugin(fakeCordis, { greeting: 'custom' })
})

test('adapter: 非 cordis 上下文被拒绝', () => {
  const plugin = defineOpcPlugin({ name: 'x', defaultConfig: {}, apply: () => {} })
  assert.throws(() => plugin({}, {}), /cordis-4 context/)
})

test('adapter: 日志脱敏 (RC-04/AR-S03)', () => {
  assert.equal(redact('key=sk-abcdef12345678'), 'key=sk-***')
  assert.equal(redact('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer ***')
  assert.equal(redact('{"api_key":"topsecret"}'), '{"api_key":"***"}')
  assert.equal(redact('plain text'), 'plain text')
})

/* ─────────────── DSH 升级门禁（compat）：锁定已安装版本依赖的 API 表面 ─────────────── */

test('compat: 已安装 cordis 4.x，detectDshRuntime 可解析版本', () => {
  const info = detectDshRuntime()
  assert.equal(info.apiLevel, 'cordis-4')
  assert.match(info.cordisVersion ?? '', /^\d+\.\d+\.\d+/)
})

test('compat: cordis 4.x Context 类型表面——provide/on/effect/get（锁 AR-C06 契约）', () => {
  const reflect = readFileSync('node_modules/@deepseek-ai/cordis/lib/types/reflect.d.ts', 'utf8')
  assert.match(reflect, /provide\(name: string, value\?: any\)/)
  assert.match(reflect, /get\(name: string, strict\?: boolean\): any/)
  const events = readFileSync('node_modules/@deepseek-ai/cordis/lib/types/events.d.ts', 'utf8')
  assert.match(events, /'waterfall'/)
  assert.match(events, /on<K extends keyof Events>/)
  const fiber = readFileSync('node_modules/@deepseek-ai/cordis/lib/types/fiber.d.ts', 'utf8')
  assert.match(fiber, /effect\(execute/)
})

test('compat: dsh-agent-loop waterfall 接管点与载荷字段（锁 ARD-005 计费埋点）', () => {
  // rc.3 起 dsh-agent-loop 可能被 npm 嵌套进 @deepseek-ai/dsh/node_modules：
  // 兼容顶层（直接依赖）与嵌套（传递依赖）两种布局，都找不到即真实漂移
  const CANDIDATE_PATHS = [
    'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
    'node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
  ]
  const found = CANDIDATE_PATHS.find((p) => existsSync(p))
  assert.ok(found, `dsh-agent-loop 未找到（候选：${CANDIDATE_PATHS.join(' | ')}）—— DSH 包布局漂移，需更新 packages/dsh-adapter`)
  const loopSrc = readFileSync(found, 'utf8')
  // 三个接管点必须存在
  for (const hook of ['agent/pre-step', 'agent/request', 'agent/request-error']) {
    assert.ok(loopSrc.includes(`"${hook}"`), `waterfall hook ${hook} missing — DSH API 漂移，需更新 packages/dsh-adapter`)
  }
  // pre-step 载荷字段与 enter/reject 决策形状（计费埋点读取这些字段）
  assert.match(loopSrc, /waterfall\("agent\/pre-step", \{\s*messages: claimed/)
  assert.match(loopSrc, /kind: "enter"/)
  assert.match(loopSrc, /decision\.kind === "reject"/)
  // request 载荷含 provider/model（model 适配器插桩依据）
  assert.match(loopSrc, /proposedConfig\.provider \|\|/)
})
