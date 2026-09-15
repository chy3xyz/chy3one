import { randomUUID } from 'node:crypto'
import type { Order } from './orders.js'

/** 支付结果（SF-06）：成功携带网关流水号，失败携带原因 */
export type PaymentResult = { ok: true; paymentRef: string } | { ok: false; reason: string }

/** 支付网关抽象（SF-06：HTTP 402 微支付或 Stripe） */
export interface PaymentProvider {
  pay(order: Order): Promise<PaymentResult>
}

export interface MockProviderOptions {
  /** 失败率（0..1），默认 0——理想路径可测（SF-06：支付成功率 ≥ 99%） */
  failureRate?: number
  /** 模拟网关延迟 ms，默认 0 */
  latencyMs?: number
  /** 随机源，可注入保证测试确定性 */
  rng?: () => number
  /** sleep 实现，可注入假时钟（测支付超时与订单取消竞态） */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * HTTP 402 风格微支付模拟（SF-06 / PRD 6.1.3）。
 * 成功返回 paymentRef = 'pm_' + uuid；失败以 402 语义描述原因。
 */
export class MockMicropaymentProvider implements PaymentProvider {
  readonly failureRate: number
  readonly latencyMs: number
  /** 最近一次 pay 实际等待的模拟时长（由注入 sleep 语义决定，供断言） */
  lastLatencyMs = 0
  private readonly rng: () => number
  private readonly sleepFn: (ms: number) => Promise<void>

  constructor(opts: MockProviderOptions = {}) {
    this.failureRate = opts.failureRate ?? 0
    this.latencyMs = opts.latencyMs ?? 0
    this.rng = opts.rng ?? Math.random
    this.sleepFn = opts.sleep ?? defaultSleep
  }

  async pay(order: Order): Promise<PaymentResult> {
    this.lastLatencyMs = 0
    if (this.latencyMs > 0) {
      await this.sleepFn(this.latencyMs)
      this.lastLatencyMs = this.latencyMs
    }
    if (this.rng() < this.failureRate) {
      return {
        ok: false,
        reason: `HTTP 402 Payment Required: micropayment of ${order.amount} cents for order ${order.id} declined (mock)`,
      }
    }
    return { ok: true, paymentRef: `pm_${randomUUID()}` }
  }
}
