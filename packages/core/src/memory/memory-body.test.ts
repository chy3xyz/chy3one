import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryBodyIndex } from './body-index.js'
import { MemoryBodyHub } from './memory-body.js'
import { scaffoldIdeaHome, type Idea } from '../idea/store.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-memory-body-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

const root = join(dir, 'ideas')

function makeIdea(id: string): Idea {
  const idea = {
    id,
    name: id,
    stage: 'description' as const,
    domains: {
      problem: { summary: 'p', points: [] },
      solution: { summary: 's', points: [] },
      spacetime: { summary: 't', points: [] },
    },
    createdAt: 1,
    updatedAt: 1,
  }
  scaffoldIdeaHome(root, idea)
  return idea
}

let hubSeq = 0
function makeHub(now: () => number = Date.now): MemoryBodyHub {
  hubSeq += 1
  return new MemoryBodyHub(root, new MemoryBodyIndex(join(dir, `idx-${hubSeq}.db`), now), now)
}

test('memory body: write 落 JSONL 正本 + 索引镜像，readStream 重放一致', () => {
  makeIdea('idea-w')
  const hub = makeHub()
  const entry = hub.write('idea-w', 'decisions', { content: '采用 node:sqlite 而非 ORM', confidence: 0.9 })
  assert.equal(entry.authority, 'user')

  const replayed = hub.readStream('idea-w', 'decisions')
  assert.equal(replayed.length, 1)
  assert.equal(replayed[0].id, entry.id)
  assert.equal(replayed[0].content, '采用 node:sqlite 而非 ORM')

  // 检索镜像可命中（关键词跨 JSONL 行）
  assert.equal(hub.query({ keyword: 'node:sqlite', ideaIds: ['idea-w'] }).length, 1)
})

test('memory body: 写入未初始化创意拒绝（IDEA_NOT_FOUND）', () => {
  const hub = makeHub()
  assert.throws(() => hub.write('idea-ghost', 'facts', { content: 'x', confidence: 0.5 }), /IDEA_NOT_FOUND|does not exist/)
  assert.throws(() => hub.write('idea-w', 'bogus-stream', { content: 'x', confidence: 0.5 }))
  assert.throws(() => hub.write('idea-w', 'facts', { content: 'x', confidence: 1.5 }))
})

test('memory body: 挂载协议——mount/unmount/listMounted（prd2.md 8.3）', () => {
  makeIdea('idea-m1')
  makeIdea('idea-m2')
  const hub = makeHub()
  hub.write('idea-m1', 'description', { content: '创意一的选品问题域', confidence: 0.8 })
  hub.write('idea-m2', 'description', { content: '创意二的获客问题域', confidence: 0.8 })

  // 未挂载 → 检索不到任何东西
  assert.deepEqual(hub.listMounted(), [])
  assert.equal(hub.query({ keyword: '问题域' }).length, 0)

  // /mount idea-m1：只挂创意一
  assert.deepEqual(hub.mount('idea-m1'), ['idea-m1'])
  const hits = hub.query({ keyword: '问题域' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].ideaId, 'idea-m1')

  // 处理创意A时创意B的记忆不会被检索到（prd2.md 2.4 挂载机制）
  assert.equal(hub.query({ keyword: '获客' }).length, 0)

  // 跨创意协作：同时挂载多个
  hub.mount('idea-m2')
  assert.equal(hub.query({ keyword: '问题域' }).length, 2)

  // /unmount
  assert.deepEqual(hub.unmount('idea-m1'), ['idea-m2'])
  assert.equal(hub.query({ keyword: '选品' }).length, 0)
  // 幂等卸载
  assert.deepEqual(hub.unmount('idea-m1'), ['idea-m2'])
})

test('memory body: 挂载未初始化创意拒绝；isMounted 查询', () => {
  const hub = makeHub()
  assert.throws(() => hub.mount('idea-none'), /cannot mount/)
  makeIdea('idea-ok')
  assert.equal(hub.mount('idea-ok').length, 1)
  assert.equal(hub.isMounted('idea-ok'), true)
  assert.equal(hub.isMounted('idea-nope'), false)
})

test('memory body: 显式 ideaIds 绕过挂载集合（创意详情页单体检索）', () => {
  makeIdea('idea-x')
  makeIdea('idea-y')
  const hub = makeHub()
  hub.write('idea-x', 'research', { content: '竞品分析：市场上已有三款工具', confidence: 0.7 })
  hub.write('idea-y', 'research', { content: '竞品分析：差异化在定价', confidence: 0.7 })

  // 挂载 idea-y，但显式点名 idea-x 仍可查
  hub.mount('idea-y')
  const explicit = hub.query({ keyword: '竞品分析', ideaIds: ['idea-x'] })
  assert.equal(explicit.length, 1)
  assert.equal(explicit[0].ideaId, 'idea-x')
})

test('memory body: JSONL 正本为权威——索引库损坏可由正本重放（append-only 零丢失）', () => {
  makeIdea('idea-p')
  const hub = makeHub()
  hub.write('idea-p', 'facts', { content: '品牌基准可见性15%', confidence: 0.8 })
  hub.write('idea-p', 'facts', { content: '结构化FAQ被引用概率更高', confidence: 0.85, authority: 'model' })

  const lines = readFileSync(join(root, 'idea-p', 'memory-body', 'facts.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
  assert.equal(lines.length, 2)
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.authority, 'user')
  assert.ok(existsSync(join(root, 'idea-p', 'memory-body', 'facts.jsonl')))
})
