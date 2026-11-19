import { randomUUID } from 'node:crypto'
import { OpcError } from '../../core/src/errors.js'
import { SubscriptionStore, type Subscription } from '../../core/src/marketplace/subscriptions.js'

/**
 * 订阅自动续费编排（prd2.md SM-04 变现深化）：
 * 到期且开启 auto_renew 的订阅 → 按市场价创建续费订单 → Mock 支付落定 →
 * 权益顺延一个周期。真实扣款只需把 settle 回调换成真实支付网关，编排不变。
 *
 * 放在 console 层而非 core 服务——跨三个组件（subscriptions/orders/skillsIndex）
 * 的编排是宿主职责；core 只提供数据访问。此文件是 console 的编排 helper。
 */

/** 订阅续费所需的技能价格来源（结构子集 = SqliteSkillIndex.get） */
export interface SkillPriceSource {
  get(skillId: string): { price: number; version: string } | undefined
}

/** 订单创建/支付（结构子集 = OrderEngine；pay 由调用方注入支付通道） */
export interface AutoRenewOrderEngine {
  createOrder(input: { skillId: string; version: string; buyerId: string; amount: number; authorId?: string }): { id: string; amount: number }
  markPaid(orderId: string, paymentRef: string): unknown
}

export interface AutoRenewOutcome {
  buyerId: string
  skillId: string
  orderId: string
  subscription: Subscription
  amountCents: number
}

export interface AutoRenewSkip {
  buyerId: string
  skillId: string
  reason: 'no-skill-price' | 'order-failed'
  detail?: string
}

export interface AutoRenewalPassResult {
  renewed: AutoRenewOutcome[]
  skipped: AutoRenewSkip[]
}

/**
 * 跑一轮自动续费：扫描全部到期且 auto_renew 开启的订阅，
 * 按市场价创建续费订单并标记已支付（Mock 通道语义），权益顺延一个周期。
 * 单条失败不阻断其余（落 skipped 带原因）。
 */
export function runAutoRenewalPass(deps: {
  subscriptions: SubscriptionStore
  orders: AutoRenewOrderEngine
  skills: SkillPriceSource
  now?: () => number
}): AutoRenewalPassResult {
  const now = deps.now ? deps.now() : Date.now()
  const renewed: AutoRenewOutcome[] = []
  const skipped: AutoRenewSkip[] = []

  for (const sub of deps.subscriptions.dueForRenewal(now)) {
    const entry = deps.skills.get(sub.skillId)
    if (!entry || !Number.isInteger(entry.price) || entry.price <= 0) {
      skipped.push({ buyerId: sub.buyerId, skillId: sub.skillId, reason: 'no-skill-price' })
      continue
    }
    try {
      const order = deps.orders.createOrder({
        skillId: sub.skillId,
        version: sub.version,
        buyerId: sub.buyerId,
        amount: entry.price,
      })
      deps.orders.markPaid(order.id, `auto-renew-${randomUUID()}`)
      const renewedSub = deps.subscriptions.activate({
        skillId: sub.skillId,
        version: sub.version,
        buyerId: sub.buyerId,
        period: sub.period,
        orderId: order.id,
      })
      renewed.push({
        buyerId: sub.buyerId,
        skillId: sub.skillId,
        orderId: order.id,
        subscription: renewedSub,
        amountCents: entry.price,
      })
    } catch (error) {
      skipped.push({
        buyerId: sub.buyerId,
        skillId: sub.skillId,
        reason: 'order-failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { renewed, skipped }
}

export { OpcError }
