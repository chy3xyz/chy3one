import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubscriptionStore } from '../../core/src/marketplace/subscriptions.js'
import { runAutoRenewalPass } from './auto-renew.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-auto-renew-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

const PRICE_TABLE = {
  'skill-paid': { price: 990, version: '1.0.0' },
  'skill-free': { price: 0, version: '1.0.0' },
}

test('auto-renew pass: 到期+开关 → 创建订单/支付顺延；无价跳过', () => {
  let clock = 10_000_000
  const store = new SubscriptionStore(join(dir, 'subs.db'), () => clock)
  store.activate({ skillId: 'skill-paid', version: '1.0.0', buyerId: 'b1', period: 'monthly', autoRenew: true })
  store.activate({ skillId: 'skill-free', version: '1.0.0', buyerId: 'b1', period: 'monthly', autoRenew: true })

  // 订单引擎测试桩（Mock 支付语义：createOrder+markPaid 即视为成交）
  const orders = {
    created: [] as Array<{ id: string; buyerId: string; amount: number }>,
    createOrder(input: { skillId: string; version: string; buyerId: string; amount: number }) {
      const id = `order-${this.created.length + 1}`
      this.created.push({ id, buyerId: input.buyerId, amount: input.amount })
      return { id, amount: input.amount }
    },
    markPaid(orderId: string) {
      void orderId
    },
  }

  // 到期
  clock += 31 * 86_400_000
  const skillsStub = {
  get(skillId: string) {
    return (PRICE_TABLE as Record<string, { price: number; version: string }>)[skillId]
  },
}
  const result = runAutoRenewalPass({ subscriptions: store, orders: orders as never, skills: skillsStub, now: () => clock })

  assert.equal(result.renewed.length, 1, '有价订阅应完成自动续费')
  assert.equal(result.skipped.length, 1, '无价订阅应被跳过')
  assert.equal(result.skipped[0]?.reason, 'no-skill-price')
  assert.equal(orders.created[0]?.buyerId, 'b1')
  assert.equal(orders.created[0]?.amount, 990, '按市场价下单')

  // 权益顺延：续费后 statusOf 重新 active
  const status = store.statusOf('b1', 'skill-paid')
  assert.equal(status.active, true)
  assert.equal(status.subscription?.orderId, result.renewed[0]?.orderId)
})

test('auto-renew pass: 单条失败不阻断其余', () => {
  let clock = 20_000_000
  const store = new SubscriptionStore(join(dir, 'subs2.db'), () => clock)
  store.activate({ skillId: 'skill-ok', version: '1.0.0', buyerId: 'b-ok', period: 'monthly', autoRenew: true })
  store.activate({ skillId: 'skill-bad', version: '1.0.0', buyerId: 'b-bad', period: 'monthly', autoRenew: true })
  clock += 31 * 86_400_000

  const orders = {
    createOrder(input: { skillId: string }) {
      if (input.skillId === 'skill-bad') throw new Error('boom')
      return { id: `order-${input.skillId}`, amount: 100 }
    },
    markPaid() {},
  }
  const skillsStub = {
    get(skillId: string) {
      return (PRICE_TABLE as Record<string, { price: number; version: string }>)[skillId] ?? { price: 100, version: '1.0.0' }
    },
  }
  const result = runAutoRenewalPass({ subscriptions: store, orders: orders as never, skills: skillsStub, now: () => clock })
  assert.equal(result.renewed.length, 1, 'skill-ok 应续费成功')
  assert.equal(result.skipped.length, 1, 'skill-bad 应落 skipped')
})
