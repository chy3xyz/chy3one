import type { Order } from './orders.js'
import type { PaymentProvider, PaymentResult } from './provider.js'

/**
 * Stripe PaymentIntent 响应（本实现只消费 id/status 两个字段）
 */
interface StripeIntentResponse {
  id?: string
  status?: string
}

/** Stripe 错误响应（HTTP 4xx/5xx：{ error: { message } }） */
interface StripeErrorResponse {
  error?: { message?: string }
}

export interface StripeProviderOptions {
  /**
   * Stripe secret key（测试模式为 sk_test_... 前缀）。
   * 仅用于 Authorization 头，绝不写入日志/错误信息（泄漏前经 redact 过滤）。
   */
  secretKey: string
  /** API 基址，默认官方端点；测试可指向本地 mock 服务 */
  baseUrl?: string
  /** 单次请求超时 ms，默认 15000；超时按网络错误处理 */
  timeoutMs?: number
  /** fetch 实现，可注入供测试（默认 globalThis.fetch） */
  fetchImpl?: typeof fetch
}

/** Stripe 测试卡 token：测试模式下免 3DS 直接确认成功（官方测试 PM） */
const STRIPE_TEST_PAYMENT_METHOD = 'pm_card_visa'

/**
 * Stripe 测试模式支付网关（SF-06 真实支付缺口）：PaymentIntent 创建并确认一步完成
 * （POST /v1/payment_intents，form-urlencoded）。与 MockMicropaymentProvider 同契约：
 * pay 永不抛错——网络/超时/非 2xx/非 succeeded 一律返回 { ok:false, reason }。
 * 金额口径：order.amount 已是整数"分"（Stripe 最小货币单位），原样透传。
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly baseUrl: string
  readonly timeoutMs: number
  private readonly secretKey: string
  private readonly fetchImpl: typeof fetch

  constructor(options: StripeProviderOptions) {
    if (typeof options.secretKey !== 'string' || options.secretKey.trim() === '') {
      // 错误信息只描述"缺失"，不回显调用方传入值（可能误传了其他敏感串）
      throw new RangeError('StripePaymentProvider: secretKey is required and must be a non-empty string')
    }
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new RangeError(`StripePaymentProvider: timeoutMs must be a positive finite number, got ${options.timeoutMs}`)
    }
    this.secretKey = options.secretKey
    this.baseUrl = (options.baseUrl ?? 'https://api.stripe.com').replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  async pay(order: Order): Promise<PaymentResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      // 表单口径（Stripe 官方）：金额分、币种 usd、测试卡直接确认、订单号进 metadata
      const body = new URLSearchParams({
        amount: String(order.amount),
        currency: 'usd',
        confirm: 'true',
        payment_method: STRIPE_TEST_PAYMENT_METHOD,
        'metadata[order_id]': order.id,
      })
      const res = await this.fetchImpl(`${this.baseUrl}/v1/payment_intents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: controller.signal,
      })
      const payload = (await res.json().catch(() => null)) as (StripeIntentResponse & StripeErrorResponse) | null
      if (res.ok) {
        if (payload?.status === 'succeeded' && payload.id) {
          return { ok: true, paymentRef: payload.id }
        }
        // 2xx 但非成功态：requires_action / requires_payment_method / processing …
        return { ok: false, reason: payload?.status ? `intent_${payload.status}` : 'intent_unknown_response' }
      }
      // 4xx/5xx：优先透出 Stripe 的 error.message（卡被拒等），拼接前过滤 secretKey
      const message = payload?.error?.message ?? `HTTP ${res.status} ${res.statusText}`
      return { ok: false, reason: this.redact(message) }
    } catch {
      // 网络失败 / 超时 abort / 响应不可读：统一网络错误语义，绝不向上抛
      return { ok: false, reason: 'network_error' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 错误信息拼进 reason 前过滤：任何途径都不允许 secretKey 出现在结果/日志中 */
  private redact(text: string): string {
    return this.secretKey && text.includes(this.secretKey) ? text.split(this.secretKey).join('[redacted]') : text
  }
}
