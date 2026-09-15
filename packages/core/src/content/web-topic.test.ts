/**
 * CE-01 热点搜索测试：WebSearchTopicSource 鸭子类型对接、去重、
 * WEB_PROVIDER_UNAVAILABLE 等失败的优雅降级（[] + lastError 原因记录）、形状守卫。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WebSearchTopicSource,
  hotSourceRef,
  looksLikeWebSearchService,
  type WebSearchRequestLike,
  type WebSearchResultLike,
} from './web-topic.js'

function fakeWeb(handler: (request: WebSearchRequestLike) => Promise<WebSearchResultLike>) {
  return { search: handler }
}

/** dsh-web WebError 形状：HarnessError 子类，携带机器可路由 code */
function webError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'WebError', code })
}

test('web-topic: mock webService 固定 results → 热点标题去重返回，透传 query/maxResults', async () => {
  const queries: string[] = []
  const web = fakeWeb(async (request) => {
    queries.push(request.query)
    assert.equal(request.maxResults, 5)
    return {
      content: '可选的 provider 摘要',
      truncated: false,
      sources:
        request.query === 'AI 效率'
          ? [
              { url: 'https://a.example.com/1', title: '热点一：AI Agent 框架对比' },
              { url: 'https://a.example.com/2', title: '热点二：大模型价格战' },
            ]
          : [{ url: 'https://b.example.com/1', title: '热点一：AI Agent 框架对比' }], // 跨关键词重复
    }
  })

  const source = new WebSearchTopicSource(web)
  const topics = await source.hotTopics(['AI 效率', '个人成长'])

  assert.deepEqual([...topics].sort(), ['热点一：AI Agent 框架对比', '热点二：大模型价格战'])
  assert.deepEqual([...queries].sort(), ['AI 效率', '个人成长'])
  assert.equal(source.lastError, '')
})

test('web-topic: WEB_PROVIDER_UNAVAILABLE → 空数组优雅降级并记录原因', async () => {
  const web = fakeWeb(async () => {
    throw webError('WEB_PROVIDER_UNAVAILABLE', 'no usable web provider is registered')
  })
  const source = new WebSearchTopicSource(web)

  const topics = await source.hotTopics(['关键词'])

  assert.deepEqual(topics, [])
  assert.ok(source.lastError.includes('WEB_PROVIDER_UNAVAILABLE'))
  assert.ok(source.lastError.includes('no usable web provider'))
})

test('web-topic: 部分关键词失败不影响其余（局部降级），lastError 聚合原因', async () => {
  const web = fakeWeb(async (request) => {
    if (request.query === '坏词') throw webError('WEB_PROVIDER_AMBIGUOUS', 'multiple usable providers')
    return { sources: [{ url: 'https://c.example.com/1', title: '唯一热点' }], truncated: false }
  })
  const source = new WebSearchTopicSource(web)

  const topics = await source.hotTopics(['坏词', '好词'])

  assert.deepEqual(topics, ['唯一热点'])
  assert.ok(source.lastError.includes('WEB_PROVIDER_AMBIGUOUS'))
})

test('web-topic: 标题缺失时回退 snippet，空结果返回 []（常青库兜底信号）', async () => {
  const web = fakeWeb(async () => ({
    sources: [{ url: 'https://d.example.com/1' }, { url: 'https://d.example.com/2', snippet: '快照即标题' }],
    truncated: false,
  }))
  const source = new WebSearchTopicSource(web)

  const topics = await source.hotTopics(['关键词'])

  assert.deepEqual(topics, ['快照即标题']) // 无 title 的 source 不可编造，直接跳过
})

test('web-topic: 空/全空白关键词 → 不发请求直接返回 []', async () => {
  let calls = 0
  const web = fakeWeb(async () => {
    calls++
    return { sources: [], truncated: false }
  })
  const source = new WebSearchTopicSource(web)

  assert.deepEqual(await source.hotTopics([]), [])
  assert.deepEqual(await source.hotTopics(['  ', '']), [])
  assert.equal(calls, 0)
  assert.equal(source.lastError, '')
})

test('web-topic: 形状守卫 — 缺 search 方法的服务不可注入', () => {
  assert.equal(looksLikeWebSearchService(undefined), false)
  assert.equal(looksLikeWebSearchService(null), false)
  assert.equal(looksLikeWebSearchService({}), false)
  assert.equal(looksLikeWebSearchService({ search: 'not-a-function' }), false)
  assert.equal(looksLikeWebSearchService({ search: () => {} }), true)

  assert.throws(() => new WebSearchTopicSource({ nope: 1 }), TypeError)
  assert.doesNotThrow(() => new WebSearchTopicSource({ search: async () => ({ sources: [], truncated: false }) }))
})

test('hotSourceRef: 生成可追溯 hot:// 标识（与 memory://、builtin:// 同构）', () => {
  const ref = hotSourceRef('热点：Agent 框架对比')
  assert.ok(ref.startsWith('hot://search/'))
  assert.ok(ref.includes(encodeURIComponent('热点：Agent 框架对比')))
})
