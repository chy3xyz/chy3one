import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'

/**
 * 登录会话（HttpOnly Cookie 载体）：
 * - 令牌：32 字节随机（base64url），仅下发不落库；库内存 sha256(token)，
 *   库文件泄露不等于会话被冒用；
 * - 滑动续期：每次 resolve 成功即续期（expiresAt = now + ttl），7 天不活跃自动失效；
 * - revoke/logout 即删行，可强制下线。
 */

export interface UserSession {
  userId: string
  expiresAt: number
}

export const DEFAULT_SESSION_TTL_MS = 7 * 86_400_000

/** 会话 Cookie 名（前端/反代统一引用） */
export const SESSION_COOKIE = 'opcos_session'

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export class SessionStore {
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(
    path: string,
    options?: { ttlMs?: number; now?: () => number },
  ) {
    this.now = options?.now ?? Date.now
    this.ttlMs = options?.ttlMs ?? DEFAULT_SESSION_TTL_MS
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, expires_at)')
  }

  /** 签发会话：返回明文令牌（只此一次可见，调用方写入 Set-Cookie）与到期时间 */
  create(userId: string): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + this.ttlMs
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), userId, expiresAt)
    return { token, expiresAt }
  }

  /**
   * 解析令牌：未命中/已过期返回 undefined；命中即滑动续期（惰性清理过期为读时副作用）。
   */
  resolve(token: string): UserSession | undefined {
    if (typeof token !== 'string' || token.length === 0) return undefined
    const tokenHash = hashToken(token)
    const rows = this.db
      .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
      .all(tokenHash) as unknown as Array<{ user_id: string; expires_at: number }>
    if (rows.length === 0) return undefined
    const { user_id, expires_at } = rows[0]
    const now = this.now()
    if (expires_at <= now) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
      return undefined
    }
    const expiresAt = now + this.ttlMs
    this.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(expiresAt, tokenHash)
    return { userId: user_id, expiresAt }
  }

  /** 注销（删除该令牌） */
  revoke(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
  }

  /** 全端下线（改密/封禁场景） */
  revokeAllForUser(userId: string): number {
    const result = this.db
      .prepare('DELETE FROM sessions WHERE user_id = ?')
      .run(userId) as unknown as { changes: number | bigint }
    return Number(result.changes)
  }

  /** 清理全部过期会话（可选维护动作；resolve 已惰性清理） */
  purgeExpired(): number {
    const result = this.db
      .prepare('DELETE FROM sessions WHERE expires_at <= ?')
      .run(this.now()) as unknown as { changes: number | bigint }
    return Number(result.changes)
  }

  close(): void {
    this.db.close()
  }
}

/** 从 Cookie 请求头解析会话令牌（只认 SESSION_COOKIE 名） */
export function extractSessionToken(cookieHeader: string | undefined): string | undefined {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return undefined
  for (const segment of cookieHeader.split(';')) {
    const eq = segment.indexOf('=')
    if (eq === -1) continue
    if (segment.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = segment.slice(eq + 1).trim()
      return value.length > 0 ? value : undefined
    }
  }
  return undefined
}
