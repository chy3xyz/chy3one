import { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { OpcError } from '../errors.js'

/**
 * 用户账户（多用户云操作系统的身份层）：
 * - 密码：node:crypto scrypt（N=16384 默认）+ 每用户独立盐，存 `salt:hash`（hex）；
 *   校验走 timingSafeEqual 防时序侧信道。零第三方依赖。
 * - 用户名：`[a-zA-Z0-9_-]{2,32}`，唯一；displayName 可选（控制台展示用）。
 */

export interface User {
  id: string
  username: string
  displayName: string
  createdAt: number
}

interface UserRow {
  id: string
  username: string
  display_name: string
  password_hash: string
  created_at: number
}

const USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/
const MIN_PASSWORD_LEN = 6
/** 登录失败统一延迟（毫秒）：钝化暴力枚举，不区分用户存在与否 */
export const AUTH_FAIL_DELAY_MS = 300

function rowToUser(row: UserRow): User {
  return { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

export class UserStore {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(path: string, now: () => number = Date.now) {
    this.now = now
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      )
    `)
  }

  /**
   * 注册：用户名/密码规则校验 + 唯一性；重复抛 USERNAME_TAKEN（控制台映射 409）。
   * 密码明文只在调用栈内存在，落库前即散列。
   */
  register(input: { username: string; password: string; displayName?: string }): User {
    const username = input.username.trim()
    if (!USERNAME_RE.test(username)) {
      throw new OpcError('VALIDATION_ERROR', 'username must match [a-zA-Z0-9_-]{2,32}')
    }
    if (typeof input.password !== 'string' || input.password.length < MIN_PASSWORD_LEN) {
      throw new OpcError('VALIDATION_ERROR', `password must be at least ${MIN_PASSWORD_LEN} characters`)
    }
    if (this.getByUsername(username)) {
      throw new OpcError('USERNAME_TAKEN', `username ${username} is already taken`)
    }
    const user: User = {
      id: `user-${randomUUID().slice(0, 8)}`,
      username,
      displayName: input.displayName?.trim() || username,
      createdAt: this.now(),
    }
    this.db
      .prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, user.username, user.displayName, hashPassword(input.password), user.createdAt)
    return user
  }

  /** 校验密码：命中返回用户；失败统一返回 undefined（不泄露用户是否存在） */
  verify(username: string, password: string): User | undefined {
    const rows = this.db
      .prepare('SELECT id, username, display_name, password_hash, created_at FROM users WHERE username = ?')
      .all(username.trim()) as unknown as UserRow[]
    if (rows.length === 0) return undefined
    const row = rows[0]
    return verifyPassword(password, row.password_hash) ? rowToUser(row) : undefined
  }

  getById(id: string): User | undefined {
    const rows = this.db
      .prepare('SELECT id, username, display_name, password_hash, created_at FROM users WHERE id = ?')
      .all(id) as unknown as UserRow[]
    return rows.length > 0 ? rowToUser(rows[0]) : undefined
  }

  getByUsername(username: string): User | undefined {
    const rows = this.db
      .prepare('SELECT id, username, display_name, password_hash, created_at FROM users WHERE username = ?')
      .all(username.trim()) as unknown as UserRow[]
    return rows.length > 0 ? rowToUser(rows[0]) : undefined
  }

  /**
   * 修改密码：旧密码校验失败抛 AUTH_FAILED；新密码同样过长度规则。
   * 会话全部失效由调用方执行（revokeAllForUser）——改密即全端下线。
   */
  updatePassword(id: string, oldPassword: string, newPassword: string): void {
    const user = this.getById(id)
    if (!user) throw new OpcError('USER_NOT_FOUND', `user ${id} does not exist`)
    if (!verifyPassword(oldPassword, this.passwordHashOf(id))) {
      throw new OpcError('AUTH_FAILED', '旧密码不正确')
    }
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LEN) {
      throw new OpcError('VALIDATION_ERROR', `new password must be at least ${MIN_PASSWORD_LEN} characters`)
    }
    this.db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hashPassword(newPassword), id)
  }

  /** 修改昵称（展示名） */
  updateDisplayName(id: string, displayName: string): User {
    const trimmed = displayName.trim()
    if (trimmed.length === 0 || trimmed.length > 32) {
      throw new OpcError('VALIDATION_ERROR', 'displayName must be 1-32 characters')
    }
    const rows = this.db
      .prepare('UPDATE users SET display_name = ? WHERE id = ? RETURNING id, username, display_name, password_hash, created_at')
      .all(trimmed, id) as unknown as UserRow[]
    if (rows.length === 0) throw new OpcError('USER_NOT_FOUND', `user ${id} does not exist`)
    return rowToUser(rows[0])
  }

  private passwordHashOf(id: string): string {
    const rows = this.db
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .all(id) as unknown as Array<{ password_hash: string }>
    return rows[0]?.password_hash ?? ''
  }

  count(): number {
    const rows = this.db.prepare('SELECT COUNT(*) AS n FROM users').all() as unknown as Array<{ n: number | bigint }>
    return Number(rows[0].n)
  }

  close(): void {
    this.db.close()
  }
}
