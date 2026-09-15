/**
 * opcos-console 集成测试（node:test + 全局 fetch）：
 * 真实 cordis 装载 + HTTP 契约验证——健康握手、组队、黑板写读（乐观锁/权限）、
 * 市场搜索命中预置与验签安装、下单→支付→85/15 分成、计费与汇总、记忆写查、
 * 静态资源与 OpcError 错误映射。每个用例独立 tmpdir，t.after 统一 close + 清理。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startConsole, type RunningConsole } from './server.js'

interface HealthBody {
  ok: boolean
  runtime: { apiLevel: string; cordisVersion?: string }
  plugins: Array<{ name: string; ok: boolean }>
  quarantined: string[]
}

interface OverviewBody {
  team: { templates: number }
  blackboard: { global: number; workflow: number }
  market: { skills: number }
  orders: { totalPaid: number; refunded: number; netRevenue: number }
  billing: { revenue: number }
  memory: { count: number }
  telemetry: { recent: Array<{ type: string }> }
}

/** 每用例独立 tmpdir + startConsole({port:0})；t.after 按 LIFO 先 close 再删目录 */
async function launch(t: TestContext): Promise<{ url: string; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'opcos-console-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const con: RunningConsole = await startConsole({ port: 0, host: '127.0.0.1', dataDir })
  t.after(() => con.close())
  return { url: con.url, dataDir }
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url)
  return { status: res.status, body: (await res.json()) as T }
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as T }
}

test('console: /api/health 全插件握手 + /api/overview 聚合 + 静态占位与 404', async (t) => {
  const { url } = await launch(t)

  const health = await getJson<HealthBody>(`${url}api/health`)
  assert.equal(health.status, 200)
  assert.equal(health.body.ok, true)
  assert.equal(health.body.runtime.apiLevel, 'cordis-4')
  assert.deepEqual(
    health.body.plugins.map((p) => p.name).sort(),
    ['opc-billing', 'opc-blackboard', 'opc-marketplace', 'opc-memory', 'opc-skill-forge', 'opc-team'],
  )
  assert.ok(health.body.plugins.every((p) => p.ok))
  assert.deepEqual(health.body.quarantined, [])

  const drafts = await getJson<{ drafts: unknown[] }>(`${url}api/skillforge/drafts`)
  assert.equal(drafts.status, 200)
  assert.deepEqual(drafts.body.drafts, [])

  const overview = await getJson<OverviewBody>(`${url}api/overview`)
  assert.equal(overview.status, 200)
  assert.equal(overview.body.team.templates, 3)
  assert.deepEqual(overview.body.blackboard, { global: 0, workflow: 0 })
  assert.equal(overview.body.market.skills, 3)
  assert.deepEqual(overview.body.orders, { totalPaid: 0, refunded: 0, netRevenue: 0 })
  assert.equal(overview.body.billing.revenue, 0)
  assert.equal(overview.body.memory.count, 0)
  assert.deepEqual(overview.body.telemetry.recent, [])

  // 静态：/ 返回 HTML（源码 static 有 index.html 则真实页，否则内置占位页——宽松断言）
  const home = await fetch(url)
  assert.equal(home.status, 200)
  assert.match(home.headers.get('content-type') ?? '', /^text\/html/)
  const html = await home.text()
  assert.ok(html.includes('<title>') || html.includes('id="app"'))

  const missingApi = await getJson<{ error: { code: string; message: string } }>(`${url}api/no-such-endpoint`)
  assert.equal(missingApi.status, 404)
  assert.equal(missingApi.body.error.code, 'NOT_FOUND')

  const missingFile = await fetch(`${url}definitely-missing.js`)
  assert.equal(missingFile.status, 404)
})

test('console: /api/team 组队与模板；空目标 → 4xx GOAL_PARSE_FAILED；埋点进 overview', async (t) => {
  const { url } = await launch(t)

  const plan = await postJson<{ roles: string[]; teamSize: number; goal: string }>(`${url}api/team`, {
    goal: '跨境电商独立站创业',
  })
  assert.equal(plan.status, 200)
  assert.deepEqual(plan.body.roles, ['researcher', 'site-builder', 'copywriter', 'marketer'])
  assert.equal(plan.body.teamSize, 4)
  assert.equal(plan.body.goal, '跨境电商独立站创业')

  const templates = await getJson<{ templates: Array<{ id: string; roles: string[] }> }>(`${url}api/team/templates`)
  assert.equal(templates.status, 200)
  assert.equal(templates.body.templates.length, 3)
  assert.ok(templates.body.templates.every((tpl) => tpl.roles.length > 0))

  const bad = await postJson<{ error: { code: string } }>(`${url}api/team`, { goal: '' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'GOAL_PARSE_FAILED')

  // 无 body 的 POST：读作空对象 → 同样 GOAL_PARSE_FAILED（OpcError 映射）
  const badNoBody = await fetch(`${url}api/team`, { method: 'POST' })
  assert.equal(badNoBody.status, 400)
  assert.equal(((await badNoBody.json()) as { error: { code: string } }).error.code, 'GOAL_PARSE_FAILED')

  const overview = await getJson<OverviewBody>(`${url}api/overview`)
  assert.ok(overview.body.telemetry.recent.some((e) => e.type === 'agent_team_create'))
})

test('console: /api/blackboard 写读、乐观锁冲突仲裁与 global 权限拒绝', async (t) => {
  const { url } = await launch(t)

  const write = await postJson<{
    status: string
    entry: { key: string; version: number; value: unknown; confidence: number }
  }>(`${url}api/blackboard`, {
    scope: 'workflow',
    key: 'niche',
    value: { topic: 'pet-supplies' },
    writer: 'agent-1',
    role: 'agent',
    expectedVersion: 0,
    confidence: 0.8,
  })
  assert.equal(write.status, 200)
  assert.equal(write.body.status, 'ok')
  assert.equal(write.body.entry.key, 'niche')
  assert.equal(write.body.entry.version, 1)
  assert.deepEqual(write.body.entry.value, { topic: 'pet-supplies' })

  const read = await getJson<{ entries: Array<{ key: string; version: number }> }>(`${url}api/blackboard?scope=workflow`)
  assert.equal(read.status, 200)
  const found = read.body.entries.find((e) => e.key === 'niche')
  assert.ok(found, '写入的条目应可在 workflow scope 读回')
  assert.equal(found.version, 1)

  // 乐观锁：expectedVersion 仍为 0 且挑战者置信度不足 → 冲突并返回当前胜者
  const conflict = await postJson<{ status: string; resolvedBy?: string; winner?: { version: number } }>(
    `${url}api/blackboard`,
    { scope: 'workflow', key: 'niche', value: 'overwrite', writer: 'agent-2', role: 'agent', expectedVersion: 0 },
  )
  assert.equal(conflict.status, 200)
  assert.equal(conflict.body.status, 'conflict')
  assert.equal(conflict.body.resolvedBy, 'timestamp+confidence')
  assert.equal(conflict.body.winner?.version, 1)

  // global scope 仅 orchestrator 可写 → 403 PERMISSION_DENIED
  const denied = await postJson<{ error: { code: string } }>(`${url}api/blackboard`, {
    scope: 'global',
    key: 'roadmap',
    value: 'v1',
    writer: 'agent-1',
    role: 'agent',
    expectedVersion: 0,
  })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED')

  const overview = await getJson<OverviewBody>(`${url}api/overview`)
  assert.equal(overview.body.blackboard.workflow, 1)
  assert.ok(overview.body.telemetry.recent.some((e) => e.type === 'blackboard_write'))
})

test('console: /api/skills 搜索预置 + 验签安装 + 下单→支付→85/15 分成', async (t) => {
  const { url, dataDir } = await launch(t)

  const search = await getJson<{ results: Array<{ id: string; name: string }>; total: number }>(
    `${url}api/skills?q=photo`,
  )
  assert.equal(search.status, 200)
  assert.equal(search.body.total, 1)
  assert.equal(search.body.results[0]?.id, 'photo-studio-pro')

  const all = await getJson<{ results: unknown[]; total: number }>(`${url}api/skills`)
  assert.equal(all.body.total, 3)
  assert.equal(all.body.results.length, 3)

  const byCategory = await getJson<{ results: Array<{ category: string }>; total: number }>(
    `${url}api/skills?category=content`,
  )
  assert.equal(byCategory.body.total, 1)
  assert.equal(byCategory.body.results[0]?.category, 'content')

  const install = await postJson<{ installedPath: string }>(`${url}api/skills/install`, {
    skillId: 'photo-studio-pro',
  })
  assert.equal(install.status, 200)
  assert.ok(install.body.installedPath.startsWith(join(dataDir, 'installed')))
  assert.equal(existsSync(join(install.body.installedPath, 'manifest.json')), true)
  assert.equal(existsSync(join(install.body.installedPath, 'skill.json')), true)
  const manifest = JSON.parse(readFileSync(join(install.body.installedPath, 'manifest.json'), 'utf8')) as {
    skillId: string
  }
  assert.equal(manifest.skillId, 'photo-studio-pro')

  const installMissing = await postJson<{ error: { code: string } }>(`${url}api/skills/install`, {
    skillId: 'no-such-skill',
  })
  assert.equal(installMissing.status, 404)
  assert.equal(installMissing.body.error.code, 'SKILL_NOT_FOUND')

  const order = await postJson<{ id: string; status: string; amount: number; authorId?: string }>(`${url}api/orders`, {
    skillId: 'photo-studio-pro',
    version: '1.2.0',
    buyerId: 'buyer-1',
    amountCents: 1000,
  })
  assert.equal(order.status, 200)
  assert.equal(order.body.status, 'pending')
  assert.equal(order.body.amount, 1000)
  assert.equal(order.body.authorId, 'creator-alice')

  const paid = await postJson<{
    order: { status: string; amount: number }
    split: { creator: number; platform: number; amount: number }
  }>(`${url}api/orders/pay`, { orderId: order.body.id })
  assert.equal(paid.status, 200)
  assert.equal(paid.body.order.status, 'delivered')
  assert.equal(paid.body.split.amount, 1000)
  assert.equal(paid.body.split.creator, 850, '创作者应得 85%')
  assert.equal(paid.body.split.platform, 150, '平台应得 15%')
  assert.equal(paid.body.split.creator + paid.body.split.platform, 1000)

  // 幂等：重复支付返回原分成，不重复入账
  const paidAgain = await postJson<{ split: { creator: number } }>(`${url}api/orders/pay`, {
    orderId: order.body.id,
  })
  assert.equal(paidAgain.status, 200)
  assert.equal(paidAgain.body.split.creator, 850)

  const list = await getJson<{ orders: Array<{ id: string; buyerId: string; status: string }> }>(
    `${url}api/orders?buyerId=buyer-1`,
  )
  assert.equal(list.status, 200)
  assert.equal(list.body.orders.length, 1)
  assert.equal(list.body.orders[0]?.status, 'delivered')

  const payMissing = await postJson<{ error: { code: string } }>(`${url}api/orders/pay`, {
    orderId: '00000000-0000-0000-0000-000000000000',
  })
  assert.equal(payMissing.status, 404)
  assert.equal(payMissing.body.error.code, 'ORDER_NOT_FOUND')

  const overview = await getJson<OverviewBody>(`${url}api/overview`)
  assert.deepEqual(overview.body.orders, { totalPaid: 1, refunded: 0, netRevenue: 1 })
})

test('console: /api/billing 完成计费与汇总、/api/memory 写查', async (t) => {
  const { url } = await launch(t)

  const complete = await postJson<{ taskId: string; agentId: string; resolution: string; amount: number }>(
    `${url}api/billing/complete`,
    { taskId: 'task-77', agentId: 'raas-agent-1', resolution: 'resolved' },
  )
  assert.equal(complete.status, 200)
  assert.equal(complete.body.amount, 2.5)

  const summary = await getJson<{ records: Array<{ taskId: string; amount: number }>; totalRevenue: number }>(
    `${url}api/billing/summary`,
  )
  assert.equal(summary.status, 200)
  assert.equal(summary.body.records.length, 1)
  assert.equal(summary.body.records[0]?.taskId, 'task-77')
  assert.equal(summary.body.totalRevenue, 2.5)

  const invalid = await postJson<{ error: { code: string } }>(`${url}api/billing/complete`, {
    taskId: 'task-78',
    agentId: 'raas-agent-1',
    resolution: 'bogus',
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR')

  const write = await postJson<{ id: string; content: string; category: string }>(`${url}api/memory`, {
    scope: 'workflow',
    category: 'lesson',
    content: '跨境电商选品先算毛利再算流量',
    confidence: 0.9,
  })
  assert.equal(write.status, 200)
  assert.ok(write.body.id.length > 0)
  assert.equal(write.body.category, 'lesson')

  const query = await getJson<{ entries: Array<{ content: string; category: string }> }>(
    `${url}api/memory?q=毛利`,
  )
  assert.equal(query.status, 200)
  assert.equal(query.body.entries.length, 1)
  assert.equal(query.body.entries[0]?.content, '跨境电商选品先算毛利再算流量')

  const byCategory = await getJson<{ entries: Array<{ category: string }> }>(`${url}api/memory?category=fact`)
  assert.equal(byCategory.body.entries.length, 0)

  const badConfidence = await postJson<{ error: { code: string } }>(`${url}api/memory`, {
    scope: 'global',
    category: 'fact',
    content: 'confidence 越界',
    confidence: 1.5,
  })
  assert.equal(badConfidence.status, 400)
  assert.equal(badConfidence.body.error.code, 'VALIDATION_ERROR')

  const overview = await getJson<OverviewBody>(`${url}api/overview`)
  assert.equal(overview.body.memory.count, 1)
  assert.equal(overview.body.billing.revenue, 2.5)
})
