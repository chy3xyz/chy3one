import test from 'node:test'
import assert from 'node:assert/strict'
import { JsonlMemoryStore } from './memory.js'

test('memory: write & query by category/keyword (AC-04 基础检索)', () => {
  const store = new JsonlMemoryStore()
  store.write({ scope: 'global', category: 'lesson', content: '金融合同必须检查利率上限条款', confidence: 0.9 })
  store.write({ scope: 'agent', category: 'soul', content: '合同审查专家人格', confidence: 0.95 })
  store.write({ scope: 'global', category: 'fact', content: '爆款标题含数字', confidence: 0.7 })

  assert.equal(store.query({ category: 'lesson' }).length, 1)
  assert.equal(store.query({ keyword: '合同' }).length, 2)
  // 高置信度优先
  const ranked = store.query({ keyword: '合同' })
  assert.equal(ranked[0].category, 'soul')
  assert.equal(store.query({ scope: 'agent' }).length, 1)
})

test('memory: ttl 惰性过期', () => {
  let clock = 1_000_000
  const store = new JsonlMemoryStore(undefined, () => clock)
  store.write({ scope: 'workflow', category: 'topic', content: '进行中选题', confidence: 0.8, ttl: 60 })
  clock += 61_000
  assert.equal(store.query({}).length, 0)
})

test('memory: confidence 越界抛错', () => {
  const store = new JsonlMemoryStore()
  assert.throws(() => store.write({ scope: 'global', category: 'fact', content: 'x', confidence: 1.5 }))
})

test('memory: owner 过滤——个人条目私有 + 无主共享（多用户口径）', () => {
  const store = new JsonlMemoryStore()
  store.write({ scope: 'global', category: 'soul', content: '甲的人设：硬核科技评论员', confidence: 0.9, owner: 'user-a' })
  store.write({ scope: 'global', category: 'lesson', content: '乙的教训：投放先小步测试', confidence: 0.8, owner: 'user-b' })
  store.write({ scope: 'global', category: 'fact', content: '共享事实：爆款标题含数字', confidence: 0.7 }) // 无主

  // 甲：自己的个人条目 + 共享条目，看不到乙的
  const aView = store.query({ owner: 'user-a', limit: 50 })
  assert.equal(aView.length, 2)
  assert.ok(aView.some((e) => e.content.includes('甲的人设')))
  assert.ok(aView.some((e) => e.content.includes('共享事实')))
  assert.equal(aView.some((e) => e.content.includes('乙的教训')), false)

  // 乙：自己的 + 共享
  const bView = store.query({ owner: 'user-b', limit: 50 })
  assert.equal(bView.length, 2)

  // 不传 owner（v1 行为）：见全部
  assert.equal(store.query({ limit: 50 }).length, 3)
})
