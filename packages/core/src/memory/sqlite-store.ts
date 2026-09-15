import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  MemoryCategory,
  MemoryEntry,
  MemoryQuery,
  MemoryScope,
  MemoryStore,
  NewMemoryEntry,
} from './memory.js'

/**
 * node:sqlite 在 @types/node >= 22.10 中已内置类型声明；
 * 若使用更旧的 @types/node，可取消下方注释补充最小模块声明：
 *
 * declare module 'node:sqlite' {
 *   export class DatabaseSync {
 *     constructor(path: string)
 *     exec(sql: string): void
 *     prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): Record<string, unknown>[] }
 *     close(): void
 *   }
 * }
 */

interface MemoryRow {
  id: string
  scope: string
  category: string
  content: string
  confidence: number
  ttl: number | null
  created_at: number
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    category: row.category as MemoryCategory,
    content: row.content,
    confidence: row.confidence,
    ...(row.ttl !== null ? { ttl: row.ttl } : {}),
    createdAt: row.created_at,
  }
}

/**
 * SQLite 持久化记忆存储（TD-01 / AR-P03 / AR-E06）：
 * 与 JsonlMemoryStore 完全同语义（置信度排序、TTL 惰性过期、默认 limit 10），
 * keyword 用 LIKE 匹配（Phase 2 换 FTS5）。WAL 模式支持并发读。
 */
export class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync
  private readonly insertStmt: ReturnType<DatabaseSync['prepare']>
  private readonly now: () => number

  constructor(path: string, now: () => number = Date.now) {
    this.now = now
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    // WAL 下的推荐档位：commit 不逐次 fsync，断电至多丢最近事务、不损坏库
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id         TEXT PRIMARY KEY,
        scope      TEXT NOT NULL,
        category   TEXT NOT NULL,
        content    TEXT NOT NULL,
        confidence REAL NOT NULL,
        ttl        INTEGER,
        created_at INTEGER NOT NULL
      )
    `)
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_memory_scope_category ON memory_entries (scope, category)',
    )
    this.insertStmt = this.db.prepare(
      'INSERT INTO memory_entries (id, scope, category, content, confidence, ttl, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
  }

  write(entry: NewMemoryEntry): MemoryEntry {
    if (entry.confidence < 0 || entry.confidence > 1) {
      throw new RangeError('confidence must be within [0,1]')
    }
    const full: MemoryEntry = { ...entry, id: randomUUID(), createdAt: this.now() }
    this.insertStmt.run(
      full.id,
      full.scope,
      full.category,
      full.content,
      full.confidence,
      full.ttl ?? null,
      full.createdAt,
    )
    return full
  }

  /**
   * 批量写入（基准灌数 / AR-E06 容量场景）：语义与逐条 write 一致，
   * 单事务提交避免 10 万次独立 commit 的 WAL 刷盘开销。
   */
  writeAll(entries: readonly NewMemoryEntry[]): MemoryEntry[] {
    const written: MemoryEntry[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const entry of entries) written.push(this.write(entry))
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return written
  }

  query(criteria: MemoryQuery): MemoryEntry[] {
    // TTL 惰性过期与 JsonlMemoryStore 等价：
    // 过期条件 createdAt/1000 + ttl < now/1000 ⟺ created_at + ttl*1000 < now(ms)
    const where: string[] = ['(ttl IS NULL OR created_at + ttl * 1000 >= ?)']
    const params: (string | number)[] = [this.now()]
    if (criteria.scope) {
      where.push('scope = ?')
      params.push(criteria.scope)
    }
    if (criteria.category) {
      where.push('category = ?')
      params.push(criteria.category)
    }
    if (criteria.keyword) {
      // LIKE 默认对 ASCII 大小写不敏感；% / _ 作为通配符（Phase 2 换 FTS5 后消除）
      where.push("content LIKE '%' || ? || '%'")
      params.push(criteria.keyword)
    }
    const rows = this.db
      .prepare(
        `SELECT id, scope, category, content, confidence, ttl, created_at
         FROM memory_entries
         WHERE ${where.join(' AND ')}
         ORDER BY confidence DESC, created_at DESC
         LIMIT ?`,
      )
      .all(...params, criteria.limit ?? 10) as unknown as MemoryRow[]
    return rows.map(rowToEntry)
  }

  close(): void {
    this.db.close()
  }
}
