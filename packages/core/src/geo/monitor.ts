import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

/**
 * GEO 监测（prd2.md 4.4 creativeos/geo-monitor 算法层 + NFR 刷新 <5min）：
 * - 指标：visibility（可见性 0..1）/ citation_rate（引用率 0..1）/ sentiment（情感 0..1）
 *   × 平台（豆包/DeepSeek/ChatGPT/文心…），按创意隔离存储；
 * - Provider：探测数据源可插拔——MockProvider（确定性伪随机，演示/测试）与
 *   真实/LLM 估值 Provider 同接口替换（沿用 DEEPSEEK_API_KEY 降级模式）；
 * - 告警：visibility 相对上一次快照下跌 ≥ alertThreshold（默认 0.2）触发；
 * - 落库：SQLite 快照表 + 可选回调（插件层接创意记忆体 analytics 流）。
 */

/** 主流 AI 平台默认矩阵（prd2.md 4.4 platforms 配置） */
export const GEO_PLATFORMS = ['doubao', 'deepseek', 'chatgpt', 'wenxin'] as const
export type GeoPlatform = (typeof GEO_PLATFORMS)[number]

export interface GeoSnapshot {
  id: string
  ideaId: string
  platform: string
  visibility: number
  citationRate: number
  sentiment: number
  at: number
}

export interface GeoAlert {
  id: string
  ideaId: string
  platform: string
  metric: 'visibility_drop'
  /** 本轮可见性 */
  value: number
  /** 上一轮可见性 */
  previous: number
  /** 下跌幅度（previous - value） */
  drop: number
  threshold: number
  at: number
}

/** 探测数据源契约（Mock / LLM 估值 / 真实平台 API 同形替换） */
export interface GeoProvider {
  probe(ideaId: string, keywords: readonly string[], platforms: readonly string[]): Promise<Omit<GeoSnapshot, 'id'>[]>
}

/** 由 seed 稳定伪随机 [0,1)：同 seed 同结果（演示数据可复现，测试可断言） */
function seededRandom(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967296
}

/**
 * Mock 探测源：以 ideaId+platform+关键词集合 为 seed 的确定性伪随机指标。
 * 真实投放数据不可得（主流 AI 平台无公开可见性 API），演示口径在 UI 明确标注。
 */
export class MockGeoProvider implements GeoProvider {
  async probe(
    ideaId: string,
    keywords: readonly string[],
    platforms: readonly string[],
  ): Promise<Omit<GeoSnapshot, 'id'>[]> {
    void keywords // 真实 Provider 按关键词检索；Mock 只需稳定 seed
    const day = Math.floor(Date.now() / 86_400_000)
    return platforms.map((platform) => {
      const seed = `${ideaId}:${platform}:${day}`
      return {
        ideaId,
        platform,
        visibility: Math.round(seededRandom(`${seed}:v`) * 100) / 100,
        citationRate: Math.round(seededRandom(`${seed}:c`) * 100) / 100,
        sentiment: Math.round(50 + seededRandom(`${seed}:s`) * 50) / 100,
        at: Date.now(),
      }
    })
  }
}

/** GEO 快照存储（SQLite，按创意隔离；WAL 同全局档位） */
export class GeoSnapshotStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS geo_snapshots (
        id            TEXT PRIMARY KEY,
        idea_id       TEXT NOT NULL,
        platform      TEXT NOT NULL,
        visibility    REAL NOT NULL,
        citation_rate REAL NOT NULL,
        sentiment     REAL NOT NULL,
        at            INTEGER NOT NULL
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_geo_idea ON geo_snapshots (idea_id, platform, at DESC)')
  }

  append(snapshot: GeoSnapshot): void {
    this.db
      .prepare(
        'INSERT INTO geo_snapshots (id, idea_id, platform, visibility, citation_rate, sentiment, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(snapshot.id, snapshot.ideaId, snapshot.platform, snapshot.visibility, snapshot.citationRate, snapshot.sentiment, snapshot.at)
  }

  /** 某创意某平台最新一条快照（告警对比基准；无历史返回 undefined） */
  latest(ideaId: string, platform: string): GeoSnapshot | undefined {
    const rows = this.db
      .prepare(
        'SELECT id, idea_id, platform, visibility, citation_rate, sentiment, at FROM geo_snapshots WHERE idea_id = ? AND platform = ? ORDER BY at DESC LIMIT 1',
      )
      .all(ideaId, platform) as unknown as Array<{
      id: string; idea_id: string; platform: string; visibility: number; citation_rate: number; sentiment: number; at: number
    }>
    if (rows.length === 0) return undefined
    const r = rows[0]
    return { id: r.id, ideaId: r.idea_id, platform: r.platform, visibility: r.visibility, citationRate: r.citation_rate, sentiment: r.sentiment, at: r.at }
  }

  /** 某创意全部快照（时间倒序，limit 默认 100） */
  history(ideaId: string, limit = 100): GeoSnapshot[] {
    const rows = this.db
      .prepare(
        'SELECT id, idea_id, platform, visibility, citation_rate, sentiment, at FROM geo_snapshots WHERE idea_id = ? ORDER BY at DESC LIMIT ?',
      )
      .all(ideaId, limit) as unknown as Array<{
      id: string; idea_id: string; platform: string; visibility: number; citation_rate: number; sentiment: number; at: number
    }>
    return rows.map((r) => ({ id: r.id, ideaId: r.idea_id, platform: r.platform, visibility: r.visibility, citationRate: r.citation_rate, sentiment: r.sentiment, at: r.at }))
  }

  close(): void {
    this.db.close()
  }
}

export interface GeoMonitorOptions {
  provider: GeoProvider
  store: GeoSnapshotStore
  /** 可见性下跌告警阈值（prd2.md 4.4 alertThreshold.visibility_drop，默认 0.2） */
  alertThreshold?: number
  /** 快照持久化后的回调（插件层接创意记忆体 analytics 流，prd2.md 4.4 writeToMemory） */
  onSnapshot?: (snapshot: GeoSnapshot) => void
  onAlert?: (alert: GeoAlert) => void
  now?: () => number
}

export interface GeoRefreshResult {
  ideaId: string
  snapshots: GeoSnapshot[]
  alerts: GeoAlert[]
  /** 模拟口径标记：Mock Provider 的数据非真实投放结果 */
  simulated: boolean
}

/** GEO 监测器：探测 → 对比告警 → 落库 → 回调（记忆体/埋点由回调方接） */
export class GeoMonitor {
  private readonly threshold: number

  constructor(private readonly options: GeoMonitorOptions) {
    this.threshold = options.alertThreshold ?? 0.2
  }

  async refresh(ideaId: string, keywords: readonly string[], platforms: readonly string[] = GEO_PLATFORMS): Promise<GeoRefreshResult> {
    const probes = await this.options.provider.probe(ideaId, keywords, platforms)
    const snapshots: GeoSnapshot[] = []
    const alerts: GeoAlert[] = []
    for (const probe of probes) {
      const snapshot: GeoSnapshot = { id: randomUUID(), ...probe }
      const previous = this.options.store.latest(ideaId, snapshot.platform)
      this.options.store.append(snapshot)
      snapshots.push(snapshot)
      this.options.onSnapshot?.(snapshot)
      // 首轮无基准不告警（prd2.md 4.4：可见性下降 20% 触发，下跌须有前一拍）
      if (previous && previous.visibility - snapshot.visibility >= this.threshold) {
        const alert: GeoAlert = {
          id: randomUUID(),
          ideaId,
          platform: snapshot.platform,
          metric: 'visibility_drop',
          value: snapshot.visibility,
          previous: previous.visibility,
          drop: Math.round((previous.visibility - snapshot.visibility) * 100) / 100,
          threshold: this.threshold,
          at: snapshot.at,
        }
        alerts.push(alert)
        this.options.onAlert?.(alert)
      }
    }
    return { ideaId, snapshots, alerts, simulated: this.options.provider instanceof MockGeoProvider }
  }

  history(ideaId: string, limit?: number): GeoSnapshot[] {
    return this.options.store.history(ideaId, limit)
  }
}
