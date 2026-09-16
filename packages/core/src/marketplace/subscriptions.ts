import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { OpcError } from '../errors.js'

/**
 * 技能订阅（prd2.md 7.3 SM-04 定价与支付的订阅语义）：
 * 订阅期 = 一次成功支付的权益窗口——支付激活、续费顺延（未到期续费从到期时间顺延，
 * 已到期从当前时间起算）、读取时按当前时钟懒判定到期。
 * 周期天数取整月/季/年近似（30/90/365），与订单系统解耦：订单管钱，这里管权益。
 */

export type SubscriptionPeriod = 'monthly' | 'quarterly' | 'yearly'

export const SUBSCRIPTION_PERIODS: readonly SubscriptionPeriod[] = ['monthly', 'quarterly', 'yearly']

/** 周期天数（取整近似；订阅权益按天判定，不做秒级精度） */
export const PERIOD_DAYS: Record<SubscriptionPeriod, number> = { monthly: 30, quarterly: 90, yearly: 365 }

export const DAY_MS = 86_400_000

export interface Subscription {
  id: string
  skillId: string
  version: string
  buyerId: string
  period: SubscriptionPeriod
  startedAt: number
  expiresAt: number
  /** 关联订单（本次激活/续费对应的支付凭证） */
  orderId?: string
}

export interface SubscriptionStatus {
  active: boolean
  subscription?: Subscription
}

function rowToSubscription(row: {
  id: string; skill_id: string; version: string; buyer_id: string; period: string
  started_at: number; expires_at: number; order_id: string | null
}): Subscription {
  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    buyerId: row.buyer_id,
    period: row.period as SubscriptionPeriod,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    ...(row.order_id ? { orderId: row.order_id } : {}),
  }
}

export function requirePeriod(period: string): SubscriptionPeriod {
  if (!(SUBSCRIPTION_PERIODS as readonly string[]).includes(period)) {
    throw new OpcError('VALIDATION_ERROR', `period must be one of: ${SUBSCRIPTION_PERIODS.join(', ')}`)
  }
  return period as SubscriptionPeriod
}

/**
 * 订阅权益存储（SQLite；WAL 同全局档位）：
 * activate 幂等方向为"顺延"——同一 (buyerId, skillId) 重复激活不覆盖历史；
 * statusOf/listByBuyer 读取时按 now 懒判定 active（过期不改写历史行）。
 */
export class SubscriptionStore {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(path: string, now: () => number = Date.now) {
    this.now = now
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id         TEXT PRIMARY KEY,
        skill_id   TEXT NOT NULL,
        version    TEXT NOT NULL,
        buyer_id   TEXT NOT NULL,
        period     TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        order_id   TEXT
      )
    `)
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_subs_buyer ON subscriptions (buyer_id, skill_id, expires_at DESC)',
    )
  }

  /**
   * 激活/续费：当前活跃（expiresAt > now）则从到期时间顺延一个周期，
   * 已过期或首订从 now 起算。返回本次的权益窗口。
   */
  activate(input: {
    skillId: string
    version: string
    buyerId: string
    period: SubscriptionPeriod
    orderId?: string
  }): Subscription {
    if (!input.skillId || !input.buyerId) {
      throw new OpcError('VALIDATION_ERROR', 'skillId and buyerId are required')
    }
    const now = this.now()
    const days = PERIOD_DAYS[input.period]
    const latest = this.latest(input.buyerId, input.skillId)
    const base = latest && latest.expiresAt > now ? latest.expiresAt : now
    const subscription: Subscription = {
      id: randomUUID(),
      skillId: input.skillId,
      version: input.version,
      buyerId: input.buyerId,
      period: input.period,
      startedAt: now,
      expiresAt: base + days * DAY_MS,
      ...(input.orderId ? { orderId: input.orderId } : {}),
    }
    this.db
      .prepare(
        'INSERT INTO subscriptions (id, skill_id, version, buyer_id, period, started_at, expires_at, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        subscription.id, subscription.skillId, subscription.version, subscription.buyerId,
        subscription.period, subscription.startedAt, subscription.expiresAt, subscription.orderId ?? null,
      )
    return subscription
  }

  /** (buyer, skill) 最新一条订阅（按到期时间倒序） */
  private latest(buyerId: string, skillId: string): Subscription | undefined {
    const rows = this.db
      .prepare(
        'SELECT id, skill_id, version, buyer_id, period, started_at, expires_at, order_id FROM subscriptions WHERE buyer_id = ? AND skill_id = ? ORDER BY expires_at DESC LIMIT 1',
      )
      .all(buyerId, skillId) as unknown as Parameters<typeof rowToSubscription>[0][]
    return rows.length > 0 ? rowToSubscription(rows[0]) : undefined
  }

  /** 权益状态：懒判定（expiresAt > now 即 active，过期不改写历史行） */
  statusOf(buyerId: string, skillId: string): SubscriptionStatus {
    const latest = this.latest(buyerId, skillId)
    if (!latest) return { active: false }
    return { active: latest.expiresAt > this.now(), subscription: latest }
  }

  /** 买家全部订阅（到期时间倒序；active 为懒判定结果） */
  listByBuyer(buyerId: string): Array<Subscription & { active: boolean }> {
    const rows = this.db
      .prepare(
        'SELECT id, skill_id, version, buyer_id, period, started_at, expires_at, order_id FROM subscriptions WHERE buyer_id = ? ORDER BY expires_at DESC',
      )
      .all(buyerId) as unknown as Parameters<typeof rowToSubscription>[0][]
    const now = this.now()
    return rows.map((row) => {
      const subscription = rowToSubscription(row)
      return { ...subscription, active: subscription.expiresAt > now }
    })
  }

  close(): void {
    this.db.close()
  }
}
