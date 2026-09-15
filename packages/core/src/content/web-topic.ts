/**
 * CE-01 热点搜索：鸭子类型对接 ctx.web（@deepseek-ai/dsh-web 的 WebRuntime）搜索能力缝。
 *
 * core 零外部运行时依赖：不 import dsh-web，仅按其公开类型结构定义兼容接口
 * （dsh-web/lib/types/types.d.ts：search({query, maxResults?}) → {sources:[{url,title?,snippet?}]}）。
 *
 * 优雅降级契约（PRD 6.3.4 热点无结果回退选题库）：任何失败——未配置 provider
 * （WebError code=WEB_PROVIDER_UNAVAILABLE 等）、网络错误、返回形状异常——都只记录
 * 原因（lastError）并返回 []，由上层模板策略常青库兜底，热点永不阻塞选题。
 */

/** 结构兼容 dsh-web 的 WebSearchRequest（types.d.ts:14-24） */
export interface WebSearchRequestLike {
  readonly query: string
  readonly maxResults?: number
}

/** 结构兼容 dsh-web 的 WebSearchSource（types.d.ts:46-52） */
export interface WebSearchSourceLike {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

/** 结构兼容 dsh-web 的 WebSearchResult（types.d.ts:32-39） */
export interface WebSearchResultLike {
  readonly content?: string
  readonly sources: readonly WebSearchSourceLike[]
  readonly truncated: boolean
}

/** 结构兼容 dsh-web 的 WebRuntime.search（index.d.ts:80） */
export interface WebSearchServiceLike {
  search(request: WebSearchRequestLike, signal?: AbortSignal): Promise<WebSearchResultLike>
}

/** 识别一个 unknown 是否可用作热点搜索服务（鸭子类型，插件层注入前探测） */
export function looksLikeWebSearchService(raw: unknown): raw is WebSearchServiceLike {
  return (
    typeof raw === 'object' && raw !== null &&
    typeof (raw as { search?: unknown }).search === 'function'
  )
}

/** 热点候选的来源可追溯标识（与 memory://、builtin:// 同构；标题编码截断保证可读） */
export function hotSourceRef(title: string): string {
  return `hot://search/${encodeURIComponent(title).slice(0, 96)}`
}

export interface WebSearchTopicSourceOptions {
  /** 每个关键词的最大结果数（透传 request.maxResults，缝层会强制截断） */
  maxResults?: number
  /** 取消信号（转发给 provider） */
  signal?: AbortSignal
}

/**
 * 热点话题源：把 ctx.web 的通用搜索缝收窄为「关键词 → 热点标题列表」。
 * 每个关键词一次 search 请求（dsh-web 语义：一个请求一个 query），合并去重。
 */
export class WebSearchTopicSource {
  /** 降级诊断：最近一次 hotTopics 的失败原因聚合（'' = 无失败） */
  lastError = ''

  private readonly web: WebSearchServiceLike
  private readonly maxResults: number
  private readonly signal?: AbortSignal

  /**
   * @param webService 期待 ctx.getService('web') 的返回（WebRuntime）；形状不符立即抛错，
   * 由插件层用 looksLikeWebSearchService 预防——undefined 服务则根本不注入本类
   */
  constructor(webService: unknown, options: WebSearchTopicSourceOptions = {}) {
    if (!looksLikeWebSearchService(webService)) {
      throw new TypeError('WebSearchTopicSource: webService must expose a search(request) method (ctx.web WebRuntime)')
    }
    this.web = webService
    this.maxResults = options.maxResults ?? 5
    this.signal = options.signal
  }

  /**
   * 关键词 → 热点标题列表（按关键词分头检索，标题/snippet 兜底，跨关键词去重）。
   * 部分关键词失败不影响其余；全部失败或零命中 → 返回 [] 并记 lastError。
   */
  async hotTopics(keywords: string[]): Promise<string[]> {
    this.lastError = ''
    const queries = (Array.isArray(keywords) ? keywords : [])
      .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      .map((k) => k.trim())
      .slice(0, 3) // 限流：最多 3 个关键词，控制延迟与配额
    if (queries.length === 0) return []

    const titles = new Set<string>()
    const reasons: string[] = []
    await Promise.all(
      queries.map(async (query) => {
        try {
          const result = await this.web.search({ query, maxResults: this.maxResults }, this.signal)
          for (const source of result?.sources ?? []) {
            const title = (source?.title ?? source?.snippet ?? '').trim()
            if (title) titles.add(title)
          }
        } catch (err) {
          reasons.push(describeWebError(err))
        }
      }),
    )
    this.lastError = reasons.join('; ')
    return [...titles]
  }
}

/** WebError 携带机器可路由 code（HarnessError 子类）；错误描述优先带 code 便于归因 */
function describeWebError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  const message = err instanceof Error ? err.message : String(err)
  return typeof code === 'string' && code.length > 0 ? `${code}: ${message}` : message
}
