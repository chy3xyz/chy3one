import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPackage, verifyPackage, installPackage, type SkillPackage } from './packager.js'
import type { SkillDefinition } from './distiller.js'

const skill: SkillDefinition = {
  name: 'contract-review-skill',
  version: '0.1.0',
  memorySnapshot: [
    { layer: 'soul', content: '合同审查专家人格' },
    { layer: 'lesson', content: '金融合同必须检查利率上限条款' },
  ],
  skillDefinition: {
    trigger: '用户上传合同PDF',
    toolSequence: ['pdf_reader', 'clause_extractor', 'risk_scorer'],
    postConditions: '输出风险评级+逐条修改建议',
  },
}

test('createPackage: 生成信封结构与兼容性标记', () => {
  const { pkg, keys } = createPackage(skill, 'author-001')
  assert.equal(pkg.manifest.skillId, 'contract-review-skill')
  assert.equal(pkg.manifest.authorId, 'author-001')
  assert.equal(pkg.manifest.compat.dsh, '>=0.1.0-rc.7')
  assert.ok(pkg.signature.length > 0)
  assert.ok(keys.publicKeyPem.includes('PUBLIC KEY'))
  assert.ok(keys.privateKeyPem!.includes('PRIVATE KEY'))
})

test('verifyPackage: 完整包验签通过', () => {
  const { pkg, keys } = createPackage(skill, 'author-001')
  assert.equal(verifyPackage(pkg, keys.publicKeyPem), true)
})

test('verifyPackage: 篡改检出率 100% (AR-S05)', () => {
  const { pkg, keys } = createPackage(skill, 'author-001')
  const tampered: SkillPackage[] = [
    { ...pkg, manifest: { ...pkg.manifest, authorId: 'attacker' } },
    { ...pkg, manifest: { ...pkg.manifest, version: '9.9.9' } },
    { ...pkg, skillDefinition: { ...pkg.skillDefinition, version: '9.9.9' } },
    {
      ...pkg,
      skillDefinition: {
        ...pkg.skillDefinition,
        skillDefinition: { ...pkg.skillDefinition.skillDefinition, trigger: '恶意触发条件' },
      },
    },
    { ...pkg, signature: Buffer.from('forged').toString('base64') },
    { ...pkg, signature: pkg.signature.slice(0, -8) + (pkg.signature.endsWith('A') ? 'B' : 'A') },
  ]
  for (const bad of tampered) {
    assert.equal(verifyPackage(bad, keys.publicKeyPem), false)
  }
  // 错误公钥同样拒绝
  const other = createPackage(skill, 'author-002')
  assert.equal(verifyPackage(other.pkg, keys.publicKeyPem), false)
})

test('installPackage: 验签通过则安装成功且产物落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshpkg-'))
  try {
    const { pkg, keys } = createPackage(skill, 'author-001')
    const installed = await installPackage(pkg, dir, keys.publicKeyPem)
    assert.equal(installed, join(dir, 'contract-review-skill'))
    const files = (await readdir(installed)).sort()
    assert.deepEqual(files, ['manifest.json', 'skill.json'])
    const manifest = JSON.parse(await readFile(join(installed, 'manifest.json'), 'utf8'))
    assert.equal(manifest.skillId, 'contract-review-skill')
    const skillJson = JSON.parse(await readFile(join(installed, 'skill.json'), 'utf8'))
    assert.deepEqual(skillJson.skillDefinition.toolSequence, ['pdf_reader', 'clause_extractor', 'risk_scorer'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('installPackage: 验签失败抛 SIGNATURE_INVALID，不留残余文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshpkg-'))
  try {
    const { pkg } = createPackage(skill, 'author-001')
    const tampered: SkillPackage = { ...pkg, manifest: { ...pkg.manifest, authorId: 'attacker' } }
    const other = createPackage(skill, 'author-002')
    await assert.rejects(() => installPackage(tampered, dir, other.keys.publicKeyPem), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal((err as { code?: string }).code, 'SIGNATURE_INVALID')
      return true
    })
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('installPackage: 写入失败时回滚，安装目录被清除', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dshpkg-'))
  try {
    const { pkg, keys } = createPackage(skill, 'author-001')
    // 预先在安装目录放置同名只读文件，使 mkdir 后 writeFile 失败
    const installDir = join(dir, pkg.manifest.skillId)
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(installDir, { recursive: true })
    await writeFile(join(installDir, 'manifest.json'), 'occupied', { mode: 0o444 })
    await assert.rejects(() => installPackage(pkg, dir, keys.publicKeyPem))
    // 回滚：安装目录被移除，不留残余
    const remaining = (await readdir(dir)).filter((f) => f === pkg.manifest.skillId)
    assert.equal(remaining.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
