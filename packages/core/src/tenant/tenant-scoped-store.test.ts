import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlMemoryStore } from '../memory/memory.js'
import { TenantScopedMemoryStore } from './tenant-scoped-store.js'
import { OpcError } from '../errors.js'

test('tenant-store: 双租户互不可见，各自可见自己的数据 (AR-S04)', () => {
  const shared = new JsonlMemoryStore()
  const tenantA = new TenantScopedMemoryStore(shared, 'tenant-a')
  const tenantB = new TenantScopedMemoryStore(shared, 'tenant-b')

  tenantA.write({ scope: 'workflow', category: 'fact', content: '客户A的定价规则：一律9折', confidence: 0.9 })
  tenantA.write({ scope: 'agent', category: 'lesson', content: '客户A的交付教训', confidence: 0.8 })
  tenantB.write({ scope: 'workflow', category: 'fact', content: '客户B的定价规则：一律8折', confidence: 0.95 })

  // B 查不到 A 的任何数据：无过滤、关键词、scope、category 全维度
  assert.equal(tenantB.query({}).length, 1)
  assert.equal(tenantB.query({ keyword: '客户A' }).length, 0)
  assert.equal(tenantB.query({ keyword: '定价' }).length, 1)
  assert.equal(tenantB.query({ scope: 'agent' }).length, 0)
  assert.equal(tenantB.query({ category: 'lesson' }).length, 0)

  // 反向同理
  assert.equal(tenantA.query({}).length, 2)
  assert.equal(tenantA.query({ keyword: '客户B' }).length, 0)
  assert.equal(tenantA.query({ category: 'lesson' }).length, 1)

  // 高置信度排序在租户视图内依然生效
  const ranked = tenantA.query({ keyword: '定价' })
  assert.equal(ranked.length, 1)
  assert.ok(ranked[0].content.includes('客户A'))
})

test('tenant-store: 租户写入 global scope 被拒绝（PERMISSION_DENIED）', () => {
  const tenant = new TenantScopedMemoryStore(new JsonlMemoryStore(), 'tenant-a')
  assert.throws(
    () => tenant.write({ scope: 'global', category: 'fact', content: '试图污染全局', confidence: 0.9 }),
    (err: unknown) => err instanceof OpcError && err.code === 'PERMISSION_DENIED',
  )
  // 拒绝后不落任何数据
  assert.equal(tenant.query({}).length, 0)
})

test('tenant-store: 旁路直写 inner 的无标记条目对所有租户不可见（fail-closed）', () => {
  const shared = new JsonlMemoryStore()
  const tenantA = new TenantScopedMemoryStore(shared, 'tenant-a')
  shared.write({ scope: 'workflow', category: 'fact', content: '绕过包装直写', confidence: 0.99 })
  assert.equal(tenantA.query({}).length, 0)
})

test('tenant-store: limit 在租户过滤后生效，不被其他租户挤占', () => {
  const shared = new JsonlMemoryStore()
  const tenantA = new TenantScopedMemoryStore(shared, 'tenant-a')
  const tenantB = new TenantScopedMemoryStore(shared, 'tenant-b')
  // A 高置信度条目 + B 高置信度条目混合
  tenantA.write({ scope: 'workflow', category: 'topic', content: 'A-low', confidence: 0.5 })
  tenantB.write({ scope: 'workflow', category: 'topic', content: 'B-high-1', confidence: 0.99 })
  tenantA.write({ scope: 'workflow', category: 'topic', content: 'A-high', confidence: 0.9 })
  tenantB.write({ scope: 'workflow', category: 'topic', content: 'B-high-2', confidence: 0.98 })

  const result = tenantA.query({ limit: 1 })
  assert.equal(result.length, 1)
  assert.equal(result[0].content, 'A-high')
})

test('tenant-store: 打包入任意 MemoryStore 实现（仅依赖接口）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'opcos-tenant-'))
  try {
    // 用带文件的 JsonlMemoryStore 验证 tenant 标记随序列化持久化
    const tmpFile = join(tmp, 'memories.jsonl')
    const shared = new JsonlMemoryStore(tmpFile)
    new TenantScopedMemoryStore(shared, 'tenant-a').write({
      scope: 'workflow', category: 'fact', content: '持久化隔离', confidence: 0.7,
    })
    // 重新加载同一文件，新的包装实例依旧只看到 tenant-a 数据
    const reloaded = new JsonlMemoryStore(tmpFile)
    const tenantA2 = new TenantScopedMemoryStore(reloaded, 'tenant-a')
    const tenantB2 = new TenantScopedMemoryStore(reloaded, 'tenant-b')
    assert.equal(tenantA2.query({ keyword: '持久化' }).length, 1)
    assert.equal(tenantB2.query({}).length, 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
