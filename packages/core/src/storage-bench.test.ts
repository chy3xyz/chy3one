import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { SqliteMemoryStore } from './memory/sqlite-store.js'
import { SqliteBlackboard } from './blackboard/sqlite-blackboard.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-storage-bench-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

// AR-P03：10 万条记忆 keyword 检索 < 500ms。本断言即目标值本身
// （本机 Node 26 / Apple Silicon 实测：单次 6.3ms、P95 8.0ms，余量充足；
//   若 CI 机器明显偏慢——LIKE 为全表扫描无索引可依赖——可将预算放宽为 2000 并在此注明）。
const QUERY_BUDGET_MS = 500
// AR-P04：黑板写入 < 100ms/条（5 Agent 并发场景的顺序等价基准；实测平均 0.02ms/条）。
const WRITE_BUDGET_MS = 100

test('AR-P03 基准：100,000 条 memory_entries 后 keyword 检索 < 500ms', () => {
  const store = new SqliteMemoryStore(join(dir, 'bench-memory.db'))
  const total = 100_000
  store.writeAll(
    Array.from({ length: total }, (_, i) => ({
      scope: 'global' as const,
      category: 'fact' as const,
      // 每 10 条 1 条命中 keyword（共 1 万条命中），其余 9 万条仍被 LIKE 扫描后再过滤
      content: i % 10 === 0 ? `金融合同必须检查利率上限条款 #${i}` : `常规记忆条目 #${i}`,
      confidence: (i % 100) / 100,
    })),
  )
  assert.equal(store.query({ keyword: '绝不命中关键词xyz' }).length, 0)

  // 先单次计时（冷路径：首次 prepare + 页缓存未热）
  const t0 = performance.now()
  const hits = store.query({ keyword: '利率上限' })
  const singleElapsed = performance.now() - t0
  assert.equal(hits.length, 10) // 默认 limit 10
  assert.equal(hits[0].confidence, 0.9) // 命中行按置信度降序

  // P95：20 次采样，走完整 query() 路径（含语句 prepare）
  const samples: number[] = []
  for (let i = 0; i < 20; i++) {
    const start = performance.now()
    store.query({ keyword: '利率上限' })
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]

  console.log(`[AR-P03] rows=${total} 单次=${singleElapsed.toFixed(1)}ms p95=${p95.toFixed(1)}ms`)
  assert.ok(singleElapsed < QUERY_BUDGET_MS, `单次检索 ${singleElapsed.toFixed(1)}ms 超出预算 ${QUERY_BUDGET_MS}ms`)
  assert.ok(p95 < QUERY_BUDGET_MS, `P95 ${p95.toFixed(1)}ms 超出预算 ${QUERY_BUDGET_MS}ms`)
  store.close()
})

test('AR-P04 基准：5 写者轮转顺序 1,000 次黑板写入平均 < 100ms/条', () => {
  const bb = new SqliteBlackboard(join(dir, 'bench-blackboard.db'))
  const writes = 1_000
  const writers = ['a', 'b', 'c', 'd', 'e']
  const t0 = performance.now()
  for (let i = 0; i < writes; i++) {
    const writer = writers[i % writers.length]!
    const r = bb.write({
      scope: 'workflow',
      key: `task-${i}`,
      value: { from: writer, step: i },
      writer,
      role: 'agent',
      expectedVersion: 0,
    })
    if (r.status !== 'ok') assert.fail(`第 ${i} 次写入失败: ${JSON.stringify(r)}`)
  }
  const elapsed = performance.now() - t0
  const avgMs = elapsed / writes

  console.log(`[AR-P04] writes=${writes} total=${elapsed.toFixed(1)}ms avg=${avgMs.toFixed(3)}ms/条`)
  assert.equal(bb.read('workflow').length, writes)
  assert.ok(avgMs < WRITE_BUDGET_MS, `平均写入 ${avgMs.toFixed(3)}ms/条 超出预算 ${WRITE_BUDGET_MS}ms`)
  bb.close()
})
