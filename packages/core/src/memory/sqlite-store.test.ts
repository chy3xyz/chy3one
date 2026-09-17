import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteMemoryStore } from './sqlite-store.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-sqlite-memory-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('sqlite memory: write & query by category/keyword (AC-04 基础检索)', () => {
  const store = new SqliteMemoryStore(join(dir, 'basic.db'))
  store.write({ scope: 'global', category: 'lesson', content: '金融合同必须检查利率上限条款', confidence: 0.9 })
  store.write({ scope: 'agent', category: 'soul', content: '合同审查专家人格', confidence: 0.95 })
  store.write({ scope: 'global', category: 'fact', content: '爆款标题含数字', confidence: 0.7 })

  assert.equal(store.query({ category: 'lesson' }).length, 1)
  assert.equal(store.query({ keyword: '合同' }).length, 2)
  // 高置信度优先
  const ranked = store.query({ keyword: '合同' })
  assert.equal(ranked[0].category, 'soul')
  assert.equal(store.query({ scope: 'agent' }).length, 1)
  store.close()
})

test('sqlite memory: query 默认 limit 10，显式 limit 放宽', () => {
  const store = new SqliteMemoryStore(join(dir, 'limit.db'))
  for (let i = 0; i < 12; i++) {
    store.write({ scope: 'global', category: 'fact', content: `共享关键词条目 ${i}`, confidence: i / 12 })
  }
  assert.equal(store.query({ keyword: '共享关键词' }).length, 10)
  assert.equal(store.query({ keyword: '共享关键词', limit: 12 }).length, 12)
  assert.equal(store.query({ keyword: '共享关键词', limit: 3 }).length, 3)
  store.close()
})

test('sqlite memory: ttl 惰性过期', () => {
  let clock = 1_000_000
  const store = new SqliteMemoryStore(join(dir, 'ttl.db'), () => clock)
  store.write({ scope: 'workflow', category: 'topic', content: '进行中选题', confidence: 0.8, ttl: 60 })
  // 未过期仍可检索
  assert.equal(store.query({}).length, 1)
  clock += 61_000
  assert.equal(store.query({}).length, 0)
  store.close()
})

test('sqlite memory: confidence 越界抛错', () => {
  const store = new SqliteMemoryStore(join(dir, 'range.db'))
  assert.throws(() => store.write({ scope: 'global', category: 'fact', content: 'x', confidence: 1.5 }))
  assert.throws(() => store.write({ scope: 'global', category: 'fact', content: 'x', confidence: -0.1 }))
  store.close()
})

test('sqlite memory: 重启恢复（重新打开同一文件）', () => {
  const path = join(dir, 'restart.db')
  let clock = 2_000_000
  const first = new SqliteMemoryStore(path, () => clock)
  const persistent = first.write({
    scope: 'global', category: 'fact', content: 'SQLite 持久化事实', confidence: 0.6,
  })
  const ephemeral = first.write({
    scope: 'global', category: 'fact', content: '临时事实也含 SQLite', confidence: 0.9, ttl: 30,
  })
  const topic = first.write({
    scope: 'workflow', category: 'topic', content: '进行中 SQLite 选题', confidence: 0.4,
  })
  first.close()

  clock += 31_000 // ttl=30s 的临时事实跨重启惰性过期
  const reopened = new SqliteMemoryStore(path, () => clock)
  const recovered = reopened.query({ keyword: 'SQLite' })
  assert.equal(recovered.length, 2)
  assert.deepEqual(
    recovered.map((e) => e.id).sort(),
    [persistent.id, topic.id].sort(),
  )
  // 字段完整保留
  const fact = recovered.find((e) => e.id === persistent.id)
  assert.equal(fact?.content, 'SQLite 持久化事实')
  assert.equal(fact?.createdAt, persistent.createdAt)
  assert.equal(fact?.scope, 'global')
  assert.equal(ephemeral.id !== undefined, true)
  assert.equal(reopened.query({ keyword: '临时事实' }).length, 0)

  // 重启后继续写入，与恢复数据一起按置信度排序
  const next = reopened.write({
    scope: 'global', category: 'fact', content: '重启后新写入的 SQLite 事实', confidence: 0.99,
  })
  const all = reopened.query({ keyword: 'SQLite' })
  assert.equal(all.length, 3)
  assert.equal(all[0].id, next.id)
  reopened.close()
})

test('sqlite memory: owner 过滤——个人条目私有 + 无主共享（多用户口径）', () => {
  const store = new SqliteMemoryStore(join(dir, 'owner.db'))
  store.write({ scope: 'global', category: 'soul', content: '甲的人设', confidence: 0.9, owner: 'user-a' })
  store.write({ scope: 'global', category: 'lesson', content: '乙的教训', confidence: 0.8, owner: 'user-b' })
  store.write({ scope: 'global', category: 'fact', content: '共享事实', confidence: 0.7 })

  const aView = store.query({ owner: 'user-a', limit: 50 })
  assert.equal(aView.length, 2, '甲 = 自己的 + 无主共享')
  assert.equal(store.query({ owner: 'user-b', limit: 50 }).length, 2)
  assert.equal(store.query({ limit: 50 }).length, 3, '不传 owner 见全部（v1 行为）')
  // 重启恢复后 owner 过滤仍生效（owner 列持久化）
  store.close()
  const reopened = new SqliteMemoryStore(join(dir, 'owner.db'))
  assert.equal(reopened.query({ owner: 'user-a', limit: 50 }).length, 2)
  reopened.close()
})
