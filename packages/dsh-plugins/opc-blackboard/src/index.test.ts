import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name, plugin } from './index.js'
import { createMockContext, type TelemetryBus, type TelemetryEvent } from '../../../dsh-adapter/src/index.js'
import { PermissionError } from '../../../core/src/index.js'

test('plugin: 持久化保存与重启恢复（AC-03 共享数据重启不丢失）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-blackboard-'))
  const persistFile = join(dir, 'blackboard.json')
  try {
    {
      const ctx = createMockContext()
      apply(ctx, { persistFile })
      const bb = ctx.getService('opc.blackboard') as {
        write(op: Record<string, unknown>): { status: string; entry?: { version: number } }
      }
      const r1 = bb.write({
        scope: 'workflow', key: 'task-state', value: { step: 1 },
        writer: 'agent-a', role: 'agent', expectedVersion: 0,
      })
      assert.equal(r1.status, 'ok')
      bb.write({
        scope: 'workflow', key: 'task-state', value: { step: 2 },
        writer: 'agent-b', role: 'agent', expectedVersion: 1,
      })
      assert.ok(existsSync(persistFile), '成功写入后应落盘全量快照')
    }
    // 模拟重启：新插件实例从快照恢复
    const ctx2 = createMockContext()
    apply(ctx2, { persistFile })
    const bb2 = ctx2.getService('opc.blackboard') as {
      read(scope: string, key: string): Array<{ version: number; value: unknown }>
    }
    const restored = bb2.read('workflow', 'task-state')
    assert.equal(restored.length, 1)
    assert.equal(restored[0].version, 2, '恢复后应重放到最新版本')
    assert.deepEqual(restored[0].value, { step: 2 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('plugin: global 越权写抛 PermissionError', () => {
  const ctx = createMockContext()
  apply(ctx, {})
  const bb = ctx.getService('opc.blackboard') as {
    write(op: Record<string, unknown>): unknown
  }
  assert.throws(
    () =>
      bb.write({
        scope: 'global', key: 'policy', value: 'x',
        writer: 'agent-a', role: 'agent', expectedVersion: 0,
      }),
    PermissionError,
  )
})

test('plugin: blackboard/write 事件入口返回 WriteResult 且订阅方收到埋点', () => {
  const ctx = createMockContext()
  apply(ctx, {})
  const bus = ctx.getService('opc.blackboard.events') as TelemetryBus
  const received: TelemetryEvent[] = []
  bus.subscribe((event) => received.push(event))

  const result = ctx.dispatch('blackboard/write', {
    scope: 'workflow', key: 'handoff', value: { answer: 42 },
    writer: 'agent-a', role: 'agent', expectedVersion: 0,
  }) as { status: string; entry: { version: number } }

  assert.equal(result.status, 'ok')
  assert.equal(result.entry.version, 1)
  assert.equal(received.length, 1)
  assert.equal(received[0].type, 'blackboard_write')
  assert.equal(received[0].payload!.agentId, 'agent-a')
  assert.equal(received[0].payload!.scope, 'workflow')
  assert.ok((received[0].payload!.dataSize as number) > 0)
  assert.ok(Number.isFinite(received[0].timestamp))
  assert.equal(name, 'opc-blackboard')
  assert.equal(plugin.name, 'opc-blackboard') // cordis Plugin.Function 元数据
})

test('plugin: 退订后不再收到埋点（TD-04 统一 subscribe 约定）', () => {
  const ctx = createMockContext()
  apply(ctx, {})
  const bus = ctx.getService('opc.blackboard.events') as TelemetryBus
  const bb = ctx.getService('opc.blackboard') as { write(op: Record<string, unknown>): { status: string } }
  const received: TelemetryEvent[] = []
  const unsubscribe = bus.subscribe((event) => received.push(event))
  unsubscribe()
  bb.write({
    scope: 'workflow', key: 'handoff', value: { answer: 42 },
    writer: 'agent-a', role: 'agent', expectedVersion: 0,
  })
  assert.equal(received.length, 0)
})

test('plugin: 卸载时清理副作用（AC-07）', () => {
  const ctx = createMockContext()
  apply(ctx, {})
  assert.ok(ctx.services.has('opc.blackboard'))
  ctx.unload() // LIFO 逆序执行清理：版本链镜像清空，服务注册表一并撤销（events 服务同）
  assert.equal(ctx.getService('opc.blackboard'), undefined)
})
