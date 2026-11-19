---
name: solid-reactivity-lint-skill
description: 响应式/数据绑定反模式拦截——适用于 chy3one 控制台的 DOM 更新、事件绑定、状态管理。修改面板渲染逻辑、事件处理、数据刷新时触发。
---

# 响应式/数据绑定反模式拦截

适用于 `packages/opcos-console/static/app.js` 的面板渲染与状态管理代码。

## 渲染反模式

### ❌ 禁止：append(null/undefined) → 产生 "null" 文本
```js
// 反模式
render(box, sectionA, maybeNull, sectionC); // maybeNull → "null" 文本
// 正确：render() 已内置 null/undefined/false 过滤
```
`render()` 助手已内置 `.filter(c => c !== null && c !== undefined && c !== false)`——
所有条件渲染通过 render/pop 分发即可，不要手动 append。

### ❌ 禁止：变量作用域引用不存在的变量
```js
// 反模式：tabBar 引用其他面板作用域的变量
const tabBar = h('div', ..., L.finance.total, pub.relations.length);
// 正确：引用同作用域的变量（ldg、pub 等 await 解构结果）
```
跨作用域引用会导致运行时 ReferenceError（浏览器白屏/面板加载失败）。

### ❌ 禁止：手动拼接闭合括号
```js
// 反模式：反复手改 `}))` / `])))` / `]))))` 修语法
// 正确：整块重写（用 python 脚本或 Edit 完整替换），确保括号配对
```
每次修改后必须 `node --check static/app.js` 验证。

### ❌ 禁止：代码块插入到表达式中间
```js
// 反模式：const 声明插入到三元/h() 参数列表内
// 正确：声明代码放在 detailBody 表达式之前，或在独立 IIFE/函数中
```

## 事件反模式

### ❌ 禁止：window.prompt / window.confirm / window.alert
```js
// 反模式：原生弹窗与面板风格割裂
const note = window.prompt('请输入');
// 正确：openInlineForm(key, title, placeholder, submit, onDone, opts) 内联表单
```
全站已清零（5→0）——新增交互必须用 openInlineForm 或 toast 操作链接。

### ❌ 禁止：声明链中插入语句
```js
// 反模式：const a = ..., bindCheck(a), const b = ...
// 正确：声明链结束后单独调用 bindCheck
```

## 状态管理反模式

### ❌ 禁止：跨面板作用域调用
```js
// 反模式：ROUTES.overview 里调 ROUTES.market 作用域的 loadNotif()
// 正确：每个面板只调用自己作用域的函数；跨面板通知走 API 数据而非函数调用
```

### ❌ 禁止：引用其他面板作用域的变量
```js
// 反模式：详情页 tabBar 引用 loadDetail 里才声明的局部变量
// 正确：在正确的作用域声明或通过参数传递
```

## 数据刷新反模式

### ❌ 禁止：在 Promise.all 中调用不存在于当前作用域的函数
```js
// 反模式：overview 的 await Promise.all([... loadNotif(), ...])
// 正确：确认函数在当前面板作用域内有定义，或通过 API 数据驱动
```

### ❌ 禁止：autoPoll 的回调引用已脱离文档的 DOM
```js
// autoPoll 已内置 isConnected 检查——面板切走后自动清理定时器
```

## 检查清单（提交前）

1. `node --check static/app.js` 语法通过
2. `npm test` 372 项全绿
3. 浏览器刷新验证所有面板无白屏/加载失败
4. `grep -c "window.confirm\|window.prompt\|window.alert" static/app.js` = 0
5. `grep "loadNotif\|loadXxx" 确认无跨面板引用`
