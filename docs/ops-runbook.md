# OPC-OS 控制台运维手册（Ops Runbook）

适用对象：已按 `deploy/README.md` 完成部署的 OPC-OS 控制台（单进程 Node + 本地 SQLite/JSONL 存储）。命令默认在部署目录（如 `/opt/opcos`）下执行，以 systemd 方式为例，Docker 方式见各节括号内替换命令。

## 1. 日常巡检清单

建议每日一次（上班后或定时任务告警时），按顺序执行：

| # | 检查项 | 命令 | 正常标准 | 异常处理 |
| --- | --- | --- | --- | --- |
| 1 | 服务存活 | `systemctl is-active opcos-console` | `active` | 非 active → `journalctl -u opcos-console -n 100` 看日志，按第 2 节排查后 `sudo systemctl restart opcos-console`（Docker：`docker compose ps` 应为 healthy） |
| 2 | 健康端点 | `curl -s http://127.0.0.1:3000/api/health` | `"ok":true` 且 `"quarantined":[]` | `ok:false` 或 quarantined 非空 → 按 2.1 插件隔离流程处理 |
| 3 | 磁盘余量 | `df -h /opt/opcos` | 使用率 < 80% | 超限 → 清理旧备份（`ls -1t backups/*.tar.gz | tail -n +8 | xargs rm -f`）、检查 `memory-bodies.db`/`geo.db` 体积（见第 3 节） |
| 4 | 数据目录体积 | `du -sh opcos-console-data/ && du -h opcos-console-data/*.db | sort -rh | head` | 无单日异常暴涨 | WAL 文件过大（> 数百 MB）→ 重启服务触发 checkpoint；`geo.db` 持续膨胀可评估清理历史监测数据 |
| 5 | 备份成功 | `ls -lht backups/ | head` 且 `tail -5 /var/log/opcos-backup.log` | 昨日 03:00 左右有新 `opcos-backup-*.tar.gz`，日志含「备份完成」 | 无新备份 → 手动跑 `./deploy/backup.sh` 验证，再查 crontab（`crontab -l`）与日志报错 |
| 6 | 备份包可用（每周抽查一次） | `tar -tzf backups/<最新一份>.tar.gz | head` | 能列出 `opcos-console-data/*.db` 与 `memories.jsonl` | 列不出 → 备份链路已坏，立即手动备份并排查磁盘/权限 |

一键巡检脚本示例（可复制执行）：

```bash
systemctl is-active opcos-console \
  && curl -fsS http://127.0.0.1:3000/api/health \
  && df -h / | tail -1 \
  && du -sh opcos-console-data/ \
  && ls -lht backups/ | head -3
```

## 2. 故障排查表

| 现象 | 可能原因 | 排查与处理 |
| --- | --- | --- |
| 接口返回 **503** `SERVICE_UNAVAILABLE`（提示 `service ... is not available (plugin quarantined or unloaded)`） | 宿主插件加载失败被隔离，对应服务缺席 | 见 2.1 |
| 接口/页面返回 **401**（`login required` 或 `用户名或密码不正确` 为 401 `AUTH_FAILED`） | 会话过期或未登录 | 见 2.2 |
| 搜索明显变慢（记忆体/市场检索） | FTS5 降级为 LIKE 全表扫描，或关键词过短未走索引 | 见 2.3 |
| 服务反复重启/起不来 | 端口占用、Node 版本过低、数据目录权限不对 | `journalctl -u opcos-console -n 200`；`lsof -i :3000` 查占用；`node -v` 必须 >= 22.19（内置 `node:sqlite`）；`ls -ld opcos-console-data` 应为 0700 且属主为运行用户（详见 `deploy/README.md` FAQ） |
| 登录连续失败返回 **429** `AUTH_LOCKED` | 短时间内多次密码错误触发锁定 | 等待锁定期结束再试；确认用户名无误 |
| `/api/health` 连接拒绝（curl 失败） | 进程未起或监听地址/端口改过 | `ss -tlnp | grep 3000` 或 `lsof -i :3000` 确认监听 `127.0.0.1:3000`；检查 `PORT`/`HOST` 环境变量是否被改 |

### 2.1 503：插件隔离（quarantine）

插件加载失败时会被记录进隔离清单 `opcos-console-data/opcos-quarantine.json`，`/api/health` 会如实上报。

```bash
# 1. 看哪些插件被隔离
curl -s http://127.0.0.1:3000/api/health | node -e \
  "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('ok:',j.ok);console.log('quarantined:',j.quarantined);console.log(j.plugins.map(p=>p.name+':'+(p.ok?'ok':'DOWN')).join('\n'))})"

# 2. 直接看隔离清单文件
cat opcos-console-data/opcos-quarantine.json

# 3. 查插件加载失败原因（启动日志）
journalctl -u opcos-console -n 300 | grep -i -E 'quarantin|plugin|error'
```

处理顺序：修复根因（常见为依赖缺失、数据目录权限、磁盘满）→ `sudo systemctl restart opcos-console` → 重跑 `/api/health` 确认 `quarantined` 清空、`ok:true`。隔离清单由启动握手重写，修复后无需手工改文件。

### 2.2 401：会话过期，重新登录

- 会话存于 `opcos-console-data/sessions.db`，Cookie 为 HttpOnly，**滑动续期 7 天**（每七天完全不活跃才失效）。401 `UNAUTHORIZED` = 未登录或会话已失效，重新登录即可：
  - 页面：打开控制台首页，前端探针返回 `user:null` 会自动渲染登录页；
  - API：`POST /api/auth/login`（首次使用先 `POST /api/auth/register` 注册）。
- 若大量用户同时 401（而非零星），通常是服务端重启后 `sessions.db` 异常或被换过，检查该库完整性：`sqlite3 opcos-console-data/sessions.db 'PRAGMA integrity_check;'`。
- 401 与 429 区分：429 `AUTH_LOCKED` 是密码连续错误锁定，等锁定期结束；401 只需重新登录。

### 2.3 搜索慢：FTS5 降级检查

记忆体检索（`memory-bodies.db` 的 `body_fts`）与创意市场检索（`ideas-market.db` 的 `market_fts`）使用 FTS5 trigram 索引；检索词 **少于 3 个码点**、或当前 SQLite 构建不支持 FTS5、或 MATCH 语法异常时，自动降级为 LIKE 扫描——功能等价但性能次之，数据量大时体感明显变慢。

```bash
# 1. SQLite 是否带 FTS5（输出含 FTS5 即支持）
sqlite3 opcos-console-data/memory-bodies.db "PRAGMA compile_options;" | grep -i fts

# 2. FTS 表是否存在（应列出 body_fts / market_fts）
sqlite3 opcos-console-data/memory-bodies.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%';"
sqlite3 opcos-console-data/ideas-market.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%';"

# 3. 数据量评估：行数大 + 已降级 LIKE = 慢
sqlite3 opcos-console-data/memory-bodies.db "SELECT count(*) FROM sqlite_master WHERE name='body_fts';"
```

处理：

| 检查结果 | 处理 |
| --- | --- |
| SQLite 构建无 FTS5（步骤 1 无输出） | 换用发行版标准 SQLite/Node 官方构建（Docker 镜像 `node:22-bookworm-slim` 自带），重建部署 |
| FTS 表缺失（步骤 2 无行） | 建库时异常，备份后删除对应 `.db`（连同 `-wal`/`-shm`）重启服务自动重建索引 |
| 用户查询词 < 3 个字 | 属预期降级，引导输入 ≥3 字关键词即可走 trigram 索引 |
| FTS 正常仍慢 | 检查 WAL 积压（`.db-wal` 过大则重启服务触发 checkpoint）与磁盘 IO |

## 3. 数据目录说明（`opcos-console-data/`）

应用自建该目录（权限 **0700**），运行期全部状态都在这里；升级/迁移只保护此目录。目录内还有 `ideas/`、`ideas-market/` 子目录（创意附件与市场衍生数据）与各库配套的 `-wal`/`-shm` WAL 文件（正常现象，随库一同备份）。

| 文件 | 类型 | 用途 | 说明 |
| --- | --- | --- | --- |
| `users.db` | SQLite | 用户库 | 多用户账号（scrypt 口令哈希），内置多用户登录的账号正本 |
| `sessions.db` | SQLite | 会话库 | 登录会话令牌与过期时间（HttpOnly Cookie，7 天滑动续期）；清空即全员下线 |
| `ideas.db` | SQLite | 创意库 | 创意实体主库：`ideas` 表 + **`idea_versions` 版本链（版本历史存于本库内，无独立文件）**；创意归属创建者 |
| `ideas/` | 目录 | 创意工作区 | 每个创意的独立记忆体与产物文件 |
| `memory-bodies.db` | SQLite | 记忆体检索索引 | 记忆体正文 + FTS5 trigram 全文索引（`body_fts`），支持会话级挂载隔离；通常是体积最大的库 |
| `ideas-market.db` | SQLite | 创意市场索引 | 市场检索（`market_fts`）、关注/协同贡献/三口径排行 |
| `subscriptions.db` | SQLite | 订阅库 | 市场订阅与自动续期状态 |
| `geo.db` | SQLite | GEO 监测库 | 生成式引擎品牌可见性监测历史数据，随时间增长明显 |
| `skills.db` | SQLite | Skill 市场库 | 已蒸馏技能包的在售/签名元数据索引 |
| `teams.db` | SQLite | 团队库 | 团队与成员关系（团队创意全员可见可写） |
| `memories.jsonl` | JSONL | 记忆正本 | 记忆/本能的追加式 JSONL 正本（与记忆体库配合），`deploy/backup.sh` 会全量快照 |
| `opcos-boot-marker.json` | JSON | 启动标记 | 记录最近一次成功启动的握手信息，用于启动自检 |
| `opcos-quarantine.json` | JSON | 隔离清单 | 宿主插件加载失败被隔离的名单，`/api/health` 读取上报（见 2.1） |

迁移/瘦身提示：`geo.db`、`memory-bodies.db` 是体积大头；`-wal`/`-shm` 文件可直接随目录整体拷贝（备份脚本已用 `.backup` 热备保证一致性），但**不要**在服务运行时单独删改它们。

## 4. 相关文件

| 文件 | 用途 |
| --- | --- |
| `deploy/README.md` | 部署总览（三种方式、备份恢复、升级流程、FAQ） |
| `deploy/backup.sh` | 备份脚本（SQLite 热备 + JSONL 快照 + tar 保留 N 份） |
| `deploy/nginx.conf.sample` | nginx 反代样例（TLS + basic auth） |
| `deploy/opcos-console.service` | systemd 单元 |
| `Dockerfile` / `docker-compose.yml`（仓库根） | Docker 部署 |
