import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { OpcError } from '../errors.js'
import type { IdeaMemoryStream } from '../idea/types.js'
import { MemoryBodyIndex, requireStream, type BodyEntry, type BodyQuery, type BodyWrite } from './body-index.js'

export type { BodyEntry, BodyQuery, BodyWrite }

/**
 * 创意记忆体枢纽（prd2.md 2.4 / 8.3）：
 * - 写入：JSONL append-only 正本（ideas/<id>/memory-body/<stream>.jsonl，AR-R03 零丢失）
 *   + FTS5 检索镜像（MemoryBodyIndex）；
 * - 挂载：会话级挂载集合（mount/unmount），query 默认只检索已挂载记忆体——
 *   "处理创意A时创意B的记忆不会被检索到"（prd2.md 2.4 挂载机制）。
 * 显式传 ideaIds 的查询（如创意详情页内检索）绕过挂载集合，属于直接点名访问。
 */
export class MemoryBodyHub {
  /** 会话级挂载集合（插入序，控制台展示按挂载顺序） */
  private readonly mounted = new Set<string>()

  constructor(
    private readonly ideasRoot: string,
    private readonly index: MemoryBodyIndex,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 写入记忆体：正本落 JSONL，索引随后镜像。创意目录不存在抛 IDEA_NOT_FOUND
   * （写入必须先有创意——记忆体跟随创意初始化，不做隐式创建）。
   */
  write(ideaId: string, stream: string, body: BodyWrite): BodyEntry {
    const validatedStream = requireStream(stream)
    const ideaDir = join(this.ideasRoot, ideaId)
    const file = join(ideaDir, 'memory-body', `${validatedStream}.jsonl`)
    if (!existsSync(file)) {
      throw new OpcError('IDEA_NOT_FOUND', `memory body for ${ideaId} does not exist (idea not initialized?)`)
    }
    if (body.confidence < 0 || body.confidence > 1) {
      throw new RangeError('confidence must be within [0,1]')
    }
    const entry: BodyEntry = {
      id: randomUUID(),
      ideaId,
      stream: validatedStream,
      authority: body.authority ?? 'user',
      content: body.content,
      confidence: body.confidence,
      createdAt: this.now(),
    }
    appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 })
    this.index.append(entry)
    return entry
  }

  /** 重放某创意某流的 JSONL 正本（append-only 源头，检索镜像损坏时的恢复依据） */
  readStream(ideaId: string, stream: IdeaMemoryStream): BodyEntry[] {
    const file = join(this.ideasRoot, ideaId, 'memory-body', `${stream}.jsonl`)
    if (!existsSync(file)) return []
    const entries: BodyEntry[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      entries.push(JSON.parse(line) as BodyEntry)
    }
    return entries
  }

  /* ─────────────── 挂载协议（prd2.md 8.3 挂载协议） ─────────────── */

  /** 挂载一个或多个记忆体（/mount <idea-id>...）；未初始化的创意拒绝挂载 */
  mount(...ideaIds: string[]): string[] {
    for (const ideaId of ideaIds) {
      if (!existsSync(join(this.ideasRoot, ideaId, 'memory-body'))) {
        throw new OpcError('IDEA_NOT_FOUND', `cannot mount ${ideaId}: memory body does not exist`)
      }
      this.mounted.add(ideaId)
    }
    return this.listMounted()
  }

  /** 卸载（/unmount <idea-id>）；未挂载的 id 静默忽略（幂等） */
  unmount(...ideaIds: string[]): string[] {
    for (const ideaId of ideaIds) this.mounted.delete(ideaId)
    return this.listMounted()
  }

  /** 当前挂载清单（插入序） */
  listMounted(): string[] {
    return [...this.mounted]
  }

  isMounted(ideaId: string): boolean {
    return this.mounted.has(ideaId)
  }

  /**
   * 跨记忆体检索（默认限定已挂载集合）；显式 ideaIds 覆盖挂载集合
   * （创意详情页单体内检索）。两者皆空 → 空结果（不挂载不检索）。
   */
  query(criteria: Omit<BodyQuery, 'ideaIds'> & { ideaIds?: readonly string[] }): BodyEntry[] {
    const ideaIds = criteria.ideaIds ?? this.listMounted()
    return this.index.query({ ...criteria, ideaIds })
  }
}
