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
# source lib.sh 只为了它开头那句 `load_blessed_env` —— 固化环境(宿主路径、镜像名、
# docker.sock 属组)由它统一读进来。这里曾经有一份自己的 `set -a; . ../env`,
# 与 lib.sh 那份**语义不同**(前者覆盖已有值,后者不覆盖);两份写法慢慢走样正是
# 这类脚本最难查的一类问题,所以收敛成一处。手工执行时那个文件不存在也无妨。
# shellcheck source=lib.sh
. "$HERE/lib.sh"

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
# ⚠️ 「固化了没有」要看**两个视角**,任何一边证实存在就够 —— 它们指的是同一个文件
# (deployer 容器将要执行的那份),只是这个脚本可能跑在两种地方,各自只看得见一边:
#
# **容器内**(catman 的 /发布、rescue 的 demote)看 `$DEPLOY_DIR`:宿主路径在容器里
# 通常根本解不开 —— 真机上 `/opt/services/catman/data` 是一条指向
# `/mnt/usb/catman_data` 的软链,容器挂了 `/opt/services` 却没挂 `/mnt/usb`,
# 链接断在容器内,只认宿主路径就会**每一次 `/发布` 都在这里 exit 1**。而 catman
# 起它时用的是 `stdio: "ignore"`,这句话谁也看不见:用户收到"已提交部署",
# 容器没起、报告没变、日志一片安静。(以前没暴露,是因为部署都由人在宿主上发起。)
#
# **宿主上**(init.sh 指引的首次部署、人工救援)看 `$CATMAN_HOST_DATA_DIR`:宿主没有
# `/data`,只认容器内路径就会让固化副本对着自己报「还没固化」,首次部署当场卡死。
# 开发机上的测试与宿主是同一种处境,test/evolve-lib.test.ts 的「固化链路」用例钉着这条。
#
# 两边都没有才是真没固化。误放行的代价有兜底:宿主路径错了的话 `docker run -v`
# 挂上的是空目录,deployer 立刻失败并写进部署报告,那是看得见的。
[ -f "$DEPLOYER_IN_CONTAINER" ] || [ -f "${HOST_DATA_DIR%/}/deploy/bin/deployer.sh" ] || {
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
  -e "CATMAN_COURIER_CONTAINER=${CATMAN_COURIER_CONTAINER:-catman-courier}" \
  ${CATMAN_HEALTH_URL:+-e "CATMAN_HEALTH_URL=$CATMAN_HEALTH_URL"} \
  ${CATMAN_BAKE_SECONDS:+-e "CATMAN_BAKE_SECONDS=$CATMAN_BAKE_SECONDS"} \
  -v "$HOST_DATA_DIR:/data" \
  -v "$DOCKER_SOCK:/var/run/docker.sock" \
  "$IMAGE" \
  "$DEPLOYER_IN_CONTAINER" "$@"
