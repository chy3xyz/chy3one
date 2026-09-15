import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { PermissionError, ConflictError } from '../errors.js'
import type {
  BlackboardEntry,
  BlackboardScope,
  BlackboardWrite,
  WriteResult,
  WriterRole,
} from './blackboard.js'

/**
 * node:sqlite 在 @types/node >= 22.10 中已内置类型声明；
 * 若使用更旧的 @types/node，可取消下方注释补充最小模块声明：
 *
 * declare module 'node:sqlite' {
 *   export class DatabaseSync {
 *     constructor(path: string)
 *     exec(sql: string): void
 *     prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): Record<string, unknown>[]; get(...p: unknown[]): Record<string, unknown> | undefined }
 *     close(): void
 *   }
 * }
 */

interface BlackboardRow {
  id: string
  scope: string
  key: string
  version: number
  value: string
  writer: string
  role: string
  confidence: number | null
  updated_at: number
}

const SELECT_LATEST = `
  SELECT id, scope, "key" AS key, version, value, writer, role, confidence, updated_at
  FROM blackboard_entries`

function rowToEntry(row: BlackboardRow): BlackboardEntry {
  return {
    id: row.id,
    scope: row.scope as BlackboardScope,
    key: row.key,
    value: JSON.parse(row.value) as unknown,
    writer: row.writer,
    role: row.role as WriterRole,
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    version: row.version,
    updatedAt: row.updated_at,
  }
}

/**
 * SQLite WAL 持久化黑板（TD-01 / AR-P04）：与 InMemoryBlackboard 相同的
 * 公开方法与仲裁语义——global 仅 orchestrator 可写；乐观锁版本链；
 * 冲突按置信度优先、并列时新时间戳优先接管，败者得到
 * { status: 'conflict', resolvedBy: 'timestamp+confidence', winner }。
 *
 * 表设计：显式 (scope, key, version) 联合主键，每次写入追加新版本行，
 * 当前值 = 每个 (scope, key) 的 MAX(version) 行——重启后版本号自然延续。
 */
export class SqliteBlackboard {
  private readonly db: DatabaseSync
  private readonly insertStmt: ReturnType<DatabaseSync['prepare']>
  private readonly currentStmt: ReturnType<DatabaseSync['prepare']>
  private readonly readStmt: ReturnType<DatabaseSync['prepare']>
  private readonly now: () => number

  constructor(path: string, now: () => number = Date.now) {
    this.now = now
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blackboard_entries (
        id         TEXT NOT NULL,
        scope      TEXT NOT NULL,
        key        TEXT NOT NULL,
        version    INTEGER NOT NULL,
        value      TEXT NOT NULL,
        writer     TEXT NOT NULL,
        role       TEXT NOT NULL,
        confidence REAL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key, version)
      )
    `)
    this.insertStmt = this.db.prepare(
      'INSERT INTO blackboard_entries (id, scope, "key", version, value, writer, role, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    this.currentStmt = this.db.prepare(`${SELECT_LATEST}
      WHERE scope = ? AND "key" = ?
      ORDER BY version DESC
      LIMIT 1`)
    this.readStmt = this.db.prepare(`${SELECT_LATEST} cur
      WHERE cur.scope = ?
        AND (? IS NULL OR cur."key" = ?)
        AND cur.version = (SELECT MAX(v.version) FROM blackboard_entries v
                           WHERE v.scope = cur.scope AND v."key" = cur."key")
      ORDER BY cur.updated_at DESC`)
  }

  read(scope: BlackboardScope, key?: string): BlackboardEntry[] {
    const rows = this.readStmt.all(scope, key ?? null, key ?? null) as unknown as BlackboardRow[]
    return rows.map(rowToEntry)
  }

  write(op: BlackboardWrite): WriteResult {
    if (op.scope === 'global' && op.role !== 'orchestrator') {
      throw new PermissionError(`global scope is writable by orchestrator only (writer=${op.writer})`)
    }
    // 读-判-写在单连接上以 IMMEDIATE 事务串行化，跨连接亦不丢版本链
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.writeLocked(op)
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 事务已结束（如 COMMIT 本身失败），无需回滚
      }
      throw err
    }
  }

  private writeLocked(op: BlackboardWrite): WriteResult {
    const mapKey = `${op.scope}:${op.key}`
    const current = this.current(op.scope, op.key)

    if (!current) {
      if (op.expectedVersion !== 0) {
        throw new ConflictError(`entry ${mapKey} does not exist; expectedVersion must be 0`)
      }
      const entry: BlackboardEntry = {
        id: randomUUID(),
        scope: op.scope,
        key: op.key,
        value: op.value,
        writer: op.writer,
        role: op.role,
        confidence: op.confidence ?? 0.5,
        version: 1,
        updatedAt: this.now(),
      }
      this.insert(entry)
      return { status: 'ok', entry }
    }

    if (op.expectedVersion !== current.version) {
      // 乐观锁冲突：按 置信度 优先、并列时新时间戳 优先仲裁
      const challengerConf = op.confidence ?? 0
      const now = this.now()
      const winner =
        challengerConf > (current.confidence ?? 0) ||
        (challengerConf === (current.confidence ?? 0) && current.updatedAt < now)
      if (winner) {
        const entry: BlackboardEntry = {
          ...current,
          value: op.value,
          writer: op.writer,
          role: op.role,
          confidence: challengerConf,
          version: current.version + 1,
          updatedAt: now,
        }
        this.insert(entry)
        return { status: 'ok', entry }
      }
      return { status: 'conflict', resolvedBy: 'timestamp+confidence', winner: current }
    }

    const entry: BlackboardEntry = {
      ...current,
      value: op.value,
      writer: op.writer,
      role: op.role,
      confidence: op.confidence ?? current.confidence,
      version: current.version + 1,
      updatedAt: this.now(),
    }
    this.insert(entry)
    return { status: 'ok', entry }
  }

  /** (scope, key) 的最新版本行；不存在则 undefined */
  private current(scope: BlackboardScope, key: string): BlackboardEntry | undefined {
    const row = this.currentStmt.get(scope, key) as BlackboardRow | undefined
    return row === undefined ? undefined : rowToEntry(row)
  }

  private insert(entry: BlackboardEntry): void {
    this.insertStmt.run(
      entry.id,
      entry.scope,
      entry.key,
      entry.version,
      JSON.stringify(entry.value) ?? 'null',
      entry.writer,
      entry.role,
      entry.confidence ?? null,
      entry.updatedAt,
    )
  }

  close(): void {
    this.db.close()
  }
}
