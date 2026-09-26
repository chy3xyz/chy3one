import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteIdeaStore } from '../idea/store.js'
import { planMvp } from '../mvp/planner.js'
import { IdeaWorkspace } from './workspace.js'
import { buildAgentDevPrompt, runAgentDev } from './agent-dev.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-agent-dev-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const store = new SqliteIdeaStore(join(dir, `ideas-${Math.random().toString(36).slice(2, 8)}.db`))
  const idea = store.create({ text: 'AI 选品工具。打算做一个选品数据平台。面向跨境电商卖家。' })
  const plan = planMvp(idea.id, idea.domains)
  const ws = new IdeaWorkspace(join(dir, `ws-${Math.random().toString(36).slice(2, 8)}`))
  return { store, idea, plan, ws }
}

test('agent-dev: 任务书组装——自包含结构（三域/功能范围/产出要求）', () => {
  const { idea, plan } = setup()
  const prompt = buildAgentDevPrompt(idea, plan)
  assert.ok(prompt.includes(`# 开发任务：${idea.name}`))
  assert.ok(prompt.includes('问题域：'))
  assert.ok(prompt.includes('MVP 功能范围（按此实现'))
  assert.ok(prompt.includes('README.md'))
  assert.ok(prompt.includes('只在当前目录内创建文件'), '越界约束必须写进任务书')
})

test('agent-dev: 执行产出落盘工作区 + 决策正本（IP-02）', () => {
  const { idea, plan, ws } = setup()
  const decisions: string[] = []
  const result = runAgentDev(idea, plan, ws, {
    execute: async (task) => ({
      output: '实现了功能清单 1-2 条',
      sessionId: 'sess-1',
      files: [
        { path: 'README.md', content: `# ${task.ideaId}\n` },
        { path: 'src/main.ts', content: 'console.log(1)\n' },
      ],
    }),
    writeDecision: (id, content) => decisions.push(`${id}:${content}`),
  })
  return result.then((r) => {
    assert.equal(r.mode, 'spawned')
    assert.deepEqual(r.files, ['README.md', 'src/main.ts'])
    assert.equal(ws.readFile('src/main.ts'), 'console.log(1)\n')
    assert.equal(decisions.length, 1)
    const payload = JSON.parse(decisions[0].slice(decisions[0].indexOf(':') + 1))
    assert.equal(payload.kind, 'agent-dev-run')
    assert.equal(payload.sessionId, 'sess-1')
  })
})

test('agent-dev: 越界产出被工作区守卫拒绝（Agent 不能逃出创意工作区）', async () => {
  const { idea, plan, ws } = setup()
  await assert.rejects(
    () =>
      runAgentDev(idea, plan, ws, {
        execute: async () => ({
          output: '尝试越界',
          files: [{ path: '../../escape.txt', content: 'x' }],
        }),
      }),
    (error: { code?: string }) => error.code === 'PERMISSION_DENIED',
  )
})

test('agent-dev: recorded 模式（宿主无 agents 服务时任务书落盘）', async () => {
  const { idea, plan, ws } = setup()
  const result = await runAgentDev(idea, plan, ws, {
    execute: async (task) => ({
      mode: 'recorded' as const,
      output: '宿主未提供 agents 服务',
      files: [{ path: 'AGENT-TASK.md', content: task.prompt }],
    }),
  })
  assert.equal(result.mode, 'recorded')
  assert.equal(ws.readFile('AGENT-TASK.md'), buildAgentDevPrompt(idea, plan))
  // 工作区实际落盘核对
  assert.ok(readFileSync(join(ws.path, 'AGENT-TASK.md'), 'utf8').includes('# 开发任务'))
})
