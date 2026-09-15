# OPC-OS · 创意变现操作系统

**让每个创意都有收入。** 基于 DeepSeek Harness（DSH）最新版构建：创意从这里进入（选题/想法），经 AI 团队变成作品（内容/技能），在市场与客户那里变成收入（订单/RaaS 计费）——一条**创意 → 作品 → 收入**的完整漏斗。

需求与架构见 docs/（PRD / ARD / 开发文档）。

## 主轴：创意变现漏斗

```
创意录入 → 内容引擎（AI 选题/撰写/审核/发布）→ Skill Forge（本能蒸馏 → 打包 → 市场在售）→ 收入（订单分成 + RaaS 计费）
     └──────────── 记忆资产（人设/爆款模式/教训）全程沉淀，反哺下一轮创意 ────────────┘
```

- **创意**：控制台一键录入，自动进入选题记忆，驱动下一条内容
- **作品**：内容引擎发布图文；重复工作流被本能系统自动蒸馏为可售 Skill（Ed25519 签名）
- **收入**：市场订单（85/15 分成、Stripe 测试通道）+ 数字员工 RaaS 计费（自主解决 ¥2.5/次）
- **资产**：全部过程沉淀为七类记忆资产（人设/爆款模式/教训…），越用越准

## 快速开始

```bash
npm install
npm test        # 构建 + 全部测试（264 项）
npm run demo    # 整体系统全链路 Demo（真实 cordis，11 步业务闭环）
npm run console # 独立运行控制台（默认 http://127.0.0.1:3000）
```

接入真实智能（可选，均有降级）：`DEEPSEEK_API_KEY` 开启 AI 撰写与热点分析；`stripeSecretKey` 开启真实收款；DSH 配置搜索 provider 后热点自动并入。

## 安装进 DSH（推荐运行方式）

见 packages/opcos-bundle/README.md。安装后 `dsh web` 的每个页面出现 "⚡ OPC-OS" 启动器，点击即达控制台（支持 `?opcos-panel=orders` 深链直达）。

## 结构

- packages/core — 领域核心（零外部依赖）：双记忆、黑板、任务板、Skill 蒸馏/打包、市场索引、支付/订单/分成、RaaS 计费/回补、租户隔离、SQLite 存储、内容流水线
- packages/dsh-adapter — DSH/Cordis 唯一接触面（升级隔离层 + compat 门禁 + TelemetryBus）
- packages/dsh-plugins/* — 8 个插件：billing / memory / blackboard / skill-forge / team / marketplace / content / console
- packages/opcos-bundle — 可安装 Bundle（cordis.patch.yml + 启动健康握手 + 全链路 Demo）
- packages/opcos-console — 创意变现控制台（11 面板：漏斗总览/团队/任务板/黑板/Skill 市场/订单/创作者中心/客户账单/RaaS 计费/内容引擎/创意资产）
