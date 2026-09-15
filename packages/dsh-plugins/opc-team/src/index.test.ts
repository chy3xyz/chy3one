import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, plugin, type TeamPlan, type TeamService, type TeamTemplate } from './index.js'
import { createMockContext, type MockContext, type TelemetryBus, type TelemetryEvent } from '../../../dsh-adapter/src/index.js'
import { OpcError } from '../../../core/src/index.js'

function setup(budget = 1_000_000) {
  const ctx: MockContext = createMockContext()
  apply(ctx, { tokenBudget: budget })
  const events: TelemetryEvent[] = []
  const bus = ctx.getService('opc.team.events') as TelemetryBus
  bus.subscribe((event) => events.push(event))
  const team = ctx.getService('opc.team') as TeamService
  return { ctx, team, events, bus }
}

test('plugin: 电商/跨境目标解析出正确角色 (AS-01)', () => {
  const { team } = setup()
  const plan = team.formTeam('做一个跨境电商独立站卖宠物用品')
  assert.deepEqual(plan.roles, ['researcher', 'site-builder', 'copywriter', 'marketer'])
  assert.equal(plan.teamSize, 4)
  assert.equal(plan.goal, '做一个跨境电商独立站卖宠物用品')
  assert.ok(Number.isFinite(plan.createdAt))
})

test('plugin: 内容/自媒体目标解析出内容团队角色 (AS-01)', () => {
  const { team } = setup()
  const plan = team.formTeam('做自媒体内容账号')
  assert.deepEqual(plan.roles, ['planner', 'writer', 'reviewer', 'distributor'])
  assert.equal(plan.teamSize, 4)
})

test('plugin: 解析失败抛 GOAL_PARSE_FAILED 并可取 fallback 模板 (PRD 6.2.3)', () => {
  const { team } = setup()
  assert.throws(() => team.formTeam('完全无法识别的 xyzzy 目标'), (err: unknown) => {
    assert.ok(err instanceof OpcError)
    assert.equal(err.code, 'GOAL_PARSE_FAILED')
    return true
  })
  const templates = team.fallbackTemplates() as TeamTemplate[]
  assert.ok(templates.length >= 2)
  assert.ok(templates.some((t) => t.id === 'cross-border-ecommerce' && t.roles.length === 4))
})

test('plugin: 团队组建即时返回（同步路径，AS-02 组建时间 < 30s）', () => {
  const { team } = setup()
  const start = Date.now()
  const plan: TeamPlan = team.formTeam('跨境电商')
  const elapsed = Date.now() - start
  assert.ok(elapsed < 30_000, `组建耗时 ${elapsed}ms 应远小于 30s（同步路径应 < 1s）`)
  assert.ok(plan.createdAt >= start)
})

test('plugin: token 80% 阈值告警 (PRD 6.2.3)', () => {
  const { team, events } = setup(1_000)
  team.recordUsage('researcher', 790)
  team.recordUsage('site-builder', 20) // 累计 810 ≥ 80%
  const warns = events.filter((e) => e.type === 'token_budget_warn')
  assert.equal(warns.length, 1)
  assert.equal((warns[0].payload!.ratio as number) >= 0.8, true)
  // 未达 100%，不拦截
  team.recordUsage('copywriter', 50)
  assert.equal(team.usage(), 860)
})

test('plugin: token 100% 超支拦截抛 TOKEN_BUDGET_EXCEEDED (PRD 6.2.3)', () => {
  const { team, events } = setup(1_000)
  team.recordUsage('researcher', 1_000)
  assert.throws(() => team.recordUsage('site-builder', 1), (err: unknown) => {
    assert.ok(err instanceof OpcError)
    assert.equal(err.code, 'TOKEN_BUDGET_EXCEEDED')
    return true
  })
  assert.ok(events.some((e) => e.type === 'token_budget_exceeded'))
})

test('plugin: formTeam 触发 agent_team_create 埋点（含 team_size/roles/goal）', () => {
  const { team, events } = setup()
  team.formTeam('跨境电商创业')
  const create = events.filter((e) => e.type === 'agent_team_create')
  assert.equal(create.length, 1)
  assert.equal(create[0].payload!.team_size, 4)
  assert.deepEqual(create[0].payload!.roles, ['researcher', 'site-builder', 'copywriter', 'marketer'])
  assert.equal(create[0].payload!.goal, '跨境电商创业')
  assert.ok(Number.isFinite(create[0].timestamp))
})

test('plugin: 退订后不再收到埋点（TD-04 统一 subscribe 约定）', () => {
  const { team, bus } = setup()
  const received: TelemetryEvent[] = []
  const unsubscribe = bus.subscribe((event) => received.push(event))
  unsubscribe()
  team.formTeam('跨境电商独立站')
  assert.equal(received.length, 0)
})

test('plugin: team/spawn 事件拉起成员（mock 仅记录）', () => {
  const { ctx } = setup()
  // 插件注册了 team/spawn 监听；mock 场景下 dispatch 不抛错即视为记录路径可用
  const result = ctx.dispatch('team/spawn', { member: 'alice', role: 'researcher' })
  assert.deepEqual(result, { member: 'alice', role: 'researcher' })
})

test('plugin: 卸载时清理副作用', () => {
  const { ctx, team } = setup(1_000)
  team.recordUsage('researcher', 500)
  ctx.unload() // LIFO 逆序执行清理：用量与告警标记一并复位（events 服务由宿主撤销）
  assert.equal(team.usage(), 0)
})

test('plugin: name 导出为 opc-team', () => {
  assert.equal(name, 'opc-team')
  assert.equal(plugin.name, 'opc-team') // cordis Plugin.Function 元数据
  assert.deepEqual(plugin.inject, [])
})
