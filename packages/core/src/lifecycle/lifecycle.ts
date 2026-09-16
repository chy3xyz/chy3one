import { OpcError } from '../errors.js'
import type { MemoryBodyHub } from '../memory/memory-body.js'
import type { Idea } from '../idea/store.js'
import { SqliteIdeaStore } from '../idea/store.js'
import { IDEA_STAGES, IDEA_STAGE_LABELS, type IdeaStage } from '../idea/types.js'

/**
 * 创意生命周期编排（prd2.md 1.2 / 3.4 / 4.5 / 8.2 creativeos/lifecycle-manager）：
 * - 状态机：四阶段线性推进（描述→产品→运营→资产），禁止跳跃与回退
 *   （回退走"归档重启"语义，由产品决策，不在编排器内隐式发生）；
 * - 迁移副作用：阶段写入（同步重写子OS profile 的 stage，SqliteIdeaStore 内）
 *   + 决策正本写入创意记忆体 decisions 流（prd2.md 3.4 memory_write）。
 */

/** 合法迁移表：线性单向。键=当前阶段，值=允许的目标阶段（恒为下一阶段） */
export const STAGE_TRANSITIONS: Readonly<Record<IdeaStage, readonly IdeaStage[]>> = {
  description: ['product'],
  product: ['operation'],
  operation: ['asset'],
  asset: [],
}

/** 各阶段迁移的默认决策记录文案（prd2.md 3.4 stage_transition.memory_write） */
export const STAGE_TRANSITION_NOTES: Readonly<Record<IdeaStage, string>> = {
  product: 'MVP验证通过，进入生产型产品开发阶段',
  operation: '产品就绪，进入内容运营与GEO行销阶段',
  asset: '运营稳定，进入资产沉淀与变现阶段',
  description: '回到创意描述阶段',
}

/** 阶段迁移入参记录（写入 decisions 流的载荷） */
export interface StageTransitionRecord {
  kind: 'stage-transition'
  from: IdeaStage
  to: IdeaStage
  note: string
  at: number
}

export interface TransitionResult {
  idea: Idea
  transition: StageTransitionRecord
}

export class IdeaLifecycle {
  constructor(
    private readonly store: SqliteIdeaStore,
    private readonly hub: MemoryBodyHub | undefined,
  ) {}

  /** 当前阶段的合法去向（资产阶段为终态，返回空） */
  nextStages(ideaId: string): IdeaStage[] {
    const idea = this.store.require(ideaId)
    return [...(STAGE_TRANSITIONS[idea.stage] ?? [])]
  }

  /** 迁移可行性：false 时 transition 必抛，UI 用于置灰 */
  canTransition(ideaId: string, to: IdeaStage): boolean {
    return this.nextStages(ideaId).includes(to)
  }

  /**
   * 阶段迁移：非法目标抛 STAGE_TRANSITION_INVALID（控制台映射 409）；
   * 成功时序 = 更新阶段（含 profile 重写）→ decisions 流写迁移正本。
   * 记忆体缺席（hub 未配置）时跳过正本，阶段迁移本身不失败。
   */
  transition(ideaId: string, to: IdeaStage, note?: string): TransitionResult {
    if (!IDEA_STAGES.includes(to)) {
      throw new OpcError('VALIDATION_ERROR', `stage must be one of: ${IDEA_STAGES.join(', ')}`)
    }
    const idea = this.store.require(ideaId)
    if (!this.canTransition(ideaId, to)) {
      throw new OpcError(
        'STAGE_TRANSITION_INVALID',
        `cannot transition idea ${ideaId} from ${idea.stage}（${IDEA_STAGE_LABELS[idea.stage]}）to ${to}（${IDEA_STAGE_LABELS[to]}）：生命周期只允许线性推进`,
      )
    }
    const updated = this.store.updateStage(ideaId, to)
    const record: StageTransitionRecord = {
      kind: 'stage-transition',
      from: idea.stage,
      to,
      note: note?.trim() || STAGE_TRANSITION_NOTES[to],
      at: Date.now(),
    }
    this.hub?.write(ideaId, 'decisions', {
      content: JSON.stringify(record),
      confidence: 0.9,
      authority: 'model',
    })
    return { idea: updated, transition: record }
  }
}
