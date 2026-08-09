#!/usr/bin/env bash
# 首次初始化 —— 把一台空机器变成能跑 catman 的机器。人工执行一次。
#
# 用法(在宿主上,catman 项目目录里):
#   CATMAN_HOST_DATA_DIR=/absolute/path/to/data scripts/evolve/init.sh
#
# 宿主上没有 bash/git/node(软路由常态)时,**整个搬进容器跑**:镜像里这些都有,
# 而它要读写的东西本来就在数据卷里。那时 CATMAN_DATA_DIR 给容器内的 /data、
# CATMAN_HOST_DATA_DIR 给宿主路径 —— 前者是它自己要写的地方,后者是它转手传给
# 下一层 `docker run -v` 的。具体命令见 README「宿主上没有 bash / git / node 怎么办」。
#
# ## 它解决的是一个鸡生蛋问题
#
# 源码直跑之后,容器的 command 指向数据卷里的 `releases/current` —— 而全新机器上
# 数据卷是空的,镜像里也不含任何应用代码。能把第一个 release 造出来的
# `prepare.sh` 本身要在 catman 容器里跑,可那个容器正因为没有 release 而起不来。
#
# 所以第一份 release 必须由**容器外的人**引导出来,就是这个脚本。它不依赖任何
# 已经跑起来的 catman:自己起一次性容器完成 clone、装依赖、测试、编译。
#
# 之后的每一次升级都不再需要它 —— 那时 catman 活着,agent 用 prepare.sh 就够了。

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# 只为了 git_trust_repo —— 见下面调用处的说明。lib.sh 只定义函数与默认值,没有副作用。
# shellcheck source=lib.sh
. "$HERE/lib.sh"

DATA_DIR="${CATMAN_DATA_DIR:-$REPO/data}"
HOST_DATA_DIR="${CATMAN_HOST_DATA_DIR:-$DATA_DIR}"
IMAGE="${CATMAN_IMAGE:-catman-env:1}"
SRC_DIR_HOST="$DATA_DIR/src/catman"
RELEASES_HOST="$DATA_DIR/releases"
REF="${1:-HEAD}"
DOCKER_SOCK="${DOCKER_SOCK_PATH:-/var/run/docker.sock}"

# 一次性容器以 uid 10002 跑,而 docker.sock 的属组是**宿主**的事实(OpenWrt 多为
# root/0,Debian 多为 docker/999),镜像里无从得知。不补这个组,容器里的 docker
# 直接 "permission denied while trying to connect to the Docker daemon socket" ——
# 报错只字不提"组",而它离真正的原因隔着好几层。与 compose 的 group_add 同一个道理。
DOCKER_GID="${DOCKER_GID:-$(stat -c '%g' "$DOCKER_SOCK" 2>/dev/null || echo 0)}"

case "$HOST_DATA_DIR" in
  /*) ;;
  *) echo "CATMAN_HOST_DATA_DIR 必须是绝对路径" >&2; exit 1 ;;
esac
command -v docker >/dev/null || { echo "需要 docker CLI" >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "镜像 $IMAGE 不存在,先构建:" >&2
  echo "  docker build -t $IMAGE -f docker/Dockerfile ." >&2
  exit 1
}

mkdir -p "$RELEASES_HOST" "$DATA_DIR/src" "$DATA_DIR/npm-cache"

# 源码仓库可能是别人(uid 10001)clone 的,而这个脚本通常以 root 跑 —— 属主一不同
# git 就 "detected dubious ownership",下面的 rev-parse 直接死掉。见 lib.sh 的说明。
# 两个仓库都放行:引导副本($REPO)与数据卷里那份可能分属不同用户。
git_trust_repo "$SRC_DIR_HOST" "$REPO"

# 部署密钥(可选)。它就放在数据卷里,所以任何挂了 /data 的容器天然看得到,
# 不需要额外挂载。
# ⚠️ ssh 对私钥有属主检查:文件必须归**当前用户**(或 root)且权限 0600,否则一律拒用。
# 约定归 **uid 10002(deployer)** —— 那个属主本身就是一道闸:agent(10001)读不到它,
# 于是没有任何一条能改写远端历史的路径。远端只由 deployer 在**部署成功之后**推进
# (见 lib.sh 的 push_upstream),所以 GitHub 上出现的永远是真正上线过的提交。
# 这个脚本以 root 跑,读得到 0600 的它;known_hosts 与它放一起,免得交互确认。
SSH_KEY="${CATMAN_GIT_SSH_KEY:-$DATA_DIR/ssh/id_ed25519}"
if [ -f "$SSH_KEY" ] && [ -z "${GIT_SSH_COMMAND:-}" ]; then
  export GIT_SSH_COMMAND="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$DATA_DIR/ssh/known_hosts -o StrictHostKeyChecking=accept-new"
  echo "使用部署密钥:$SSH_KEY"
fi

# 源码仓库落到数据卷里:此后 agent 在它上面开分支干活,而它与 release 目录
# 是两回事 —— release 是从这里 clone 出去的、只读的、可回滚的快照。
if [ ! -d "$SRC_DIR_HOST/.git" ]; then
  echo "把源码 clone 到 $SRC_DIR_HOST"
  git clone "$REPO" "$SRC_DIR_HOST"
else
  # 拉不到就跳过(网络不通、密钥归属对不上都算)。这一步只是顺手刷新,
  # 真正要制备哪个提交由下面的 rev-parse 说了算 —— 本地已有的引用足够。
  echo "源码仓库已存在,顺手拉一次最新提交(失败则跳过)"
  git -C "$SRC_DIR_HOST" fetch origin --quiet || echo "  拉取失败,用本地已有的引用继续"
fi

# agent 的 git 身份。镜像里什么都没配,而 `git commit` 没有 user.name/user.email 就直接
# 失败(那句 "Please tell me who you are" 后面跟着一大段配置指引)—— 自进化的第一步
# 就是提交,所以这一步不做的话,agent 第一次干活必然卡在这里。
# 写**仓库级**而不是 global:不依赖 HOME 可写,而且这份配置随仓库走。幂等,已有仓库也补。
git -C "$SRC_DIR_HOST" config user.name "${CATMAN_GIT_USER_NAME:-catman}"
git -C "$SRC_DIR_HOST" config user.email "${CATMAN_GIT_USER_EMAIL:-catman@localhost}"

# 属主必须交给对应的 uid。制备与部署跑在以 10002 运行的一次性容器里,而 agent 以
# 10001 在 /data/src 上开分支干活 —— 这个脚本却是宿主上的人(通常 root)跑的。
# 不 chown 的话第一次制备就 EACCES,而报错信息(npm 写不了 node_modules)跟真正的
# 原因隔着好几层,极难对号。
# **必须排在 clone 之后**:先 chown 再 clone 的话,新建出来的 catman/ 归创建者所有,
# 上面那次 chown 一个字节都没盖到它 —— 症状要等到 agent 第一次想改代码时才出现。
# 主容器对 releases 是**只读**挂载,所以 10002 这个属主同时也是"助手删不掉回滚目标"的那道闸。
if [ "$(id -u)" = "0" ]; then
  chown -R 10002:10002 "$RELEASES_HOST" "$DATA_DIR/npm-cache"
  chown -R 10001:10001 "$DATA_DIR/src"
  # 部署密钥归 deployer:ssh 的属主检查因此成为一道真闸,agent 读不到它。
  # 这一步幂等,也是从"密钥曾经归 10001"那版迁移过来的唯一动作。
  if [ -d "$DATA_DIR/ssh" ]; then chown -R 10002:10002 "$DATA_DIR/ssh"; fi
else
  echo "⚠️  当前不是 root,跳过 chown。请确认下面三条成立(否则制备会 EACCES):"
  echo "    $RELEASES_HOST 与 $DATA_DIR/npm-cache 可被 uid 10002 写"
  echo "    $DATA_DIR/src 可被 uid 10001 写"
  echo "    $DATA_DIR/ssh(若有部署密钥)归 uid 10002 且密钥 0600"
fi

SHA="$(git -C "$SRC_DIR_HOST" rev-parse "$REF")"
echo "首个 release:$SHA"

if [ -d "$RELEASES_HOST/$SHA" ]; then
  echo "release $SHA 已存在,跳过制备"
else
  PROXY_ENV=()
  for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    [ -n "${!v:-}" ] && PROXY_ENV+=(-e "$v=${!v}")
  done
  # 与 prepare.sh 走**同一条路径**:同一个镜像、同一个 uid、同一套步骤。
  # 两份实现会慢慢走样,而走样的后果是"第一个 release 与后来的不一样",
  # 那种差异最难查。这里直接调 prepare.sh 本身。
  docker run --rm \
    --user 10002:10002 \
    --group-add "$DOCKER_GID" \
    --memory "${CATMAN_PREPARE_MEMORY:-1500m}" \
    --add-host host.docker.internal:host-gateway \
    "${PROXY_ENV[@]}" \
    -e "TZ=${TZ:-UTC}" \
    -e "CATMAN_HOST_DATA_DIR=$HOST_DATA_DIR" \
    -e "CATMAN_IMAGE=$IMAGE" \
    -e "CATMAN_NPM_REGISTRY=${CATMAN_NPM_REGISTRY:-}" \
    -e "CATMAN_PREPARE_MEMORY=${CATMAN_PREPARE_MEMORY:-1500m}" \
    -e "CATMAN_MIN_DISK_MB=${CATMAN_MIN_DISK_MB:-5120}" \
    -e "CATMAN_TEST_FLAGS=${CATMAN_TEST_FLAGS:-}" \
    -v "$HOST_DATA_DIR:/data" \
    -v "$DOCKER_SOCK:/var/run/docker.sock" \
    -w /data/src/catman \
    "$IMAGE" \
    bash /data/src/catman/scripts/evolve/prepare.sh "$SHA"
fi

# 三个指针一起立起来:
#   current —— 容器跑哪个;
#   stable  —— 出事退回哪个(此刻与 current 相同,因为只有这一个);
#   pinned  —— 将来给守护人格钉住的那个(Phase 3 才真正用上,现在先占位,
#              好让 GC 的保留集从第一天起就认得它)。
for name in current stable pinned; do
  ln -sfn "$SHA" "$RELEASES_HOST/$name.tmp"
  mv -T "$RELEASES_HOST/$name.tmp" "$RELEASES_HOST/$name"
done

# 首个 release 直接进已验证清单:它是人工引导出来的,而且下面马上要跑起来。
# 用 shell 写而不是 `node -e`:这个脚本跑在**宿主**上,而宿主(软路由)多半没有
# node —— 整个设计的前提就是"宿主只需要 docker"。内容是固定形状的两个字段,
# 不存在需要 JSON 库的转义问题(sha 是十六进制,时间戳是 date 给的)。
cat > "$RELEASES_HOST/verified-history.json" <<EOF
{
  "schema": 1,
  "releases": [
    { "sha": "$SHA", "verifiedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
  ]
}
EOF

# 清单此后由 deployer(10002)重写,而这个文件是宿主上的人建的。目录属主已经对了,
# 重写走的是 tmp + rename(只要目录可写就行),但把文件也交过去更省心。
if [ "$(id -u)" = "0" ]; then
  chown 10002:10002 "$RELEASES_HOST/verified-history.json"
fi

echo
echo "初始化完成。"
echo "  release:  $RELEASES_HOST/$SHA"
echo "  指针:     current/stable/pinned → $SHA"
echo
echo "接下来:"
echo "  1) 固化部署机制(自进化要用):"
echo "     CATMAN_HOST_DATA_DIR=$HOST_DATA_DIR scripts/evolve/bless.sh"
echo "  2) 起服务:docker compose up -d"
