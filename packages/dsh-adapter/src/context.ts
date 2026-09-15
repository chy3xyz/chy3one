/**
 * OPC-OS 对 DSH/Cordis 的唯一接触面（升级隔离层，对应 AR-C06 / R-01）。
 *
 * 升级流程：DSH 新版本发布 → 根 package.json 升级 @deepseek-ai/* → 跑
 * compat 门禁测试锁定 API 表面 → 只修本目录 → 业务插件与 core 零改动。
 */
import { createRequire } from 'node:module'

/** OPC-OS 插件可见的稳定上下文：与 cordis 版本解耦的最小契约 */
export interface OpcContext {
  /** 注册具名服务，返回撤销函数 */
  provideService(name: string, impl: unknown): () => void
  /** 运行时解析服务（AR-C06：禁止编译期硬依赖） */
  getService<T = unknown>(name: string): T | undefined
  /** 订阅事件（含 waterfall 接管点），返回退订函数 */
  onEvent(name: string, listener: (payload: any) => any): () => void
  /** waterfall 接管点监听：返回非 undefined 时替换载荷（放行返回原载荷或 void） */
  onWaterfall(name: string, listener: (payload: any) => any): () => void
  /** 注册卸载清理（LIFO），对应 cordis effect 逆操作（AR-R06） */
  onDispose(fn: () => void): void
}

export interface DshRuntimeInfo {
  /** cordis 运行时来源 */
  apiLevel: 'cordis-4' | 'mock'
  cordisVersion?: string
}

/* ─────────────── 真实 cordis 4.x 适配 ─────────────── */

/** cordis 4.x Context 的结构子集（不 import 其类型，避免编译期耦合） */
interface Cordis4Context {
  provide(name: string, value?: unknown): unknown
  get(name: string, strict?: boolean): unknown
  on(name: string, listener: (...args: any[]) => unknown, options?: unknown): () => boolean
  effect(execute: () => unknown, label?: string): unknown
}

export function isCordis4Context(raw: unknown): raw is Cordis4Context {
  return (
    typeof raw === 'object' && raw !== null &&
    typeof (raw as Cordis4Context).provide === 'function' &&
    typeof (raw as Cordis4Context).on === 'function' &&
    typeof (raw as Cordis4Context).effect === 'function'
  )
}

/** 把真实 cordis ctx 包装成稳定 OpcContext */
export function adaptContext(raw: Cordis4Context): OpcContext {
  return {
    provideService: (name, impl) => {
      const revoke = raw.provide(name, impl) as unknown as () => void
      return () => revoke?.()
    },
    getService: (name) => raw.get(name) as never,
    onEvent: (name, listener) => {
      const off = raw.on(name, listener as (...args: any[]) => unknown)
      return () => off()
    },
    onWaterfall: (name, listener) => {
      // cordis 4 waterfall 是 Koa 式组合：监听器实际签名为 (payload, next)，
      // 不调用 next() 即否决整条链（含官方默认行为），返回值直接成为结果。
      // OPC 语义映射：listener 返回 undefined = 观察/放行 → 必须 next() 走完官方链；
      // 返回非 undefined = 替换意图 → 官方钩子上禁止（会否决链），仅用于自有事件。
      const wrapped = async (payload: unknown, next?: () => unknown) => {
        const result = listener(payload)
        if (typeof next === 'function') return next()
        return result
      }
      const off = raw.on(name, wrapped as (...args: any[]) => unknown)
      return () => off()
    },
    onDispose: (fn) => {
      // cordis 4：effect body 立即执行，其返回函数即逆操作
      raw.effect(() => fn)
    },
  }
}

/* ─────────────── Mock 上下文（单测/无 DSH 环境） ─────────────── */

export interface MockContext extends OpcContext {
  /** 手动派发事件（waterfall 语义：监听器串行，返回值替换载荷） */
  dispatch(name: string, payload: unknown): unknown
  /** 执行已注册的卸载清理（LIFO） */
  unload(): void
  /** 已注册服务快照 */
  readonly services: Map<string, unknown>
}

export function createMockContext(): MockContext {
  const listeners = new Map<string, Array<(payload: any) => any>>()
  const disposers: Array<() => void> = []
  const services = new Map<string, unknown>()
  return {
    services,
    provideService(name, impl) {
      services.set(name, impl)
      return () => services.delete(name)
    },
    getService(name) {
      return services.get(name) as never
    },
    onEvent(name, listener) {
      const list = listeners.get(name) ?? []
      listeners.set(name, [...list, listener])
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((l) => l !== listener))
    },
    onWaterfall(name, listener) {
      return this.onEvent(name, listener)
    },
    onDispose(fn) {
      disposers.push(fn)
    },
    dispatch(name, payload) {
      let current = payload
      for (const l of listeners.get(name) ?? []) {
        const next = l(current)
        if (next !== undefined) current = next
      }
      return current
    },
    unload() {
      for (const fn of disposers.reverse()) fn()
      disposers.length = 0
      listeners.clear()
      services.clear()
    },
  }
}

/* ─────────────── 插件定义辅助 ─────────────── */

export interface OpcPluginDefinition<C> {
  name: string
  inject?: string[]
  defaultConfig: C
  apply(ctx: OpcContext, config: C): void
}

/**
 * 产出 cordis 兼容的函数插件：可直接被 `ctx.plugin(plugin, config)` 加载，
 * 也可被 dsh bundle 引用。apply 收到的永远是稳定 OpcContext。
 */
export function defineOpcPlugin<C>(def: OpcPluginDefinition<C>) {
  const plugin = (rawCtx: unknown, userConfig?: Partial<C>) => {
    if (!isCordis4Context(rawCtx)) {
      throw new TypeError(`plugin ${def.name}: expects a cordis-4 context`)
    }
    const ctx = adaptContext(rawCtx)
    const config = { ...def.defaultConfig, ...userConfig } as C
    def.apply(ctx, config)
  }
  // Function.name 只读，用 defineProperty 挂载 cordis 插件元数据
  Object.defineProperty(plugin, 'name', { value: def.name, configurable: true })
  const typed = plugin as ((rawCtx: unknown, userConfig?: Partial<C>) => void) & {
    name: string
    inject: string[]
  }
  typed.inject = def.inject ?? []
  return typed
}

/* ─────────────── 运行时探测与日志脱敏 ─────────────── */

export function detectDshRuntime(): DshRuntimeInfo {
  try {
    const req = createRequire(import.meta.url)
    const cordisPkg = req('@deepseek-ai/cordis/package.json') as { version: string }
    return { apiLevel: 'cordis-4', cordisVersion: cordisPkg.version }
  } catch {
    return { apiLevel: 'mock' }
  }
}

const SECRET_PATTERNS: Array<{ re: RegExp; mask: string }> = [
  { re: /sk-[A-Za-z0-9]{8,}/g, mask: 'sk-***' },
  { re: /Bearer\s+[A-Za-z0-9._-]+/gi, mask: 'Bearer ***' },
  { re: /("(?:api[-_]?key|password|secret|token)"\s*:\s*")[^"]+(")/gi, mask: '$1***$2' },
]

/** 日志脱敏（RC-04 / AR-S03）：API Key、Bearer、敏感字段一律打码 */
export function redact(text: string): string {
  let out = text
  for (const { re, mask } of SECRET_PATTERNS) out = out.replace(re, mask)
  return out
}
