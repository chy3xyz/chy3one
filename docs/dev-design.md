# OPC-OS 开发文档（技术设计与开发规范）

> **产品主轴（2026-09-16 定版）：创意变现。** 所有功能围绕漏斗**创意 → 作品 → 收入**组织：
> 创意录入（记忆 topic 层）→ 内容引擎产出作品（图文发布）→ 本能蒸馏为可售 Skill（市场在售）→
> 双通道收入（订单分成 + RaaS 计费）；全过程沉淀七类记忆资产反哺创意。
> 控制台总览即漏斗视图，新增功能须回答"它在漏斗的哪一段、如何提升转化"。

| 文档属性 | 内容 |
|---|---|
| 文档编号 | DEV-OPCOS-2026-001 |
| 文档版本 | v1.0 |
| 关联文档 | PRD-OPCOS-2026-001 v2.0 / ARD-OPCOS-2026-001 v1.0 |
| 文档状态 | 开发基线 |
| 更新日期 | 2026-09-15 |

## 1. 文档目的

将 PRD/ARD 中的需求映射为可执行的工程结构：代码仓库布局、模块划分、接口契约、开发规范与测试策略。本文档是开发阶段的唯一基线，需求变更需同步更新本文档。

## 2. 工程结构（Monorepo）

```
chy3one/
├── docs/                      # PRD / ARD / 本文档
├── package.json               # workspace 根
├── tsconfig.base.json
├── packages/
│   ├── core/                  # @opcos/core：领域模型与存储抽象（无 DSH 依赖）
│   │   └── src/
│   │       ├── memory/        # 双记忆系统：Memory(知识) + Instinct(行为)
│   │       ├── blackboard/    # 黑板：乐观锁并发仲裁 + Scope 链
│   │       ├── skill/         # Skill 蒸馏：质量门控 + 蒸馏产物
│   │       └── billing/       # RaaS 计费：埋点事件 + 计费引擎
│   └── dsh-plugins/           # DSH/Cordis 插件层（薄适配，依赖 core）
│       ├── opc-blackboard/    # 黑板插件（注册为 DSH 服务）
│       ├── opc-memory/        # 双记忆插件
│       ├── opc-billing/       # RaaS 计费插件（waterfall 插桩）
│       └── opc-skill-forge/   # Skill 蒸馏插件
└── tests/                     # 集成测试与验收测试（对应 PRD AC-01~AC-08）
```

**分层原则**：
- `core` 是纯 TypeScript 领域库，不依赖 DSH/Cordis 运行时，可独立单测（应对 R-01 DSH API 漂移：业务逻辑与框架解耦）。
- `dsh-plugins` 只做协议适配：实现 `apply(ctx, config)`，把 core 能力注册进 `ctx`，生命周期清理统一走 `ctx.effect()`（AR-R06）。
- 插件对外服务一律通过 `ctx.get()` 运行时解析（AR-C06），禁止编译期硬依赖其他插件。

## 3. 模块设计

### 3.1 @opcos/core — memory（双记忆系统，ARD-004）

```typescript
interface MemoryEntry {
  id: string
  scope: 'global' | 'workflow' | 'agent'
  category: 'soul'|'user'|'project'|'fact'|'lesson'|'topic'|'rules'
  content: string
  confidence: number   // 0..1
  ttl?: number         // 秒；过期由检索时惰性判定
  createdAt: number
}

interface MemoryStore {
  write(entry: Omit<MemoryEntry,'id'|'createdAt'>): MemoryEntry
  query(criteria: {scope?, category?, keyword?, limit?}): MemoryEntry[]  // R@5 检索入口
}
```

- 存储实现：`JsonlStore`（默认，memories.jsonl / instincts.jsonl，append-only 满足 AR-R03）+ `SqliteStore`（Phase 2 接入）。
- Instinct 侧输入是工具调用观测记录 `ToolObservation { tools: string[], success: boolean, timestamp }`。

### 3.2 @opcos/core — blackboard（ARD-002）

```typescript
interface Blackboard {
  read(scope: 'global'|'workflow', key?: string): BlackboardEntry[]
  write(entry: Omit<BlackboardEntry,'version'|'updatedAt'>): WriteResult
}
// WriteResult: { status: 'ok' } | { status: 'conflict', resolvedBy: 'timestamp+confidence' }
```

- 乐观锁：写入携带 `expectedVersion`，冲突时按"时间戳+置信度"仲裁（PRD 6.2.2）。
- 写权限：global scope 仅 Orchestrator 角色可写；越权写抛 `PermissionError`。
- 目标：并发 5 Agent 写入延迟 < 100ms（AR-P04）；存储先 JSONL + 内存索引（TD-01），Phase 3 迁 SQLite WAL。

### 3.3 @opcos/core — skill（Skill Forge 蒸馏核心，PRD 6.1）

- `PatternMiner`：从 Instinct 观测流中检测重复 ≥ 3 次且成功率达标的工具序列（识别率 ≥ 80%、误报 < 10% 的基础版：序列编辑距离聚类 + 重复计数门控）。
- `QualityGate`：不完整序列标记"低置信度"不蒸馏；质量不达标提示手动编辑。
- `SkillDistiller`：产出 PRD 6.1.2 定义的 YAML 产物（trigger / tool_sequence / post_conditions / memory_snapshot）。

### 3.4 @opcos/core — billing（RaaS，ARD-005）

```typescript
interface BillingEvent {
  taskId: string; agentId: string
  resolution: 'resolved' | 'escalated'
  tokensUsed: { prompt: number; completion: number }
  durationMs: number; timestamp: number
}
```

- 计费规则表驱动（`BillingRule = { resolution, unitPrice }`），resolved 计费、escalated 免费并返回 lesson 写入指令。
- 事件 append-only 落盘（billing-events.jsonl），丢失可从 Session 日志回溯补录。

### 3.5 DSH 插件层

每个插件遵循 PRD 5.3 规范：导出 `name`、`inject`、`Config`(Schema)、`apply(ctx, config)`；所有注册通过 `ctx`，手动资源用 `ctx.effect()` 声明清理。`opc-billing` 在 `agent/pre-step` / `agent/request` waterfall 点埋点。

## 4. 开发规范

| 项 | 规范 |
|---|---|
| 语言/运行时 | TypeScript 5.x strict；Node.js ≥ 22.19 |
| 模块格式 | ESM（`"type":"module"`），无 CJS 产物 |
| 依赖 | core 层零外部运行时依赖（SQLite 用内置 node:sqlite）；插件层只依赖 `@opcos/dsh-adapter`，adapter 层才接触 `@deepseek-ai/cordis` |
| 测试 | `node --test`（内置测试器），单测随包；验收测试映射 AC 编号 |
| 命名 | 文件 kebab-case；类型/类 PascalCase；插件包名 `opc-*` |
| 错误处理 | 领域错误继承 `OpcError`（带 `code`）；异常策略遵循 PRD 各"异常与边界处理"表 |
| 安全 | 日志脱敏（RC-04）；凭据 AES-256-GCM（Phase 2 引入 `credential/` 模块） |

## 5. 测试与验收映射

| 用例组 | 覆盖验收项 |
|---|---|
| pattern-miner.test（≥20 条用例） | AC-01 本能提炼 |
| memory.test（R@5 检索） | AC-04 |
| blackboard.test（并发 5 写者） | AC-03 |
| billing.test（≥1000 笔批量） | AC-05 |
| plugin-unload.test（副作用撤销） | AC-07 |

## 6. 里程碑（对齐 PRD 第 10 章）

| 迭代 | 交付 |
|---|---|
| M1（已完成） | core 四模块 + 单测 + opc-billing 插件骨架（mock ctx 验证生命周期） |
| M2（已完成） | opc-memory / opc-blackboard（持久化+埋点）/ opc-team（目标解析+token预算）插件；core 新增 packager（`.dshpkg` Ed25519 签名/验签/安装回滚，AR-S05/AC-02）；opc-skill-forge 插件（观测→蒸馏→打包闭环）。49 项测试全通过 |
| M3（已完成） | 基线切换到最新 DSH（dsh 0.1.5-rc.1 + cordis 4.0.2）并建立 adapter 升级隔离层与 compat 门禁；五插件迁移至 OpcContext 稳定接口并经真实 cordis `ctx.plugin()` 加载验证；SQLite WAL 双存储（AR-P03 实测 8ms / AR-P04 实测 0.02ms/条）；租户隔离（AES-256-GCM 凭据库、租户过滤 store、0700 租户目录）与 RaaS Session 日志回补；四插件业务 E2E。98 项测试全通过 |
| M4（已完成） | 埋点 API 统一为 TelemetryBus（TD-04 偿还）；支付/订单/分成（30s 超时取消、幂等支付、85/15 整数分账零误差、402 风格 Mock 通道 + opc-marketplace 插件）；Skill 市场索引（SQLite、关键词/分类/评分/DSH 版本兼容过滤，50k 条实测 0.1ms~7.6ms，预算 500ms，AR-P08）；opcos-bundle（对照 dsh-base 真实格式的 cordis.patch.yml + 启动健康握手：单插件崩溃隔离不拖垮 Profile、上次不健康降级只装关键项，AR-R02）。157 项测试全通过（M4 收口）|

## 7. DSH 版本基线与同步升级策略

### 7.1 当前基线（2026-09-15，rc.2 升级后）

| 组件 | 版本 | 说明 |
|---|---|---|
| `@deepseek-ai/dsh` | 0.1.5-rc.2 | `next` 通道最新；与全部 web 子包（web-app/webserver/client-modules 等）同版本对齐 |
| `@deepseek-ai/cordis` | 4.0.2 | 插件运行时，最新 stable |
| Node.js | ≥ 22.19 | engines 约束 |

> **版本判断要点（实测教训）**：官方 `latest` dist-tag 会滞后（dsh 的 latest 曾停在 rc.1，dsh-web 的 latest 甚至停在 0.0.1-rc.1）。判断"是否最新"要对比 `npm view <pkg> dist-tags` 的 `latest`+`next`+`alpha` 与已装版本，而非只看 latest。升级通道约定：`next`（rc）跟进，`alpha` 跳过；rc.1→rc.2 升级经 compat 门禁零适配通过，隔离层按预期工作。

### 7.2 升级隔离架构

```
┌────────────────────────────────────────────┐
│ packages/dsh-plugins/*   业务插件            │  只依赖稳定接口 OpcContext
├────────────────────────────────────────────┤
│ packages/dsh-adapter     适配层（唯一接触面）│  adaptContext / defineOpcPlugin
├────────────────────────────────────────────┤
│ @deepseek-ai/cordis 4.x  @deepseek-ai/dsh  │  升级时只动这层
└────────────────────────────────────────────┘
```

- 业务插件 `import` 的只有 `@opcos/dsh-adapter` 与 `@opcos/core`，**永不直接 import cordis**。
- 适配层封装 cordis 4.x 的 `ctx.provide/get/on/effect` 为 `provideService/getService/onEvent/onWaterfall/onDispose`，并内置 `createMockContext`（无 DSH 环境单测）。
- cordis 4.x waterfall 真实载荷形状（已在源码中核实）：`agent/pre-step` 载荷 `{messages, turn, signal}`、决策 `{kind:'enter'|'reject', messages}`；`agent/request` 载荷含 `provider/model`。

### 7.3 同步升级流程（DSH 新版本发布时）

1. 根 `package.json` 升级 `@deepseek-ai/dsh` 与 `@deepseek-ai/cordis` 到目标版本，`npm install`。
2. 跑升级门禁测试 `packages/dsh-adapter/src/context.test.ts` 中 `compat:*` 用例——它们直接断言已安装包内真实源码的 API 表面（waterfall 事件名、载荷字段、Context 类型签名），任何漂移立即失败并指明需要修的适配层位置。
3. 若门禁失败：只修改 `packages/dsh-adapter`（必要时在 `OpcContext` 上加版本探测分支），业务插件与 core 零改动。
4. 全量 `npm test` 回归，更新本节版本表与 7.2 的载荷形状描述。

### 7.4 已核实的 cordis 4.x 契约要点

- 插件形状：函数插件 `{ name?, Config?: StandardSchemaV1, inject?, provide? }` + `(ctx, config)`；`ctx.plugin(plugin, config)` 加载。
- `ctx.provide(name, value)` 返回撤销函数；`ctx.get(name)` 运行时解析服务。
- `ctx.on(name, listener)` 返回 `() => boolean` 退订函数。
- `ctx.effect(execute)`：body 立即执行，返回的函数即卸载逆操作（LIFO）。
- **waterfall 真实语义（2026-09-15 事故更正）**：Koa 式组合而非"返回值替换链"。监听器实际签名 `(payload, next)`，**不调用 `next()` 即否决整条链（含官方默认行为）**，最外层监听器的返回值成为结果；修改载荷靠原地变更 args，而非返回值。adapter 的 `onWaterfall` 已封装：OPC 监听器返回 `undefined`（观察语义）→ 自动 `next()` 放行官方链；非 `undefined` 仅对自有事件有效。行为门禁测试 `compat: waterfall 行为语义` 锁定此契约（违反时症状：官方 `decision.kind` 读 undefined，所有 Agent turn 秒失败）。

## 8. 风险落地

- R-01（DSH 漂移）：adapter 隔离层 + `compat:*` 门禁测试（见第 7 节），core 与业务插件零接触 cordis。
- TD-01：存储接口 `MemoryStore`/`BlackboardStore` 抽象化，SQLite 迁移不改调用方。
- 计费可靠性：事件先落盘后处理（write-ahead），与 Session 日志同源可回溯。
- TD-04（已偿还，M4）：三插件埋点订阅统一为 `TelemetryBus`（adapter 共享类型，`subscribe(fn) → 退订函数`）。
- Bundle 安装：`packages/opcos-bundle`（`dsh.bundle.patch` 声明 + insert 层），安装/健康握手/升级衔接见其 README。

## 9. opcos-console × DSH Web 协同模式

### 9.1 已核实的 DSH Web 架构（dsh 0.1.5 源码）

| 组件 | 职责 |
|---|---|
| `dsh-host-webserver` | 宿主 HTTP：具名路由注册（`webServer.register({kind:'exact'\|'prefix', path, handler(req,res)})`，最长前缀胜出，重复 (kind,path) 抛错）+ 单一静态兜底 + index 注入 |
| `dsh-web-app`（`dsh web` 命令） | 组合 webserver + 前端静态 + 各 `dsh-client-ui-*` 面板（GUI 即插件集合） |
| `dsh-client-modules` | 客户端 UI 插件注册表（boot graph 注入同一 SPA），index-inject 事件可注入全局脚本 |
| `@deepseek-ai/dsh-web` | 注意：这是 `ctx.web`（Agent 搜索/抓取 provider seam），不是 Web UI |

### 9.2 协同三模式（均已实现）

1. **standalone（sidecar）**：`npm run console`，独立端口，与 `dsh web` 并行、共享数据目录。
2. **hosted（已实现，推荐）**：`opc-console` DSH 插件把 UI+API 挂到官方 webServer 的 **`/opcos`** 顶层前缀（不占用官方 `/api`）；`ctx.inject(["webServer"], …)` 响应式等待，路由注销走 `effect`（AR-R06）。三种 mode：`auto`（默认，有 webServer 即挂载、无则自起）/ `standalone` / `hosted`；`hostedPlugin` 入口声明 `inject:['webServer']` 供 profile 使用。共享逻辑在 `packages/opcos-console/src/api.ts`（12 端点 + 静态前缀剥离），两种形态同源。
3. **官方 GUI 启动器（已实现）**：hosted 模式下监听 `webserver/index-inject`（官方类型化注入行：style/script，每次 GUI 页面渲染收集），向官方 GUI 每个页面注入右下角 "⚡ OPC-OS" 启动器按钮 + 全屏 iframe 遮罩（懒加载 `/opcos/`、幂等、`launcher:false` 可关）。**取舍记录**：官方 React client-module 体系（`dsh.client` 声明 + `__ModuleLoader__` + 私有 primitives/pnpm 工具链）反向适配脆弱、维护成本高；launcher 方案用受支持的插件 API 达成同一入口体验，符合升级隔离原则。若未来 DSH 开放声明式面板槽位，可再评估全量迁移。

### 9.3 官方挂载范式（照此实现，勿自创）

```js
ctx.inject(["webServer"], (webCtx) => {
  const route = { kind: "prefix", path: "/opcos", handler: async (req, res) => {/*…*/} };
  webCtx.effect(() => webCtx.webServer.register(route)); // 卸载自动注销
});
```

### 9.4 真实 DSH 联调记录（2026-09-15，dsh web @ :3080）

- 安装：`dsh plugin --profile web add link:<repo>/packages/opcos-bundle`（写 profile package.json 的 `dsh.profile.bundles` + pnpm link；`patchReload: live` 只作用于 patch 文件，**新挂 bundle 需重启 `dsh web`**）。
- loader 取插件入口用 `exports.default ?? exports`——bundle 场景 default 必须是 hostedPlugin（`inject:['webServer']`）；headless profile 下 dormant 即可。
- hosted 前提：webServer 是响应式服务，auto 模式在 apply 时单次探测不可靠（apply 早于 webServer 装载 → 误回退 standalone）——bundle 场景一律用 hostedPlugin。
- 前端部署路径自感知：`API_BASE = location.pathname.startsWith('/opcos') ? '/opcos' : ''`，standalone/hosted 同一份静态文件。
- 启动器注入实测：官方 GUI 页面（authed index）含 opc-launcher 全套元素，点击弹出全屏控制台，徽标"运行中"、数据正常。
- 已知点：`/opcos` 路由不经过 DSH 的 401 认证网关（认证属 fallback/index 层）——公网部署需在 handler 内自行鉴权或置于反代之后（M5 待办）。
- **代码生效契约**：静态文件（static/）热读源码目录，改动即生效（响应已带 `cache-control: no-store`，防启发式缓存陈旧——曾发生 app.js 陈旧事故）；API 层（api.ts 编译进 dist）随进程固化——**改 API 必须重启 `dsh web`**，否则新面板请求 404。
- 前端渲染串行化：面板渲染走 Promise 链，杜绝并发渲染的过期覆盖（首帧竞态事故修复，2026-09-15）。

> 注：M4 表内数字为各里程碑收口时点值；当前全量测试数以 `npm test` 实时输出为准（本评估时点为 174）。

## 10. PRD v2.0（CreativeOS）升级章节（DEV-OPCOS-2026-002，2026-09-16）

> 对应产品文档 docs/prd2.md（PRD-OPCOS-2026-002）：产品单元从 v1 的 Agent/工具收敛为**创意（Idea）一等公民**——四阶段生命周期（描述→产品→运营→资产）、独立记忆体、子操作系统、双市场。本章记录落地形态与 v1 章节的增量契约。

### 10.1 新增核心模块（packages/core）

| 模块 | 职责 | 对应 PRD 需求 |
|---|---|---|
| `idea/` | Idea 实体（四阶段状态机数据层）+ 三域框架（每域≥3 引导问题）+ 规则策略三域草案 + SqliteIdeaStore（ideas 表 + `$DSH_HOME/ideas/<id>/` 目录脚手架：memory-body 七 JSONL 正本、assets/ledger.json、assets/token.json、profile/cordis.patch.yml、meta.json 镜像） | ID-01/02/03、2.4、2.5 |
| `memory/body-index.ts` + `memory-body.ts` | 记忆体检索索引（SQLite FTS5 **trigram**：中英文≥3 字任意子串命中；FTS5 不可用自动回退 LIKE；查询必带 ideaIds 过滤=挂载隔离）+ MemoryBodyHub（JSONL append-only 正本 + 索引镜像 + 会话级 mount/unmount） | 2.4、8.3、10 |
| `memory/body-bridge.ts` | 创意记忆体 ↔ MemoryStore 桥（v1 七类 category → 记忆体流映射），供内容流水线按创意隔离人设 | CO-02 |
| `lifecycle/` | IdeaLifecycle 线性单向状态机（description→product→operation→asset）：迁移写 decisions 正本（authority=model）+ profile 的 stage 行重写；非法迁移 `STAGE_TRANSITION_INVALID` | 3.4、4.5 |
| `mvp/` | planMvp（三域→功能清单/技术栈/三段计划，模板策略）+ suggestGoNoGo（确定性规则：≥2 条且均值≥3.5 → go） | IP-01/04 |
| `workspace/` | IdeaWorkspace 路径守卫：绝对路径/`..`/盘符逃逸一律 `PERMISSION_DENIED`，读写根限定 `ideas/<id>/workspace/` | IP-02、3.3 |
| `content/platforms.ts` | 五平台矩阵（wechat/xiaohongshu/douyin/twitter/bilibili）Mock 适配器 + MultiPlatformDispatcher（逐平台适配耗时、单平台失败隔离） | CO-03 |
| `content/geo.ts` | E-E-A-T 四维启发式检查（advisory：扣分不改 pass）+ Schema JSON-LD 生成 + 结构化选题加权（FAQ/指南/对比 +0.3） | 4.3 策略一/二/三 |
| `geo/` | GeoMonitor（探测→visibility_drop≥0.2 告警→SQLite 快照→onSnapshot 回调写记忆体 analytics 流）+ MockGeoProvider（确定性伪随机，GeoProvider 接口可换真实/LLM 估值） | 4.4 |
| `asset/` | IdeaLedger：`assets/ledger.json` 五类资产账本（prd2.md 5.5 同形；金额一律"分"） | 5.5 |
| `token/` | TokenLedger：Meme Token 积分账本（**不上链**，R-02 合规定位；45/25/20/10 分配模型；角色配额+总量双重约束 `TOKEN_ALLOCATION_EXCEEDED`；distribution.json append 流水） | 5.4、6.5 |
| `idea-market/` | SqliteIdeaMarket：公开摘要发布（+summary.json 文件镜像）、FTS5 检索、关注+阶段变更通知、关联发现（三域 bigram Jaccard + 阶段互补 → complementary/similar）、协同贡献记录（6.4 六角色权重）、三口径排行 | IM-01~06、ID-05 |
| `bench/prd2-nfr.test.ts` | NFR 基线：1000 创意目录、挂载切换 <500ms（实测 ~30ms）、1000 摘要检索 <500ms（实测 ~110ms） | 10 |

### 10.2 新增插件（packages/dsh-plugins）

| 插件 | 服务 | 说明 |
|---|---|---|
| `opc-lifecycle` | `opc.lifecycle` | 生命周期编排的 DSH 服务形态；与控制台共享 ideas.db / ideas/ 目录 / memory-bodies.db（WAL 多连接）。PRD `creativeos/lifecycle-manager` 的物理形态 |
| `opc-geo-monitor` | `opc.geo` | GEO 监测服务（writeToMemory 接线：快照写 analytics 流）。PRD `creativeos/geo-monitor` 的物理形态 |

**命名约定说明**：PRD 8.2 的 `creativeos/*` 为逻辑名，物理插件沿用仓库 `opc-*` 约定（dev-design 第 4 章）。`creativeos/idea-marketplace` / `skill-marketplace` 未单独成插件——市场索引由控制台本地构造（SqliteIdeaMarket/SqliteSkillIndex），与 skills.db 同模式；DSH 侧工具经 summary.json/ledger.json 文件镜像访问。

### 10.3 控制台增量（opcos-console）

- **新面板**：我的创意（列表/阶段推进/三域编辑器/记忆体检索写入/挂载开关/MVP 方案与验证/GEO 监测/资产与 Token/市场发布与协同）、创意市场（搜索/排行/关注/通知）。总览漏斗段 1 切换为 Idea 实体口径。
- **新端点**：`/api/ideas/:id`（详情/domains/transition/mvp/*/workspace/entries/ledger/token/geo/publish/collab）、`/api/memory-bodies(+mount)`、`/api/guiding-questions`、`/api/market/*`、`/api/notifications`。创意库未配置时 `/api/ideas` 自动降级 v1 topic 行为。
- **资产联动**：orders/pay 对作者为创意（authorId=创意ID）的订单自动把 85% 创作者分成入账该创意 `skill_revenue`；geo 刷新联动账本 analytics；协同按角色权重（默认 权重×100）发放 Token。
- **签名同源**：createMarketCatalog 返回目录级 Ed25519 密钥（内存持有私钥），publish-draft 用其签名，修复"新签名包无法通过目录公钥验签安装"的断层。
- **插件清单**：standalone 启动装载 9 插件（8 个 v1 插件 + opc-lifecycle + opc-geo-monitor；opc-console 自身 hosted/standalone 二态不在此列）。
- **多用户云操作系统**：`core/auth`（UserStore scrypt+timingSafeEqual / SessionStore sha256 哈希落库+滑动续期 7 天 / TeamStore owner-member 两角色）+ ideas 表 owner_id/team_id 增量迁移；API 鉴权闸门（`/api/health` 与 `/api/auth/*` 匿名白名单，其余 401）；创意访问控制 403；市场关注/协同登录态强制实名。生产默认开启，`ConsoleOptions.auth=false` 仅本地兼容测试。**补齐 9.4 的 standalone 鉴权缺口**——反代仍建议做 TLS。
- **GEO 7×24 调度**：opc-geo-monitor `refreshIntervalMs`（默认 5min，0 关闭）周期探测全部创意，防重叠/单创意失败不阻断；订阅支付自动激活权益（活跃期续订从到期时间顺延）。

### 10.4 需求编号 ↔ 测试映射（PRD v2.0）

| 需求 | 测试 |
|---|---|
| ID-01 三域草案 | core `idea/store.test.ts`、`three-domains.test.ts` |
| ID-02 三域引导/迭代 | core `idea/store.test.ts`、console `server.test.ts`（创意实体端点） |
| ID-03 创意初始化 | core `idea/store.test.ts`（脚手架+幂等） |
| ID-04 版本链/回滚 | core `idea/store.test.ts`（版本链与回滚）、console（versions/rollback 端点集成） |
| 记忆体/挂载/FTS5（8.3） | core `memory/body-index.test.ts`、`memory-body.test.ts` |
| 子OS profile（2.5） | core `idea/store.test.ts`（阶段同步重写） |
| 生命周期（3.4/4.5） | core `lifecycle/lifecycle.test.ts`、plugin `opc-lifecycle/index.test.ts` |
| IP-01/04 MVP | core `mvp/planner.test.ts`、console M2 集成 |
| IP-02 工作区隔离 | core `workspace/workspace.test.ts`、console M2 集成（越界 403） |
| CO-02 人设隔离 | core `memory/body-bridge.test.ts`（端到端流水线） |
| CO-03 多平台 | core `content/platforms.test.ts` |
| 4.3 GEO 行销 | core `content/geo.test.ts` |
| 4.4 GEO 监测 | core `geo/monitor.test.ts`、plugin `opc-geo-monitor/index.test.ts` |
| 5.4/6.5 Token | core `token/points.test.ts` |
| 5.5 账本 | core `asset/ledger.test.ts` |
| 7.5 .skillpkg | core `skill/packager.skillpkg.test.ts` |
| IM-01~06 创意市场 | core `idea-market/market.test.ts`、console M5 集成 |
| IM-03 关联准确率 ≥70% | core `idea-market/relations-accuracy.test.ts`（50 组标注评测集，实测 100%） |
| SM-01/02/04 技能市场 v2 | console M5 集成 |
| SM-04 订阅续费语义 | core `marketplace/subscriptions.test.ts`（激活/顺延/懒到期）、console 集成（支付激活+权益检查） |
| 4.4 7×24 调度 | plugin `opc-geo-monitor/index.test.ts`（周期自动探测/dispose 停表/interval=0 关闭） |
| 多用户鉴权/团队 | core `auth/auth.test.ts`（scrypt/会话/团队）、console 集成（注册登录/越权 403/团队可见性/关注防冒名） |
| 10 NFR | core `bench/prd2-nfr.test.ts` |

### 10.5 偏差与口径说明

- **Meme Token 为积分账本**（R-02 自身缓解措施），不接链；数据形态对齐 6.5，接口预留 chain provider 扩展位。
- **GEO 监测数据为模拟口径**（主流 AI 平台无公开可见性 API），MockProvider 确定性伪随机，UI/API 均显式标注 `simulated`；GeoProvider 接口可替换 LLM 估值/真实采集。
- **PRD 9.1 统计数字内部不一致**（P0×18 vs 模块表加总 24），执行以模块表 P0 编号为准。
- 记忆体检索隔离采用"单库 + idea_id 过滤列"而非每创意独立 .db；规模验证（bench）达标后如需物理隔离再演进。
