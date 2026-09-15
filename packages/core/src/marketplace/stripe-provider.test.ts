import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { StripePaymentProvider } from './stripe-provider.js'
import { OrderEngine } from './orders.js'

/** mock Stripe 收到的请求快照（断言 form 体与鉴权头用） */
interface CapturedRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

interface MockStripe {
  server: Server
  /** 如 http://127.0.0.1:port */
  url: string
  requests: CapturedRequest[]
}

/**
 * 起 mock Stripe 服务（node:http）：handler 决定响应，请求全量捕获。
 * 测试结束（t.after）关监听并强杀残留 keep-alive 连接（超时用例的挂起 socket），tmp 清理。
 */
async function startMockStripe(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<MockStripe> {
  const requests: CapturedRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('error', () => {})
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      res.on('error', () => {}) // 客户端超时 abort 后写响应会 EPIPE，静默
      try {
        handler(req, res, body)
      } catch {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'mock handler crashed' } }))
        } catch {
          /* socket 已死 */
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { server, url: `http://127.0.0.1:${addr.port}`, requests }
}

/** 测试专用 secret key（形似 sk_test_ 但纯属虚构，非任何真实凭据） */
const FAKE_KEY = 'sk_test_zzz-not-a-real-key-zzz'

function makeOrder(amount = 1_000) {
  const engine = new OrderEngine()
  return engine.createOrder({ skillId: 'sk', version: '1.0.0', buyerId: 'b', amount })
}

function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

test('stripe: 测试卡直接确认成功 → ok:true 且 paymentRef=PaymentIntent id', async (t) => {
  const mock = await startMockStripe(t, (req, res) => jsonResponse(res, 200, { id: 'pi_x', status: 'succeeded' }))
  const provider = new StripePaymentProvider({ secretKey: FAKE_KEY, baseUrl: mock.url, timeoutMs: 5_000 })
  const order = makeOrder()

  const r = await provider.pay(order)
  assert.ok(r.ok, `应支付成功：${!r.ok ? r.reason : ''}`)
  assert.equal(r.paymentRef, 'pi_x')

  // 请求口径：POST /v1/payment_intents，Bearer 鉴权，form 体含金额/metadata
  assert.equal(mock.requests.length, 1)
  const req = mock.requests[0]
  assert.equal(req.method, 'POST')
  assert.equal(req.url, '/v1/payment_intents')
  assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.equal(req.headers.authorization, `Bearer ${FAKE_KEY}`)
  const form = new URLSearchParams(req.body)
  assert.equal(form.get('amount'), '1000', 'amount 以分透传')
  assert.equal(form.get('currency'), 'usd')
  assert.equal(form.get('confirm'), 'true')
  assert.equal(form.get('payment_method'), 'pm_card_visa')
  assert.equal(form.get('metadata[order_id]'), order.id)
})

test('stripe: 卡被拒（HTTP 402）→ ok:false 且 reason 含 Stripe error.message', async (t) => {
  const mock = await startMockStripe(t, (req, res) =>
    jsonResponse(res, 402, { error: { message: 'Your card was declined.', code: 'card_declined' } }),
  )
  const provider = new StripePaymentProvider({ secretKey: FAKE_KEY, baseUrl: mock.url })

  const r = await provider.pay(makeOrder())
  assert.ok(!r.ok)
  assert.ok(r.reason.includes('declined'), `reason 应含卡拒信息：${r.reason}`)
})

test('stripe: 2xx 但 requires_action → ok:false reason=intent_requires_action（pay 不抛错）', async (t) => {
  const mock = await startMockStripe(t, (req, res) =>
    jsonResponse(res, 200, { id: 'pi_3', status: 'requires_action' }),
  )
  const provider = new StripePaymentProvider({ secretKey: FAKE_KEY, baseUrl: mock.url })

  const r = await provider.pay(makeOrder())
  assert.ok(!r.ok)
  assert.equal(r.reason, 'intent_requires_action')
})

test('stripe: 网关响应慢于 timeoutMs → ok:false reason=network_error（不抛错、不悬挂）', async (t) => {
  const mock = await startMockStripe(t, (req, res) => {
    setTimeout(() => jsonResponse(res, 200, { id: 'pi_late', status: 'succeeded' }), 400)
  })
  const provider = new StripePaymentProvider({ secretKey: FAKE_KEY, baseUrl: mock.url, timeoutMs: 50 })

  const r = await provider.pay(makeOrder())
  assert.ok(!r.ok)
  assert.equal(r.reason, 'network_error')
})

test('stripe: 网络层失败（连接拒绝）→ ok:false reason=network_error', async (t) => {
  // 0 端口必然连接失败：无需真实 mock 服务
  const provider = new StripePaymentProvider({ secretKey: FAKE_KEY, baseUrl: 'http://127.0.0.1:0' })
  const r = await provider.pay(makeOrder())
  assert.ok(!r.ok)
  assert.equal(r.reason, 'network_error')
})

test('stripe: secretKey 缺失/空白构造抛 RangeError，且错误信息不回显输入', async () => {
  assert.throws(() => new StripePaymentProvider({ secretKey: '' }), RangeError)
  assert.throws(() => new StripePaymentProvider({ secretKey: '   ' }), RangeError)
  assert.throws(
    () => new StripePaymentProvider({} as unknown as { secretKey: string }),
    RangeError,
  )
  try {
    new StripePaymentProvider({ secretKey: '   ' })
  } catch (e) {
    assert.ok(!(e as Error).message.includes('sk_test'), '错误信息不得包含任何疑似密钥的字符串')
  }
  assert.throws(() => new StripePaymentProvider({ secretKey: FAKE_KEY, timeoutMs: 0 }), RangeError)
})

test('stripe: 上游回显敏感串 → reason 中 secretKey 被 [redacted] 过滤（绝不泄漏）', async (t) => {
  // mock 恶意把 Authorization 头回显进 error.message，验证 redact 兜底
  const mock = await startMockStripe(t, (req, res) =>
    jsonResponse(res, 402, { error: { message: `leak attempt: ${req.headers.authorization}` } }),
  )
  const provider = new StripePaymentProvider({ secretKey: FAKE_KEY, baseUrl: mock.url })

  const r = await provider.pay(makeOrder())
  assert.ok(!r.ok)
  assert.ok(!r.reason.includes(FAKE_KEY), 'reason 绝不能包含 secretKey')
  assert.ok(r.reason.includes('[redacted]'))
  assert.ok(r.reason.includes('leak attempt'))
})
