import test from 'node:test'
import assert from 'node:assert/strict'
import { MultiPlatformDispatcher, MockPlatformAdapter, PLATFORMS, defaultPlatformAdapters } from './platforms.js'
import type { PlatformContent } from './types.js'

const CONTENT: PlatformContent = {
  platform: 'wechat',
  title: 'AI 落地页工具选购指南',
  htmlBody: '<p>第一段</p><p>第二段</p>',
  tags: ['AI', '建站'],
  schemaJsonLd: '{"@context":"https://schema.org"}',
}

test('platforms: 五平台矩阵与展示名（CO-03 平台清单）', () => {
  assert.deepEqual([...PLATFORMS], ['wechat', 'xiaohongshu', 'douyin', 'twitter', 'bilibili'])
  assert.equal(defaultPlatformAdapters().length, 5)
})

test('platforms: 分发器全平台成功 + 逐平台适配耗时（CO-03 <30s/平台）', async () => {
  const dispatcher = new MultiPlatformDispatcher(defaultPlatformAdapters())
  const report = await dispatcher.dispatch(CONTENT)
  assert.equal(report.success, true)
  assert.equal(report.dispatches.length, 5)
  for (const d of report.dispatches) {
    assert.equal(d.result.success, true)
    assert.ok(d.result.url.length > 0)
    assert.ok(d.adaptationMs < 30_000, 'CO-03 验收：适配时间 <30s/平台')
  }
  // 平台形态差异：Twitter 截断到 280、小红书去 HTML 标签
  const twitter = report.dispatches.find((d) => d.platform === 'twitter')
  assert.ok(twitter)
  const douyin = report.dispatches.find((d) => d.platform === 'douyin')
  assert.ok(douyin)
})

test('platforms: 单平台失败不阻断其余平台（异常隔离）', async () => {
  const failing = {
    platform: 'douyin',
    publish: async () => {
      throw new Error('rate limited')
    },
  }
  const dispatcher = new MultiPlatformDispatcher([...defaultPlatformAdapters(['wechat', 'bilibili']), failing])
  const report = await dispatcher.dispatch(CONTENT)
  assert.equal(report.dispatches.length, 3)
  assert.equal(report.success, false, '任一平台失败 → 整体 success=false')
  assert.equal(report.dispatches.find((d) => d.platform === 'douyin')?.result.success, false)
  assert.equal(report.dispatches.find((d) => d.platform === 'wechat')?.result.success, true)
})

test('platforms: MockPlatformAdapter 单平台发布回执', async () => {
  const adapter = new MockPlatformAdapter('xiaohongshu')
  const result = await adapter.publish(CONTENT)
  assert.equal(result.platform, 'xiaohongshu')
  assert.ok(result.url.startsWith('https://www.xiaohongshu.com/'))
  assert.equal(result.success, true)
})
