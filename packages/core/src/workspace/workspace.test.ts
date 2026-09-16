import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdeaWorkspace, workspacePathFor } from './workspace.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-workspace-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeWorkspace(): { ws: IdeaWorkspace; root: string } {
  const root = join(dir, `ws-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(root, { recursive: true })
  return { ws: new IdeaWorkspace(root), root }
}

test('workspace: 写读删正常路径（IP-02 Agent 读写创意工作区）', () => {
  const { ws } = makeWorkspace()
  const written = ws.writeFile('src/index.ts', 'console.log(1)\n')
  assert.ok(written.path.endsWith(join('src', 'index.ts')))
  assert.equal(written.bytes, 15)
  assert.equal(ws.readFile('src/index.ts'), 'console.log(1)\n')
  assert.deepEqual(ws.list(), ['src/index.ts'])
  assert.equal(ws.removeFile('src/index.ts'), true)
  assert.equal(ws.readFile('src/index.ts'), undefined)
})

test('workspace: 越界路径全部拒绝（prd2.md 3.3 工作区隔离）', () => {
  const { ws, root } = makeWorkspace()
  const denied = (fn: () => unknown): void =>
    assert.throws(fn, (error: { code?: string }) => error.code === 'PERMISSION_DENIED')
  // .. 逃逸
  denied(() => ws.resolveIn('../../etc/passwd'))
  denied(() => ws.writeFile('../sibling.txt', 'x'))
  // 绝对路径（POSIX 与 Windows 盘符）
  denied(() => ws.resolveIn('/etc/passwd'))
  denied(() => ws.resolveIn('C:\\windows\\temp'))
  // 空路径 / NUL
  assert.throws(() => ws.resolveIn(''), /non-empty/)
  assert.throws(() => ws.resolveIn('a\0b'), /NUL/)
  // 兄弟目录（同 root 深度）不可达
  const sibling = join(root, '..', `${root}-sibling`)
  mkdirSync(sibling, { recursive: true })
  writeFileSync(join(sibling, 'secret.txt'), 'secret')
  denied(() => ws.readFile(join('..', `${root}-sibling`, 'secret.txt')))
  // 深层前缀伪装不通过（normalize 后仍越界）
  denied(() => ws.resolveIn('a/b/../../../outside.txt'))
})

test('workspace: 读不存在的文件返回 undefined；list 空工作区为空', () => {
  const { ws } = makeWorkspace()
  assert.equal(ws.readFile('ghost.txt'), undefined)
  assert.deepEqual(ws.list(), [])
  assert.equal(ws.removeFile('ghost.txt'), false)
})

test('workspace: 工作区根首次写入自动创建；workspacePathFor 约定路径', () => {
  const root = join(dir, 'auto', 'workspace-root')
  const ws = new IdeaWorkspace(root)
  assert.equal(existsSync(root), false)
  ws.writeFile('README.md', 'hello\n')
  assert.equal(existsSync(root), true)
  assert.equal(ws.readFile('README.md'), 'hello\n')
  assert.equal(workspacePathFor(join(dir, 'ideas', 'idea-x')), join(dir, 'ideas', 'idea-x', 'workspace'))
})

test('workspace: 写工作区根本身拒绝（根只作目录容器）', () => {
  const { ws } = makeWorkspace()
  assert.throws(() => ws.writeFile('.', 'x'), /root itself/)
  assert.equal(ws.readFile('.'), undefined)
})
