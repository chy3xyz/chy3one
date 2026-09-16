import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldIdeaHome } from '../idea/store.js'
import { TokenLedger } from './points.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-token-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeLedger(name: string): { ledger: TokenLedger; home: string } {
  // scaffoldIdeaHome(ideasRoot, idea)：第一参为 ideas 父目录，真实创意目录为 <root>/<name>
  const ideasRoot = join(dir, `${name}-root`)
  scaffoldIdeaHome(ideasRoot, { id: name, name, stage: 'asset', domains: {} as never, createdAt: 1, updatedAt: 1 })
  const home = join(ideasRoot, name)
  return { ledger: new TokenLedger(home, name), home }
}

test('token ledger: 默认分配模型 45/25/20/10（prd2.md 5.4）', () => {
  const { ledger } = makeLedger('idea-t0')
  const config = ledger.config()
  assert.equal(config.total_supply, 1_000_000)
  assert.deepEqual(config.allocation, { community: 45, creator: 25, collaborator: 20, ecosystem: 10 })
  assert.ok(config.note?.includes('不承诺'))
})

test('token ledger: 发行 + 流水 + holders 统计 + token.json 回写', () => {
  const { ledger, home } = makeLedger('idea-t1')
  ledger.issue('user-x', 'community', 40_000, '内容创作贡献')
  ledger.issue('user-y', 'community', 10_000, '测试反馈')
  ledger.issue('creator-1', 'creator', 250_000, '创意发起人')
  assert.equal(ledger.stats().distributed, 300_000)
  assert.equal(ledger.stats().holders, 3)
  assert.equal(ledger.distributedByRole('community'), 50_000)

  // 流水 JSONL append
  const lines = readFileSync(join(home, 'assets', 'distribution.json'), 'utf8')
    .split('\n').filter((l) => l.trim())
  assert.equal(lines.length, 3)
  const grant = JSON.parse(lines[0])
  assert.equal(grant.role, 'community')

  // token.json distributed/holders 回写
  const config = JSON.parse(readFileSync(join(home, 'assets', 'token.json'), 'utf8'))
  assert.equal(config.distributed, 300_000)
  assert.equal(config.holders, 3)
})

test('token ledger: 角色配额与总量双重约束（TOKEN_ALLOCATION_EXCEEDED）', () => {
  const { ledger } = makeLedger('idea-t2')
  // community 45% = 450_000
  ledger.issue('u1', 'community', 449_000, '批量激励')
  assert.throws(
    () => ledger.issue('u2', 'community', 2_000, '超配额'),
    (e: { code?: string }) => e.code === 'TOKEN_ALLOCATION_EXCEEDED',
  )
  // 恰好到配额边界允许
  assert.doesNotThrow(() => ledger.issue('u2', 'community', 1_000, '贴边发行'))
  // 总量约束：creator 25% = 250_000，community 已发 450_000，creator 全额可发
  assert.doesNotThrow(() => ledger.issue('c1', 'creator', 250_000, '创作者'))
  // 非法参数
  assert.throws(() => ledger.issue('u', 'community', -1, '负数'))
  assert.throws(() => ledger.issue('u', 'bogus' as 'creator', 1, 'r'))
  assert.throws(() => ledger.issue('', 'community', 1, 'r'))
})

test('token ledger: 分配流水重启恢复（重开实例累计不丢）', () => {
  const { home } = makeLedger('idea-t3')
  {
    const first = new TokenLedger(home, 'idea-t3')
    first.issue('u1', 'collaborator', 5_000, 'MVP 代码贡献')
  }
  const reopened = new TokenLedger(home, 'idea-t3')
  assert.equal(reopened.stats().distributed, 5_000)
  assert.equal(reopened.distributedByRole('collaborator'), 5_000)
  // 恢复后配额约束继续生效（collaborator 20% = 200_000）
  reopened.issue('u2', 'collaborator', 195_000, 'GEO 策略贡献')
  assert.throws(
    () => reopened.issue('u3', 'collaborator', 1, '超配额'),
    (e: { code?: string }) => e.code === 'TOKEN_ALLOCATION_EXCEEDED',
  )
})
