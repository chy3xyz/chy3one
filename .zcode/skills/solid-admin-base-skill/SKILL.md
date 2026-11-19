---
name: solid-admin-base-skill
description: 后台管理基础开发规范——适用于 chy3one 控制台（vanilla JS + node:sqlite + 无框架）的面板/路由/表单开发。修改控制台页面、新增面板、调整路由、编辑表单时触发。
---

# 后台管理基础开发规范

适用于 `packages/opcos-console/static/`（前端）与 `packages/opcos-console/src/api.ts`（后端 API）的控制台开发。

## 面板结构

每个面板是一个 `ROUTES.<name>` 异步函数，接收 `box` 容器：

```js
ROUTES.myPanel = async box => {
  // 1. 声明局部变量（输入框/按钮/容器）
  // 2. 定义 load/render 函数
  // 3. render(box, ...) 组装输出
  // 4. await Promise.all([...数据加载])
};
```

## 路由注册

- 侧栏导航项必须在 `index.html` 加 `<a href="#/name" data-route="name">`
- `ROUTE_NAMES` 数组同步追加面板名
- 分组导航：`.nav-group` div 标注所属组

## 深链支持

hash query 由 `router.current()` 解析（如 `#/ideas?id=xxx`），面板通过 `router.query.get('id')` 读取。修改 hash 后**不重写**——保留 query。

## 表单规范

- 用 `h(tag, attrs, ...children)` 构建 DOM（不手动 innerHTML，除非 render/pop）
- 输入框用 `ui.field(label, input)` 包裹获得统一标签样式
- 按钮操作用 `busyBtn(btn, '进行中…', async () => { ... })` 自动禁用/恢复
- 数字输入用 `bindNumberCheck(input, { min, max, integer })` 即时校验
- 确认/阻塞类操作用 `openInlineForm(key, title, placeholder, submit, onDone, opts)` 内联表单（不使用原生 prompt/confirm/alert）
- 提交后 `toast.ok()` 或 `toast.okAction(msg, { label, onclick })` 反馈

## API 调用

- `api.get(path)` / `api.post(path, body)` / `api.request(method, path, body)`
- 401 自动回登录页（sessionExpiredHandled 防重入）
- 后端校验是最终校验——前端只做即时提示

## 安全

- 登录态下所有写操作按当前用户执行（后端强制，前端不传用户身份）
- 危险操作（归档/回滚）必须走 `openInlineForm` 二次确认
- API Key 等凭据只存服务端（0600），前端只显示掩码

## CSS

- 修改样式后 `node --check static/app.js` 验证语法
- `npm test` 回归全量（372 项）+ `npm run demo` 冒烟（12 步）
