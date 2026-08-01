# catman —— OpenWrt/x86 软路由 Docker 内的 Claude 助手
#
# 多阶段构建:build 阶段装全量依赖(含 typescript/tsx)只为跑一次 tsc;
# 运行时阶段用 `npm ci --omit=dev` 重装纯运行时依赖,再从 build 阶段拷 dist 产物。
# devDependencies(typescript/tsx/esbuild/@types,约 55MB)因此不进最终镜像。
#
# claude 二进制由 Agent SDK 的 optionalDependencies 提供(claude-agent-sdk-<os>-<arch>),
# 无需单独全局安装 —— 但 npm 是按**执行安装的这个容器**的 arch/libc 挑包的。所以**运行时
# 阶段**的 `npm ci` 必须在目标平台下运行(buildx + QEMU 或原生 builder):给它加
# `FROM --platform=$BUILDPLATFORM` 交叉编译会装进构建机架构的二进制,构建期一切正常,
# 只在目标机上起 agent 时才炸。多架构构建步骤见 README「构建多架构镜像」。

FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim

# 运行时需要 git/ripgrep 等常用工具(助手在容器内执行命令时常用)
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Docker CLI(仅客户端,不含 daemon):助手通过挂载进来的 /var/run/docker.sock
# 操作宿主的 Docker(docker-outside-of-docker)。socket 由 compose 挂载,
# 访问权限由 compose 的 group_add 提供 —— 见 docker-compose.yml 的说明。
# apt 源的 codename 从 base image 自身读取,base 升级后不会指向错误的 Debian 版本。
# 需要 `docker buildx` 时在下面追加 docker-buildx-plugin(镜像约 +50MB)。
RUN . /etc/os-release \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
     > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

# 非 root 用户:bypassPermissions 模式要求非 root 运行
RUN useradd -m -u 10001 catman \
  && mkdir -p /data \
  && chown catman:catman /data

WORKDIR /app

# 纯运行时依赖。npm 缓存清理与 chown 必须与安装同层:分层的话,缓存(内含整个 claude
# 二进制的 tarball)会留在镜像里;而单独一层 `chown -R` 会因写时复制把整个 node_modules
# 在新层里再复制一份 —— 这两条曾让镜像凭空大出数百 MB。
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && chown -R catman:catman /app

COPY --from=build --chown=catman:catman /app/dist ./dist

USER catman

ENV CATMAN_DATA_DIR=/data \
    CLAUDE_CONFIG_DIR=/data/claude \
    CATMAN_CHANNEL=wechat

EXPOSE 8787
CMD ["node", "dist/src/index.js"]
