/**
 * opc-content 插件测试：服务注册、run 全链路、content_publish 埋点、
 * 策略替换注入（审核必拒 → CONTENT_REVIEW_REJECTED）、runsFile 落盘、卸载清理。
 * 基于 mock OpcContext（真实 cordis 装载语义由 dsh-plugins/cordis-runtime.test.ts 覆盖）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpcError } from '../../../core/src/errors.js'
import { CONTENT_REVIEW_REJECTED } from '../../../core/src/content/pipeline.js'
import type { ReviewStrategy } from '../../../core/src/content/strategy.js'
import { createMockContext, type TelemetryBus, type TelemetryEvent } from '../../../dsh-adapter/src/index.js'
import { apply, name, plugin, type ContentService } from './index.js'

/** 缺省配置：纯内存运行，测试无落盘副作用 */
const emptyConfig = {}

test('plugin: 注册 opc.content 与 opc.content.events 服务', () => {
  const ctx = createMockContext()
  apply(ctx, emptyConfig)

  assert.equal(name, 'opc-content')
  assert.equal(plugin.name, 'opc-content') // cordis Plugin.Function 元数据
  assert.deepEqual(plugin.inject, [])
  assert.ok(ctx.services.has('opc.content'))
  assert.ok(ctx.services.has('opc.content.events'))

  // 人设记忆直通（七类 MemoryCategory）
  const service = ctx.getService<ContentService>('opc.content')!
  const entry = service.memory.write({ scope: 'global', category: 'soul', content: '测试人设', confidence: 0.9 })
  assert.ok(entry.id.length > 0)
  assert.equal(service.memory.query({ category: 'soul' }).length, 1)
  assert.deepEqual(service.stats(), { runs: 0 })
})

test('plugin: run() 全链路 — 发布成功、content_publish 埋点、fact 记忆、runsFile 落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-content-'))
  const runsFile = join(dir, 'runs.jsonl')
  try {
    const ctx = createMockContext()
    apply(ctx, { runsFile })

    const events: TelemetryEvent[] = []
    ctx.getService<TelemetryBus>('opc.content.events')!.subscribe((e) => events.push(e))

    const service = ctx.getService<ContentService>('opc.content')!
    const result = await service.run()

    // 全链路产物
    assert.equal(result.publish.success, true)
    assert.match(result.publish.url, /^https:\/\/mp\.weixin\.qq\.com\/s\//)
    assert.equal(result.review.pass, true)
    assert.equal(result.draft.platform, 'wechat')

    // PRD 7.5 埋点
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'content_publish')
    assert.equal(events[0].payload?.platform, 'wechat')
    assert.equal(events[0].payload?.title, result.draft.title)

    // 记忆沉淀 + run 计数
    assert.equal(service.memory.query({ category: 'fact' }).length, 1)
    assert.deepEqual(service.stats(), { runs: 1 })

    // runs JSONL：一行一条，可反序列化
    const lines = readFileSync(runsFile, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0]) as { platform?: string; publish?: { url: string } }
    assert.equal(parsed.publish?.url, result.publish.url)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugin: 策略替换注入 — 必拒审核触发 CONTENT_REVIEW_REJECTED 且 lesson 落库', async () => {
  const ctx = createMockContext()
  apply(ctx, emptyConfig)
  const service = ctx.getService<ContentService>('opc.content')!

  const alwaysViolating: ReviewStrategy = {
    review: async () => ({
      pass: false,
      score: 0,
      violations: [{ type: 'absolute-claim', severity: 'high', detail: '注入的必拒策略' }],
    }),
  }
  service.setStrategies({ reviewStrategy: alwaysViolating })

  await assert.rejects(
    () => service.run(),
    (err: unknown) => err instanceof OpcError && err.code === CONTENT_REVIEW_REJECTED,
  )
  assert.equal(service.memory.query({ category: 'lesson' }).length, 1)
  assert.equal(service.memory.query({ category: 'fact' }).length, 0)
  assert.deepEqual(service.stats(), { runs: 1 }) // 失败同样计入 run 次数
})

test('plugin: 卸载清理 (AC-07)', () => {
  const ctx = createMockContext()
  apply(ctx, emptyConfig)
  assert.ok(ctx.services.has('opc.content'))
  ctx.unload() // LIFO 执行 onDispose：计数复位，服务随注册表撤销
  assert.equal(ctx.getService('opc.content'), undefined)
  assert.equal(ctx.getService('opc.content.events'), undefined)
})
