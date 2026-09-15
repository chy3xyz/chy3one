import { appendFileSync } from 'node:fs'
import { OpcError } from '../errors.js'

/** 计费埋点事件（DE-07），在 agent/pre-step / agent/request waterfall 点捕获（ARD-005） */
export interface BillingEvent {
  taskId: string
  agentId: string
  resolution: 'resolved' | 'escalated'
  tokensUsed: { prompt: number; completion: number }
  durationMs: number
  timestamp: number
}

export interface BillingRule {
  resolution: 'resolved' | 'escalated'
  unitPrice: number
}

export interface BillingRecord {
  taskId: string
  agentId: string
  resolution: BillingEvent['resolution']
  amount: number
  /** escalated 时携带失败记忆写入指令的目标内容（DE-04） */
  lesson?: { failureScenario: string; correctPath: string }
  recordedAt: number
}

export const DEFAULT_RULES: BillingRule[] = [
  { resolution: 'resolved', unitPrice: 2.5 },
  { resolution: 'escalated', unitPrice: 0 },
]

/**
 * RaaS 计费引擎（DE-06）：事件先落盘后处理（write-ahead），
 * escalated 免费并产出 lesson 层失败记忆。误差率目标 < 0.5%（AR TO-04）。
 */
export class BillingEngine {
  private rules = new Map(DEFAULT_RULES.map((r) => [r.resolution, r.unitPrice]))
  private records: BillingRecord[] = []
  private seenTasks = new Set<string>()
  private now: () => number

  constructor(
    private readonly logFile?: string,
    now: () => number = Date.now,
  ) {
    this.now = now
  }

  setRule(rule: BillingRule): void {
    this.rules.set(rule.resolution, rule.unitPrice)
  }

  /** 幂等处理一条埋点事件；重复 taskId 直接返回既有记录（防重复计费） */
  onTaskComplete(event: BillingEvent): BillingRecord {
    const existing = this.records.find((r) => r.taskId === event.taskId)
    if (existing) return existing
    this.seenTasks.add(event.taskId)

    const unitPrice = this.rules.get(event.resolution) ?? 0
    const record: BillingRecord = {
      taskId: event.taskId,
      agentId: event.agentId,
      resolution: event.resolution,
      amount: Math.round(unitPrice * 100) / 100,
      recordedAt: this.now(),
    }
    if (event.resolution === 'escalated') {
      record.lesson = {
        failureScenario: `task ${event.agentId}/${event.taskId} escalated to human`,
        correctPath: '人工处理路径待补充（由人工纠正流程回填）',
      }
    }
    this.records.push(record)
    if (this.logFile) appendFileSync(this.logFile, JSON.stringify({ event, record }) + '\n')
    return record
  }

  totalRevenue(): number {
    return Math.round(this.records.reduce((s, r) => s + r.amount, 0) * 100) / 100
  }
}

export class BillingEventError extends OpcError {
  constructor(detail: string) {
    super('BILLING_EVENT_INVALID', detail)
  }
}
