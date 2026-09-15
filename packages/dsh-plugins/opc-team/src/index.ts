import { OpcError } from '../../../core/src/index.js'
import { createTelemetryBus, defineOpcPlugin, type OpcContext } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-team'

export interface Config {
  tokenBudget: number
}

/** 团队角色标识（对应 dsh-team 拉起的命名队友） */
export type TeamRole =
  | 'researcher'
  | 'site-builder'
  | 'copywriter'
  | 'marketer'
  | 'planner'
  | 'writer'
  | 'reviewer'
  | 'distributor'

export interface TeamPlan {
  /** 推荐角色列表（顺序即分工链路） */
  roles: TeamRole[]
  teamSize: number
  createdAt: number
  goal: string
}

export interface TeamTemplate {
  id: string
  label: string
  roles: TeamRole[]
}

/** 目标关键词 → 角色映射表（AS-01：解析准确率 ≥ 85% 的内置规则基线） */
const GOAL_ROLE_RULES: Array<{ pattern: RegExp; roles: TeamRole[]; templateId: string }> = [
  { pattern: /电商|跨境|独立站/u, roles: ['researcher', 'site-builder', 'copywriter', 'marketer'], templateId: 'cross-border-ecommerce' },
  { pattern: /内容|自媒体/u, roles: ['planner', 'writer', 'reviewer', 'distributor'], templateId: 'content-creator' },
]

/** 可手动选择的降级模板（PRD 6.2.3：目标解析失败 → 手动选择角色模板） */
const FALLBACK_TEMPLATES: TeamTemplate[] = [
  { id: 'cross-border-ecommerce', label: '跨境电商创业团队', roles: ['researcher', 'site-builder', 'copywriter', 'marketer'] },
  { id: 'content-creator', label: '内容自媒体团队', roles: ['planner', 'writer', 'reviewer', 'distributor'] },
  { id: 'indie-hacker', label: '独立开发者团队', roles: ['researcher', 'site-builder', 'marketer'] },
]

export interface TeamService {
  formTeam(goal: string): TeamPlan
  fallbackTemplates(): TeamTemplate[]
  recordUsage(member: string, tokens: number): void
  /** 测试/观测用：当前累计 token 消耗 */
  usage(): number
}

export function apply(ctx: OpcContext, config: Config) {
  const tokenBudget = config.tokenBudget > 0 ? config.tokenBudget : 1_000_000
  let usedTokens = 0
  let budgetWarned = false
  /** 已拉起的团队成员（mock：仅记录，不真实 spawn） */
  const spawnedMembers: Array<{ member: string; role: TeamRole; spawnedAt: number }> = []

  // 埋点总线（TD-04：统一 TelemetryBus 订阅约定），事件 type 与载荷保持原约定
  const events = createTelemetryBus()
  const emitTeamEvent = (type: string, payload: Record<string, unknown>) => {
    events.emit({ type, payload, timestamp: Date.now() })
  }
  ctx.provideService('opc.team.events', events)

  const service: TeamService = {
    formTeam(goal: string): TeamPlan {
      if (typeof goal !== 'string' || goal.trim().length === 0) {
        throw new OpcError('GOAL_PARSE_FAILED', `无法解析创业目标: ${JSON.stringify(goal)}`)
      }
      const rule = GOAL_ROLE_RULES.find((r) => r.pattern.test(goal))
      if (!rule) {
        throw new OpcError('GOAL_PARSE_FAILED', `无法识别目标关键词，可改用 fallbackTemplates() 手动选择: ${goal}`)
      }
      const plan: TeamPlan = {
        roles: [...rule.roles],
        teamSize: rule.roles.length,
        createdAt: Date.now(),
        goal,
      }
      // 埋点：agent_team_create（PRD 数据事件表：team_size, roles, goal）
      emitTeamEvent('agent_team_create', { team_size: plan.teamSize, roles: plan.roles, goal })
      return plan
    },

    fallbackTemplates(): TeamTemplate[] {
      return FALLBACK_TEMPLATES.map((t) => ({ ...t, roles: [...t.roles] }))
    },

    recordUsage(member: string, tokens: number): void {
      if (usedTokens + tokens > tokenBudget) {
        // PRD 6.2.3：Token 消耗超预算 → 超支拦截（100%，严格超额才拦截，本次用量不记录）
        emitTeamEvent('token_budget_exceeded', { used: usedTokens, budget: tokenBudget, member })
        throw new OpcError('TOKEN_BUDGET_EXCEEDED', `token 预算已耗尽: ${usedTokens}/${tokenBudget}`)
      }
      usedTokens += tokens
      const ratio = usedTokens / tokenBudget
      if (ratio >= 0.8 && !budgetWarned) {
        budgetWarned = true
        // PRD 6.2.3：阈值告警（80%）
        emitTeamEvent('token_budget_warn', { used: usedTokens, budget: tokenBudget, ratio, member })
      }
    },

    usage(): number {
      return usedTokens
    },
  }

  ctx.provideService('opc.team', service)

  // 模拟 dsh-team 集成：'team/spawn' 事件入口拉起成员（mock 场景仅记录）
  ctx.onEvent('team/spawn', (payload) => {
    const req = payload as { member: string; role: TeamRole }
    spawnedMembers.push({ member: req.member, role: req.role, spawnedAt: Date.now() })
  })

  ctx.onDispose(() => {
    spawnedMembers.length = 0
    usedTokens = 0
    budgetWarned = false // 'opc.team.events' 服务由宿主 unload 时从注册表撤销
  })
}

/** cordis Plugin.Function 形状：可被真实 ctx.plugin(plugin, config) 加载 */
export const plugin = defineOpcPlugin<Config>({
  name,
  defaultConfig: { tokenBudget: 1_000_000 },
  apply,
})

export default plugin
