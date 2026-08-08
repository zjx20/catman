# catman-env —— 自进化用的**稳定基底镜像**
#
# ## 它为什么不含应用代码
#
# catman 采用**源码直跑**:部署单元是数据卷里的 release 目录
# (`/data/releases/<sha>/` = 浅 clone + 自带 node_modules + dist),切换版本 =
# 原子换一个符号链接再重启容器。镜像因此退化成一层不含业务代码的运行环境,
# **极少变更**(改它属 Tier 3,要人工构建并 bless)。
#
# 这样换来三件事:
#   ① 路由器上不再需要 `docker build` —— 那是一整族资源风险的唯一来源
#      (构建期 OOM 可能连坐 dockerd、镜像层与 build cache 撑爆小磁盘);
#   ② 也不再需要 buildx / BuildKit 兼容性(新版 CLI 的 `docker build` 没有
#      buildx 插件会直接报错),这块坑整个消失;
#   ③ **测试环境即生产环境** —— 主容器、守护人格、流水线的一次性容器
#      (制备/自检)全都用这一个镜像,消灭"测试机上好好的、目标机上炸"的漂移。
#
# ## 依然成立的老约束:npm 装在哪就必须能在哪跑
#
# claude 二进制来自 Agent SDK 的 optionalDependencies(`claude-agent-sdk-<os>-<arch>`),
# npm 按**执行安装的那个容器**的 arch/libc 挑包。源码直跑把这件事挪到了运行时 ——
# 依赖是在**目标机器上**用这个镜像装的,天然就是对的架构,不再需要
# buildx + QEMU 那套多架构构建。基底是 bookworm(glibc);换 alpine 会切到 musl 变体。
# 验证手段不变:容器内 `node -p process.arch` 与 `ls node_modules/@anthropic-ai/` 要对得上。

FROM node:22-bookworm-slim

# 运行时需要 git/ripgrep 等常用工具(助手在容器内执行命令时常用;
# git 还是制备 release 的必需品 —— 每个 release 是一次浅 clone)。
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/*

# Docker CLI(仅客户端,不含 daemon):助手通过挂载进来的 /var/run/docker.sock
# 操作宿主的 Docker(docker-outside-of-docker),deployer 也靠它停/起容器。
# socket 由 compose 挂载,访问权限由 compose 的 group_add 提供。
# apt 源的 codename 从 base image 自身读取,base 升级后不会指向错误的 Debian 版本。
RUN . /etc/os-release \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
     > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/*

# 两个用户,职责分明:
#   catman(10001)  —— 跑应用。bypassPermissions 模式要求非 root。
#   deployer(10002)—— 跑制备与部署。**/data/releases 归它所有**,主容器只读挂载,
#     于是任何一个用户回合里的 `rm -rf` 都会直接 EACCES 暴露,而不是成功删掉
#     回滚目标。这道属主隔离是"回滚目标不被静默改坏"的主防线,不是洁癖。
RUN useradd -m -u 10001 catman \
  && useradd -m -u 10002 deployer \
  && mkdir -p /data \
  && chown catman:catman /data

# 入口脚本。它负责把符号链接解析成真实路径再 exec node —— 见脚本内的说明。
COPY docker/entrypoint.sh /usr/local/bin/catman-entrypoint
RUN chmod 0755 /usr/local/bin/catman-entrypoint

USER catman

ENV CATMAN_DATA_DIR=/data \
    CLAUDE_CONFIG_DIR=/data/claude \
    CATMAN_CHANNEL=wechat \
    CATMAN_RELEASE_LINK=/data/releases/current

EXPOSE 8787

# tini 当 PID 1:agent 会 spawn 一堆子进程(claude CLI 及其工具),
# 没有 init 的话僵尸进程会在长跑的容器里越攒越多。
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/catman-entrypoint"]
