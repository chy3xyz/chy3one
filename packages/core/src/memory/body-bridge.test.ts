import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldIdeaHome } from '../idea/store.js'
import type { Idea } from '../idea/store.js'
import { IdeaMemoryBridge } from './body-bridge.js'
import { MemoryBodyHub } from './memory-body.js'
import { MemoryBodyIndex } from './body-index.js'
import { TemplateTopicStrategy } from '../content/strategy.js'
import { ContentPipeline } from '../content/pipeline.js'
import type { MemoryEntry, MemoryStore } from './memory.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-body-bridge-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 每个用例独立 ideas 根与索引库：脚手架幂等不覆盖既有文件，共享会累积条目 */
let setupSeq = 0

function makeIdeaIn(ideasRoot: string, id: string): Idea {
  const idea = {
    id,
    name: id,
    stage: 'operation' as const,
    domains: {
      problem: { summary: 'p', points: [] },
      solution: { summary: 's', points: [] },
      spacetime: { summary: 't', points: [] },
    },
    createdAt: 1,
    updatedAt: 1,
  }
  scaffoldIdeaHome(ideasRoot, idea)
  return idea
}

function setup() {
  setupSeq += 1
  const root = join(dir, `ideas-${setupSeq}`)
  makeIdeaIn(root, 'idea-a')
  makeIdeaIn(root, 'idea-b')
  const hub = new MemoryBodyHub(root, new MemoryBodyIndex(join(dir, `bridge-idx-${setupSeq}.db`)))
  return { hub, bridgeA: new IdeaMemoryBridge(hub, 'idea-a'), bridgeB: new IdeaMemoryBridge(hub, 'idea-b') }
}

test('body bridge: 类别→流映射 + 写读回圈', () => {
  const { hub, bridgeA } = setup()
  assert.equal(IdeaMemoryBridge.streamOf('fact'), 'facts')
  assert.equal(IdeaMemoryBridge.streamOf('topic'), 'description')

  const entry = bridgeA.write({ scope: 'global', category: 'soul', content: '硬核科技评论员', confidence: 0.9 })
  assert.equal(entry.category, 'soul')
  // 落在 idea-a 的 description 流（正本可重放）
  const stream = hub.readStream('idea-a', 'description')
  assert.ok(stream.some((e) => e.content === '硬核科技评论员' && e.authority === 'model'))
})

test('body bridge: 创意A与创意B人设完全隔离（CO-02，prd2.md 4.2）', () => {
  const { bridgeA, bridgeB } = setup()
  bridgeA.write({ scope: 'global', category: 'soul', content: '硬核科技评论员', confidence: 0.9 })
  bridgeB.write({ scope: 'global', category: 'soul', content: '温柔生活方式博主', confidence: 0.9 })

  const soulA = bridgeA.query({ category: 'soul' })
  const soulB = bridgeB.query({ category: 'soul' })
  assert.equal(soulA.length, 1)
  assert.equal(soulA[0]?.content, '硬核科技评论员')
  assert.equal(soulB[0]?.content, '温柔生活方式博主')
  assert.equal(bridgeA.query({ category: 'soul', keyword: '温柔' }).length, 0, 'A 检索不到 B 的人设')
})

test('body bridge: 端到端——流水线按 ideaId 隔离运行（选题/沉淀均入该创意记忆体）', async () => {
  const { hub, bridgeA } = setup()
  // 创意A的选题 + 人设
  bridgeA.write({ scope: 'global', category: 'topic', content: 'AI 建站工具选购指南', confidence: 0.8 })
  bridgeA.write({ scope: 'global', category: 'soul', content: '硬核科技评论员', confidence: 0.9 })

  const noopStore: MemoryStore = {
    write: (): MemoryEntry => {
      throw new Error('global store must not be used for idea runs')
    },
    query: () => [],
  }
  let globalWrites = 0
  const globalMemory: MemoryStore = {
    write: (entry) => {
      globalWrites++
      return { ...entry, id: `g-${globalWrites}`, createdAt: 0 }
    },
    query: () => [],
  }
  void noopStore
  const pipeline = new ContentPipeline({
    memory: globalMemory,
    ideaMemoryResolver: (ideaId) => (ideaId === 'idea-a' ? bridgeA : undefined),
  })
  const result = await pipeline.run('idea-a')
  assert.equal(result.ideaId, 'idea-a')
  assert.equal(result.brief.title, 'AI 建站工具选购指南', '选题应落题为创意A记忆体里的选题')
  assert.ok(result.review.eeat, 'E-E-A-T 检查应随审核结果携带')
  assert.ok(result.content.schemaJsonLd?.includes('schema.org'), 'Schema 标记随内容生成')
  assert.equal(globalWrites, 0, '发布沉淀应写入创意记忆体而非全局库')

  // 沉淀落在 idea-a 的 facts 流
  const facts = hub.readStream('idea-a', 'facts')
  assert.ok(facts.some((e) => e.content.startsWith('发布成功')))

  // TemplateTopicStrategy 在桥上仍能取到选题候选（≥5 由常青库兜底）
  const strategy = new TemplateTopicStrategy()
  const candidates = strategy.generateCandidates(bridgeA)
  assert.ok(candidates.length >= 5)
})
