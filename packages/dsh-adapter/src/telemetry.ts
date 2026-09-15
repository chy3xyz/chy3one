/**
 * 统一埋点订阅约定（TD-04 偿还 / PRD 7.5 订阅回调注册表）。
 *
 * opc-team / opc-blackboard / opc-skill-forge 一律以 '<name>.events' 服务
 * 暴露 TelemetryBus：消费者 bus.subscribe(fn) 订阅（返回退订函数），
 * 插件内部经 bus.emit 发射埋点。事件 type 语义与 payload 字段由各插件自定。
 */

/** 埋点事件信封 */
export interface TelemetryEvent {
  type: string
  payload?: Record<string, unknown>
  /** 发射时刻（epoch ms） */
  timestamp: number
}

export interface TelemetryBus {
  /** 订阅埋点事件，返回退订函数 */
  subscribe(fn: (event: TelemetryEvent) => void): () => void
  /** 内部使用：插件埋点发射入口 */
  emit(event: TelemetryEvent): void
}

export function createTelemetryBus(): TelemetryBus {
  const subscribers = new Set<(event: TelemetryEvent) => void>()
  return {
    subscribe(fn) {
      subscribers.add(fn)
      return () => {
        subscribers.delete(fn)
      }
    },
    emit(event) {
      for (const fn of subscribers) fn(event)
    },
  }
}
