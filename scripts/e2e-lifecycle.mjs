#!/usr/bin/env node
/**
 * 创意生命周期端到端通测（对运行中的控制台走真实 HTTP API）。
 * 用法：先 npm run console（或 npm run build 后 node dist/opcos-console/src/server.js），
 *      另开终端：node scripts/e2e-lifecycle.mjs [BASE] [用户名] [密码]
 * 默认 BASE=http://127.0.0.1:3000，demo/demo123456。
 * 断言三域草案/MVP/验证 Go/阶段迁移/内容五平台/GEO/账本/Token/市场发布全链 18 步。
 */
const BASE = (process.argv[2] ?? 'http://127.0.0.1:3000/').replace(/\/?$/, '/')
const USER = process.argv[3] ?? 'demo'
const PASS = process.argv[4] ?? 'demo123456'
const jar = { cookie: '' }
let step = 0, pass = 0
const ok = (name, cond) => { step++; if (cond) { pass++; console.log(`✔ ${step}. ${name}`) } else console.log(`✘ ${step}. ${name}`) }
async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(jar.cookie ? { cookie: jar.cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const sc = res.headers.get('set-cookie')
  if (sc) jar.cookie = sc.split(';')[0]
  return { status: res.status, body: await res.json().catch(() => null) }
}

const login = await req('POST', 'api/auth/login', { username: USER, password: PASS })
ok(`登录 ${USER}（${login.status}）`, login.status === 200)

const created = await req('POST', 'api/ideas', {
  text: '三源合恰课程网站：用『物象义』三源理论重构课程设计。我们打算做一个在线课程平台，把每门课拆成物（物质基底：教具、实验、实操材料）、象（符号思想：图示、语言、叙事）、义（赋义智能：学习者自己赋予意义的AI引导）三层来设计。面向在线教育创作者与企业培训团队，时间窗口在AI重构教育的红利期。',
})
ok('ID-01 录入创意，自动生成三域草案', created.status === 200 && created.body.idea.domains.problem.summary.length > 0)
const idea = created.body.idea
console.log(`   创意 ID ${idea.id}`)

const domains = {
  problem: {
    summary: '传统在线课程只交付符号知识（视频+讲义），缺乏物质载体与意义生成环节，完课率不足 10%，学习者留存与口碑转化差',
    points: ['完课率低：知识只到『象』层，没落到『物』也没生成『义』', '课程同质化：内容付费市场缺乏结构化的差异化设计方法论'],
  },
  solution: {
    summary: '三源合恰课程平台：把每门课拆为物（教具/实验/实操）、象（图示/叙事/语言）、义（AI 赋义引导）三层，给出结构化的课程设计引擎',
    points: ['三层课程设计引擎：输入主题自动生成物象义三层大纲', '物象义模板库：按学科提供可套用的设计模板', 'AI 赋义引导器：按学习者画像生成意义追问', '课程诊断报告：按三层完备度打分并给改进建议'],
  },
  spacetime: {
    summary: 'AI 重构教育的红利窗口期（未来 2-3 年），面向在线教育创作者与企业培训团队，先中文市场后出海',
    points: ['窗口：AI 课程工具爆发前夜，创作者急需结构化方法论', '人群：知识付费创作者、企业培训师、独立课程工作室'],
  },
}
const patched = await req('PATCH', `api/ideas/${idea.id}/domains`, domains)
ok('ID-02 三域迭代完善', patched.status === 200 && patched.body.idea.domains.solution.points.length === 4)

const persona = await req('POST', `api/ideas/${idea.id}/persona`, {
  persona: '三源合恰布道者——把抽象理论讲成可上手的课程设计动作，先给骨架再给血肉，每句话都能落地成课件',
})
ok('CO-02 保存品牌人设', persona.status === 200)

const plan = await req('POST', `api/ideas/${idea.id}/mvp/plan`, {})
ok('IP-01 生成 MVP 方案', plan.status === 200 && plan.body.plan.milestones.length === 3)

for (const v of [
  { source: 'feedback', score: 4.6, content: '12 名课程设计师内测，9 人表示愿意付费使用' },
  { source: 'metric', score: 4.2, content: '试听课→注册转化率 8.3%，高于行业基线 2 倍' },
  { source: 'feedback', score: 3.9, content: '赋义引导器被评为最有惊喜的功能' },
]) await req('POST', `api/ideas/${idea.id}/mvp/validation`, v)
const sug = await req('GET', `api/ideas/${idea.id}/mvp/suggestion`)
ok('IP-03/IP-04 Go 判定', sug.body.suggestion.suggestion === 'go' && sug.body.suggestion.validations === 3)

const t1 = await req('POST', `api/ideas/${idea.id}/transition`, { to: 'product', note: '内测数据过线，验证通过' })
ok('阶段迁移 描述→产品', t1.status === 200 && t1.body.transition.from === 'description')
const t2 = await req('POST', `api/ideas/${idea.id}/transition`, { to: 'operation', note: '产品上线' })
ok('阶段迁移 产品→运营', t2.status === 200 && t2.body.idea.stage === 'operation')

const run = await req('POST', 'api/content/run', { ideaId: idea.id, platforms: true })
ok('CO-02/03 按创意人设出作品 + 五平台分发 + Schema', run.status === 200 && run.body.success && (run.body.dispatch?.dispatches?.length === 5) && !!run.body.content.schemaJsonLd)

const geo = await req('POST', `api/ideas/${idea.id}/geo/refresh`, {})
ok('4.4 GEO 监测刷新', geo.status === 200 && geo.body.snapshots.length === 4)

const t3 = await req('POST', `api/ideas/${idea.id}/transition`, { to: 'asset', note: '运营稳定，进入资产沉淀' })
ok('阶段迁移 运营→资产', t3.status === 200 && t3.body.idea.stage === 'asset')

const rev = await req('POST', `api/ideas/${idea.id}/ledger/revenue`, { source: 'subscription', amountCents: 129000, note: '订阅收入' })
ok('5.5 账本记订阅收入 ¥1290', rev.status === 200 && rev.body.ledger.assets.finance.total === 129000)

const g1 = await req('POST', `api/ideas/${idea.id}/token/issue`, { to: USER, role: 'creator', amount: 200000, reason: '理论原创者' })
const g2 = await req('POST', `api/ideas/${idea.id}/token/issue`, { to: 'user-b', role: 'collaborator', amount: 40000, reason: '协作开发' })
ok('5.4 Token 发放', g1.status === 200 && g2.status === 200 && g2.body.stats.distributed === 240000)

const pub = await req('POST', `api/ideas/${idea.id}/publish`, {})
ok('ID-05/IM-01 发布到市场', pub.status === 200)
const search = await req('GET', `api/market/ideas?q=${encodeURIComponent('课程平台')}`)
ok('IM-05 市场检索命中', search.body.ideas.some(i => i.ideaId === idea.id))
const follow = await req('POST', `api/market/ideas/${idea.id}/follow`, {})
ok('IM-02 关注（登录态实名）', follow.status === 200 && follow.body.follower === USER)
const collab = await req('POST', `api/ideas/${idea.id}/collab`, { role: 'operator', contribution: 'GEO 行销策略', tokens: 20000 })
ok('IM-04 协同记录 + Token', collab.status === 200 && collab.body.record.tokensGranted === 20000)

const ledger = await req('GET', `api/ideas/${idea.id}/ledger`)
const L = ledger.body.ledger.assets
const final = await req('GET', `api/ideas/${idea.id}`)
ok('终态核对', L.finance.total === 129000 && L.tokens.distributed === 260000 && final.body.idea.stage === 'asset')

const funnel = await req('GET', 'api/funnel')
console.log(`\n═══ E2E 完成：${pass}/${step} 步通过 ═══`)
console.log(`创意 ${idea.id} 终态：阶段=${final.body.idea.stage} · 财务 ¥${(L.finance.total/100).toFixed(2)} · Token ${L.tokens.distributed}`)
process.exit(pass === step ? 0 : 1)
