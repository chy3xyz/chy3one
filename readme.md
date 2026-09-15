# OPC-OS

基于 DeepSeek Harness（DSH）最新版的一人公司变现操作系统。需求见 docs/（PRD / ARD / 开发文档）。

## 基线

- @deepseek-ai/dsh 0.1.5-rc.1 + @deepseek-ai/cordis 4.0.2（升级流程与门禁测试见 docs/dev-design.md 第 7 节）

## 快速开始

```bash
npm install
npm test        # 构建 + 全部测试（174 项）
npm run demo    # 整体系统全链路 Demo（真实 cordis，11 步业务闭环）
npm run console # 启动统一控制台 UI（DSH 操作系统入口，默认 http://127.0.0.1:3000）
```

## opcos-console 统一控制台

零依赖 Web UI（`packages/opcos-console`）：总览 / 团队 / 黑板 / Skill 市场 / 订单交易 / RaaS 计费 / 记忆库七面板，中文深色主题，hash 路由。两种运行形态（共享 `src/api.ts`）：

- **独立运行**：`npm run console`（sidecar 模式，真实 cordis 装载六插件 + 健康握手）
- **DSH 插件模式**：`packages/dsh-plugins/opc-console` 挂到官方 `dsh web` 的 webServer `/opcos` 前缀（`mode: auto|standalone|hosted`，auto 自动选择；推荐 profile 入口 `hostedPlugin`，声明 `inject:['webServer']`）。hosted 下还会经官方 `webserver/index-inject` 通道向 GUI 每页注入 "⚡ OPC-OS" 启动器按钮（全屏遮罩内嵌控制台，`launcher:false` 关闭）。bundle 已含 opc-console 条目。协同架构见 docs/dev-design.md 第 9 节。

已知小瑕疵：首次点击侧边导航偶发主区渲染延迟，刷新即恢复。

## 安装进真实 DSH

见 packages/opcos-bundle/README.md（dsh plugin --profile opcos add link:... 三步安装，含启动健康握手说明）。

## 结构

- packages/core — 领域核心（零外部依赖）：双记忆、黑板、Skill 蒸馏/打包、RaaS 计费/回补、租户隔离、SQLite 存储、支付/订单/分成、市场索引
- packages/dsh-adapter — DSH/Cordis 唯一接触面（升级隔离层 + compat 门禁 + TelemetryBus）
- packages/dsh-plugins/* — opc-billing / opc-memory / opc-blackboard / opc-skill-forge / opc-team / opc-marketplace
- packages/opcos-bundle — 可安装 Bundle（cordis.patch.yml + 健康握手装载器 + 全链路 Demo）
- packages/opcos-console — 统一控制台（HTTP 服务 + 单页 UI，DSH 操作系统入口）
