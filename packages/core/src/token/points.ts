import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { OpcError } from '../errors.js'

/**
 * Meme Token 积分账本（prd2.md 5.4 / 6.5，R-02 合规定位）：
 * 社区积分凭证——不上链、不承诺任何金融回报；数据形态对齐 PRD
 * （assets/token.json 配置 + assets/distribution.json 分配流水）。
 * 分配模型（建议）：社区 45% / 创作者 25% / 协同贡献 20% / 生态储备 10%。
 */

export type TokenRole = 'community' | 'creator' | 'collaborator' | 'ecosystem'

export const TOKEN_ROLES: readonly TokenRole[] = ['community', 'creator', 'collaborator', 'ecosystem']

export const TOKEN_ROLE_LABELS: Record<TokenRole, string> = {
  community: '社区激励',
  creator: '创作者',
  collaborator: '协同贡献',
  ecosystem: '生态储备',
}

export interface TokenConfig {
  idea_id: string
  symbol: string
  total_supply: number
  allocation: Record<TokenRole, number>
  /** 已分配数量（发行后回写） */
  distributed: number
  holders: number
  note?: string
}

export interface TokenGrant {
  id: string
  to: string
  role: TokenRole
  amount: number
  reason: string
  at: number
}

/** 读取 token 配置（脚手架已生成；缺失时按默认模型构造） */
export function readTokenConfig(homeDir: string, ideaId: string): TokenConfig {
  const file = join(homeDir, 'assets', 'token.json')
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<TokenConfig>
      if (parsed && typeof parsed.total_supply === 'number') {
        return {
          idea_id: parsed.idea_id ?? ideaId,
          symbol: parsed.symbol ?? ideaId.toUpperCase(),
          total_supply: parsed.total_supply,
          allocation: parsed.allocation ?? { community: 45, creator: 25, collaborator: 20, ecosystem: 10 },
          distributed: parsed.distributed ?? 0,
          holders: parsed.holders ?? 0,
          note: parsed.note,
        }
      }
    } catch {
      /* 损坏配置按默认模型重建 */
    }
  }
  return {
    idea_id: ideaId,
    symbol: ideaId.toUpperCase(),
    total_supply: 1_000_000,
    allocation: { community: 45, creator: 25, collaborator: 20, ecosystem: 10 },
    distributed: 0,
    holders: 0,
    note: '社区积分凭证，非金融产品，不承诺任何回报（prd2.md R-02 合规定位）',
  }
}

/**
 * Token 积分账本：发行受总量与角色配额双重约束——
 * 累计发行（某角色）不得超过 配额% × 总量；总量不得超发。
 * 流水 append 到 distribution.json（JSONL），配置文件回写 distributed/holders。
 */
export class TokenLedger {
  private current: TokenConfig
  private grants: TokenGrant[]

  constructor(
    /** 创意目录（ideas/<id>/） */
    private readonly homeDir: string,
    private readonly ideaId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.current = readTokenConfig(homeDir, ideaId)
    this.grants = this.load()
  }

  private get grantsFile(): string {
    return join(this.homeDir, 'assets', 'distribution.json')
  }

  private load(): TokenGrant[] {
    if (!existsSync(this.grantsFile)) return []
    const grants: TokenGrant[] = []
    for (const line of readFileSync(this.grantsFile, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      try {
        grants.push(JSON.parse(line) as TokenGrant)
      } catch {
        /* 坏行跳过（append-only 流水） */
      }
    }
    return grants
  }

  config(): TokenConfig {
    return { ...this.current, allocation: { ...this.current.allocation } }
  }

  /** 分配流水（时间正序） */
  list(): TokenGrant[] {
    return [...this.grants]
  }

  /** 按角色累计已发行 */
  distributedByRole(role: TokenRole): number {
    return this.grants.filter((g) => g.role === role).reduce((sum, g) => sum + g.amount, 0)
  }

  stats(): { total_supply: number; distributed: number; holders: number } {
    return {
      total_supply: this.current.total_supply,
      distributed: this.current.distributed,
      holders: this.current.holders,
    }
  }

  /**
   * 发行（社区激励/创作者/协同贡献/生态）：
   * 超出角色配额或总量 → OpcError('TOKEN_ALLOCATION_EXCEEDED')（控制台映射 409）；
   * 负数/非整数 → RangeError。发行后回写 token.json 与 distribution.json。
   */
  issue(to: string, role: TokenRole, amount: number, reason: string): TokenGrant {
    if (typeof to !== 'string' || to.trim().length === 0) {
      throw new OpcError('VALIDATION_ERROR', 'field to must be a non-empty recipient id')
    }
    if (!TOKEN_ROLES.includes(role)) {
      throw new OpcError('VALIDATION_ERROR', `role must be one of: ${TOKEN_ROLES.join(', ')}`)
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new RangeError('amount must be a positive integer')
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new OpcError('VALIDATION_ERROR', 'field reason must be a non-empty string')
    }
    const cap = Math.floor((this.current.total_supply * this.current.allocation[role]) / 100)
    const roleIssued = this.distributedByRole(role)
    if (roleIssued + amount > cap) {
      throw new OpcError(
        'TOKEN_ALLOCATION_EXCEEDED',
        `角色「${TOKEN_ROLE_LABELS[role]}」配额 ${cap}，已发行 ${roleIssued}，本次 ${amount} 超出`,
      )
    }
    if (this.current.distributed + amount > this.current.total_supply) {
      throw new OpcError('TOKEN_ALLOCATION_EXCEEDED', '超出代币总量')
    }
    const grant: TokenGrant = { id: randomUUID(), to: to.trim(), role, amount, reason: reason.trim(), at: this.now() }
    this.grants.push(grant)
    this.current.distributed += amount
    this.current.holders = new Set(this.grants.map((g) => g.to)).size
    // 流水 append + 配置回写（两步都成功才一致；进程中断至多丢最近一笔回执）
    writeFileSync(this.grantsFile, JSON.stringify(grant) + '\n', { flag: 'a', mode: 0o600 })
    writeFileSync(join(this.homeDir, 'assets', 'token.json'), JSON.stringify(this.current, null, 2) + '\n', { mode: 0o600 })
    return grant
  }
}
