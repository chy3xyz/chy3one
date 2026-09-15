import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTenantHome, isValidTenantId } from './tenant-homes.js'
import { OpcError } from '../errors.js'

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'opcos-homes-'))
}

function assertInvalid(id: unknown): void {
  assert.throws(
    () => createTenantHome('/tmp/opcos-root-should-not-exist', id as string),
    (err: unknown) => err instanceof OpcError && err.code === 'INVALID_TENANT_ID',
  )
}

test('homes: 创建 rootDir/<tenantId> 目录且权限 0o700 (AR-S07)', () => {
  const tmp = makeTmp()
  try {
    const home = createTenantHome(tmp, 'acme-corp')
    assert.equal(home, join(tmp, 'acme-corp'))
    assert.ok(existsSync(home))
    assert.ok(statSync(home).isDirectory())
    assert.equal(statSync(home).mode & 0o777, 0o700)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('homes: rootDir 不存在时递归创建，叶子目录仍为 0o700', () => {
  const tmp = makeTmp()
  try {
    const home = createTenantHome(join(tmp, 'dsh', 'tenants'), 't1')
    assert.ok(existsSync(home))
    assert.equal(statSync(home).mode & 0o777, 0o700)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('homes: 已存在但权限宽松的目录被收敛回 0o700', () => {
  const tmp = makeTmp()
  try {
    const pre = join(tmp, 'pre-existing')
    mkdirSync(pre) // 默认 0755
    chmodSync(pre, 0o755)
    const home = createTenantHome(tmp, 'pre-existing')
    assert.equal(statSync(home).mode & 0o777, 0o700)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('homes: 非法 tenantId 拒绝（路径穿越 / 大写 / 空 / 边界）', () => {
  for (const bad of ['../etc', '..%2Fetc', 'Acme', 'ACME', '', ' ', '-lead', 'a'.repeat(64), 'dot.id', 'slash/id', 'back\\slash', '中文']) {
    assertInvalid(bad)
    assert.equal(isValidTenantId(bad), false)
  }
})

test('homes: 合法 tenantId 边界通过（63 字符、单字符、含连字符）', () => {
  assert.equal(isValidTenantId('a'), true)
  assert.equal(isValidTenantId('a'.repeat(63)), true)
  assert.equal(isValidTenantId('0-tenant-9'), true)
  assert.equal(isValidTenantId('a'.repeat(63) + 'x'), false)
})
