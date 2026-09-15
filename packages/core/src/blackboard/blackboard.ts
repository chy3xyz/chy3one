import { randomUUID } from 'node:crypto'
import { PermissionError, ConflictError } from '../errors.js'

export type BlackboardScope = 'global' | 'workflow'
export type WriterRole = 'orchestrator' | 'agent'

export interface BlackboardEntry {
  id: string
  scope: BlackboardScope
  /** 共享黑板条目的逻辑键，同一 key 的写入构成乐观锁版本链 */
  key: string
  value: unknown
  writer: string
  role: WriterRole
  /** 冲突仲裁置信度 */
  confidence?: number
  /** 乐观锁版本号，从 1 起 */
  version: number
  updatedAt: number
}

export interface BlackboardWrite {
  scope: BlackboardScope
  key: string
  value: unknown
  writer: string
  role: WriterRole
  /** 调用方所见的前一版本；0 表示新建 */
  expectedVersion: number
  /** 冲突仲裁用置信度（PRD 6.2.2：时间戳+置信度优先级） */
  confidence?: number
}

export type WriteResult =
  | { status: 'ok'; entry: BlackboardEntry }
  | { status: 'conflict'; resolvedBy: 'timestamp+confidence'; winner: BlackboardEntry }

/**
 * 黑板（ARD-002）：global scope 仅 orchestrator 可写；
 * 并发写冲突按“时间戳+置信度”仲裁，保留高优先级写入（AR-P04 / AC-03）。
 * 内存实现，存储接口在 Phase 3 换 SQLite WAL（TD-01）。
 */
export class InMemoryBlackboard {
  private entries = new Map<string, BlackboardEntry>()
  private now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  read(scope: BlackboardScope, key?: string): BlackboardEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.scope === scope && (key === undefined || e.key === key))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  write(op: BlackboardWrite): WriteResult {
    if (op.scope === 'global' && op.role !== 'orchestrator') {
      throw new PermissionError(`global scope is writable by orchestrator only (writer=${op.writer})`)
    }
    const mapKey = `${op.scope}:${op.key}`
    const current = this.entries.get(mapKey)

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
      this.entries.set(mapKey, entry)
      return { status: 'ok', entry }
    }

    if (op.expectedVersion !== current.version) {
      // 乐观锁冲突：按 置信度 优先、并列时新时间戳 优先仲裁
      const challengerConf = op.confidence ?? 0
      const winner =
        challengerConf > (current.confidence ?? 0) ||
        (challengerConf === (current.confidence ?? 0) && current.updatedAt < this.now())
      if (winner) {
        const entry: BlackboardEntry = {
          ...current,
          value: op.value,
          writer: op.writer,
          role: op.role,
          confidence: challengerConf,
          version: current.version + 1,
          updatedAt: this.now(),
        }
        this.entries.set(mapKey, entry)
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
    this.entries.set(mapKey, entry)
    return { status: 'ok', entry }
  }
}
