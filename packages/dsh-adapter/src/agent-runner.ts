import { randomUUID } from 'node:crypto'

/**
 * DSH Agent 原语（结构子集，与 opc-team 的 NativeRegistryLike 同款 duck-type，
 * AR-C06：经 ctx 服务表运行时解析，不编译期依赖 dsh 包）。
 * 事实来源：dsh-headless/lib/index.js:127-168（apply 级独立 spawn 官方样例）。
 */

/** agents.create 句柄（agent 会话对象 + 可选 dispose） */
export interface DshAgentHandle {
  agent: {
    session: { id?: string | number | null; seq?: number }
    followup(message: { id: string; role: 'user'; content: Array<{ type: string; text: string }>; source: { kind: string } }): void
    whenIdle(): Promise<void>
  }
  dispose?(): Promise<void> | void
}

export interface DshAgentsRegistry {
  create(input: {
    sessionId: string
    meta?: { cwd: string }
    agentOptions?: { provider?: string; model?: string }
  }): Promise<DshAgentHandle> | DshAgentHandle
}

export interface DshSessionsService {
  flush(session: unknown): Promise<void> | void
}

export interface DshDefaultModelService {
  currentSelection?(): { provider?: string; model?: string } | undefined
}

/** 从宿主服务表解析 Agent 执行器（缺席/形状不符返回 undefined——优雅降级由调用方处理） */
export function resolveDshAgentRunner(deps: {
  getService: (name: string) => unknown
  cwd: string
}): ((prompt: string) => Promise<{ output: string; sessionId?: string }>) | undefined {
  const agents = deps.getService('agents') as DshAgentsRegistry | undefined
  if (!agents || typeof agents.create !== 'function') return undefined
  const sessions = deps.getService('sessions') as DshSessionsService | undefined
  const canFlush = !!sessions && typeof sessions.flush === 'function'
  const defaultModel = deps.getService('agentDefaultModel') as DshDefaultModelService | undefined
  const selection = defaultModel?.currentSelection?.()

  return async (prompt: string) => {
    const handle = await agents.create({
      sessionId: `session-agent-dev-${randomUUID()}`,
      meta: { cwd: deps.cwd },
      ...(selection ? { agentOptions: { provider: selection.provider, model: selection.model } } : {}),
    })
    const agent = handle.agent
    try {
      const firstSeq = agent.session.seq ?? 0
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      })
      await agent.whenIdle()
      // 取本轮新增 assistant 文本（dsh-headless 同款摘要语义，简版：拼接新增文本块）
      const output = summarizeTail(agent, firstSeq)
      if (canFlush) await sessions!.flush(agent.session)
      const sessionId =
        agent.session.id === undefined || agent.session.id === null ? undefined : String(agent.session.id)
      return { output, sessionId }
    } finally {
      if (typeof handle.dispose === 'function') await handle.dispose()
    }
  }
}

/** 复刻 dsh-headless 的会话摘要取法（lib/index.js:33-56 语义）：最后一条非空 assistant 文本 */
function summarizeTail(agent: DshAgentHandle['agent'], firstSeq: number): string {
  const entries = (agent.session as unknown as { entries?: Array<{ kind?: string; message?: { role?: string; content?: unknown } }> }).entries ?? []
  let output = ''
  for (const entry of entries) {
    const message = entry.message
    if (!message || message.role !== 'assistant') continue
    const text = extractText(message.content)
    if (text) output = text
  }
  void firstSeq
  return output
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && (part as { type?: string }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}
