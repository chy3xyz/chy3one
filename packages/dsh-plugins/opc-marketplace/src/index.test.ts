import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, plugin, type Config, type PayResult } from './index.js'
import { createMockContext } from '../../../dsh-adapter/src/index.js'
import { OpcError } from '../../../core/src/index.js'
import type { OrderEngine, RevenueSplitter } from '../../../core/src/marketplace/index.js'

function fakeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

function services(ctx: ReturnType<typeof createMockContext>) {
  return {
    orders: ctx.getService('opc.marketplace.orders') as OrderEngine,
    revenue: ctx.getService('opc.marketplace.revenue') as RevenueSplitter,
    pay: ctx.getService('opc.marketplace.pay') as (orderId: string) => Promise<PayResult>,
  }
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

test('plugin: 下单 → 支付 → 自动交付 → 分成 → 创作者余额（US-05 85/15）', async () => {
  const ctx = createMockContext()
  apply(ctx, { currency: 'cents' })
  const { orders, revenue, pay } = services(ctx)

  const order = orders.createOrder(orderInput())
  const { order: delivered, split } = await pay(order.id)

  assert.equal(delivered.id, order.id)
  assert.equal(delivered.status, 'delivered')
  assert.match(delivered.paymentRef!, /^pm_/)
  assert.equal(split.creator, 850)
  assert.equal(split.platform, 150)
  assert.equal(split.authorId, 'author-7')
  assert.equal(revenue.creatorBalance('author-7'), 850)
  assert.equal(revenue.platformRevenue(), 150)
  assert.deepEqual(orders.stats(), { totalPaid: 1, refunded: 0, netRevenue: 1 })

  assert.equal(name, 'opc-marketplace')
  assert.equal(plugin.name, 'opc-marketplace') // cordis Plugin.Function 元数据
  assert.deepEqual(plugin.inject, [])
})

test('plugin: 重复支付幂等——返回原单与既有分成，余额不重复累计', async () => {
  const ctx = createMockContext()
  apply(ctx, { currency: 'cents' })
  const { orders, revenue, pay } = services(ctx)

  const order = orders.createOrder(orderInput())
  const first = await pay(order.id)
  const second = await pay(order.id)

  assert.equal(second.order, first.order)
  assert.equal(second.split, first.split) // recordSplit 幂等返回同一条目
  assert.equal(revenue.creatorBalance('author-7'), 850)
  assert.equal(revenue.platformRevenue(), 150)
  assert.equal(orders.stats().totalPaid, 1)
})

test('plugin: 支付失败抛 PAYMENT_FAILED，订单停留在 pending', async () => {
  const ctx = createMockContext()
  apply(ctx, { currency: 'cents', payment: { failureRate: 1 } })
  const { orders, pay } = services(ctx)

  const order = orders.createOrder(orderInput())
  await assert.rejects(
    () => pay(order.id),
    (e: OpcError) => e.code === 'PAYMENT_FAILED' && e.message.includes('402'),
  )
  assert.equal(order.status, 'pending')
  assert.deepEqual(orders.stats(), { totalPaid: 0, refunded: 0, netRevenue: 0 })
})

test('plugin: 支付超时 30 秒自动取消，迟到支付被拒（PRD 6.1.3，时钟注入）', async () => {
  const clock = fakeClock()
  const ctx = createMockContext()
  apply(ctx, { currency: 'cents', now: clock.now })
  const { orders, pay } = services(ctx)

  const order = orders.createOrder(orderInput())
  clock.advance(31_000)
  const expired = orders.expirePending()

  assert.equal(expired.length, 1)
  assert.equal(expired[0].id, order.id)
  assert.equal(order.status, 'cancelled')
  await assert.rejects(() => pay(order.id), (e: OpcError) => e.code === 'ORDER_STATE_INVALID')
  assert.deepEqual(orders.stats(), { totalPaid: 0, refunded: 0, netRevenue: 0 }, '取消单不计入交易量')
})

test('plugin: 非 cents 计价拒绝（金额全部整型分运算）', () => {
  const ctx = createMockContext()
  assert.throws(
    () => apply(ctx, { currency: 'usd' } as unknown as Config),
    (e: OpcError) => e.code === 'CURRENCY_UNSUPPORTED',
  )
})

test('plugin: pay 未识别订单抛 ORDER_NOT_FOUND', async () => {
  const ctx = createMockContext()
  apply(ctx, { currency: 'cents' })
  const { pay } = services(ctx)
  await assert.rejects(() => pay('nope'), (e: OpcError) => e.code === 'ORDER_NOT_FOUND')
})

test('plugin: 卸载清理服务注册与引擎状态', async () => {
  const ctx = createMockContext()
  apply(ctx, { currency: 'cents' })
  const { orders, pay } = services(ctx)
  const order = orders.createOrder(orderInput())
  await pay(order.id)

  assert.ok(ctx.services.has('opc.marketplace.pay'))
  ctx.unload() // LIFO 逆序执行清理
  assert.equal(ctx.getService('opc.marketplace.orders'), undefined)
  assert.equal(ctx.getService('opc.marketplace.revenue'), undefined)
  assert.equal(ctx.getService('opc.marketplace.pay'), undefined)
})
