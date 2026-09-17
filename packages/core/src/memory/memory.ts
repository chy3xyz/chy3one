import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export type MemoryScope = 'global' | 'workflow' | 'agent'
export type MemoryCategory =
  | 'soul' | 'user' | 'project' | 'fact' | 'lesson' | 'topic' | 'rules'

export interface MemoryEntry {
  id: string
  scope: MemoryScope
  category: MemoryCategory
  content: string
  /** 0..1，黑板仲裁与检索排序共用 */
  confidence: number
  /** 秒；检索时惰性过期（应对 AR-RK07 记忆膨胀） */
  ttl?: number
  createdAt: number
  /**
   * 所有者用户 ID（多用户模式，可选）：
   * undefined = 存量共享条目（登录用户均可见）；写入时带 owner 即个人条目。
   */
  owner?: string
}

export type NewMemoryEntry = Omit<MemoryEntry, 'id' | 'createdAt'>

export interface MemoryQuery {
  scope?: MemoryScope
  category?: MemoryCategory
  keyword?: string
  limit?: number
  /**
   * 按所有者过滤（多用户口径）：命中 owner 相等的个人条目 + 无主共享条目；
   * 不传 = 不做所有者过滤（v1 行为，见全部）。
   */
  owner?: string
}

export interface MemoryStore {
  write(entry: NewMemoryEntry): MemoryEntry
  query(criteria: MemoryQuery): MemoryEntry[]
}

/**
 * 双记忆系统（ARD-004）的通用存储：Memory(知识) 与 Instinct(行为) 共用此实现，
 * 仅实例化路径不同（memories.jsonl / instincts.jsonl）。
 * append-only 落盘满足 AR-R03；检索为内存倒排 + 关键词匹配，Phase 2 换 SQLite FTS5。
 */
export class JsonlMemoryStore implements MemoryStore {
  private entries: MemoryEntry[] = []
  private now: () => number

  constructor(
    private readonly filePath?: string,
    now: () => number = Date.now,
  ) {
    this.now = now
    if (filePath && existsSync(filePath)) {
      for (const line of readFileSync(filePath, 'utf8').split('\n')) {
        if (line.trim()) this.entries.push(JSON.parse(line))
      }
    }
  }

  write(entry: NewMemoryEntry): MemoryEntry {
    if (entry.confidence < 0 || entry.confidence > 1) {
      throw new RangeError('confidence must be within [0,1]')
    }
    const full: MemoryEntry = { ...entry, id: randomUUID(), createdAt: this.now() }
    this.entries.push(full)
    if (this.filePath) appendFileSync(this.filePath, JSON.stringify(full) + '\n')
    return full
  }

  query(criteria: MemoryQuery): MemoryEntry[] {
    const nowSec = this.now() / 1000
    const keyword = criteria.keyword?.toLowerCase()
    return this.entries
      .filter((e) => {
        if (e.ttl !== undefined && e.createdAt / 1000 + e.ttl < nowSec) return false
        if (criteria.scope && e.scope !== criteria.scope) return false
        if (criteria.category && e.category !== criteria.category) return false
        // 多用户口径：按 owner 过滤 = 该用户的个人条目 + 无主共享条目
        if (criteria.owner && e.owner !== undefined && e.owner !== criteria.owner) return false
        if (keyword && !e.content.toLowerCase().includes(keyword)) return false
        return true
      })
      .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
      .slice(0, criteria.limit ?? 10)
  }
}
