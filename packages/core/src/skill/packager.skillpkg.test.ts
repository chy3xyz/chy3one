import test from 'node:test'
import assert from 'node:assert/strict'
import { createPackage, verifyPackage } from './packager.js'
import type { SkillDefinition } from './distiller.js'

const DEF: SkillDefinition = {
  name: 'geo-content-optimizer',
  version: '2.1.0',
  memorySnapshot: [{ layer: 'lesson', content: '结构化FAQ被引用概率更高' }],
  skillDefinition: {
    trigger: '用户需要优化内容以提升AI可见性',
    toolSequence: ['brand_fact_check', 'schema_generator', 'geo_monitor'],
    postConditions: '输出优化后的内容 + GEO评分',
  },
}

test('.skillpkg: 创意归属元数据入签（prd2.md 7.5）', () => {
  const { pkg, keys } = createPackage(DEF, 'idea-abc12345', undefined, {
    stage: 'operation',
    category: 'GEO行销',
    compatibleIdeas: ['ecommerce', 'saas', 'content'],
    ideaId: 'idea-abc12345',
  })
  assert.equal(pkg.skillpkg?.category, 'GEO行销')
  assert.equal(pkg.manifest.authorId, 'idea-abc12345')
  assert.equal(verifyPackage(pkg, keys.publicKeyPem), true)

  // 篡改 skillpkg 元数据 → 验签失败
  const tampered = { ...pkg, skillpkg: { ...pkg.skillpkg!, category: '篡改' } }
  assert.equal(verifyPackage(tampered, keys.publicKeyPem), false)
})

test('.skillpkg: 兼容 .dshpkg —— 无元数据时验签路径不变', () => {
  const { pkg, keys } = createPackage(DEF, 'creator-alice')
  assert.equal(pkg.skillpkg, undefined)
  assert.equal(verifyPackage(pkg, keys.publicKeyPem), true)
})
