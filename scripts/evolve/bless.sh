#!/usr/bin/env bash
# bless —— 把部署机制**固化**下来。人工执行,这是 Tier 3 的入口。
#
# 用法(在宿主上,catman 项目目录里):
#   CATMAN_HOST_DATA_DIR=/absolute/path/to/data scripts/evolve/bless.sh
#
# 宿主上没有 bash 时同样可以整个搬进容器跑(与 init.sh 一样,见 README)。
#
# ## 它固化什么,为什么
#
# 把 `scripts/evolve/` 里的脚本拷进 `/data/deploy/bin/`,并记下 `/data` 在**宿主上
# 的绝对路径**。此后 catman 的 `/回滚` 执行的是这份固化副本,而不是当前 release
# 里的那份。
#
# 理由是"更新者不能是被更新者":部署脚本住在同一个仓库里,自我进化改得到它们。
# 如果 `/回滚` 执行的是当前 release 里的脚本,那么一次改坏了部署逻辑的进化,
# 会连同"退回上一版"这个能力一起毁掉 —— 门禁和逃生门是同一把锁。固化之后,
# 脚本的更新必须经人再跑一次 bless,而在那之前逃生门用的永远是被验证过的那份。
#
# ## 宿主绝对路径为什么必须在这里定死
#
# deployer 跑在容器里,却要 `docker run -v <宿主路径>:/data` —— 传容器内的
# `/data` 会挂到宿主的 `/data`(通常不存在,dockerd 会静默建一个空目录 root 属主),
# 症状是"每次制备都 ENOENT,而且看不出为什么"。
# 也**不能**指望 compose 里的 `${PWD}`:那是 shell 变量,容器进程的环境里没有它,
# compose 对未设变量只警告一句然后代入空串。所以由人在 bless 时给一次,写进文件。

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

DATA_DIR="${CATMAN_DATA_DIR:-$REPO/data}"
DEPLOY_DIR="$DATA_DIR/deploy"
HOST_DATA_DIR="${CATMAN_HOST_DATA_DIR:-$DATA_DIR}"

case "$HOST_DATA_DIR" in
  /*) ;;
  *) echo "CATMAN_HOST_DATA_DIR 必须是绝对路径,拿到的是:$HOST_DATA_DIR" >&2; exit 1 ;;
esac
# 存在性只能查 $DATA_DIR —— 也就是这个脚本**自己要写进去**的那个路径。
# $HOST_DATA_DIR 是给宿主上的 `docker run -v` 用的,本脚本在容器里跑时它在
# 这个文件系统里根本不存在;拿它做 `-d` 判断会让容器内的 bless 必然失败。
[ -d "$DATA_DIR" ] || { echo "数据目录不存在:$DATA_DIR" >&2; exit 1; }

mkdir -p "$DEPLOY_DIR/bin"
# prepare.sh 与 deployer.sh 一起固化,理由完全相同:**制备门就在 prepare.sh 里**。
# 让 agent 跑 release 里那份的话,一次把 `npm test` 改没了的进化会让此后每一次制备
# 都不再跑测试,而日志上看起来一切正常。能改门的人不能是被门管的人。
#
# ⚠️ **必须用 `install`(或别的先 unlink 再建的方式),不能改成 `cp`。** bash 是
# **边读边执行**的:它按文件偏移量一段段读脚本。`cp` 保留目标 inode、原地覆写字节,
# 于是一个正在跑的脚本会从中间读到新内容,执行一段前言不搭后语的代码 —— 而"正在跑的"
# 最可能是一个处在 30 分钟观察期里的 deployer,人往往正是在等它的时候顺手跑一次 bless。
# `install` 先 unlink 再新建(实测:目标 inode 变了),老 inode 一直活到那个进程读完。
# 有单测钉着"换文件必须换 inode"。
install -m 0755 "$HERE"/lib.sh "$HERE"/deployer.sh "$HERE"/deployer-run.sh "$HERE"/prepare.sh \
  "$DEPLOY_DIR/bin/"

# docker.sock 的属组。deployer 以 uid 10002 跑,不补这个组就连不上 dockerd。
# 在**宿主上** stat 是最权威的取法(容器里那份是挂进去的同一个 inode,但这个脚本
# 本来就跑在宿主上,不必绕);人可以用 DOCKER_GID 覆盖。
DOCKER_SOCK="${DOCKER_SOCK_PATH:-/var/run/docker.sock}"
DOCKER_GID="${DOCKER_GID:-$(stat -c '%g' "$DOCKER_SOCK" 2>/dev/null || echo 0)}"

# 固化环境。deployer-run.sh 与 catman 都读它 —— 一处定义,免得两边各写一份
# 然后慢慢走样。
cat > "$DEPLOY_DIR/env" <<EOF
# 由 scripts/evolve/bless.sh 生成,请勿手改 —— 改了要重新跑一次 bless。
CATMAN_HOST_DATA_DIR=$HOST_DATA_DIR
CATMAN_IMAGE=${CATMAN_IMAGE:-catman-env:1}
CATMAN_CONTAINER=${CATMAN_CONTAINER:-catman}
DOCKER_GID=$DOCKER_GID
EOF
chmod 0644 "$DEPLOY_DIR/env"

# deployer(uid 10002)要往这里写部署报告,而 catman(10001)要读它。
# 目录归 10002、其他人可读 —— catman 只读它,也**只该**读它。
if [ "$(id -u)" = "0" ]; then
  chown -R 10002:10002 "$DEPLOY_DIR"
  chmod 0755 "$DEPLOY_DIR" "$DEPLOY_DIR/bin"
else
  echo "⚠️  当前不是 root,跳过 chown。请确认 $DEPLOY_DIR 可被 uid 10002 写、被 10001 读。"
fi

# ── 钦定稳定面 ─────────────────────────────────────────────────────
# 信使与守护人格跑的是 `pinned`,而**钦定它是显式的人工步骤**(设计 §18):
# 它决定"出事时还活着的是哪份代码",不该由任何自动流程改写。
#
# bless 是那个人工步骤的自然落点 —— 人已经在这儿了,而且 bless 的语义本来就是
# "我认可这一版的部署机制"。默认取当前 `stable`(存活最久的已验证版本)。
#
# **换 pinned 之前先把旧的存进 pinned-prev**:看门狗在信使 crash-loop 时要退到它。
# 少了这一步,一次钦定错误就没有退路 —— 而钦定错误恰恰只会在信使起不来时才发现。
PIN_TARGET="${CATMAN_PIN:-}"
if [ -z "$PIN_TARGET" ]; then
  PIN_TARGET="$(basename "$(readlink -f "$DATA_DIR/releases/stable" 2>/dev/null || echo "")" 2>/dev/null || true)"
fi
if [ -n "$PIN_TARGET" ] && [ -d "$DATA_DIR/releases/$PIN_TARGET" ]; then
  OLD_PIN="$(basename "$(readlink -f "$DATA_DIR/releases/pinned" 2>/dev/null || echo "")" 2>/dev/null || true)"
  if [ -n "$OLD_PIN" ] && [ "$OLD_PIN" != "$PIN_TARGET" ] && [ -d "$DATA_DIR/releases/$OLD_PIN" ]; then
    ln -sfn "$OLD_PIN" "$DATA_DIR/releases/pinned-prev.tmp"
    mv -T "$DATA_DIR/releases/pinned-prev.tmp" "$DATA_DIR/releases/pinned-prev"
    echo "  上一份 pinned 存进 pinned-prev:$OLD_PIN"
  fi
  ln -sfn "$PIN_TARGET" "$DATA_DIR/releases/pinned.tmp"
  mv -T "$DATA_DIR/releases/pinned.tmp" "$DATA_DIR/releases/pinned"
  echo "  稳定面 pinned → $PIN_TARGET(信使与守护人格跑它)"
else
  echo "  ⚠️  没能钦定 pinned(stable 指针不可用)。信使与守护人格起不来 ——"
  echo "      先完成一次部署让 stable 立起来,再重跑 bless;或用 CATMAN_PIN=<sha> 指定。"
fi

echo "已固化到 $DEPLOY_DIR"
echo "  宿主 /data 路径:$HOST_DATA_DIR"
echo "  docker.sock 属组:$DOCKER_GID"
echo "  脚本:$(ls "$DEPLOY_DIR/bin" | tr '\n' ' ')"
echo
echo "提醒:以后改了 scripts/evolve/ 下的任何脚本,都要重新跑一次 bless 才会生效。"
echo "这是刻意的 —— 部署机制属 Tier 3,不随自我进化自动更新。"
