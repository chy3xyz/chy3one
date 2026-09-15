import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskBoard, TaskNotFoundError, type TaskBoardEvent } from './taskboard.js'
import { ConflictError, PermissionError } from '../errors.js'

test('taskboard: add/claim/complete 全生命周期与 stats', () => {
  let clock = 1000
  const board = new TaskBoard(() => clock)
  const t = board.addTask('写落地页文案')
  assert.equal(t.status, 'pending')
  assert.equal(t.version, 1)
  assert.equal(t.createdAt, 1000)
  assert.ok(t.id)

  const claimed = board.claim(t.id, 'alice', 1)
  assert.equal(claimed.status, 'claimed')
  assert.equal(claimed.claimedBy, 'alice')
  assert.equal(claimed.version, 2)

  clock += 5
  const done = board.complete(t.id, 'alice', '文案 v1 已交付', 2)
  assert.equal(done.status, 'done')
  assert.equal(done.result, '文案 v1 已交付')
  assert.equal(done.version, 3)
  assert.equal(done.updatedAt, 1005)
  assert.equal(done.createdAt, 1000)
  assert.deepEqual(board.stats(), { total: 1, pending: 0, claimed: 0, done: 1, blocked: 0 })
})

test('taskboard: block 任意状态可阻断并计入 stats，blocked 不可再认领', () => {
  const board = new TaskBoard()
  const a = board.addTask('任务A')
  board.claim(a.id, 'alice', 1)
  // claimed → blocked：保留 claimedBy，reason 存入 result
  const blockedA = board.block(a.id, 'orch', '需要人工确认预算', 2)
  assert.equal(blockedA.status, 'blocked')
  assert.equal(blockedA.claimedBy, 'alice')
  assert.equal(blockedA.result, '需要人工确认预算')
  assert.equal(blockedA.version, 3)

  const b = board.addTask('任务B')
  const blockedB = board.block(b.id, 'orch', '上游依赖缺失', 1)
  assert.equal(blockedB.status, 'blocked')
  assert.equal(blockedB.claimedBy, undefined)
  assert.equal(blockedB.version, 2)

  assert.throws(
    () => board.claim(b.id, 'bob', 2),
    (e: unknown) => e instanceof ConflictError && /status=blocked/.test((e as Error).message),
  )
  assert.deepEqual(board.stats(), { total: 2, pending: 0, claimed: 0, done: 0, blocked: 2 })
})

test('taskboard: 并发认领同一任务，仅 expectedVersion 匹配者成功', () => {
  const board = new TaskBoard()
  const t = board.addTask('投放开屏广告')

  // 两人都基于 version=1 同时发起认领：先到者成功，后到者 ConflictError 且带快照信息
  const aliceClaim = board.claim(t.id, 'alice', 1)
  assert.equal(aliceClaim.claimedBy, 'alice')
  assert.equal(aliceClaim.version, 2)
  assert.throws(
    () => board.claim(t.id, 'bob', 1),
    (e: unknown) =>
      e instanceof ConflictError &&
      /version conflict|not claimable/.test((e as Error).message) &&
      /claimedBy=alice/.test((e as Error).message),
  )

  // 反向：bob 先抢另一任务成功，alice 落败
  const t2 = board.addTask('投放信息流广告')
  board.claim(t2.id, 'bob', 1)
  assert.throws(() => board.claim(t2.id, 'alice', 1), ConflictError)

  // 纯版本过期路径：任务仍 pending，但 expectedVersion 过期
  const t3 = board.addTask('投放搜索广告')
  assert.throws(
    () => board.claim(t3.id, 'carol', 99),
    (e: unknown) => e instanceof ConflictError && /expected 99, current 1/.test((e as Error).message),
  )
  // 版本正确者随后仍可认领
  assert.equal(board.claim(t3.id, 'carol', 1).status, 'claimed')
  assert.deepEqual(board.stats(), { total: 3, pending: 0, claimed: 3, done: 0, blocked: 0 })
})

test('taskboard: 越权完成抛 PERMISSION_DENIED，认领者本人可完成', () => {
  const board = new TaskBoard()
  const t = board.addTask('做竞品调研')
  board.claim(t.id, 'alice', 1)
  assert.throws(
    () => board.complete(t.id, 'bob', '冒名交付', 2),
    (e: unknown) => e instanceof PermissionError && e.code === 'PERMISSION_DENIED',
  )
  // 越权后任务未被破坏，认领者仍可用原版本完成
  const done = board.complete(t.id, 'alice', '调研报告 v1', 2)
  assert.equal(done.status, 'done')
  // done 状态再完成 / 再认领均冲突
  assert.throws(() => board.complete(t.id, 'alice', '重复交付', 3), ConflictError)
  assert.throws(() => board.claim(t.id, 'bob', 3), ConflictError)
})

test('taskboard: 非法状态流转与任务不存在', () => {
  const board = new TaskBoard()
  const t = board.addTask('pending 任务')
  // pending 不能直接 complete
  assert.throws(
    () => board.complete(t.id, 'alice', 'x', 1),
    (e: unknown) => e instanceof ConflictError && /status=pending/.test((e as Error).message),
  )
  assert.throws(
    () => board.claim('no-such-task', 'alice', 1),
    (e: unknown) => e instanceof TaskNotFoundError && e.code === 'TASK_NOT_FOUND',
  )
  assert.throws(() => board.addTask('   '), TypeError)
  // addTask 清单级乐观锁：expectedListVersion 过期抛 ConflictError
  assert.throws(() => board.addTask('并发下发任务', 0), ConflictError)
  assert.equal(board.addTask('并发下发任务', 1).status, 'pending')
})

test('taskboard: onChange 事件序列与退订', () => {
  let clock = 0
  const board = new TaskBoard(() => clock)
  const events: TaskBoardEvent[] = []
  const off = board.onChange((e) => events.push(e))

  const a = board.addTask('任务A')
  board.claim(a.id, 'alice', 1)
  clock += 1
  board.complete(a.id, 'alice', 'ok', 2)
  const b = board.addTask('任务B')
  board.block(b.id, 'bob', '阻塞原因', 1)

  assert.deepEqual(
    events.map((e) => e.type),
    ['task_added', 'task_claimed', 'task_done', 'task_added', 'task_blocked'],
  )
  assert.equal(events[0].taskId, a.id)
  assert.equal(events[0].by, 'system')
  assert.equal(events[1].by, 'alice')
  assert.equal(events[1].taskId, a.id)
  assert.equal(events[2].by, 'alice')
  // 时钟在 complete 前 +1：前两个事件 at=0，其后均 at=1
  assert.equal(events[0].at, 0)
  assert.equal(events[1].at, 0)
  assert.equal(events[2].at, 1)
  assert.equal(events[3].at, 1)
  assert.equal(events[4].by, 'bob')
  assert.equal(events[4].taskId, b.id)
  assert.equal(events[4].at, 1)

  // 退订后不再收到事件
  off()
  board.addTask('任务C')
  assert.equal(events.length, 5)
  // 退订可重复调用（幂等）
  off()
  assert.equal(events.length, 5)
})

test('taskboard: snapshot→restore 后版本链延续', () => {
  const board = new TaskBoard()
  const t = board.addTask('部署官网')
  const snap = board.snapshot()
  assert.equal(snap.listVersion, 1)

  // 快照是拷贝：原板继续变更不影响快照内容
  board.claim(t.id, 'alice', 1)
  assert.equal(snap.tasks[0].status, 'pending')
  assert.equal(snap.tasks[0].version, 1)

  const restored = new TaskBoard()
  restored.restore(snap)
  assert.deepEqual(restored.stats(), { total: 1, pending: 1, claimed: 0, done: 0, blocked: 0 })
  // 用恢复出的 version=1 继续认领成功，版本链延续
  const claimed = restored.claim(t.id, 'carol', 1)
  assert.equal(claimed.version, 2)
  const done = restored.complete(t.id, 'carol', '已上线', 2)
  assert.equal(done.version, 3)

  // 更深版本链：claim 后快照，restore 后凭恢复版本直接 complete
  const board2 = new TaskBoard()
  const t2 = board2.addTask('投放广告')
  board2.claim(t2.id, 'alice', 1)
  const board3 = new TaskBoard()
  board3.restore(board2.snapshot())
  const done2 = board3.complete(t2.id, 'alice', 'ROI 1.8', 2)
  assert.equal(done2.version, 3)
  assert.equal(board3.listVersion, 3)

  // 非法快照拒绝恢复
  assert.throws(() => board3.restore(undefined as unknown as Parameters<TaskBoard['restore']>[0]), TypeError)
  assert.throws(() => board3.restore({ tasks: 'nope', listVersion: 0, savedAt: 0 } as unknown as Parameters<TaskBoard['restore']>[0]), TypeError)
})

test('taskboard: 批量 50 任务 add/claim/complete 无丢失', () => {
  const board = new TaskBoard()
  const members = ['alice', 'bob', 'carol', 'dave', 'erin']
  const tasks = Array.from({ length: 50 }, (_, i) => board.addTask(`任务-${i}`))
  assert.equal(tasks.length, 50)
  assert.equal(new Set(tasks.map((t) => t.id)).size, 50)

  tasks.forEach((t, i) => {
    const claimed = board.claim(t.id, members[i % members.length], 1)
    assert.equal(claimed.version, 2)
    assert.equal(claimed.claimedBy, members[i % members.length])
  })
  assert.deepEqual(board.stats(), { total: 50, pending: 0, claimed: 50, done: 0, blocked: 0 })

  tasks.forEach((t, i) => {
    const done = board.complete(t.id, members[i % members.length], `result-${i}`, 2)
    assert.equal(done.version, 3)
  })
  assert.deepEqual(board.stats(), { total: 50, pending: 0, claimed: 0, done: 50, blocked: 0 })

  const list = board.list()
  assert.equal(list.length, 50)
  for (let i = 0; i < list.length; i++) {
    assert.equal(list[i].title, `任务-${i}`) // createdAt 相同（测试钟不动）→ 稳定保持创建顺序
    assert.equal(list[i].claimedBy, members[i % members.length])
    assert.equal(list[i].result, `result-${i}`)
    assert.equal(list[i].version, 3)
    if (i > 0) assert.ok(list[i].createdAt >= list[i - 1].createdAt)
  }
  assert.equal(board.listVersion, 150) // 50 add + 50 claim + 50 complete
})
