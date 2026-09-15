/**
 * Demo 全链路回归：直接 await main() 跑真实 cordis 运行时上的 OPC-OS
 * 业务闭环，断言返回的结构化报告——
 * - steps 全 ✔（failures === 0）；
 * - 六插件经握手全部装载、运行时为 cordis-4；
 * - RaaS 计费 totalRevenue 2.5；
 * - 本能蒸馏 drafts 1；
 * - 市场搜索命中 1；
 * - 分成守恒 creator + platform === 990（分账数值以 revenue.ts 源码为准：
 *   platform = floor(990 × 15%) = 148，creator = 842）；
 * - 三条埋点总线事件计数符合预期。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { main } from './demo.js'

/** 蒸馏草案命名约定：skill-<taskSignature>-<N>steps */
const TASK_SIGNATURE_CHECK = 'product-research'

test('demo: OPC-OS 全链路闭环 — 步骤全 ✔、关键数字与分成守恒', async () => {
  const report = await main()

  // 全部步骤成功
  assert.equal(report.failures, 0, `失败步骤: ${report.steps.filter((s) => !s.ok).map((s) => `${s.name}(${s.error})`).join(', ')}`)
  assert.ok(report.steps.length >= 9, '应至少覆盖任务要求的九类步骤')
  for (const step of report.steps) {
    assert.equal(step.ok, true, `${step.name}: ${step.error ?? 'unknown error'}`)
  }

  // 六插件经真实 cordis 握手全部装载，无隔离、无降级
  assert.equal(report.runtime.apiLevel, 'cordis-4')
  assert.equal(report.handshake.degradedBoot, false)
  assert.equal(report.handshake.allFailed, false)
  assert.deepEqual(report.handshake.quarantined, [])
  assert.deepEqual([...report.handshake.loaded].sort(), [
    'opc-billing',
    'opc-blackboard',
    'opc-marketplace',
    'opc-memory',
    'opc-skill-forge',
    'opc-team',
  ])

  // b. 组队：跨境电商目标 → 4 角色
  assert.equal(report.results.team?.teamSize, 4)
  assert.equal(report.results.team?.roles.length, 4)

  // c. 黑板：1 条 global 规则 + 4 条 workflow 任务
  assert.equal(report.results.blackboard?.globalEntries, 1)
  assert.equal(report.results.blackboard?.workflowEntries, 4)
  assert.equal(report.results.blackboard?.totalEntries, 5)

  // d. 本能蒸馏：3 次观测 → 恰好 1 个草案
  assert.equal(report.results.instinct?.observations, 3)
  assert.equal(report.results.instinct?.drafts, 1)
  assert.ok(report.results.instinct?.skillId.includes(TASK_SIGNATURE_CHECK))

  // e. 打包上架：信封验签通过；索引 1 条且 compat 搜索命中
  assert.equal(report.results.packaging?.signatureVerified, true)
  assert.ok(report.results.packaging?.publicKeyPem.includes('BEGIN PUBLIC KEY'))
  assert.equal(report.results.market?.indexed, 1)
  assert.equal(report.results.market?.searchHits, 1)
  assert.equal(report.results.market?.hitIds.length, 1)

  // f. 交易：delivered + 分成守恒（990 = creator 842 + platform 148）
  const trade = report.results.trade
  assert.equal(trade?.status, 'delivered')
  assert.equal(trade?.buyerId, 'demo-buyer')
  assert.equal(trade?.amount, 990)
  assert.equal(trade?.splitConserved, true)
  assert.equal((trade?.creatorShare ?? 0) + (trade?.platformShare ?? 0), 990)
  assert.equal(trade?.creatorShare, 842, '85% 取整规则以 revenue.ts 源码为准：990 − floor(148.5) = 842')
  assert.equal(trade?.platformShare, 148, '15% 取整规则以 revenue.ts 源码为准：floor(990 × 0.15) = 148')

  // g. RaaS 计费：resolved 一单 → 2.5
  assert.equal(report.results.billing?.amount, 2.5)
  assert.equal(report.results.billing?.totalRevenue, 2.5)

  // h. 记忆：lesson 写入并检索命中
  assert.equal(report.results.memory?.hits, 1)

  // i. 埋点：三条总线的事件 type 计数
  assert.equal(report.telemetry.team?.agent_team_create, 1)
  assert.equal(report.telemetry.blackboard?.blackboard_write, 5)
  assert.equal(report.telemetry.skillforge?.skill_distill_start, 1)
  assert.equal(report.telemetry.skillforge?.skill_distill_complete, 1)
  assert.equal(report.results.telemetryTotals?.totalEvents, 8)
})
