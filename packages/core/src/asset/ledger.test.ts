import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldIdeaHome } from '../idea/store.js'
import { IdeaLedger } from './ledger.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-ledger-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** scaffoldIdeaHome(ideasRoot, idea)：第一参为 ideas 父目录；返回真实创意目录 */
function makeIdeaDir(name: string, id: string): string {
  const ideasRoot = join(dir, `${name}-root`)
  scaffoldIdeaHome(ideasRoot, { id, name, stage: 'asset', domains: {} as never, createdAt: 1, updatedAt: 1 })
  return join(ideasRoot, id)
}

test('idea ledger: 收入记账（prd2.md 5.5 三来源 + total）', () => {
  const home = makeIdeaDir('idea-ledger-1', 'idea-l1')
  const ledger = IdeaLedger.forIdeaHome(home, 'idea-l1')
  ledger.recordRevenue('product', 8500)
  ledger.recordRevenue('subscription', 3200)
  ledger.recordRevenue('skill', 1250)
  const data = ledger.read()
  assert.equal(data.assets.finance.product_revenue, 8500)
  assert.equal(data.assets.finance.subscription_revenue, 3200)
  assert.equal(data.assets.finance.skill_revenue, 1250)
  assert.equal(data.assets.finance.total, 12950)

  // 落盘 JSON 与 PRD 5.5 结构同形
  const raw = JSON.parse(readFileSync(join(home, 'assets', 'ledger.json'), 'utf8'))
  assert.equal(raw.assets.finance.total, 12950)
  assert.equal(raw.idea_id, 'idea-l1')

  // 非法金额拒绝
  assert.throws(() => ledger.recordRevenue('product', -1))
  assert.throws(() => ledger.recordRevenue('product', 1.5))
})

test('idea ledger: Skill 沉淀 upsert + token 统计镜像 + 用户/运营数据', () => {
  const home = makeIdeaDir('idea-ledger-2', 'idea-l2')
  const ledger = IdeaLedger.forIdeaHome(home, 'idea-l2')
  ledger.recordSkill({ id: 'skill-001', name: 'GEO内容优化', status: 'listed' })
  ledger.recordSkill({ id: 'skill-001', name: 'GEO内容优化', status: 'listed', revenueCents: 125000 })
  const data = ledger.read()
  assert.equal(data.assets.skills.length, 1, '同 id upsert 不重复')
  assert.equal(data.assets.skills[0]?.revenue, 125000)

  ledger.syncTokens({ total_supply: 1_000_000, distributed: 450_000, holders: 128 })
  assert.equal(ledger.read().assets.tokens.holders, 128)

  ledger.updateUsers({ total: 2450, paying: 156 })
  ledger.updateAnalytics({ geo_visibility: 0.78 })
  assert.equal(ledger.read().assets.users.paying, 156)
  assert.equal(ledger.read().assets.analytics.geo_visibility, 0.78)
})
