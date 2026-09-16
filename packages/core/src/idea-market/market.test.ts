import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyRelation, SqliteIdeaMarket, readSummaryFile, type IdeaMarketSummary } from './market.js'
import type { IdeaStage } from '../idea/types.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-idea-market-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

function summary(ideaId: string, stage: IdeaStage, problem: string, solution: string, extra?: Partial<IdeaMarketSummary>): IdeaMarketSummary {
  return {
    ideaId,
    name: ideaId,
    stage,
    problemSummary: problem,
    solutionSummary: solution,
    spacetimeSummary: '面向国内市场',
    financeTotalCents: 0,
    geoVisibility: 0,
    publishedAt: Date.now(),
    followers: 0,
    ...extra,
  }
}

test('idea market: classifyRelation 互补/相似判定（prd2.md 6.3 例子）', () => {
  // 互补：问题域 ↔ 解决域 命中（A 的问题 B 的方案来解决）
  const A = { ideaId: 'idea-a', stage: 'description' as IdeaStage, problemSummary: '跨境电商卖家选品难，缺少选品数据工具支撑', solutionSummary: '' }
  const B = { ideaId: 'idea-b', stage: 'operation' as IdeaStage, problemSummary: '', solutionSummary: 'AI 选品工具：为跨境电商卖家提供选品数据' }
  const relation = classifyRelation(A, B)
  assert.ok(relation, '选品问题 ↔ 选品工具应判定互补')
  assert.equal(relation?.type, 'complementary')

  // 相似：问题域高度重合 → 合并建议
  const S1 = { ideaId: 'idea-s1', stage: 'description' as IdeaStage, problemSummary: '独立开发者获客难，缺便宜的获客渠道', solutionSummary: '' }
  const S2 = { ideaId: 'idea-s2', stage: 'description' as IdeaStage, problemSummary: '小团队获客难，获客渠道又贵又少', solutionSummary: '' }
  const similar = classifyRelation(S1, S2)
  assert.ok(similar)
  assert.equal(similar?.type, 'similar')

  // 无关联
  assert.equal(classifyRelation(
    { ideaId: 'x', stage: 'description', problemSummary: '宠物喂养', solutionSummary: '上门喂猫' },
    { ideaId: 'y', stage: 'description', problemSummary: '企业报表自动化', solutionSummary: '财务机器人' },
  ), null)
})

test('idea market: 发布 + 检索（FTS5 ≥3 字子串）+ summary.json 镜像', () => {
  const marketRoot = join(dir, 'market-files')
  const market = new SqliteIdeaMarket(join(dir, 'market.db'), { marketRoot })
  market.publish(summary('idea-m1', 'description', '跨境电商卖家选品难', 'AI 选品工具'))
  market.publish(summary('idea-m2', 'operation', '开发者获客难', '获客内容矩阵'))
  market.publish(summary('idea-m3', 'product', '宠物寄养信息不对称', '寄养匹配平台'))

  // 关键词命中：LIKE 路径（2 字）与 FTS5 trigram 路径（≥3 字任意子串）
  assert.equal(market.search({ keyword: '选品' }).length, 1)
  assert.equal(market.search({ keyword: '选品难' }).length, 1)
  assert.equal(market.search({ keyword: '获客内容' }).length, 1)
  assert.equal(market.search({ keyword: '不存在的子串' }).length, 0)
  // 阶段过滤
  assert.equal(market.search({ stage: 'operation' }).length, 1)
  // 未发布检索不到 / get
  assert.equal(market.get('idea-none'), undefined)
  // summary.json 镜像
  assert.ok(existsSync(join(marketRoot, 'idea-m1', 'summary.json')))
  assert.equal(readSummaryFile(marketRoot, 'idea-m1')?.ideaId, 'idea-m1')
})

test('idea market: 关注 + 阶段变更通知（IM-02）', () => {
  const market = new SqliteIdeaMarket(join(dir, 'follow.db'))
  market.publish(summary('idea-f', 'description', '问题F', '方案F'))
  market.follow('idea-f', 'user-1')
  market.follow('idea-f', 'user-2')
  assert.equal(market.follow('idea-f', 'user-1').followers, 2, '重复关注幂等')
  assert.equal(market.get('idea-f')?.followers, 2)

  const notified = market.notifyStageChange('idea-f', 'description', 'product')
  assert.equal(notified, 2)
  const feed = market.notificationsFor('user-1')
  assert.equal(feed.length, 1)
  assert.ok(feed[0]?.message.includes('product'))

  market.unfollow('idea-f', 'user-2')
  assert.equal(market.get('idea-f')?.followers, 1)
})

test('idea market: 关联发现重算与查询（IM-03）', () => {
  const market = new SqliteIdeaMarket(join(dir, 'relations.db'))
  market.publish(summary('idea-r1', 'description', '跨境电商卖家选品难，缺数据支撑', ''))
  market.publish(summary('idea-r2', 'operation', '', 'AI 选品工具：为跨境电商卖家提供选品数据'))
  market.publish(summary('idea-r3', 'product', '宠物寄养', '寄养平台'))

  const relations = market.recomputeRelations('idea-r1')
  assert.equal(relations.length, 1)
  assert.equal(relations[0]?.b, 'idea-r2')
  // 双向可查
  assert.equal(market.relations('idea-r2', 'complementary').length, 1)
  assert.equal(market.relations('idea-r3').length, 0)
})

test('idea market: 协同记录（IM-04，角色校验）', () => {
  const market = new SqliteIdeaMarket(join(dir, 'collab.db'))
  market.publish(summary('idea-c', 'product', '问题C', '方案C'))
  market.recordCollaboration({ ideaId: 'idea-c', userId: 'user-y', role: 'developer', contribution: 'MVP 代码', tokensGranted: 5_000 })
  assert.throws(() =>
    market.recordCollaboration({ ideaId: 'idea-c', userId: 'user-z', role: 'bogus' as 'developer', contribution: 'x', tokensGranted: 0 }),
  )
  assert.equal(market.collaborators('idea-c').length, 1)
  assert.equal(market.collaborators('idea-c')[0]?.tokensGranted, 5_000)
})

test('idea market: 排行三口径（IM-06：资产/社区/GEO）', () => {
  const market = new SqliteIdeaMarket(join(dir, 'rank.db'))
  market.publish(summary('idea-p1', 'asset', 'p1', 's1', { financeTotalCents: 10_000, followers: 1, geoVisibility: 0.3 }))
  market.publish(summary('idea-p2', 'asset', 'p2', 's2', { financeTotalCents: 50_000, followers: 9, geoVisibility: 0.1 }))
  market.publish(summary('idea-p3', 'asset', 'p3', 's3', { financeTotalCents: 20_000, followers: 5, geoVisibility: 0.8 }))
  assert.deepEqual(market.ranking('assets', 3).map((s) => s.ideaId), ['idea-p2', 'idea-p3', 'idea-p1'])
  assert.deepEqual(market.ranking('community').map((s) => s.ideaId), ['idea-p2', 'idea-p3', 'idea-p1'])
  assert.deepEqual(market.ranking('geo').map((s) => s.ideaId), ['idea-p3', 'idea-p1', 'idea-p2'])
})
