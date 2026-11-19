---
name: tanstack-table-form-skill
description: 后台表格与表单最佳实践——适用于 chy3one 控制台的 ui.table / ui.field / form-grid / toolbar 模式。新增数据表格、编辑表单、操作列、分页筛选时触发。
---

# 后台表格与表单最佳实践

适用于 `packages/opcos-console/static/app.js` 中所有使用 `ui.table` / `ui.field` / `ui.toolbar` / `form-grid` 的面板。

## 表格（ui.table）

### 基本用法
```js
ui.table(['列1', '列2', '操作'], rows.map(item => [
  item.name,                          // 文本
  ui.badge(item.status, 'ok'),        // 徽标
  h('button', { text: '操作' }),       // 按钮
]))
```

### 行构建规范
- 行数据用变量中间步骤（不把 IIFE 塞进数组元素分隔符后）
- 操作列放最后一个元素（`<div class="row-actions">` 包多个按钮）
- 金额列用 `money(cents)` 换算分→元
- 时间列用 `fmtTime(epoch)` 格式化
- 状态列用 `ui.badge(text, variant)` 语义色

### 空态
- `rows.length === 0` 时返回 `ui.empty('空态文案——指向下一步动作')`
- 空态文案必须可操作（不是"暂无数据"而是"做什么可以看到数据"）

### 排序/筛选
- 后端支持筛选：toolbar 加筛选控件 + API 参数传递
- 后端不支持：前端 filter（数据量 <1000 时可接受）

## 表单（ui.field / form-grid）

### 基本用法
```js
ui.field('标签 label', inputElement)
h('div', { class: 'form-grid' }, field1, field2, field3)
h('div', { class: 'form-grid form-grid-1' }, field)  // 单列布局
```

### 即时校验
```js
bindNumberCheck(input, { min: 0, max: 100, integer: true });
// input 事件即时红框；提交时后端仍为最终校验
```

### 提交模式
```js
busyBtn(saveBtn, '提交中…', async () => {
  const result = await api.post(path, { ... });
  toast.ok('成功消息');  // 或 toast.okAction(msg, { label, onclick })
  loadList();  // 刷新列表
});
```

## 工具栏（ui.toolbar）

```js
ui.toolbar(
  ui.grow(ui.field('关键词', searchInput)),   // 弹性搜索框
  ui.field('筛选', filterSelect),             // 固定宽筛选
  ui.actions(actionBtn, totalCountText)       // 操作按钮 + 统计
)
```

## 分页

数据量 ≤200 时不做前端分页（全量渲染）。超过时：
- 后端 LIMIT/OFFSET（API 已支持 limit 参数的端点直接传）
- 前端"加载更多"按钮追加到 rows 尾部

## 禁止

- ❌ 表格内嵌套 iframe
- ❌ 行内编辑（点击行进入编辑态）——用独立表单或弹层
- ❌ 隐藏列（用 responsive CSS 控制列可见性）
- ❌ 无限滚动（数据量不超过 200，分页即可）
