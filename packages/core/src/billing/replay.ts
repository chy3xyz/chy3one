import type { BillingEngine, BillingEvent } from './billing.js'

export interface ReplayResult {
  /** 实际送入 engine.onTaskComplete 的行数（空行/坏行/非计费行不计入） */
  replayed: number
  /** 本次回补真实新增的计费记录数（重复 taskId 命中幂等去重不计入） */
  recovered: number
}

/** Session 事件日志行（JSON lines）：仅 type==='task_complete' 携带计费事件 */
interface SessionLogLine {
  type?: unknown
  event?: unknown
}

function isBillingEvent(value: unknown): value is BillingEvent {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    typeof e.taskId === 'string' &&
    typeof e.agentId === 'string' &&
    (e.resolution === 'resolved' || e.resolution === 'escalated') &&
    typeof e.tokensUsed === 'object' && e.tokensUsed !== null &&
    typeof (e.tokensUsed as Record<string, unknown>).prompt === 'number' &&
    typeof (e.tokensUsed as Record<string, unknown>).completion === 'number' &&
    typeof e.durationMs === 'number' &&
    typeof e.timestamp === 'number'
  )
}

/**
 * 计费埋点丢失回补（PRD 6.4.5 / DE-07）：
 * 从 Session 事件日志（JSON lines）逐行回放 task_complete 事件至计费引擎。
 * BillingEngine.onTaskComplete 按 taskId 幂等，重复事件不会重复计费；
 * 空行、坏 JSON、结构损坏的事件行静默跳过，回补过程永不抛错。
 */
export function replayFromSessionLog(logLines: string[], engine: BillingEngine): ReplayResult {
  let replayed = 0
  let recovered = 0
  /** 本轮回补中已判定的记录对象（BillingEngine 对重复 taskId 返回同一记录引用） */
  const seenRecords = new Set<unknown>()

  for (const raw of logLines) {
    const line = raw.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const logLine = parsed as SessionLogLine
    if (logLine.type !== 'task_complete') continue
    if (!isBillingEvent(logLine.event)) continue

    const event = logLine.event
    const revenueBefore = engine.totalRevenue()
    const record = engine.onTaskComplete(event)
    replayed++

    // 新增记录判定（仅凭公开 API 可得的两路信号）：
    // 1) totalRevenue 变化 → 必为新增的计费记录（跨批次预入账的重复也正确排除）；
    // 2) 零额记录（escalated 免费等）无收入信号，靠记录引用判定——
    //    BillingEngine 对重复 taskId 返回同一记录对象，本轮回补内重复即被去重。
    const revenueChanged = engine.totalRevenue() !== revenueBefore
    if (revenueChanged || (!seenRecords.has(record) && record.amount === 0)) {
      recovered++
    }
    seenRecords.add(record)
  }

  return { replayed, recovered }
}
