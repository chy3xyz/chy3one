/**
 * Content Engine 真实智能层测试（CE-02/CE-03）：
 * 本地 node:http 起 OpenAI 兼容 mock 服务，覆盖 DeepSeekChatClient 成功/非 200/
 * 网络错误/超时，DeepSeekWriteStrategy 与 DeepSeekAnalysisStrategy 的契约解析、
 * 扩写、热点候选并入与模板回退。Key 脱敏（错误信息不泄漏凭证）一并断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { OpcError } from '../errors.js'
import { JsonlMemoryStore } from '../memory/memory.js'
import {
  DeepSeekAnalysisStrategy,
  DeepSeekChatClient,
  DeepSeekWriteStrategy,
  LLM_REQUEST_FAILED,
} from './llm.js'
import { TemplateTopicStrategy, TemplateWriteStrategy, type WriteStrategy } from './strategy.js'
import { hotSourceRef } from './web-topic.js'
import type { Brief } from './types.js'

/* ─────────────── 测试夹具 ─────────────── */

/** ≥300 字且能过 RuleReviewStrategy 的正文（无绝对化/禁词/未证实断言） */
const LONG_BODY = [
  '先说结论：内容工厂的核心不是灵感，而是可复用的流水线，灵感只是流水线上的原料之一。',
  '拆开看执行层：把选题、撰写、审核、分发四个环节各自定义完成标准与回退路径，任何一环不达标就退回上一环节重做，避免带病上线。',
  '选题环节的完成标准是候选足够多且都带人设相关性评分；撰写环节的标准是篇幅达标、结构完整、每段只解决一个具体问题。',
  '接着用记忆库沉淀每次发布的经验：高转化的标题公式、读者留存的话题方向、审核驳回的原因分类，让下一篇的决策有据可依。',
  '然后把重复动作交给自动化脚本，人工只保留判断与把关，单人也能维持稳定更新节奏，不依赖状态和情绪。',
  '收尾每周复盘一次数据，把高转化篇目的特征写回记忆，让系统随时间复利成长；再配一份常见问答与延伸阅读，方便读者收藏转发。',
].join('\n')

interface RecordedCall {
  path: string | undefined
  method: string | undefined
  authorization: string | undefined
  model?: unknown
  messages?: Array<{ role: string; content: string }>
}

interface MockReply {
  status?: number
  /** 直接回 JSON 体（默认包成 OpenAI choices 形状） */
  content?: string
  /** 完全接管响应体 */
  raw?: string
}

type ChatResponder = (call: RecordedCall) => MockReply

/** 本地 OpenAI 兼容 mock：记录每次请求（路径/凭证头/body），按 responder 脚本应答 */
async function startMockChatServer(responder: ChatResponder): Promise<{
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
      calls.push({
        path: req.url,
        method: req.method,
        authorization: req.headers.authorization,
        model: parsed.model,
        messages: parsed.messages,
      })
      const reply = responder(calls[calls.length - 1])
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
      res.end(
        reply.raw ??
          JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: reply.content ?? '' } }] }),
      )
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/** 永不应答的 mock（测超时中止） */
async function startHangingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(() => {
    /* 不响应，等客户端超时 */
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/** 计数代理：包一层模板策略（透传 lastExpansions 视图），观察回退是否发生 */
function countingFallback(
  base: TemplateWriteStrategy,
): { strategy: WriteStrategy & { lastExpansions?: number }; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    strategy: {
      get lastExpansions() {
        return base.lastExpansions
      },
      write: async (brief, memory, feedback) => {
        calls++
        return base.write(brief, memory, feedback)
      },
    },
  }
}

const BRIEF: Brief = { title: '测试选题', angle: '测试角度', personaScore: 4.5, sources: ['test'] }

const WRITE_JSON = JSON.stringify({ title: 'LLM 直出标题', body: LONG_BODY, tags: ['AI', '效率'] })
const ANALYSIS_JSON = JSON.stringify({
  angle: '以单人流水线视角拆解同题内容的写法套路，给出可直接复用的差异化定位清单',
  differentiation: [
    '受众颗粒度：面向一人团队，而非市场常见的大厂团队视角',
    '证据形态：以可复现流程与清单替代常见的观点输出',
    '行动闭环：给出当天可完成的落地步骤，而非停留在认知层',
  ],
  personaScore: 4.6,
})

/* ─────────────── DeepSeekChatClient ─────────────── */

test('DeepSeekChatClient: 成功路径 — POST /chat/completions、Bearer 凭证头、body 含 model', async (t) => {
  const { url, calls, close } = await startMockChatServer(() => ({ content: '分析完成：结论如下' }))
  t.after(close)

  const client = new DeepSeekChatClient('sk-test-key-abcdef123456', { baseUrl: url, model: 'deepseek-chat', timeoutMs: 2000 })
  const out = await client.complete('系统指令', '用户问题')

  assert.equal(out, '分析完成：结论如下')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/chat/completions')
  assert.equal(calls[0].method, 'POST')
  // 凭证只应出现在请求头里（且不回传到任何日志/错误面）
  assert.equal(calls[0].authorization, 'Bearer sk-test-key-abcdef123456')
  assert.equal(calls[0].model, 'deepseek-chat')
  assert.deepEqual(
    calls[0].messages?.map((m) => ({ role: m.role, content: m.content })),
    [
      { role: 'system', content: '系统指令' },
      { role: 'user', content: '用户问题' },
    ],
  )
})

test('DeepSeekChatClient: 非 200 → LLM_REQUEST_FAILED，错误信息脱敏（Key 不泄漏）', async (t) => {
  const key = 'sk-super-secret-987654'
  const { url, close } = await startMockChatServer(() => ({
    status: 401,
    raw: JSON.stringify({
      error: { message: `invalid api key: ${key} (Authorization: Bearer ${key}, also tried sk-foreign-token-424242)` },
    }),
  }))
  t.after(close)

  const client = new DeepSeekChatClient(key, { baseUrl: url, timeoutMs: 2000 })
  await assert.rejects(
    () => client.complete('s', 'u'),
    (err: unknown) => {
      assert.ok(err instanceof OpcError)
      assert.equal((err as OpcError).code, LLM_REQUEST_FAILED)
      const message = (err as Error).message
      assert.ok(message.includes('401'), '应携带 HTTP 状态码')
      assert.ok(!message.includes(key), '错误信息不得包含原始 Key')
      assert.ok(!message.includes('foreign-token-424242'), '无关令牌也应被打码')
      assert.ok(message.includes('sk-***'), `sk- 令牌应脱敏: ${message}`)
      assert.ok(message.includes('Bearer ***'), 'Bearer 凭证应打码')
      return true
    },
  )
})

test('DeepSeekChatClient: 网络错误（连接拒绝）→ LLM_REQUEST_FAILED', async () => {
  // 端口 9（discard）：本机无监听，fetch 立即 ECONNREFUSED
  const client = new DeepSeekChatClient('sk-test-key-abcdef123456', { baseUrl: 'http://127.0.0.1:9', timeoutMs: 1000 })
  await assert.rejects(
    () => client.complete('s', 'u'),
    (err: unknown) => err instanceof OpcError && (err as OpcError).code === LLM_REQUEST_FAILED,
  )
})

test('DeepSeekChatClient: 超时中止 → LLM_REQUEST_FAILED', async (t) => {
  const { url, close } = await startHangingServer()
  t.after(close)

  const client = new DeepSeekChatClient('sk-test-key-abcdef123456', { baseUrl: url, timeoutMs: 100 })
  const startedAt = Date.now()
  await assert.rejects(
    () => client.complete('s', 'u'),
    (err: unknown) => err instanceof OpcError && (err as OpcError).code === LLM_REQUEST_FAILED,
  )
  assert.ok(Date.now() - startedAt < 5000, '应在超时上限附近中止，而非无限等待')
})

/* ─────────────── DeepSeekWriteStrategy（CE-03） ─────────────── */

test('DeepSeekWriteStrategy: 合法 JSON（含围栏）→ 产出 Draft，tags 透传，不走回退', async (t) => {
  const { url, calls, close } = await startMockChatServer(() => ({
    content: "```json\n" + WRITE_JSON + "\n```", // 容忍代码围栏
  }))
  t.after(close)

  const fallback = countingFallback(new TemplateWriteStrategy())
  const strategy = new DeepSeekWriteStrategy(new DeepSeekChatClient('sk-test-key-abcdef123456', { baseUrl: url }), fallback.strategy)

  const draft = await strategy.write(BRIEF, new JsonlMemoryStore())

  assert.equal(draft.title, 'LLM 直出标题')
  assert.equal(draft.body, LONG_BODY)
  assert.equal(draft.platform, 'wechat')
  assert.deepEqual(draft.tags, ['AI', '效率'])
  assert.equal(strategy.lastExpansions, 0)
  assert.equal(fallback.calls(), 0)
  assert.equal(calls.length, 1)
})

test('DeepSeekWriteStrategy: 坏 JSON → 回退模板策略产出（≥300 字）', async (t) => {
  const { url, close } = await startMockChatServer(() => ({ content: '抱歉，我不能输出 JSON。' }))
  t.after(close)

  const base = new TemplateWriteStrategy()
  const fallback = countingFallback(base)
  const strategy = new DeepSeekWriteStrategy(new DeepSeekChatClient('sk-test-key-abcdef123456', { baseUrl: url }), fallback.strategy)

  const draft = await strategy.write(BRIEF, new JsonlMemoryStore())

  assert.equal(fallback.calls(), 1)
  assert.equal(draft.title, `${BRIEF.title}：从原理到落地的 3 个步骤`) // 模板标题公式
  assert.ok(draft.body.length >= 300)
  assert.equal(strategy.lastExpansions, base.lastExpansions) // 透传模板扩写统计
})

test('DeepSeekWriteStrategy: 短文触发一轮 LLM 扩写（PRD 6.3.4），扩写后达标', async (t) => {
  const { url, calls, close } = await startMockChatServer(({ messages }) => {
    const user = messages?.[1]?.content ?? ''
    return user.includes('扩写')
      ? { content: JSON.stringify({ title: '扩写后标题', body: LONG_BODY, tags: ['扩写'] }) }
      : { content: JSON.stringify({ title: '短稿标题', body: '太短。' }) }
  })
  t.after(close)

  const strategy = new DeepSeekWriteStrategy(
    new DeepSeekChatClient('sk-test-key-abcdef123456', { baseUrl: url }),
    new TemplateWriteStrategy(),
  )
  const draft = await strategy.write(BRIEF, new JsonlMemoryStore())

  assert.equal(calls.length, 2)
  assert.equal(draft.title, '扩写后标题')
  assert.equal(draft.body, LONG_BODY)
  assert.equal(strategy.lastExpansions, 1)
})

/* ─────────────── DeepSeekAnalysisStrategy（CE-02） ─────────────── */

/** 假热点源：固定返回两条热点（source:'hot' 并入候选） */
const hotSource = {
  hotTopics: async (keywords: string[]) =>
    keywords.length > 0 ? ['热点：AI 编程助手横评', '热点：大模型价格战'] : [],
}

function analysisMemory(): JsonlMemoryStore {
  const memory = new JsonlMemoryStore()
  memory.write({ scope: 'global', category: 'topic', content: '跨境电商独立站SEO实战', confidence: 0.8 })
  memory.write({ scope: 'global', category: 'soul', content: '理性务实的独立开发者人设', confidence: 0.95 })
  return memory
}

test('DeepSeekAnalysisStrategy: 契约 JSON → Brief 含 differentiation≥3、hot/analysis 标注、personaScore', async (t) => {
  const { url, calls, close } = await startMockChatServer(() => ({ content: ANALYSIS_JSON }))
  t.after(close)

  const strategy = new DeepSeekAnalysisStrategy(
    new DeepSeekChatClient('sk-test-key-abcdef123456', { baseUrl: url }),
    new TemplateTopicStrategy(hotSource),
  )

  const brief = await strategy.pick(analysisMemory())

  // 落题 = 输入候选中人设分最高者（记忆直连 4.8 > 热点 3.0）
  assert.equal(brief.title, '跨境电商独立站SEO实战')
  assert.ok(brief.angle.startsWith('以单人流水线视角'))
  assert.equal(brief.personaScore, 4.6)
  assert.ok(brief.differentiation && brief.differentiation.length >= 3, '差异化维度 ≥3')
  // 来源标注：热点 hot:// + 落题 memory:// + 分析 analysis://deepseek
  assert.ok(brief.sources.includes('analysis://deepseek'))
  assert.ok(brief.sources.some((s) => s.startsWith('hot://')))
  assert.ok(brief.sources.some((s) => s.startsWith('memory://topic/')))

  // 输入候选并入热点：LLM user 消息带 [hot] 标注与热点标题
  assert.equal(calls.length, 1)
  const user = calls[0].messages?.[1]?.content ?? ''
  assert.ok(user.includes('[hot]'))
  assert.ok(user.includes('热点：大模型价格战'))
  assert.ok(user.includes('跨境电商独立站SEO实战'))
})

test('DeepSeekAnalysisStrategy: 坏 JSON → 回退模板选题（无 analysis 标注）', async (t) => {
  const { url, close } = await startMockChatServer(() => ({ content: '不是 JSON 的分析结论。' }))
  t.after(close)

  const strategy = new DeepSeekAnalysisStrategy(
    new DeepSeekChatClient('sk-test-key-abcdef123456', { baseUrl: url }),
    new TemplateTopicStrategy(hotSource),
  )

  const brief = await strategy.pick(analysisMemory())

  assert.ok(!brief.sources.includes('analysis://deepseek'))
  assert.ok(brief.sources[0].startsWith('memory://topic/'))
  assert.equal(brief.differentiation, undefined) // 模板策略不产生差异化维度
})

test('DeepSeekAnalysisStrategy: 差异化维度不足 3 → 契约违约，回退模板选题', async (t) => {
  const { url, close } = await startMockChatServer(() => ({
    content: JSON.stringify({
      angle: '只有两个维度的偷懒回答',
      differentiation: ['维度一：x', '维度二：y'],
      personaScore: 4.0,
    }),
  }))
  t.after(close)

  const strategy = new DeepSeekAnalysisStrategy(
    new DeepSeekChatClient('sk-test-key-abcdef123456', { baseUrl: url }),
    new TemplateTopicStrategy(hotSource),
  )

  const brief = await strategy.pick(analysisMemory())
  assert.ok(!brief.sources.includes('analysis://deepseek'))
  assert.ok(brief.sources[0].startsWith('memory://topic/'))
})

test('hotSourceRef: 生成可追溯 hot:// 标识', () => {
  const ref = hotSourceRef('热点：AI 编程')
  assert.ok(ref.startsWith('hot://search/'))
  assert.ok(ref.includes(encodeURIComponent('热点：AI 编程')))
})
