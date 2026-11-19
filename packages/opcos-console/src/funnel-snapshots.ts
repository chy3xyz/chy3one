import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { join } from 'node:path'

/**
 * 漏斗时序采集器（趋势图数据源）：
 * - 快照：GET /api/funnel 时调用 snapshot()（调用方节流：默认 ≥60 分钟才落一条）；
 * - 聚合：trend(days) 按日聚合为每日最后一条快照（漏斗四段读数）。
 * 正本为 JSONL append-only（与 runsFile 同模式，重启不丢）。
 */

export interface FunnelSnapshot {
  at: number
  day: string
  ideas: number
  contentsRuns: number
  contentsPublished: number
  skillsDrafts: number
  skillsListed: number
  orderNetCents: number
  raasRevenueYuan: number
}

export class FunnelSnapshotStore {
  private lastSnapshotAt = 0

  constructor(
    private readonly filePath: string,
    private readonly minIntervalMs: number = 60 * 60_000,
  ) {}

  /** 节流判定：距上次快照不足 minIntervalMs 时调用方应跳过落盘 */
  shouldSnapshot(now: number): boolean {
    return now - this.lastSnapshotAt >= this.minIntervalMs
  }

  snapshot(data: Omit<FunnelSnapshot, 'at' | 'day'>, now: number = Date.now()): FunnelSnapshot {
    this.lastSnapshotAt = now
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const record: FunnelSnapshot = {
      at: now,
      day: new Date(now).toISOString().slice(0, 10),
      ...data,
    }
    appendFileSync(this.filePath, JSON.stringify(record) + '\n', { mode: 0o600 })
    return record
  }

  /** 按日聚合：每日取当日最后一条快照（趋势图数据源） */
  trendByDay(days: number, now: number = Date.now()): FunnelSnapshot[] {
    if (!existsSync(this.filePath)) return []
    const byDay = new Map<string, FunnelSnapshot>()
    for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const rec = JSON.parse(line) as FunnelSnapshot
        byDay.set(rec.day, rec) // 同日后者覆盖（每日口径取最新读数）
      } catch { /* 坏行跳过 */ }
    }
    const cutoff = now - days * 86_400_000
    return [...byDay.values()]
      .filter((s) => s.at >= cutoff)
      .sort((a, b) => a.at - b.at)
  }

  close(): void {}
}
