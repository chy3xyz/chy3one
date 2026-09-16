import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 创意资产账本（prd2.md 5.5，阶段四五类资产）：
 * 每创意一份 assets/ledger.json（PRD 原生 JSON 形态，DSH 侧工具可直接读），
 * 金额一律用"分"（INTEGER）与 marketplace 口径一致，控制台层做分→元换算。
 * 五类资产：Skill 沉淀 / Meme Token / 财务收入 / 用户资源 / 运营数据。
 */

export type RevenueSource = 'product' | 'subscription' | 'skill'

export interface LedgerSkillEntry {
  id: string
  name: string
  status: 'draft' | 'listed'
  /** 该 Skill 累计收入（分） */
  revenue: number
}

export interface IdeaLedgerData {
  idea_id: string
  updated_at: number
  assets: {
    skills: LedgerSkillEntry[]
    tokens: { total_supply: number; distributed: number; holders: number }
    finance: {
      product_revenue: number
      subscription_revenue: number
      skill_revenue: number
      total: number
    }
    users: { total: number; active_30d: number; paying: number }
    analytics: { geo_visibility: number; content_engagement: number; conversion_rate: number }
  }
}

function zeroLedger(ideaId: string): IdeaLedgerData {
  return {
    idea_id: ideaId,
    updated_at: 0,
    assets: {
      skills: [],
      tokens: { total_supply: 1_000_000, distributed: 0, holders: 0 },
      finance: { product_revenue: 0, subscription_revenue: 0, skill_revenue: 0, total: 0 },
      users: { total: 0, active_30d: 0, paying: 0 },
      analytics: { geo_visibility: 0, content_engagement: 0, conversion_rate: 0 },
    },
  }
}

export class IdeaLedger {
  private cache: IdeaLedgerData | undefined

  constructor(
    /** 账本文件路径（惯例：ideas/<id>/assets/ledger.json） */
    private readonly filePath: string,
    private readonly ideaId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 从创意目录派生账本（assets/ledger.json，prd2.md 2.4 目录结构） */
  static forIdeaHome(ideaHomeDir: string, ideaId: string, now?: () => number): IdeaLedger {
    return new IdeaLedger(join(ideaHomeDir, 'assets', 'ledger.json'), ideaId, now)
  }

  /** 读取账本（文件缺失/损坏时以零账本起步，首次写入落盘） */
  read(): IdeaLedgerData {
    if (this.cache) return this.cache
    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as IdeaLedgerData
        if (parsed && typeof parsed === 'object' && parsed.assets) {
          this.cache = parsed
          return this.cache
        }
      } catch {
        /* 损坏账本按零起步（正本以最新成功写入为准） */
      }
    }
    this.cache = zeroLedger(this.ideaId)
    return this.cache
  }

  /** 内部：合并 patch 后原子落盘 */
  private persist(): IdeaLedgerData {
    const data = this.read()
    data.updated_at = this.now()
    writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    return data
  }

  /** 记一笔收入（prd2.md 5.2 财务收入三来源；amountCents 单位为分，非负整数） */
  recordRevenue(source: RevenueSource, amountCents: number): IdeaLedgerData {
    if (!Number.isInteger(amountCents) || amountCents < 0) {
      throw new RangeError('amountCents must be a non-negative integer (cents)')
    }
    const data = this.read()
    data.assets.finance[`${source}_revenue`] += amountCents
    data.assets.finance.total += amountCents
    return this.persist()
  }

  /** Skill 沉淀入账（上架/更新时按 id upsert，收入合并） */
  recordSkill(entry: { id: string; name: string; status: LedgerSkillEntry['status']; revenueCents?: number }): IdeaLedgerData {
    const data = this.read()
    const existing = data.assets.skills.find((s) => s.id === entry.id)
    if (existing) {
      existing.name = entry.name
      existing.status = entry.status
      existing.revenue += entry.revenueCents ?? 0
    } else {
      data.assets.skills.push({
        id: entry.id,
        name: entry.name,
        status: entry.status,
        revenue: entry.revenueCents ?? 0,
      })
    }
    return this.persist()
  }

  /** 用户资源更新（合并 patch） */
  updateUsers(patch: Partial<IdeaLedgerData['assets']['users']>): IdeaLedgerData {
    const data = this.read()
    data.assets.users = { ...data.assets.users, ...patch }
    return this.persist()
  }

  /** 运营数据更新（GEO 可见性/内容互动率/转化率，合并 patch） */
  updateAnalytics(patch: Partial<IdeaLedgerData['assets']['analytics']>): IdeaLedgerData {
    const data = this.read()
    data.assets.analytics = { ...data.assets.analytics, ...patch }
    return this.persist()
  }

  /** Token 统计镜像（TokenLedger 发放后回写，单一展示源为 token.json） */
  syncTokens(stats: { total_supply: number; distributed: number; holders: number }): IdeaLedgerData {
    const data = this.read()
    data.assets.tokens = { ...stats }
    return this.persist()
  }
}
