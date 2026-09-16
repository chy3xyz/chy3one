/**
 * Skill 市场类型定义（PRD SF-05：浏览 / 搜索 / 购买 / 安装）。
 * MarketSkill 是 PRD 8.2 skills 表的运行时镜像：
 * price 用“分”表示（INTEGER），避免 DECIMAL(10,2) 的浮点误差。
 */

/** 市场条目：对应 skills 表一行 */
export interface MarketSkill {
  id: string
  name: string
  version: string
  authorId: string
  /** 价格，单位：分 */
  price: number
  category: string
  downloads: number
  /** 平均评分 0..5，两位小数（DECIMAL(3,2)） */
  rating: number
  /** 上架时间（epoch ms） */
  createdAt: number
  /** DSH 兼容性标记（PRD 4.2 “扩展”旅程：缓解兼容性不确定），如 '>=0.1.0-rc.7' */
  compat: { dsh: string }
}

/** 市场检索条件：全部可选、可组合 */
export interface SearchQuery {
  /** 对 name 做 LIKE 模糊匹配（ASCII 大小写不敏感，% _ 按字面量处理） */
  keyword?: string
  /** category 精确匹配 */
  category?: string
  /** 生命周期阶段过滤（prd2.md SM-01：metadata 表 stage 键；仅上架时写入 stage 的条目可命中） */
  stage?: string
  /** 最低评分（rating >= minRating） */
  minRating?: number
  /** 本地 DSH 版本（如 '0.1.5'）：只返回 compat.dsh semver 范围满足该版本的条目 */
  compatDsh?: string
  /** 默认 20 */
  limit?: number
  offset?: number
}
