# OPC-OS · 创意变现操作系统

**让每个创意都有收入。** 基于 DeepSeek Harness（DSH）最新版构建：创意从这里进入（选题/想法），经 AI 团队变成作品（内容/技能），在市场与客户那里变成收入（订单/RaaS 计费）——一条**创意 → 作品 → 收入**的完整漏斗。

需求与架构见 docs/（PRD / ARD / 开发文档）。

## 主轴：创意变现漏斗

```
创意录入 → 内容引擎（AI 选题/撰写/审核/发布）→ Skill Forge（本能蒸馏 → 打包 → 市场在售）→ 收入（订单分成 + RaaS 计费）
     └──────────── 记忆资产（人设/爆款模式/教训）全程沉淀，反哺下一轮创意 ────────────┘
```

- **多用户**：注册登录即得专属创意空间；创意归属创建者，团队创意全员可见可写，市场关注/协同强制实名
- **创意**：控制台一键录入，自动生成三域草案（问题域/解决域/时空域）、初始化独立记忆体与子操作系统，沿 描述→产品→运营→资产 四阶段生命周期推进
- **作品**：内容引擎按创意人设出稿（人设隔离），五平台矩阵（公众号/小红书/抖音/Twitter/B站）适配分发；重复工作流被本能系统自动蒸馏为可售 Skill（Ed25519 签名 .skillpkg）
- **收入**：市场订单（85/15 分成、免费/一次性/订阅三种定价、Stripe 测试通道）+ 数字员工 RaaS 计费（自主解决 ¥2.5/次），分成自动入账创意资产账本
- **资产**：五类资产账本（Skill 沉淀/Meme Token 积分/财务/用户/运营数据）+ 七类记忆资产，全程沉淀反哺创意
- **GEO**：豆包/DeepSeek/ChatGPT/文心 品牌可见性监测（模拟口径），E-E-A-T 检查与 Schema 标记提升被生成式引擎引用概率
- **市场**：创意市场（检索/关注/互补相似关联发现/协同贡献发 Token/三口径排行）

## 快速开始

```bash
npm install
npm test        # 构建 + 全部测试（359 项）
npm run demo    # 整体系统全链路 Demo（真实 cordis，12 步业务闭环）
npm run console # 独立运行控制台（默认 http://127.0.0.1:3000）
```

接入真实智能（可选，均有降级）：`DEEPSEEK_API_KEY` 开启 AI 撰写与热点分析；`stripeSecretKey` 开启真实收款；DSH 配置搜索 provider 后热点自动并入。

## 云服务器部署

单进程 Node 应用 + 本地文件存储，最低 1 核 1GB 即可运行：

```bash
# Docker 方式（推荐）
docker compose up -d --build          # 数据持久化在 ./opcos-console-data

# 裸机/VM 方式（需 Node >= 22.19）
npm ci && npm run build
PORT=3000 HOST=127.0.0.1 node dist/opcos-console/src/server.js   # systemd 见 deploy/
```

公网访问：控制台只监听回环（HOST=127.0.0.1），用 nginx/caddy 做 TLS 终止后转发
（样例见 deploy/nginx.conf.sample，含 basic auth 双层防线；内置多用户登录为第一道防线）。
可选环境变量：`DEEPSEEK_API_KEY`（AI 撰写）、`STRIPE_SECRET_KEY`（真实收款）。

## 安装进 DSH（推荐运行方式）

见 packages/opcos-bundle/README.md。安装后 `dsh web` 的每个页面出现 "⚡ OPC-OS" 启动器，点击即达控制台（支持 `?opcos-panel=orders` 深链直达）。

## 结构

- packages/core — 领域核心（零外部依赖）：创意实体/三域/生命周期、记忆体（FTS5 检索+挂载隔离）、黑板、任务板、Skill 蒸馏/打包、Skill/创意双市场、支付/订单/分成、RaaS 计费/回补、租户隔离、SQLite 存储、内容流水线（多平台+GEO）、GEO 监测、资产账本、Token 积分
- packages/dsh-adapter — DSH/Cordis 唯一接触面（升级隔离层 + compat 门禁 + TelemetryBus）
- packages/dsh-plugins/* — 10 个插件：billing / memory / blackboard / skill-forge / team / marketplace / content / console / lifecycle / geo-monitor
- packages/opcos-bundle — 可安装 Bundle（cordis.patch.yml + 启动健康握手 + 全链路 Demo）
- packages/opcos-console — 创意变现控制台（14 面板：漏斗总览/我的创意/创意市场/协作团队/团队/任务板/黑板/Skill 市场/订单/创作者中心/客户账单/RaaS 计费/内容引擎/创意资产）；多用户注册登录（scrypt 密码 + HttpOnly 会话），每个创意者独立云操作系统，团队创意成员共享协作
