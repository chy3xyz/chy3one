/**
 * opcos-console 集成测试（node:test + 全局 fetch）：
 * 真实 cordis 装载 + HTTP 契约验证——健康握手、组队、黑板写读（乐观锁/权限）、
 * 市场搜索命中预置与验签安装、下单→支付→85/15 分成、计费与汇总、记忆写查、
 * 创意变现漏斗（创意录入 / 四段漏斗聚合 / 创意→内容通路）、
 * 静态资源与 OpcError 错误映射。每个用例独立 tmpdir，t.after 统一 close + 清理。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { request } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
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

/** 每用例独立 tmpdir + startConsole({port:0})；t.after 按 LIFO 先 close 再删目录。
 *  opts.onReady 透传给 startConsole（测试钩子：暴露宿主 getService，用于预置插件内部状态）。 */
async function launch(
  t: TestContext,
  opts: { onReady?: (getService: (name: string) => unknown) => void; authEnabled?: boolean } = {},
): Promise<{ url: string; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'opcos-console-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  // 存量测试默认关鉴权（v1 单用户行为）；authEnabled: true 供多用户鉴权测试显式开启
  const con: RunningConsole = await startConsole({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    onReady: opts.onReady,
    auth: opts.authEnabled === true,
  })
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

async function patchJson<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: 'PATCH',
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
    [
      'opc-billing',
      'opc-blackboard',
      'opc-content',
      'opc-geo-monitor',
      'opc-lifecycle',
      'opc-marketplace',
      'opc-memory',
      'opc-skill-forge',
      'opc-team',
    ],
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

interface CreatorSummary {
  authorId: string
  balance: number
  splits: number
  lastAt: number
}

interface CreatorDetail {
  authorId: string
  balance: number
  entries: Array<{ orderId: string; amount: number; creator: number; platform: number; recordedAt: number }>
}

interface BillBody {
  buyerId: string
  orders: Array<{ id: string; amount: number; status: string }>
  totalSpent: number
  totalSpentYuan: number
}

interface BillsSummaryBody {
  buyers: Array<{ buyerId: string; orders: number; spent: number }>
  totalBuyers: number
  totalOrders: number
  orderNetCount: number
  orderNetAmountCents: number
  raasRevenueYuan: number
  totalRevenueYuan: number
  units: Record<string, string>
}

test('console: SF-07/DE-08 创作者中心与客户账单聚合（/api/creators、/api/bills）', async (t) => {
  const { url } = await launch(t)

  // 预置：下单+支付+分成三笔（alice×2、bruno×1），另留一笔 pending 不入账
  async function buy(skillId: string, version: string, buyerId: string, amountCents: number): Promise<string> {
    const created = await postJson<{ id: string }>(`${url}api/orders`, { skillId, version, buyerId, amountCents })
    assert.equal(created.status, 200)
    const paid = await postJson<{ order: { status: string } }>(`${url}api/orders/pay`, { orderId: created.body.id })
    assert.equal(paid.status, 200)
    assert.equal(paid.body.order.status, 'delivered')
    return created.body.id
  }
  const aliceOrderId = await buy('photo-studio-pro', '1.2.0', 'buyer-1', 1000)
  await buy('photo-studio-pro', '1.2.0', 'buyer-2', 500)
  await buy('seo-copy-toolkit', '0.9.0', 'buyer-1', 590)

  const pending = await postJson<{ id: string }>(`${url}api/orders`, {
    skillId: 'repo-sentinel-ci',
    version: '1.0.0',
    buyerId: 'buyer-2',
    amountCents: 1290,
  })
  assert.equal(pending.status, 200)

  // RaaS：一笔 resolved 计费 2.5（元）
  const complete = await postJson<{ amount: number }>(`${url}api/billing/complete`, {
    taskId: 'task-c1',
    agentId: 'raas-agent-9',
    resolution: 'resolved',
  })
  assert.equal(complete.status, 200)
  assert.equal(complete.body.amount, 2.5)

  // GET /api/creators：按 authorId 聚合（余额 = Σ creator，85%）
  const creators = await getJson<{ creators: CreatorSummary[] }>(`${url}api/creators`)
  assert.equal(creators.status, 200)
  const alice = creators.body.creators.find((c) => c.authorId === 'creator-alice')
  const bruno = creators.body.creators.find((c) => c.authorId === 'creator-bruno')
  assert.ok(alice, 'creator-alice 应出现在聚合中')
  assert.ok(bruno, 'creator-bruno 应出现在聚合中')
  assert.equal(alice.balance, 1275, 'alice 余额 = (1000+500) × 85%')
  assert.equal(alice.splits, 2)
  assert.ok(alice.lastAt > 0)
  assert.equal(bruno.balance, 502, 'bruno 余额 = 590 - floor(590×15%)（余数归创作者）')
  assert.equal(bruno.splits, 1)

  // 未支付订单不入账：仅 pending 时无 cara 流水
  assert.equal(creators.body.creators.some((c) => c.authorId === 'creator-cara'), false)

  // GET /api/creators/:authorId：该作者的分成流水（时间倒序）
  const aliceDetail = await getJson<CreatorDetail>(`${url}api/creators/creator-alice`)
  assert.equal(aliceDetail.status, 200)
  assert.equal(aliceDetail.body.authorId, 'creator-alice')
  assert.equal(aliceDetail.body.balance, 1275)
  assert.equal(aliceDetail.body.entries.length, 2)
  const firstEntry = aliceDetail.body.entries[0]
  assert.ok(firstEntry)
  for (const entry of aliceDetail.body.entries) {
    assert.equal(entry.creator + entry.platform, entry.amount, '85/15 分账守恒')
  }
  assert.ok(
    aliceDetail.body.entries.some((e) => e.orderId === aliceOrderId && e.amount === 1000 && e.creator === 850 && e.platform === 150),
  )

  const nobody = await getJson<CreatorDetail>(`${url}api/creators/creator-nobody`)
  assert.equal(nobody.status, 200)
  assert.deepEqual(nobody.body.entries, [])
  assert.equal(nobody.body.balance, 0)

  // 注册校验：POST /api/creators → 405；参数路由非 GET → 405
  const wrongMethod = await postJson<{ error: { code: string } }>(`${url}api/creators`, {})
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.body.error.code, 'METHOD_NOT_ALLOWED')

  // GET /api/bills?buyerId=：订单笔数与总消费（paid+delivered 口径）
  const bills1 = await getJson<BillBody>(`${url}api/bills?buyerId=buyer-1`)
  assert.equal(bills1.status, 200)
  assert.equal(bills1.body.buyerId, 'buyer-1')
  assert.equal(bills1.body.orders.length, 2)
  assert.equal(bills1.body.totalSpent, 1590)
  assert.equal(bills1.body.totalSpentYuan, 15.9)

  const bills2 = await getJson<BillBody>(`${url}api/bills?buyerId=buyer-2`)
  assert.equal(bills2.status, 200)
  assert.equal(bills2.body.orders.length, 2, 'buyer-2 含一 delivered 一 pending')
  assert.equal(bills2.body.totalSpent, 500, 'pending 的 1290 分不计入总消费')

  const noBuyer = await getJson<{ error: { code: string } }>(`${url}api/bills`)
  assert.equal(noBuyer.status, 400)
  assert.equal(noBuyer.body.error.code, 'VALIDATION_ERROR')

  // GET /api/bills/summary：汇总与口径字段
  const summary = await getJson<BillsSummaryBody>(`${url}api/bills/summary`)
  assert.equal(summary.status, 200)
  assert.equal(summary.body.totalBuyers, 2)
  assert.equal(summary.body.totalOrders, 3, '支付成功口径（stats.totalPaid）')
  assert.equal(summary.body.orderNetCount, 3, 'paid+delivered 笔数（stats.netRevenue）')
  assert.equal(summary.body.orderNetAmountCents, 2090, '订单净额 = 1000+500+590（分）')
  assert.equal(summary.body.raasRevenueYuan, 2.5, 'RaaS 收入（元）')
  assert.equal(summary.body.totalRevenueYuan, 23.4, '总收入 = 订单净额 20.9 元 + RaaS 2.5 元')
  assert.equal(summary.body.units.orderAmounts, 'cents(分)')
  assert.equal(summary.body.units.raasAndTotalRevenue, 'yuan(元)')
  const buyer1Agg = summary.body.buyers.find((b) => b.buyerId === 'buyer-1')
  const buyer2Agg = summary.body.buyers.find((b) => b.buyerId === 'buyer-2')
  assert.ok(buyer1Agg && buyer2Agg, '汇总应含两个已成交买家')
  assert.equal(buyer1Agg.orders, 2)
  assert.equal(buyer1Agg.spent, 1590)
  assert.equal(buyer2Agg.orders, 1, 'pending 单不计入汇总买家笔数')
  assert.equal(buyer2Agg.spent, 500)
})

/* ─────────────── P1：Content Engine / 任务板 / 草案上架 ─────────────── */

interface ContentRunBody {
  brief: { title: string; angle: string; personaScore: number; differentiation?: string[] }
  review: { pass: boolean; score: number; violations: Array<{ type: string; severity: string; detail: string }> }
  publish: { platform: string; url: string; success: boolean }
  rewrites: number
  durationMs: number
  success: boolean
}

test('console: /api/content 流水线运行、stats 与 content_publish 事件环形缓冲', async (t) => {
  const { url } = await launch(t)

  const before = await getJson<{ events: unknown[] }>(`${url}api/content/events`)
  assert.equal(before.status, 200)
  assert.deepEqual(before.body.events, [])

  // 默认模板策略（未配 key）秒级返回
  const run = await postJson<ContentRunBody>(`${url}api/content/run`, {})
  assert.equal(run.status, 200)
  assert.equal(run.body.success, true)
  assert.equal(run.body.publish.success, true)
  assert.match(run.body.publish.url, /^https:\/\/mp\.weixin\.qq\.com\/s\//)
  assert.ok(run.body.brief.title.length > 0)
  assert.ok(run.body.durationMs >= 0)
  assert.equal(run.body.review.pass, true)
  assert.deepEqual(run.body.review.violations, [])

  const stats = await getJson<{ runs: number; mode: { llm: boolean; hotSearch: boolean } }>(
    `${url}api/content/stats`,
  )
  assert.equal(stats.status, 200)
  assert.equal(stats.body.runs, 1)
  assert.equal(typeof stats.body.mode.llm, 'boolean')
  assert.equal(typeof stats.body.mode.hotSearch, 'boolean')

  const events = await getJson<{
    events: Array<{ type: string; timestamp: number; payload: { title?: string; platform?: string } }>
  }>(`${url}api/content/events`)
  assert.equal(events.status, 200)
  assert.equal(events.body.events.length, 1)
  const event = events.body.events[0]
  assert.equal(event?.type, 'content_publish')
  assert.ok(event && event.payload.title && event.payload.title.length > 0)
  assert.equal(event?.payload.platform, 'wechat')
  assert.ok(event && event.timestamp > 0)
})

/* ─────────────── 创意变现漏斗（/api/ideas、/api/funnel） ─────────────── */

interface FunnelBody {
  ideas: number
  contents: { runs: number; published: number }
  skills: { drafts: number; listed: number }
  revenue: { orderNetCount: number; orderNetCents: number; raasRevenueYuan: number }
}

interface IdeaEntity {
  id: string
  name: string
  stage: string
  domains: {
    problem: { summary: string; points: string[] }
    solution: { summary: string; points: string[] }
    spacetime: { summary: string; points: string[] }
  } | null
  createdAt: number
  updatedAt: number
}

test('console: /api/ideas 创意录入 → /api/funnel ideas +1、列表倒序含该文本、空 text 400', async (t) => {
  const { url } = await launch(t)

  // 空库漏斗：四段字段齐全且为基线值（市场预置 3 条示例 Skill）
  const funnel0 = await getJson<FunnelBody>(`${url}api/funnel`)
  assert.equal(funnel0.status, 200)
  assert.equal(funnel0.body.ideas, 0)
  assert.deepEqual(funnel0.body.contents, { runs: 0, published: 0 })
  assert.deepEqual(funnel0.body.skills, { drafts: 0, listed: 3 })
  assert.deepEqual(funnel0.body.revenue, { orderNetCount: 0, orderNetCents: 0, raasRevenueYuan: 0 })

  const list0 = await getJson<{ ideas: IdeaEntity[] }>(`${url}api/ideas`)
  assert.equal(list0.status, 200)
  assert.deepEqual(list0.body.ideas, [])

  // 校验：text 必须非空（空串与纯空白都拒绝）
  const blank = await postJson<{ error: { code: string } }>(`${url}api/ideas`, { text: '' })
  assert.equal(blank.status, 400)
  assert.equal(blank.body.error.code, 'VALIDATION_ERROR')
  const blankish = await postJson<{ error: { code: string } }>(`${url}api/ideas`, { text: '   ' })
  assert.equal(blankish.status, 400)
  assert.equal(blankish.body.error.code, 'VALIDATION_ERROR')

  // 录入：Idea 实体 / description 阶段 / 三域草案（ID-01）+ hint 指引（prd2.md M1）
  const created = await postJson<{ idea: IdeaEntity; hint: string }>(`${url}api/ideas`, { text: '宠物经济测评' })
  assert.equal(created.status, 200)
  assert.match(created.body.idea.id, /^idea-[0-9a-f]{8}$/)
  assert.equal(created.body.idea.stage, 'description')
  assert.equal(created.body.idea.name, '宠物经济测评')
  assert.ok(created.body.idea.domains, '录入应自动生成三域草案')
  assert.ok((created.body.idea.domains?.problem.summary ?? '').length > 0)
  assert.ok(created.body.hint.includes('三域草案'))

  // 漏斗 ideas 计数 +1；最近创意列表含该创意（实体形态）
  const funnel1 = await getJson<FunnelBody>(`${url}api/funnel`)
  assert.equal(funnel1.body.ideas, 1)
  const list1 = await getJson<{ ideas: IdeaEntity[] }>(`${url}api/ideas`)
  assert.equal(list1.body.ideas.length, 1)
  assert.equal(list1.body.ideas[0]?.name, '宠物经济测评')

  // 再录一条：列表保持时间倒序，计数继续累加
  const second = await postJson<{ idea: IdeaEntity }>(`${url}api/ideas`, { text: '银发经济陪诊师' })
  assert.equal(second.status, 200)
  const list2 = await getJson<{ ideas: IdeaEntity[] }>(`${url}api/ideas`)
  assert.equal(list2.body.ideas.length, 2)
  assert.ok(
    (list2.body.ideas[0]?.createdAt ?? 0) >= (list2.body.ideas[1]?.createdAt ?? 0),
    '最近创意列表应按时间倒序',
  )
  assert.ok(list2.body.ideas.some((e) => e.name === '银发经济陪诊师'))
  const funnel2 = await getJson<FunnelBody>(`${url}api/funnel`)
  assert.equal(funnel2.body.ideas, 2)
})

test('console: 创意实体端点（M1）——详情/三域迭代/记忆体检索/挂载隔离/guiding-questions', async (t) => {
  const { url } = await launch(t)

  // 录入两个创意（带解决域/时空域线索，草案应分桶）
  const a = await postJson<{ idea: IdeaEntity }>(`${url}api/ideas`, {
    text: '独立开发者获客难。我们打算做一个AI落地页生成器。面向出海跨境电商市场。',
  })
  const ideaA = a.body.idea
  const b = await postJson<{ idea: IdeaEntity }>(`${url}api/ideas`, { text: '宠物上门喂养平台' })
  const ideaB = b.body.idea

  // 详情：实体 + 目录 + 引导问题（每域 ≥3）+ 记忆体近况 + 挂载态
  const detail = await getJson<{
    idea: IdeaEntity
    home: { root: string; profile: string; ledger: string } | null
    guidingQuestions: Record<string, string[]>
    entries: Array<{ stream: string; content: string; authority: string }>
    mounted: boolean
  }>(`${url}api/ideas/${ideaA.id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.idea.id, ideaA.id)
  assert.ok(detail.body.home?.profile.endsWith('cordis.patch.yml'))
  for (const key of ['problem', 'solution', 'spacetime']) {
    assert.ok((detail.body.guidingQuestions[key] ?? []).length >= 3, `${key} 引导问题不足 3`)
  }
  assert.equal(detail.body.mounted, false)
  assert.equal(detail.body.entries.length, 1, '录入文本应写入 description 流正本')
  assert.equal(detail.body.entries[0]?.stream, 'description')
  assert.equal(detail.body.entries[0]?.authority, 'user')
  assert.ok(detail.body.entries[0]?.content.includes('独立开发者'))
  // 三域草案分桶（ID-01）
  assert.ok(ideaA.domains?.solution.summary.includes('落地页'))
  assert.ok(ideaA.domains?.spacetime.summary.includes('跨境'))

  // 三域迭代（ID-02）：单域更新，其余域保持
  const patched = await patchJson<{ idea: IdeaEntity }>(`${url}api/ideas/${ideaA.id}/domains`, {
    domain: 'solution',
    summary: '对话式配置直接上线的落地页工具',
    points: ['5 分钟上线', '自带 SEO 检查'],
  })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.idea.domains?.solution.summary, '对话式配置直接上线的落地页工具')
  assert.ok(patched.body.idea.domains?.problem.summary.includes('获客难'), '未编辑的域保持原样')

  // 迭代同步写入记忆体正本：description 流新增一条 user 权威条目
  const entries1 = await getJson<{ entries: Array<{ content: string }> }>(
    `${url}api/ideas/${ideaA.id}/entries?q=落地页工具`,
  )
  assert.equal(entries1.body.entries.length, 1)
  assert.ok(entries1.body.entries[0]?.content.includes('三域迭代'))

  // 手动写记忆体 + 检索
  const written = await postJson<{ entry: { id: string } }>(`${url}api/ideas/${ideaA.id}/entries`, {
    stream: 'research',
    content: '竞品分析：现有工具定价偏高',
    confidence: 0.7,
  })
  assert.equal(written.status, 200)
  const research = await getJson<{ entries: Array<{ stream: string }> }>(
    `${url}api/ideas/${ideaA.id}/entries?stream=research`,
  )
  assert.equal(research.body.entries.length, 1)

  // 挂载协议：未挂载时跨创意检索不命中；挂载后命中；卸载后再次隔离
  const mount0 = await getJson<{ mounted: string[]; entries: Array<unknown> }>(
    `${url}api/memory-bodies?q=竞品分析`,
  )
  assert.deepEqual(mount0.body.mounted, [])
  assert.equal(mount0.body.entries.length, 0)
  const mount1 = await postJson<{ mounted: string[] }>(`${url}api/memory-bodies/mount`, {
    ideaIds: [ideaA.id],
  })
  assert.deepEqual(mount1.body.mounted, [ideaA.id])
  const mount2 = await postJson<{ mounted: string[] }>(`${url}api/memory-bodies/mount`, {
    ideaIds: [ideaA.id, ideaB.id],
    action: 'unmount',
  })
  assert.deepEqual(mount2.body.mounted, [], '卸载未挂载的 id 幂等忽略')

  await postJson(`${url}api/memory-bodies/mount`, { ideaIds: [ideaA.id, ideaB.id] })
  const both = await getJson<{ entries: Array<{ ideaId: string }> }>(`${url}api/memory-bodies?q=竞品分析`)
  assert.equal(both.body.entries.length, 1)
  assert.equal(both.body.entries[0]?.ideaId, ideaA.id)

  // 404 语义：不存在的创意 / 未配置流名校验
  const missing = await getJson<{ error: { code: string } }>(`${url}api/ideas/idea-deadbeef`)
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'IDEA_NOT_FOUND')
  const badStream = await postJson<{ error: { code: string } }>(`${url}api/ideas/${ideaA.id}/entries`, {
    stream: 'bogus',
    content: 'x',
    confidence: 0.5,
  })
  assert.equal(badStream.status, 400)

  // 引导问题独立端点（ID-02）
  const gq = await getJson<{ questions: Record<string, string[]> }>(`${url}api/guiding-questions`)
  assert.equal(gq.status, 200)
  assert.ok(gq.body.questions.problem.length >= 3)
})

test('console: 生命周期/MVP/工作区端点（M2）——迁移409、MVP方案正本、Go/No-Go、工作区越界403', async (t) => {
  const { url } = await launch(t)
  const created = await postJson<{ idea: IdeaEntity }>(`${url}api/ideas`, {
    text: 'AI 落地页生成器。打算做一个对话式建站工具。面向出海市场。',
  })
  const idea = created.body.idea
  assert.ok(idea)

  // 阶段迁移：跳跃拒绝（409 STAGE_TRANSITION_INVALID），单步推进成功
  const skip = await postJson<{ error: { code: string } }>(`${url}api/ideas/${idea.id}/transition`, { to: 'asset' })
  assert.equal(skip.status, 409)
  assert.equal(skip.body.error.code, 'STAGE_TRANSITION_INVALID')
  const ok = await postJson<{ idea: IdeaEntity; transition: { from: string; to: string; note: string } }>(
    `${url}api/ideas/${idea.id}/transition`, { to: 'product' },
  )
  assert.equal(ok.status, 200)
  assert.equal(ok.body.idea.stage, 'product')
  assert.equal(ok.body.transition.from, 'description')
  assert.ok(ok.body.transition.note.includes('MVP验证通过'), '默认决策文案来自 prd2.md 3.4')

  // 迁移决策正本已写入 decisions 流
  const detail = await getJson<{ entries: Array<{ stream: string; content: string }> }>(`${url}api/ideas/${idea.id}`)
  const decisions = detail.body.entries.filter((e) => e.stream === 'decisions')
  assert.equal(decisions.length, 1)
  assert.ok(JSON.parse(decisions[0]?.content ?? '{}').kind === 'stage-transition')

  // MVP 方案：三域 → 功能清单/技术栈/开发计划，正本写 decisions（IP-01）
  const plan = await postJson<{ plan: { features: string[]; techStack: string[]; milestones: unknown[] } }>(
    `${url}api/ideas/${idea.id}/mvp/plan`, {},
  )
  assert.equal(plan.status, 200)
  assert.ok(plan.body.plan.features.length > 0)
  assert.ok(plan.body.plan.techStack.length > 0)
  assert.equal(plan.body.plan.milestones.length, 3)

  // Go/No-Go：空记录 no-go；两条高分记录后 go（IP-04）
  const sug0 = await getJson<{ suggestion: { suggestion: string; validations: number } }>(
    `${url}api/ideas/${idea.id}/mvp/suggestion`,
  )
  assert.equal(sug0.body.suggestion.suggestion, 'no-go')
  assert.equal(sug0.body.suggestion.validations, 0)
  const v1 = await postJson<{ record: { kind: string; source: string } }>(`${url}api/ideas/${idea.id}/mvp/validation`, {
    source: 'feedback', content: '内测 12 人，10 人愿意付费', score: 4.5,
  })
  assert.equal(v1.status, 200)
  assert.equal(v1.body.record.kind, 'mvp-validation')
  await postJson(`${url}api/ideas/${idea.id}/mvp/validation`, {
    source: 'metric', content: '落地页转化率 6.2%', score: 4,
  })
  const sug1 = await getJson<{ suggestion: { suggestion: string; validations: number }; validations: unknown[] }>(
    `${url}api/ideas/${idea.id}/mvp/suggestion`,
  )
  assert.equal(sug1.body.suggestion.suggestion, 'go')
  assert.equal(sug1.body.suggestion.validations, 2)
  assert.equal(sug1.body.validations.length, 2)

  // 评分越界 400
  const badScore = await postJson<{ error: { code: string } }>(`${url}api/ideas/${idea.id}/mvp/validation`, {
    source: 'metric', content: 'x', score: 9,
  })
  assert.equal(badScore.status, 400)

  // 工作区（IP-02）：写读列 + 越界 403
  const write = await postJson<{ written: { path: string } }>(`${url}api/ideas/${idea.id}/workspace/file`, {
    path: 'src/main.ts', content: 'console.log("mvp")\n',
  })
  assert.equal(write.status, 200)
  assert.ok(write.body.written.path.includes('workspace'))
  const list = await getJson<{ root: string; files: string[] }>(`${url}api/ideas/${idea.id}/workspace`)
  assert.deepEqual(list.body.files, ['src/main.ts'])
  const read = await getJson<{ content: string }>(
    `${url}api/ideas/${idea.id}/workspace/file?path=${encodeURIComponent('src/main.ts')}`,
  )
  assert.equal(read.body.content, 'console.log("mvp")\n')
  const escape = await postJson<{ error: { code: string } }>(`${url}api/ideas/${idea.id}/workspace/file`, {
    path: '../../escape.txt', content: 'x',
  })
  assert.equal(escape.status, 403)
  assert.equal(escape.body.error.code, 'PERMISSION_DENIED')
  const missing = await getJson<{ error: { code: string } }>(
    `${url}api/ideas/${idea.id}/workspace/file?path=ghost.txt`,
  )
  assert.equal(missing.status, 404)
})

test('console: 内容运营升级（M3）——创意人设 run、多平台分发、GEO 监测', async (t) => {
  const { url } = await launch(t)
  const a = await postJson<{ idea: IdeaEntity }>(`${url}api/ideas`, { text: 'AI 建站工具选购指南' })
  const ideaA = a.body.idea

  // 指定创意 run（CO-02）：选题落题为该创意记忆体中的描述，E-E-A-T 与 Schema 随行
  const run = await postJson<{
    ideaId?: string
    brief: { title: string }
    review: { eeat?: unknown[] }
    content: { schemaJsonLd?: string }
    dispatch?: { dispatches: Array<{ platform: string; result: { success: boolean } }>; success: boolean }
  }>(`${url}api/content/run`, { ideaId: ideaA.id, platforms: ['wechat', 'twitter'] })
  assert.equal(run.status, 200)
  assert.equal(run.body.ideaId, ideaA.id)
  assert.equal(run.body.brief.title, 'AI 建站工具选购指南')
  assert.ok(Array.isArray(run.body.review.eeat), 'E-E-A-T 检查应随审核结果携带')
  assert.ok(run.body.content.schemaJsonLd?.includes('schema.org'), 'Schema 标记随内容生成')
  assert.equal(run.body.dispatch?.dispatches.length, 2)
  assert.equal(run.body.dispatch?.success, true)

  // 缺省全平台（CO-03 五平台矩阵）
  const runAll = await postJson<{ dispatch?: { dispatches: Array<{ platform: string }> } }>(
    `${url}api/content/run`, {},
  )
  assert.equal(runAll.status, 200)
  assert.equal(runAll.body.dispatch?.dispatches.length, 5)

  // platforms 非法值 400
  const badPlatforms = await postJson<{ error: { code: string } }>(`${url}api/content/run`, {
    platforms: ['mastodon'],
  })
  assert.equal(badPlatforms.status, 400)

  // GEO 监测（prd2.md 4.4）：刷新落库 + 写记忆体 analytics 流 + 历史/配置
  const refresh = await postJson<{
    snapshots: Array<{ platform: string; visibility: number }>
    alerts: unknown[]
    simulated: boolean
  }>(`${url}api/ideas/${ideaA.id}/geo/refresh`, {})
  assert.equal(refresh.status, 200)
  assert.equal(refresh.body.snapshots.length, 4, '默认四平台矩阵')
  assert.equal(refresh.body.simulated, true, '模拟口径显式标注')
  const geo = await getJson<{
    history: Array<{ platform: string; ideaId?: string }>
    config: { platforms: string[]; alertThreshold: number }
  }>(`${url}api/ideas/${ideaA.id}/geo`)
  assert.equal(geo.body.history.length, 4)
  assert.equal(geo.body.config.alertThreshold, 0.2)
  const analytics = await getJson<{ entries: Array<{ stream: string; content: string }> }>(
    `${url}api/ideas/${ideaA.id}/entries?stream=analytics`,
  )
  assert.ok(analytics.body.entries.some((e) => e.content.includes('geo-snapshot')), '快照正本写入 analytics 流')
  void ideaA
})

test('console: 产品资产（M4）——.skillpkg 创意归属、订单分成入账、资产账本与 Token 积分', async (t) => {
  let getService: ((name: string) => unknown) | undefined
  const { url } = await launch(t, {
    onReady: (fn) => {
      getService = fn
    },
  })

  // 录入创意 + 蒸馏草案（同签名同工具序列成功 3 次）
  const idea = (await postJson<{ idea: IdeaEntity }>(`${url}api/ideas`, { text: 'GEO 行销自动化创意' })).body.idea
  const forge = getService?.('opc.skillforge') as
    | {
        observe(observation: { taskSignature: string; tools: string[]; success: boolean; timestamp: number }): void
        listDrafts(): Array<{ name: string; version: string }>
      }
    | undefined
  assert.ok(forge)
  for (let i = 0; i < 3; i++) {
    forge.observe({
      taskSignature: 'geo-optimize',
      tools: ['brand_fact_check', 'schema_generator', 'geo_monitor'],
      success: true,
      timestamp: 1_750_000_000_000 + i,
    })
  }

  // 归属创意上架（prd2.md 7.5）：作者记为创意 + .skillpkg 元数据 + 账本 Skill 沉淀
  const published = await postJson<{ skillId: string; authorId: string }>(`${url}api/skills/publish-draft`, {
    ideaId: idea.id,
    stage: 'operation',
    category: 'GEO行销',
  })
  assert.equal(published.status, 200)
  assert.equal(published.body.authorId, idea.id, '作者应为该创意')
  const ledger0 = await getJson<{ ledger: { assets: { skills: Array<{ id: string; status: string }> } } }>(
    `${url}api/ideas/${idea.id}/ledger`,
  )
  assert.equal(ledger0.body.ledger.assets.skills[0]?.id, published.body.skillId)
  assert.equal(ledger0.body.ledger.assets.skills[0]?.status, 'listed')

  // 订单支付：创作者分成（85%）自动入账该创意（prd2.md 5.2 财务收入联动）
  const order = await postJson<{ id: string }>(`${url}api/orders`, {
    skillId: published.body.skillId,
    version: '1.0.0',
    buyerId: 'buyer-m4',
    amountCents: 1000,
  })
  const paid = await postJson<{ creditedIdeaId?: string; split: { creator: number } }>(
    `${url}api/orders/pay`, { orderId: order.body.id },
  )
  assert.equal(paid.status, 200)
  assert.equal(paid.body.creditedIdeaId, idea.id)
  assert.equal(paid.body.split.creator, 850)
  const ledger1 = await getJson<{ ledger: { assets: { finance: { skill_revenue: number; total: number } } } }>(
    `${url}api/ideas/${idea.id}/ledger`,
  )
  assert.equal(ledger1.body.ledger.assets.finance.skill_revenue, 850)

  // 手动记一笔作品收入（/ledger/revenue）
  await postJson(`${url}api/ideas/${idea.id}/ledger/revenue`, { source: 'product', amountCents: 5000 })
  const ledger2 = await getJson<{ ledger: { assets: { finance: { total: number } } } }>(
    `${url}api/ideas/${idea.id}/ledger`,
  )
  assert.equal(ledger2.body.ledger.assets.finance.total, 5850)

  // Token 积分（prd2.md 5.4，R-02 积分定位）：发放 + 配额约束 + 账本镜像
  const grant = await postJson<{ grant: { to: string; amount: number }; stats: { distributed: number } }>(
    `${url}api/ideas/${idea.id}/token/issue`,
    { to: 'user-x', role: 'community', amount: 40_000, reason: 'MVP 测试反馈' },
  )
  assert.equal(grant.status, 200)
  assert.equal(grant.body.grant.amount, 40_000)
  assert.equal(grant.body.stats.distributed, 40_000)
  const badGrant = await postJson<{ error: { code: string } }>(`${url}api/ideas/${idea.id}/token/issue`, {
    to: 'user-y', role: 'community', amount: 999_999, reason: '超配额',
  })
  assert.equal(badGrant.status, 409)
  assert.equal(badGrant.body.error.code, 'TOKEN_ALLOCATION_EXCEEDED')
  const token = await getJson<{ config: { total_supply: number; note?: string }; stats: { holders: number } }>(
    `${url}api/ideas/${idea.id}/token`,
  )
  assert.equal(token.body.config.total_supply, 1_000_000)
  assert.equal(token.body.stats.holders, 1)
  assert.ok(token.body.config.note?.includes('不承诺'))
  // Token 镜像已入资产账本
  const ledger3 = await getJson<{ ledger: { assets: { tokens: { distributed: number } } } }>(
    `${url}api/ideas/${idea.id}/ledger`,
  )
  assert.equal(ledger3.body.ledger.assets.tokens.distributed, 40_000)
})

test('console: 创意版本链与回滚（ID-04）——迭代入链/回滚以新版本入链/404', async (t) => {
  const { url } = await launch(t)
  const idea = (await postJson<{ idea: IdeaEntity }>(`${url}api/ideas`, { text: '版本链测试创意' })).body.idea

  // v1 初始草案
  const v0 = await getJson<{ versions: Array<{ version: number; note: string; domains: ThreeDomainsOf }> }>(
    `${url}api/ideas/${idea.id}/versions`,
  )
  assert.equal(v0.body.versions.length, 1)
  assert.equal(v0.body.versions[0]?.version, 1)
  assert.equal(v0.body.versions[0]?.note, '初始三域草案')

  // 迭代 v2 → 回滚 v1 → 恢复态入链 v3
  await patchJson(`${url}api/ideas/${idea.id}/domains`, {
    domain: 'solution', summary: '迭代后的方案', points: ['要点甲'],
  })
  const rolled = await postJson<{ idea: IdeaEntity; version: { version: number } }>(
    `${url}api/ideas/${idea.id}/rollback`, { version: 1 },
  )
  assert.equal(rolled.status, 200)
  assert.equal(rolled.body.version.version, 3, '恢复态应以新版本 v3 入链')
  assert.notEqual(rolled.body.idea.domains?.solution.summary, '迭代后的方案')

  const v2 = await getJson<{ versions: Array<{ version: number }> }>(`${url}api/ideas/${idea.id}/versions`)
  assert.deepEqual(v2.body.versions.map((v) => v.version), [3, 2, 1])

  // 回滚描述写入 description 流正本
  const entries = await getJson<{ entries: Array<{ content: string }> }>(
    `${url}api/ideas/${idea.id}/entries?q=${encodeURIComponent('三域回滚')}`,
  )
  assert.equal(entries.body.entries.length, 1)

  // 版本不存在 → 404 VERSION_NOT_FOUND；GET versions 不存在的创意 → 404
  const missing = await postJson<{ error: { code: string } }>(`${url}api/ideas/${idea.id}/rollback`, { version: 99 })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'VERSION_NOT_FOUND')
  const none = await getJson<{ error: { code: string } }>(`${url}api/versions-x/${idea.id}`)
  assert.equal(none.status, 404)
})

type ThreeDomainsOf = IdeaEntity['domains']

test('console: 订阅续费语义（SM-04）——支付激活/续费顺延/权益检查', async (t) => {
  let getService: ((name: string) => unknown) | undefined
  const { url } = await launch(t, {
    onReady: (fn) => {
      getService = fn
    },
  })
  const forge = getService?.('opc.skillforge') as
    | {
        observe(observation: { taskSignature: string; tools: string[]; success: boolean; timestamp: number }): void
        listDrafts(): Array<{ name: string; version: string }>
      }
    | undefined
  assert.ok(forge)
  for (let i = 0; i < 3; i++) {
    forge.observe({
      taskSignature: 'sub-skill',
      tools: ['extract', 'format', 'deliver'],
      success: true,
      timestamp: 1_750_000_000_000 + i,
    })
  }

  // 以订阅定价上架（monthly）
  const published = await postJson<{ skillId: string; pricing: { model: string; period?: string } }>(
    `${url}api/skills/publish-draft`, { pricingModel: 'subscription', period: 'monthly' },
  )
  assert.equal(published.status, 200)
  assert.equal(published.body.pricing.model, 'subscription')
  assert.equal(published.body.pricing.period, 'monthly')
  const skillId = published.body.skillId

  // 首订：支付后激活权益
  const order1 = await postJson<{ id: string }>(`${url}api/orders`, {
    skillId, version: '1.0.0', buyerId: 'buyer-sub', amountCents: 990,
  })
  const pay1 = await postJson<{ subscription?: { expiresAt: number; activeHint?: boolean } }>(
    `${url}api/orders/pay`, { orderId: order1.body.id },
  )
  assert.equal(pay1.status, 200)
  assert.ok(pay1.body.subscription, '订阅技能支付应激活权益')
  const expiry1 = pay1.body.subscription!.expiresAt

  // 权益检查：订阅期内 active
  const status1 = await getJson<{ active: boolean; subscription?: { expiresAt: number } }>(
    `${url}api/subscriptions/status?buyerId=buyer-sub&skillId=${skillId}`,
  )
  assert.equal(status1.body.active, true)
  assert.equal(status1.body.subscription?.expiresAt, expiry1)

  // 续订：第二次支付从到期时间顺延（真时钟下同周期内续订 → expiresAt 严格增长）
  const order2 = await postJson<{ id: string }>(`${url}api/orders`, {
    skillId, version: '1.0.0', buyerId: 'buyer-sub', amountCents: 990,
  })
  const pay2 = await postJson<{ subscription?: { expiresAt: number } }>(
    `${url}api/orders/pay`, { orderId: order2.body.id },
  )
  assert.equal(pay2.status, 200)
  assert.ok(pay2.body.subscription)
  const expiry2 = pay2.body.subscription!.expiresAt
  assert.equal(expiry2, expiry1 + 30 * 86_400_000, '活跃期内续订应从到期时间顺延一个周期')

  // 买家订阅清单
  const list = await getJson<{ subscriptions: Array<{ skillId: string; active: boolean }> }>(
    `${url}api/subscriptions?buyerId=buyer-sub`,
  )
  assert.equal(list.body.subscriptions.filter((s) => s.skillId === skillId).length, 2)
  // 一次性定价技能支付不产生订阅
  const oneTime = await postJson<{ subscription?: unknown }>(`${url}api/skills/publish-draft`, {})
  assert.equal(oneTime.status, 200)
  void oneTime
})

test('console: 多用户鉴权与团队协作——注册/登录/越权 403/团队可见性/关注防冒名', async (t) => {
  const { url } = await launch(t, { authEnabled: true })
  const jar: Record<string, string> = {}

  /** 带 Cookie jar 的请求（两个用户各自的会话互不干扰） */
  const authedFetch = async (
    as: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(jar[as] ? { cookie: jar[as] } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) jar[as] = setCookie.split(';')[0] ?? jar[as] ?? ''
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      /* 空响应 */
    }
    return { status: res.status, body: parsed }
  }

  // 未登录访问受保护端点 → 401
  const anon = await authedFetch('anon', 'GET', 'api/ideas')
  assert.equal(anon.status, 401)
  assert.equal(anon.body.error.code, 'UNAUTHORIZED')
  // 健康探针保持公开
  assert.equal((await authedFetch('anon', 'GET', 'api/health')).status, 200)
  // me 探针：未登录 200 + user null
  assert.equal((await authedFetch('anon', 'GET', 'api/auth/me')).body.user, null)

  // 注册两个创意者（注册即登录）
  const reg1 = await authedFetch('alice', 'POST', 'api/auth/register', {
    username: 'alice', password: 'secret123', displayName: '爱丽丝',
  })
  assert.equal(reg1.status, 200)
  assert.equal(reg1.body.user.username, 'alice')
  const reg2 = await authedFetch('bob', 'POST', 'api/auth/register', {
    username: 'bob', password: 'secret456',
  })
  assert.equal(reg2.status, 200)

  // 重复用户名 409；错误密码 401
  assert.equal((await authedFetch('anon', 'POST', 'api/auth/register', { username: 'alice', password: 'secret123' })).status, 409)
  assert.equal((await authedFetch('anon', 'POST', 'api/auth/login', { username: 'alice', password: 'wrong!' })).status, 401)

  // alice 创建私有创意；bob 看不到、改不了
  const ideaA = await authedFetch('alice', 'POST', 'api/ideas', { text: '爱丽丝的跨境选品创意' })
  assert.equal(ideaA.status, 200)
  assert.equal(ideaA.body.idea.ownerId, reg1.body.user.id)
  const bobList = await authedFetch('bob', 'GET', 'api/ideas')
  assert.equal(bobList.body.ideas.some((i: { id: string }) => i.id === ideaA.body.idea.id), false, '他人私有创意不可见')
  const bobPatch = await authedFetch('bob', 'PATCH', `api/ideas/${ideaA.body.idea.id}/domains`, {
    domain: 'problem', summary: '越权篡改',
  })
  assert.equal(bobPatch.status, 403)
  assert.equal(bobPatch.body.error.code, 'PERMISSION_DENIED')

  // 团队协作：alice 建队邀请 bob；bob 创建团队创意 → 双方可见
  const team = await authedFetch('alice', 'POST', 'api/teams', { name: '出海小分队' })
  assert.equal(team.status, 200)
  const invite = await authedFetch('alice', 'POST', `api/teams/${team.body.team.id}/members`, { username: 'bob' })
  assert.equal(invite.status, 200)
  // bob 邀自己进队 → 仅 owner 可操作 403
  assert.equal(
    (await authedFetch('bob', 'POST', `api/teams/${team.body.team.id}/members`, { username: 'bob' })).status,
    403,
  )
  const teamIdea = await authedFetch('alice', 'POST', 'api/ideas', {
    text: '团队共研的选品工具创意', teamId: team.body.team.id,
  })
  assert.equal(teamIdea.status, 200)
  assert.equal(teamIdea.body.idea.teamId, team.body.team.id)
  // bob 在团队详情可见队友 + 团队创意
  const bobTeams = await authedFetch('bob', 'GET', 'api/teams')
  assert.ok(bobTeams.body.teams.some((x: { id: string }) => x.id === team.body.team.id))
  const bobList2 = await authedFetch('bob', 'GET', 'api/ideas')
  assert.ok(bobList2.body.ideas.some((i: { id: string }) => i.id === teamIdea.body.idea.id), '团队成员应可见团队创意')
  // bob 可写团队创意（三域迭代）
  assert.equal(
    (await authedFetch('bob', 'PATCH', `api/ideas/${teamIdea.body.idea.id}/domains`, {
      domain: 'solution', summary: 'bob 补充的方案',
    })).status,
    200,
  )

  // 登录：登出后再访问 401，重新登录恢复
  await authedFetch('alice', 'POST', 'api/auth/logout', {})
  assert.equal((await authedFetch('alice', 'GET', 'api/ideas')).status, 401)
  const relogin = await authedFetch('alice', 'POST', 'api/auth/login', { username: 'alice', password: 'secret123' })
  assert.equal(relogin.status, 200)
  assert.equal((await authedFetch('alice', 'GET', 'api/auth/me')).body.user.username, 'alice')

  // 市场关注防冒名：登录态下 follower 强制为当前用户
  await authedFetch('alice', 'POST', `api/ideas/${teamIdea.body.idea.id}/publish`, {})
  const follow = await authedFetch('alice', 'POST', `api/market/ideas/${teamIdea.body.idea.id}/follow`, {
    follower: 'someone-else',
  })
  assert.equal(follow.body.follower, 'alice', '登录态下 follower 应强制为当前用户')
  // 我的关注反查
  const follows = await authedFetch('alice', 'GET', 'api/market/follows')
  assert.ok(follows.body.ideas.some((i: { ideaId: string }) => i.ideaId === teamIdea.body.idea.id))

  // 用户中心：改昵称 + 改密（改密后全端下线，新密码重登）
  const renamed = await authedFetch('alice', 'POST', 'api/auth/profile', { displayName: '爱丽丝二世' })
  assert.equal(renamed.body.user.displayName, '爱丽丝二世')
  const pwdChange = await authedFetch('alice', 'POST', 'api/auth/password', {
    oldPassword: 'wrong-old', newPassword: 'new789xyz',
  })
  assert.equal(pwdChange.status, 401, '旧密码错误应拒绝')
  const pwdOk = await authedFetch('alice', 'POST', 'api/auth/password', {
    oldPassword: 'secret123', newPassword: 'new789xyz',
  })
  assert.equal(pwdOk.status, 200)
  assert.equal((await authedFetch('alice', 'GET', 'api/auth/me')).body.user, null, '改密后全会话失效')
  const relogin2 = await authedFetch('alice', 'POST', 'api/auth/login', { username: 'alice', password: 'new789xyz' })
  assert.equal(relogin2.status, 200)
  assert.equal((await authedFetch('alice', 'POST', 'api/auth/login', { username: 'alice', password: 'secret123' })).status, 401)
})

test('console: 创意市场与技能市场 v2（M5）——发布/关联/关注通知/排行/协同/阶段过滤/定价/安装到创意', async (t) => {
  let getService: ((name: string) => unknown) | undefined
  const { url } = await launch(t, {
    onReady: (fn) => {
      getService = fn
    },
  })
  const forge = getService?.('opc.skillforge') as
    | {
        observe(observation: { taskSignature: string; tools: string[]; success: boolean; timestamp: number }): void
        listDrafts(): Array<{ name: string; version: string }>
      }
    | undefined
  assert.ok(forge)

  // 三个创意：互补对（A 选品问题 × B 选品工具方案）+ 相似对素材（获客问题，不发布）
  const a = (await postJson<{ idea: IdeaEntity }>(`${url}api/ideas`, {
    text: '电商卖家选品难，缺少选品数据工具',
  })).body.idea
  const b = (await postJson<{ idea: IdeaEntity }>(`${url}api/ideas`, {
    text: '帮卖家更好的卖货。我们打算做一个电商选品数据工具。',
  })).body.idea
  await postJson(`${url}api/ideas`, { text: '小团队获客难，获客渠道又贵又少' })

  // 发布到市场（ID-05/IM-01）：发布即检索到，互补/相似关联自动发现（IM-03）
  const pub = await postJson<{ summary: { ideaId: string }; relations: Array<{ type: string; b: string }> }>(
    `${url}api/ideas/${a.id}/publish`, {},
  )
  assert.equal(pub.status, 200)
  await postJson(`${url}api/ideas/${b.id}/publish`, {})
  const listed = await getJson<{ ideas: Array<{ ideaId: string }> }>(`${url}api/market/ideas`)
  assert.equal(listed.body.ideas.length, 2)
  const search = await getJson<{ ideas: Array<{ ideaId: string }> }>(`${url}api/market/ideas?q=${encodeURIComponent('卖货')}`)
  assert.equal(search.body.ideas.length, 1)
  assert.equal(search.body.ideas[0]?.ideaId, b.id)

  // 互补关联双向可查
  const relA = await getJson<{ relations: Array<{ type: string; b: string }> }>(`${url}api/market/ideas/${a.id}`)
  assert.ok(relA.body.relations.some((r) => r.type === 'complementary' && r.b === b.id))

  // 关注 + 阶段变更通知（IM-02）
  await postJson(`${url}api/market/ideas/${a.id}/follow`, { follower: 'user-1' })
  await postJson(`${url}api/ideas/${a.id}/transition`, { to: 'product' })
  const notif = await getJson<{ notifications: Array<{ message: string }> }>(`${url}api/notifications?follower=user-1`)
  assert.equal(notif.body.notifications.length, 1)
  assert.ok(notif.body.notifications[0]?.message.includes('product'))

  // 排行（IM-06）
  const rankings = await getJson<{ assets: unknown[]; community: Array<{ ideaId: string; followers: number }>; geo: unknown[] }>(
    `${url}api/market/rankings`,
  )
  assert.equal(rankings.body.community[0]?.ideaId, a.id, '被关注的创意应在社区活跃榜第一')

  // 协同（IM-04）：贡献记录 + collaborator 池 Token 发放（默认 权重×100）
  const collab = await postJson<{ record: { tokensGranted: number }; grant: { role: string } }>(
    `${url}api/ideas/${b.id}/collab`,
    { userId: 'user-y', role: 'developer', contribution: 'MVP 代码贡献' },
  )
  assert.equal(collab.status, 200)
  assert.equal(collab.body.record.tokensGranted, 2000)
  assert.equal(collab.body.grant.role, 'collaborator')

  // 技能市场 v2：蒸馏草案 → 归属创意 + stage 元数据上架（SM-01/SM-03）
  for (let i = 0; i < 3; i++) {
    forge.observe({
      taskSignature: 'geo-optimize',
      tools: ['brand_fact_check', 'schema_generator', 'geo_monitor'],
      success: true,
      timestamp: 1_750_000_000_000 + i,
    })
  }
  const pub1 = await postJson<{ skillId: string; pricing: { model: string } }>(`${url}api/skills/publish-draft`, {
    ideaId: b.id, stage: 'operation', category: 'GEO行销',
  })
  assert.equal(pub1.status, 200)
  assert.equal(pub1.body.pricing.model, 'one_time', '缺省定价模型为一次性')
  const skillId = pub1.body.skillId

  const byStage = await getJson<{ results: Array<{ id: string }> }>(`${url}api/skills?stage=operation`)
  assert.ok(byStage.body.results.some((s) => s.id === skillId), 'SM-01：阶段过滤命中上架技能')
  assert.equal((await getJson<{ results: unknown[] }>(`${url}api/skills?stage=description`)).body.results.length, 0)

  // SM-04：一次性定价 → 正常下单；免费技能 → 下单拒绝、直接安装（安装到创意，SM-02）
  const order = await postJson<{ id: string }>(`${url}api/orders`, {
    skillId, version: '1.0.0', buyerId: 'buyer-m5', amountCents: 990,
  })
  assert.equal(order.status, 200)
  await postJson(`${url}api/skills/publish-draft`, { pricingModel: 'free' })
  const freeOrder = await postJson<{ error: { code: string } }>(`${url}api/orders`, {
    skillId, version: '1.0.0', buyerId: 'buyer-m5', amountCents: 1,
  })
  assert.equal(freeOrder.status, 400)
  const installed = await postJson<{ installedPath: string; ideaId?: string }>(`${url}api/skills/install`, {
    skillId, ideaId: b.id,
  })
  assert.equal(installed.status, 200)
  assert.ok(installed.body.installedPath.includes(b.id), 'SM-02：应落盘该创意目录 skills/')
  assert.equal(installed.body.ideaId, b.id)

  // SM-04 订阅权益安装守卫：再次以订阅定价上架 → 未订阅安装 402，订阅后放行；
  // GET /api/skills/:id 暴露定价模型与阶段元数据
  await postJson(`${url}api/skills/publish-draft`, { pricingModel: 'subscription', period: 'monthly' })
  const detail = await getJson<{ pricing: { model: string; period?: string }; meta: { stage?: string; idea_id?: string } }>(
    `${url}api/skills/${skillId}`,
  )
  assert.equal(detail.body.pricing.model, 'subscription')
  assert.equal(detail.body.pricing.period, 'monthly')
  assert.equal(detail.body.meta.stage, 'operation')
  const denied = await postJson<{ error: { code: string } }>(`${url}api/skills/install`, {
    skillId, buyerId: 'buyer-no-sub',
  })
  assert.equal(denied.status, 402)
  assert.equal(denied.body.error.code, 'SUBSCRIPTION_REQUIRED')
  const subOrder = await postJson<{ id: string }>(`${url}api/orders`, {
    skillId, version: '1.0.0', buyerId: 'buyer-no-sub', amountCents: 990,
  })
  await postJson(`${url}api/orders/pay`, { orderId: subOrder.body.id })
  const allowed = await postJson<{ installedPath: string }>(`${url}api/skills/install`, {
    skillId, buyerId: 'buyer-no-sub',
  })
  assert.equal(allowed.status, 200, '有效订阅应放行安装')
})

test('console: 创意变现漏斗全链 —— 创意→内容通路（topic 直连选题）+ run/订单/计费预置后四段计数', async (t) => {
  const { url } = await launch(t)

  // 创意录入 → 内容通路：TemplateTopicStrategy 把 topic 记忆直连为候选
  //（personaScore = 4 + confidence 0.8 = 4.8，高于无人设记忆时的常青库 3.0，必被选中）
  const idea = await postJson<{ idea: IdeaEntity }>(`${url}api/ideas`, { text: '宠物经济测评' })
  assert.equal(idea.status, 200)

  const run = await postJson<ContentRunBody>(`${url}api/content/run`, {})
  assert.equal(run.status, 200)
  assert.equal(run.body.success, true)
  // 落题断言：录入的创意原文成为被选中的候选标题（模板/LLM 模式均成立——LLM 模式
  // 落题同样取人设分最高的输入候选，即记忆直连那条）
  assert.equal(run.body.brief.title, '宠物经济测评', '选题应落题为录入的创意（topic 记忆直连候选）')
  const runStats = await getJson<{ runs: number; mode: { llm: boolean } }>(`${url}api/content/stats`)
  assert.equal(runStats.body.runs, 1)
  if (!runStats.body.mode.llm) {
    // 模板模式的直连签名：角度固定携带创意原文「围绕进行中选题「<text>」做深度展开…」
    assert.ok(run.body.brief.angle.includes('宠物经济测评'), '模板模式下选题角度应包含创意原文')
  }

  // 段4 预置：一笔 delivered 订单 + 一笔 RaaS 计费
  const order = await postJson<{ id: string; status: string }>(`${url}api/orders`, {
    skillId: 'photo-studio-pro',
    version: '1.2.0',
    buyerId: 'buyer-1',
    amountCents: 1000,
  })
  assert.equal(order.status, 200)
  const paid = await postJson<{ order: { status: string } }>(`${url}api/orders/pay`, { orderId: order.body.id })
  assert.equal(paid.body.order.status, 'delivered')
  const complete = await postJson<{ amount: number }>(`${url}api/billing/complete`, {
    taskId: 'task-funnel',
    agentId: 'raas-agent-1',
    resolution: 'resolved',
  })
  assert.equal(complete.body.amount, 2.5)

  // 全漏斗一次请求返回：四段计数与预置一一对应
  const funnel = await getJson<FunnelBody>(`${url}api/funnel`)
  assert.equal(funnel.status, 200)
  assert.equal(funnel.body.ideas, 1)
  assert.equal(funnel.body.contents.runs, 1)
  assert.equal(funnel.body.contents.published, 1, 'published = contentEvents 环形缓冲中 content_publish 计数')
  assert.ok(funnel.body.skills.listed >= 3, '在售 Skill ≥ 预置 3 条示例')
  assert.equal(funnel.body.skills.drafts, 0)
  assert.equal(funnel.body.revenue.orderNetCount, 1, 'paid+delivered 笔数（stats.netRevenue 口径）')
  assert.equal(funnel.body.revenue.orderNetCents, 1000, '订单净额（分）')
  assert.equal(funnel.body.revenue.raasRevenueYuan, 2.5, 'RaaS 计费收入（元）')

  // 交叉验证：漏斗收入段与 /api/bills/summary 复用同一 orderNetAggregates 口径，数字一致
  const summary = await getJson<BillsSummaryBody>(`${url}api/bills/summary`)
  assert.equal(summary.body.orderNetAmountCents, funnel.body.revenue.orderNetCents)
  assert.equal(summary.body.raasRevenueYuan, funnel.body.revenue.raasRevenueYuan)
})

interface TaskBody {
  id: string
  title: string
  status: string
  claimedBy?: string
  result?: string
  version: number
}

test('console: /api/board 生命周期（add→claim→complete）+ 乐观锁 409 快照 + 越权 403', async (t) => {
  const { url } = await launch(t)

  const board0 = await getJson<{ tasks: TaskBody[]; stats: Record<string, number> }>(`${url}api/board`)
  assert.equal(board0.status, 200)
  assert.deepEqual(board0.body.tasks, [])
  assert.deepEqual(board0.body.stats, { total: 0, pending: 0, claimed: 0, done: 0, blocked: 0 })

  const invalid = await postJson<{ error: { code: string } }>(`${url}api/board/add`, { title: '' })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR')

  const added = await postJson<TaskBody>(`${url}api/board/add`, { title: '写周报' })
  assert.equal(added.status, 200)
  assert.equal(added.body.status, 'pending')
  assert.equal(added.body.version, 1)
  const taskId = added.body.id

  // 过期 expectedVersion 认领 → 409 VERSION_CONFLICT + current 任务快照
  const conflict = await postJson<{ error: { code: string; current: TaskBody | null } }>(`${url}api/board/claim`, {
    taskId,
    member: 'op',
    expectedVersion: 99,
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error.code, 'VERSION_CONFLICT')
  assert.equal(conflict.body.error.current?.version, 1)
  assert.equal(conflict.body.error.current?.status, 'pending')

  // 正常认领：pending → claimed（claimedBy 记录成员，版本 +1）
  const claimed = await postJson<TaskBody>(`${url}api/board/claim`, { taskId, member: 'op', expectedVersion: 1 })
  assert.equal(claimed.status, 200)
  assert.equal(claimed.body.status, 'claimed')
  assert.equal(claimed.body.claimedBy, 'op')
  assert.equal(claimed.body.version, 2)

  // 他人代完成 → 403 PERMISSION_DENIED
  const denied = await postJson<{ error: { code: string } }>(`${url}api/board/complete`, {
    taskId,
    member: 'alice',
    result: '抢答',
    expectedVersion: 2,
  })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED')

  // 认领者本人完成：claimed → done（结果入库，版本 +1）
  const done = await postJson<TaskBody>(`${url}api/board/complete`, {
    taskId,
    member: 'op',
    result: '周报已发',
    expectedVersion: 2,
  })
  assert.equal(done.status, 200)
  assert.equal(done.body.status, 'done')
  assert.equal(done.body.result, '周报已发')
  assert.equal(done.body.version, 3)

  // 不存在的任务 → 404 TASK_NOT_FOUND
  const missing = await postJson<{ error: { code: string } }>(`${url}api/board/claim`, {
    taskId: '00000000-0000-0000-0000-000000000000',
    member: 'op',
    expectedVersion: 1,
  })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'TASK_NOT_FOUND')

  const board1 = await getJson<{ tasks: TaskBody[]; stats: Record<string, number> }>(`${url}api/board`)
  assert.equal(board1.body.tasks.length, 1)
  assert.equal(board1.body.tasks[0]?.status, 'done')
  assert.deepEqual(board1.body.stats, { total: 1, pending: 0, claimed: 0, done: 1, blocked: 0 })
})

test('console: /api/skills/publish-draft 草案上架 + 无草案 409 NO_DRAFTS', async (t) => {
  let getService: ((name: string) => unknown) | undefined
  const { url } = await launch(t, {
    onReady: (fn) => {
      getService = fn
    },
  })

  // 库空无草案 → 409 NO_DRAFTS
  const none = await postJson<{ error: { code: string } }>(`${url}api/skills/publish-draft`, {})
  assert.equal(none.status, 409)
  assert.equal(none.body.error.code, 'NO_DRAFTS')

  // 预置：同一任务签名 + 同一工具序列成功观测 3 次（默认 minRepetitions=3）→ high 置信度蒸馏草案
  const forge = getService?.('opc.skillforge') as
    | {
        observe(observation: { taskSignature: string; tools: string[]; success: boolean; timestamp: number }): void
        listDrafts(): Array<{ name: string; version: string }>
      }
    | undefined
  assert.ok(forge, 'onReady 钩子应暴露宿主 opc.skillforge 服务')
  for (let i = 0; i < 3; i++) {
    forge.observe({
      taskSignature: 'weekly-report',
      tools: ['outline', 'draft', 'export'],
      success: true,
      timestamp: 1_750_000_000_000 + i,
    })
  }
  const drafts = forge.listDrafts()
  assert.equal(drafts.length, 1)
  const draftName = drafts[0]?.name
  assert.equal(draftName, 'skill-weekly-report-3steps')

  const published = await postJson<{
    skillId: string
    name: string
    version: string
    authorId: string
    category: string
    price: number
    publicKeyPem: string
  }>(`${url}api/skills/publish-draft`, {})
  assert.equal(published.status, 200)
  assert.equal(published.body.skillId, 'skill-weekly-report-3steps')
  assert.equal(published.body.name, 'skill-weekly-report-3steps')
  assert.equal(published.body.authorId, 'console-creator', '缺省 authorId 落 console-creator')
  assert.ok(published.body.publicKeyPem.includes('BEGIN PUBLIC KEY'), '应返回本次签名的 Ed25519 公钥')

  // 市场索引可搜到：community 分类 / 990 分 / compat 基线
  const search = await getJson<{
    total: number
    results: Array<{ id: string; category: string; price: number; compat: { dsh: string } }>
  }>(`${url}api/skills?q=weekly-report`)
  assert.equal(search.status, 200)
  assert.equal(search.body.total, 1)
  const entry = search.body.results[0]
  assert.equal(entry?.id, 'skill-weekly-report-3steps')
  assert.equal(entry?.category, 'community')
  assert.equal(entry?.price, 990)
  assert.equal(entry?.compat.dsh, '>=0.1.0-rc.7')

  // 自定义 authorId 透传（重复上架为幂等 upsert）
  const republished = await postJson<{ skillId: string; authorId: string }>(`${url}api/skills/publish-draft`, {
    authorId: 'creator-zed',
  })
  assert.equal(republished.status, 200)
  assert.equal(republished.body.authorId, 'creator-zed')
})

/* ─────────────── P2：gzip 压缩（>1KB JSON / 静态文本，按 accept-encoding） ─────────────── */

/** 裸 node:http 请求：精确控制 accept-encoding（undici fetch 默认附带 gzip，无法测 identity 路径） */
function rawRequest(
  target: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolveReq, rejectReq) => {
    const req = request(target, { method: opts.method ?? 'GET', headers: opts.headers ?? {} }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolveReq({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      })
    })
    req.on('error', rejectReq)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

test('console: gzip —— >1KB JSON 与静态文本压缩（解压后内容一致），identity 客户端不受影响', async (t) => {
  const { url } = await launch(t)

  // /api/team 回显 goal：长目标（含“电商”关键词命中解析规则）→ 响应 > 2KB
  const goal = `跨境电商独立站创业：选品、流量与转化细节。`.repeat(60)

  // 接受 gzip 的客户端：content-encoding: gzip + vary: Accept-Encoding，解压后内容一致
  const gzipped = await rawRequest(`${url}api/team`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' },
    body: JSON.stringify({ goal }),
  })
  assert.equal(gzipped.status, 200)
  assert.equal(gzipped.headers['content-encoding'], 'gzip')
  assert.equal(gzipped.headers['vary'], 'Accept-Encoding')
  const inflated = JSON.parse(gunzipSync(gzipped.body).toString('utf8')) as { goal: string }
  assert.equal(inflated.goal, goal, 'gzip 解压后内容与原 JSON 一致')

  // identity 客户端：不压缩、原文可达（vary 仍在——响应随 accept-encoding 变化）
  const identity = await rawRequest(`${url}api/team`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' },
    body: JSON.stringify({ goal }),
  })
  assert.equal(identity.status, 200)
  assert.equal(identity.headers['content-encoding'], undefined)
  assert.equal((JSON.parse(identity.body.toString('utf8')) as { goal: string }).goal, goal)

  // 小响应（<1KB 阈值）不压缩
  const small = await rawRequest(`${url}api/health`, { headers: { 'accept-encoding': 'gzip' } })
  assert.equal(small.status, 200)
  assert.equal(small.headers['content-encoding'], undefined)

  // 静态文本：app.js（数十 KB）接受 gzip 时压缩，解压后为前端源码
  const appGz = await rawRequest(`${url}app.js`, { headers: { 'accept-encoding': 'gzip' } })
  assert.equal(appGz.status, 200)
  assert.equal(appGz.headers['content-encoding'], 'gzip')
  assert.match(String(appGz.headers['content-type']), /^text\/javascript/)
  assert.ok(gunzipSync(appGz.body).toString('utf8').includes('ROUTE_NAMES'))
  const appPlain = await rawRequest(`${url}app.js`, { headers: { 'accept-encoding': 'identity' } })
  assert.equal(appPlain.headers['content-encoding'], undefined)
  assert.ok(appPlain.body.toString('utf8').includes('ROUTE_NAMES'))
})
