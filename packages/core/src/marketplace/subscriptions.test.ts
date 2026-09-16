import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubscriptionStore, PERIOD_DAYS, DAY_MS } from './subscriptions.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-subscriptions-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

const DAY = DAY_MS

test('subscriptions: 激活 → 活跃 → 到期懒判定（SM-04 订阅语义）', () => {
  let clock = 1_000_000
  const store = new SubscriptionStore(join(dir, 'subs-basic.db'), () => clock)
  const sub = store.activate({
    skillId: 'skill-s1', version: '1.0.0', buyerId: 'buyer-1', period: 'monthly', orderId: 'order-1',
  })
  assert.equal(sub.expiresAt - sub.startedAt, PERIOD_DAYS.monthly * DAY)

  // 订阅期内 active
  clock += 10 * DAY
  assert.equal(store.statusOf('buyer-1', 'skill-s1').active, true)
  // 过期后懒判定 inactive（历史行保留）
  clock += 21 * DAY
  const expired = store.statusOf('buyer-1', 'skill-s1')
  assert.equal(expired.active, false, '31 天后应懒判定到期')
  assert.equal(expired.subscription?.expiresAt, sub.expiresAt, '历史窗口不被改写')
  // 未订阅过的组合
  assert.equal(store.statusOf('buyer-1', 'skill-none').active, false)
})

test('subscriptions: 未到期续费从到期时间顺延；到期后续费从当前时间起算', () => {
  let clock = 2_000_000
  const store = new SubscriptionStore(join(dir, 'subs-renew.db'), () => clock)
  const first = store.activate({ skillId: 'skill-r', version: '1.0.0', buyerId: 'b', period: 'monthly' })
  const firstExpiry = first.expiresAt

  // 第 10 天续费：从 firstExpiry 顺延（不损失剩余天数）
  clock += 10 * DAY
  const renewed = store.activate({ skillId: 'skill-r', version: '1.0.0', buyerId: 'b', period: 'monthly' })
  assert.equal(renewed.expiresAt, firstExpiry + PERIOD_DAYS.monthly * DAY, '活跃期续费应顺延')

  // 放任到期（firstExpiry + 40 天 > renewed expiry），再续：从当前时间起算
  clock = firstExpiry + 40 * DAY
  const third = store.activate({ skillId: 'skill-r', version: '1.0.0', buyerId: 'b', period: 'monthly' })
  assert.equal(third.expiresAt, clock + PERIOD_DAYS.monthly * DAY, '过期后激活应从当前时间起算')
})

test('subscriptions: 周期天数与非法周期校验 + 买家订阅清单', () => {
  let clock = 3_000_000
  const store = new SubscriptionStore(join(dir, 'subs-list.db'), () => clock)
  assert.equal(PERIOD_DAYS.yearly, 365)
  assert.throws(() =>
    store.activate({ skillId: 's', version: '1', buyerId: 'b', period: 'weekly' as 'monthly' }),
  )
  store.activate({ skillId: 'skill-a', version: '1.0.0', buyerId: 'b1', period: 'yearly' })
  store.activate({ skillId: 'skill-b', version: '1.0.0', buyerId: 'b1', period: 'quarterly' })
  const list = store.listByBuyer('b1')
  assert.equal(list.length, 2)
  assert.ok(list.every((s) => s.active))
  assert.equal(store.listByBuyer('b2').length, 0)
})

test('subscriptions: 重启恢复（重开同一库权益与顺延基准不丢）', () => {
  const path = join(dir, 'subs-restart.db')
  let clock = 4_000_000
  const first = new SubscriptionStore(path, () => clock)
  const sub = first.activate({ skillId: 'skill-p', version: '1.0.0', buyerId: 'b', period: 'monthly' })
  first.close()

  clock += 5 * DAY
  const reopened = new SubscriptionStore(path, () => clock)
  const renewed = reopened.activate({ skillId: 'skill-p', version: '1.0.0', buyerId: 'b', period: 'monthly' })
  assert.equal(renewed.expiresAt, sub.expiresAt + PERIOD_DAYS.monthly * DAY, '重启后续费仍从到期时间顺延')
  reopened.close()
})
