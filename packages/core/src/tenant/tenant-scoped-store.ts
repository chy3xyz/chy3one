import { PermissionError } from '../errors.js'
import type { MemoryEntry, MemoryQuery, MemoryStore, NewMemoryEntry } from '../memory/memory.js'

/**
 * 落盘条目附加的租户标记：MemoryEntry 结构本身不带 tenant 字段（AR-S04 补充说明的
 * "tenant_id 列"），此处通过结构化附加属性实现——JSONL 序列化后天然随条目持久化。
 */
interface TenantTag {
  tenant?: string
}

const tenantOf = (entry: MemoryEntry): string | undefined => (entry as MemoryEntry & TenantTag).tenant

/**
 * 租户隔离存储包装器（AR-S04 / DE-01）：包装任意 MemoryStore，写入时强制打上
 * 本租户标记（global scope 拒写，租户不可污染全局），查询时强制追加租户过滤——
 * 未打标记（旁路直写 inner）的条目同样不可见，保证 fail-closed：
 * 租户 A 写入的数据租户 B 查询绝对不可见。
 */
export class TenantScopedMemoryStore implements MemoryStore {
  constructor(
    private readonly inner: MemoryStore,
    private readonly tenantId: string,
  ) {}

  write(entry: NewMemoryEntry): MemoryEntry {
    if (entry.scope === 'global') {
      throw new PermissionError(`tenant '${this.tenantId}' is not allowed to write global scope`)
    }
    // 经中间变量规避 TS 对象字面量的多余属性检查；tenant 标记随条目序列化落盘
    const tagged: NewMemoryEntry & TenantTag = { ...entry, tenant: this.tenantId }
    return this.inner.write(tagged)
  }

  query(criteria: MemoryQuery): MemoryEntry[] {
    const limit = criteria.limit ?? 10
    // 先以大 limit 取回内层全部候选，再套租户过滤并截断，
    // 避免内层先按 limit 截断导致跨租户条目挤占本租户结果
    return this.inner
      .query({ ...criteria, limit: Number.MAX_SAFE_INTEGER })
      .filter((e) => tenantOf(e) === this.tenantId)
      .slice(0, limit)
  }
}
