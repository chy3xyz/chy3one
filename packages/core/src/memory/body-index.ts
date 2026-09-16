import { DatabaseSync } from 'node:sqlite'
import { OpcError } from '../errors.js'
import type { IdeaMemoryStream } from '../idea/types.js'
import { IDEA_MEMORY_STREAMS } from '../idea/types.js'

/**
 * 创意记忆体条目（prd2.md 2.4 / 8.3）：JSONL 为 append-only 正本，本索引为检索镜像。
 * authority 对应 LMA 双权威（prd2.md 8.3）：user=用户钦定，model=模型自动总结。
 */
export interface BodyEntry {
  id: string
  ideaId: string
  stream: IdeaMemoryStream
  authority: 'user' | 'model'
  content: string
  /** 0..1，检索排序 */
  confidence: number
  createdAt: number
}

export interface BodyWrite {
  content: string
  confidence: number
  authority?: 'user' | 'model'
}

export interface BodyQuery {
  /** 关键词：≥3 字符（按码点）走 FTS5 trigram 任意子串，<3 字符回退 LIKE */
  keyword?: string
  /** 检索范围：仅命中给出的记忆体（挂载隔离，prd2.md 8.3 检索隔离行） */
  ideaIds: readonly string[]
  stream?: IdeaMemoryStream
  authority?: 'user' | 'model'
  limit?: number
}

interface BodyRow {
  id: string
  idea_id: string
  stream: string
  authority: string
  content: string
  confidence: number
  created_at: number
}

function rowToEntry(row: BodyRow): BodyEntry {
  return {
    id: row.id,
    ideaId: row.idea_id,
    stream: row.stream as IdeaMemoryStream,
    authority: row.authority as 'user' | 'model',
    content: row.content,
    confidence: row.confidence,
    createdAt: row.created_at,
  }
}

/** LIKE 字面量转义（% _ \） */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * 记忆体检索索引（全部创意共用一个 SQLite 库，FTS5 trigram 提供
 * "中英文 ≥3 字符任意子串命中"（prd2.md 8.3 FTS5 行）。
 *
 * 检索隔离不靠分库而靠 idea_id 过滤列：查询必带 ideaIds 集合
 * （挂载管理器保证只传入已挂载的创意），未挂载记忆体的条目物理在库但不可达——
 * 与 PRD"挂载按会话控制"一致；独立库版（每创意一个 .db）留待规模验证后评估。
 *
 * trigram 不可用的 SQLite 构建自动降级为 LIKE 检索（功能等价，性能次之）。
 */
export class MemoryBodyIndex {
  private readonly db: DatabaseSync
  private readonly ftsAvailable: boolean
  private readonly now: () => number

  constructor(path: string, now: () => number = Date.now) {
    this.now = now
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS body_entries (
        id         TEXT PRIMARY KEY,
        idea_id    TEXT NOT NULL,
        stream     TEXT NOT NULL,
        authority  TEXT NOT NULL,
        content    TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_body_idea ON body_entries (idea_id, stream, created_at DESC)')
    let fts = false
    try {
      this.db.exec(
        // entry_id UNINDEXED：与主表 id 关联（rowid 序列两表独立，不可作 join 键）
        `CREATE VIRTUAL TABLE IF NOT EXISTS body_fts USING fts5(content, idea_id UNINDEXED, entry_id UNINDEXED, tokenize='trigram')`,
      )
      fts = true
    } catch {
      fts = false
    }
    this.ftsAvailable = fts
  }

  /** 追加索引镜像（JSONL 正本写入后由 MemoryBodyHub 调用；entry.id/createdAt 已由 hub 分配） */
  append(entry: BodyEntry): void {
    this.db
      .prepare(
        'INSERT INTO body_entries (id, idea_id, stream, authority, content, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(entry.id, entry.ideaId, entry.stream, entry.authority, entry.content, entry.confidence, entry.createdAt)
    if (this.ftsAvailable) {
      this.db
        .prepare('INSERT INTO body_fts (content, idea_id, entry_id) VALUES (?, ?, ?)')
        .run(entry.content, entry.ideaId, entry.id)
    }
  }

  /**
   * 检索：confidence DESC, createdAt DESC；ideaIds 为必带过滤（空集合 → 空结果）。
   * FTS5 路径要求关键词 ≥3 码点（trigram 语义），否则走 LIKE；
   * FTS5 MATCH 异常（特殊字符等）同样回退 LIKE，检索永不因查询语法失败。
   */
  query(criteria: BodyQuery): BodyEntry[] {
    const ideaIds = [...criteria.ideaIds]
    if (ideaIds.length === 0) return []
    const limit = criteria.limit ?? 10
    const keyword = criteria.keyword

    const baseWhere = [`idea_id IN (${ideaIds.map(() => '?').join(', ')})`]
    const baseParams: (string | number)[] = ideaIds
    if (criteria.stream) {
      baseWhere.push('stream = ?')
      baseParams.push(criteria.stream)
    }
    if (criteria.authority) {
      baseWhere.push('authority = ?')
      baseParams.push(criteria.authority)
    }

    const useFts =
      this.ftsAvailable && keyword !== undefined && [...keyword].length >= 3 && !keyword.includes('"')
    if (keyword !== undefined && useFts) {
      try {
        const where = baseWhere.length > 0 ? `AND ${baseWhere.join(' AND ')}` : ''
        const rows = this.db
          .prepare(
            `SELECT b.id, b.idea_id, b.stream, b.authority, b.content, b.confidence, b.created_at
             FROM body_fts f
             JOIN body_entries b ON b.id = f.entry_id
             WHERE body_fts MATCH ? ${where}
             ORDER BY b.confidence DESC, b.created_at DESC
             LIMIT ?`,
          )
          .all(...([`"${keyword}"`, ...baseParams, limit] as (string | number)[])) as unknown as BodyRow[]
        return rows.map(rowToEntry)
      } catch {
        // MATCH 语法异常 → 落入 LIKE 路径
      }
    }

    const where = [...baseWhere]
    const params = [...baseParams]
    if (keyword !== undefined) {
      where.push("content LIKE '%' || ? || '%' ESCAPE '\\'")
      params.push(escapeLike(keyword))
    }
    const rows = this.db
      .prepare(
        `SELECT id, idea_id, stream, authority, content, confidence, created_at
         FROM body_entries
         WHERE ${where.join(' AND ')}
         ORDER BY confidence DESC, created_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as BodyRow[]
    return rows.map(rowToEntry)
  }

  countByIdea(ideaId: string): number {
    const rows = this.db
      .prepare('SELECT COUNT(*) AS n FROM body_entries WHERE idea_id = ?')
      .all(ideaId) as unknown as Array<{ n: number | bigint }>
    return Number(rows[0].n)
  }

  close(): void {
    this.db.close()
  }
}

/** 校验流名（MemoryBodyHub.write 入口防呆） */
export function requireStream(stream: string): IdeaMemoryStream {
  if (!(IDEA_MEMORY_STREAMS as readonly string[]).includes(stream)) {
    throw new OpcError('VALIDATION_ERROR', `stream must be one of: ${IDEA_MEMORY_STREAMS.join(', ')}`)
  }
  return stream as IdeaMemoryStream
}
