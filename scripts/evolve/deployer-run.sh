#!/usr/bin/env bash
# 把 deployer 起进一个**独立的一次性容器**里。
#
# catman 的 `/回滚` 执行的就是这个脚本(的 bless 固化副本)。它薄得刻意 ——
# 真正的逻辑在 deployer.sh 里,这里只负责"起一个不会跟着 catman 一起死的进程"。
#
# ## 为什么必须是独立容器,而不是 catman 里的一个子进程
#
# deployer 做的第一件事就是 `docker stop catman`。跑在 catman 里的子进程会在
# 那一刻连同父进程一起被杀,切换停在半路:容器停了、链接换了一半、没人拉起来。
# 独立容器则完全不受影响,还能在 catman 死在观察期里时照样完成回滚。
#
# 容器名固定 = 天然的串行互斥:第二个部署请求会因为重名直接失败,而不是与第一个
# 并发去动同一组指针。

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 固化环境(bless 生成)。catman 直接执行本脚本,而它的 env 里没有宿主路径这类值 ——
# 从这里读,一处定义,免得两边各写一份然后慢慢走样。手工执行时不存在也无妨,
# 那种场合由调用者自己 export。
if [ -f "$HERE/../env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HERE/../env"
  set +a
fi

CONTAINER="${CATMAN_DEPLOYER_CONTAINER:-catman-deployer}"
IMAGE="${CATMAN_IMAGE:-catman-env:1}"
DEPLOY_DIR="${CATMAN_DEPLOY_DIR:-/data/deploy}"
HOST_DATA_DIR="${CATMAN_HOST_DATA_DIR:?必须给出 /data 在宿主上的绝对路径}"
DOCKER_SOCK="${DOCKER_SOCK_PATH:-/var/run/docker.sock}"
# deployer 以 uid 10002 跑,而它做的每一件事(停容器、起容器、跑 smoke)都要过
# docker.sock。socket 的属组是**宿主**的事实(OpenWrt 多为 root/0,Debian 多为
# docker/999),镜像里无从得知,所以运行时补组 —— 与 compose 给主容器的 group_add
# 是同一个决定。取值优先用 bless 时记下来的(宿主上 stat 出来的那个,最权威),
# 否则就地 stat 一次。漏了这一步的症状是 `/回滚` 起了容器却什么都没做,
# 日志里只有一句 permission denied —— 而那正是最需要它工作的时刻。
DOCKER_GID="${DOCKER_GID:-$(stat -c '%g' "$DOCKER_SOCK" 2>/dev/null || echo 0)}"

# 跑的必须是**固化过的**那份 deployer,不是当前 release 里的那份。理由见 bless.sh:
# 门禁和逃生门是同一把锁,不能让一次改坏了部署逻辑的进化把它们一起毁掉。
DEPLOYER_IN_CONTAINER="$DEPLOY_DIR/bin/deployer.sh"
[ -f "${CATMAN_HOST_DATA_DIR%/}/deploy/bin/deployer.sh" ] || {
  echo "部署机制还没固化 —— 先在宿主上跑一次:" >&2
  echo "  CATMAN_HOST_DATA_DIR=$HOST_DATA_DIR scripts/evolve/bless.sh" >&2
  exit 1
}

# 上一次的容器留到现在才删:它的日志是"上次部署到底发生了什么"的唯一现场,
# 而部署失败之后人最想看的就是那个。
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

PROXY_ENV=()
for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
  [ -n "${!v:-}" ] && PROXY_ENV+=(-e "$v=${!v}")
done

# -d:起完就返回。调用方(catman 的 /回滚)拿不到结果也不该等 —— 它自己马上就要
# 被停掉了。结果由下一次启动读部署报告播报。
exec docker run -d \
  --name "$CONTAINER" \
  --user 10002:10002 \
  --group-add "$DOCKER_GID" \
  --restart no \
  --add-host host.docker.internal:host-gateway \
  "${PROXY_ENV[@]}" \
  -e "TZ=${TZ:-UTC}" \
  -e "CATMAN_HOST_DATA_DIR=$HOST_DATA_DIR" \
  -e "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}" \
  -e "CATMAN_IMAGE=$IMAGE" \
  -e "CATMAN_CONTAINER=${CATMAN_CONTAINER:-catman}" \
  ${CATMAN_HEALTH_URL:+-e "CATMAN_HEALTH_URL=$CATMAN_HEALTH_URL"} \
  ${CATMAN_BAKE_SECONDS:+-e "CATMAN_BAKE_SECONDS=$CATMAN_BAKE_SECONDS"} \
  -v "$HOST_DATA_DIR:/data" \
  -v "$DOCKER_SOCK:/var/run/docker.sock" \
  "$IMAGE" \
  "$DEPLOYER_IN_CONTAINER" "$@"
