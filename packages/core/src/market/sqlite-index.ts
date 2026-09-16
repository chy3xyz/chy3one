import { DatabaseSync } from 'node:sqlite'
import { OpcError } from '../errors.js'
import { satisfies } from './semver.js'
import type { MarketSkill, SearchQuery } from './types.js'

interface SkillRow {
  id: string
  name: string
  version: string
  author_id: string
  price: number
  category: string
  downloads: number
  rating: number
  created_at: number
  compat_dsh: string
}

function rowToSkill(row: SkillRow): MarketSkill {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    authorId: row.author_id,
    price: row.price,
    category: row.category,
    downloads: row.downloads,
    rating: row.rating,
    createdAt: row.created_at,
    compat: { dsh: row.compat_dsh },
  }
}

/** LIKE 关键字按字面量匹配：% 与 _ 需转义 */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/**
 * Skill 市场索引（SF-05 / PRD 8.2 关键表结构）：
 * - skills：浏览 / 搜索主表（price 以“分”存 INTEGER，rating 对应 DECIMAL(3,2)）；
 * - metadata(skill_id, key, value)：rating_count（评分次数）、last_installed_at 等；
 * - WAL + synchronous=NORMAL（同 memory/sqlite-store.ts 档位）支撑 AR-P08 的 <500ms 检索。
 */
export class SqliteSkillIndex {
  private readonly db: DatabaseSync
  private readonly upsertStmt: ReturnType<DatabaseSync['prepare']>

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    // WAL 下的推荐档位：commit 不逐次 fsync，断电至多丢最近事务、不损坏库
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        version    TEXT NOT NULL,
        author_id  TEXT NOT NULL,
        price      INTEGER NOT NULL,
        category   TEXT NOT NULL,
        downloads  INTEGER NOT NULL DEFAULT 0,
        rating     REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        compat_dsh TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        skill_id TEXT NOT NULL,
        key      TEXT NOT NULL,
        value    TEXT NOT NULL,
        PRIMARY KEY (skill_id, key)
      )
    `)
    // category 精确过滤 + 热度排序可整体走索引；无 category 时退回全表热度序
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_skills_category ON skills (category, downloads DESC, rating DESC)',
    )
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_skills_popularity ON skills (downloads DESC, rating DESC)',
    )
    this.upsertStmt = this.db.prepare(`
      INSERT INTO skills (id, name, version, author_id, price, category, downloads, rating, created_at, compat_dsh)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name       = excluded.name,
        version    = excluded.version,
        author_id  = excluded.author_id,
        price      = excluded.price,
        category   = excluded.category,
        compat_dsh = excluded.compat_dsh
    `)
  }

  /**
   * 写入 / 更新市场条目：新版本覆盖展示字段（name/version/author_id/price/category/compat），
   * 但保留既有 downloads / rating / created_at —— 市场统计不随版本重置。
   * 条目不存在时按传入值整体插入（新上架 downloads/rating 通常为 0）。
   */
  upsert(skill: MarketSkill): void {
    this.upsertStmt.run(
      skill.id,
      skill.name,
      skill.version,
      skill.authorId,
      skill.price,
      skill.category,
      skill.downloads,
      skill.rating,
      skill.createdAt,
      skill.compat.dsh,
    )
  }

  /** 批量写入（基准灌数 / AR-P08 容量场景）：单事务提交，避免逐条 commit 的 WAL 刷盘开销 */
  upsertAll(skills: readonly MarketSkill[]): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const skill of skills) this.upsert(skill)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * 市场检索（SF-05 / AR-P08）：
   * keyword 对 name LIKE（ASCII 大小写不敏感、% _ 按字面量）、category 精确、
   * rating >= minRating；compatDsh（如 '0.1.5'）命中 compat.dsh semver 范围满足该版本的条目。
   * 排序 downloads DESC, rating DESC；LIMIT/OFFSET 分页（limit 默认 20）。
   */
  search(query: SearchQuery = {}): MarketSkill[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (query.keyword) {
      where.push("name LIKE '%' || ? || '%' ESCAPE '\\'")
      params.push(escapeLike(query.keyword))
    }
    if (query.category) {
      where.push('category = ?')
      params.push(query.category)
    }
    if (query.stage) {
      // SM-01 阶段过滤：stage 存 metadata 表（上架时写入），子查询避免主表冗余列
      where.push("id IN (SELECT skill_id FROM metadata WHERE key = 'stage' AND value = ?)")
      params.push(query.stage)
    }
    if (query.minRating !== undefined) {
      where.push('rating >= ?')
      params.push(query.minRating)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const orderBy = 'ORDER BY downloads DESC, rating DESC'
    const limit = query.limit ?? 20
    const offset = query.offset ?? 0

    if (query.compatDsh) {
      // semver 满足判断无法下推 SQL：先按其余过滤器全量取出，内存过滤后再分页，
      // 保证 compatDsh 与 LIMIT/OFFSET 组合时分页语义正确
      const rows = this.db
        .prepare(`SELECT * FROM skills ${whereSql} ${orderBy}`)
        .all(...params) as unknown as SkillRow[]
      return rows
        .filter((row) => satisfies(row.compat_dsh, query.compatDsh!))
        .slice(offset, offset + limit)
        .map(rowToSkill)
    }
    const rows = this.db
      .prepare(`SELECT * FROM skills ${whereSql} ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as SkillRow[]
    return rows.map(rowToSkill)
  }

  /** 下载计数 +1；条目不存在抛 SKILL_NOT_FOUND */
  incDownloads(id: string): void {
    const res = this.db
      .prepare('UPDATE skills SET downloads = downloads + 1 WHERE id = ?')
      .run(id) as unknown as { changes: number | bigint }
    if (Number(res.changes) === 0) {
      throw new OpcError('SKILL_NOT_FOUND', `skill ${id} not in market index`)
    }
  }

  /**
   * 评分（score 取值 [0,5]）：评分次数存 metadata.rating_count，
   * 按 (旧均值 × 次数 + score) / (次数 + 1) 重算平均存回 skills.rating（两位小数）。
   * 条目不存在抛 SKILL_NOT_FOUND。
   */
  rate(id: string, score: number): void {
    if (score < 0 || score > 5) throw new RangeError('score must be within [0,5]')
    const skill = this.get(id)
    if (!skill) throw new OpcError('SKILL_NOT_FOUND', `skill ${id} not in market index`)
    const count = Number(this.getMetadata(id, 'rating_count') ?? '0')
    const average = (skill.rating * count + score) / (count + 1)
    this.db
      .prepare('UPDATE skills SET rating = ? WHERE id = ?')
      .run(Math.round(average * 100) / 100, id)
    this.setMetadata(id, 'rating_count', String(count + 1))
  }

  get(id: string): MarketSkill | undefined {
    const rows = this.db
      .prepare('SELECT * FROM skills WHERE id = ?')
      .all(id) as unknown as SkillRow[]
    return rows.length > 0 ? rowToSkill(rows[0]) : undefined
  }

  /** 条目总数 */
  count(): number {
    const rows = this.db
      .prepare('SELECT COUNT(*) AS n FROM skills')
      .all() as unknown as Array<{ n: number | bigint }>
    return Number(rows[0].n)
  }

  setMetadata(skillId: string, key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO metadata (skill_id, key, value) VALUES (?, ?, ?)')
      .run(skillId, key, value)
  }

  getMetadata(skillId: string, key: string): string | undefined {
    const rows = this.db
      .prepare('SELECT value FROM metadata WHERE skill_id = ? AND key = ?')
      .all(skillId, key) as unknown as Array<{ value: string }>
    return rows.length > 0 ? rows[0].value : undefined
  }

  close(): void {
    this.db.close()
  }
}
