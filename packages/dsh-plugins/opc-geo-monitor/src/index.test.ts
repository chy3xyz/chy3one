import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteIdeaStore } from '../../../core/src/index.js'
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
