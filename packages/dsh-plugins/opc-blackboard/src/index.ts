import { readFileSync, writeFileSync } from 'node:fs'
import {
  InMemoryBlackboard,
  type BlackboardEntry,
  type BlackboardWrite,
  type BlackboardScope,
  type WriteResult,
} from '../../../core/src/index.js'
import { createTelemetryBus, defineOpcPlugin, type OpcContext } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-blackboard'

export interface Config {
  /** 持久化快照文件路径；未配置则纯内存运行 */
  persistFile?: string
}

/** 'blackboard_write' 埋点事件载荷（PRD 7.5，经 TelemetryBus 的 payload 通道分发） */
export interface BlackboardWritePayload {
  agentId: string
  scope: BlackboardScope
  dataSize: number
  [extra: string]: unknown
}

interface Snapshot {
  version: 1
  entries: BlackboardEntry[]
}

const snapshotVersion = 1 as const

export function apply(ctx: OpcContext, config: Config) {
  const board = new InMemoryBlackboard()

  /** 插件层薄持久化层：以 mapKey 索引的版本链镜像（保存完整链以精确还原版本号），成功写入后全量落盘 */
  const chains = new Map<string, BlackboardEntry[]>()

  const load = (): void => {
    if (!config.persistFile) return
    let snapshot: Snapshot
    try {
      snapshot = JSON.parse(readFileSync(config.persistFile, 'utf8')) as Snapshot
    } catch {
      return // 文件不存在或损坏：按空黑板冷启动
    }
    if (snapshot?.version !== snapshotVersion || !Array.isArray(snapshot.entries)) return
    // 按版本号重放到 core 实例，运行时仲裁仍由 InMemoryBlackboard 负责
    const byKey = new Map<string, BlackboardEntry[]>()
    for (const entry of snapshot.entries) {
      const mapKey = `${entry.scope}:${entry.key}`
      byKey.set(mapKey, [...(byKey.get(mapKey) ?? []), entry])
    }
    for (const [mapKey, chain] of byKey) {
      chain.sort((a, b) => a.version - b.version)
      const replayed: BlackboardEntry[] = []
      // 链内位置即乐观锁版本（0,1,2…），成功写入次数与原版本号严格一致
      chain.forEach((entry, idx) => {
        const op: BlackboardWrite = {
          scope: entry.scope,
          key: entry.key,
          value: entry.value,
          writer: entry.writer,
          role: entry.role,
          confidence: entry.confidence,
          expectedVersion: idx,
        }
        const result = board.write(op)
        if (result.status === 'ok') replayed.push(result.entry)
      })
      if (replayed.length) chains.set(mapKey, replayed)
    }
  }

  const save = (): void => {
    if (!config.persistFile) return
    const snapshot: Snapshot = { version: snapshotVersion, entries: [...chains.values()].flat() }
    writeFileSync(config.persistFile, JSON.stringify(snapshot), 'utf8')
  }

  load()

  // 埋点总线（TD-04：统一 TelemetryBus 订阅约定）
  const events = createTelemetryBus()

  const write = (op: BlackboardWrite): WriteResult => {
    let result: WriteResult
    try {
      result = board.write(op) // core 仲裁（PermissionError/ConflictError 原样上抛）
    } catch (err) {
      throw err
    }
    if (result.status === 'ok') {
      const mapKey = `${op.scope}:${op.key}`
      chains.set(mapKey, [...(chains.get(mapKey) ?? []), result.entry])
      save() // 全量快照追加保存（AC-03：重启不丢共享数据）
      const payload: BlackboardWritePayload = {
        agentId: op.writer,
        scope: op.scope,
        dataSize: JSON.stringify(op.value ?? null).length,
      }
      events.emit({ type: 'blackboard_write', payload, timestamp: Date.now() })
    }
    return result
  }

  ctx.provideService('opc.blackboard', {
    read: (scope: BlackboardScope, key?: string) => board.read(scope, key),
    write,
  })

  ctx.provideService('opc.blackboard.events', events)

  /** 事件式写入入口：waterfall 钩子载荷即 BlackboardWrite，返回 WriteResult 替换载荷 */
  ctx.onWaterfall('blackboard/write', (payload) => write(payload as BlackboardWrite))

  ctx.onDispose(() => {
    chains.clear() // 'opc.blackboard.events' 服务由宿主 unload 时从注册表撤销
  })
}

/** cordis Plugin.Function 形状：可被真实 ctx.plugin(plugin, config) 加载 */
export const plugin = defineOpcPlugin<Config>({
  name,
  defaultConfig: {},
  apply,
})

export default plugin
