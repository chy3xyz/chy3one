import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { MarketSkill } from './types.js'
import { compareVersions, satisfies } from './semver.js'
import { SqliteSkillIndex } from './sqlite-index.js'
import { installFromMarket, type PackageStore } from './flow.js'
import { createPackage } from '../skill/packager.js'
import type { SkillDefinition } from '../skill/distiller.js'
import { OpcError } from '../errors.js'

function makeSkill(overrides: Partial<MarketSkill> = {}): MarketSkill {
  return {
    id: 'skill-001',
    name: 'contract-review',
    version: '0.1.0',
    authorId: 'author-001',
    price: 1990,
    category: 'legal',
    downloads: 0,
    rating: 0,
    createdAt: 1_700_000_000_000,
    compat: { dsh: '>=0.1.0-rc.7' },
    ...overrides,
  }
}

/** 每个用例独立 tmpdir + 索引实例，结束即清理（含 WAL 残留文件） */
async function withIndex(fn: (index: SqliteSkillIndex) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'market-test-'))
  const index = new SqliteSkillIndex(join(dir, 'skills.db'))
  try {
    await fn(index)
  } finally {
    index.close()
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------- semver ----------

test('satisfies: DSH 兼容基线 >=0.1.0-rc.7 的命中 / 不命中', () => {
  assert.equal(satisfies('>=0.1.0-rc.7', '0.1.5-rc.1'), true)
  assert.equal(satisfies('>=0.1.0-rc.7', '0.1.0-rc.3'), false)
  assert.equal(satisfies('>=0.1.0-rc.7', '0.1.0'), true)
  assert.equal(satisfies('>=0.1.0-rc.7', '0.1.0-rc.7'), true) // 恰好等于下界
  assert.equal(satisfies('>=0.1.0-rc.7', '0.0.9'), false)
})

test('satisfies: prerelease 段按数值比较（rc.7 < rc.10），正式版 > prerelease', () => {
  assert.equal(satisfies('>=1.0.0-rc.7', '1.0.0-rc.10'), true)
  assert.equal(satisfies('>=1.0.0-rc.10', '1.0.0-rc.7'), false)
  assert.equal(satisfies('>=1.0.0', '1.0.0-rc.1'), false) // 下界为正式版时 rc 不满足
  // 更高版本的 prerelease 仍大于低版本正式版
  assert.equal(compareVersions('0.2.0-rc.1', '0.1.9'), 1)
  assert.equal(compareVersions('0.1.0-alpha', '0.1.0-beta'), -1)
  assert.equal(compareVersions('0.1.0-rc.7', '0.1.0-rc.7.build.1'), -1) // 前缀相同，字段多者大
  assert.equal(compareVersions('0.1.0-1', '0.1.0-alpha'), -1) // 数字段低于字母段
})

test('satisfies: 不支持的范围 / 非法版本抛 RangeError', () => {
  assert.throws(() => satisfies('^0.1.0', '0.1.0'), RangeError)
  assert.throws(() => satisfies('~1.0.0', '1.0.0'), RangeError)
  assert.throws(() => satisfies('>=0.1', '0.1.0'), RangeError) // 非完整 x.y.z
  assert.throws(() => satisfies('>=1.0.0', '1.0'), RangeError)
})

// ---------- sqlite-index：写入与读取 ----------

test('upsert/get/count: 新条目落库并完整往返', async () => {
  await withIndex((index) => {
    const skill = makeSkill()
    index.upsert(skill)
    assert.deepEqual(index.get('skill-001'), skill)
    assert.equal(index.get('nope'), undefined)
    assert.equal(index.count(), 1)
  })
})

test('upsert: 新版本覆盖展示字段但保留 downloads/rating/createdAt', async () => {
  await withIndex((index) => {
    index.upsert(makeSkill())
    index.incDownloads('skill-001')
    index.incDownloads('skill-001')
    index.incDownloads('skill-001')
    index.rate('skill-001', 5)

    index.upsert(
      makeSkill({ version: '0.2.0', name: 'contract-review-pro', price: 2990, category: 'legal-pro' }),
    )
    const updated = index.get('skill-001')
    assert.ok(updated)
    assert.equal(updated.version, '0.2.0')
    assert.equal(updated.name, 'contract-review-pro')
    assert.equal(updated.price, 2990)
    assert.equal(updated.category, 'legal-pro')
    assert.equal(updated.downloads, 3) // 保留
    assert.equal(updated.rating, 5) // 保留
    assert.equal(updated.createdAt, 1_700_000_000_000) // 保留
    // 评分次数同样保留：再评 3 分 → (5*1+3)/2 = 4
    index.rate('skill-001', 3)
    assert.equal(index.get('skill-001')?.rating, 4)
    assert.equal(index.getMetadata('skill-001', 'rating_count'), '2')
  })
})

test('upsert: 同版本重复上架幂等且不清零统计', async () => {
  await withIndex((index) => {
    index.upsert(makeSkill())
    index.incDownloads('skill-001')
    index.upsert(makeSkill({ price: 990 }))
    const refreshed = index.get('skill-001')
    assert.ok(refreshed)
    assert.equal(refreshed.price, 990)
    assert.equal(refreshed.downloads, 1)
    assert.equal(index.count(), 1)
  })
})

// ---------- sqlite-index：检索 ----------

test('search: keyword 对 name LIKE 且 ASCII 大小写不敏感', async () => {
  await withIndex((index) => {
    index.upsertAll([
      makeSkill({ id: 'a', name: 'Contract-Review' }),
      makeSkill({ id: 'b', name: 'invoice-scanner' }),
    ])
    assert.deepEqual(
      index.search({ keyword: 'contract' }).map((s) => s.id),
      ['a'],
    )
    assert.deepEqual(
      index.search({ keyword: 'CONTRACT' }).map((s) => s.id),
      ['a'],
    )
    assert.deepEqual(index.search({ keyword: 'scan' }).map((s) => s.id), ['b'])
    assert.deepEqual(index.search({ keyword: '绝不命中xyz' }), [])
  })
})

test('search: keyword 中 % _ 按字面量匹配', async () => {
  await withIndex((index) => {
    index.upsertAll([
      makeSkill({ id: 'a', name: 'load-100%cfg' }),
      makeSkill({ id: 'b', name: 'load-200%cfg' }),
      makeSkill({ id: 'c', name: 'wild_card' }),
    ])
    assert.deepEqual(index.search({ keyword: '100%' }).map((s) => s.id), ['a'])
    assert.deepEqual(index.search({ keyword: '_' }).map((s) => s.id), ['c'])
  })
})

test('search: category 精确匹配 + 排序 downloads DESC, rating DESC', async () => {
  await withIndex((index) => {
    index.upsertAll([
      makeSkill({ id: 'low', name: 'doc', category: 'legal', downloads: 10, rating: 4.9 }),
      makeSkill({ id: 'hot', name: 'doc', category: 'legal', downloads: 100, rating: 3.0 }),
      makeSkill({ id: 'tie-a', name: 'doc', category: 'legal', downloads: 100, rating: 4.5 }),
      makeSkill({ id: 'other', name: 'doc', category: 'writing', downloads: 999 }),
    ])
    assert.deepEqual(
      index.search({ category: 'legal' }).map((s) => s.id),
      ['tie-a', 'hot', 'low'], // downloads 同为 100 时 rating 高者在前
    )
  })
})

test('search: minRating 过滤', async () => {
  await withIndex((index) => {
    index.upsertAll([
      makeSkill({ id: 'a', downloads: 30, rating: 4.9 }),
      makeSkill({ id: 'b', downloads: 20, rating: 4.0 }),
      makeSkill({ id: 'c', downloads: 10, rating: 3.99 }),
    ])
    assert.deepEqual(
      index.search({ minRating: 4 }).map((s) => s.id),
      ['a', 'b'],
    )
  })
})

test('search: 组合过滤器 keyword + category + minRating', async () => {
  await withIndex((index) => {
    index.upsertAll([
      makeSkill({ id: 'hit', name: 'contract-review', category: 'legal', downloads: 50, rating: 4.8 }),
      makeSkill({ id: 'wrong-cat', name: 'contract-review', category: 'writing', downloads: 99, rating: 4.9 }),
      makeSkill({ id: 'low-rating', name: 'contract-review', category: 'legal', downloads: 98, rating: 3.0 }),
      makeSkill({ id: 'wrong-name', name: 'invoice', category: 'legal', downloads: 97, rating: 4.9 }),
    ])
    assert.deepEqual(
      index.search({ keyword: 'contract', category: 'legal', minRating: 4 }).map((s) => s.id),
      ['hit'],
    )
  })
})

test('search: 分页 limit/offset 与默认 limit 20', async () => {
  await withIndex((index) => {
    index.upsertAll(
      Array.from({ length: 25 }, (_, i) => makeSkill({ id: `s${String(i).padStart(2, '0')}`, downloads: 25 - i })),
    )
    const all = index.search({ limit: 100 })
    assert.equal(all.length, 25)
    assert.deepEqual(
      index.search({}).map((s) => s.id),
      all.slice(0, 20).map((s) => s.id),
    ) // 默认 limit 20
    assert.deepEqual(
      index.search({ offset: 20 }).map((s) => s.id),
      ['s20', 's21', 's22', 's23', 's24'], // 默认 limit 20 + offset 20 → 剩余 5 条
    )
    assert.equal(index.search({ offset: 20 }).length, 5)
    assert.equal(index.search({ offset: 30 }).length, 0) // 越界 offset → 空
    assert.deepEqual(
      index.search({ limit: 3, offset: 3 }).map((s) => s.id),
      ['s03', 's04', 's05'],
    )
  })
})

test('search: compatDsh 过滤命中 / 不命中，且与分页组合语义正确', async () => {
  await withIndex((index) => {
    index.upsertAll([
      makeSkill({ id: 'old-base', downloads: 100, compat: { dsh: '>=0.1.0-rc.7' } }), // 命中 0.1.5
      makeSkill({ id: 'future', downloads: 200, compat: { dsh: '>=0.2.0' } }), // 不命中 0.1.5
      makeSkill({ id: 'newer-rc', downloads: 50, compat: { dsh: '>=0.1.5-rc.2' } }), // 命中 0.1.5（正式版 > rc）
      makeSkill({ id: 'too-new-rc', downloads: 300, compat: { dsh: '>=0.1.5-rc.2' } }),
    ])
    // 本地 DSH 0.1.5：future（>=0.2.0）被排除，其余按热度排序
    assert.deepEqual(
      index.search({ compatDsh: '0.1.5' }).map((s) => s.id),
      ['too-new-rc', 'old-base', 'newer-rc'],
    )
    // 本地 DSH 0.1.5-rc.1：>=0.1.5-rc.2 的条目也不命中（rc.1 < rc.2）
    assert.deepEqual(
      index.search({ compatDsh: '0.1.5-rc.1' }).map((s) => s.id),
      ['old-base'],
    )
    // compat 过滤后分页：不命中条目不占 offset 名额
    assert.deepEqual(
      index.search({ compatDsh: '0.1.5', limit: 1, offset: 1 }).map((s) => s.id),
      ['old-base'],
    )
    assert.deepEqual(
      index.search({ compatDsh: '0.1.5', limit: 10, offset: 2 }).map((s) => s.id),
      ['newer-rc'],
    )
  })
})

// ---------- sqlite-index：计数与评分 ----------

test('incDownloads: 计数递增；条目不存在抛 SKILL_NOT_FOUND', async () => {
  await withIndex((index) => {
    index.upsert(makeSkill())
    index.incDownloads('skill-001')
    index.incDownloads('skill-001')
    assert.equal(index.get('skill-001')?.downloads, 2)
    assert.throws(
      () => index.incDownloads('nope'),
      (err: unknown) => err instanceof OpcError && err.code === 'SKILL_NOT_FOUND',
    )
  })
})

test('rate: 按评分次数重算平均，四舍五入到两位小数', async () => {
  await withIndex((index) => {
    index.upsert(makeSkill())
    index.rate('skill-001', 5)
    assert.equal(index.get('skill-001')?.rating, 5)
    index.rate('skill-001', 1)
    assert.equal(index.get('skill-001')?.rating, 3) // (5+1)/2
    index.rate('skill-001', 5)
    index.rate('skill-001', 5)
    assert.equal(index.get('skill-001')?.rating, 4) // (5+1+5+5)/4
    index.rate('skill-001', 5)
    index.rate('skill-001', 5)
    assert.equal(index.get('skill-001')?.rating, 4.33) // (5+1+5+5+5+5)/6 = 4.333...
    assert.equal(index.getMetadata('skill-001', 'rating_count'), '6')
    assert.throws(() => index.rate('skill-001', 5.1), RangeError)
    assert.throws(
      () => index.rate('nope', 4),
      (err: unknown) => err instanceof OpcError && err.code === 'SKILL_NOT_FOUND',
    )
  })
})

// ---------- flow：市场安装闭环 ----------

const skillDef: SkillDefinition = {
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

test('installFromMarket: 索引→取包→验签→安装→计数 闭环', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'market-flow-'))
  const index = new SqliteSkillIndex(join(dir, 'index.db'))
  try {
    const { pkg, keys } = createPackage(skillDef, 'author-001')
    index.upsert(makeSkill({ id: skillDef.name, name: skillDef.name, version: skillDef.version }))
    const store: PackageStore = { get: (id) => (id === skillDef.name ? pkg : undefined) }
    let now = 1_750_000_000_000
    const clock = () => now

    const installed = await installFromMarket(
      index,
      store,
      keys.publicKeyPem,
      skillDef.name,
      join(dir, 'skills'),
      clock,
    )
    assert.equal(installed, join(dir, 'skills', skillDef.name))
    assert.deepEqual((await readdir(installed)).sort(), ['manifest.json', 'skill.json'])
    const manifest = JSON.parse(await readFile(join(installed, 'manifest.json'), 'utf8'))
    assert.equal(manifest.skillId, skillDef.name)
    assert.equal(index.get(skillDef.name)?.downloads, 1)
    assert.equal(index.getMetadata(skillDef.name, 'last_installed_at'), '1750000000000')

    // 重复安装：计数累加、安装时间刷新
    now = 1_750_000_001_000
    await installFromMarket(index, store, keys.publicKeyPem, skillDef.name, join(dir, 'skills'), clock)
    assert.equal(index.get(skillDef.name)?.downloads, 2)
    assert.equal(index.getMetadata(skillDef.name, 'last_installed_at'), '1750000001000')
  } finally {
    index.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('installFromMarket: 索引无条目或包缺失 → SKILL_NOT_FOUND', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'market-flow-'))
  const index = new SqliteSkillIndex(join(dir, 'index.db'))
  try {
    const { pkg, keys } = createPackage(skillDef, 'author-001')
    const store: PackageStore = { get: (id) => (id === skillDef.name ? pkg : undefined) }

    // 索引无条目
    await assert.rejects(
      () => installFromMarket(index, store, keys.publicKeyPem, skillDef.name, join(dir, 'skills')),
      (err: unknown) => err instanceof OpcError && err.code === 'SKILL_NOT_FOUND',
    )
    // 索引有条目但包仓库缺失
    index.upsert(makeSkill({ id: skillDef.name, name: skillDef.name, version: skillDef.version }))
    const emptyStore: PackageStore = { get: () => undefined }
    await assert.rejects(
      () => installFromMarket(index, emptyStore, keys.publicKeyPem, skillDef.name, join(dir, 'skills')),
      (err: unknown) => err instanceof OpcError && err.code === 'SKILL_NOT_FOUND',
    )
    assert.equal(index.get(skillDef.name)?.downloads, 0) // 未计数
  } finally {
    index.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('installFromMarket: 验签失败原样抛 SIGNATURE_INVALID，不计数不落盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'market-flow-'))
  const index = new SqliteSkillIndex(join(dir, 'index.db'))
  try {
    const { pkg, keys } = createPackage(skillDef, 'author-001')
    const tampered = { ...pkg, manifest: { ...pkg.manifest, authorId: 'attacker' } }
    index.upsert(makeSkill({ id: skillDef.name, name: skillDef.name, version: skillDef.version }))
    const store: PackageStore = { get: (id) => (id === skillDef.name ? tampered : undefined) }

    await assert.rejects(
      () => installFromMarket(index, store, keys.publicKeyPem, skillDef.name, join(dir, 'skills')),
      (err: unknown) => err instanceof OpcError && err.code === 'SIGNATURE_INVALID',
    )
    assert.equal(index.get(skillDef.name)?.downloads, 0)
    assert.equal(index.getMetadata(skillDef.name, 'last_installed_at'), undefined)
    assert.deepEqual(await readdir(join(dir, 'skills')).catch(() => []), [])
  } finally {
    index.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- 性能基准（AR-P08） ----------

// AR-P08：市场搜索 < 500ms。灌 50,000 条后 keyword + category 检索；
// 本断言即目标值本身（LIKE 为全表扫描、无索引可依赖，50k 行量级余量充足；
// 若 CI 机器明显偏慢可将预算放宽并在此注明）。
const SEARCH_BUDGET_MS = 500
const PERF_ROWS = 50_000

test('AR-P08 基准：50,000 条 keyword+category 检索 < 500ms', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'market-perf-'))
  const index = new SqliteSkillIndex(join(dir, 'skills.db'))
  try {
    const categories = ['legal', 'marketing', 'devops', 'writing', 'data', 'finance', 'design', 'hr', 'sales', 'support']
    const words = ['contract', 'invoice', 'deploy', 'seo', 'pipeline', 'report', 'translate', 'audit', 'onboard', 'schedule']
    index.upsertAll(
      Array.from({ length: PERF_ROWS }, (_, i) =>
        makeSkill({
          id: `skill-${i}`,
          name: `${words[i % words.length]}-automation-${i}`,
          version: '0.1.0',
          category: categories[i % categories.length],
          downloads: i % 1000,
          rating: (i % 50) / 10,
          compat: { dsh: '>=0.1.0-rc.7' },
        }),
      ),
    )
    assert.equal(index.count(), PERF_ROWS)
    // 冷路径校验：无命中查询也要走完整扫描
    assert.equal(index.search({ keyword: '绝不命中xyz', category: 'legal' }).length, 0)

    // 每 10 条 1 条同时命中 keyword+category（共 5,000 条），取默认 limit 20
    const t0 = performance.now()
    const hits = index.search({ keyword: 'contract', category: 'legal' })
    const singleElapsed = performance.now() - t0
    assert.equal(hits.length, 20)
    for (const hit of hits) {
      assert.match(hit.name, /contract/)
      assert.equal(hit.category, 'legal')
    }

    // P95：20 次采样，走完整 search() 路径（含语句 prepare）
    const samples: number[] = []
    for (let i = 0; i < 20; i++) {
      const start = performance.now()
      index.search({ keyword: 'contract', category: 'legal' })
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]

    // 最坏情形：无 category 可走索引、无命中的 keyword → 全表 50k 行 LIKE 扫描
    const t1 = performance.now()
    assert.equal(index.search({ keyword: '绝不命中xyz' }).length, 0)
    const fullScanElapsed = performance.now() - t1

    console.log(
      `[AR-P08] rows=${PERF_ROWS} 单次=${singleElapsed.toFixed(1)}ms p95=${p95.toFixed(1)}ms 全表扫描无命中=${fullScanElapsed.toFixed(1)}ms`,
    )
    assert.ok(singleElapsed < SEARCH_BUDGET_MS, `单次检索 ${singleElapsed.toFixed(1)}ms 超出预算 ${SEARCH_BUDGET_MS}ms`)
    assert.ok(p95 < SEARCH_BUDGET_MS, `P95 ${p95.toFixed(1)}ms 超出预算 ${SEARCH_BUDGET_MS}ms`)
    assert.ok(
      fullScanElapsed < SEARCH_BUDGET_MS,
      `全表扫描 ${fullScanElapsed.toFixed(1)}ms 超出预算 ${SEARCH_BUDGET_MS}ms`,
    )
  } finally {
    index.close()
    await rm(dir, { recursive: true, force: true })
  }
})
