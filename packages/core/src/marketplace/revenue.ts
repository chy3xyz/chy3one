import { OpcError } from '../errors.js'

/** US-05：创作者 85% / 平台 15%（基点表示，整数运算避免浮点误差） */
export const CREATOR_BPS = 8_500
export const PLATFORM_BPS = 1_500

export interface RevenueSplit {
  /** 创作者所得（分） */
  creator: number
  /** 平台抽成（分） */
  platform: number
}

/** 分成流水账条目 */
export interface SplitEntry extends RevenueSplit {
  orderId: string
  amount: number
  authorId: string
  recordedAt: number
}

/**
 * 分成引擎（US-05 / SF-07 收益统计）。
 * 金额一律以"分"（整数）计算：platform = floor(amount × 15%)，
 * 余数归创作者（85/15 分账 1 分钱时创作者得 1 分），
 * 由构造保证 creator + platform === amount，守恒误差恒为 0。
 */
export class RevenueSplitter {
  private entries: SplitEntry[] = []
  private byOrderId = new Map<string, SplitEntry>()
  private now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** 纯分账计算，不落账 */
  split(amount: number): RevenueSplit {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new OpcError('SPLIT_AMOUNT_INVALID', `amount must be a non-negative integer in cents, got ${amount}`)
    }
    const platform = Math.floor((amount * PLATFORM_BPS) / 10_000)
    return { creator: amount - platform, platform }
  }

  /** 记账并累计；幂等：同 orderId 重复记账返回原条目（防重复分成） */
  recordSplit(orderId: string, amount: number, authorId = 'unknown'): SplitEntry {
    const existing = this.byOrderId.get(orderId)
    if (existing) return existing
    const { creator, platform } = this.split(amount)
    const entry: SplitEntry = { orderId, amount, authorId, creator, platform, recordedAt: this.now() }
    this.entries.push(entry)
    this.byOrderId.set(orderId, entry)
    return entry
  }

  /** 创作者累计未提取余额（分） */
  creatorBalance(authorId: string): number {
    return this.entries.reduce((sum, e) => (e.authorId === authorId ? sum + e.creator : sum), 0)
  }

  /** 平台累计抽成（分） */
  platformRevenue(): number {
    return this.entries.reduce((sum, e) => sum + e.platform, 0)
  }

  /** 全量流水（审计用，只读快照） */
  listEntries(): readonly SplitEntry[] {
    return [...this.entries]
  }

  /** 清空账本（插件卸载清理 / 测试用） */
  clear(): void {
    this.entries = []
    this.byOrderId.clear()
  }
}
