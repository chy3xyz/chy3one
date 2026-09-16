import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { OpcError } from '../errors.js'
import { draftThreeDomains, deriveIdeaName } from './three-domains.js'
import {
  IDEA_MEMORY_STREAMS,
  IDEA_STAGES,
  validateDomains,
  type DomainKey,
  type IdeaStage,
  type ThreeDomains,
} from './types.js'

/** 创意一等公民（prd2.md 1.3）：全局唯一 ID + 名称 + 阶段 + 三域 */
export interface Idea {
  id: string
  name: string
  stage: IdeaStage
  domains: ThreeDomains
  createdAt: number
  updatedAt: number
}

export interface NewIdeaInput {
  /** 自然语言创意描述（ID-01：录入即生成三域草案） */
  text: string
  /** 创意名；缺省从描述派生（前 16 字符） */
  name?: string
}

interface IdeaRow {
  id: string
  name: string
  stage: string
  domains_json: string
  created_at: number
  updated_at: number
}

function rowToIdea(row: IdeaRow): Idea {
  return {
    id: row.id,
    name: row.name,
    stage: row.stage as IdeaStage,
    domains: JSON.parse(row.domains_json) as ThreeDomains,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** YAML 双引号标量转义（profile/cordis.patch.yml 生成用，零 YAML 依赖） */
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * ID-03 创意初始化：落创意目录脚手架（prd2.md 2.4 目录结构）——
 * memory-body 七个 append-only JSONL 正本、assets 账本与 Token 配置、
 * 子操作系统 profile、meta 元数据镜像。目录已存在时跳过（幂等，成功率 100%）。
 */
export function scaffoldIdeaHome(ideasRoot: string, idea: Idea): string {
  const home = join(ideasRoot, idea.id)
  for (const stream of IDEA_MEMORY_STREAMS) {
    const file = join(home, 'memory-body', `${stream}.jsonl`)
    if (!existsSync(file)) {
      mkdirSync(join(home, 'memory-body'), { recursive: true, mode: 0o700 })
      writeFileSync(file, '', { mode: 0o600 })
    }
  }
  mkdirSync(join(home, 'assets'), { recursive: true, mode: 0o700 })
  mkdirSync(join(home, 'profile'), { recursive: true, mode: 0o700 })

  const ledgerFile = join(home, 'assets', 'ledger.json')
  if (!existsSync(ledgerFile)) {
    // 五类资产账本初始形态（prd2.md 5.5）
    writeFileSync(
      ledgerFile,
      JSON.stringify(
        {
          idea_id: idea.id,
          assets: {
            skills: [],
            tokens: { total_supply: 1_000_000, distributed: 0, holders: 0 },
            finance: { product_revenue: 0, subscription_revenue: 0, skill_revenue: 0, total: 0 },
            users: { total: 0, active_30d: 0, paying: 0 },
            analytics: { geo_visibility: 0, content_engagement: 0, conversion_rate: 0 },
          },
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )
  }

  const tokenFile = join(home, 'assets', 'token.json')
  if (!existsSync(tokenFile)) {
    // Meme Token 配置（prd2.md 5.4 分配模型；R-02：社区积分定位，不承诺金融回报）
    writeFileSync(
      tokenFile,
      JSON.stringify(
        {
          idea_id: idea.id,
          symbol: idea.id.toUpperCase().replace(/[^A-Z0-9]/g, '-'),
          total_supply: 1_000_000,
          allocation: { community: 45, creator: 25, collaborators: 20, ecosystem: 10 },
          distributed: 0,
          holders: 0,
          note: '社区积分凭证，非金融产品，不承诺任何回报（prd2.md R-02 合规定位）',
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )
  }

  const profileFile = join(home, 'profile', 'cordis.patch.yml')
  if (!existsSync(profileFile)) {
    // 子操作系统 Profile（prd2.md 2.5）：阶段一默认插件组合；
    // 阶段切换时由生命周期编排（opc-lifecycle，M2）整体重写
    writeFileSync(
      profileFile,
      [
        `# CreativeOS 子操作系统 Profile（prd2.md 2.5）——由 ${idea.id} 初始化生成`,
        `idea_id: ${yamlScalar(idea.id)}`,
        `idea_name: ${yamlScalar(idea.name)}`,
        `stage: ${yamlScalar(idea.stage)}`,
        `memory_body: ${yamlScalar(join(home, 'memory-body'))}`,
        'plugins:',
        '  - id: idea-memory',
        '    name: "@szx-a/dsh-layered-memory-architecture"',
        '    config:',
        `      defaultBodies: [${yamlScalar(idea.id)}]`,
        '  - id: stage-guide',
        '    name: "creativeos/stage-guide"',
        '    config:',
        `      currentStage: ${yamlScalar(idea.stage)}`,
        '      enableThreeDomains: true',
        '  - id: idea-asset-ledger',
        '    name: "creativeos/asset-ledger"',
        '    config:',
        `      ledgerPath: ${yamlScalar(join(home, 'assets', 'ledger.json'))}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    )
  }

  const metaFile = join(home, 'meta.json')
  writeFileSync(
    metaFile,
    JSON.stringify(
      { idea_id: idea.id, name: idea.name, stage: idea.stage, created_at: idea.createdAt, updated_at: idea.updatedAt },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  return home
}

/**
 * 创意存储（SQLite 主库，ideas 表）：
 * - create：文本 → 三域草案（ID-01）+ 可选目录脚手架（ID-03）；
 * - domains/stage 更新同步镜像 meta.json（DSH 侧工具直接可读）。
 * 目录根缺省时为纯库模式（不落 ideas/ 目录，测试用）。
 */
export class SqliteIdeaStore {
  private readonly db: DatabaseSync
  private readonly now: () => number

  constructor(
    path: string,
    private readonly ideasRoot?: string,
    now: () => number = Date.now,
  ) {
    this.now = now
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ideas (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        stage        TEXT NOT NULL,
        domains_json TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_ideas_stage ON ideas (stage, created_at DESC)')
  }

  /** 录入创意：ID-01 自动三域草案；ideasRoot 就绪时同步 ID-03 目录初始化 */
  create(input: NewIdeaInput): Idea {
    const text = input.text.trim()
    if (text.length === 0) {
      throw new OpcError('VALIDATION_ERROR', 'idea text must be a non-empty string')
    }
    const now = this.now()
    const idea: Idea = {
      id: `idea-${randomUUID().slice(0, 8)}`,
      name: (input.name?.trim() || deriveIdeaName(text)).slice(0, 64),
      stage: 'description',
      domains: draftThreeDomains(text),
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare('INSERT INTO ideas (id, name, stage, domains_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(idea.id, idea.name, idea.stage, JSON.stringify(idea.domains), idea.createdAt, idea.updatedAt)
    if (this.ideasRoot) scaffoldIdeaHome(this.ideasRoot, idea)
    return idea
  }

  get(id: string): Idea | undefined {
    const rows = this.db
      .prepare('SELECT id, name, stage, domains_json, created_at, updated_at FROM ideas WHERE id = ?')
      .all(id) as unknown as IdeaRow[]
    return rows.length > 0 ? rowToIdea(rows[0]) : undefined
  }

  /** 必取创意：不存在抛 IDEA_NOT_FOUND（控制台映射 404） */
  require(id: string): Idea {
    const idea = this.get(id)
    if (!idea) throw new OpcError('IDEA_NOT_FOUND', `idea ${id} does not exist`)
    return idea
  }

  /** 全量列表，新建在前（控制台"最近创意"口径） */
  list(): Idea[] {
    const rows = this.db
      .prepare('SELECT id, name, stage, domains_json, created_at, updated_at FROM ideas ORDER BY created_at DESC')
      .all() as unknown as IdeaRow[]
    return rows.map(rowToIdea)
  }

  count(): number {
    const rows = this.db.prepare('SELECT COUNT(*) AS n FROM ideas').all() as unknown as Array<{ n: number | bigint }>
    return Number(rows[0].n)
  }

  /**
   * 三域迭代更新（ID-02：用户在三域间自由切换、反复迭代）：整体替换三域并镜像 meta.json。
   * 同时把本次编辑以 user 权威写入 description 流是调用方（API 层）的职责——
   * store 只管实体一致性与持久化。
   */
  updateDomains(id: string, domains: ThreeDomains): Idea {
    const current = this.require(id)
    const validated = validateDomains(domains)
    const updatedAt = this.now()
    this.db
      .prepare('UPDATE ideas SET domains_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(validated), updatedAt, id)
    const updated: Idea = { ...current, domains: validated, updatedAt }
    this.mirrorMeta(updated)
    return updated
  }

  /** 单域便捷更新：仅覆盖给定维度，其余保持原样（三域共演化，非线性流程） */
  updateDomain(id: string, key: DomainKey, detail: { summary?: string; points?: string[] }): Idea {
    const current = this.require(id)
    const merged = { ...current.domains }
    const base = merged[key]
    merged[key] = {
      summary: detail.summary ?? base.summary,
      points: detail.points ?? base.points,
    }
    return this.updateDomains(id, merged)
  }

  /** 阶段推进（合法性由 M2 opc-lifecycle 状态机校验；store 层只认合法阶段值） */
  updateStage(id: string, stage: IdeaStage): Idea {
    if (!IDEA_STAGES.includes(stage)) {
      throw new OpcError('VALIDATION_ERROR', `stage must be one of: ${IDEA_STAGES.join(', ')}`)
    }
    const current = this.require(id)
    const updatedAt = this.now()
    this.db.prepare('UPDATE ideas SET stage = ?, updated_at = ? WHERE id = ?').run(stage, updatedAt, id)
    const updated: Idea = { ...current, stage, updatedAt }
    this.mirrorMeta(updated)
    // 阶段变更同步子操作系统 Profile 的 stage 字段（prd2.md 2.5）
    if (this.ideasRoot) this.rewriteProfileStage(this.ideasRoot, updated)
    return updated
  }

  /** 创意目录根（未启用目录模式返回 undefined） */
  homeDir(id: string): string | undefined {
    return this.ideasRoot ? join(this.ideasRoot, id) : undefined
  }

  close(): void {
    this.db.close()
  }

  private mirrorMeta(idea: Idea): void {
    if (!this.ideasRoot) return
    const metaFile = join(this.ideasRoot, idea.id, 'meta.json')
    if (!existsSync(metaFile)) return
    writeFileSync(
      metaFile,
      JSON.stringify(
        { idea_id: idea.id, name: idea.name, stage: idea.stage, created_at: idea.createdAt, updated_at: idea.updatedAt },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )
  }

  private rewriteProfileStage(ideasRoot: string, idea: Idea): void {
    const profileFile = join(ideasRoot, idea.id, 'profile', 'cordis.patch.yml')
    if (!existsSync(profileFile)) return
    // 只重写 stage 相关两行，保留其余插件装配（last-write-wins 的 patch 语义由宿主负责）
    const original = readFileSync(profileFile, 'utf8')
    const updated = original
      .replace(/^stage: .*$/m, `stage: ${yamlScalar(idea.stage)}`)
      .replace(/^(\s*currentStage: ).*$/m, `$1${yamlScalar(idea.stage)}`)
    writeFileSync(profileFile, updated, { mode: 0o600 })
  }
}
