import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GeoMonitor, GeoSnapshotStore, MockGeoProvider, type GeoAlert, type GeoProvider, type GeoSnapshot } from './monitor.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-geo-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('geo monitor: Mock 探测确定性 + 快照落库 + 历史', async () => {
  const store = new GeoSnapshotStore(join(dir, 'geo.db'))
  const monitor = new GeoMonitor({ provider: new MockGeoProvider(), store })
  const r1 = await monitor.refresh('idea-g1', ['品牌A'], ['doubao', 'deepseek'])
  assert.equal(r1.simulated, true)
  assert.equal(r1.snapshots.length, 2)
  assert.equal(r1.alerts.length, 0, '首轮无基准不告警')

  // 同日同 seed 确定性
  const again = await new MockGeoProvider().probe('idea-g1', ['品牌A'], ['doubao'])
  assert.equal(again[0]?.visibility, r1.snapshots.find((s) => s.platform === 'doubao')?.visibility)

  const history = monitor.history('idea-g1')
  assert.equal(history.length, 2)
  store.close()
})

test('geo monitor: visibility 下跌 ≥0.2 触发告警（prd2.md 4.4 alertThreshold）', async () => {
  const store = new GeoSnapshotStore(join(dir, 'alert.db'))
  // 可控 Provider：第一轮 visibility 0.8，第二轮 0.5（下跌 0.3 ≥ 0.2 → 告警）
  let round = 0
  const provider: GeoProvider = {
    async probe(ideaId, _kw, platforms) {
      const current = round++ === 0 ? 0.8 : 0.5
      return platforms.map((platform) => ({
        ideaId,
        platform,
        visibility: current,
        citationRate: 0.4,
        sentiment: 0.7,
        at: Date.now(),
      }))
    },
  }
  const alerts: GeoAlert[] = []
  const monitor = new GeoMonitor({
    provider,
    store,
    onAlert: (a) => alerts.push(a),
  })
  await monitor.refresh('idea-g2', ['品牌B'], ['doubao'])
  const second = await monitor.refresh('idea-g2', ['品牌B'], ['doubao'])
  assert.equal(second.alerts.length, 1)
  assert.equal(second.alerts[0]?.metric, 'visibility_drop')
  assert.equal(second.alerts[0]?.drop, 0.3)
  assert.equal(alerts.length, 1)
  store.close()
})

test('geo monitor: 下跌未达阈值不告警；创意间历史隔离', async () => {
  const store = new GeoSnapshotStore(join(dir, 'threshold.db'))
  let value = 0.8
  const provider: GeoProvider = {
    async probe(ideaId, _kw, platforms) {
      return platforms.map((platform) => ({ ideaId, platform, visibility: value, citationRate: 0.2, sentiment: 0.6, at: Date.now() }))
    },
  }
  const monitor = new GeoMonitor({ provider, store })
  await monitor.refresh('idea-t1', ['k'], ['doubao'])
  value = 0.65 // 下跌 0.15 < 0.2 → 不告警
  const result = await monitor.refresh('idea-t1', ['k'], ['doubao'])
  assert.equal(result.alerts.length, 0)

  // 其他创意的历史不可见（按创意隔离）
  await monitor.refresh('idea-t2', ['k'], ['doubao'])
  assert.equal(monitor.history('idea-t2').every((s) => s.ideaId === 'idea-t2'), true)
  assert.ok(monitor.history('idea-t1').length >= 2)
  store.close()
})

test('geo monitor: 快照回调（writeToMemory 接线位）', async () => {
  const store = new GeoSnapshotStore(join(dir, 'callback.db'))
  const seen: string[] = []
  const monitor = new GeoMonitor({
    provider: new MockGeoProvider(),
    store,
    onSnapshot: (s) => seen.push(`${s.ideaId}:${s.platform}`),
  })
  await monitor.refresh('idea-cb', ['k'], ['doubao'])
  assert.equal(seen.length, 1)
  assert.equal(seen[0], 'idea-cb:doubao')
  store.close()
})
