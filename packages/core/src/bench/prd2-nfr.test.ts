import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldIdeaHome } from '../idea/store.js'
import { MemoryBodyHub } from '../memory/memory-body.js'
import { MemoryBodyIndex } from '../memory/body-index.js'
import { SqliteIdeaMarket, type IdeaMarketSummary } from '../idea-market/market.js'

/**
 * prd2.md 10 非功能需求基线（M6 收口）：
 * - 性能：记忆体挂载切换 < 500ms；创意市场搜索 < 500ms
 * - 可扩展：单实例创意数量 ≥ 1000 个
 * 全部为本地 SQLite/FTS5 基线（AR-P 口径），CI/低端机允许放宽但不阻断（见各断言注释）。
 */

const dir = mkdtempSync(join(tmpdir(), 'opcos-prd2-nfr-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

const IDEA_COUNT = 1000

/** 灌 1000 个创意目录（ID-03 规模验收：单实例创意数量 ≥ 1000） */
test('NFR 可扩展：单实例 1000 个创意目录初始化', () => {
  const ideasRoot = join(dir, 'ideas-scale')
  const startedAt = Date.now()
  for (let i = 0; i < IDEA_COUNT; i++) {
    scaffoldIdeaHome(ideasRoot, {
      id: `idea-n${String(i).padStart(4, '0')}`,
      name: `规模化创意 ${i}`,
      stage: 'description',
      domains: {
        problem: { summary: 'p', points: [] },
        solution: { summary: 's', points: [] },
        spacetime: { summary: 't', points: [] },
      },
      createdAt: i,
      updatedAt: i,
    })
  }
  const elapsed = Date.now() - startedAt
  // 1000 次脚手架（每次数个文件写入）整体秒级即可，不设硬性 PRD 指标，仅防退化告警
  assert.ok(elapsed < 60_000, `1000 创意目录初始化应在分钟内完成，实际 ${elapsed}ms`)
})

test('NFR 性能：记忆体挂载/卸载切换 < 500ms（prd2.md 10）', () => {
  const ideasRoot = join(dir, 'ideas-mount')
  for (let i = 0; i < 50; i++) {
    scaffoldIdeaHome(ideasRoot, {
      id: `idea-m${i}`,
      name: `挂载创意 ${i}`,
      stage: 'description',
      domains: { problem: { summary: 'p', points: [] }, solution: { summary: 's', points: [] }, spacetime: { summary: 't', points: [] } },
      createdAt: i,
      updatedAt: i,
    })
  }
  const hub = new MemoryBodyHub(ideasRoot, new MemoryBodyIndex(join(dir, 'mount-bench.db')))
  const ids = Array.from({ length: 50 }, (_, i) => `idea-m${i}`)
  const startedAt = Date.now()
  for (const id of ids) hub.mount(id)
  for (const id of ids) hub.unmount(id)
  const elapsed = Date.now() - startedAt
  assert.equal(hub.listMounted().length, 0)
  assert.ok(elapsed < 500, `挂载切换应 <500ms，实际 ${elapsed}ms（PRD 10 性能）`)
})

test('NFR 性能：创意市场 1000 条摘要下检索 < 500ms（prd2.md 10/IM-05）', () => {
  const market = new SqliteIdeaMarket(join(dir, 'market-bench.db'))
  const summaries: IdeaMarketSummary[] = []
  const topics = ['选品', '获客', '寄养', '建站', '剪辑', '翻译', '记账', '出行', '餐饮', '健身']
  for (let i = 0; i < IDEA_COUNT; i++) {
    const topic = topics[i % topics.length]!
    summaries.push({
      ideaId: `idea-bench-${String(i).padStart(4, '0')}`,
      name: `${topic}创意 ${i}`,
      stage: 'description',
      problemSummary: `${topic}场景下的真实痛点描述 ${i}`,
      solutionSummary: `用自动化工具解决${topic}问题的方案 ${i}`,
      spacetimeSummary: '面向国内市场',
      financeTotalCents: i,
      geoVisibility: (i % 100) / 100,
      publishedAt: i,
      followers: i % 50,
    })
  }
  market.publish(summaries[0]!)
  // 单条 publish 走 upsert；批量灌入走同一接口（规模语义与单条一致）
  for (const summary of summaries.slice(1)) market.publish(summary)

  // 冷/热两次检索均 < 500ms（IM-05/NFR 性能口径）；limit 放宽到全量以校验命中数
  const coldStartedAt = Date.now()
  const hits = market.search({ keyword: '选品场景下的真实痛点', limit: IDEA_COUNT })
  const coldElapsed = Date.now() - coldStartedAt
  const warmStartedAt = Date.now()
  const hits2 = market.search({ keyword: '获客', limit: IDEA_COUNT })
  const warmElapsed = Date.now() - warmStartedAt
  assert.ok(hits.length >= 90, `关键词应命中该 topic 的全部条目（实际 ${hits.length}）`)
  assert.ok(hits2.length >= 90)
  assert.ok(coldElapsed < 500, `创意市场检索应 <500ms，实际 ${coldElapsed}ms（PRD 10）`)
  assert.ok(warmElapsed < 500, `创意市场热检索应 <500ms，实际 ${warmElapsed}ms（PRD 10）`)
  market.close()
})
