import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, plugin, type Config, type RoleExecutor, type RoleSpawnResult, type SpawnTeamResult, type TeamPlan, type TeamService, type TeamTemplate } from './index.js'
import { createMockContext, type MockContext, type TelemetryBus, type TelemetryEvent } from '../../../dsh-adapter/src/index.js'
import { InMemoryBlackboard, OpcError } from '../../../core/src/index.js'

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

/* ─────────────── 真实拉起（评估建议 #2）─────────────── */

function setupSpawn(config: Config) {
  const ctx: MockContext = createMockContext()
  apply(ctx, config)
  const events: TelemetryEvent[] = []
  const bus = ctx.getService('opc.team.events') as TelemetryBus
  bus.subscribe((event) => events.push(event))
  const team = ctx.getService('opc.team') as TeamService
  return { ctx, team, events }
}

test('plugin: 默认（不配 spawn）spawnTeam 回退记录式且不触碰执行器（回归）', async () => {
  const { team, events } = setupSpawn({ tokenBudget: 1_000 })
  let calls = 0
  team.setExecutor(async () => {
    calls++
    return { output: '不应被执行' }
  })
  const result = await team.spawnTeam('做一个跨境电商独立站')
  assert.equal(result.mode, 'recorded')
  if (result.mode === 'recorded') {
    assert.equal(result.fallbackReason, 'spawn-off')
    assert.equal(result.plan.teamSize, 4)
  }
  assert.equal(calls, 0, "spawn:'off' 时即使注入了 executor 也不得执行")
  const fallbacks = events.filter((e) => e.type === 'team_spawn_fallback')
  assert.equal(fallbacks.length, 1)
  assert.equal(fallbacks[0].payload!.reason, 'spawn-off')
})

test('plugin: 显式 spawn off 行为与默认一致（回归）', async () => {
  const { team } = setupSpawn({ tokenBudget: 1_000, spawn: 'off' })
  const result = await team.spawnTeam('做自媒体内容账号')
  assert.equal(result.mode, 'recorded')
  if (result.mode === 'recorded') assert.deepEqual(result.plan.roles, ['planner', 'writer', 'reviewer', 'distributor'])
})

test('plugin: spawn auto + 注入 executor：并发拉起 4 角色、产出落黑板、埋点发出', async () => {
  const { team, events } = setupSpawn({ tokenBudget: 1_000, spawn: 'auto' })
  const calls: string[] = []
  let active = 0
  let maxActive = 0
  const executor: RoleExecutor = async (req) => {
    assert.ok(req.task.includes('团队目标：做一个跨境电商独立站'), '角色化 prompt 须含目标')
    assert.ok(req.task.includes(`「${req.role}」`), '角色化 prompt 须含角色职责')
    assert.equal(req.label, `opc-team:${req.role}`)
    calls.push(req.role)
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5)) // 强制时间窗重叠以验证并发
    active--
    return { output: `${req.role} done`, sessionId: `sess-${req.role}` }
  }
  team.setExecutor(executor)
  const board = new InMemoryBlackboard()
  const result = await team.spawnTeam('做一个跨境电商独立站', board)
  assert.equal(result.mode, 'spawned')
  if (result.mode !== 'spawned') return
  assert.deepEqual([...calls].sort(), ['copywriter', 'marketer', 'researcher', 'site-builder'])
  assert.ok(maxActive > 1, `应并发执行（观测峰值 ${maxActive}）`)
  const ok = result.results.filter((r): r is Extract<RoleSpawnResult, { status: 'fulfilled' }> => r.status === 'fulfilled')
  assert.equal(ok.length, 4)
  assert.ok(ok.every((r) => r.output === `${r.role} done` && r.sessionId === `sess-${r.role}` && r.blackboard === 'written'))
  // 黑板：scope 'workflow'，key `task-<role>`，writer 为对应角色代理
  const entries = board.read('workflow')
  assert.deepEqual(entries.map((e) => e.key).sort(), ['task-copywriter', 'task-marketer', 'task-researcher', 'task-site-builder'])
  assert.ok(entries.every((e) => e.writer === `opc-team:${(e.value as { role: string }).role}` && e.role === 'agent'))
  // 埋点：team_spawn_real（真实模式，AS-02：durationMs 可测）
  const reals = events.filter((e) => e.type === 'team_spawn_real')
  assert.equal(reals.length, 1)
  assert.equal(reals[0].payload!.fulfilled, 4)
  assert.equal(reals[0].payload!.rejected, 0)
  assert.equal(reals[0].payload!.team_size, 4)
  const durationMs = reals[0].payload!.durationMs as number
  assert.ok(durationMs >= 0 && durationMs < 30_000, `组建/拉起耗时应可测且 <30s（AS-02）：${durationMs}ms`)
  assert.equal(result.durationMs, durationMs)
})

test('plugin: spawn 部分失败保持 allSettled 语义（1 失败 3 成功 → results 状态正确）', async () => {
  const { team, events } = setupSpawn({ tokenBudget: 1_000, spawn: 'auto' })
  team.setExecutor(async (req) => {
    if (req.role === 'copywriter') throw new Error('copywriter boom')
    return { output: `${req.role} ok` }
  })
  const board = new InMemoryBlackboard()
  const result = await team.spawnTeam('跨境电商', board)
  assert.equal(result.mode, 'spawned')
  if (result.mode !== 'spawned') return
  const rejected = result.results.filter((r): r is Extract<RoleSpawnResult, { status: 'rejected' }> => r.status === 'rejected')
  const fulfilled = result.results.filter((r) => r.status === 'fulfilled')
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].role, 'copywriter')
  assert.equal(rejected[0].reason, 'copywriter boom')
  assert.equal(fulfilled.length, 3)
  // 失败角色不落黑板；成功角色照常落
  const entries = board.read('workflow')
  assert.equal(entries.length, 3)
  assert.ok(!entries.some((e) => e.key === 'task-copywriter'))
  const real = events.find((e) => e.type === 'team_spawn_real')
  assert.equal(real?.payload!.fulfilled, 3)
  assert.equal(real?.payload!.rejected, 1)
})

test('plugin: spawn auto/on 依赖缺失（无 agents 服务）诚实回退 recorded 并留痕', async () => {
  for (const spawn of ['auto', 'on'] as const) {
    const { team, events } = setupSpawn({ tokenBudget: 1_000, spawn })
    const result = (await team.spawnTeam('跨境电商')) as Extract<SpawnTeamResult, { mode: 'recorded' }>
    assert.equal(result.mode, 'recorded')
    assert.equal(result.fallbackReason, 'executor-unavailable')
    const fallbacks = events.filter((e) => e.type === 'team_spawn_fallback')
    assert.equal(fallbacks.length, 1)
    assert.equal(fallbacks[0].payload!.spawn, spawn)
    assert.equal(fallbacks[0].payload!.reason, 'executor-unavailable')
  }
})

test('plugin: spawn on + 注入 executor 走真实路径；setExecutor(undefined) 清除后回退', async () => {
  const { team, events } = setupSpawn({ tokenBudget: 1_000, spawn: 'on' })
  team.setExecutor(async (req) => ({ output: `${req.role} ran` }))
  const spawned = await team.spawnTeam('跨境电商')
  assert.equal(spawned.mode, 'spawned')
  team.setExecutor(undefined)
  const fallback = await team.spawnTeam('跨境电商')
  assert.equal(fallback.mode, 'recorded')
  assert.ok(events.some((e) => e.type === 'team_spawn_real'))
})

test('plugin: spawn 配置非法值拒绝装载（SPAWN_CONFIG_INVALID）', () => {
  const ctx = createMockContext()
  assert.throws(() => apply(ctx, { tokenBudget: 1_000, spawn: 'always' as unknown as Config['spawn'] }), (err: unknown) => {
    assert.ok(err instanceof OpcError)
    assert.equal(err.code, 'SPAWN_CONFIG_INVALID')
    return true
  })
})

test('plugin: 真实 cordis 冒烟 — duck-type agents/sessions 服务 → native 拉起 4 角色', async () => {
  interface CordisContextLike {
    plugin(p: unknown, ...args: unknown[]): { dispose: () => Promise<void> } & PromiseLike<unknown>
    get(name: string, strict?: boolean): unknown
    provide(name: string, value?: unknown): unknown
  }
  const mod = (await import('@deepseek-ai/cordis')) as { Context: new () => CordisContextLike }
  const ctx = new mod.Context()
  const received: Array<{ sessionId: string; text: string }> = []
  const flushed: unknown[] = []
  // duck-type 'agents' 注册表桩：模拟 dsh-headless 的 agents.create 契约
  // （create → {agent{session,followup,whenIdle}, dispose}，会话事件可经 eventAt 读出）
  ctx.provide('agents', {
    create: async (options: { sessionId: string }) => {
      const agentEvents = [
        { type: 'turn/start', data: {} },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `${options.sessionId} 的结论摘要` }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ]
      const agent = {
        session: {
          id: options.sessionId,
          seq: 0,
          eventAt: (seq: number) => agentEvents[seq],
        },
        followup: (message: { content: Array<{ type: string; text?: string }> }) => {
          // 真实会话中 followup 开启 turn 并追加事件：seq 前移
          agent.session.seq = agentEvents.length
          received.push({
            sessionId: options.sessionId,
            text: message.content.find((b) => b.type === 'text')?.text ?? '',
          })
        },
        whenIdle: async () => {},
      }
      return { agent, dispose: async () => {} }
    },
  })
  ctx.provide('sessions', { flush: async (session: unknown) => flushed.push(session) })
  const fiber = ctx.plugin(plugin, { tokenBudget: 1_000, spawn: 'auto' })
  await Promise.resolve(fiber)
  const team = ctx.get('opc.team') as TeamService
  const result = await team.spawnTeam('跨境电商')
  assert.equal(result.mode, 'spawned')
  if (result.mode !== 'spawned') return
  assert.equal(received.length, 4, 'native 执行器应经 followup 投递 4 条角色化消息')
  assert.ok(received.every((m) => m.text.includes('团队目标：跨境电商')))
  assert.equal(flushed.length, 4, 'native 执行器应对每个子会话 flush')
  assert.ok(result.results.every((r) => r.status === 'fulfilled' && r.output.endsWith('结论摘要')))
  assert.ok(result.results.every((r) => r.status !== 'fulfilled' || r.blackboard === 'skipped'), '未提供黑板时产出写入应记 skipped')
  await fiber.dispose()
})
