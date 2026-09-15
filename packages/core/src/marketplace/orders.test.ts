import test from 'node:test'
import assert from 'node:assert/strict'
import { OrderEngine, PAYMENT_TIMEOUT_MS } from './orders.js'
import { OpcError } from '../errors.js'

/** 可推进假时钟：测 30s 支付超时无需真实等待 */
function fakeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

function input(overrides: Partial<Parameters<OrderEngine['createOrder']>[0]> = {}) {
  return { skillId: 'contract-review-skill', version: '1.2.0', buyerId: 'buyer-42', amount: 990, ...overrides }
}

test('orders: 创建订单为 pending，id 为 UUID 并锁定 skillId/version', () => {
  const engine = new OrderEngine()
  const order = engine.createOrder(input())
  assert.equal(order.status, 'pending')
  assert.match(order.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(order.skillId, 'contract-review-skill')
  assert.equal(order.version, '1.2.0')
  assert.equal(order.buyerId, 'buyer-42')
  assert.equal(engine.get(order.id), order)
})

test('orders: 非法金额/缺字段拒绝下单', () => {
  const engine = new OrderEngine()
  assert.throws(() => engine.createOrder(input({ amount: 9.9 })), (e: OpcError) => e.code === 'ORDER_AMOUNT_INVALID')
  assert.throws(() => engine.createOrder(input({ amount: 0 })), (e: OpcError) => e.code === 'ORDER_AMOUNT_INVALID')
  assert.throws(() => engine.createOrder(input({ buyerId: '' })), (e: OpcError) => e.code === 'ORDER_INPUT_INVALID')
})

test('orders: pending → paid → delivered 正常流转', () => {
  const clock = fakeClock()
  const engine = new OrderEngine(clock.now)
  const order = engine.createOrder(input())

  clock.advance(100)
  const paid = engine.markPaid(order.id, 'pm_ref_1')
  assert.equal(paid.status, 'paid')
  assert.equal(paid.paymentRef, 'pm_ref_1')
  assert.equal(paid.paidAt, 100)

  clock.advance(50)
  const delivered = engine.deliver(order.id)
  assert.equal(delivered.status, 'delivered')
  assert.equal(delivered.deliveredAt, 150)
})

test('orders: 重复支付幂等——已 paid/delivered 直接返回原单，paymentRef 不变', () => {
  const engine = new OrderEngine()
  const order = engine.createOrder(input())
  engine.markPaid(order.id, 'pm_ref_1')
  engine.deliver(order.id)

  const again = engine.markPaid(order.id, 'pm_ref_2')
  assert.equal(again, order) // 同一对象（原单）
  assert.equal(again.paymentRef, 'pm_ref_1') // 流水号锁定首次
  assert.equal(again.status, 'delivered') // 状态不被重复支付回拨
})

test('orders: refund 允许 paid/delivered，记录退款原因', () => {
  const engine = new OrderEngine()
  const o1 = engine.createOrder(input())
  engine.markPaid(o1.id, 'pm_a')
  const r1 = engine.refund(o1.id, 'buyer remorse')
  assert.equal(r1.status, 'refunded')
  assert.equal(r1.refundReason, 'buyer remorse')

  const o2 = engine.createOrder(input())
  engine.markPaid(o2.id, 'pm_b')
  engine.deliver(o2.id)
  assert.equal(engine.refund(o2.id, 'defect').status, 'refunded')
})

test('orders: cancel 仅允许 pending', () => {
  const engine = new OrderEngine()
  const o1 = engine.createOrder(input())
  const cancelled = engine.cancel(o1.id, 'buyer changed mind')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cancelReason, 'buyer changed mind')

  const o2 = engine.createOrder(input())
  engine.markPaid(o2.id, 'pm_c')
  assert.throws(() => engine.cancel(o2.id), (e: OpcError) => e.code === 'ORDER_STATE_INVALID')
})

test('orders: 越状态转移拒绝——pending 直接 deliver 抛 ORDER_STATE_INVALID', () => {
  const engine = new OrderEngine()
  const order = engine.createOrder(input())
  assert.throws(
    () => engine.deliver(order.id),
    (e: OpcError) => e.code === 'ORDER_STATE_INVALID',
  )
  assert.throws(
    () => engine.refund(order.id, 'x'),
    (e: OpcError) => e.code === 'ORDER_STATE_INVALID',
  )
})

test('orders: 已取消订单拒绝迟到支付，未找到抛 ORDER_NOT_FOUND', () => {
  const engine = new OrderEngine()
  const order = engine.createOrder(input())
  engine.cancel(order.id, 'timeout')
  assert.throws(() => engine.markPaid(order.id, 'pm_late'), (e: OpcError) => e.code === 'ORDER_STATE_INVALID')
  assert.throws(() => engine.markPaid('nope', 'pm_x'), (e: OpcError) => e.code === 'ORDER_NOT_FOUND')
})

test('orders: 支付超时 30 秒自动取消（PRD 6.1.3），注入时钟推进', () => {
  const clock = fakeClock()
  const engine = new OrderEngine(clock.now)
  const a = engine.createOrder(input()) // t=0
  clock.advance(5_000)
  const b = engine.createOrder(input()) // t=5s

  clock.advance(25_000) // now=30s：a age 30s（≥30s）过期，b age 25s 保留
  const expired = engine.expirePending() // 默认 olderThanMs = PAYMENT_TIMEOUT_MS
  assert.equal(expired.length, 1)
  assert.equal(expired[0].id, a.id)
  assert.equal(a.status, 'cancelled')
  assert.ok(a.cancelReason!.includes('payment timeout'))
  assert.equal(b.status, 'pending')

  // 自定义阈值：5s 口径下 b（age 25s）也过期，且无重复过期
  const expiredAgain = engine.expirePending(5_000)
  assert.deepEqual(expiredAgain.map((o) => o.id), [b.id])
  assert.equal(engine.expirePending(5_000).length, 0)
  assert.equal(PAYMENT_TIMEOUT_MS, 30_000)
})

test('orders: stats 口径——净交易量 = paid+delivered，退款不计入（PRD 3.3）', () => {
  const engine = new OrderEngine()
  const o1 = engine.createOrder(input()) // 交付
  const o2 = engine.createOrder(input()) // 退款
  const o3 = engine.createOrder(input()) // 已支付未交付
  engine.createOrder(input()) // pending
  const o5 = engine.createOrder(input()) // 取消

  engine.markPaid(o1.id, 'pm_1')
  engine.deliver(o1.id)
  engine.markPaid(o2.id, 'pm_2')
  engine.refund(o2.id, 'buyer remorse')
  engine.markPaid(o3.id, 'pm_3')
  engine.cancel(o5.id, 'changed mind')

  const s = engine.stats()
  assert.equal(s.totalPaid, 3, '支付成功事件 3 笔（交付/退款/已付）')
  assert.equal(s.refunded, 1)
  assert.equal(s.netRevenue, 2, '净交易量 = paid(1) + delivered(1)，退款与取消不计入')
})

test('orders: listByBuyer / listBySkill 过滤', () => {
  const engine = new OrderEngine()
  const o1 = engine.createOrder(input({ buyerId: 'b1', skillId: 'sk-a' }))
  const o2 = engine.createOrder(input({ buyerId: 'b1', skillId: 'sk-b' }))
  const o3 = engine.createOrder(input({ buyerId: 'b2', skillId: 'sk-a' }))

  assert.deepEqual(engine.listByBuyer('b1').map((o) => o.id), [o1.id, o2.id])
  assert.deepEqual(engine.listBySkill('sk-a').map((o) => o.id), [o1.id, o3.id])
  assert.equal(engine.listByBuyer('nobody').length, 0)
  assert.equal(engine.listBySkill('sk-none').length, 0)
})
