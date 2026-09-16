import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { OpcError } from '../errors.js'

/**
 * 协作团队（多用户协作的组织层）：
 * - 两角色制 v1：owner（建队人，可邀请/移除）与 member（可读写团队创意）；
 * - 创意与团队的关联在 ideas.team_id（创意所有权在 IdeaStore），本模块只管队伍与成员；
 * - 团队创意的可见性 = 队伍成员关系，由控制台把 userTeams(userId) 注入创意查询。
 */

export type TeamRole = 'owner' | 'member'

export const TEAM_ROLES: readonly TeamRole[] = ['owner', 'member']

export interface Team {
  id: string
  name: string
  ownerId: string
  createdAt: number
}

export interface TeamMember {
  userId: string
  role: TeamRole
  joinedAt: number
}

interface TeamRow {
  id: string
  name: string
  owner_id: string
  created_at: number
}

interface MemberRow {
  team_id: string
  user_id: string
  role: string
  joined_at: number
}

function rowToTeam(row: TeamRow): Team {
  return { id: row.id, name: row.name, ownerId: row.owner_id, createdAt: row.created_at }
}

function rowToMember(row: MemberRow): TeamMember {
  return { userId: row.user_id, role: row.role as TeamRole, joinedAt: row.joined_at }
}

export class TeamStore {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(path: string, now: () => number = Date.now) {
    this.now = now
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id       TEXT PRIMARY KEY,
        name     TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS team_members (
        team_id   TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        role      TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, user_id)
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id)')
  }

  /** 建队：创建者即 owner（并写入成员表，isMember 对 owner 恒真） */
  create(ownerUserId: string, name: string): Team {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > 64) {
      throw new OpcError('VALIDATION_ERROR', 'team name must be 1-64 characters')
    }
    const team: Team = {
      id: `team-${randomUUID().slice(0, 8)}`,
      name: trimmed,
      ownerId: ownerUserId,
      createdAt: this.now(),
    }
    this.db
      .prepare('INSERT INTO teams (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)')
      .run(team.id, team.name, team.ownerId, team.createdAt)
    this.db
      .prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(team.id, ownerUserId, 'owner', team.createdAt)
    return team
  }

  require(teamId: string): Team {
    const rows = this.db
      .prepare('SELECT id, name, owner_id, created_at FROM teams WHERE id = ?')
      .all(teamId) as unknown as TeamRow[]
    if (rows.length === 0) throw new OpcError('TEAM_NOT_FOUND', `team ${teamId} does not exist`)
    return rowToTeam(rows[0])
  }

  /** 用户所属的全部队伍（owner 或 member） */
  listForUser(userId: string): Team[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, t.owner_id, t.created_at
         FROM teams t
         JOIN team_members m ON m.team_id = t.id AND m.user_id = ?
         ORDER BY t.created_at DESC`,
      )
      .all(userId) as unknown as TeamRow[]
    return rows.map(rowToTeam)
  }

  members(teamId: string): TeamMember[] {
    this.require(teamId)
    const rows = this.db
      .prepare('SELECT team_id, user_id, role, joined_at FROM team_members WHERE team_id = ? ORDER BY joined_at')
      .all(teamId) as unknown as MemberRow[]
    return rows.map(rowToMember)
  }

  isMember(teamId: string, userId: string): boolean {
    const rows = this.db
      .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
      .all(teamId, userId) as unknown as Array<{ role: string }>
    return rows.length > 0
  }

  /** 邀请成员（仅 owner 可操作）；已在队内幂等返回既有成员 */
  invite(teamId: string, inviterUserId: string, targetUserId: string, role: TeamRole = 'member'): TeamMember {
    const team = this.require(teamId)
    if (team.ownerId !== inviterUserId) {
      throw new OpcError('PERMISSION_DENIED', 'only the team owner can invite members')
    }
    if (role !== 'member') {
      throw new OpcError('VALIDATION_ERROR', 'invite role must be member (owner is fixed to the creator)')
    }
    const existing = this.db
      .prepare('SELECT team_id, user_id, role, joined_at FROM team_members WHERE team_id = ? AND user_id = ?')
      .all(teamId, targetUserId) as unknown as MemberRow[]
    if (existing.length > 0) return rowToMember(existing[0])
    const joinedAt = this.now()
    this.db
      .prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(teamId, targetUserId, 'member', joinedAt)
    return { userId: targetUserId, role: 'member', joinedAt }
  }

  /** 移除成员（仅 owner；不能移除自己——owner 身份随队伍存续） */
  remove(teamId: string, inviterUserId: string, targetUserId: string): void {
    const team = this.require(teamId)
    if (team.ownerId !== inviterUserId) {
      throw new OpcError('PERMISSION_DENIED', 'only the team owner can remove members')
    }
    if (targetUserId === team.ownerId) {
      throw new OpcError('VALIDATION_ERROR', 'cannot remove the team owner')
    }
    this.db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, targetUserId)
  }

  close(): void {
    this.db.close()
  }
}
