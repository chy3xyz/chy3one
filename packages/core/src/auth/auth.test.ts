import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore } from './users.js'
import { SessionStore, extractSessionToken, SESSION_COOKIE } from './sessions.js'
import { TeamStore } from './teams.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-auth-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('users: 注册/校验/重复用户名（scrypt + timingSafeEqual）', () => {
  const store = new UserStore(join(dir, 'users.db'))
  const user = store.register({ username: 'alice', password: 'secret123', displayName: '爱丽丝' })
  assert.match(user.id, /^user-[0-9a-f]{8}$/)
  assert.equal(user.displayName, '爱丽丝')

  // 正确密码
  assert.equal(store.verify('alice', 'secret123')?.id, user.id)
  // 错误密码 / 不存在的用户：统一 undefined（不泄露存在性）
  assert.equal(store.verify('alice', 'wrong!'), undefined)
  assert.equal(store.verify('ghost', 'secret123'), undefined)

  // 重复注册
  assert.throws(
    () => store.register({ username: 'alice', password: 'secret123' }),
    (e: { code?: string }) => e.code === 'USERNAME_TAKEN',
  )
  // 规则校验
  assert.throws(() => store.register({ username: 'a', password: 'secret123' }))
  assert.throws(() => store.register({ username: 'bad name!', password: 'secret123' }))
  assert.throws(() => store.register({ username: 'bob', password: '12345' }))
  // displayName 缺省取用户名
  assert.equal(store.register({ username: 'bob', password: 'secret123' }).displayName, 'bob')
  store.close()
})

test('sessions: 签发/解析/滑动续期/过期/注销', () => {
  let clock = 10_000_000
  const store = new SessionStore(join(dir, 'sessions.db'), { now: () => clock })
  const { token, expiresAt } = store.create('user-a')
  assert.ok(token.length >= 40)
  assert.equal(expiresAt, clock + 7 * 86_400_000)

  // 解析命中且滑动续期
  clock += 3 * 86_400_000
  const resolved = store.resolve(token)
  assert.equal(resolved?.userId, 'user-a')
  assert.equal(resolved?.expiresAt, clock + 7 * 86_400_000, 'resolve 应滑动续期')

  // 自然过期：超过续期后的 ttl
  clock += 8 * 86_400_000
  assert.equal(store.resolve(token), undefined, '过期会话应失效')

  // 注销
  const { token: token2 } = store.create('user-b')
  store.revoke(token2)
  assert.equal(store.resolve(token2), undefined)

  // 全端下线
  const { token: token3 } = store.create('user-c')
  const { token: token4 } = store.create('user-c')
  assert.equal(store.revokeAllForUser('user-c'), 2)
  assert.equal(store.resolve(token3), undefined)
  assert.equal(store.resolve(token4), undefined)
  store.close()
})

test('sessions: 令牌只存哈希（库泄露不可逆）+ cookie 解析', () => {
  const store = new SessionStore(join(dir, 'sessions-hash.db'))
  const { token } = store.create('user-x')
  const raw = readFileSync(join(dir, 'sessions-hash.db'), 'utf8')
  assert.equal(raw.includes(token), false, '明文令牌不得落库')
  assert.equal(extractSessionToken(`${SESSION_COOKIE}=abc; other=1`), 'abc')
  assert.equal(extractSessionToken('other=1'), undefined)
  assert.equal(extractSessionToken(undefined), undefined)
  store.close()
})

test('users: 修改昵称与密码（改密旧密码校验 + 新密码规则）', () => {
  const store = new UserStore(join(dir, 'users-profile.db'))
  const user = store.register({ username: 'cara', password: 'old123456' })

  // 改昵称
  const renamed = store.updateDisplayName(user.id, '卡拉')
  assert.equal(renamed.displayName, '卡拉')

  // 改密：旧密码错误拒绝
  assert.throws(
    () => store.updatePassword(user.id, 'wrong-old', 'new123456'),
    (e: { code?: string }) => e.code === 'AUTH_FAILED',
  )
  // 新密码过短拒绝
  assert.throws(() => store.updatePassword(user.id, 'old123456', '12345'))
  // 正常改密后：旧密码失效、新密码可登录
  store.updatePassword(user.id, 'old123456', 'new123456')
  assert.equal(store.verify('cara', 'old123456'), undefined)
  assert.equal(store.verify('cara', 'new123456')?.id, user.id)
  // 不存在的用户
  assert.throws(() => store.updateDisplayName('user-none', 'x'))
  store.close()
})

test('teams: 建队/邀请/成员/权限（owner 两角色制）', () => {
  const store = new TeamStore(join(dir, 'teams.db'))
  const team = store.create('user-owner', '创意突击队')
  assert.match(team.id, /^team-[0-9a-f]{8}$/)
  assert.equal(store.isMember(team.id, 'user-owner'), true, 'owner 恒为成员')

  // 非 owner 邀请拒绝
  assert.throws(
    () => store.invite(team.id, 'user-member', 'user-x'),
    (e: { code?: string }) => e.code === 'PERMISSION_DENIED',
  )
  store.invite(team.id, 'user-owner', 'user-a')
  // 重复邀请幂等
  store.invite(team.id, 'user-owner', 'user-a')
  assert.equal(store.members(team.id).length, 2)
  assert.equal(store.isMember(team.id, 'user-a'), true)

  // owner 不能被移除
  assert.throws(() => store.remove(team.id, 'user-owner', 'user-owner'))
  store.remove(team.id, 'user-owner', 'user-a')
  assert.equal(store.isMember(team.id, 'user-a'), false)

  // listForUser：owner 与 member 各自可见
  const team2 = store.create('user-a', '另一支队伍')
  store.invite(team2.id, 'user-a', 'user-owner')
  assert.equal(store.listForUser('user-owner').map((t) => t.id).sort().join(','), [team.id, team2.id].sort().join(','))
  // 不存在的队伍
  assert.throws(() => store.require('team-none'), /does not exist/)
  store.close()
})
