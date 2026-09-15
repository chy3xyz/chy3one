/**
 * Bundle 启动健康握手测试（真实 cordis 4.x 运行时，非 mock；写法对齐
 * packages/dsh-plugins/cordis-runtime.test.ts）：
 * - 五插件经 loadWithHandshake 全部装载成功（五个具名服务可 get）；
 * - 必抛错插件（defineOpcPlugin 的 apply 直接 throw）被隔离（quarantined），
 *   其余插件不受影响，隔离清单内容正确（JSON + 0600 + 按名去重）；
 * - 二次启动：上次 lastBootUnhealthy marker 存在 + criticalNames=['opc-billing']
 *   → 只装载 opc-billing，抛错插件与无关插件被 skipped（AR-R02）；
 * - 每个用例清理 tmpdir（t.after rmSync）与 cordis fiber（dispose / registry.delete）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineOpcPlugin } from '../../dsh-adapter/src/index.js'
import {
  DEFAULT_MARKER_FILE,
  DEFAULT_QUARANTINE_FILE,
  guardedLoad,
  loadWithHandshake,
  type HandshakeOutcome,
} from './health.js'
import { plugin as billingPlugin } from '../../dsh-plugins/opc-billing/src/index.js'
import { plugin as memoryPlugin } from '../../dsh-plugins/opc-memory/src/index.js'
import { plugin as blackboardPlugin } from '../../dsh-plugins/opc-blackboard/src/index.js'
import { plugin as skillForgePlugin } from '../../dsh-plugins/opc-skill-forge/src/index.js'
import { plugin as teamPlugin } from '../../dsh-plugins/opc-team/src/index.js'

interface Cordis4ContextLike {
  plugin(p: unknown, ...args: unknown[]): { dispose: () => Promise<void> } & PromiseLike<unknown>
  get(name: string, strict?: boolean): unknown
  registry: { delete(plugin: unknown): unknown }
}

async function loadCordis(): Promise<new () => Cordis4ContextLike> {
  const mod = (await import('@deepseek-ai/cordis')) as { Context: new () => Cordis4ContextLike }
  return mod.Context
}

/** 必抛错插件：apply 直接 throw（AR-R02 故障注入） */
const brokenPlugin = defineOpcPlugin({
  name: 'opc-broken',
  defaultConfig: {},
  apply() {
    throw new Error('boom: opc-broken startup failure')
  },
})

/** 每个用例独立的 tmpdir 与健康文件路径；t.after 统一清理 */
function makeHealthDir(t: TestContext): { dir: string; quarantineFile: string; markerFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'opcos-bundle-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, quarantineFile: join(dir, 'quarantine.json'), markerFile: join(dir, 'marker.json') }
}

/** dispose 所有装载成功的 fiber（quarantined 项的 fiber 由 registry.delete 清理） */
async function disposeOutcomes(outcomes: HandshakeOutcome[]): Promise<void> {
  await Promise.all(
    outcomes.map((o) => (o.status === 'loaded' && o.fiber ? o.fiber.dispose() : Promise.resolve())),
  )
}

test('handshake: 五插件经 loadWithHandshake 全部装载成功（服务可 get）', async (t) => {
  const { dir, quarantineFile, markerFile } = makeHealthDir(t)
  const Context = await loadCordis()
  const ctx = new Context()

  const report = await loadWithHandshake(
    ctx,
    [
      { plugin: billingPlugin, config: { resolvedUnitPrice: 3 } },
      {
        plugin: memoryPlugin,
        config: { memoriesFile: join(dir, 'memories.jsonl'), instinctsFile: join(dir, 'instincts.jsonl') },
      },
      { plugin: blackboardPlugin },
      { plugin: skillForgePlugin },
      { plugin: teamPlugin },
    ],
    { quarantineFile, markerFile },
  )

  assert.equal(report.degradedBoot, false)
  assert.equal(report.allFailed, false)
  assert.deepEqual(
    report.outcomes.map((o) => [o.name, o.status]),
    [
      ['opc-billing', 'loaded'],
      ['opc-memory', 'loaded'],
      ['opc-blackboard', 'loaded'],
      ['opc-skill-forge', 'loaded'],
      ['opc-team', 'loaded'],
    ],
  )

  // 五个具名服务在真实 cordis 上全部可解析
  for (const service of ['opc.billing', 'opc.memory', 'opc.blackboard', 'opc.skillforge', 'opc.team']) {
    assert.ok(ctx.get(service), `service ${service} should be provided`)
  }

  // config 经握手透传：resolvedUnitPrice=3 生效（结算额 = 单价 × 1 个 resolved 任务）
  const complete = ctx.get('opc.billing.complete') as (
    e: { taskId: string; agentId: string; resolution: 'resolved' },
  ) => { amount: number }
  assert.equal(complete({ taskId: 'boot-1', agentId: 'acme', resolution: 'resolved' }).amount, 3)

  // 健康轮：不产生隔离清单；marker 落为 lastBootUnhealthy: false
  assert.equal(existsSync(quarantineFile), false)
  assert.deepEqual(JSON.parse(readFileSync(markerFile, 'utf8')), { lastBootUnhealthy: false })

  await disposeOutcomes(report.outcomes)
  // 五个服务 dispose 后撤销（副作用隔离）
  assert.equal(ctx.get('opc.billing'), undefined)
  assert.equal(ctx.get('opc.team'), undefined)
})

test('handshake: 必抛错插件被隔离，其余插件不受影响，隔离清单正确', async (t) => {
  const { quarantineFile, markerFile } = makeHealthDir(t)
  const Context = await loadCordis()
  const ctx = new Context()

  const report = await loadWithHandshake(
    ctx,
    [
      { plugin: brokenPlugin }, // 排最前：证明其失败不阻断后续装载
      { plugin: billingPlugin },
      { plugin: memoryPlugin },
    ],
    { quarantineFile, markerFile },
  )

  const [broken, billing, memory] = report.outcomes
  assert.equal(broken?.status, 'quarantined')
  assert.ok(broken?.error instanceof Error)
  assert.match((broken?.error as Error).message, /boom/)
  assert.equal(billing?.status, 'loaded')
  assert.equal(memory?.status, 'loaded')

  // 故障隔离：失败插件的错误不外溢，其余服务正常可用
  assert.ok(ctx.get('opc.billing'))
  assert.ok(ctx.get('opc.memory'))

  // 隔离清单：JSON、仅含该插件名、权限 0600
  assert.deepEqual(JSON.parse(readFileSync(quarantineFile, 'utf8')), {
    version: 1,
    quarantined: ['opc-broken'],
  })
  assert.equal(statSync(quarantineFile).mode & 0o777, 0o600)

  // 未全失败 → 不标记不健康（marker 为 false）
  assert.equal(report.allFailed, false)
  assert.deepEqual(JSON.parse(readFileSync(markerFile, 'utf8')), { lastBootUnhealthy: false })

  // 同名插件重复隔离：清单按名去重
  const again = await guardedLoad(ctx, brokenPlugin, undefined, { quarantineFile })
  assert.equal(again.ok, false)
  assert.deepEqual(JSON.parse(readFileSync(quarantineFile, 'utf8')), {
    version: 1,
    quarantined: ['opc-broken'],
  })

  await disposeOutcomes(report.outcomes)
  // 清理 FAILED fiber（guardedLoad 失败返回值不含 fiber，经 registry 撤销）
  ctx.registry.delete(brokenPlugin)
})

test('handshake: 上次启动不健康 → 降级轮只装载 criticalNames（AR-R02）', async (t) => {
  const { quarantineFile, markerFile } = makeHealthDir(t)
  const Context = await loadCordis()

  // 第一次启动：唯一插件必抛错 → 本轮全部失败 → marker 记 lastBootUnhealthy: true
  const ctx1 = new Context()
  const boot1 = await loadWithHandshake(ctx1, [{ plugin: brokenPlugin }], {
    quarantineFile,
    markerFile,
  })
  assert.equal(boot1.allFailed, true)
  assert.deepEqual(JSON.parse(readFileSync(markerFile, 'utf8')), { lastBootUnhealthy: true })
  assert.deepEqual(JSON.parse(readFileSync(quarantineFile, 'utf8')), {
    version: 1,
    quarantined: ['opc-broken'],
  })
  ctx1.registry.delete(brokenPlugin)

  // 第二次启动（模拟进程重启：全新 Context，沿用同一 marker/隔离文件）：
  // 上次不健康 → 只装载 criticalNames=['opc-billing']，
  // 抛错插件与无关插件全部 skipped，保证宿主可回（AR-R02）。
  const ctx2 = new Context()
  const boot2 = await loadWithHandshake(
    ctx2,
    [{ plugin: brokenPlugin }, { plugin: memoryPlugin }, { plugin: billingPlugin }],
    { quarantineFile, markerFile, criticalNames: ['opc-billing'] },
  )
  assert.equal(boot2.degradedBoot, true)
  assert.deepEqual(boot2.criticalNames, ['opc-billing'])
  assert.deepEqual(
    boot2.outcomes.map((o) => [o.name, o.status]),
    [
      ['opc-broken', 'skipped'],
      ['opc-memory', 'skipped'],
      ['opc-billing', 'loaded'],
    ],
  )
  assert.ok(ctx2.get('opc.billing'), 'critical 项 opc-billing 应装载')
  assert.equal(ctx2.get('opc.memory'), undefined, '降级轮无关插件不装载')
  assert.equal(ctx2.get('opc.team'), undefined)

  // 降级轮装载成功 → marker 自愈为 false，下一轮恢复全量尝试
  assert.equal(boot2.allFailed, false)
  assert.deepEqual(JSON.parse(readFileSync(markerFile, 'utf8')), { lastBootUnhealthy: false })

  await disposeOutcomes(boot2.outcomes)
})

test('handshake: 默认健康文件路径与降级轮空 criticalNames 的 marker 语义', async (t) => {
  // 默认路径契约（测试内不写默认路径，避免污染仓库 cwd）
  assert.equal(DEFAULT_QUARANTINE_FILE, './opcos-quarantine.json')
  assert.equal(DEFAULT_MARKER_FILE, './opcos-boot-marker.json')

  const { quarantineFile, markerFile } = makeHealthDir(t)
  const Context = await loadCordis()

  // 先制造 lastBootUnhealthy marker
  const ctx1 = new Context()
  await loadWithHandshake(ctx1, [{ plugin: brokenPlugin }], { quarantineFile, markerFile })
  ctx1.registry.delete(brokenPlugin)

  // 降级轮 criticalNames 为空（默认）：无选中项 → 不改写 marker，保持降级
  const ctx2 = new Context()
  const boot = await loadWithHandshake(ctx2, [{ plugin: billingPlugin }], {
    quarantineFile,
    markerFile,
    criticalNames: [],
  })
  assert.equal(boot.degradedBoot, true)
  assert.deepEqual(
    boot.outcomes.map((o) => [o.name, o.status]),
    [['opc-billing', 'skipped']],
  )
  assert.equal(boot.allFailed, false)
  assert.deepEqual(JSON.parse(readFileSync(markerFile, 'utf8')), { lastBootUnhealthy: true })
})
