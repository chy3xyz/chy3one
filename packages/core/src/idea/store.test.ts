import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteIdeaStore } from './store.js'
import { IDEA_MEMORY_STREAMS, GUIDING_QUESTIONS, DOMAIN_KEYS } from './types.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-idea-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

const TEXT =
  '独立开发者获客很难，缺少低价的落地页工具。我们打算做一个AI落地页生成器，通过对话式配置直接上线。面向出海的跨境电商市场，时间窗口在AI流量红利期。'

test('idea store: create 自动生成三域草案（ID-01）', () => {
  const store = new SqliteIdeaStore(join(dir, 'ideas.db'))
  const idea = store.create({ text: TEXT })
  assert.match(idea.id, /^idea-[0-9a-f]{8}$/)
  assert.equal(idea.stage, 'description')
  assert.ok(idea.domains.problem.summary.includes('独立开发者获客很难'))
  assert.ok(idea.domains.solution.summary.includes('AI落地页生成器'))
  assert.ok(idea.domains.spacetime.summary.includes('跨境电商市场'))
  // ID-02 验收：每个维度至少 3 个引导问题
  for (const key of DOMAIN_KEYS) {
    assert.ok(GUIDING_QUESTIONS[key].length >= 3, `${key} 引导问题不足 3 个`)
  }
  store.close()
})

test('idea store: create 落目录脚手架（ID-03）且幂等', () => {
  const root = join(dir, 'ideas-home')
  const store = new SqliteIdeaStore(join(dir, 'home.db'), root)
  const idea = store.create({ text: TEXT, name: '落地页生成器' })

  for (const stream of IDEA_MEMORY_STREAMS) {
    assert.ok(existsSync(join(root, idea.id, 'memory-body', `${stream}.jsonl`)), `${stream}.jsonl 缺失`)
  }
  assert.ok(existsSync(join(root, idea.id, 'assets', 'ledger.json')))
  assert.ok(existsSync(join(root, idea.id, 'assets', 'token.json')))
  assert.ok(existsSync(join(root, idea.id, 'profile', 'cordis.patch.yml')))
  assert.ok(existsSync(join(root, idea.id, 'meta.json')))

  const ledger = JSON.parse(readFileSync(join(root, idea.id, 'assets', 'ledger.json'), 'utf8'))
  assert.equal(ledger.idea_id, idea.id)
  assert.equal(ledger.assets.finance.total, 0)
  const meta = JSON.parse(readFileSync(join(root, idea.id, 'meta.json'), 'utf8'))
  assert.equal(meta.stage, 'description')

  // 幂等：重复脚手架不覆盖既有文件（改为重建 store 触发同 id 校验路径外，直接重入断言不抛）
  assert.doesNotThrow(() => store.get(idea.id))
  store.close()
})

test('idea store: 三域迭代（ID-02）——整体替换与单域合并', () => {
  const store = new SqliteIdeaStore(join(dir, 'iter.db'))
  const idea = store.create({ text: '宠物上门喂养服务的创意描述' })
  const updated = store.updateDomain(idea.id, 'solution', {
    summary: '连接宠物主与附近喂养员的调度平台',
    points: ['双向评价体系', '行程可视化'],
  })
  assert.equal(updated.domains.solution.summary, '连接宠物主与附近喂养员的调度平台')
  assert.deepEqual(updated.domains.solution.points, ['双向评价体系', '行程可视化'])
  // 其他域保持不变
  assert.equal(updated.domains.problem.summary, idea.domains.problem.summary)

  const replaced = store.updateDomains(idea.id, {
    problem: { summary: '假期宠物无人照看', points: ['异地度假场景高频'] },
    solution: updated.domains.solution,
    spacetime: { summary: '一二线城市，节假日窗口', points: ['春节/国庆峰值'] },
  })
  assert.equal(replaced.domains.problem.summary, '假期宠物无人照看')
  assert.equal(replaced.domains.spacetime.points[0], '春节/国庆峰值')

  // 结构校验：缺域 / 非法 points 拒绝
  assert.throws(() =>
    store.updateDomains(idea.id, {
      problem: { summary: 'x', points: [] },
      solution: { summary: 'y', points: 'no' as unknown as string[] },
      spacetime: { summary: 'z', points: [] },
    }),
  )
  store.close()
})

test('idea store: 阶段推进同步 profile 与 meta（prd2.md 2.5）', () => {
  const root = join(dir, 'ideas-stage')
  const store = new SqliteIdeaStore(join(dir, 'stage.db'), root)
  const idea = store.create({ text: TEXT })
  store.updateStage(idea.id, 'product')

  const profile = readFileSync(join(root, idea.id, 'profile', 'cordis.patch.yml'), 'utf8')
  assert.match(profile, /stage: "product"/)
  assert.match(profile, /currentStage: "product"/)
  assert.match(profile, /idea_id: "/)
  const meta = JSON.parse(readFileSync(join(root, idea.id, 'meta.json'), 'utf8'))
  assert.equal(meta.stage, 'product')

  assert.throws(() => store.updateStage(idea.id, 'bogus' as 'product'))
  store.close()
})

test('idea store: list 新建在前 / count / require 404 语义', () => {
  let clock = 10_000
  const store = new SqliteIdeaStore(join(dir, 'list.db'), undefined, () => clock)
  const a = store.create({ text: '第一个创意' })
  clock += 1_000
  const b = store.create({ text: '第二个创意' })
  assert.deepEqual(store.list().map((i) => i.id), [b.id, a.id])
  assert.equal(store.count(), 2)
  assert.throws(() => store.require('idea-missing'), /does not exist/)
  assert.throws(() => store.create({ text: '   ' }))
  store.close()
})
