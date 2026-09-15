/**
 * opc-marketplace：Skill 交易支付与创作者分成插件（PRD 6.1 SF-05/SF-06、US-05）。
 * 组合 core 的 OrderEngine / RevenueSplitter / MockMicropaymentProvider，
 * 通过 OpcContext 注册为具名服务，业务侧零硬依赖（AR-C06）。
 * 配置 ordersDb 时换用 SqliteMarketplaceStore 持久化引擎：订单与分成 ledger
 * 重启即恢复（PRD 8.2 orders 表意图），路径解析语义同 opc-console 的 dataDir。
 */
import { resolve } from 'node:path'
import { OpcError } from '../../../core/src/index.js'
import {
  OrderEngine,
  RevenueSplitter,
  MockMicropaymentProvider,
  SqliteMarketplaceStore,
  PersistentOrderEngine,
  PersistentRevenueSplitter,
  type Order,
  type SplitEntry,
} from '../../../core/src/marketplace/index.js'
import { defineOpcPlugin, type OpcContext } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-marketplace'

/** 订单/分成持久化库的默认路径（dataDir 语义：相对 cwd 解析） */
export const DEFAULT_ORDERS_DB = './opcos-orders.db'

export interface Config {
  /** 计价单位：全部金额以整数"分"计算（PRD 8.2 orders/skills 价格口径） */
  currency: 'cents'
  /** 时钟注入（测试支付超时取消流程用） */
  now?: () => number
  /** 微支付模拟参数（SF-06：失败率/延迟） */
  payment?: { failureRate?: number; latencyMs?: number }
  /**
   * 订单/分成 SQLite 库路径（默认建议 DEFAULT_ORDERS_DB = './opcos-orders.db'）。
   * 设置后用 PersistentOrderEngine / PersistentRevenueSplitter 替代内存版，
   * 二者共享同一 DatabaseSync；不设置保持纯内存（默认，向后兼容）。
   */
  ordersDb?: string
}

export type PayResult = { order: Order; split: SplitEntry }

export function apply(ctx: OpcContext, config: Config) {
  if (config.currency !== 'cents') {
    throw new OpcError('CURRENCY_UNSUPPORTED', `currency must be 'cents' (integer minor units), got '${String(config.currency)}'`)
  }
  // ordersDb 配置即启用持久化：订单与分成共享同一 SQLite 连接（WAL），重启后全量恢复
  const store = config.ordersDb !== undefined ? new SqliteMarketplaceStore(resolve(config.ordersDb)) : undefined
  const orders = store ? new PersistentOrderEngine(store, config.now) : new OrderEngine(config.now)
  const revenue = store ? new PersistentRevenueSplitter(store, config.now) : new RevenueSplitter(config.now)
  const provider = new MockMicropaymentProvider(config.payment)

  /**
   * 一站式收单：支付 → markPaid → 自动 deliver → 分成入账（US-05：创作者 85% / 平台 15%）。
   * 幂等：对已交付订单重复调用返回原单与既有分成，不重复入账。
   * 若支付等待期间订单被 30s 超时巡检取消，markPaid 抛 ORDER_STATE_INVALID（PRD 6.1.3）。
   */
  async function pay(orderId: string): Promise<PayResult> {
    const existing = orders.get(orderId)
    if (!existing) throw new OpcError('ORDER_NOT_FOUND', `order ${orderId} not found`)
    if (existing.status === 'cancelled' || existing.status === 'refunded') {
      throw new OpcError('ORDER_STATE_INVALID', `order ${orderId} is ${existing.status}, cannot pay`)
    }
    if (existing.status === 'delivered') {
      const entry = revenue.recordSplit(orderId, existing.amount, existing.authorId ?? 'unknown')
      return { order: existing, split: entry }
    }
    const result = await provider.pay(existing)
    if (!result.ok) throw new OpcError('PAYMENT_FAILED', result.reason)
    orders.markPaid(orderId, result.paymentRef)
    const order = orders.deliver(orderId)
    const split = revenue.recordSplit(orderId, order.amount, order.authorId ?? 'unknown')
    return { order, split }
  }

  const revokes = [
    ctx.provideService('opc.marketplace.orders', orders),
    ctx.provideService('opc.marketplace.revenue', revenue),
    ctx.provideService('opc.marketplace.pay', pay),
  ]

  ctx.onDispose(() => {
    for (const revoke of revokes) revoke()
    if (store) {
      store.close() // 持久化模式：落盘收尾，绝不清库（clear 会把已持久化订单/流水删光）
    } else {
      orders.clear()
      revenue.clear()
    }
  })
}

/** cordis Plugin.Function 形状：可被真实 ctx.plugin(plugin, config) 加载 */
export const plugin = defineOpcPlugin<Config>({
  name,
  defaultConfig: { currency: 'cents' },
  apply,
})

export default plugin
