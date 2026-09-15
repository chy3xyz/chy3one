import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PersistentOrderEngine,
  PersistentRevenueSplitter,
  SqliteMarketplaceStore,
} from './sqlite-marketplace.js'
import type { Order } from './orders.js'
import { OpcError } from '../errors.js'

/** 可推进假时钟：测 30s 支付超时跨重启无需真实等待 */
function fakeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

/** 每个用例独立 tmpdir，结束自动清理（含 -wal/-shm） */
function tmpDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'opcos-marketplace-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function input(overrides: Partial<Parameters<PersistentOrderEngine['createOrder']>[0]> = {}) {
  return {
    skillId: 'contract-review-skill',
    version: '1.2.0',
    buyerId: 'buyer-42',
    amount: 1_000,
    ...overrides,
  }
}

test('sqlite-marketplace: 下单→支付→交付→重启后 get/list/stats/余额完整恢复', (t) => {
  const db = join(tmpDir(t), 'orders.db')
  const clock = fakeClock()

  // 第一次"进程"：共享同一 store 的持久化引擎
  const store = new SqliteMarketplaceStore(db)
  const orders = new PersistentOrderEngine(store, clock.now)
  const revenue = new PersistentRevenueSplitter(store, clock.now)

  const order = orders.createOrder(input({ authorId: 'author-7' }))
  clock.advance(100)
  orders.markPaid(order.id, 'pm_ref_1')
  clock.advance(50)
  orders.deliver(order.id)
  const split = revenue.recordSplit(order.id, order.amount, 'author-7')
  store.close()

  // 重启：同库重新构造（时钟继续推进，不影响已恢复字段）
  clock.advance(10_000)
  const store2 = new SqliteMarketplaceStore(db)
  t.after(() => store2.close())
  const orders2 = new PersistentOrderEngine(store2, clock.now)
  const revenue2 = new PersistentRevenueSplitter(store2, clock.now)

  const restored = orders2.get(order.id)
  assert.ok(restored, '订单跨重启恢复')
  assert.deepEqual(restored, { ...order }, '订单全字段保真（含 paymentRef/时间戳/authorId）')

  assert.deepEqual(orders2.listByBuyer('buyer-42').map((o) => o.id), [order.id])
  assert.deepEqual(orders2.listBySkill('contract-review-skill').map((o) => o.id), [order.id])
  assert.equal(orders2.listByBuyer('nobody').length, 0)
  assert.deepEqual(orders2.stats(), { totalPaid: 1, refunded: 0, netRevenue: 1 })

  assert.deepEqual([...revenue2.listEntries()], [split])
  assert.equal(revenue2.creatorBalance('author-7'), 850)
  assert.equal(revenue2.platformRevenue(), 150)
})

test('sqlite-marketplace: 退款/取消状态、原因与时间戳跨重启恢复，stats 口径不变', (t) => {
  const db = join(tmpDir(t), 'orders.db')
  const clock = fakeClock()

  const store = new SqliteMarketplaceStore(db)
  const orders = new PersistentOrderEngine(store, clock.now)

  const a = orders.createOrder(input())
  clock.advance(100)
  orders.markPaid(a.id, 'pm_a')
  clock.advance(20)
  orders.refund(a.id, 'buyer remorse')

  clock.advance(10)
  const b = orders.createOrder(input())
  clock.advance(10)
  orders.cancel(b.id, 'buyer changed mind')
  store.close()

  const store2 = new SqliteMarketplaceStore(db)
  t.after(() => store2.close())
  const orders2 = new PersistentOrderEngine(store2, clock.now)

  const ra = orders2.get(a.id) as Order
  assert.equal(ra.status, 'refunded')
  assert.equal(ra.refundReason, 'buyer remorse')
  assert.equal(ra.refundedAt, 120)
  assert.equal(ra.paidAt, 100)

  const rb = orders2.get(b.id) as Order
  assert.equal(rb.status, 'cancelled')
  assert.equal(rb.cancelReason, 'buyer changed mind')
  assert.equal(rb.cancelledAt, 140)
  assert.equal(rb.paymentRef, undefined)

  assert.deepEqual(orders2.stats(), { totalPaid: 1, refunded: 1, netRevenue: 0 })
})

test('sqlite-marketplace: 30s 支付超时跨重启仍生效，且不重复过期（PRD 6.1.3，注入时钟）', (t) => {
  const db = join(tmpDir(t), 'orders.db')
  const clock = fakeClock()

  const store1 = new SqliteMarketplaceStore(db)
  const orders1 = new PersistentOrderEngine(store1, clock.now)
  const a = orders1.createOrder(input()) // t=0
  store1.close()

  clock.advance(31_000) // 重启后时钟已越过 30s 窗口
  const store2 = new SqliteMarketplaceStore(db)
  const orders2 = new PersistentOrderEngine(store2, clock.now)
  assert.equal(orders2.get(a.id)?.status, 'pending', '重启恢复后仍是 pending，超时语义得以延续')

  const expired = orders2.expirePending() // 默认 olderThanMs = 30_000
  assert.equal(expired.length, 1)
  assert.equal(expired[0].id, a.id)
  assert.equal(expired[0].status, 'cancelled')
  assert.ok(expired[0].cancelReason!.includes('payment timeout'))
  assert.equal(orders2.stats().netRevenue, 0)
  store2.close()

  // 再次重启：取消已落库，不产生重复过期/状态回拨
  const store3 = new SqliteMarketplaceStore(db)
  t.after(() => store3.close())
  const orders3 = new PersistentOrderEngine(store3, clock.now)
  assert.equal(orders3.get(a.id)?.status, 'cancelled')
  assert.equal(orders3.expirePending().length, 0)
})

test('sqlite-marketplace: 重复支付幂等跨重启——paymentRef 锁定首次，分成不重复入账', (t) => {
  const db = join(tmpDir(t), 'orders.db')
  const clock = fakeClock()

  const store1 = new SqliteMarketplaceStore(db)
  const orders1 = new PersistentOrderEngine(store1, clock.now)
  const revenue1 = new PersistentRevenueSplitter(store1, clock.now)
  const order = orders1.createOrder(input({ authorId: 'author-1' }))
  clock.advance(100)
  orders1.markPaid(order.id, 'pm_ref_1')
  orders1.deliver(order.id)
  revenue1.recordSplit(order.id, order.amount, 'author-1')
  store1.close()

  const store2 = new SqliteMarketplaceStore(db)
  t.after(() => store2.close())
  const orders2 = new PersistentOrderEngine(store2, clock.now)
  const revenue2 = new PersistentRevenueSplitter(store2, clock.now)

  const again = orders2.markPaid(order.id, 'pm_ref_2') // 迟到重复支付
  assert.equal(again.id, order.id)
  assert.equal(again.paymentRef, 'pm_ref_1', '流水号锁定首次')
  assert.equal(again.paidAt, 100)
  assert.equal(again.status, 'delivered', '状态不被重复支付回拨')

  const entry = revenue2.recordSplit(order.id, order.amount, 'author-1')
  assert.equal(entry.orderId, order.id)
  assert.equal(revenue2.creatorBalance('author-1'), 850)
  assert.equal(revenue2.platformRevenue(), 150)
  assert.equal(revenue2.listEntries().length, 1, '重启后 recordSplit 仍幂等')

  // 落库层面同样无重复行、无字段污染
  const store3 = new SqliteMarketplaceStore(db)
  const orders3 = new PersistentOrderEngine(store3, clock.now)
  const revenue3 = new PersistentRevenueSplitter(store3, clock.now)
  store3.close()
  assert.equal(orders3.get(order.id)?.paymentRef, 'pm_ref_1')
  assert.equal(revenue3.listEntries().length, 1)
})

test('sqlite-marketplace: 分账守恒（creator+platform===amount）与多作者余额跨重启恢复', (t) => {
  const db = join(tmpDir(t), 'orders.db')
  const clock = fakeClock()

  const store1 = new SqliteMarketplaceStore(db)
  const revenue1 = new PersistentRevenueSplitter(store1, clock.now)
  revenue1.recordSplit('o1', 100_00, 'author-1') // 8500 / 1500
  revenue1.recordSplit('o2', 200_00, 'author-1') // 17000 / 3000
  revenue1.recordSplit('o3', 1, 'author-2') // 余数归创作者：1 / 0
  revenue1.recordSplit('o4', 99, 'author-2') // 85 / 14
  store1.close()

  const store2 = new SqliteMarketplaceStore(db)
  t.after(() => store2.close())
  const orders2 = new PersistentOrderEngine(store2, clock.now) // 共库恢复不互相干扰
  const revenue2 = new PersistentRevenueSplitter(store2, clock.now)

  for (const e of revenue2.listEntries()) {
    assert.equal(e.creator + e.platform, e.amount, `order ${e.orderId} 守恒失败`)
  }
  assert.equal(revenue2.creatorBalance('author-1'), 8_500 + 17_000)
  assert.equal(revenue2.creatorBalance('author-2'), 1 + 85)
  assert.equal(revenue2.creatorBalance('author-none'), 0)
  assert.equal(revenue2.platformRevenue(), 1_500 + 3_000 + 0 + 14)
  assert.equal(orders2.stats().totalPaid, 0, 'orders 与 split_ledger 互不串数据')
})

test('sqlite-marketplace: 非法输入/越状态转移不落库，ORDER_NOT_FOUND 跨重启一致', (t) => {
  const db = join(tmpDir(t), 'orders.db')
  const clock = fakeClock()

  const store1 = new SqliteMarketplaceStore(db)
  const orders1 = new PersistentOrderEngine(store1, clock.now)
  const order = orders1.createOrder(input())

  assert.throws(
    () => orders1.createOrder(input({ amount: 9.9 })),
    (e: OpcError) => e.code === 'ORDER_AMOUNT_INVALID',
  )
  assert.throws(
    () => orders1.deliver(order.id), // pending 直接 deliver
    (e: OpcError) => e.code === 'ORDER_STATE_INVALID',
  )
  assert.throws(
    () => orders1.markPaid('missing', 'pm_x'),
    (e: OpcError) => e.code === 'ORDER_NOT_FOUND',
  )
  store1.close()

  const store2 = new SqliteMarketplaceStore(db)
  t.after(() => store2.close())
  const orders2 = new PersistentOrderEngine(store2, clock.now)
  assert.equal(orders2.get(order.id)?.status, 'pending', '失败转移不落库')
  assert.equal(orders2.listByBuyer('buyer-42').length, 1, '非法下单不产生脏行')
  assert.throws(() => orders2.markPaid('missing', 'pm_x'), (e: OpcError) => e.code === 'ORDER_NOT_FOUND')
})

test('sqlite-marketplace: clear 同时清空内存与库，重启后为空', (t) => {
  const db = join(tmpDir(t), 'orders.db')
  const clock = fakeClock()

  const store1 = new SqliteMarketplaceStore(db)
  const orders1 = new PersistentOrderEngine(store1, clock.now)
  const revenue1 = new PersistentRevenueSplitter(store1, clock.now)
  const o = orders1.createOrder(input())
  orders1.markPaid(o.id, 'pm_1')
  revenue1.recordSplit(o.id, o.amount, 'a')
  orders1.clear()
  revenue1.clear()
  store1.close()

  const store2 = new SqliteMarketplaceStore(db)
  t.after(() => store2.close())
  const orders2 = new PersistentOrderEngine(store2, clock.now)
  const revenue2 = new PersistentRevenueSplitter(store2, clock.now)
  assert.equal(orders2.listByBuyer('buyer-42').length, 0)
  assert.deepEqual(orders2.stats(), { totalPaid: 0, refunded: 0, netRevenue: 0 })
  assert.equal(revenue2.listEntries().length, 0)
  assert.equal(revenue2.platformRevenue(), 0)
})

test('sqlite-marketplace: 传 dbPath 各自开库（自管 close）同样可用', (t) => {
  const db = join(tmpDir(t), 'orders.db')
  const clock = fakeClock()

  const orders = new PersistentOrderEngine(db, clock.now)
  const revenue = new PersistentRevenueSplitter(db, clock.now)
  const o = orders.createOrder(input({ authorId: 'author-9' }))
  orders.markPaid(o.id, 'pm_path')
  revenue.recordSplit(o.id, o.amount, 'author-9')
  orders.close() // 各自关闭自开连接
  revenue.close()

  const store = new SqliteMarketplaceStore(db)
  t.after(() => store.close())
  const orders2 = new PersistentOrderEngine(store, clock.now)
  const revenue2 = new PersistentRevenueSplitter(store, clock.now)
  assert.equal(orders2.get(o.id)?.status, 'paid')
  assert.equal(orders2.get(o.id)?.paymentRef, 'pm_path')
  assert.equal(revenue2.creatorBalance('author-9'), 850)
})
