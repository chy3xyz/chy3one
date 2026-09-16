import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryBodyIndex, type BodyEntry } from './body-index.js'

const dir = mkdtempSync(join(tmpdir(), 'opcos-body-index-'))
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function entry(partial: Partial<BodyEntry> & { ideaId: string; content: string }): BodyEntry {
  seq += 1
  return {
    id: `entry-${seq}`,
    stream: 'description',
    authority: 'user',
    confidence: 0.8,
    createdAt: 1_000 + seq,
    ...partial,
  }
}

test('body index: 检索隔离——ideaIds 过滤（prd2.md 8.3 检索隔离行）', () => {
  const index = new MemoryBodyIndex(join(dir, 'iso.db'))
  index.append(entry({ ideaId: 'idea-aaa', content: '跨境电商选品难是核心问题' }))
  index.append(entry({ ideaId: 'idea-bbb', content: '宠物喂养平台的问题陈述' }))

  assert.equal(index.query({ ideaIds: ['idea-aaa'], keyword: '问题' }).length, 1)
  assert.equal(index.query({ ideaIds: ['idea-aaa'], keyword: '宠物' }).length, 0)
  // 跨创意同时挂载 → 命中两者
  assert.equal(index.query({ ideaIds: ['idea-aaa', 'idea-bbb'], keyword: '问题' }).length, 2)
  // 空挂载集合 → 永远空结果（不挂载不检索）
  assert.equal(index.query({ ideaIds: [], keyword: '问题' }).length, 0)
  index.close()
})

test('body index: 中英文 ≥3 字任意子串命中（FTS5 trigram / prd2.md 8.3）', () => {
  const index = new MemoryBodyIndex(join(dir, 'fts.db'))
  index.append(entry({ ideaId: 'idea-fts', content: '跨境电商选品难怎么办' }))
  index.append(entry({ ideaId: 'idea-fts', content: 'AI video editor for creators' }))

  // 中文 3 字子串（非整词、非前缀）
  assert.equal(index.query({ ideaIds: ['idea-fts'], keyword: '选品难' }).length, 1)
  assert.equal(index.query({ ideaIds: ['idea-fts'], keyword: '电商选品' }).length, 1)
  // 英文子串大小写不敏感
  assert.equal(index.query({ ideaIds: ['idea-fts'], keyword: 'editor' }).length, 1)
  assert.equal(index.query({ ideaIds: ['idea-fts'], keyword: 'EDITOR' }).length, 1)
  // 不命中的子串
  assert.equal(index.query({ ideaIds: ['idea-fts'], keyword: '不存在的子串' }).length, 0)
  index.close()
})

test('body index: <3 字符关键词回退 LIKE 仍可命中', () => {
  const index = new MemoryBodyIndex(join(dir, 'like.db'))
  index.append(entry({ ideaId: 'idea-like', content: '跨境电商选品难' }))
  assert.equal(index.query({ ideaIds: ['idea-like'], keyword: '选品' }).length, 1)
  assert.equal(index.query({ ideaIds: ['idea-like'], keyword: '不存在的词' }).length, 0)
  index.close()
})

test('body index: stream / authority 过滤 + 置信度排序', () => {
  const index = new MemoryBodyIndex(join(dir, 'filter.db'))
  index.append(entry({ ideaId: 'idea-f', content: '决策记录甲', stream: 'decisions', confidence: 0.6 }))
  index.append(entry({ ideaId: 'idea-f', content: '决策记录乙', stream: 'decisions', confidence: 0.95 }))
  index.append(entry({ ideaId: 'idea-f', content: '决策记录丙', stream: 'decisions', confidence: 0.9, authority: 'model' }))

  const ranked = index.query({ ideaIds: ['idea-f'], keyword: '决策' })
  assert.equal(ranked[0].content, '决策记录乙')
  assert.equal(index.query({ ideaIds: ['idea-f'], keyword: '决策', authority: 'model' }).length, 1)
  assert.equal(index.query({ ideaIds: ['idea-f'], keyword: '决策', stream: 'facts' }).length, 0)
  index.close()
})

test('body index: 重启恢复（同一文件重开可检索）', () => {
  const path = join(dir, 'restart.db')
  const first = new MemoryBodyIndex(path)
  first.append(entry({ ideaId: 'idea-r', content: '持久化的品牌事实库条目', stream: 'facts' }))
  first.close()

  const reopened = new MemoryBodyIndex(path)
  assert.equal(reopened.query({ ideaIds: ['idea-r'], keyword: '品牌事实库' }).length, 1)
  reopened.close()
})
