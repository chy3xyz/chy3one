import { join } from 'node:path'

import {
  GeoMonitor,
  GeoSnapshotStore,
  MockGeoProvider,
  MemoryBodyHub,
  MemoryBodyIndex,
  SqliteIdeaStore,
  GEO_PLATFORMS,
  type GeoPlatform,
  type GeoRefreshResult,
  type GeoSnapshot,
} from '../../../core/src/index.js'
import { defineOpcPlugin, type OpcContext } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-geo-monitor'

/**
 * opc-geo-monitor —— GEO 监测插件（prd2.md 4.4 creativeos/geo-monitor 的 DSH 服务形态）：
 * 'opc.geo' 服务提供 refresh（探测+告警+落库+写入创意记忆体 analytics 流）与 history。
 *
 * 数据源默认 MockGeoProvider（主流 AI 平台无公开可见性 API，演示口径，UI 明确标注）；
 * 真实/LLM 估值 Provider 经 GeoProvider 接口替换（沿用 DEEPSEEK_API_KEY 降级模式）。
 * 数据与控制台/lifecycle 同源：ideas.db 读创意名作品牌关键词，memory-bodies.db 写监测正本。
 */
export interface Config {
  /** 创意库 SQLite 路径（默认 ./opcos-console-data/ideas.db） */
  ideasDbPath?: string
  /** 创意目录根（默认 ./opcos-console-data/ideas） */
  ideasRoot?: string
  /** 记忆体索引（analytics 正本镜像，默认 ./opcos-console-data/memory-bodies.db） */
  bodiesDbPath?: string
  /** GEO 快照库（默认 ./opcos-console-data/geo.db） */
  geoDbPath?: string
  /** 监测平台（默认 prd2.md 4.4 四平台：doubao/deepseek/chatgpt/wenxin） */
  platforms?: GeoPlatform[]
  /** 可见性下跌告警阈值（默认 0.2） */
  alertThreshold?: number
  /**
   * 7×24 周期调度间隔（prd2.md 4.4「7×24 监测」/ NFR 刷新 <5min，默认 300_000ms = 5 分钟，
   * NFR 10 允许的上限）。0 = 关闭调度（仅手动刷新）。定时对全部创意逐个探测，
   * 单创意失败不阻断其余；上一轮未结束时跳过本轮（防重叠）。
   */
  refreshIntervalMs?: number
}

/** 'opc.geo' 服务契约 */
export interface GeoService {
  /** 刷新一次监测（品牌关键词默认取创意名；结果同步写入创意记忆体 analytics 流） */
  refresh(ideaId: string, keywords?: readonly string[]): Promise<GeoRefreshResult>
  /** 该创意的快照历史（时间倒序） */
  history(ideaId: string, limit?: number): GeoSnapshot[]
  /** 当前生效的平台矩阵、阈值与调度器状态（观测用） */
  config(): {
    platforms: readonly string[]
    alertThreshold: number
    simulated: boolean
    scheduler: { intervalMs: number; running: boolean; lastRunAt: number; lastError?: string }
  }
}

export function apply(ctx: OpcContext, config: Config): void {
  const ideasRoot = config.ideasRoot ?? join('./opcos-console-data', 'ideas')
  const ideasDbPath = config.ideasDbPath ?? join('./opcos-console-data', 'ideas.db')
  const bodiesDbPath = config.bodiesDbPath ?? join('./opcos-console-data', 'memory-bodies.db')
  const geoDbPath = config.geoDbPath ?? join('./opcos-console-data', 'geo.db')
  const platforms = config.platforms ?? GEO_PLATFORMS
  const alertThreshold = config.alertThreshold ?? 0.2

  const store = new SqliteIdeaStore(ideasDbPath, ideasRoot)
  const bodyIndex = new MemoryBodyIndex(bodiesDbPath)
  const hub = new MemoryBodyHub(ideasRoot, bodyIndex)
  const geoStore = new GeoSnapshotStore(geoDbPath)
  // writeToMemory（prd2.md 4.4）：监测快照以 model 权威写入创意记忆体 analytics 流
  const monitor = new GeoMonitor({
    provider: new MockGeoProvider(),
    store: geoStore,
    alertThreshold,
    onSnapshot: (snapshot) => {
      // 创意目录缺席（已被清理等）不阻断监测主流程
      try {
        hub.write(snapshot.ideaId, 'analytics', {
          content: JSON.stringify({ kind: 'geo-snapshot', ...snapshot }),
          confidence: 0.7,
          authority: 'model',
        })
      } catch {
        /* 记忆体写入失败不阻断监测 */
      }
    },
  })

  const service: GeoService = {
    async refresh(ideaId, keywords) {
      const kws = keywords ?? [store.require(ideaId).name]
      return monitor.refresh(ideaId, kws, platforms)
    },
    history: (ideaId, limit) => monitor.history(ideaId, limit),
    config: () => ({
      platforms,
      alertThreshold,
      simulated: true,
      scheduler: schedulerStatus(),
    }),
  }
  ctx.provideService('opc.geo', service)

  /* ─────────────── 7×24 周期调度（prd2.md 4.4） ─────────────── */

  const intervalMs = config.refreshIntervalMs ?? 300_000
  let running = false
  let lastRunAt = 0
  let lastError: string | undefined
  const schedulerStatus = (): { intervalMs: number; running: boolean; lastRunAt: number; lastError?: string } => ({
    intervalMs,
    running,
    lastRunAt,
    ...(lastError ? { lastError } : {}),
  })

  const refreshAll = async (): Promise<void> => {
    if (running) return // 上一轮未结束：跳过本轮，防重叠
    running = true
    try {
      for (const idea of store.list()) {
        try {
          await monitor.refresh(idea.id, [idea.name], platforms)
        } catch (error) {
          // 单创意失败（目录被清理等）不阻断其余创意的监测
          lastError = error instanceof Error ? error.message : String(error)
        }
      }
      lastRunAt = Date.now()
      lastError = undefined
    } finally {
      running = false
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined
  if (intervalMs > 0) {
    timer = setInterval(() => {
      void refreshAll()
    }, intervalMs)
    timer.unref?.() // 不阻塞进程退出
  }

  ctx.onDispose(() => {
    if (timer) clearInterval(timer)
    geoStore.close()
    bodyIndex.close()
    store.close()
  })
}

export const plugin = defineOpcPlugin<Config>({ name, defaultConfig: { refreshIntervalMs: 300_000 }, apply })
export default plugin
