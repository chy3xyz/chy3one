import { randomUUID } from 'node:crypto'
import type { IdeaMemoryStream } from '../idea/types.js'
import type { MemoryCategory, MemoryEntry, MemoryQuery, MemoryStore, NewMemoryEntry } from './memory.js'
import type { MemoryBodyHub } from './memory-body.js'

/**
 * 创意记忆体 ↔ MemoryStore 桥（CO-02 每创意人设隔离，prd2.md 4.2）：
 * 把某创意的记忆体（MemoryBodyHub 单体视图）适配为 Content Pipeline 的
 * MemoryStore 形状——人设/选题/沉淀读写全部落在该创意的记忆体流内，
 * 创意A与创意B的人设互不可见。
 *
 * v1 七类 category → 记忆体流映射（语义就近）：
 *   topic/soul/rules/project → description（描述与人设）
 *   fact → facts（品牌事实库，GEO 事实源）
 *   lesson → model-notes（经验教训）
 *   user → users（受众）
 */
const CATEGORY_TO_STREAM: Readonly<Record<MemoryCategory, IdeaMemoryStream>> = {
  topic: 'description',
  soul: 'description',
  rules: 'description',
  project: 'description',
  fact: 'facts',
  lesson: 'model-notes',
  user: 'users',
}

export class IdeaMemoryBridge implements MemoryStore {
  constructor(
    private readonly hub: MemoryBodyHub,
    private readonly ideaId: string,
  ) {}

  /** v1 类别 → 记忆体流（桥接映射的唯一出口，测试与观测用） */
  static streamOf(category: MemoryCategory): IdeaMemoryStream {
    return CATEGORY_TO_STREAM[category]
  }

  /** Pipeline 沉淀写入（fact/lesson 等）→ 记忆体流，authority=model（系统自动沉淀） */
  write(entry: NewMemoryEntry): MemoryEntry {
    const written = this.hub.write(this.ideaId, CATEGORY_TO_STREAM[entry.category], {
      content: entry.content,
      confidence: entry.confidence,
      authority: 'model',
    })
    return this.toMemoryEntry(written, entry.category)
  }

  /** Pipeline 检索（topic/soul/fact/rules…）→ 记忆体流过滤检索（限单体，天然隔离） */
  query(criteria: MemoryQuery): MemoryEntry[] {
    const stream = criteria.category ? CATEGORY_TO_STREAM[criteria.category] : undefined
    const entries = this.hub.query({
      keyword: criteria.keyword,
      ideaIds: [this.ideaId],
      stream,
      limit: criteria.limit ?? 10,
    })
    // 流可能承载多个 v1 类别（description ← topic/soul/rules/project）：
    // 按 content 无法反解类别，统一以请求类别标注（pipeline 按类别查询的语义不变）
    return entries.map((entry) => this.toMemoryEntry(entry, criteria.category ?? this.defaultCategory(stream)))
  }

  private defaultCategory(stream: IdeaMemoryStream | undefined): MemoryCategory {
    switch (stream) {
      case 'facts': return 'fact'
      case 'users': return 'user'
      case 'model-notes': return 'lesson'
      case 'research': return 'project'
      default: return 'topic'
    }
  }

  private toMemoryEntry(entry: { id: string; content: string; confidence: number; createdAt: number }, category: MemoryCategory): MemoryEntry {
    return {
      id: entry.id ?? randomUUID(),
      scope: 'global',
      category,
      content: entry.content,
      confidence: entry.confidence,
      createdAt: entry.createdAt,
    }
  }
}
