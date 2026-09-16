import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteIdeaStore, GeoSnapshotStore } from '../../../core/src/index.js'
import { apply, plugin } from './index.js'
import { createMockContext } from '../../../dsh-adapter/src/index.js'

test('plugin opc-geo-monitor: refresh 落库 + 写创意记忆体 analytics 流 + history 隔离', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-geo-monitor-'))
  try {
    const ideasRoot = join(dir, 'ideas')
    const store = new SqliteIdeaStore(join(dir, 'ideas.db'), ideasRoot)
    const idea = store.create({ text: '美妆品牌AI可见性优化' })
    store.close()

    const ctx = createMockContext()
    apply(ctx, {
      ideasDbPath: join(dir, 'ideas.db'),
      ideasRoot,
      bodiesDbPath: join(dir, 'bodies.db'),
      geoDbPath: join(dir, 'geo.db'),
      platforms: ['doubao', 'deepseek'],
    })
    const geo = ctx.getService('opc.geo') as {
      refresh(id: string, kw?: string[]): Promise<{ snapshots: unknown[]; alerts: unknown[]; simulated: boolean }>
      history(id: string): Array<{ ideaId: string; platform: string }>
      config(): { platforms: string[]; alertThreshold: number; simulated: boolean }
    }
    assert.deepEqual(geo.config().platforms, ['doubao', 'deepseek'])
    assert.equal(geo.config().simulated, true)

    // 关键词默认取创意名；不存在的创意 require 抛错
    const result = await geo.refresh(idea.id)
    assert.equal(result.snapshots.length, 2)
    assert.equal(result.alerts.length, 0)
    await assert.rejects(() => geo.refresh('idea-none'), /does not exist/)

    const history = geo.history(idea.id)
    assert.equal(history.length, 2)
    assert.ok(history.every((s) => s.ideaId === idea.id))

    // 监测正本写入记忆体 analytics 流（writeToMemory，prd2.md 4.4）
    const analyticsFile = join(ideasRoot, idea.id, 'memory-body', 'analytics.jsonl')
    const content = readFileSync(analyticsFile, 'utf8')
    assert.ok(content.includes('geo-snapshot'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugin opc-geo-monitor: defineOpcPlugin 元数据', () => {
  assert.equal(plugin.name, 'opc-geo-monitor')
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('plugin opc-geo-monitor: 7×24 调度器——周期自动探测，dispose 停表', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-geo-sched-'))
  try {
    const ideasRoot = join(dir, 'ideas')
    const store = new SqliteIdeaStore(join(dir, 'ideas.db'), ideasRoot)
    const idea = store.create({ text: '调度器监测的创意' })
    store.close()

    const ctx = createMockContext()
    apply(ctx, {
      ideasDbPath: join(dir, 'ideas.db'),
      ideasRoot,
      bodiesDbPath: join(dir, 'bodies.db'),
      geoDbPath: join(dir, 'geo.db'),
      platforms: ['doubao'],
      refreshIntervalMs: 30, // 测试用 30ms 轮询
    })
    const geo = ctx.getService('opc.geo') as {
      history(id: string): Array<{ at: number }>
      config(): { scheduler: { intervalMs: number; running: boolean; lastRunAt: number } }
    }
    assert.equal(geo.config().scheduler.intervalMs, 30)

    await sleep(160) // 至少 3 轮自动探测
    const geoDbPath = join(dir, 'geo.db')
    const countRuns = (): number => {
      const probe = new GeoSnapshotStore(geoDbPath)
      try {
        return probe.history(idea.id).length
      } finally {
        probe.close()
      }
    }
    const countAfterRuns = countRuns()
    assert.ok(countAfterRuns >= 2, `调度器应自动刷新（30ms × 160ms ≥ 3 轮），实际 ${countAfterRuns} 条快照`)
    assert.ok(geo.config().scheduler.lastRunAt > 0)

    // dispose 停表：再等 3 个周期，快照数不再增长（测试自持连接读库，插件侧已 close）
    ctx.unload()
    await sleep(120)
    assert.equal(countRuns(), countAfterRuns, 'dispose 后应停止周期探测')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugin opc-geo-monitor: refreshIntervalMs=0 关闭调度（仅手动刷新）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-geo-nosched-'))
  try {
    const ideasRoot = join(dir, 'ideas')
    const store = new SqliteIdeaStore(join(dir, 'ideas.db'), ideasRoot)
    const idea = store.create({ text: '不自动监测的创意' })
    store.close()

    const ctx = createMockContext()
    apply(ctx, {
      ideasDbPath: join(dir, 'ideas.db'),
      ideasRoot,
      bodiesDbPath: join(dir, 'bodies.db'),
      geoDbPath: join(dir, 'geo.db'),
      platforms: ['doubao'],
      refreshIntervalMs: 0,
    })
    const geo = ctx.getService('opc.geo') as {
      history(id: string): Array<{ at: number }>
      refresh(id: string): Promise<unknown>
    }
    await sleep(90)
    assert.equal(geo.history(idea.id).length, 0, '关闭调度后不应自动探测')
    await geo.refresh(idea.id)
    assert.equal(geo.history(idea.id).length, 1, '手动刷新仍可用')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
