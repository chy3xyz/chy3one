import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, DEFAULT_ORDERS_DB, type PayResult } from './index.js'
import { createMockContext } from '../../../dsh-adapter/src/index.js'
import {
  OrderEngine,
  RevenueSplitter,
  SqliteMarketplaceStore,
  PersistentOrderEngine,
  PersistentRevenueSplitter,
} from '../../../core/src/marketplace/index.js'

function fakeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

function tmpDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'opcos-marketplace-plugin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function orderInput(overrides: Partial<Parameters<OrderEngine['createOrder']>[0]> = {}) {
  return {
    skillId: 'contract-review-skill',
    version: '1.2.0',
    buyerId: 'buyer-42',
    amount: 1_000,
    authorId: 'author-7',
    ...overrides,
  }
}

test('plugin ordersDb: 配置持久化路径后引擎落库，卸载关库不清库', async (t) => {
  const db = join(tmpDir(t), 'orders.db')
  const ctx = createMockContext()
  apply(ctx, { currency: 'cents', ordersDb: db })

  const orders = ctx.getService('opc.marketplace.orders') as OrderEngine
  const revenue = ctx.getService('opc.marketplace.revenue') as RevenueSplitter
  const pay = ctx.getService('opc.marketplace.pay') as (orderId: string) => Promise<PayResult>
  assert.ok(orders instanceof PersistentOrderEngine, 'orders 服务换用持久化引擎')
  assert.ok(revenue instanceof PersistentRevenueSplitter, 'revenue 服务换用持久化引擎')

  const order = orders.createOrder(orderInput())
  const { order: delivered, split } = await pay(order.id)
  assert.equal(delivered.status, 'delivered')
  assert.equal(split.creator, 850)
  assert.equal(split.platform, 150)

  ctx.unload() // 优雅卸载：关闭库句柄而非 clear（clear 会删光已持久化数据）
  assert.equal(ctx.getService('opc.marketplace.orders'), undefined)
  assert.equal(ctx.getService('opc.marketplace.pay'), undefined)

  // 卸载后数据仍在库中：直接重开验证
  const store = new SqliteMarketplaceStore(db)
  const orders2 = new PersistentOrderEngine(store)
  const revenue2 = new PersistentRevenueSplitter(store)
  assert.equal(orders2.get(order.id)?.status, 'delivered')
  assert.match(orders2.get(order.id)?.paymentRef ?? '', /^pm_/)
  assert.equal(revenue2.creatorBalance('author-7'), 850)
  assert.equal(revenue2.platformRevenue(), 150)
  store.close()
})

test('plugin ordersDb: 同路径重新加载插件即恢复订单/统计/余额，重复支付幂等不重复入账', async (t) => {
  const db = join(tmpDir(t), 'orders.db')
  const clock = fakeClock()

  const ctx1 = createMockContext()
  apply(ctx1, { currency: 'cents', now: clock.now, ordersDb: db })
  const orders1 = ctx1.getService('opc.marketplace.orders') as OrderEngine
  const pay1 = ctx1.getService('opc.marketplace.pay') as (orderId: string) => Promise<PayResult>
  const order = orders1.createOrder(orderInput())
  await pay1(order.id)
  ctx1.unload()

  // "重启"：同库重新加载插件（时钟继续推进）
  clock.advance(10_000)
  const ctx2 = createMockContext()
  apply(ctx2, { currency: 'cents', now: clock.now, ordersDb: db })
  const orders2 = ctx2.getService('opc.marketplace.orders') as OrderEngine
  const revenue2 = ctx2.getService('opc.marketplace.revenue') as RevenueSplitter
  const pay2 = ctx2.getService('opc.marketplace.pay') as (orderId: string) => Promise<PayResult>

  const restored = orders2.get(order.id)
  assert.ok(restored)
  assert.equal(restored.status, 'delivered')
  assert.match(restored.paymentRef!, /^pm_/)
  assert.deepEqual(orders2.stats(), { totalPaid: 1, refunded: 0, netRevenue: 1 })
  assert.equal(revenue2.creatorBalance('author-7'), 850)
  assert.equal(revenue2.platformRevenue(), 150)

  // 重启后重复支付：返回原单与既有分成，余额不重复累计
  const second = await pay2(order.id)
  assert.equal(second.order.id, order.id)
  assert.equal(second.order.paymentRef, restored.paymentRef)
  assert.equal(second.split.orderId, order.id)
  assert.equal(revenue2.creatorBalance('author-7'), 850)
  assert.equal(revenue2.platformRevenue(), 150)
  ctx2.unload()
})

test('plugin ordersDb: 未配置时保持内存版引擎与默认路径常量（向后兼容）', () => {
  const ctx = createMockContext()
  apply(ctx, { currency: 'cents' })
  const orders = ctx.getService('opc.marketplace.orders') as OrderEngine
  const revenue = ctx.getService('opc.marketplace.revenue') as RevenueSplitter
  assert.ok(orders instanceof OrderEngine)
  assert.ok(!(orders instanceof PersistentOrderEngine), '默认仍是内存版')
  assert.ok(!(revenue instanceof PersistentRevenueSplitter), '默认仍是内存版')
  ctx.unload()

  assert.equal(DEFAULT_ORDERS_DB, './opcos-orders.db')
})
