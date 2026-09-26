import type { MvpPlan } from '../mvp/planner.js'
import type { Idea } from '../idea/store.js'
import type { IdeaWorkspace } from '../workspace/workspace.js'

/**
 * 创意开发执行（prd2.md 阶段二 IP-02 的 Agent 接线层）：
 * 把 MVP 方案 + 三域组装成结构化开发任务书，交由 DSH Agent（经 opc-team 的
 * spawnTeam/RoleExecutor）在创意工作区内执行；产出文件清单由执行回调写回工作区。
 *
 * 职责边界：本模块只做任务书组装、产出落盘、记忆留痕——Agent 拉起是宿主能力
 * （AR-C06：core 零 DSH 依赖，执行器经回调注入）。
 */

/** Agent 产出的单个文件（执行回调从子代理输出中解析或直接返回） */
export interface AgentDevFile {
  path: string
  content: string
}

export interface AgentDevTask {
  ideaId: string
  /** 结构化开发任务书（投递给 Agent 的完整 prompt） */
  prompt: string
  /** 工作区根（Agent 的 cwd / 文件落盘根） */
  workspaceRoot: string
  /** 组装时间戳 */
  at: number
}

export interface AgentDevResult {
  ideaId: string
  mode: 'spawned' | 'recorded'
  /** Agent 输出文本（recorded 模式为任务书回执） */
  output: string
  sessionId?: string
  /** 落盘到工作区的文件（相对路径） */
  files: string[]
  durationMs: number
}

export interface AgentDevDeps {
  /** Agent 执行器：注入 opc-team 的 spawn 能力或测试桩；返回产出文件与总结文本（mode 缺省 spawned） */
  execute: (task: AgentDevTask) => Promise<{ output: string; sessionId?: string; files: AgentDevFile[]; mode?: 'spawned' | 'recorded' }>
  /** 决策正本写入（创意记忆体 decisions 流；缺席时跳过） */
  writeDecision?: (ideaId: string, content: string) => void
  now?: () => number
}

/** 从 MVP 方案 + 三域组装开发任务书（结构化、自包含——子代理看不到控制台上下文） */
export function buildAgentDevPrompt(idea: Idea, plan: MvpPlan): string {
  const d = idea.domains
  return [
    `# 开发任务：${idea.name}`,
    '',
    '## 背景三域',
    `- 问题域：${d.problem.summary}`,
    d.problem.points.length > 0 ? `- 问题要点：${d.problem.points.join('；')}` : '',
    `- 解决域：${d.solution.summary}`,
    d.solution.points.length > 0 ? `- 方案要点：${d.solution.points.join('；')}` : '',
    `- 时空域：${d.spacetime.summary}`,
    '',
    '## MVP 功能范围（按此实现，不要扩大范围）',
    ...plan.features.map((f, i) => `${i + 1}. ${f}`),
    '',
    '## 技术栈约定',
    ...plan.techStack.map((t) => `- ${t}`),
    '',
    '## 产出要求',
    '在当前工作目录内产出可运行的 MVP 脚手架：',
    '1. `README.md`——项目说明：运行方式、功能清单与三域对照',
    '2. `package.json`——依赖与启动脚本',
    '3. 核心源码文件（按功能清单拆分，每个模块一个文件）',
    '4. 一个最小可验证入口（能跑起来看到主流程）',
    '',
    '约束：只在当前目录内创建文件；不引入超出技术栈约定的重依赖；',
    '完成后输出一段总结：实现了哪些功能、对应功能清单第几条、如何运行。',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * 执行一次 Agent 开发：组装任务书 → 执行器（真实 DSH Agent）→ 产出落盘工作区 →
 * 决策正本留痕。产出文件路径越界由 IdeaWorkspace 守卫（PERMISSION_DENIED）。
 */
export async function runAgentDev(
  idea: Idea,
  plan: MvpPlan,
  workspace: IdeaWorkspace,
  deps: AgentDevDeps,
): Promise<AgentDevResult> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const task: AgentDevTask = {
    ideaId: idea.id,
    prompt: buildAgentDevPrompt(idea, plan),
    workspaceRoot: workspace.path,
    at: startedAt,
  }
  const outcome = await deps.execute(task)
  const files: string[] = []
  for (const file of outcome.files) {
    workspace.writeFile(file.path, file.content)
    files.push(file.path)
  }
  deps.writeDecision?.(
    idea.id,
    JSON.stringify({
      kind: 'agent-dev-run',
      mode: outcome.mode ?? 'spawned',
      files,
      sessionId: outcome.sessionId,
      durationMs: now() - startedAt,
      summary: outcome.output.slice(0, 400),
    }),
  )
  return {
    ideaId: idea.id,
    mode: outcome.mode ?? 'spawned',
    output: outcome.output,
    sessionId: outcome.sessionId,
    files,
    durationMs: now() - startedAt,
  }
}
