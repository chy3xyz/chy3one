# opcos-bundle

把 OPC-OS 五插件（`opc-billing` / `opc-memory` / `opc-blackboard` /
`opc-skill-forge` / `opc-team`）打成**一个可安装进真实 DSH 的 profile
bundle 层**（PRD 5.3），并提供启动健康握手 / 故障隔离
（`src/health.ts`，AR-R02 / R-05）。

## 1. Bundle 清单格式（已对照真实样板核实）

本包的声明格式逐字段对照了仓库内安装的真实 bundle
`node_modules/@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-sdk-minimal`：

| 声明项 | 真实格式（本包照抄） | 核实来源 |
|---|---|---|
| bundle 标记 | `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` —— 是**对象 + patch 路径**，不是布尔值 | dsh-base / dsh-sdk-minimal 的 package.json；dsh-app-boot 源码注释 "npm packages whose manifest declares `dsh.bundle.patch`"；`dsh plugin` 的 reconcile 以 `dsh.bundle.patch` 字段存在性判定 bundle |
| patch 文件 | 顶层 YAML 数组；bundle 层是单个 `- insert:` 行列表；行键 `id` / `name` / `inject` / `disabled` / `config`；后续层（用户 profile 的 cordis.patch.yml、`--patch` 叠加）按 `id` 寻址，同行最后写胜出 | dsh-base / dsh-sdk-minimal 的 cordis.patch.yml；dsh-app-boot `applyEntryPatches` |
| `name` 解析 | 裸说明符按包解析（双锚点：先 dsh 安装、后 profile 目录）；`.`/`..` 相对说明符**按 patch 文件自身 URL 解析**（loader 会把 `ctx.baseUrl` 重锚到每个 patch 文件所在目录）；`.ts` 说明符被改写成 `.js`（不转译），因此必须指向编译产物 | cordis-plugin-loader `EntryTree.import` 与 `__rewriteRelativeImportExtension`；dsh-app-boot 的 patch 文件构造函数 |
| `!!js` 表达式 | 在 loader ctx 作用域求值；`dshHomePath(...)`（解析为 `$DSH_HOME` 下绝对路径，不自动建目录）是 boot 时 `ctx.provide('dshHomePath', ...)` 提供的服务，对用户 bundle 同样可用 | dsh-base 行内用法 + dsh-app-boot `boot()` |

因此本包的 `cordis.patch.yml` 五行 `name` 均为相对路径
`../../dist/dsh-plugins/opc-*/src/index.js`——相对 patch 文件自身解析，
指向**本仓库 `npm run build`（tsc：rootDir=packages，outDir=dist）的编译
产物**。以 dsh-base 同构格式声明；发布为独立 npm 包时应改为裸包名并把
五个插件列入 `dependencies` + `peerDependencies: { "@deepseek-ai/cordis": "^4.0.2" }`（对齐 dsh-base 清单）。

## 2. 安装到真实 DSH（三步）

前置：目标机器已安装 `dsh`（本仓库基线为 `@deepseek-ai/dsh` 0.1.5-rc.1
+ `@deepseek-ai/cordis` 4.0.2，见 `docs/dev-design.md` 7.1）。

```sh
# ① 构建并放置仓库（patch 行指向的 dist/ 产物在这里生成）
git clone <this-repo> /path/to/opcos && cd /path/to/opcos
npm install && npm run build          # 产出 dist/dsh-plugins/*/src/index.js

# ② 把本 bundle 注册进一个 profile（R-05：一次性 Profile，删目录即卸载）
dsh plugin --profile opcos add link:/path/to/opcos/packages/opcos-bundle

# ③ 用该 profile 启动
dsh --profile opcos
```

第 ② 步内部行为（`dsh plugin` 源码核实）：首次使用会自动初始化
`$DSH_HOME/profiles/opcos/`（package.json 含 `dsh.profile.bundles` 层栈、
空的 cordis.patch.yml 用户层、pnpm-workspace.yaml），把参数转发给 pnpm
安装，然后把**解析到 `dsh.bundle.patch` 声明的依赖自动并入
`dsh.profile.bundles`**——即本包被挂为 dsh-base 之后的 bundle 层。

注意：

- 用 `link:`（符号链接）安装以保持 monorepo 兄弟目录布局——patch 里的
  `../../dist/...` 相对引用以 patch 文件真实位置为锚；`file:`/拷贝式安装
  会丢失 `../dsh-plugins` 兄弟目录。若宿主经符号链接解析且相对引用失效，
  在 profile 自己的 `cordis.patch.yml` 里按 id 覆盖 `name` 为绝对路径即可
  （同行最后写胜出）。
- 覆盖插件配置同样按 id 覆盖整行 `config`（层间是替换不是合并；与插件的
  `defaultConfig` 合并发生在插件包装器内部）。例如把记忆库挪进 DSH home：
  ```yaml
  - id: opc-memory
    config:
      memoriesFile: !!js dshHomePath('opcos/memories.jsonl')
      instinctsFile: !!js dshHomePath('opcos/instincts.jsonl')
  ```
  （`dshHomePath` 不建目录，先 `mkdir -p "$DSH_HOME/opcos"`。）

## 3. 启动健康握手（AR-R02 / R-05，`src/health.ts`）

两条装载路径并存：

- **声明式**：上面的 patch 行由 DSH loader 直接起 fiber（服务可用性驱动激活）；
- **受控握手**：宿主代码自己驱动 `ctx.plugin()` 时（SDK / headless 入口、
  测试），用本模块保证故障隔离与可恢复性：

`guardedLoad(ctx, plugin, config?, opts?)` —— try/catch 包裹真实 cordis 的
`ctx.plugin()` 并 `await fiber`（cordis 4 的 apply 在微任务后执行，启动
错误以 fiber 拒绝冒出）：

- 成功 → `{ ok: true, fiber }`；
- 失败 → `{ ok: false, error, quarantined: true }`，插件名追加进**隔离清单**
  （JSON `{ version: 1, quarantined: [...] }`，按名去重，0600，路径可注入，
  默认 `./opcos-quarantine.json`；生产应指向 `$DSH_HOME` 下可写目录）。

`loadWithHandshake(ctx, plugins, opts)` —— 启动握手轮：

1. 读**marker**（默认 `./opcos-boot-marker.json`）：上次 `lastBootUnhealthy:
   true` → 本轮**降级**，只装载 `opts.criticalNames`（默认 `[]`）指定的
   core 必需项，其余用户插件全部 `skipped`；
2. 选中项逐一经 `guardedLoad`（单项失败只进隔离清单，不阻断其余插件）；
3. 收尾写 marker：选中项**全部失败** → `{ lastBootUnhealthy: true }`（下一轮
   降级，**保证宿主永远能回来**，AR-R02）；**任一项成功** →
   `{ lastBootUnhealthy: false }`（下一轮自动恢复全量尝试，自愈）；降级轮
   无选中项（criticalNames 为空/不匹配）→ 不改写 marker，保持降级直到配置修复。

健康文件路径全部可注入（R-05 一次性 Profile：删除 profile 目录连同其中
健康文件即完全卸载，宿主不留状态）。

`src/boot.test.ts` 用**真实 cordis**（`new Context()`）验证：五插件全量装载
（五个具名服务可 get）、必抛错插件的隔离与清单内容（JSON/0600/去重）、
二次启动降级（marker + `criticalNames=['opc-billing']` → 只装 opc-billing，
其余 skipped，成功后 marker 自愈）、降级轮空 criticalNames 的 marker 语义。

## 4. 与 `docs/dev-design.md` 第 7 节（升级流程）的衔接

- 基线：`@deepseek-ai/dsh` 0.1.5-rc.1 + `@deepseek-ai/cordis` 4.0.2
  （7.1 版本表）。本 bundle 的 patch 行指向本仓库 dist 产物，**与 cordis
  运行时 ABI 同生命周期**。
- 按 7.3 升级四步走：升根 `package.json` 的 `@deepseek-ai/*` → 跑
  `packages/dsh-adapter` 的 `compat:*` 门禁（锁 waterfall 事件名/载荷与
  `Context` 表面）→ 若漂移只修 `packages/dsh-adapter`（业务插件与 core
  零改动）→ 全量 `npm test` 回归并更新 7.1/7.2。
- bundle 视角的增补：升级后必须**重新 `npm run build`**（DSH 进程加载的是
  dist 里的编译产物，不是 TS 源）；装载/隔离/降级语义由本包
  `src/boot.test.ts` 连同 `packages/dsh-plugins/cordis-runtime.test.ts` 在
  真实 cordis 上把关，升级后任一失败即装载语义漂移，先修 adapter 再回灌。
- 插件永远只依赖稳定 `OpcContext`（7.2 隔离架构），本 bundle 不 import
  cordis 类型——升级不触碰本目录的补丁声明。
