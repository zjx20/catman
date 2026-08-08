#!/bin/sh
# catman 容器入口。
#
# 职责只有两件:把 `CATMAN_RELEASE_LINK` 指的那个符号链接解析成真实路径,
# 然后 exec 进去的 node。中间隔着一个**引导模式**,它存在的理由见下。
#
# ## 为什么不能直接 `node /data/releases/current/dist/src/index.js`
#
# 那是一条数据卷里的路径,而数据卷在**全新机器上是空的** —— 镜像里不含任何应用
# 代码(见 Dockerfile 开头)。直接 exec 的结果是 node 立刻 ENOENT 退出,
# 而 compose 的 restart 策略没有退避:容器会以最快速度反复重启,日志被刷屏,
# dockerd 空转,而真正该做的事(跑一次 bless/init 把第一个 release 建出来)
# 没有任何提示。
#
# 所以链接解析不了时进**引导模式**:打印一句能照做的指引,然后**慢速**重试。
# 慢速是关键 —— 它把"还没初始化"这个状态变成一条每分钟一行的清晰日志,
# 而不是一场刷屏。人跑完 init 之后无需手工干预,下一次重试就正常起来了。
#
# ## 为什么解析成真实路径再 exec
#
# 直接跑符号链接路径的话,node 的模块解析(默认走 realpath)与后续的部署切换
# 会撞上:切换只是把链接指向另一个目录,而**已经在跑的进程**握着的是旧路径 ——
# 这是对的(旧进程本来就该跑完旧代码),但如果进程内部又按链接路径去读文件,
# 就会读到新旧混合的代码。先解析、再 exec,进程从头到尾只认一个真实目录。

set -eu

LINK="${CATMAN_RELEASE_LINK:-/data/releases/current}"
ENTRY="dist/src/index.js"
# 引导模式的重试间隔。60 秒:足够让日志保持可读,又不至于让人跑完 init 后干等太久。
BOOTSTRAP_RETRY_SECONDS="${CATMAN_BOOTSTRAP_RETRY_SECONDS:-60}"

resolve() {
  # -f 解析整条链接链并要求最终目标存在。悬空链接(目标被误删)与链接不存在
  # 在这里是同一个结果,处置也相同 —— 都是"没有可跑的代码"。
  readlink -f "$LINK" 2>/dev/null || true
}

while true; do
  RELEASE="$(resolve)"
  if [ -n "$RELEASE" ] && [ -f "$RELEASE/$ENTRY" ]; then
    echo "[entrypoint] release=$RELEASE"
    cd "$RELEASE"
    exec node "$ENTRY" "$@"
  fi

  echo "[entrypoint] 还没有可运行的 release:$LINK 解析不到 $ENTRY。"
  echo "[entrypoint] 首次部署请在宿主上执行一次初始化(见 README「首次部署」):"
  echo "[entrypoint]   scripts/evolve/init.sh"
  echo "[entrypoint] 如果这是升级后出现的,说明 release 目录被删或链接坏了,"
  echo "[entrypoint] 用 scripts/evolve/deployer.sh rollback 退回上一个已验证版本。"
  echo "[entrypoint] ${BOOTSTRAP_RETRY_SECONDS} 秒后重试。"
  sleep "$BOOTSTRAP_RETRY_SECONDS"
done
