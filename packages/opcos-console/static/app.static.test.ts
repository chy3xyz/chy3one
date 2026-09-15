/**
 * 控制台前端 smoke 测试（node:test · 纯文本断言）：
 * 不 import 任何浏览器代码，直接读 static/ 下 app.js / index.html / style.css 源文本：
 * - ROUTE_NAMES 与 index.html 导航项一一对应（data-route / href="#/..." 计数）；
 * - API_BASE 部署路径自感知与 ？panel= 深链路由存在；
 * - XSS 抽查：innerHTML 仅允许清空容器（= ''），关键用户数据渲染走 h() 的 text 通道；
 * - a11y 与主题联动标记（role="status" / scope="col" / .opc-light / matchMedia）。
 *
 * 源目录解析：源码形态（本文件与 app.js 同目录）或 dist 形态
 * （dist/opcos-console/static/ → 仓库 packages/opcos-console/static/）双候选。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const candidates = [here, resolve(here, '../../../packages/opcos-console/static')]
const staticDir = candidates.find((dir) => existsSync(resolve(dir, 'app.js')))
assert.ok(staticDir, `应能在候选路径中定位 static 源目录: ${candidates.join(' | ')}`)

const appJs = readFileSync(resolve(staticDir, 'app.js'), 'utf8')
const indexHtml = readFileSync(resolve(staticDir, 'index.html'), 'utf8')
const styleCss = readFileSync(resolve(staticDir, 'style.css'), 'utf8')

/** 从 app.js 源文本解析 ROUTE_NAMES 字面量数组 */
function parseRouteNames(): string[] {
  const match = /const ROUTE_NAMES = \[([^\]]+)\]/.exec(appJs)
  assert.ok(match, 'app.js 应声明 ROUTE_NAMES 路由白名单')
  return (match[1] ?? '')
    .split(',')
    .map((raw) => raw.trim().replace(/^['"]|['"]$/g, ''))
    .filter((name) => name.length > 0)
}

test('smoke: ROUTE_NAMES 与 index.html 导航项一一对应（data-route 与 href="#/..."）', () => {
  const routeNames = parseRouteNames()
  assert.ok(routeNames.length > 0, 'ROUTE_NAMES 非空')

  const dataRoutes = [...indexHtml.matchAll(/data-route="([a-z]+)"/g)].map((m) => m[1] ?? '')
  const hrefRoutes = [...indexHtml.matchAll(/href="#\/([a-z]+)"/g)].map((m) => m[1] ?? '')
  assert.equal(dataRoutes.length, routeNames.length, `导航 data-route 数量应与 ROUTE_NAMES 一致`)
  assert.equal(hrefRoutes.length, routeNames.length, `导航 href="#/..." 数量应与 ROUTE_NAMES 一致`)
  assert.deepEqual([...dataRoutes].sort(), [...routeNames].sort(), 'data-route 与 ROUTE_NAMES 集合一致')
  assert.deepEqual([...hrefRoutes].sort(), [...routeNames].sort(), 'href 路由与 ROUTE_NAMES 集合一致')
})

test('smoke: API_BASE 部署路径自感知 + ?panel= 深链初始路由（非法值忽略）', () => {
  // hosted 模式挂在 /opcos 前缀：API_BASE 依 location.pathname 自感知
  assert.ok(
    appJs.includes("location.pathname.startsWith('/opcos')"),
    'API_BASE 应按 location.pathname 是否以 /opcos 开头切换',
  )
  assert.ok(appJs.includes("'/opcos'"), 'API_BASE hosted 前缀存在')

  // 深链：官方 GUI 启动器 iframe 以 ?panel=<name> 打开 → 初始路由到该面板
  assert.ok(appJs.includes(".get('panel')"), '启动时读 location.search 的 panel 参数')
  assert.ok(
    /requested && ROUTE_NAMES\.includes\(requested\)/.test(appJs),
    'panel 参数须经 ROUTE_NAMES 白名单校验（非法值忽略）',
  )
  assert.ok(appJs.includes('location.hash = `#/${requested}`'), '合法 panel → 初始 hash 路由到该面板')
})

test('smoke: XSS 抽查——innerHTML 仅用于清空容器，用户数据渲染走 h() text 通道', () => {
  // 允许的 innerHTML 用法只有清空（= ''）；清空语句全部剥除后不得再有 innerHTML
  const withoutClearing = appJs.replace(/innerHTML\s*=\s*''/g, '')
  assert.ok(!withoutClearing.includes('innerHTML'), '除 `innerHTML = \'\'` 清空外不得出现 innerHTML 插值')
  assert.ok(!appJs.includes('insertAdjacentHTML'), '禁止 insertAdjacentHTML')
  assert.ok(!appJs.includes('document.write'), '禁止 document.write')

  // 关键用户数据渲染通道抽查：标题/任务名/记忆内容/toast/JSON 折叠全部走 h() 的 text（textContent）
  for (const channel of [
    "h('h2', { class: 'page-title', text: title })",
    "h('span', { text: t.title })",
    "h('p', { class: 'memory-content', text: e.content || '' })",
    "h('span', { class: 'toast-msg', text: message })",
    "h('pre', { text: safeJson(value) })",
  ] as const) {
    assert.ok(appJs.includes(channel), `用户数据应走 text 通道: ${channel}`)
  }
})

test('smoke: a11y 与主题联动标记（role="status" / scope="col" / .opc-light / matchMedia）', () => {
  // a11y：装载中/空态 role="status"；表头 scope="col"
  assert.ok(appJs.includes("role: 'status'"), 'ui.loading / ui.empty 应带 role="status"')
  assert.ok(appJs.includes("scope: 'col'"), '表头 th 应带 scope="col"')
  // 主题：浅色覆盖块 + 变量化色板 + 前端跟随系统深浅色
  assert.ok(styleCss.includes('.opc-light'), 'style.css 应含 .opc-light 浅色覆盖块')
  assert.ok(styleCss.includes('--opc-bg:'), 'style.css 核心色应收敛为 --opc-* 变量')
  assert.ok(appJs.includes("window.matchMedia('(prefers-color-scheme: light)')"), '前端监听系统浅色偏好')
  // index.html：静态页无内联脚本（逻辑全部收敛在 app.js）
  assert.ok(!indexHtml.includes('<script src=') || /<script src="app\.js"><\/script>/.test(indexHtml))
  assert.equal([...indexHtml.matchAll(/<script(?![^>]*src=)/g)].length, 0, 'index.html 不得有内联脚本')
})

test('smoke: 文案禁用词——「提交」「操作成功」不得作为按钮 / toast 文案（console-voice §6）', () => {
  // 变量名与注释不在检查范围，按用户可见文案模式放宽匹配（text 通道 + 字符串字面量）
  assert.ok(
    !appJs.includes("text: '提交'") && !appJs.includes("'提交'"),
    '禁用词「提交」不得作为按钮/toast 文案字面量出现',
  )
  assert.ok(!appJs.includes('操作成功'), '禁用词「操作成功」不得出现在任何用户可见文案')
})
