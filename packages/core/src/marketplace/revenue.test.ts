import test from 'node:test'
import assert from 'node:assert/strict'
import { RevenueSplitter, CREATOR_BPS, PLATFORM_BPS } from './revenue.js'
import { OpcError } from '../errors.js'

/** 确定性 PRNG（mulberry32）：随机金额测试可复现 */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('revenue: 分成比例常量 85/15（US-05）', () => {
  assert.equal(CREATOR_BPS, 8_500)
  assert.equal(PLATFORM_BPS, 1_500)
})

test('revenue: 整百金额精确 85/15', () => {
  const splitter = new RevenueSplitter()
  assert.deepEqual(splitter.split(100), { creator: 85, platform: 15 })
  assert.deepEqual(splitter.split(100_00), { creator: 8_500, platform: 1_500 })
})

test('revenue: 1 分钱创作者拿余数（platform 向下取整）', () => {
  const splitter = new RevenueSplitter()
  assert.deepEqual(splitter.split(1), { creator: 1, platform: 0 })
})

test('revenue: 3 分钱', () => {
  const splitter = new RevenueSplitter()
  const s = splitter.split(3)
  assert.deepEqual(s, { creator: 3, platform: 0 })
  assert.equal(s.creator + s.platform, 3)
})

test('revenue: 99 分钱', () => {
  const splitter = new RevenueSplitter()
  const s = splitter.split(99)
  assert.deepEqual(s, { creator: 85, platform: 14 })
  assert.equal(s.creator + s.platform, 99)
})

test('revenue: 随机 10000 笔金额总和守恒 creator+platform===total，平台抽成误差为 0', () => {
  const splitter = new RevenueSplitter()
  const rng = mulberry32(20260915)
  let grandTotal = 0
  let creatorTotal = 0
  let platformTotal = 0
  for (let i = 0; i < 10_000; i++) {
    const amount = 1 + Math.floor(rng() * 1_000_000) // 1 分 ~ 1 万元（分）
    const { creator, platform } = splitter.split(amount)
    assert.ok(Number.isInteger(creator) && Number.isInteger(platform))
    assert.equal(creator + platform, amount, `第 ${i} 笔守恒失败：${amount}`)
    grandTotal += amount
    creatorTotal += creator
    platformTotal += platform
  }
  // 守恒误差为 0（整型精确）
  assert.equal(creatorTotal + platformTotal, grandTotal)
  // 平台抽成比例误差：每笔向下取整 <1 分，10000 笔累计比例偏差远小于 1e-3
  assert.ok(
    Math.abs(platformTotal / grandTotal - 0.15) < 1e-3,
    `platform ratio drifted: ${platformTotal / grandTotal}`,
  )
  assert.ok(Math.abs(creatorTotal / grandTotal - 0.85) < 1e-3)
})

test('revenue: recordSplit 累计入账，creatorBalance 按作者归集', () => {
  const splitter = new RevenueSplitter(() => 1_000)
  const e1 = splitter.recordSplit('order-1', 100_00, 'author-1')
  splitter.recordSplit('order-2', 200_00, 'author-1')
  splitter.recordSplit('order-3', 50_00, 'author-2')

  assert.equal(e1.recordedAt, 1_000)
  assert.equal(splitter.creatorBalance('author-1'), 8_500 + 17_000) // 25500
  assert.equal(splitter.creatorBalance('author-2'), 4_250)
  assert.equal(splitter.creatorBalance('author-none'), 0)
  assert.equal(splitter.platformRevenue(), 1_500 + 3_000 + 750)
  assert.equal(splitter.listEntries().length, 3)
})

test('revenue: recordSplit 幂等——同 orderId 重复记账不重复分成', () => {
  const splitter = new RevenueSplitter()
  const first = splitter.recordSplit('order-dup', 100_00, 'author-1')
  const again = splitter.recordSplit('order-dup', 100_00, 'author-1')
  assert.equal(again, first)
  assert.equal(splitter.creatorBalance('author-1'), 8_500)
  assert.equal(splitter.platformRevenue(), 1_500)
  assert.equal(splitter.listEntries().length, 1)
})

test('revenue: 非整数/负数金额拒绝（SPLIT_AMOUNT_INVALID）', () => {
  const splitter = new RevenueSplitter()
  assert.throws(() => splitter.split(0.5), (e: OpcError) => e.code === 'SPLIT_AMOUNT_INVALID')
  assert.throws(() => splitter.split(-1), (e: OpcError) => e.code === 'SPLIT_AMOUNT_INVALID')
  assert.throws(() => splitter.recordSplit('o', -5, 'a'), (e: OpcError) => e.code === 'SPLIT_AMOUNT_INVALID')
})

test('revenue: clear 清空账本', () => {
  const splitter = new RevenueSplitter()
  splitter.recordSplit('o1', 100, 'a')
  splitter.clear()
  assert.equal(splitter.listEntries().length, 0)
  assert.equal(splitter.creatorBalance('a'), 0)
})
