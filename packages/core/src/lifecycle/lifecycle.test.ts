import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryBodyIndex } from '../memory/body-index.js'
import { MemoryBodyHub } from '../memory/memory-body.js'
import { SqliteIdeaStore } from '../idea/store.js'
import { IdeaLifecycle, STAGE_TRANSITIONS } from './lifecycle.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-lifecycle-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

const root = join(dir, 'ideas')

function setup() {
  const store = new SqliteIdeaStore(join(dir, `ideas-${Math.random().toString(36).slice(2, 8)}.db`), root)
  const hub = new MemoryBodyHub(root, new MemoryBodyIndex(join(dir, `idx-${Math.random().toString(36).slice(2, 8)}.db`)))
  const lifecycle = new IdeaLifecycle(store, hub)
  const idea = store.create({ text: 'AI 落地页生成器，帮独立开发者快速上线' })
  return { store, hub, lifecycle, idea }
}

test('lifecycle: 线性单向迁移表（prd2.md 1.2 四阶段）', () => {
  assert.deepEqual(STAGE_TRANSITIONS.description, ['product'])
  assert.deepEqual(STAGE_TRANSITIONS.product, ['operation'])
  assert.deepEqual(STAGE_TRANSITIONS.operation, ['asset'])
  assert.deepEqual(STAGE_TRANSITIONS.asset, [], '资产是终态')
})

test('lifecycle: 正向单步迁移 + decisions 正本 + profile/meta 同步', () => {
  const { store, hub, lifecycle, idea } = setup()
  assert.deepEqual(lifecycle.nextStages(idea.id), ['product'])

  const result = lifecycle.transition(idea.id, 'product')
  assert.equal(result.idea.stage, 'product')
  assert.equal(result.transition.from, 'description')
  assert.equal(result.transition.to, 'product')
  assert.ok(result.transition.note.includes('MVP验证通过'), '默认决策文案对齐 prd2.md 3.4')

  // decisions 流写入迁移正本（model 权威）
  const decisions = hub.readStream(idea.id, 'decisions')
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].authority, 'model')
  const payload = JSON.parse(decisions[0].content)
  assert.equal(payload.kind, 'stage-transition')
  assert.equal(payload.from, 'description')

  // 子OS profile 与 meta 同步（store.updateStage 内）
  const profile = readFileSync(join(root, idea.id, 'profile', 'cordis.patch.yml'), 'utf8')
  assert.match(profile, /stage: "product"/)
  assert.equal(store.require(idea.id).stage, 'product')
})

test('lifecycle: 跳跃/回退/非法目标拒绝（STAGE_TRANSITION_INVALID）', () => {
  const { lifecycle, idea } = setup()
  // 跳跃：description → operation
  assert.throws(() => lifecycle.transition(idea.id, 'operation'), /STAGE_TRANSITION_INVALID|线性/)
  // 回退：迁移到当前阶段同样拒绝（transition 表不含自身）
  assert.throws(() => lifecycle.transition(idea.id, 'description'), /STAGE_TRANSITION_INVALID|线性/)
  // 非法值
  assert.throws(() => lifecycle.transition(idea.id, 'bogus' as 'product'), /VALIDATION_ERROR|stage must be/)
  // 终态不可再迁
  lifecycle.transition(idea.id, 'product')
  lifecycle.transition(idea.id, 'operation')
  lifecycle.transition(idea.id, 'asset')
  assert.deepEqual(lifecycle.nextStages(idea.id), [])
  assert.throws(() => lifecycle.transition(idea.id, 'product'), /STAGE_TRANSITION_INVALID|线性/)
})

test('lifecycle: 自定义 note 覆盖默认文案；hub 缺席时迁移仍成功', () => {
  const { lifecycle, idea, store } = setup()
  const result = lifecycle.transition(idea.id, 'product', '内测 12 人，次留 40%，过线')
  assert.equal(result.transition.note, '内测 12 人，次留 40%，过线')

  const bare = new IdeaLifecycle(store, undefined)
  const idea2 = store.create({ text: '另一个创意' })
  assert.equal(bare.transition(idea2.id, 'product').idea.stage, 'product')
})
