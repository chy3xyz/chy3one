import { randomUUID } from 'node:crypto'
import type { PlatformContent, PublishResult } from './types.js'
import type { PublishAdapter } from './strategy.js'

/**
 * 多平台分发（prd2.md 4.2 CO-03：公众号/小红书/抖音/Twitter/B站，适配 <30s/平台）。
 * Mock 适配器沿用 MockWechatAdapter 形态（真实平台 API 注入位：实现 PublishAdapter 覆盖）。
 */

/** 平台矩阵（prd2.md CO-03 平台清单） */
export const PLATFORMS = ['wechat', 'xiaohongshu', 'douyin', 'twitter', 'bilibili'] as const
export type Platform = (typeof PLATFORMS)[number]

/** 平台展示名（控制台与文案共用） */
export const PLATFORM_LABELS: Record<Platform, string> = {
  wechat: '公众号',
  xiaohongshu: '小红书',
  douyin: '抖音',
  twitter: 'Twitter',
  bilibili: 'B站',
}

interface PlatformShape {
  /** 假链接前缀（mock 发布） */
  urlBase: string
  /** 平台内容形态适配（正文变换，CO-03 适配语义的最小实现） */
  adapt(content: PlatformContent): PlatformContent
}

/** 各平台形态差异：公众号长文 <p>；小红书去 HTML 加话题标签；抖音短视频脚本化；Twitter 截断；B站专栏 */
const SHAPES: Record<Platform, PlatformShape> = {
  wechat: {
    urlBase: 'https://mp.weixin.qq.com/s/',
    adapt: (c) => c,
  },
  xiaohongshu: {
    urlBase: 'https://www.xiaohongshu.com/explore/',
    adapt: (c) => ({
      ...c,
      htmlBody: c.htmlBody.replace(/<\/?p>/g, '\n').trim(),
      tags: [...new Set([...c.tags, '图文笔记'])].slice(0, 10),
    }),
  },
  douyin: {
    urlBase: 'https://www.douyin.com/video/',
    adapt: (c) => ({
      ...c,
      htmlBody: `【口播脚本】${c.title}\n${c.htmlBody.replace(/<\/?p>/g, ' ').trim()}\n【画面提示】要点字幕 + 产品特写`,
      tags: [...new Set([...c.tags, '短视频'])].slice(0, 5),
    }),
  },
  twitter: {
    urlBase: 'https://x.com/i/status/',
    adapt: (c) => ({
      ...c,
      title: c.title.slice(0, 80),
      htmlBody: c.htmlBody.replace(/<\/?p>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280),
      tags: c.tags.slice(0, 3),
    }),
  },
  bilibili: {
    urlBase: 'https://www.bilibili.com/read/cv',
    adapt: (c) => ({
      ...c,
      htmlBody: `<h1>${c.title}</h1>${c.htmlBody}`,
      tags: [...new Set([...c.tags, '专栏'])].slice(0, 12),
    }),
  },
}

/** 平台 Mock 适配器：按平台形态适配后返回假发布链接（真实 API 的替换位） */
export class MockPlatformAdapter implements PublishAdapter {
  constructor(readonly platform: Platform) {}

  async publish(content: PlatformContent): Promise<PublishResult> {
    const shape = SHAPES[this.platform]
    void shape.adapt(content) // 真实适配器在此把适配产物交给平台 API；mock 只生成回执
    return {
      platform: this.platform,
      url: `${shape.urlBase}${randomUUID()}`,
      publishedAt: Date.now(),
      success: true,
    }
  }
}

/** 全平台 Mock 适配器（CO-03 默认矩阵） */
export function defaultPlatformAdapters(platforms: readonly Platform[] = PLATFORMS): MockPlatformAdapter[] {
  return platforms.map((platform) => new MockPlatformAdapter(platform))
}

export interface PlatformDispatch {
  platform: Platform
  result: PublishResult
  /** 该平台适配耗时（ms，CO-03 验收 <30s/平台 的直接证据） */
  adaptationMs: number
}

export interface DispatchReport {
  dispatches: PlatformDispatch[]
  /** 全部平台均成功才为 true */
  success: boolean
  totalMs: number
}

/**
 * 多平台分发器：逐平台适配 + 发布，统计每平台适配耗时。
 * 单平台失败不阻断其余平台（结果里带 success=false，由调用方决定重试/告警）。
 */
export class MultiPlatformDispatcher {
  constructor(private readonly adapters: PublishAdapter[]) {}

  async dispatch(content: PlatformContent): Promise<DispatchReport> {
    const startedAt = Date.now()
    const dispatches: PlatformDispatch[] = []
    for (const adapter of this.adapters) {
      const adaptStarted = Date.now()
      try {
        const result = await adapter.publish(content)
        dispatches.push({ platform: adapter.platform as Platform, result, adaptationMs: Date.now() - adaptStarted })
      } catch (error) {
        dispatches.push({
          platform: adapter.platform as Platform,
          result: {
            platform: adapter.platform,
            url: '',
            publishedAt: Date.now(),
            success: false,
          },
          adaptationMs: Date.now() - adaptStarted,
        })
        void error // 单平台异常隔离：记录失败，不阻断其余平台
      }
    }
    return {
      dispatches,
      success: dispatches.length > 0 && dispatches.every((d) => d.result.success),
      totalMs: Date.now() - startedAt,
    }
  }
}
