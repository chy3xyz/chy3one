/**
 * OPC-OS 整体系统全链路 Demo（可执行脚本，非测试）。
 *
 * 用真实 cordis 4.x Context 经 loadWithHandshake 装载六个 opc-* 插件
 * （billing / memory / blackboard / skill-forge / team / marketplace），
 * 依次跑通全部业务闭环并输出结构化报告：
 *
 *   a. detectDshRuntime 运行时探测
 *   b. team.formTeam 组队（跨境电商目标 → 4 角色）
 *   c. 黑板协同（orchestrator 写 global 规则 + 4 成员写 workflow 任务）
 *   d. 本能蒸馏（同一工具序列观测 3 次 → 1 个草案）
 *   e. 打包上架（packageDraft 信封 + Ed25519 验签 → SqliteSkillIndex
 *      upsert → compatDsh 语义搜索命中）
 *   f. 交易（下单 990 分 → Mock 微支付 → delivered + 85/15 分成入账；
 *      分账规则以 core/src/marketplace/revenue.ts 源码为准：
 *      platform = floor(990 × 1500 / 10000) = 148，creator = 990 − 148 = 842）
 *   g. RaaS 计费（resolved 一单 → totalRevenue 2.5）
 *   h. 记忆（写 lesson + 关键词检索命中）
 *   i. 埋点（订阅 team / blackboard / skillforge 三条 TelemetryBus，
 *      报告末尾列出事件 type 计数）
 *
 * 任一步抛错只记 {error} 并继续后续步骤（尽量不中断）；全部步骤结束后
 * console.log(JSON 报告) + 每步一行 ✔/✘ 摘要，并以 process.exitCode 反映
 * 失败步数。清理（try/finally）：埋点退订、fiber dispose、SqliteSkillIndex
 * close、tmpdir 删除；进程意外退出时经 'exit' 钩子兜底删 tmpdir。
 *
 * 运行：npm run demo（tsc -p . && node dist/opcos-bundle/src/demo.js）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadWithHandshake, type HandshakeEntry } from './health.js'
import { detectDshRuntime, type TelemetryBus } from '../../dsh-adapter/src/index.js'
import { plugin as billingPlugin } from '../../dsh-plugins/opc-billing/src/index.js'
import { plugin as blackboardPlugin } from '../../dsh-plugins/opc-blackboard/src/index.js'
import { plugin as marketplacePlugin, type PayResult } from '../../dsh-plugins/opc-marketplace/src/index.js'
import { plugin as memoryPlugin } from '../../dsh-plugins/opc-memory/src/index.js'
import { plugin as skillForgePlugin, type SkillForgeService } from '../../dsh-plugins/opc-skill-forge/src/index.js'
import { plugin as teamPlugin, type TeamPlan, type TeamService } from '../../dsh-plugins/opc-team/src/index.js'
import {
  SqliteSkillIndex,
  type BillingEngine,
  type BlackboardEntry,
  type BlackboardScope,
  type BlackboardWrite,
  type MarketSkill,
  type MemoryEntry,
  type MemoryQuery,
  type NewMemoryEntry,
  type OrderEngine,
  type SkillDefinition,
  type ToolObservation,
  type WriteResult,
} from '../../core/src/index.js'
import { createPackage, verifyPackage } from '../../core/src/skill/packager.js'

/* ─────────────── 常量 ─────────────── */

const CREATOR_ID = 'demo-creator'
const BUYER_ID = 'demo-buyer'
const PRICE_CENTS = 990
const GOAL = '帮我做一个跨境电商独立站'
/** 演示用工具序列（3 步）：观测 3 次即满足默认 minRepetitions=3 / minSuccessRate=0.8 */
const TOOL_SEQUENCE = ['web_search', 'fs_read', 'bash_exec']
const TASK_SIGNATURE = 'product-research'
const MARKET_KEYWORD = 'product-research'
/** 本地 DSH 版本（compat.dsh '>=0.1.0-rc.7' 应满足它） */
const DSH_LOCAL_VERSION = '0.1.5'

/* ─────────────── 结构类型 ─────────────── */

/** 真实 cordis 4.x Context 的结构子集（写法对齐 boot.test.ts） */
interface Cordis4ContextLike {
  plugin(p: unknown, ...args: unknown[]): { dispose(): Promise<void> } & PromiseLike<unknown>
  get(name: string, strict?: boolean): unknown
  registry: { delete(plugin: unknown): unknown }
}

/** opc-blackboard 服务视图（插件侧未导出接口，按 core 类型对齐） */
interface BlackboardService {
  read(scope: BlackboardScope, key?: string): BlackboardEntry[]
  write(op: BlackboardWrite): WriteResult
}

/** opc.memory 服务视图（core JsonlMemoryStore 的方法签名） */
interface MemoryService {
  write(entry: NewMemoryEntry): MemoryEntry
  query(criteria: MemoryQuery): MemoryEntry[]
}

/** opc.billing.complete 服务视图 */
type BillingComplete = (event: {
  taskId: string
  agentId: string
  resolution: 'resolved' | 'escalated'
}) => { taskId: string; amount: number }

/** opc.marketplace.pay 服务视图（一站式收单：支付 → 交付 → 分成） */
type MarketplacePay = (orderId: string) => Promise<PayResult>

/** 单个步骤的执行结果（✔/✘ 摘要行与 JSON 报告共用） */
export interface DemoStepOutcome {
  name: string
  ok: boolean
  error?: string
}

/** 各业务步骤收集的结构化结果 */
export interface DemoResults {
  team?: { goal: string; roles: string[]; teamSize: number }
  blackboard?: { globalEntries: number; workflowEntries: number; totalEntries: number }
  instinct?: { observations: number; drafts: number; skillId: string }
  packaging?: {
    envelopeSkillId: string
    envelopeVersion: string
    authorId: string
    signatureVerified: boolean
    publicKeyPem: string
  }
  market?: {
    indexed: number
    keyword: string
    compatDsh: string
    searchHits: number
    hitIds: string[]
  }
  trade?: {
    orderId: string
    skillId: string
    buyerId: string
    status: string
    amount: number
    creatorShare: number
    platformShare: number
    splitConserved: boolean
  }
  billing?: { taskId: string; amount: number; totalRevenue: number }
  memory?: { writtenId: string; category: string; hits: number }
  telemetryTotals?: { totalEvents: number }
}

/** 全链路 Demo 结构化报告（demo.test.ts 断言的对象） */
export interface DemoReport {
  runtime: { apiLevel: string; cordisVersion?: string }
  handshake: {
    degradedBoot: boolean
    allFailed: boolean
    loaded: string[]
    quarantined: string[]
  }
  steps: DemoStepOutcome[]
  /** 失败步数（> 0 时脚本以退出码 1 结束） */
  failures: number
  results: DemoResults
  /** 各埋点总线收到的事件 type 计数：{ team: {...}, blackboard: {...}, skillforge: {...} } */
  telemetry: Record<string, Record<string, number>>
}

/* ─────────────── 辅助 ─────────────── */

/** 运行时解析具名服务，缺前置（Context 未装载）或服务缺失时抛出可读错误 */
function mustGet<T>(ctx: Cordis4ContextLike | undefined, service: string): T {
  if (ctx === undefined) throw new Error('前置失败：cordis Context 未装载（boot 步骤未通过）')
  const impl = ctx.get(service) as T | undefined
  if (impl === undefined) throw new Error(`服务不可用: ${service}（对应插件未装载）`)
  return impl
}

/** 一步业务：抛错记 {error} 继续后续步骤（尽量不中断） */
async function runStep(steps: DemoStepOutcome[], name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    steps.push({ name, ok: true })
  } catch (err) {
    steps.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

/* ─────────────── 主流程 ─────────────── */

/**
 * 跑通 OPC-OS 全链路并返回结构化报告。
 * 同时打印 JSON 报告与每步一行 ✔/✘ 摘要；测试可直接 await main() 断言报告。
 */
export async function main(): Promise<DemoReport> {
  const dir = mkdtempSync(join(tmpdir(), 'opcos-demo-'))
  const cleanupTmpdir = (): void => rmSync(dir, { recursive: true, force: true })
  // 进程退出兜底清理（正常路径在 finally 中 off + rmSync）
  process.on('exit', cleanupTmpdir)

  const steps: DemoStepOutcome[] = []
  const telemetry: Record<string, Record<string, number>> = { team: {}, blackboard: {}, skillforge: {} }
  const report: DemoReport = {
    runtime: { apiLevel: 'unknown' },
    handshake: { degradedBoot: false, allFailed: false, loaded: [], quarantined: [] },
    steps,
    failures: 0,
    results: {},
    telemetry,
  }

  // 跨步骤状态（前置失败时后续步骤以可读错误记 ✘，不中断）
  let ctx: Cordis4ContextLike | undefined
  const disposeFns: Array<() => Promise<void>> = []
  const registryDrops: Array<() => void> = []
  const telemetryUnsubs: Array<() => void> = []
  let index: SqliteSkillIndex | undefined
  let teamPlan: TeamPlan | undefined
  let draft: SkillDefinition | undefined
  let marketSkill: MarketSkill | undefined

  try {
    /* boot：真实 cordis Context + loadWithHandshake 装载六插件 */
    await runStep(steps, 'boot: 真实 cordis Context + loadWithHandshake 装载六插件', async () => {
      const mod = (await import('@deepseek-ai/cordis')) as { Context: new () => Cordis4ContextLike }
      ctx = new mod.Context()
      const pluginEntries: HandshakeEntry[] = [
        {
          plugin: billingPlugin,
          config: { resolvedUnitPrice: 2.5, logFile: join(dir, 'billing-events.jsonl') },
        },
        {
          plugin: memoryPlugin,
          config: {
            memoriesFile: join(dir, 'memories.jsonl'),
            instinctsFile: join(dir, 'instincts.jsonl'),
          },
        },
        { plugin: blackboardPlugin, config: { persistFile: join(dir, 'blackboard.json') } },
        { plugin: skillForgePlugin },
        { plugin: teamPlugin },
        { plugin: marketplacePlugin, config: { currency: 'cents' } },
      ]
      const handshake = await loadWithHandshake(ctx, pluginEntries, {
        quarantineFile: join(dir, 'quarantine.json'),
        markerFile: join(dir, 'boot-marker.json'),
      })
      report.handshake = {
        degradedBoot: handshake.degradedBoot,
        allFailed: handshake.allFailed,
        loaded: handshake.outcomes.filter((o) => o.status === 'loaded').map((o) => o.name),
        quarantined: handshake.outcomes.filter((o) => o.status === 'quarantined').map((o) => o.name),
      }
      // loaded 的 fiber 收集 dispose；quarantined 的 FAILED fiber 经 registry 撤销
      handshake.outcomes.forEach((outcome, i) => {
        if (outcome.status === 'loaded' && outcome.fiber) {
          const fiber = outcome.fiber
          disposeFns.push(() => fiber.dispose())
        } else if (outcome.status === 'quarantined') {
          const failed = pluginEntries[i]?.plugin
          registryDrops.push(() => ctx?.registry.delete(failed))
        }
      })
      assert.equal(report.handshake.loaded.length, 6, '六个插件应全部装载成功')
      assert.equal(report.handshake.quarantined.length, 0, '不应有插件被隔离')
    })

    /* a. 运行时信息 */
    await runStep(steps, 'runtime: detectDshRuntime 运行时探测', () => {
      const info = detectDshRuntime()
      report.runtime = { apiLevel: info.apiLevel, cordisVersion: info.cordisVersion }
      assert.equal(info.apiLevel, 'cordis-4', 'Demo 需要真实 cordis 运行时')
    })

    /* i（前置）：订阅三条埋点总线，业务步骤执行期间收集事件计数 */
    await runStep(steps, 'telemetry: 订阅 team/blackboard/skillforge 三条埋点总线', () => {
      const buses: Array<[service: string, label: string]> = [
        ['opc.team.events', 'team'],
        ['opc.blackboard.events', 'blackboard'],
        ['opc.skillforge.events', 'skillforge'],
      ]
      for (const [service, label] of buses) {
        const bus = mustGet<TelemetryBus>(ctx, service)
        telemetryUnsubs.push(
          bus.subscribe((event) => {
            const counts = telemetry[label]
            counts[event.type] = (counts[event.type] ?? 0) + 1
          }),
        )
      }
    })

    /* b. 组队 */
    await runStep(steps, 'team: formTeam 组队（跨境电商独立站）', () => {
      const team = mustGet<TeamService>(ctx, 'opc.team')
      teamPlan = team.formTeam(GOAL)
      report.results.team = {
        goal: teamPlan.goal,
        roles: [...teamPlan.roles],
        teamSize: teamPlan.teamSize,
      }
      assert.equal(teamPlan.teamSize, 4)
      assert.deepEqual(teamPlan.roles, ['researcher', 'site-builder', 'copywriter', 'marketer'])
    })

    /* c. 黑板：orchestrator 写 global 规则 + 4 个成员各写 workflow 任务 */
    await runStep(steps, 'blackboard: orchestrator 写 global 规则 + 4 成员写 workflow 任务并读回', () => {
      if (teamPlan === undefined) throw new Error('前置失败：team.formTeam 未完成')
      const board = mustGet<BlackboardService>(ctx, 'opc.blackboard')
      const ruleWrite = board.write({
        scope: 'global',
        key: 'brand-voice',
        value: { tone: '专业、克制、可信', language: 'zh-CN' },
        writer: 'orchestrator',
        role: 'orchestrator',
        expectedVersion: 0,
        confidence: 1,
      })
      assert.equal(ruleWrite.status, 'ok')
      const taskTitles = [
        '选品与供应商调研',
        '独立站搭建与支付接入',
        '商品详情页文案撰写',
        '冷启动投放与增长',
      ]
      const workflowWrites = teamPlan.roles.map((role, i) =>
        board.write({
          scope: 'workflow',
          key: `task-${role}`,
          value: { title: taskTitles[i], owner: role, status: 'open' },
          writer: role,
          role: 'agent',
          expectedVersion: 0,
          confidence: 0.8,
        }),
      )
      for (const result of workflowWrites) assert.equal(result.status, 'ok')
      const globalEntries = board.read('global')
      const workflowEntries = board.read('workflow')
      report.results.blackboard = {
        globalEntries: globalEntries.length,
        workflowEntries: workflowEntries.length,
        totalEntries: globalEntries.length + workflowEntries.length,
      }
      assert.equal(globalEntries.length, 1)
      assert.equal(workflowEntries.length, 4)
    })

    /* d. 本能蒸馏：同一工具序列观测 3 次 → listDrafts 应为 1 */
    await runStep(steps, 'skillforge: 同一工具序列观测 3 次蒸馏本能草案', () => {
      const forge = mustGet<SkillForgeService>(ctx, 'opc.skillforge')
      for (let i = 0; i < 3; i++) {
        const observation: ToolObservation = {
          taskSignature: TASK_SIGNATURE,
          tools: [...TOOL_SEQUENCE],
          success: true,
          timestamp: Date.now(),
        }
        forge.observe(observation)
      }
      const drafts = forge.listDrafts()
      draft = drafts[0]
      report.results.instinct = {
        observations: 3,
        drafts: drafts.length,
        skillId: draft?.name ?? '',
      }
      assert.equal(drafts.length, 1, '3 次重复观测应蒸馏出恰好 1 个草案')
    })

    /* e. 打包上架：packageDraft 信封 + Ed25519 验签 + SqliteSkillIndex 上架与搜索 */
    await runStep(steps, 'market: packageDraft 出信封 + 验签 + SqliteSkillIndex 上架与 compat 搜索', () => {
      if (draft === undefined) throw new Error('前置失败：无蒸馏草案')
      const forge = mustGet<SkillForgeService>(ctx, 'opc.skillforge')
      const envelope = forge.packageDraft(draft, CREATOR_ID)
      // packageDraft 只返回 .pkg 信封（不回传密钥）；公钥签名链路用 core
      // packager 另行生成 Ed25519 密钥对验签，证明信封可验证（AR-S05）
      const { pkg, keys } = createPackage(draft, CREATOR_ID)
      const signatureVerified = verifyPackage(pkg, keys.publicKeyPem)
      assert.equal(signatureVerified, true, 'Ed25519 验签应通过')
      const skill: MarketSkill = {
        id: envelope.manifest.skillId,
        name: envelope.manifest.name,
        version: envelope.manifest.version,
        authorId: envelope.manifest.authorId,
        price: PRICE_CENTS,
        category: 'ops',
        downloads: 0,
        rating: 0,
        createdAt: envelope.manifest.createdAt,
        compat: { dsh: '>=0.1.0-rc.7' },
      }
      index = new SqliteSkillIndex(join(dir, 'market.db'))
      index.upsert(skill)
      const hits = index.search({ keyword: MARKET_KEYWORD, compatDsh: DSH_LOCAL_VERSION })
      marketSkill = hits[0]
      report.results.packaging = {
        envelopeSkillId: envelope.manifest.skillId,
        envelopeVersion: envelope.manifest.version,
        authorId: envelope.manifest.authorId,
        signatureVerified,
        publicKeyPem: keys.publicKeyPem,
      }
      report.results.market = {
        indexed: index.count(),
        keyword: MARKET_KEYWORD,
        compatDsh: DSH_LOCAL_VERSION,
        searchHits: hits.length,
        hitIds: hits.map((h) => h.id),
      }
      assert.equal(index.count(), 1)
      assert.equal(hits.length, 1, 'keyword + compatDsh 搜索应命中刚上架的技能')
      assert.equal(hits[0]?.id, skill.id)
      assert.equal(hits[0]?.price, PRICE_CENTS)
    })

    /* f. 交易：下单 990 分 → Mock 微支付 → delivered + 85/15 分成 */
    await runStep(steps, 'marketplace: 下单 990 分 + Mock 微支付 + 分成入账', async () => {
      if (marketSkill === undefined) throw new Error('前置失败：市场条目未上架')
      const orders = mustGet<OrderEngine>(ctx, 'opc.marketplace.orders')
      const pay = mustGet<MarketplacePay>(ctx, 'opc.marketplace.pay')
      const order = orders.createOrder({
        skillId: marketSkill.id,
        version: marketSkill.version,
        buyerId: BUYER_ID,
        amount: marketSkill.price,
        authorId: marketSkill.authorId,
      })
      const { order: delivered, split } = await pay(order.id)
      report.results.trade = {
        orderId: delivered.id,
        skillId: delivered.skillId,
        buyerId: delivered.buyerId,
        status: delivered.status,
        amount: delivered.amount,
        creatorShare: split.creator,
        platformShare: split.platform,
        splitConserved: split.creator + split.platform === delivered.amount,
      }
      assert.equal(delivered.status, 'delivered', '支付后订单应自动交付')
      // 分账规则以 revenue.ts 源码为准：platform = floor(990 × 1500 / 10000) = 148，
      // 余数归创作者 creator = 990 − 148 = 842，恒守恒 creator + platform === 990
      assert.equal(split.platform, 148)
      assert.equal(split.creator, 842)
      assert.equal(split.creator + split.platform, delivered.amount)
    })

    /* g. RaaS 计费：resolved 一单 → totalRevenue 2.5 */
    await runStep(steps, 'billing: RaaS 计费 resolved 一单结算', () => {
      const complete = mustGet<BillingComplete>(ctx, 'opc.billing.complete')
      const engine = mustGet<BillingEngine>(ctx, 'opc.billing')
      const record = complete({ taskId: 'demo-task-001', agentId: 'demo-agent', resolution: 'resolved' })
      const totalRevenue = engine.totalRevenue()
      report.results.billing = { taskId: record.taskId, amount: record.amount, totalRevenue }
      assert.equal(record.amount, 2.5)
      assert.equal(totalRevenue, 2.5)
    })

    /* h. 记忆：写 lesson + query 命中 */
    await runStep(steps, 'memory: 写入 lesson 记忆并检索命中', () => {
      const memory = mustGet<MemoryService>(ctx, 'opc.memory')
      const entry = memory.write({
        scope: 'global',
        category: 'lesson',
        content: '跨境支付网关返回 HTTP 402 时，先幂等重试再升级人工，避免重复扣款',
        confidence: 0.9,
      })
      const hits = memory.query({ keyword: '402', category: 'lesson' })
      report.results.memory = { writtenId: entry.id, category: entry.category, hits: hits.length }
      assert.equal(hits.length, 1)
      assert.equal(hits[0]?.id, entry.id)
    })

    /* i. 埋点汇总：报告末尾列出各总线收到的事件 type 计数 */
    await runStep(steps, 'telemetry: 汇总三条埋点总线事件计数', () => {
      const totalEvents = Object.values(telemetry).reduce(
        (sum, counts) => sum + Object.values(counts).reduce((a, b) => a + b, 0),
        0,
      )
      report.results.telemetryTotals = { totalEvents }
      assert.equal(telemetry.team?.['agent_team_create'] ?? 0, 1)
      assert.equal(telemetry.blackboard?.['blackboard_write'] ?? 0, 5, '1 条 global + 4 条 workflow')
      assert.equal(telemetry.skillforge?.['skill_distill_start'] ?? 0, 1)
      assert.equal(telemetry.skillforge?.['skill_distill_complete'] ?? 0, 1)
      assert.equal(totalEvents, 8)
    })
  } finally {
    // 清理（互不阻断）：退订埋点 → dispose 装载成功的 fiber → 撤销 FAILED
    // fiber → 关闭市场索引 → 摘除退出钩子 → 删除 tmpdir
    for (const off of telemetryUnsubs) {
      try {
        off()
      } catch {
        /* 退订失败不影响其余清理 */
      }
    }
    await Promise.allSettled(disposeFns.map((dispose) => dispose()))
    for (const drop of registryDrops) {
      try {
        drop()
      } catch {
        /* 同上 */
      }
    }
    try {
      index?.close()
    } catch {
      /* 库可能未创建或已关闭 */
    }
    process.off('exit', cleanupTmpdir)
    rmSync(dir, { recursive: true, force: true })
  }

  report.failures = steps.filter((s) => !s.ok).length

  // 输出：结构化 JSON 报告 + 人类可读的步骤摘要（每步一行 ✔/✘）
  console.log('=== OPC-OS 全链路 Demo 结构化报告 ===')
  console.log(JSON.stringify(report, null, 2))
  console.log('=== 步骤摘要 ===')
  for (const step of steps) {
    console.log(`${step.ok ? '✔' : '✘'} ${step.name}${step.ok ? '' : ` — ${step.error ?? 'unknown error'}`}`)
  }
  console.log(`共 ${steps.length} 步，失败 ${report.failures} 步`)

  return report
}

/* ─────────────── 可执行入口 ─────────────── */

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const report = await main()
  process.exitCode = report.failures > 0 ? 1 : 0
}
