import { randomUUID } from 'node:crypto'
import { OpcError } from '../errors.js'

/**
 * Skill 交易订单（SF-05 / PRD 8.2 orders 表）。
 * 生命周期：pending → paid → delivered；分支：paid/delivered → refunded、pending → cancelled。
 */
export type OrderStatus = 'pending' | 'paid' | 'delivered' | 'refunded' | 'cancelled'

export interface CreateOrderInput {
  /** 目标 Skill（.dshpkg manifest.skillId） */
  skillId: string
  /** 目标版本（manifest.version，订单锁定具体版本） */
  version: string
  buyerId: string
  /** 金额（单位：分，整数） */
  amount: number
  /** 创作者归属（PRD 8.2 skills.author_id），供分成 ledger 记账 */
  authorId?: string
}

export interface Order {
  id: string
  skillId: string
  version: string
  buyerId: string
  /** 金额（单位：分，整数） */
  amount: number
  /** 创作者归属，缺省由调用方在上架目录补齐 */
  authorId?: string
  status: OrderStatus
  createdAt: number
  paidAt?: number
  deliveredAt?: number
  refundedAt?: number
  cancelledAt?: number
  /** 支付网关流水号（首次 markPaid 落定，之后不变） */
  paymentRef?: string
  refundReason?: string
  cancelReason?: string
}

export interface OrderStats {
  /** 支付成功事件总笔数（含其后退款/交付的，PRD 3.3 分子） */
  totalPaid: number
  /** 退款笔数 */
  refunded: number
  /** 净交易量：paid+delivered 笔数，退款不计入（PRD 3.3 成功指标口径） */
  netRevenue: number
}

/** PRD 6.1.3：支付超时 30 秒自动取消 */
export const PAYMENT_TIMEOUT_MS = 30_000

export class OrderStateError extends OpcError {
  constructor(detail: string) {
    super('ORDER_STATE_INVALID', detail)
  }
}

/**
 * 订单引擎：内存态状态机，时钟可注入（测试 30s 超时无需真实等待）。
 * 除 markPaid 幂等外，任何越状态转移抛 OpcError('ORDER_STATE_INVALID')。
 */
export class OrderEngine {
  private orders = new Map<string, Order>()
  private now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  createOrder(input: CreateOrderInput): Order {
    if (!input.skillId || !input.version || !input.buyerId) {
      throw new OpcError('ORDER_INPUT_INVALID', 'skillId, version and buyerId are required')
    }
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new OpcError('ORDER_AMOUNT_INVALID', `amount must be a positive integer in cents, got ${input.amount}`)
    }
    const order: Order = {
      id: randomUUID(),
      skillId: input.skillId,
      version: input.version,
      buyerId: input.buyerId,
      amount: input.amount,
      ...(input.authorId !== undefined ? { authorId: input.authorId } : {}),
      status: 'pending',
      createdAt: this.now(),
    }
    this.orders.set(order.id, order)
    return order
  }

  get(orderId: string): Order | undefined {
    return this.orders.get(orderId)
  }

  listByBuyer(buyerId: string): Order[] {
    return [...this.orders.values()].filter((o) => o.buyerId === buyerId)
  }

  listBySkill(skillId: string): Order[] {
    return [...this.orders.values()].filter((o) => o.skillId === skillId)
  }

  private require(orderId: string): Order {
    const order = this.orders.get(orderId)
    if (!order) throw new OpcError('ORDER_NOT_FOUND', `order ${orderId} not found`)
    return order
  }

  /** pending → paid；重复支付幂等：已支付过（paid/delivered/refunded）直接返回原单 */
  markPaid(orderId: string, paymentRef: string): Order {
    const order = this.require(orderId)
    if (order.status === 'cancelled') {
      throw new OrderStateError(`cannot mark paid: order ${orderId} is cancelled (payment timeout or manual cancel)`)
    }
    if (order.status !== 'pending') return order
    order.status = 'paid'
    order.paymentRef = paymentRef
    order.paidAt = this.now()
    return order
  }

  /** paid → delivered（pending 直接 deliver 属越状态转移） */
  deliver(orderId: string): Order {
    const order = this.require(orderId)
    if (order.status !== 'paid') {
      throw new OrderStateError(`cannot deliver: order ${orderId} is ${order.status}, expected paid`)
    }
    order.status = 'delivered'
    order.deliveredAt = this.now()
    return order
  }

  /** paid/delivered → refunded，记录退款原因 */
  refund(orderId: string, reason = 'unspecified'): Order {
    const order = this.require(orderId)
    if (order.status !== 'paid' && order.status !== 'delivered') {
      throw new OrderStateError(`cannot refund: order ${orderId} is ${order.status}, expected paid or delivered`)
    }
    order.status = 'refunded'
    order.refundReason = reason
    order.refundedAt = this.now()
    return order
  }

  /** 仅 pending → cancelled */
  cancel(orderId: string, reason = 'unspecified'): Order {
    const order = this.require(orderId)
    if (order.status !== 'pending') {
      throw new OrderStateError(`cannot cancel: order ${orderId} is ${order.status}, expected pending`)
    }
    order.status = 'cancelled'
    order.cancelReason = reason
    order.cancelledAt = this.now()
    return order
  }

  /**
   * 批量取消超时 pending 单（PRD 6.1.3：支付超时 30 秒自动取消，订单状态回滚）。
   * 判定口径：now - createdAt ≥ olderThanMs。返回本次过期取消的订单列表。
   */
  expirePending(olderThanMs: number = PAYMENT_TIMEOUT_MS): Order[] {
    const cutoff = this.now() - olderThanMs
    const expired: Order[] = []
    for (const order of this.orders.values()) {
      if (order.status === 'pending' && order.createdAt <= cutoff) {
        order.status = 'cancelled'
        order.cancelReason = `payment timeout: pending for ${this.now() - order.createdAt}ms > ${olderThanMs}ms`
        order.cancelledAt = this.now()
        expired.push(order)
      }
    }
    return expired
  }

  /** 交易统计：净交易量 = paid+delivered 笔数，退款不计入（PRD 3.3） */
  stats(): OrderStats {
    let totalPaid = 0
    let refunded = 0
    let netRevenue = 0
    for (const order of this.orders.values()) {
      if (order.status === 'paid' || order.status === 'delivered' || order.status === 'refunded') totalPaid++
      if (order.status === 'refunded') refunded++
      if (order.status === 'paid' || order.status === 'delivered') netRevenue++
    }
    return { totalPaid, refunded, netRevenue }
  }

  /** 清空全部订单（插件卸载清理 / 测试用） */
  clear(): void {
    this.orders.clear()
  }
}
