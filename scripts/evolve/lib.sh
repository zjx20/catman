#!/usr/bin/env bash
# 自进化流水线的公共部分:路径、日志、锁、JSON 读写、release 校验。
#
# ## 一个贯穿全部脚本的简化
#
# 源码直跑之后,**切换版本不需要重建容器** —— 容器的配置(镜像、挂载、env、端口)
# 一个字都没变,变的只是数据卷里那个符号链接指向哪个目录。所以部署动作是
# `docker stop` + 换链接 + `docker start`,全程**不碰 docker compose**。
#
# 这不是图省事:compose 一旦进场,就要处理它的文件优先级(compose.yaml 覆盖
# docker-compose.yml)、override 的自动合并、`${PWD}` 这类只在人的 shell 里存在的
# 变量插值(在容器里一律变空串)、项目名不一致导致的容器认领失败、以及两个不同
# compose 版本算出的 config hash 不同引发的反复 recreate。这些都是真实的、
# 会在"人不在电脑前"的时候发作的坑。不用它就一个都不存在。
#
# 代价说清楚:改 compose 仍然要人(它属 Tier 3),这套脚本也**不会**替你应用
# compose 的变更 —— 那正是我们想要的边界。

set -euo pipefail

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 固化环境的兜底 ─────────────────────────────────────────────────
# bless 会把 `/data` 的宿主绝对路径这类"只有人知道"的值写进 `/data/deploy/env`。
# 固化之后 lib.sh 就住在 `/data/deploy/bin/`,于是这份 env 正好在隔壁 —— 谁 source 了
# lib.sh 谁就自动拿到它,不必每个调用点都记得 export 一遍。
#
# 这是 prepare.sh 能被 agent 直接跑起来的前提:agent 的进程环境里没有宿主路径,
# 而 prepare 要拿它去 `docker run -v`。缺了就是一句 `CATMAN_HOST_DATA_DIR: 必须给出…`,
# 而那句话不会告诉他值该从哪来。
#
# **已经有值的一律不覆盖。** 命令行上显式给的(`CATMAN_IMAGE=foo prepare.sh …`)必须赢 ——
# 那是排查时唯一的旋钮,被一份静态文件盖掉的话,人会以为自己的覆盖没生效而去怀疑别处。
load_blessed_env() {
  local file="${CATMAN_BLESSED_ENV:-$LIB_DIR/../env}" line key val
  [ -f "$file" ] || return 0
  # 末行没有换行符时 read 会返回非零但 $line 有内容,所以补一个 `|| [ -n "$line" ]`。
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in \#* | "") continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    # 不像环境变量名的行一概跳过:这份文件是机器生成的,但读它的这段代码要能
    # 扛住有人手改出一行奇怪的东西 —— 我们在这里 export,写错了就是注入。
    case "$key" in *[!A-Za-z0-9_]* | "") continue ;; esac
    if [ -z "${!key:-}" ]; then export "$key=$val"; fi
  done < "$file"
  return 0
}
load_blessed_env

RELEASES_DIR="${CATMAN_RELEASES_DIR:-/data/releases}"
DEPLOY_DIR="${CATMAN_DEPLOY_DIR:-/data/deploy}"
SRC_DIR="${CATMAN_SRC_DIR:-/data/src/catman}"
LOCK_FILE="$RELEASES_DIR/.deploy-lock"
HISTORY_FILE="$RELEASES_DIR/verified-history.json"
REPORT_FILE="$DEPLOY_DIR/report.json"
NPM_CACHE_DIR="${CATMAN_NPM_CACHE_DIR:-/data/npm-cache}"

CATMAN_CONTAINER="${CATMAN_CONTAINER:-catman}"
# 信使容器。它跑 `pinned`,而 pinned 坏掉时**微信整个聋掉** —— 两个人格都在它身后。
CATMAN_COURIER_CONTAINER="${CATMAN_COURIER_CONTAINER:-catman-courier}"
CATMAN_IMAGE="${CATMAN_IMAGE:-catman-env:1}"
# 健康检查走**宿主上映射出来的端口**,不走容器网络:deployer 是 `docker run` 起的
# 一次性容器,不在 compose 网络里;而共享 catman 的 netns(--network container:catman)
# 会让 deployer 在 catman 被停掉的那一刻一起死 —— 那恰好是它最要活着的时刻。
HEALTH_URL="${CATMAN_HEALTH_URL:-http://host.docker.internal:8787/health}"

# 保留几个已验证版本。3 个 = 当前 + 两级可回退,够覆盖"回滚后发现更早的版本才对"。
KEEP_VERIFIED="${CATMAN_KEEP_VERIFIED:-3}"

log() { echo "[$(date -Is)] $*" >&2; }
die() { log "错误:$*"; exit 1; }

# ── JSON:用 node 而不是 sed ────────────────────────────────────────
# 镜像里 node 本来就在,而用 sed/grep 拼 JSON 是这类脚本最经典的出错来源
# (一个含特殊字符的 detail 就能写出一份让 catman 读不懂的报告)。

json_get() { # json_get <file> <js表达式,d 是解析后的对象>
  local file="$1" expr="$2"
  node -e '
    const fs = require("fs");
    let d = {};
    try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
    const v = (() => { try { return eval(process.argv[2]); } catch { return undefined; } })();
    process.stdout.write(v === undefined || v === null ? "" : String(v));
  ' "$file" "$expr"
}

json_write() { # json_write <file> <json字符串>
  local file="$1" payload="$2"
  node -e '
    const fs = require("fs"), path = require("path");
    const [file, payload] = process.argv.slice(1);
    // 原子写:tmp + rename。读它的是另一个进程(catman),半截 JSON 会被它
    // 的防御式解析当成"没有报告",这条结果就静默丢了。
    const tmp = file + ".tmp";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(JSON.parse(payload), null, 2));
    fs.renameSync(tmp, file);
  ' "$file" "$payload"
}

# ── git:接受属主不同的仓库 ─────────────────────────────────────────
# `/data/src/catman` 归 catman(10001)所有 —— agent 在上面开分支干活;而制备跑在
# deployer(10002)下。属主一不同,git 就以 "detected dubious ownership" 拒绝打开它,
# **第一条 git 命令就失败**,而这条路径在开发机上永远碰不到(那里两者是同一个人)。
# 不是绕过安全检查:这个目录的属主正是 init.sh 自己设定的,不是外来仓库。
#
# **两条都要**:`rev-parse` 认的是仓库目录本身,而 `clone` 认的是它下面的 `.git`
# (报错里的路径带 `.git` 后缀)—— 只加前一条会一路正常到 clone 那步再炸。
#
# **必须走配置文件(`GIT_CONFIG_GLOBAL`),不能用 `GIT_CONFIG_COUNT` 那族环境变量。**
# `git clone <本地路径>` 会 fork 一个 `git-upload-pack` 去读**源仓库**,而 git 把
# `GIT_CONFIG_COUNT` 划进"仅属于当前仓库、换仓库就得清掉"的那一类,fork 前显式 unset:
#     trace: run_command: unset GIT_CONFIG_COUNT GIT_DIR; git-upload-pack '…/.git'
# 于是子进程看不到任何例外,自己做属主检查、自己 fatal,父进程只剩一句
# "Could not read from remote repository" —— 症状指向网络/权限,离真正的原因很远。
# 换成 `GIT_CONFIG_GLOBAL` 后被清的只有 `GIT_DIR`,配置活着穿过每一层子进程。
#
# 文件写在 /tmp(哪个 uid 都写得进),所以**每个进程/容器各自调一次**;
# 不要把 `GIT_CONFIG_GLOBAL` 传给另一个容器 —— 那边的 /tmp 里没有这个文件,
# 而 git 对读不到的 global 配置是静默当空的,例外就这么无声无息地丢了。
git_trust_repo() { # git_trust_repo <仓库目录>...
  local cfg="${CATMAN_GIT_CONFIG:-/tmp/catman-gitconfig}" dir
  local prev="${GIT_CONFIG_GLOBAL:-${HOME:-}/.gitconfig}"
  # **绝不能把这份配置 include 进它自己。** 第二次调用时 GIT_CONFIG_GLOBAL 已经指向
  # cfg,若照旧 include 一次就成了循环,git 会以 "exceeded maximum include depth"
  # 拒掉**该进程里的每一条 git 命令** —— 不是某一条失败,是全废。
  # 这条路径不是假想:prepare 先调一次并导出 GIT_CONFIG_GLOBAL,随后 `npm test`
  # 继承了它,测试里再调一次,于是整个测试进程的 git 全挂。
  # 所以只有第一次(prev 还不是我们自己)才重建;之后只追加例外。
  if [ "$prev" != "$cfg" ]; then
    : > "$cfg"
    # 保留原有的 global 配置(身份、insteadOf、代理等):我们是往上叠例外,不是替掉它。
    if [ -f "$prev" ]; then git config --file "$cfg" --add include.path "$prev"; fi
  fi
  for dir in "$@"; do
    git config --file "$cfg" --add safe.directory "$dir"
    git config --file "$cfg" --add safe.directory "$dir/.git"
  done
  export GIT_CONFIG_GLOBAL="$cfg"
}

# ── 部署密钥:两个槽位,一读一写 ───────────────────────────────────
# 密钥放在数据卷里,所以任何挂了 `/data` 的容器天然看得到。**两把,不是一把**:
#
#   /data/ssh/fetch/id_ed25519   属主 10001(agent) —— **只读** deploy key,用来 pull
#   /data/ssh/id_ed25519         属主 10002(deployer)—— 可写 deploy key,用来 push
#
# ssh 对私钥有属主检查(必须归当前用户或 root 且 0600),所以一把钥匙只能服务一个 uid ——
# 这不是设计选择,是 ssh 的硬约束。分成两把之后:
#
# - **agent 拉得到代码**。这条路是主路径:人在开发机上改完 push 到 GitHub,
#   路由器上的 catman 得把它拉下来才谈得上制备。曾经把密钥整个归 10002,
#   结果 agent 一行 `git pull` 都跑不了,而软路由宿主上连 git 都没有,
#   "人上机 pull"实际是"再起一个容器,以 root 跑,跑完还要把 .git 里新生成的
#   root 属主对象 chown 回去"—— 那不是一条能长期走的路。
# - **agent 依然改不了远端历史**。这道闸从"文件属主"上移到了 **GitHub 侧的只读
#   deploy key**,而那比属主强:属主挡不住一个挂了 docker.sock 的助手,只读密钥挡得住。
#
# 只放一把也能跑,按属主决定谁能用(见 fetch_key_path):放给 10001 则 pull 通、push 跳过;
# 放给 10002 则反过来。**pull 比 push 重要** —— 后者只是让远端记录上线过的版本。

# 那把用来 push 的(deployer 侧)。找不到或读不到都返回空 —— 调用方据此跳过并说明。
push_key_path() {
  local key="${CATMAN_GIT_SSH_KEY:-${CATMAN_SSH_DIR:-/data/ssh}/id_ed25519}"
  [ -r "$key" ] && echo "$key"
  return 0
}

# 那把用来 fetch 的(agent 侧)。解析顺序:显式指定 → 专用的 fetch/ → 只放了一把
# **且那把归 10001** 的兜底。最后这条是为"我只做了一个 deploy key 并给了助手"准备的,
# 少了它,那种配置下 agent 会拿到一把自己读不了的钥匙,报错停在 ssh 的属主检查上。
fetch_key_path() {
  local ssh_dir="${CATMAN_SSH_DIR:-/data/ssh}"
  local explicit="${CATMAN_GIT_FETCH_KEY:-}"
  if [ -n "$explicit" ]; then
    [ -f "$explicit" ] && echo "$explicit"
    return 0
  fi
  local dedicated="$ssh_dir/fetch/id_ed25519"
  if [ -f "$dedicated" ]; then
    echo "$dedicated"
    return 0
  fi
  local single="$ssh_dir/id_ed25519"
  if [ -f "$single" ] && [ "$(stat -c '%u' "$single" 2>/dev/null || echo -1)" = "10001" ]; then
    echo "$single"
  fi
  return 0
}

# 拼一条 ssh 命令。known_hosts 跟密钥放一起,免得每次都要交互确认。
ssh_command_for() { # ssh_command_for <私钥路径>
  echo "ssh -i $1 -o IdentitiesOnly=yes -o UserKnownHostsFile=$(dirname "$1")/known_hosts -o StrictHostKeyChecking=accept-new"
}

# 给**当前进程**设上 push 用的密钥。已经有 GIT_SSH_COMMAND 时不动它:
# 调用方显式给的优先(与 load_blessed_env 同一取向)。
git_ssh_env() {
  if [ -n "${GIT_SSH_COMMAND:-}" ]; then return 0; fi
  local key
  key="$(push_key_path)"
  if [ -z "$key" ]; then return 0; fi
  GIT_SSH_COMMAND="$(ssh_command_for "$key")"
  export GIT_SSH_COMMAND
  return 0
}

# ── 部署锁 ─────────────────────────────────────────────────────────
# 带心跳的锁,不是简单的 mkdir 互斥:deployer 可能在 bake 期间(半小时)被 OOM
# 杀掉,一个没有心跳的锁会把部署能力永久锁死;而看门狗要靠心跳超时来判断
# "deployer 已经死了,该我接管收尾了"。

LOCK_HELD=""

lock_acquire() { # lock_acquire <owner>
  local owner="$1" now stale_after=2700 # 45min > bake 上限
  mkdir -p "$RELEASES_DIR"
  now="$(date +%s)"
  if [ -f "$LOCK_FILE" ]; then
    local beat owner_old age
    beat="$(json_get "$LOCK_FILE" 'd.heartbeat')"
    owner_old="$(json_get "$LOCK_FILE" 'd.owner')"
    # 心跳读不出来(锁文件损坏/格式变了)按"已经死了"处理:一把读不懂的锁若能
    # 永久挡住部署,那连回滚都做不了 —— 那比冒一次并发的风险糟得多。
    if [ -n "$beat" ]; then age=$((now - beat)); else age="$stale_after"; fi
    if [ "$age" -lt "$stale_after" ]; then
      die "另一个部署正在进行(owner=${owner_old:-?},$age 秒前还活着)"
    fi
    log "接管一把过期的锁(owner=${owner_old:-?},静默 $age 秒)"
  fi
  json_write "$LOCK_FILE" "{\"owner\":\"$owner\",\"heartbeat\":$now}"
  LOCK_HELD="$owner"
}

lock_beat() {
  [ -n "$LOCK_HELD" ] || return 0
  json_write "$LOCK_FILE" "{\"owner\":\"$LOCK_HELD\",\"heartbeat\":$(date +%s)}"
}

lock_release() {
  [ -n "$LOCK_HELD" ] || return 0
  rm -f "$LOCK_FILE"
  LOCK_HELD=""
}

# ── 指针 ───────────────────────────────────────────────────────────
# **写指针的只有 deployer**。current 由部署与回滚改;stable 只在观察期通过后前移
# (指针单主原则)。看门狗将来只把 current 拨回 stable,绝不动 stable。

pointer_target() { # pointer_target <name> → 真实路径(解析不了则空)
  readlink -f "$RELEASES_DIR/$1" 2>/dev/null || true
}

pointer_sha() { # pointer_sha <name> → 目录名(即 sha)
  local p; p="$(pointer_target "$1")"
  [ -n "$p" ] && basename "$p" || true
}

# 原子换链接。**必须可从任意断点重跑** —— deployer 可能在 ln 与 mv 之间被杀,
# 残留的 .tmp 会让下一次部署在 `ln -s` 上 EEXIST 失败,而那时容器已经停了,
# 结果是没人拉起它。所以开头无条件清残留,并用 -f 覆盖。
pointer_set() { # pointer_set <name> <sha>
  local name="$1" sha="$2"
  [ -d "$RELEASES_DIR/$sha" ] || die "release $sha 不存在,拒绝把 $name 指过去"
  rm -f "$RELEASES_DIR/$name.tmp"
  ln -sfn "$sha" "$RELEASES_DIR/$name.tmp"
  mv -T "$RELEASES_DIR/$name.tmp" "$RELEASES_DIR/$name"
  log "指针 $name → $sha"
}

# ── 已验证版本清单 ─────────────────────────────────────────────────

history_shas() { # 新→旧,一行一个
  [ -f "$HISTORY_FILE" ] || return 0
  node -e '
    const fs = require("fs");
    let d = {};
    try { d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
    for (const r of Array.isArray(d.releases) ? d.releases : []) {
      if (r && typeof r.sha === "string" && r.sha) console.log(r.sha);
    }
  ' "$HISTORY_FILE"
}

history_push() { # history_push <sha>
  local sha="$1"
  node -e '
    const fs = require("fs"), path = require("path");
    const [file, sha, keepRaw] = process.argv.slice(1);
    const keep = Number(keepRaw);
    let d = {};
    try { d = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const old = (Array.isArray(d.releases) ? d.releases : []).filter(
      (r) => r && typeof r.sha === "string" && r.sha && r.sha !== sha,
    );
    // 新的排最前:回滚沿这张单子往回走,顺序本身就是语义。
    const releases = [{ sha, verifiedAt: new Date().toISOString() }, ...old].slice(0, keep);
    const tmp = file + ".tmp";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ schema: 1, releases }, null, 2));
    fs.renameSync(tmp, file);
  ' "$HISTORY_FILE" "$sha" "$KEEP_VERIFIED"
  log "已验证版本清单:$sha 置顶,保留最近 $KEEP_VERIFIED 个"
}

# ── 健康查询 ───────────────────────────────────────────────────────

# `--noproxy '*'`:健康检查按定义打的是**本机那个 catman**,永远不该走代理。
# 而代理环境变量是必须透传给这个容器的(smoke 要够得着 Anthropic API),于是
# curl 会连 host.docker.internal 也送去代理 —— NO_PROXY 里的 CIDR 只对 IP 字面量
# 生效,对**主机名**是后缀匹配,`172.16.0.0/12` 拦不住 `host.docker.internal`。
# 后果:健康门永远超时 → 每一次部署都在最后一步自动回滚,而新版本其实是好的。
# 靠配置里记得写一条排除项挡不住这个,所以在这里钉死。
health_json() {
  curl -fsS --noproxy '*' --max-time 5 "$HEALTH_URL" 2>/dev/null || true
}

# 健康门:进程起来了、渠道起来了,**而且跑的确实是我们刚切过去的那份**。
# sha 比对不是多余的谨慎:`docker start` 返回成功只说明容器起来了,不说明它跑的是
# 哪份代码(比如别的东西抢先用旧链接拉起过它)。没有这一比,bake 可能在验证一份
# 从未真正运行过的版本,而它会被记进已验证清单当成将来的回滚目标。
health_ok() { # health_ok <期望的sha,可空>
  local want="${1:-}" body sha boot
  body="$(health_json)"
  [ -n "$body" ] || return 1
  echo "$body" > /tmp/health.json
  boot="$(json_get /tmp/health.json 'd.bootOk')"
  [ "$boot" = "true" ] || return 1
  if [ -n "$want" ]; then
    sha="$(json_get /tmp/health.json 'd.version && d.version.sha')"
    [ "$sha" = "$want" ] || return 1
  fi
  return 0
}

# 排水:网关里一条消息都不剩。三个计数必须同时为零 —— 它们是消息经过网关的
# 三段(聚合窗口 / 分拣链 / 在飞回合),只看在飞回合的话,卡在前两段的话会被
# 切换连人带消息一起杀掉,用户那边就是"发了没反应"。
# 后台回合**不算**:它们是用户主动切走、说过"你接着跑"的长任务,等它们等于永远
# 切不了;被中断的条数写进报告,如实告诉用户。
health_drained() {
  local body
  body="$(health_json)"
  [ -n "$body" ] || return 0 # 进程都不在了,自然没有待处理的消息
  echo "$body" > /tmp/health.json
  [ "$(json_get /tmp/health.json 'd.inFlight.foreground')" = "0" ] || return 1
  [ "$(json_get /tmp/health.json 'd.queued')" = "0" ] || return 1
  [ "$(json_get /tmp/health.json 'd.aggregating')" = "0" ] || return 1
  return 0
}

health_background() {
  local body
  body="$(health_json)"
  [ -n "$body" ] || { echo 0; return; }
  echo "$body" > /tmp/health.json
  json_get /tmp/health.json 'd.inFlight.background' || echo 0
}

# ── 容器 ───────────────────────────────────────────────────────────

# 下面四个都接一个可选的容器名,**默认仍是主人格** —— 既有调用点一个字都不用改。
# 需要名字的是信使兜底(切 pinned 之后要重启的是 catman-courier,不是 catman)。

container_running() { # container_running [容器名]
  local c="${1:-$CATMAN_CONTAINER}"
  [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" = "true" ]
}

# 停容器并**确认它真的退出了**。不确认的话,后面换链接、写状态文件的动作会与
# 一个还在跑的进程并发 —— 尤其 crash-loop 的容器会被 restart 策略一次次拉起来,
# 每次都可能再写一遍状态文件。
container_stop() { # container_stop [容器名]
  local c="${1:-$CATMAN_CONTAINER}"
  log "停止 $c"
  docker stop -t "${CATMAN_STOP_TIMEOUT:-60}" "$c" >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 30); do
    container_running "$c" || { log "已停止"; return 0; }
    sleep 1
  done
  die "$c 停不下来"
}

container_start() { # container_start [容器名]
  local c="${1:-$CATMAN_CONTAINER}"
  log "启动 $c"
  docker start "$c" >/dev/null
}

container_restarts() { # container_restarts [容器名]
  docker inspect -f '{{.RestartCount}}' "${1:-$CATMAN_CONTAINER}" 2>/dev/null || echo 0
}

# ── release 校验 ───────────────────────────────────────────────────
# git status 对 dist/ 与 node_modules/ 是**全盲**的(两者都在 .gitignore 里),
# 而那恰恰是真正被执行的字节。所以完整性靠制备时生成的内容清单:
# 切换到任何一个 release 之前重验一次,不符就拒绝并往回找下一个可验证的目标。

# ── GC ─────────────────────────────────────────────────────────────
# 保留集 = 已验证清单 ∪ **全部指针指向的目录**。
# 指针那一半不能少:守护人格钉住的那个 release 天然是最老的,只按"保留最近 N 个"
# 清理会把它的脚下抽空 —— 而活着的进程握着已删除的 inode 照样在跑,直到某次
# 断电重启才暴露,那正是最需要它的时刻。
#
# ⚠️ **指针本身不是 release,枚举时必须跳过。** 带尾斜杠的 glob(`"$DIR"/*/`)会把
# current/stable/pinned 这些**指向目录的符号链接**一并列出来,而它们的名字当然不在
# 保留集里 —— 于是 `rm -rf current/` 顺着链接进去**把目标 release 的内容掏空**,
# 链接本身完好无损,日志上只有一句轻描淡写的"GC 清理 release current"。
# 结果是 current 与全部回滚目标同时变成空目录:保留集算得再对也白搭,因为删错的
# 不是"没被保留的那些",而是"保留集本身指着的那些"。真机上发生过。
release_gc() {
  local keep_file
  keep_file="$(mktemp)"
  history_shas > "$keep_file"
  local name p
  for name in current stable pinned pinned-prev; do
    p="$(pointer_sha "$name")"
    [ -n "$p" ] && echo "$p" >> "$keep_file"
  done
  sort -u "$keep_file" -o "$keep_file"

  local dir sha
  for dir in "$RELEASES_DIR"/*/; do
    dir="${dir%/}"
    [ -L "$dir" ] && continue   # 指针,不是 release
    [ -d "$dir" ] || continue
    sha="$(basename "$dir")"
    # 第二道闸:只认 release 的命名。prepare 一律用 `git rev-parse` 的 40 位十六进制,
    # 所以"名字不像 release 的东西"一概不碰 —— 包括制备中途留下的 `<sha>.tmp`。
    # 宁可漏删(占点磁盘,人能看见),不可错删(删掉的正是出事时要回退的东西)。
    case "$sha" in *[!0-9a-f]* | "") continue ;; esac
    [ "${#sha}" -eq 40 ] || continue
    if ! grep -qx "$sha" "$keep_file"; then
      log "GC 清理 release $sha"
      chmod -R u+w "$dir" 2>/dev/null || true
      rm -rf "$dir"
    fi
  done
  rm -f "$keep_file"
}

# ── 制备残骸 ───────────────────────────────────────────────────────
# 删掉一个 `<sha>.tmp`。看着是 `rm -rf` 的同义词,不是:
#
# 制备被中途杀掉时(会话结束、Ctrl-C、OOM)`$WORK` 留在盘上,而**建它的人自己都删不掉**
# —— lockfile 未变时 node_modules 是 `cp -al` 复用来的,连同 555 的目录权限一起复制了
# 过来,rm 进不去那些目录。于是下一次同 sha 的制备在 `rm -rf "$WORK"` 这**第一行**就
# `set -e` 退出,满屏 `Permission denied`。那条报错跟这次改的代码毫无关系,却让制备
# 再也跑不动,只能人工进来清一次。真机上连着撞了两次,第二次才看明白。
#
# ⚠️ **只 chmod 目录,不能用 `chmod -R`。** `$WORK` 里的**文件**与已验证 release 逐个
# 共享 inode(见 prepare.sh 头上的纪律 ③),chmod 会穿透过去改到 stable 的字节上 ——
# 为了删掉一坨垃圾而动了逃生门,买卖做反了。目录是 `cp -al` 新建的,只归这个 `$WORK`,
# 改它安全。有单测钉着这一条。
rm_release_tmp() { # rm_release_tmp <目录>
  local work="${1:-}"
  [ -n "$work" ] || return 0
  # 写成 if 而不是 `[ -d … ] && …`:目录不存在时那种写法整条 AND 列表返回 1,
  # 在调用方的 `set -e` 下是不是当场退出取决于它出现在什么位置 —— 而"没有残骸要清"
  # 恰恰是最常走的那条路,不能让它去赌。
  if [ -d "$work" ]; then
    # chmod 失败不致命:真接不下去的话让 rm 去报错,那句话比这里能说的更具体。
    find "$work" -type d -exec chmod u+w {} + 2>/dev/null || true
  fi
  rm -rf "$work"
}

# ── release 校验 ───────────────────────────────────────────────────
release_verify() { # release_verify <sha>
  # ⚠️ 分两句写。`local a="$1" b="…$a"` 在 `set -u` 下会炸:local 先把两个名字都
  # 建成**未赋值**的局部变量,再逐个赋值 —— 第二个赋值里的 $a 因此是 unbound,
  # 而不是外层的同名变量。同一句里引用前一个声明的写法在本仓库一律禁止。
  local sha="$1"
  local dir="$RELEASES_DIR/$sha"
  [ -d "$dir" ] || { log "release $sha:目录不存在"; return 1; }
  [ -f "$dir/VERSION" ] || { log "release $sha:缺 VERSION"; return 1; }
  [ -f "$dir/dist/src/index.js" ] || { log "release $sha:缺 dist 产物"; return 1; }
  [ -d "$dir/node_modules" ] || { log "release $sha:缺 node_modules"; return 1; }

  local want_sha
  want_sha="$(json_get "$dir/VERSION" 'd.sha')"
  [ "$want_sha" = "$sha" ] || { log "release $sha:VERSION 里的 sha 是 $want_sha,对不上目录名"; return 1; }

  [ -f "$dir/MANIFEST" ] || { log "release $sha:缺内容清单"; return 1; }
  # 校验输出必须收进日志,**不能漏到 stdout**:`sha256sum -c` 把不匹配的文件名打在
  # stdout 上,而本函数被 pick_rollback_target 在命令替换里调用 —— 那行 FAILED 会
  # 混进被捕获的 sha,回滚就切到一个垃圾路径去了。
  # 同时"是哪个文件被改了"是排查的起点,不能一并丢掉,所以收下来打进日志。
  local mismatch
  if ! mismatch="$(cd "$dir" && sha256sum --quiet -c MANIFEST 2>&1)"; then
    log "release $sha:内容清单校验不通过 —— 有人改过里面的字节:$(echo "$mismatch" | tr '\n' ' ')"
    return 1
  fi
  return 0
}

# ── 看门狗降级的目标选择 ───────────────────────────────────────────
# 放在 lib.sh 而不是 deployer.sh:它要能**不依赖 docker**被跑起来验。
# 与 release_gc 同一个理由 —— 会改变"出事时退到哪儿"的代码,必须有直接的用例。
#
# 第 N 级 = 已验证清单里第 N 个「不是 current 且校验得过」的 release。
# 校验不过的**跳过但不占级数**:它本来就不能作为目标,占了级数会让"第 2 级"
# 指向一个比预期更旧的版本,而看门狗每级只退一次 —— 那一格就永久跳过去了。
pick_demote_target() { # pick_demote_target <级数> → sha(找不到则空)
  local step="${1:-1}"
  local cur; cur="$(pointer_sha current)"
  local n=0 sha
  while read -r sha; do
    [ -n "$sha" ] || continue
    [ "$sha" = "$cur" ] && continue
    release_verify "$sha" >/dev/null 2>&1 || continue
    n=$((n + 1))
    if [ "$n" -ge "$step" ]; then echo "$sha"; return 0; fi
  done < <(history_shas)
  return 1
}

# ── 变更分级(Tier) ───────────────────────────────────────────────
# 一次改动里有没有"光靠流水线上不了线"的东西。分级本身不拦任何事 —— 它拦不住,
# 也不该拦:Tier 3 的东西**改了也不会自动生效**(部署脚本走 bless 固化副本、
# compose 与镜像根本不进部署路径),那才是机械闸。这里做的是**说出来**,
# 免得人以为"部署成功了 = 我要的改动都生效了",而实际上还欠一次 bless 或一次镜像重建。
#
# ⚠️ **这张分类表必须住在固化侧**(所以是 lib.sh 里的 shell,不是 src/ 里的 TS)。
# 它要是住在被自我进化改写的那棵树里,agent 只要顺手改一行 case,就能把 Tier 3
# 的改动报成 Tier 1 —— 而人正是靠这份报告决定要不要额外做点什么。
tier_of() { # tier_of <仓库相对路径> → 3 / 2 / 1star / 1
  case "$1" in
    # 部署机制自身。改了要重新 bless,否则跑的还是固化的旧版本。
    scripts/evolve/*) echo 3 ;;
    # 基底镜像与容器配置。前者要重建镜像,后者要人改 compose 并 recreate 容器。
    docker/* | docker-compose.yml | compose.yaml | compose.yml | .env | .env.*) echo 3 ;;
    # 依赖变更:流水线自己能处理,但 lockfile 一变就是真 npm ci,制备明显更久。
    package.json | package-lock.json) echo 2 ;;
    # 门禁本体。自动上线,但确认时要单独点名 —— 改坏它的后果是"门失效",
    # 而门失效在日志里长得跟一切正常一模一样。
    #
    # gateway.ts 故意**不**在这张表里:排水计数确实出自它,但它每周都在改,
    # 列进来会让几乎每次改动都是 1★,点名也就失去了意义。守住排水语义的是
    # health 那份 golden 测试 —— 语义一变它必须跟着改,而它在表上。
    src/dashboard/health.ts | src/core/selfcheck.ts | src/core/commands.ts) echo 1star ;;
    src/core/deploy.ts | src/core/deploy-report.ts | src/core/releases.ts | src/core/version.ts) echo 1star ;;
    test/health.test.ts | test/selfcheck.test.ts | test/deploy-report.test.ts) echo 1star ;;
    test/entrypoint.test.ts | test/evolve-lib.test.ts) echo 1star ;;
    *) echo 1 ;;
  esac
}

# 报告块**不逐行打时间戳**:它是给人读的一段结构化文字(agent 会原样转述给管理员),
# 每行前面挂一个 ISO 时间戳会把它读成日志流。时间信息由上面那句 log 头承担。
tier_report() { # tier_report <base-ref> <head-ref>
  local base="$1"
  local head="$2"
  local files
  git_trust_repo "$SRC_DIR"
  if ! files="$(git -C "$SRC_DIR" diff --name-only "$base" "$head" 2>/dev/null)"; then
    log "变更分级:算不出 ${base:0:7}..${head:0:7} 的差异(基线可能不在这个仓库里),跳过"
    return 0
  fi
  # 刻意不写成 `[ -n "$files" ] && log … || { …; return 0; }`:那个三段式在中间那条
  # 命令失败时会**同时**执行第三段,是这类脚本最经典的静默错误来源。
  if [ -z "$files" ]; then
    log "变更分级:与 ${base:0:7} 没有差异"
    return 0
  fi
  log "变更分级(相对 ${base:0:7}):"

  local f t
  local t3="" t2="" t1s="" t1=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    t="$(tier_of "$f")"
    case "$t" in
      3) t3="$t3  $f
" ;;
      2) t2="$t2  $f
" ;;
      1star) t1s="$t1s  $f
" ;;
      *) t1="$t1  $f
" ;;
    esac
  done <<< "$files"

  {
    if [ -n "$t3" ]; then
      echo "Tier 3 —— 流水线上不了线,应用要人:"
      printf '%s' "$t3"
      echo "  → scripts/evolve/ 改了要重新跑 bless;docker/ 改了要重建镜像;compose 改了要 recreate 容器。"
    fi
    if [ -n "$t2" ]; then
      echo "Tier 2 —— 依赖变更(自动上线,制备会明显变慢):"
      printf '%s' "$t2"
    fi
    if [ -n "$t1s" ]; then
      echo "Tier 1★ —— 触碰了门禁本体(自动上线,但要在确认时单独点名):"
      printf '%s' "$t1s"
    fi
    if [ -n "$t1" ]; then
      echo "Tier 1 —— 常规改动,全流水线自动:"
      printf '%s' "$t1"
    fi
  } >&2
  return 0
}

# ── 把已上线的提交推到远端 ─────────────────────────────────────────
# 时机是**部署成功、stable 前移之后**:于是 GitHub 上出现的永远是真正上线过、
# 过完观察期的提交。推得更早(比如制备完就推)会让远端记录一堆从未运行过的东西,
# 而人恰恰是靠远端判断"线上现在是什么"。
#
# **失败只记日志,绝不反过来判部署失败** —— 版本已经在跑了,远端没跟上是另一件事,
# 而且多半是"有人在 GitHub 上也提交了",要人来合。同理**绝不 --force**:
# 这把密钥能改写远端历史是最不该发生的事,而快进失败正是它该失败的样子。
push_upstream() { # push_upstream <sha>
  local sha="$1"
  local dir="$RELEASES_DIR/$sha"
  local url branch out
  git_trust_repo "$SRC_DIR"
  url="$(git -C "$SRC_DIR" remote get-url origin 2>/dev/null || true)"
  case "$url" in
    "") log "push:源码仓库没有 origin,跳过"; return 0 ;;
    /* | ./* | ../*) log "push:origin 是本地路径($url),跳过"; return 0 ;;
  esac
  branch="$(json_get "$dir/VERSION" 'd.branch')"
  # detached 制备(prepare 传的是裸 sha)时 branch 是 "HEAD" 或空,那就推主线:
  # 走到这一步的提交已经上线并过了观察期,主线本就该是它。
  case "$branch" in "" | HEAD) branch="${CATMAN_UPSTREAM_BRANCH:-main}" ;; esac
  # 先说清"有没有钥匙"。没有这一句的话,没配可写密钥的机器上每次部署都会在这里
  # 甩一段 ssh 的 Permission denied,看起来像部署出了问题,其实只是没打算推远端。
  case "$url" in
    *ssh://* | *@*:*)
      if [ -z "$(push_key_path)" ]; then
        log "push:没有可读的可写密钥(deployer 侧),跳过 —— 远端不会记录这次上线"
        return 0
      fi
      ;;
  esac
  git_ssh_env
  if out="$(git -C "$dir" push "$url" "$sha:refs/heads/$branch" 2>&1)"; then
    log "push:${sha:0:7} → $branch"
  else
    log "push 失败(不影响本次部署,版本已经在跑了):$(echo "$out" | tr '\n' ' ')"
  fi
  return 0
}
