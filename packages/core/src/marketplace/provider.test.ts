import test from 'node:test'
import assert from 'node:assert/strict'
import { MockMicropaymentProvider, type PaymentProvider } from './provider.js'
import { OrderEngine } from './orders.js'
import { OpcError } from '../errors.js'

const UUID_RE = /^pm_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function fakeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

test('provider: 默认全成功，paymentRef 为 pm_ + uuid 且唯一', async () => {
  const provider: PaymentProvider = new MockMicropaymentProvider()
  const engine = new OrderEngine()
  const order = engine.createOrder({ skillId: 'sk', version: '1.0.0', buyerId: 'b', amount: 100 })

  const r1 = await provider.pay(order)
  const r2 = await provider.pay(order)
  assert.ok(r1.ok)
  assert.ok(r2.ok)
  assert.match(r1.paymentRef, UUID_RE)
  assert.notEqual(r1.paymentRef, r2.paymentRef)
})

test('provider: failureRate=1 恒失败，原因为 HTTP 402 语义', async () => {
  const provider = new MockMicropaymentProvider({ failureRate: 1 })
  const engine = new OrderEngine()
  const order = engine.createOrder({ skillId: 'sk', version: '1.0.0', buyerId: 'b', amount: 100 })

  const r = await provider.pay(order)
  assert.ok(!r.ok)
  assert.ok(r.reason.includes('402'), `reason 应含 402：${r.reason}`)
  assert.ok(r.reason.includes(order.id))
})

test('provider: rng 注入保证确定性（SF-06 成功率阈值可测）', async () => {
  const engine = new OrderEngine()
  const order = engine.createOrder({ skillId: 'sk', version: '1.0.0', buyerId: 'b', amount: 100 })

  const pass = new MockMicropaymentProvider({ failureRate: 0.5, rng: () => 0.9 })
  assert.ok((await pass.pay(order)).ok)

  const fail = new MockMicropaymentProvider({ failureRate: 0.5, rng: () => 0.2 })
  assert.ok(!(await fail.pay(order)).ok)
})

test('provider: 注入 sleep 模拟延迟，pay 等待 latencyMs', async () => {
  const slept: number[] = []
  const provider = new MockMicropaymentProvider({
    latencyMs: 50,
    sleep: async (ms) => {
      slept.push(ms)
    },
  })
  const engine = new OrderEngine()
  const order = engine.createOrder({ skillId: 'sk', version: '1.0.0', buyerId: 'b', amount: 100 })

  const r = await provider.pay(order)
  assert.ok(r.ok)
  assert.deepEqual(slept, [50])
  assert.equal(provider.lastLatencyMs, 50)

  const zero = new MockMicropaymentProvider()
  await zero.pay(order)
  assert.equal(zero.lastLatencyMs, 0, 'latencyMs=0 不等待')
})

test('provider: 支付耗时超过 30s——订单先被超时取消，迟到 markPaid 被拒（PRD 6.1.3 竞态）', async () => {
  const clock = fakeClock()
  const engine = new OrderEngine(clock.now)
  const provider = new MockMicropaymentProvider({
    latencyMs: 31_000,
    sleep: async (ms) => {
      clock.advance(ms) // 假时钟：网关等待期间时间真实流逝
    },
  })

  const order = engine.createOrder({ skillId: 'sk', version: '1.0.0', buyerId: 'b', amount: 100 })
  const result = await provider.pay(order) // 支付本身成功，但时钟已推进 31s
  assert.ok(result.ok)

  const expired = engine.expirePending() // 收款回调落地前的超时巡检
  assert.equal(expired.length, 1)
  assert.equal(expired[0].id, order.id)
  assert.equal(order.status, 'cancelled')

  assert.throws(
    () => engine.markPaid(order.id, result.ok ? result.paymentRef : ''),
    (e: OpcError) => e.code === 'ORDER_STATE_INVALID',
    '迟到支付不得复活已取消订单',
  )
})
