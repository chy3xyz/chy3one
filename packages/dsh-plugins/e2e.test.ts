/**
 * 四插件业务 E2E（US-02 场景："跨境电商创业团队"全链路）：
 * 组队 → 黑板协作 → 工具观测蒸馏 Skill → RaaS 计费结算 → 记忆沉淀 → 统一卸载。
 * 基于稳定 OpcContext（mock），真实 cordis 装载语义由 cordis-runtime.test.ts 覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMockContext, type TelemetryBus, type TelemetryEvent } from '../dsh-adapter/src/index.js'
import { apply as applyBilling } from './opc-billing/src/index.js'
import { apply as applyMemory } from './opc-memory/src/index.js'
import { apply as applyBlackboard } from './opc-blackboard/src/index.js'
import { apply as applySkillForge } from './opc-skill-forge/src/index.js'
import { apply as applyTeam } from './opc-team/src/index.js'

test('e2e: 跨境电商团队全链路（US-02 / AC-01 / AC-03 / AC-05 / AC-07）', () => {
  const ctx = createMockContext()
  const telemetry: TelemetryEvent[] = []

  applyTeam(ctx, { tokenBudget: 100_000 })
  applyBlackboard(ctx, {}) // 纯内存（不配置 persistFile）
  applyMemory(ctx, {}) // 纯内存
  applySkillForge(ctx, { minRepetitions: 3, minSuccessRate: 0.8 })
  applyBilling(ctx, { resolvedUnitPrice: 2.5 })

  // 埋点订阅（PRD 7.5 / TD-04：三插件统一以 '<name>.events' 服务暴露 TelemetryBus）
  for (const serviceName of ['opc.team.events', 'opc.blackboard.events', 'opc.skillforge.events']) {
    ctx.getService<TelemetryBus>(serviceName)!.subscribe((event) => telemetry.push(event))
  }

  // 1. 组队（AS-01/AS-02）
  const team = ctx.getService<{
    formTeam(goal: string): { roles: string[]; teamSize: number }
    recordUsage(member: string, tokens: number): void
  }>('opc.team')!
  const plan = team.formTeam('帮我做一个跨境电商独立站')
  assert.deepEqual(plan.roles, ['researcher', 'site-builder', 'copywriter', 'marketer'])

  // 2. 黑板协作：Orchestrator 写全局规则，成员认领任务（AC-03）
  const bb = ctx.getService<{
    read(scope: 'global' | 'workflow', key?: string): Array<{ key: string; version: number }>
    write(op: Record<string, unknown>): { status: string }
  }>('opc.blackboard')!
  bb.write({ scope: 'global', key: 'rules', value: { currency: 'USD' }, writer: 'orch', role: 'orchestrator', expectedVersion: 0 })
  let version = 0
  for (const member of plan.roles) {
    const r = bb.write({ scope: 'workflow', key: `task-${member}`, value: { owner: member }, writer: member, role: 'agent', expectedVersion: 0 })
    assert.equal(r.status, 'ok')
    version++
  }
  assert.equal(bb.read('workflow').length, version)
  assert.throws(() => bb.write({ scope: 'global', key: 'rules', value: 1, writer: 'm', role: 'agent', expectedVersion: 0 }))

  // 3. 工具观测×3 → 自动蒸馏 Skill 草案（AC-01 / SF-02）
  const forge = ctx.getService<{ observe(ob: { taskSignature: string; tools: string[]; success: boolean }): void; listDrafts(): unknown[] }>('opc.skillforge')!
  for (let i = 0; i < 3; i++) {
    forge.observe({ taskSignature: 'product-listing', tools: ['scraper', 'translator', 'lister'], success: true })
  }
  assert.equal(forge.listDrafts().length, 1)

  // 4. RaaS 计费：埋点→结算（DE-06/DE-07 / AC-05）
  ctx.dispatch('agent/pre-step', { taskId: 'order-001', messages: [], turn: 1 })
  ctx.dispatch('agent/request', { taskId: 'order-001', provider: 'deepseek', model: 'chat', usage: { prompt: 900, completion: 100 } })
  const complete = ctx.getService<(e: { taskId: string; agentId: string; resolution: 'resolved' }) => { amount: number }>('opc.billing.complete')!
  assert.equal(complete({ taskId: 'order-001', agentId: 'cs-acme', resolution: 'resolved' }).amount, 2.5)
  const engine = ctx.getService<{ totalRevenue(): number }>('opc.billing')!
  assert.equal(engine.totalRevenue(), 2.5)

  // 5. 记忆沉淀（lesson）与检索（AC-04 基础）
  const memory = ctx.getService<{ write(e: Record<string, unknown>): unknown; query(c: Record<string, unknown>): Array<{ content: string }> }>('opc.memory')!
  memory.write({ scope: 'global', category: 'lesson', content: 'listing 标题需含品牌词', confidence: 0.9 })
  assert.equal(memory.query({ keyword: '品牌' }).length, 1)

  // 6. 埋点完整性
  const types = telemetry.map((e) => e.type)
  assert.ok(types.includes('agent_team_create'))
  assert.ok(types.includes('blackboard_write'))
  assert.ok(types.includes('skill_distill_start'))
  assert.ok(types.includes('skill_distill_complete'))

  // 7. 统一卸载：全部服务撤销（AC-07）
  ctx.unload()
  assert.equal(ctx.getService('opc.team'), undefined)
  assert.equal(ctx.getService('opc.blackboard'), undefined)
  assert.equal(ctx.getService('opc.billing'), undefined)
  assert.equal(team.recordUsage('researcher', 1) === undefined, true) // 记账函数仍可用但团队服务已注销
})
