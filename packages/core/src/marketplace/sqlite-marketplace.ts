import { DatabaseSync } from 'node:sqlite'
import {
  OrderEngine,
  PAYMENT_TIMEOUT_MS,
  type CreateOrderInput,
  type Order,
  type OrderStatus,
} from './orders.js'
import { RevenueSplitter, type SplitEntry } from './revenue.js'

/**
 * marketplace SQLite 持久化（PRD 8.2 orders 表意图 / AR-P03）：
 * 修复评估指出的"订单与分账纯内存、重启即丢"。
 * - SqliteMarketplaceStore：唯一持有 DatabaseSync（WAL + synchronous=NORMAL，同 memory/sqlite-store.ts 档位），
 *   建表 orders + split_ledger；PersistentOrderEngine / PersistentRevenueSplitter 共享同一实例，
 *   保证订单与分成 ledger 的写入在同一连接上提交（推荐用法：一个库一个 store）。
 * - 状态机 / 分账规则全部继承复用 orders.ts / revenue.ts（仅覆写变更点追加落库），内存版语义零漂移。
 * - 表结构按任务规格：orders(id PK, skill_id, version, buyer_id, author_id, amount, status,
 *   payment_ref, refund_reason, created_at, paid_at, delivered_at, refunded_at, cancelled_at)
 *   —— 额外补 cancel_reason 列：Order.cancelReason（含 "payment timeout" 语义）与
 *   refund_reason 对偶，缺列则取消单跨重启恢复不完整。
 */

interface OrderRow {
  id: string
  skill_id: string
  version: string
  buyer_id: string
  author_id: string | null
  amount: number
  status: string
  payment_ref: string | null
  refund_reason: string | null
  cancel_reason: string | null
  created_at: number
  paid_at: number | null
  delivered_at: number | null
  refunded_at: number | null
  cancelled_at: number | null
}

interface SplitRow {
  order_id: string
  author_id: string
  amount: number
  creator: number
  platform: number
  recorded_at: number
}

function rowToOrder(row: OrderRow): Order {
  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    buyerId: row.buyer_id,
    amount: Number(row.amount),
    status: row.status as OrderStatus,
    createdAt: Number(row.created_at),
    ...(row.author_id !== null ? { authorId: row.author_id } : {}),
    ...(row.payment_ref !== null ? { paymentRef: row.payment_ref } : {}),
    ...(row.refund_reason !== null ? { refundReason: row.refund_reason } : {}),
    ...(row.cancel_reason !== null ? { cancelReason: row.cancel_reason } : {}),
    ...(row.paid_at !== null ? { paidAt: Number(row.paid_at) } : {}),
    ...(row.delivered_at !== null ? { deliveredAt: Number(row.delivered_at) } : {}),
    ...(row.refunded_at !== null ? { refundedAt: Number(row.refunded_at) } : {}),
    ...(row.cancelled_at !== null ? { cancelledAt: Number(row.cancelled_at) } : {}),
  }
}

/**
 * marketplace 持久化库句柄：建表 + WAL 配置 + close()。
 * PersistentOrderEngine / PersistentRevenueSplitter 构造时传入同一实例即共享同一连接；
 * 各自传 dbPath 则各开连接（WAL 下可行，但需自行处理并发写竞争，推荐共享）。
 */
export class SqliteMarketplaceStore {
  readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    // WAL 下的推荐档位：commit 不逐次 fsync，断电至多丢最近事务、不损坏库
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id            TEXT PRIMARY KEY,
        skill_id      TEXT NOT NULL,
        version       TEXT NOT NULL,
        buyer_id      TEXT NOT NULL,
        author_id     TEXT,
        amount        INTEGER NOT NULL,
        status        TEXT NOT NULL,
        payment_ref   TEXT,
        refund_reason TEXT,
        cancel_reason TEXT,
        created_at    INTEGER NOT NULL,
        paid_at       INTEGER,
        delivered_at  INTEGER,
        refunded_at   INTEGER,
        cancelled_at  INTEGER
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS split_ledger (
        order_id    TEXT PRIMARY KEY,
        author_id   TEXT NOT NULL,
        amount      INTEGER NOT NULL,
        creator     INTEGER NOT NULL,
        platform    INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL
      )
    `)
    // listByBuyer / listBySkill 过滤走索引（OrderEngine.listBy* 在内存侧过滤，索引用于库上直查/审计）
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders (buyer_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_orders_skill ON orders (skill_id)')
  }

  close(): void {
    this.db.close()
  }
}

/**
 * 订单引擎持久化版：继承 OrderEngine（校验/状态机/统计全部复用），
 * 每个成功变更点整单 upsert 落库；构造时从库恢复全部订单。
 * 构造传 store 则共享连接（推荐，close 交还调用方）；传 dbPath 则自开自关。
 */
export class PersistentOrderEngine extends OrderEngine {
  private readonly store: SqliteMarketplaceStore
  private readonly ownsStore: boolean
  private readonly upsertStmt: ReturnType<DatabaseSync['prepare']>

  constructor(db: string | SqliteMarketplaceStore, now: () => number = Date.now) {
    super(now)
    this.ownsStore = typeof db === 'string'
    this.store = typeof db === 'string' ? new SqliteMarketplaceStore(db) : db
    // 整单快照 upsert：15 列全部来自同一权威内存态，REPLACE 与逐列 UPDATE 等价且更简
    this.upsertStmt = this.store.db.prepare(`
      INSERT OR REPLACE INTO orders (
        id, skill_id, version, buyer_id, author_id, amount, status,
        payment_ref, refund_reason, cancel_reason,
        created_at, paid_at, delivered_at, refunded_at, cancelled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    // 重启恢复：按创建序播种内存状态机（created_at 同值时以 id 稳定排序）
    const rows = this.store.db
      .prepare('SELECT * FROM orders ORDER BY created_at, id')
      .all() as unknown as OrderRow[]
    for (const row of rows) {
      const order = rowToOrder(row)
      this.orders.set(order.id, order)
    }
  }

  private persist(order: Order): void {
    this.upsertStmt.run(
      order.id,
      order.skillId,
      order.version,
      order.buyerId,
      order.authorId ?? null,
      order.amount,
      order.status,
      order.paymentRef ?? null,
      order.refundReason ?? null,
      order.cancelReason ?? null,
      order.createdAt,
      order.paidAt ?? null,
      order.deliveredAt ?? null,
      order.refundedAt ?? null,
      order.cancelledAt ?? null,
    )
  }

  override createOrder(input: CreateOrderInput): Order {
    const order = super.createOrder(input) // 入参校验先于落库，非法输入不产生脏行
    this.persist(order)
    return order
  }

  override markPaid(orderId: string, paymentRef: string): Order {
    const order = super.markPaid(orderId, paymentRef) // 幂等早退时整单快照不变，重复落库无副作用
    this.persist(order)
    return order
  }

  override deliver(orderId: string): Order {
    const order = super.deliver(orderId)
    this.persist(order)
    return order
  }

  override refund(orderId: string, reason = 'unspecified'): Order {
    const order = super.refund(orderId, reason)
    this.persist(order)
    return order
  }

  override cancel(orderId: string, reason = 'unspecified'): Order {
    const order = super.cancel(orderId, reason)
    this.persist(order)
    return order
  }

  /** 语义同基类（now - createdAt ≥ olderThanMs），仅把本次过期取消的单落库 */
  override expirePending(olderThanMs: number = PAYMENT_TIMEOUT_MS): Order[] {
    const expired = super.expirePending(olderThanMs)
    for (const order of expired) this.persist(order)
    return expired
  }

  /** 清空内存 + 库中全部订单（与内存版"清空"语义一致，避免内存/库不一致） */
  override clear(): void {
    super.clear()
    this.store.db.exec('DELETE FROM orders')
  }

  /** 仅关闭本引擎自开的库（构造传 dbPath）；共享 store 时由调用方统一 store.close() */
  close(): void {
    if (this.ownsStore) this.store.close()
  }
}

/**
 * 分成引擎持久化版：继承 RevenueSplitter（8500/1500 bps、余数归创作者的规则零改动），
 * recordSplit 落 ledger（order_id 主键天然幂等）；构造时从 split_ledger 恢复余额与流水。
 */
export class PersistentRevenueSplitter extends RevenueSplitter {
  private readonly store: SqliteMarketplaceStore
  private readonly ownsStore: boolean
  private readonly insertStmt: ReturnType<DatabaseSync['prepare']>

  constructor(db: string | SqliteMarketplaceStore, now: () => number = Date.now) {
    super(now)
    this.ownsStore = typeof db === 'string'
    this.store = typeof db === 'string' ? new SqliteMarketplaceStore(db) : db
    this.insertStmt = this.store.db.prepare(`
      INSERT INTO split_ledger (order_id, author_id, amount, creator, platform, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    // 重启恢复：按入账序播种（recorded_at 同值时以 order_id 稳定排序）
    const rows = this.store.db
      .prepare('SELECT * FROM split_ledger ORDER BY recorded_at, order_id')
      .all() as unknown as SplitRow[]
    for (const row of rows) {
      const entry: SplitEntry = {
        orderId: row.order_id,
        authorId: row.author_id,
        amount: Number(row.amount),
        creator: Number(row.creator),
        platform: Number(row.platform),
        recordedAt: Number(row.recorded_at),
      }
      this.entries.push(entry)
      this.byOrderId.set(entry.orderId, entry)
    }
  }

  /** 幂等：内存 byOrderId 命中（含重启恢复的）直接返回原条目，不重复写 ledger */
  override recordSplit(orderId: string, amount: number, authorId = 'unknown'): SplitEntry {
    const known = this.byOrderId.has(orderId)
    const entry = super.recordSplit(orderId, amount, authorId) // 金额校验/幂等先于落库
    if (!known) {
      this.insertStmt.run(
        entry.orderId,
        entry.authorId,
        entry.amount,
        entry.creator,
        entry.platform,
        entry.recordedAt,
      )
    }
    return entry
  }

  /** 清空内存 + 库中全部流水（与内存版"清空"语义一致） */
  override clear(): void {
    super.clear()
    this.store.db.exec('DELETE FROM split_ledger')
  }

  /** 仅关闭本引擎自开的库（构造传 dbPath）；共享 store 时由调用方统一 store.close() */
  close(): void {
    if (this.ownsStore) this.store.close()
  }
}
