import { randomUUID } from 'node:crypto'
import { OpcError, PermissionError, ConflictError } from '../errors.js'

export type TaskStatus = 'pending' | 'claimed' | 'done' | 'blocked'

export interface Task {
  id: string
  title: string
  status: TaskStatus
  /** 认领者；blocked 任务保留原认领者供审计 */
  claimedBy?: string
  /** done 存放交付结果；blocked 存放阻断原因 */
  result?: string
  createdAt: number
  updatedAt: number
  /** 乐观锁版本号，从 1 起；每次状态变更 +1 */
  version: number
}

export type TaskBoardEventType = 'task_added' | 'task_claimed' | 'task_done' | 'task_blocked'

export interface TaskBoardEvent {
  type: TaskBoardEventType
  taskId: string
  /** task_added 固定为 'system'（addTask 不携带成员身份） */
  by: string
  at: number
}

export interface TaskBoardSnapshot {
  tasks: Task[]
  /** 清单级版本，随任意变更 +1；供 addTask 的 expectedListVersion 乐观锁使用 */
  listVersion: number
  savedAt: number
}

export class TaskNotFoundError extends OpcError {
  constructor(taskId: string) {
    super('TASK_NOT_FOUND', `task ${taskId} not found`)
  }
}

/**
 * 共享任务板（PRD 6.2 AS-04）：全队认领同一份清单，任务状态实时同步（<2s，
 * 进程内形态即 onChange 事件推送）。并发语义对齐黑板 ARD-002：每次写入携带
 * expectedVersion 乐观锁，冲突抛 ConflictError；越权完成抛 PermissionError。
 * 内存实现，跨重启由调用方经 snapshot/restore 持久化（与黑板插件分层一致，
 * Phase 3 换 SQLite WAL，TD-01）。
 */
export class TaskBoard {
  private tasks = new Map<string, Task>()
  private _listVersion = 0
  private listeners = new Set<(event: TaskBoardEvent) => void>()
  private now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** 清单级版本：任意变更（add/claim/complete/block）都会使其 +1 */
  get listVersion(): number {
    return this._listVersion
  }

  /**
   * 新增 pending 任务（版本从 1 起）。
   * @param expectedListVersion 调用方所见的清单级版本；不匹配抛 ConflictError，
   *                            省略表示不校验（用于编排器防并发重复下发）。
   */
  addTask(title: string, expectedListVersion?: number): Task {
    if (typeof title !== 'string' || title.trim() === '') {
      throw new TypeError('task title must be a non-empty string')
    }
    if (expectedListVersion !== undefined && expectedListVersion !== this._listVersion) {
      throw new ConflictError(
        `list version conflict: expected ${expectedListVersion}, current ${this._listVersion}`,
      )
    }
    const ts = this.now()
    const task: Task = {
      id: randomUUID(),
      title,
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
      version: 1,
    }
    this.tasks.set(task.id, task)
    this._listVersion++
    this.emit('task_added', task.id, 'system')
    return { ...task }
  }

  /** 任务清单，按 createdAt 升序（同刻按创建顺序稳定排序） */
  list(): Task[] {
    return [...this.tasks.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => ({ ...t }))
  }

  /** 认领：pending→claimed 并记录 claimedBy；非 pending 或版本过期抛 ConflictError（附当前任务快照） */
  claim(taskId: string, member: string, expectedVersion: number): Task {
    const task = this.mustGet(taskId)
    if (task.status !== 'pending') {
      throw new ConflictError(
        `task ${taskId} is not claimable (status=${task.status}, claimedBy=${task.claimedBy ?? 'none'}, version=${task.version})`,
      )
    }
    if (task.version !== expectedVersion) {
      throw new ConflictError(
        `task ${taskId} version conflict: expected ${expectedVersion}, current ${task.version}`,
      )
    }
    const updated: Task = {
      ...task,
      status: 'claimed',
      claimedBy: member,
      updatedAt: this.now(),
      version: task.version + 1,
    }
    this.tasks.set(taskId, updated)
    this._listVersion++
    this.emit('task_claimed', taskId, member)
    return { ...updated }
  }

  /** 完成：claimed→done；仅认领者本人可完成（他人代完成抛 PERMISSION_DENIED） */
  complete(taskId: string, member: string, result: string, expectedVersion: number): Task {
    const task = this.mustGet(taskId)
    if (task.status !== 'claimed') {
      throw new ConflictError(
        `task ${taskId} is not completable (status=${task.status}, claimedBy=${task.claimedBy ?? 'none'}, version=${task.version})`,
      )
    }
    if (task.claimedBy !== member) {
      throw new PermissionError(
        `task ${taskId} is claimed by ${task.claimedBy}; only the claimer can complete it (member=${member})`,
      )
    }
    if (task.version !== expectedVersion) {
      throw new ConflictError(
        `task ${taskId} version conflict: expected ${expectedVersion}, current ${task.version}`,
      )
    }
    const updated: Task = {
      ...task,
      status: 'done',
      result,
      updatedAt: this.now(),
      version: task.version + 1,
    }
    this.tasks.set(taskId, updated)
    this._listVersion++
    this.emit('task_done', taskId, member)
    return { ...updated }
  }

  /** 阻断：任意状态→blocked，原因存入 result（claimedBy 保留供审计）；需人工介入（PRD 6.2.3）走此路径 */
  block(taskId: string, member: string, reason: string, expectedVersion: number): Task {
    const task = this.mustGet(taskId)
    if (task.version !== expectedVersion) {
      throw new ConflictError(
        `task ${taskId} version conflict: expected ${expectedVersion}, current ${task.version}`,
      )
    }
    const updated: Task = {
      ...task,
      status: 'blocked',
      result: reason,
      updatedAt: this.now(),
      version: task.version + 1,
    }
    this.tasks.set(taskId, updated)
    this._listVersion++
    this.emit('task_blocked', taskId, member)
    return { ...updated }
  }

  stats(): { total: number; pending: number; claimed: number; done: number; blocked: number } {
    const s = { total: 0, pending: 0, claimed: 0, done: 0, blocked: 0 }
    for (const t of this.tasks.values()) {
      s.total++
      s[t.status]++
    }
    return s
  }

  /**
   * 注册状态变更监听（"状态实时同步"的进程内形态；跨进程由上层插件桥接）。
   * 事件在状态变更落定后同步派发，返回退订函数。
   */
  onChange(fn: (event: TaskBoardEvent) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** JSON 可序列化快照；深拷贝，后续变更不影响快照。落盘由调用方负责 */
  snapshot(): TaskBoardSnapshot {
    return { tasks: this.list(), listVersion: this._listVersion, savedAt: this.now() }
  }

  /** 恢复快照：任务版本与清单版本原样延续，restore 后可凭恢复出的 version 继续乐观锁写入 */
  restore(snapshot: TaskBoardSnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.tasks) || typeof snapshot.listVersion !== 'number') {
      throw new TypeError('invalid TaskBoard snapshot')
    }
    this.tasks = new Map(snapshot.tasks.map((t) => [t.id, { ...t }]))
    this._listVersion = snapshot.listVersion
  }

  private mustGet(taskId: string): Task {
    const task = this.tasks.get(taskId)
    if (!task) throw new TaskNotFoundError(taskId)
    return task
  }

  private emit(type: TaskBoardEventType, taskId: string, by: string): void {
    const event: TaskBoardEvent = { type, taskId, by, at: this.now() }
    for (const fn of [...this.listeners]) fn(event)
  }
}
