# OPC-OS 控制台部署指南

OPC-OS 控制台是**单进程 Node 应用 + 本地文件存储**（SQLite + JSONL），最低 1 核 1GB 即可运行。运行期数据全部落在 `opcos-console-data/` 目录（应用自建，权限 0700），升级/迁移只需保护这一个目录。

控制台默认只监听回环地址 `127.0.0.1:3000`（可用 `HOST`/`PORT` 环境变量覆盖），公网访问必须经反向代理（nginx/caddy）做 TLS 终止后转发。内置多用户登录（scrypt 口令哈希 + HttpOnly 会话 Cookie）为第一道防线，反代 basic auth 为第二道防线。

## 前置要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **>= 22.19** | 控制台使用内置 `node:sqlite` 模块，低版本会启动失败；Docker 镜像基于 `node:22-bookworm-slim` 无需关心 |
| npm | 随 Node 附带 | 安装依赖用 `npm ci`（按 `package-lock.json` 精确安装） |
| 反向代理 | nginx / caddy | 仅公网部署需要；样例见 `deploy/nginx.conf.sample` |
| sqlite3 CLI | 可选 | `deploy/backup.sh` 有 sqlite3 时走 `.backup` 在线热备，没有则直接拷贝文件兜底 |

## 三种部署方式对照

| 维度 | Docker Compose（推荐） | systemd 裸机/VM | 反代 + 手动运行 |
| --- | --- | --- | --- |
| 适用场景 | 有 Docker 的云服务器，日常首选 | 无 Docker、想用 systemd 托管进程 | 本地开发、临时验证、已有自己的进程管理 |
| 需要的文件 | `Dockerfile`、`docker-compose.yml`（均在仓库根） | `deploy/opcos-console.service` | 仓库本身 |
| 数据持久化 | 卷挂载 `./opcos-console-data:/app/opcos-console-data` | 工作目录下 `opcos-console-data/` | 同左 |
| 升级方式 | `docker compose up -d --build`（自动重建镜像） | `git pull` + 重新构建 + `systemctl restart` | 手动重启进程 |
| 进程守护 | Docker `restart: unless-stopped` + compose 内置 healthcheck | systemd `Restart=always`（3 秒后拉起） | 无（进程退出即停） |
| 是否需要手动构建 | 否（镜像内自动 `npm ci && npm run build`） | 是（宿主机上构建） | 是 |
| 监听地址 | 容器内 `127.0.0.1:3000`，宿主机映射 `127.0.0.1:3000:3000` | `HOST=127.0.0.1` `PORT=3000` | 同左（默认值） |

三种方式共同的公网出口：nginx/caddy 监听 443 做 TLS，转发到 `127.0.0.1:3000`，配置样例见 `deploy/nginx.conf.sample`。

---

## 方式一：Docker Compose（推荐）

前置：服务器已安装 Docker 与 docker compose 插件。

```bash
# 1. 获取代码
git clone <你的仓库地址> /opt/opcos && cd /opt/opcos

# 2. （可选）配置模型凭据等环境变量：编辑 docker-compose.yml 的 environment 段
#    - DEEPSEEK_API_KEY=sk-...   开启 LLM 撰写与 GEO 热点分析（不配则自动降级为本地规则）
#    - STRIPE_SECRET_KEY=...     开启真实收款（不配则走测试通道）

# 3. 构建并后台启动
docker compose up -d --build

# 4. 验证
docker compose ps                                  # STATUS 应含 (healthy)
curl -s http://127.0.0.1:3000/api/health           # {"ok":true,...}
```

日常运维命令：

```bash
docker compose logs -f opcos-console   # 跟踪日志
docker compose restart                 # 重启
docker compose down                    # 停止（数据卷 ./opcos-console-data 不受影响）
docker compose up -d --build           # 升级后重建
```

要点（对应 `Dockerfile` / `docker-compose.yml`）：

- 端口映射写死 `127.0.0.1:3000:3000`，只绑宿主机回环，公网流量必须经反代进入；若要容器直接暴露端口，需运行时传 `-e HOST=0.0.0.0` 并自行加鉴权层（不推荐）。
- compose 内置 healthcheck：每 30 秒请求一次 `/api/health`，失败 3 次标记 unhealthy。
- 数据目录通过 bind mount 落在宿主机 `./opcos-console-data`，备份、迁移直接操作该目录。

---

## 方式二：systemd 裸机/VM 部署

前置：服务器已安装 **Node >= 22.19**，且具备 git、构建工具链。

```bash
# 1. 获取代码并构建
git clone <你的仓库地址> /opt/opcos && cd /opt/opcos
npm ci && npm run build          # 产物在 dist/

# 2. 安装 systemd 单元
sudo cp deploy/opcos-console.service /etc/systemd/system/
#    按实际部署路径修改单元内两行：
#      WorkingDirectory=/opt/opcos
#      ExecStart=/usr/bin/node dist/opcos-console/src/server.js
#    （ExecStart 用 node 绝对路径，可用 `command -v node` 查询）

# 3. 启动并设开机自启
sudo systemctl daemon-reload
sudo systemctl enable --now opcos-console

# 4. 验证
systemctl status opcos-console
curl -s http://127.0.0.1:3000/api/health
```

要点（对应 `deploy/opcos-console.service`）：

- 单元已设 `Restart=always` / `RestartSec=3`：进程崩溃 3 秒后自动拉起。
- 已启用 `NoNewPrivileges=true`、`PrivateTmp=true` 加固；`DEEPSEEK_API_KEY` 默认注释，需要时取消注释并 `daemon-reload`。
- 运行用户默认为 root；如需专用用户，添加 `User=opcos` 并保证该用户对仓库目录与 `opcos-console-data/` 有读写权限。

---

## 方式三：反向代理 + 手动运行

适合本地开发或临时验证（公网长期运行请用方式一/二）。

```bash
# 1. 构建并启动（前台运行，Ctrl+C 停止）
npm ci && npm run build
npm run console                  # 等价于 node dist/opcos-console/src/server.js

# 2. 或直接指定端口/地址
PORT=3000 HOST=127.0.0.1 node dist/opcos-console/src/server.js
```

公网部署时配套 nginx（样例 `deploy/nginx.conf.sample`，可直接拷贝修改域名）：

```bash
# 1. 安装样例配置（替换 console.example.com 为实际域名）
sudo cp deploy/nginx.conf.sample /etc/nginx/sites-available/opcos.conf
sudo ln -s /etc/nginx/sites-available/opcos.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 2. 入口层 basic auth（第二道防线，控制台自身还有多用户登录）
sudo htpasswd -c /etc/nginx/opcos.htpasswd yourname

# 3. TLS 证书（二选一）
sudo certbot --nginx -d console.example.com        # 自动配置证书
# 或自行指定 ssl_certificate / ssl_certificate_key 路径（样例中已留注释位）
```

要点：nginx 必须转发 `X-Forwarded-Proto: https`，应用据此为会话 Cookie 自动加 `Secure` 标记；`proxy_read_timeout 120s` 是为内容流水线 LLM 模式的慢请求预留的。

---

## 备份与恢复

备份脚本为 `deploy/backup.sh`：SQLite 热备（`.backup` 在线备份，WAL 下安全）+ JSONL/JSON 快照，tar 打包并保留最近 N 份。

### 手动备份

```bash
chmod +x deploy/backup.sh
./deploy/backup.sh                                     # 默认：./opcos-console-data → ./backups，保留 14 份
./deploy/backup.sh ./opcos-console-data /data/backups 30   # 自定义：数据目录 / 备份目录 / 保留份数
```

产出形如 `backups/opcos-backup-20260119-030000.tar.gz`。

### 定时备份（crontab，每日 03:00）

```bash
crontab -e
# 加入一行（路径按实际部署目录调整）：
0 3 * * * cd /opt/opcos && ./deploy/backup.sh >> /var/log/opcos-backup.log 2>&1
```

### 恢复演练（建议每季度做一次）

```bash
# 1. 停止控制台进程（方式二）
sudo systemctl stop opcos-console
#    （Docker 方式：docker compose stop opcos-console）

# 2. 现存数据目录改名留底（不要直接覆盖）
cd /opt/opcos
mv opcos-console-data opcos-console-data.broken

# 3. 解包备份到工作目录（脚本打包内含顶层 opcos-console-data/ 目录）
tar -xzf backups/opcos-backup-<时间戳>.tar.gz -C /opt/opcos

# 4. 校验各库完整性
for db in opcos-console-data/*.db; do
  sqlite3 "$db" "PRAGMA integrity_check;"
done   # 全部输出 ok 即通过

# 5. 重启并验证
sudo systemctl start opcos-console
curl -s http://127.0.0.1:3000/api/health
#    再登录一次控制台，抽查创意列表/记忆检索是否正常

# 6. 确认无误后清理留底
rm -rf opcos-console-data.broken
```

注意：`deploy/backup.sh` 面向 Linux 服务器（使用了 GNU `cp --parents`）；macOS 本机演练请先 `brew install coreutils` 并将脚本内 `cp` 换为 `gcp`，或直接手动 `tar -czf` 打包。

---

## 升级流程

数据全部在 `opcos-console-data/`，升级只动代码与 `dist/`，该目录全程不碰。

```bash
cd /opt/opcos

# 1. （稳妥起见）升级前手动备份一次
./deploy/backup.sh

# 2. 拉代码并重建
git pull
npm ci              # lockfile 变化时精确同步依赖
npm run build       # 重新产出 dist/

# 3. 重启
sudo systemctl restart opcos-console        # systemd 方式
# docker compose up -d --build              # Docker 方式（重建镜像并滚动替换）

# 4. 验证
systemctl status opcos-console
curl -s http://127.0.0.1:3000/api/health    # ok:true 且 quarantined 为空
```

回滚：`git checkout <上一个发布 commit>` 后重复第 2-3 步；如需回滚数据，按上文恢复流程用升级前的备份包还原。

---

## 常见问题（FAQ）

| 问题 | 原因与处理 |
| --- | --- |
| 启动报 `node:sqlite` 不存在或语法错误 | Node 版本低于 22.19（控制台依赖内置 `node:sqlite`，`package.json` `engines` 已声明 `>=22.19`）。用 `node -v` 检查，升级 Node 或改用 Docker 方式（镜像自带 node:22） |
| 启动报 `EADDRINUSE` 端口占用 | `lsof -i :3000` 查看占用进程并结束，或在启动时换端口：`PORT=3001 node dist/opcos-console/src/server.js`（Docker 方式同时改 compose 的端口映射） |
| `opcos-console-data/` 目录权限不对 | 应用自建该目录时即为 `0700`（仅属主可读写）。检查/修复：`chmod 700 opcos-console-data && chown -R <运行用户> opcos-console-data`。若以专用用户运行 systemd 服务，确保该用户对仓库目录有写权限，否则初始化失败 |
| 不配 `DEEPSEEK_API_KEY` 能用吗 | 能。该变量**可选**：配置后开启 LLM 撰写与 GEO 热点分析；不配置时相应功能自动降级为本地规则/模拟口径，核心的创意、记忆、市场、计费流程不受影响。同类的 `STRIPE_SECRET_KEY` 也是可选 |
| 公网直接访问 3000 端口不通 | 这是预期行为：默认 `HOST=127.0.0.1` 只监听回环，公网必须经反代（见方式三的 nginx 配置）。切勿为了图方便改成 `HOST=0.0.0.0` 裸奔 |
| 登录后 Cookie 不带 Secure / 反代下会话异常 | 检查 nginx 是否转发 `X-Forwarded-Proto: https`（样例已含）；该头决定会话 Cookie 是否加 `Secure` |
| 备份文件多大合适/保留几份 | 脚本默认保留 14 份；`memory-bodies.db` 与 `geo.db` 通常是体积大头，磁盘紧张时可用第三参数调小保留份数 |

## 相关文件

| 文件 | 用途 |
| --- | --- |
| `Dockerfile`（仓库根） | 多阶段构建镜像（构建 → 运行），声明 `/app/opcos-console-data` 卷 |
| `docker-compose.yml`（仓库根） | 编排：端口映射、卷、可选环境变量、healthcheck |
| `deploy/opcos-console.service` | systemd 单元（裸机/VM 部署） |
| `deploy/nginx.conf.sample` | nginx 反代样例（TLS 终止 + basic auth + 80 跳 443） |
| `deploy/backup.sh` | 备份脚本（SQLite 热备 + JSONL 快照 + tar 保留 N 份） |
| `docs/ops-runbook.md` | 运维手册（巡检、故障排查、数据目录说明） |
