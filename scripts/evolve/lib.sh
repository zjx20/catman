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

RELEASES_DIR="${CATMAN_RELEASES_DIR:-/data/releases}"
DEPLOY_DIR="${CATMAN_DEPLOY_DIR:-/data/deploy}"
SRC_DIR="${CATMAN_SRC_DIR:-/data/src/catman}"
LOCK_FILE="$RELEASES_DIR/.deploy-lock"
HISTORY_FILE="$RELEASES_DIR/verified-history.json"
REPORT_FILE="$DEPLOY_DIR/report.json"
NPM_CACHE_DIR="${CATMAN_NPM_CACHE_DIR:-/data/npm-cache}"

CATMAN_CONTAINER="${CATMAN_CONTAINER:-catman}"
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
  : > "$cfg"
  # 保留原有的 global 配置(用户名/邮箱等):我们是往上叠两条例外,不是替掉人家的配置。
  local prev="${GIT_CONFIG_GLOBAL:-${HOME:-}/.gitconfig}"
  if [ -f "$prev" ]; then git config --file "$cfg" --add include.path "$prev"; fi
  for dir in "$@"; do
    git config --file "$cfg" --add safe.directory "$dir"
    git config --file "$cfg" --add safe.directory "$dir/.git"
  done
  export GIT_CONFIG_GLOBAL="$cfg"
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

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CATMAN_CONTAINER" 2>/dev/null || echo false)" = "true" ]
}

# 停容器并**确认它真的退出了**。不确认的话,后面换链接、写状态文件的动作会与
# 一个还在跑的进程并发 —— 尤其 crash-loop 的容器会被 restart 策略一次次拉起来,
# 每次都可能再写一遍状态文件。
container_stop() {
  log "停止 $CATMAN_CONTAINER"
  docker stop -t "${CATMAN_STOP_TIMEOUT:-60}" "$CATMAN_CONTAINER" >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 30); do
    container_running || { log "已停止"; return 0; }
    sleep 1
  done
  die "$CATMAN_CONTAINER 停不下来"
}

container_start() {
  log "启动 $CATMAN_CONTAINER"
  docker start "$CATMAN_CONTAINER" >/dev/null
}

container_restarts() {
  docker inspect -f '{{.RestartCount}}' "$CATMAN_CONTAINER" 2>/dev/null || echo 0
}

# ── release 校验 ───────────────────────────────────────────────────
# git status 对 dist/ 与 node_modules/ 是**全盲**的(两者都在 .gitignore 里),
# 而那恰恰是真正被执行的字节。所以完整性靠制备时生成的内容清单:
# 切换到任何一个 release 之前重验一次,不符就拒绝并往回找下一个可验证的目标。

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
