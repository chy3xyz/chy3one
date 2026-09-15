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
  opts: { onReady?: (getService: (name: string) => unknown) => void } = {},
): Promise<{ url: string; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'opcos-console-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const con: RunningConsole = await startConsole({ port: 0, host: '127.0.0.1', dataDir, onReady: opts.onReady })
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
    [
      'opc-billing',
      'opc-blackboard',
      'opc-content',
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

interface IdeaEntry {
  id: string
  scope: string
  category: string
  content: string
  confidence: number
  createdAt: number
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

  const list0 = await getJson<{ ideas: IdeaEntry[] }>(`${url}api/ideas`)
  assert.equal(list0.status, 200)
  assert.deepEqual(list0.body.ideas, [])

  // 校验：text 必须非空（空串与纯空白都拒绝）
  const blank = await postJson<{ error: { code: string } }>(`${url}api/ideas`, { text: '' })
  assert.equal(blank.status, 400)
  assert.equal(blank.body.error.code, 'VALIDATION_ERROR')
  const blankish = await postJson<{ error: { code: string } }>(`${url}api/ideas`, { text: '   ' })
  assert.equal(blankish.status, 400)
  assert.equal(blankish.body.error.code, 'VALIDATION_ERROR')

  // 录入：topic 记忆 / global scope / confidence 0.8 + hint 指引
  const created = await postJson<{ entry: IdeaEntry; hint: string }>(`${url}api/ideas`, { text: '宠物经济测评' })
  assert.equal(created.status, 200)
  assert.equal(created.body.entry.category, 'topic')
  assert.equal(created.body.entry.scope, 'global')
  assert.equal(created.body.entry.confidence, 0.8)
  assert.equal(created.body.entry.content, '宠物经济测评')
  assert.ok(created.body.hint.includes('选题记忆'))

  // 漏斗 ideas 计数 +1；最近创意列表含该文本
  const funnel1 = await getJson<FunnelBody>(`${url}api/funnel`)
  assert.equal(funnel1.body.ideas, 1)
  const list1 = await getJson<{ ideas: IdeaEntry[] }>(`${url}api/ideas`)
  assert.equal(list1.body.ideas.length, 1)
  assert.equal(list1.body.ideas[0]?.content, '宠物经济测评')

  // 再录一条：列表保持时间倒序，计数继续累加
  const second = await postJson<{ entry: IdeaEntry }>(`${url}api/ideas`, { text: '银发经济陪诊师' })
  assert.equal(second.status, 200)
  const list2 = await getJson<{ ideas: IdeaEntry[] }>(`${url}api/ideas`)
  assert.equal(list2.body.ideas.length, 2)
  assert.ok(
    (list2.body.ideas[0]?.createdAt ?? 0) >= (list2.body.ideas[1]?.createdAt ?? 0),
    '最近创意列表应按时间倒序',
  )
  assert.ok(list2.body.ideas.some((e) => e.content === '银发经济陪诊师'))
  const funnel2 = await getJson<FunnelBody>(`${url}api/funnel`)
  assert.equal(funnel2.body.ideas, 2)
})

test('console: 创意变现漏斗全链 —— 创意→内容通路（topic 直连选题）+ run/订单/计费预置后四段计数', async (t) => {
  const { url } = await launch(t)

  // 创意录入 → 内容通路：TemplateTopicStrategy 把 topic 记忆直连为候选
  //（personaScore = 4 + confidence 0.8 = 4.8，高于无人设记忆时的常青库 3.0，必被选中）
  const idea = await postJson<{ entry: IdeaEntry }>(`${url}api/ideas`, { text: '宠物经济测评' })
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
