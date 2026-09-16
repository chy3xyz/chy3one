import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteIdeaStore } from '../../../core/src/index.js'
import { apply, plugin } from './index.js'
import { createMockContext } from '../../../dsh-adapter/src/index.js'

test('plugin opc-lifecycle: 服务注册 + 迁移写入共享库 + 卸载关闭', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-lifecycle-'))
  try {
    const ideasRoot = join(dir, 'ideas')
    const store = new SqliteIdeaStore(join(dir, 'ideas.db'), ideasRoot)
    const idea = store.create({ text: '组队协作待办小工具' })
    store.close()

    const ctx = createMockContext()
    apply(ctx, { ideasDbPath: join(dir, 'ideas.db'), ideasRoot, bodiesDbPath: join(dir, 'bodies.db') })
    const lifecycle = ctx.getService('opc.lifecycle') as {
      nextStages(id: string): string[]
      canTransition(id: string, to: string): boolean
      transition(id: string, to: string, note?: string): { idea: { stage: string }; transition: { from: string; to: string } }
    }
    assert.deepEqual(lifecycle.nextStages(idea.id), ['product'])
    assert.equal(lifecycle.canTransition(idea.id, 'product'), true)
    assert.equal(lifecycle.canTransition(idea.id, 'asset'), false)

    const result = lifecycle.transition(idea.id, 'product', '过线')
    assert.equal(result.idea.stage, 'product')
    assert.equal(result.transition.from, 'description')

    // 决策正本落入共享目录的 memory-body/decisions.jsonl（跨连接可见）
    const decisions = JSON.parse(
      readFileSync(join(ideasRoot, idea.id, 'memory-body', 'decisions.jsonl'), 'utf8')
        .split('\n').filter((l: string) => l.trim())[0],
    )
    assert.equal(decisions.content.includes('过线'), true)

    // 非法迁移 409 语义错误码（回退被状态机拒绝）
    assert.throws(
      () => lifecycle.transition(idea.id, 'description'),
      (error: { code?: string }) => error.code === 'STAGE_TRANSITION_INVALID',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugin opc-lifecycle: defineOpcPlugin 元数据', () => {
  assert.equal(plugin.name, 'opc-lifecycle')
})
