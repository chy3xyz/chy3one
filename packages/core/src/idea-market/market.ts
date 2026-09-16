import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OpcError } from '../errors.js'
import type { IdeaStage } from '../idea/types.js'

/**
 * 创意市场（prd2.md 6，8.2 creativeos/idea-marketplace 算法层）：
 * - 展示/搜索：公开摘要（FTS5 trigram 中英文 ≥3 字子串检索，IM-05 <500ms）
 * - 关注：follower 登记 + 阶段变更通知（IM-02）
 * - 关联发现：三域文本 bigram 相似度 + 阶段互补性 → 互补/相似两类（IM-03，prd2.md 6.3）
 * - 协同：贡献记录（IM-04，prd2.md 6.4，Token 分配由 TokenLedger 按权重执行）
 * - 排行：资产规模 / 社区活跃 / GEO 表现（IM-06）
 *
 * SQLite 为查询真源；publish 时同步落 ideas-market/<id>/summary.json 文件镜像
 * （prd2.md 6.5 文件模型，供 DSH 侧工具直接读取）。
 */

export interface IdeaMarketSummary {
  ideaId: string
  name: string
  stage: IdeaStage
  problemSummary: string
  solutionSummary: string
  spacetimeSummary: string
  /** 资产规模口径：财务收入合计（分） */
  financeTotalCents: number
  geoVisibility: number
  publishedAt: number
  /** 关注计数（follow/unfollow 维护） */
  followers: number
}

export type RelationType = 'complementary' | 'similar'

export interface IdeaRelation {
  a: string
  b: string
  type: RelationType
  /** 0..1 相似度/互补度评分 */
  score: number
  reason: string
}

/** 协同角色与 Token 分配权重（prd2.md 6.4 协同收益分配表） */
export const COLLAB_ROLES = [
  { role: 'founder', label: '创意发起人', weight: 25 },
  { role: 'developer', label: 'MVP开发者', weight: 20 },
  { role: 'operator', label: '内容运营者', weight: 20 },
  { role: 'asset-manager', label: '资产管理者', weight: 10 },
  { role: 'promoter', label: '社区推广者', weight: 15 },
  { role: 'platform', label: '平台', weight: 10 },
] as const

export type CollabRole = (typeof COLLAB_ROLES)[number]['role']

export interface CollabRecord {
  id: string
  ideaId: string
  userId: string
  role: CollabRole
  contribution: string
  tokensGranted: number
  at: number
}

interface SummaryRow {
  idea_id: string
  name: string
  stage: string
  problem_summary: string
  solution_summary: string
  spacetime_summary: string
  finance_total_cents: number
  geo_visibility: number
  published_at: number
  followers: number
}

function rowToSummary(row: SummaryRow): IdeaMarketSummary {
  return {
    ideaId: row.idea_id,
    name: row.name,
    stage: row.stage as IdeaStage,
    problemSummary: row.problem_summary,
    solutionSummary: row.solution_summary,
    spacetimeSummary: row.spacetime_summary,
    financeTotalCents: row.finance_total_cents,
    geoVisibility: row.geo_visibility,
    publishedAt: row.published_at,
    followers: row.followers,
  }
}

/** 归一化文本 → 2-gram 集合（中英混排，与 content/strategy 同法） */
function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const grams = new Set<string>()
  for (const token of normalized.split(' ')) {
    if (token.length < 2) continue
    for (let i = 0; i < token.length - 1; i++) grams.add(token.slice(i, i + 2))
  }
  return grams
}

/** Jaccard 相似度（|A∩B| / |A∪B|，空集为 0） */
function similarity(a: string, b: string): number {
  const ga = bigrams(a)
  const gb = bigrams(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter)
}

/** LIKE 字面量转义 */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** 关联判定阈值（PRD 6.3 关联算法：向量相似 + 关键词 + 阶段互补的启发式落地） */
const SIMILAR_THRESHOLD = 0.12
const CROSS_THRESHOLD = 0.08

/**
 * 关联发现（prd2.md 6.3）：
 * - 互补：A 的问题域 ↔ B 的解决域 命中（B 的方案解决 A 的问题），或
 *   双方解决域同域且阶段不同（产品互补，可协同）；
 * - 相似：问题域 ↔ 问题域 或 解决域 ↔ 解决域 高度相似（可合并/协同）。
 * 返回分型与得分；两类都不命中返回 null。
 */
export function classifyRelation(
  a: Pick<IdeaMarketSummary, 'ideaId' | 'stage' | 'problemSummary' | 'solutionSummary'>,
  b: Pick<IdeaMarketSummary, 'ideaId' | 'stage' | 'problemSummary' | 'solutionSummary'>,
): IdeaRelation | null {
  if (a.ideaId === b.ideaId) return null
  const crossAB = similarity(a.problemSummary, b.solutionSummary)
  const crossBA = similarity(b.problemSummary, a.solutionSummary)
  const sameProblem = similarity(a.problemSummary, b.problemSummary)
  const sameSolution = similarity(a.solutionSummary, b.solutionSummary)
  const cross = Math.max(crossAB, crossBA)
  const same = Math.max(sameProblem, sameSolution)

  // 阶段互补加成：不同阶段的解决方案同域 → 产品互补（如 描述期方案 × 运营期方案）
  const stageComplement = a.stage !== b.stage && sameSolution >= CROSS_THRESHOLD
  const complementaryScore = Math.max(cross, stageComplement ? sameSolution : 0)

  if (complementaryScore >= CROSS_THRESHOLD && complementaryScore >= same) {
    const reason = crossAB >= crossBA
      ? `「${b.ideaId}」的解决方案覆盖「${a.ideaId}」的问题域，可协同互补`
      : `「${a.ideaId}」的解决方案覆盖「${b.ideaId}」的问题域，可协同互补`
    return { a: a.ideaId, b: b.ideaId, type: 'complementary', score: Math.round(complementaryScore * 100) / 100, reason }
  }
  if (same >= SIMILAR_THRESHOLD) {
    const reason = sameProblem >= sameSolution
      ? `两者问题域高度相似，可考虑合并建议或协同拆解`
      : `两者解决方案高度相似，可考虑合并建议或差异化协同`
    return { a: a.ideaId, b: b.ideaId, type: 'similar', score: Math.round(same * 100) / 100, reason }
  }
  return null
}

export interface MarketQuery {
  keyword?: string
  stage?: IdeaStage
  limit?: number
}

export type RankingKey = 'assets' | 'community' | 'geo'

/**
 * 创意市场索引（SQLite，FTS5 trigram 检索）。
 * publish/unpublish 维护摘要；关注/协同/关联为关系表；排行三类直查。
 */
export class SqliteIdeaMarket {
  private readonly db: DatabaseSync
  private readonly ftsAvailable: boolean
  private readonly marketRoot: string | undefined
  private readonly now: () => number

  constructor(dbPath: string, options?: { marketRoot?: string; now?: () => number }) {
    this.marketRoot = options?.marketRoot
    this.now = options?.now ?? Date.now
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_summaries (
        idea_id            TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        stage              TEXT NOT NULL,
        problem_summary    TEXT NOT NULL DEFAULT '',
        solution_summary   TEXT NOT NULL DEFAULT '',
        spacetime_summary  TEXT NOT NULL DEFAULT '',
        finance_total_cents INTEGER NOT NULL DEFAULT 0,
        geo_visibility     REAL NOT NULL DEFAULT 0,
        published_at       INTEGER NOT NULL,
        followers          INTEGER NOT NULL DEFAULT 0
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_follows (
        idea_id  TEXT NOT NULL,
        follower TEXT NOT NULL,
        at       INTEGER NOT NULL,
        PRIMARY KEY (idea_id, follower)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_notifications (
        id       TEXT PRIMARY KEY,
        idea_id  TEXT NOT NULL,
        follower TEXT NOT NULL,
        message  TEXT NOT NULL,
        at       INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_relations (
        a     TEXT NOT NULL,
        b     TEXT NOT NULL,
        type  TEXT NOT NULL,
        score REAL NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY (a, b)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS market_collaborators (
        id             TEXT PRIMARY KEY,
        idea_id        TEXT NOT NULL,
        user_id        TEXT NOT NULL,
        role           TEXT NOT NULL,
        contribution   TEXT NOT NULL,
        tokens_granted INTEGER NOT NULL DEFAULT 0,
        at             INTEGER NOT NULL
      )
    `)
    let fts = false
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS market_fts USING fts5(text, idea_id UNINDEXED, tokenize='trigram')`,
      )
      fts = true
    } catch {
      fts = false
    }
    this.ftsAvailable = fts
  }

  /**
   * 发布/更新公开摘要（IM-01/ID-05）：索引 upsert + summary.json 文件镜像。
   * 发布后立即可检索（本地市场，无同步延迟）。
   */
  publish(summary: IdeaMarketSummary): void {
    this.db
      .prepare(
        `INSERT INTO market_summaries
         (idea_id, name, stage, problem_summary, solution_summary, spacetime_summary, finance_total_cents, geo_visibility, published_at, followers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idea_id) DO UPDATE SET
           name = excluded.name, stage = excluded.stage,
           problem_summary = excluded.problem_summary, solution_summary = excluded.solution_summary,
           spacetime_summary = excluded.spacetime_summary,
           finance_total_cents = excluded.finance_total_cents, geo_visibility = excluded.geo_visibility`,
      )
      .run(
        summary.ideaId, summary.name, summary.stage, summary.problemSummary, summary.solutionSummary,
        summary.spacetimeSummary, summary.financeTotalCents, summary.geoVisibility, summary.publishedAt,
        summary.followers,
      )
    if (this.ftsAvailable) {
      this.db.prepare('DELETE FROM market_fts WHERE idea_id = ?').run(summary.ideaId)
      this.db
        .prepare('INSERT INTO market_fts (text, idea_id) VALUES (?, ?)')
        .run(
          `${summary.name} ${summary.problemSummary} ${summary.solutionSummary} ${summary.spacetimeSummary}`,
          summary.ideaId,
        )
    }
    this.writeSummaryFile(summary)
  }

  /** summary.json 文件镜像（prd2.md 6.5 文件模型；目录缺席时静默跳过） */
  private writeSummaryFile(summary: IdeaMarketSummary): void {
    if (!this.marketRoot) return
    try {
      const dir = join(this.marketRoot, summary.ideaId)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(dir, 'summary.json'),
        JSON.stringify({ ...summary, relationsHint: 'via market relations API' }, null, 2) + '\n',
        { mode: 0o600 },
      )
    } catch {
      /* 镜像失败不影响索引 */
    }
  }

  get(ideaId: string): IdeaMarketSummary | undefined {
    const rows = this.db
      .prepare('SELECT * FROM market_summaries WHERE idea_id = ?')
      .all(ideaId) as unknown as SummaryRow[]
    return rows.length > 0 ? rowToSummary(rows[0]) : undefined
  }

  require(ideaId: string): IdeaMarketSummary {
    const summary = this.get(ideaId)
    if (!summary) throw new OpcError('IDEA_NOT_FOUND', `idea ${ideaId} is not published to the market`)
    return summary
  }

  list(): IdeaMarketSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM market_summaries ORDER BY published_at DESC')
      .all() as unknown as SummaryRow[]
    return rows.map(rowToSummary)
  }

  /** 检索（IM-05）：关键词（≥3 字走 FTS5 trigram 任意子串，<3 字回退 LIKE）+ 阶段过滤 */
  search(query: MarketQuery = {}): IdeaMarketSummary[] {
    const where: string[] = []
    const params: (string | number)[] = []
    const keyword = query.keyword
    let ftsIds: string[] | undefined
    if (keyword !== undefined && this.ftsAvailable && [...keyword].length >= 3 && !keyword.includes('"')) {
      try {
        const rows = this.db
          .prepare('SELECT idea_id FROM market_fts WHERE market_fts MATCH ?')
          .all(`"${keyword}"`) as unknown as Array<{ idea_id: string }>
        ftsIds = rows.map((r) => r.idea_id)
      } catch {
        ftsIds = undefined
      }
    }
    if (ftsIds !== undefined) {
      if (ftsIds.length === 0) return []
      where.push(`idea_id IN (${ftsIds.map(() => '?').join(', ')})`)
      params.push(...ftsIds)
    } else if (keyword !== undefined) {
      const like = `LIKE ('%' || ? || '%') ESCAPE '\\'`
      where.push(
        `(name ${like} OR problem_summary ${like} OR solution_summary ${like} OR spacetime_summary ${like})`,
      )
      params.push(escapeLike(keyword), escapeLike(keyword), escapeLike(keyword), escapeLike(keyword))
    }
    if (query.stage) {
      where.push('stage = ?')
      params.push(query.stage)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM market_summaries ${whereSql} ORDER BY followers DESC, published_at DESC LIMIT ?`)
      .all(...params, query.limit ?? 20) as unknown as SummaryRow[]
    return rows.map(rowToSummary)
  }

  /** 下架 */
  unpublish(ideaId: string): void {
    this.db.prepare('DELETE FROM market_summaries WHERE idea_id = ?').run(ideaId)
    if (this.ftsAvailable) this.db.prepare('DELETE FROM market_fts WHERE idea_id = ?').run(ideaId)
  }

  /* ─────────────── 关注（IM-02） ─────────────── */

  follow(ideaId: string, follower: string): { followers: number } {
    this.require(ideaId)
    if (follower.trim().length === 0) throw new OpcError('VALIDATION_ERROR', 'follower id must be non-empty')
    this.db
      .prepare('INSERT OR IGNORE INTO market_follows (idea_id, follower, at) VALUES (?, ?, ?)')
      .run(ideaId, follower.trim(), this.now())
    return this.refreshFollowers(ideaId)
  }

  unfollow(ideaId: string, follower: string): { followers: number } {
    this.db.prepare('DELETE FROM market_follows WHERE idea_id = ? AND follower = ?').run(ideaId, follower)
    return this.refreshFollowers(ideaId)
  }

  private refreshFollowers(ideaId: string): { followers: number } {
    this.db
      .prepare(`UPDATE market_summaries SET followers = (SELECT COUNT(*) FROM market_follows WHERE idea_id = ?) WHERE idea_id = ?`)
      .run(ideaId, ideaId)
    return { followers: this.get(ideaId)?.followers ?? 0 }
  }

  /** 阶段变更通知（IM-02：关注后收到阶段变更通知；lifecycle 迁移后调用） */
  notifyStageChange(ideaId: string, from: IdeaStage, to: IdeaStage): number {
    const followers = this.db
      .prepare('SELECT follower FROM market_follows WHERE idea_id = ?')
      .all(ideaId) as unknown as Array<{ follower: string }>
    const message = `关注的创意 ${ideaId} 已从 ${from} 推进到 ${to}`
    for (const { follower } of followers) {
      this.db
        .prepare('INSERT INTO market_notifications (id, idea_id, follower, message, at) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), ideaId, follower, message, this.now())
    }
    return followers.length
  }

  notificationsFor(follower: string, limit = 20): Array<{ ideaId: string; message: string; at: number }> {
    const rows = this.db
      .prepare('SELECT idea_id, message, at FROM market_notifications WHERE follower = ? ORDER BY at DESC LIMIT ?')
      .all(follower, limit) as unknown as Array<{ idea_id: string; message: string; at: number }>
    return rows.map((r) => ({ ideaId: r.idea_id, message: r.message, at: r.at }))
  }

  /* ─────────────── 关联发现（IM-03） ─────────────── */

  /** 重算某创意与市场内其他创意的关联（发布/更新后调用；成对写双行 a→b 与 b→a） */
  recomputeRelations(ideaId: string): IdeaRelation[] {
    const summaries = this.list().filter((s) => s.ideaId !== ideaId)
    const me = this.require(ideaId)
    this.db.prepare('DELETE FROM market_relations WHERE a = ? OR b = ?').run(ideaId, ideaId)
    const out: IdeaRelation[] = []
    for (const other of summaries) {
      const relation = classifyRelation(me, other)
      if (!relation) continue
      this.db
        .prepare('INSERT OR REPLACE INTO market_relations (a, b, type, score, reason) VALUES (?, ?, ?, ?, ?)')
        .run(relation.a, relation.b, relation.type, relation.score, relation.reason)
      this.db
        .prepare('INSERT OR REPLACE INTO market_relations (a, b, type, score, reason) VALUES (?, ?, ?, ?, ?)')
        .run(relation.b, relation.a, relation.type, relation.score, relation.reason)
      out.push(relation)
    }
    return out
  }

  relations(ideaId: string, type?: RelationType): IdeaRelation[] {
    const rows = (type
      ? this.db.prepare('SELECT a, b, type, score, reason FROM market_relations WHERE a = ? AND type = ? ORDER BY score DESC').all(ideaId, type)
      : this.db.prepare('SELECT a, b, type, score, reason FROM market_relations WHERE a = ? ORDER BY score DESC').all(ideaId)
    ) as unknown as Array<{ a: string; b: string; type: RelationType; score: number; reason: string }>
    return rows.map((r) => ({ a: r.a, b: r.b, type: r.type, score: r.score, reason: r.reason }))
  }

  /* ─────────────── 协同（IM-04，prd2.md 6.4） ─────────────── */

  recordCollaboration(input: {
    ideaId: string
    userId: string
    role: CollabRole
    contribution: string
    tokensGranted: number
  }): CollabRecord {
    this.require(input.ideaId)
    if (!COLLAB_ROLES.some((r) => r.role === input.role)) {
      throw new OpcError('VALIDATION_ERROR', `role must be one of: ${COLLAB_ROLES.map((r) => r.role).join(', ')}`)
    }
    if (input.userId.trim().length === 0) throw new OpcError('VALIDATION_ERROR', 'userId must be non-empty')
    const record: CollabRecord = {
      id: randomUUID(),
      ideaId: input.ideaId,
      userId: input.userId.trim(),
      role: input.role,
      contribution: input.contribution.trim() || '协同贡献',
      tokensGranted: input.tokensGranted,
      at: this.now(),
    }
    this.db
      .prepare(
        'INSERT INTO market_collaborators (id, idea_id, user_id, role, contribution, tokens_granted, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(record.id, record.ideaId, record.userId, record.role, record.contribution, record.tokensGranted, record.at)
    return record
  }

  collaborators(ideaId: string): CollabRecord[] {
    const rows = this.db
      .prepare('SELECT id, idea_id, user_id, role, contribution, tokens_granted, at FROM market_collaborators WHERE idea_id = ? ORDER BY at DESC')
      .all(ideaId) as unknown as Array<{
      id: string; idea_id: string; user_id: string; role: CollabRole; contribution: string; tokens_granted: number; at: number
    }>
    return rows.map((r) => ({
      id: r.id, ideaId: r.idea_id, userId: r.user_id, role: r.role, contribution: r.contribution,
      tokensGranted: r.tokens_granted, at: r.at,
    }))
  }

  /* ─────────────── 排行（IM-06） ─────────────── */

  ranking(by: RankingKey, limit = 10): IdeaMarketSummary[] {
    const order = by === 'assets'
      ? 'finance_total_cents DESC'
      : by === 'community'
        ? 'followers DESC'
        : 'geo_visibility DESC'
    const rows = this.db
      .prepare(`SELECT * FROM market_summaries ORDER BY ${order}, published_at DESC LIMIT ?`)
      .all(limit) as unknown as SummaryRow[]
    return rows.map(rowToSummary)
  }

  close(): void {
    this.db.close()
  }
}

/** 从创意目录读取 marketRoot 下的 summary 镜像（诊断用；缺失返回 undefined） */
export function readSummaryFile(marketRoot: string, ideaId: string): IdeaMarketSummary | undefined {
  const file = join(marketRoot, ideaId, 'summary.json')
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as IdeaMarketSummary
}
