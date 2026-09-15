/**
 * opc-content 插件测试：服务注册、run 全链路、content_publish 埋点、
 * 策略替换注入（审核必拒 → CONTENT_REVIEW_REJECTED）、runsFile 落盘、卸载清理。
 * 基于 mock OpcContext（真实 cordis 装载语义由 dsh-plugins/cordis-runtime.test.ts 覆盖）。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { OpcError } from '../../../core/src/errors.js'
import { CONTENT_REVIEW_REJECTED } from '../../../core/src/content/pipeline.js'
import type { ReviewStrategy } from '../../../core/src/content/strategy.js'
import { createMockContext, type TelemetryBus, type TelemetryEvent } from '../../../dsh-adapter/src/index.js'
import { apply, name, plugin, type Config, type ContentService } from './index.js'

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

/* ─────────────── 真实智能层（CE-02/CE-03 + 热点搜索） ─────────────── */

/** hermetic：清掉可能存在的环境变量 Key，保证「无 key → 模板」用例不被宿主环境污染 */
const savedEnvKey = process.env['DEEPSEEK_API_KEY']
delete process.env['DEEPSEEK_API_KEY']
after(() => {
  if (savedEnvKey !== undefined) process.env['DEEPSEEK_API_KEY'] = savedEnvKey
})

/** ≥300 字且能过 RuleReviewStrategy 的正文（与 core llm.test.ts 同款约束） */
const LONG_BODY = [
  '先说结论：内容工厂的核心不是灵感，而是可复用的流水线，灵感只是流水线上的原料之一。',
  '拆开看执行层：把选题、撰写、审核、分发四个环节各自定义完成标准与回退路径，任何一环不达标就退回上一环节重做，避免带病上线。',
  '选题环节的完成标准是候选足够多且都带人设相关性评分；撰写环节的标准是篇幅达标、结构完整、每段只解决一个具体问题。',
  '接着用记忆库沉淀每次发布的经验：高转化的标题公式、读者留存的话题方向、审核驳回的原因分类，让下一篇的决策有据可依。',
  '然后把重复动作交给自动化脚本，人工只保留判断与把关，单人也能维持稳定更新节奏，不依赖状态和情绪。',
  '收尾每周复盘一次数据，把高转化篇目的特征写回记忆，让系统随时间复利成长；再配一份常见问答与延伸阅读，方便读者收藏转发。',
].join('\n')

const PLUGIN_WRITE_JSON = JSON.stringify({
  title: 'LLM 直出：内容工厂的流水线实践',
  body: LONG_BODY,
  tags: ['AI', '效率'],
})
const PLUGIN_ANALYSIS_JSON = JSON.stringify({
  angle: '以可复现流水线视角给出差异化定位清单，直接落到下一篇的写作动作上',
  differentiation: [
    '受众颗粒度：面向一人团队而非大厂团队',
    '证据形态：可复现流程替代观点输出',
    '行动闭环：当天可完成的落地清单',
  ],
  personaScore: 4.2,
})

interface RecordedCall {
  authorization: string | undefined
  model?: unknown
  messages?: Array<{ role: string; content: string }>
}

/** 本地 OpenAI 兼容 mock：按 system 内容区分分析/撰写应答 */
async function startMockChatServer(): Promise<{
  url: string
  calls: RecordedCall[]
  close: () => Promise<void>
}> {
  const calls: RecordedCall[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let parsed: { model?: unknown; messages?: Array<{ role: string; content: string }> } = {}
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof parsed
      } catch {
        parsed = {}
      }
      calls.push({ authorization: req.headers.authorization, model: parsed.model, messages: parsed.messages })
      const system = parsed.messages?.[0]?.content ?? ''
      const content = system.includes('内容策略分析师') ? PLUGIN_ANALYSIS_JSON : PLUGIN_WRITE_JSON
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content } }] }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

test('plugin: mode() — 无 key 且宿主无 web 服务 → 纯模板模式', () => {
  const ctx = createMockContext()
  apply(ctx, emptyConfig)
  const service = ctx.getService<ContentService>('opc.content')!
  assert.deepEqual(service.mode(), { llm: false, hotSearch: false })
})

test('plugin: hotSearch:false → 即使宿主提供 web 服务也不注入热点源', () => {
  const ctx = createMockContext()
  ctx.provideService('web', { search: async () => ({ sources: [], truncated: false }) })
  apply(ctx, { hotSearch: false } satisfies Config)
  assert.deepEqual(ctx.getService<ContentService>('opc.content')!.mode(), { llm: false, hotSearch: false })
})

test('plugin: web 服务形状不符 → 不注入热点源（不抛错，常青库兜底）', () => {
  const ctx = createMockContext()
  ctx.provideService('web', { noSearchMethod: true })
  apply(ctx, emptyConfig)
  assert.deepEqual(ctx.getService<ContentService>('opc.content')!.mode(), { llm: false, hotSearch: false })
})

test('plugin: fake key + 本地 mock LLM/web → run() 全链路走 LLM 策略并并入热点', async (t) => {
  const { url, calls, close } = await startMockChatServer()
  t.after(close)

  const ctx = createMockContext()
  ctx.provideService('web', {
    search: async () => ({
      sources: [{ url: 'https://hot.example.com/1', title: '热点：Agent 框架对比' }],
      truncated: false,
    }),
  })
  apply(ctx, {
    deepseekApiKey: 'sk-plugin-fake-key-123456',
    deepseekBaseUrl: url,
    deepseekModel: 'deepseek-chat',
  } satisfies Config)
  const service = ctx.getService<ContentService>('opc.content')!
  assert.deepEqual(service.mode(), { llm: true, hotSearch: true })

  const result = await service.run()

  // 撰写产物来自 LLM 策略（标题为 mock JSON 中的 title，模板标题公式未出现）
  assert.equal(result.draft.title, 'LLM 直出：内容工厂的流水线实践')
  assert.ok(result.draft.body.length >= 300)
  assert.equal(result.draft.platform, 'wechat')

  // Brief：热点 hot:// + 分析 analysis://deepseek 标注
  assert.ok(result.brief.sources.includes('analysis://deepseek'))
  assert.ok(result.brief.sources.some((s) => s.startsWith('hot://')))
  assert.ok(result.brief.differentiation && result.brief.differentiation.length >= 3)

  // 真实流水线照常收尾：过审 + mock 公众号发布 + LLM 自拟标签并入平台 tags
  assert.equal(result.review.pass, true)
  assert.equal(result.publish.success, true)
  assert.match(result.publish.url, /^https:\/\/mp\.weixin\.qq\.com\/s\//)
  assert.ok(result.content.tags.includes('AI'))
  assert.ok(result.content.tags.includes('效率'))

  // 全链路恰好两次 LLM 请求（分析 + 撰写），凭证只在请求头且 body 带 model
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.authorization, 'Bearer sk-plugin-fake-key-123456')
    assert.equal(call.model, 'deepseek-chat')
  }

  // 记忆沉淀 + run 计数
  assert.equal(service.memory.query({ category: 'fact' }).length, 1)
  assert.deepEqual(service.stats(), { runs: 1 })
})
