import { join } from 'node:path'

import {
  IdeaLifecycle,
  MemoryBodyHub,
  MemoryBodyIndex,
  SqliteIdeaStore,
  type IdeaStage,
} from '../../../core/src/index.js'
import { defineOpcPlugin, type OpcContext } from '../../../dsh-adapter/src/index.js'

export const name = 'opc-lifecycle'

/**
 * opc-lifecycle —— 创意生命周期编排插件（prd2.md 8.2 creativeos/lifecycle-manager 的
 * DSH 服务形态；控制台 API 内部直接用 core IdeaLifecycle，二者共享同一套状态机与正本）。
 *
 * 服务 'opc.lifecycle'：nextStages / canTransition / transition。
 * 数据与控制台同源（ideas.db + ideas/ 目录 + memory-bodies.db），多连接经 WAL 并发；
 * 全部路径经 Config 注入（bundle 层用 !!js dshHomePath 表达式按部署覆盖）。
 */
export interface Config {
  /** 创意库 SQLite 路径（默认 ./opcos-console-data/ideas.db，与控制台同源） */
  ideasDbPath?: string
  /** 创意目录根（默认 ./opcos-console-data/ideas） */
  ideasRoot?: string
  /** 记忆体检索索引 SQLite 路径（默认 ./opcos-console-data/memory-bodies.db） */
  bodiesDbPath?: string
}

/** 'opc.lifecycle' 服务契约（IdeaLifecycle 的结构子集，供宿主/测试消费） */
export interface LifecycleService {
  nextStages(ideaId: string): IdeaStage[]
  canTransition(ideaId: string, to: IdeaStage): boolean
  transition(ideaId: string, to: IdeaStage, note?: string): ReturnType<IdeaLifecycle['transition']>
}

export function apply(ctx: OpcContext, config: Config): void {
  const ideasRoot = config.ideasRoot ?? join('./opcos-console-data', 'ideas')
  const store = new SqliteIdeaStore(config.ideasDbPath ?? join('./opcos-console-data', 'ideas.db'), ideasRoot)
  const bodyIndex = new MemoryBodyIndex(config.bodiesDbPath ?? join('./opcos-console-data', 'memory-bodies.db'))
  const hub = new MemoryBodyHub(ideasRoot, bodyIndex)
  const lifecycle = new IdeaLifecycle(store, hub)

  ctx.provideService('opc.lifecycle', {
    nextStages: (ideaId) => lifecycle.nextStages(ideaId),
    canTransition: (ideaId, to) => lifecycle.canTransition(ideaId, to),
    transition: (ideaId, to, note) => lifecycle.transition(ideaId, to, note),
  } satisfies LifecycleService)

  ctx.onDispose(() => {
    store.close()
    bodyIndex.close()
  })
}

export const plugin = defineOpcPlugin<Config>({ name, defaultConfig: {}, apply })
export default plugin
