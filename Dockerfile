# OPC-OS 控制台云部署镜像（多阶段：构建 → 运行）
# 构建上下文 = 仓库根目录；运行时数据全部落在 /app/opcos-console-data（挂卷持久化）
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY tsconfig.json tsconfig.base.json ./
RUN npm ci --include=dev && npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=127.0.0.1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# 运行期数据目录（users/ideas/market/subscriptions/geo 等 SQLite + JSONL 全在其中）
VOLUME ["/app/opcos-console-data"]
EXPOSE 3000
# HOST=127.0.0.1：容器内只监听回环，公网流量经反代/端口映射进入；
# 如需容器直暴露端口，运行时传 -e HOST=0.0.0.0 并自行加鉴权层
CMD ["node", "dist/opcos-console/src/server.js"]
