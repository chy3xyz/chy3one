import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRelation, type IdeaRelation, type RelationType } from './market.js'

/**
 * IM-03 验收评测（prd2.md 6.2：关联推荐准确率 ≥ 70%）。
 *
 * 10 个领域词包 × 5 类标注对，共 50 组：
 * - complementary（10）：A 的问题域 ↔ B 的解决域（B 的方案解决 A 的问题）；
 * - similar-problem（10）：两者问题域同义改写；
 * - similar-solution（10）：两者解决域同义改写；
 * - unrelated（20）：跨领域问题域对（+3 / +7 错位），不应产生任何关联。
 *
 * 每组断言分类器输出与标注一致（unrelated 期望 null），
 * 总准确率与分类型准确率均须 ≥ 70%（IM-03 验收线）。
 */

interface DomainPack {
  key: string
  problem: string
  problemVariant: string
  solution: string
  solutionVariant: string
}

const DOMAIN_PACKS: readonly DomainPack[] = [
  {
    key: '选品',
    problem: '跨境电商卖家选品难，缺少选品数据',
    problemVariant: '电商卖家选品决策缺少数据支撑',
    solution: 'AI 选品工具：为卖家提供选品数据与选品建议',
    solutionVariant: '选品数据平台，帮卖家做选品决策',
  },
  {
    key: '寄养',
    problem: '假期宠物无人照看，寄养信息不透明',
    problemVariant: '宠物寄养渠道少，照看信息不透明',
    solution: '宠物寄养匹配平台，透明展示寄养家庭',
    solutionVariant: '寄养家庭匹配服务，让照看信息透明',
  },
  {
    key: '周报',
    problem: '团队周报撰写耗时，格式五花八门',
    problemVariant: '周报撰写太花时间，格式五花八门',
    solution: 'AI 周报生成器：周报撰写自动成稿，格式统一',
    solutionVariant: '周报自动成稿工具，统一模板与格式',
  },
  {
    key: '健身',
    problem: '健身新手不会安排训练计划',
    problemVariant: '新手缺乏训练计划指导',
    solution: 'AI 健身教练：定制个性化训练计划',
    solutionVariant: '个性化训练计划定制服务',
  },
  {
    key: '启蒙',
    problem: '家长不知道怎么给幼儿做英语启蒙',
    problemVariant: '幼儿英语启蒙缺少方法指导',
    solution: '英语启蒙动画课：按月龄分级的启蒙内容',
    solutionVariant: '分级启蒙内容库，按月龄推英语动画课',
  },
  {
    key: '供应链',
    problem: '小餐厅食材采购价高且不稳定',
    problemVariant: '餐厅食材采购成本高、供货不稳',
    solution: '食材供应链集采平台：餐厅拼单直采',
    solutionVariant: '拼单直采的食材供应链服务',
  },
  {
    key: '行程',
    problem: '自由行做攻略费时，行程安排不合理',
    problemVariant: '攻略太费时间，行程规划不合理',
    solution: 'AI 行程规划师：攻略自动生成，行程安排不再费时',
    solutionVariant: '自动生成攻略的行程规划工具',
  },
  {
    key: '记账',
    problem: '小生意记账混乱，月底对不上账',
    problemVariant: '生意账目混乱，月底账目对不上',
    solution: 'AI 记账助手：月底自动对账，账目不再混乱',
    solutionVariant: '票据拍照自动记账与对账工具',
  },
  {
    key: '装修',
    problem: '装修不懂行，怕被施工方坑',
    problemVariant: '装修小白难以监督施工方',
    solution: '第三方装修监理：全程替业主验收施工',
    solutionVariant: '装修施工验收的第三方监理服务',
  },
  {
    key: '播客',
    problem: '播客主剪辑一期节目要花一整天',
    problemVariant: '剪辑播客节目耗时太长',
    solution: '播客自动剪辑：去停顿、加章节，一期节目一键成片',
    solutionVariant: '一键去停顿、加章节的播客剪辑服务',
  },
]

interface LabeledPair {
  name: string
  label: RelationType | null
  a: { ideaId: string; stage: 'description' | 'operation'; problemSummary: string; solutionSummary: string }
  b: { ideaId: string; stage: 'description' | 'operation'; problemSummary: string; solutionSummary: string }
}

function buildPairs(): LabeledPair[] {
  const pairs: LabeledPair[] = []
  DOMAIN_PACKS.forEach((d, i) => {
    // 互补：B 的方案解决 A 的问题
    pairs.push({
      name: `${d.key}-互补`,
      label: 'complementary',
      a: { ideaId: `idea-${d.key}-p`, stage: 'description', problemSummary: d.problem, solutionSummary: '' },
      b: { ideaId: `idea-${d.key}-s`, stage: 'operation', problemSummary: '', solutionSummary: d.solution },
    })
    // 相似：问题域同义改写
    pairs.push({
      name: `${d.key}-相似问题`,
      label: 'similar',
      a: { ideaId: `idea-${d.key}-p1`, stage: 'description', problemSummary: d.problem, solutionSummary: '' },
      b: { ideaId: `idea-${d.key}-p2`, stage: 'description', problemSummary: d.problemVariant, solutionSummary: '' },
    })
    // 相似：解决域同义改写
    pairs.push({
      name: `${d.key}-相似方案`,
      label: 'similar',
      a: { ideaId: `idea-${d.key}-s1`, stage: 'operation', problemSummary: '', solutionSummary: d.solution },
      b: { ideaId: `idea-${d.key}-s2`, stage: 'operation', problemSummary: '', solutionSummary: d.solutionVariant },
    })
  })
  // 无关：跨领域问题域错位配对（+3 / +7 mod 10，恒不与自身成对）
  for (let i = 0; i < DOMAIN_PACKS.length; i++) {
    for (const offset of [3, 7]) {
      const j = (i + offset) % DOMAIN_PACKS.length
      const d1 = DOMAIN_PACKS[i]!
      const d2 = DOMAIN_PACKS[j]!
      pairs.push({
        name: `${d1.key}-无关-${d2.key}`,
        label: null,
        a: { ideaId: `idea-u-${d1.key}`, stage: 'description', problemSummary: d1.problem, solutionSummary: '' },
        b: { ideaId: `idea-u-${d2.key}`, stage: 'description', problemSummary: d2.problem, solutionSummary: '' },
      })
    }
  }
  return pairs
}

test('IM-03 验收：关联推荐准确率 ≥ 70%（50 组标注评测集）', () => {
  const pairs = buildPairs()
  assert.equal(pairs.length, 50, '评测集应含 50 组标注对')

  let correct = 0
  const byLabel: Record<string, { total: number; correct: number; wrong: Array<{ name: string; got: IdeaRelation | null }> }> = {}
  for (const pair of pairs) {
    const got = classifyRelation(pair.a, pair.b)
    const gotType = got?.type ?? null
    const bucket = (byLabel[pair.label ?? 'unrelated'] ??= { total: 0, correct: 0, wrong: [] })
    bucket.total += 1
    if (gotType === pair.label) {
      correct += 1
      bucket.correct += 1
    } else {
      bucket.wrong.push({ name: pair.name, got })
    }
  }

  const accuracy = correct / pairs.length
  const comp = byLabel['complementary']!
  const sim = byLabel['similar']!
  const unrelated = byLabel['unrelated']!

  console.log(
    `[IM-03 评测] 总准确率 ${(accuracy * 100).toFixed(1)}%（${correct}/${pairs.length}）· ` +
      `互补 ${comp.correct}/${comp.total} · 相似 ${sim.correct}/${sim.total} · 无关误报 ${unrelated.total - unrelated.correct}/${unrelated.total}`,
  )
  for (const wrong of [...comp.wrong, ...sim.wrong, ...unrelated.wrong]) {
    console.log(`  ✘ ${wrong.name}: 实际 ${wrong.got?.type ?? 'null'}（score=${wrong.got?.score ?? '—'}）`)
  }

  // IM-03 验收线：准确率 ≥ 70%；分类型同样 ≥ 70%，避免整体数字掩盖单类失效
  assert.ok(accuracy >= 0.7, `关联推荐准确率应 ≥ 70%，实际 ${(accuracy * 100).toFixed(1)}%`)
  assert.ok(comp.correct / comp.total >= 0.7, `互补型准确率应 ≥ 70%，实际 ${comp.correct}/${comp.total}`)
  assert.ok(sim.correct / sim.total >= 0.7, `相似型准确率应 ≥ 70%，实际 ${sim.correct}/${sim.total}`)
  assert.ok(unrelated.correct / unrelated.total >= 0.7, `无关对误报率应 ≤ 30%，实际误报 ${unrelated.total - unrelated.correct}/${unrelated.total}`)
})
