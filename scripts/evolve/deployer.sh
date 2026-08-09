#!/usr/bin/env bash
# deployer —— 执行切换与回滚的那一层。
#
# 用法:
#   deployer.sh deploy <sha> [--requested-by <userKey>]
#   deployer.sh rollback [--requested-by <userKey>]
#   deployer.sh status
#
# ## 它为什么必须与 catman 分开
#
# 更新者不能是被更新者。这个脚本会停掉 catman、换掉它脚下的代码、再把它拉起来 ——
# 跑在被停的那个进程里显然不行。它跑在一个独立的一次性容器里,catman 死在切换窗口
# 里它照样能收尾、能回滚。
#
# 而且**执法者自己取证**:smoke 由它亲自跑(不是让 agent 递一份"我测过了"的证明),
# 健康门比对的 sha 是它从 /health 亲自读的。agent 改坏了自检代码,结果只会是
# 它自己的版本过不了门,而不是门失效。
#
# ## 顺序上的两条硬纪律
#
# **① stable 只在观察期结束后前移。** 观察期内 current≠stable,于是这段时间里的
# 任何崩溃(包括宿主断电重启)都会自然落回 stable —— 观察期才是真正的门。
# 反过来(切换成功就前移 stable)会让观察期变成纯仪式:真出事时"回滚目标"
# 恰恰就是刚上线的坏版本。
#
# **② 回滚是"先停,再换,后起"。** 不先停就换链接的话,restart 策略会在换的过程中
# 把旧容器拉起来,而 crash-loop 的容器每次启动都可能再写一遍状态文件 ——
# 回滚这个最后防线自己产出损坏状态,还是静默的。

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

MODE="${1:-}"; shift || true
REQUESTED_BY=""
TARGET_SHA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --requested-by) REQUESTED_BY="${2:-}"; shift 2 ;;
    -*) die "未知参数 $1" ;;
    *) TARGET_SHA="$1"; shift ;;
  esac
done

DRAIN_TIMEOUT="${CATMAN_DRAIN_TIMEOUT:-300}"     # 5 分钟
HEALTH_TIMEOUT="${CATMAN_HEALTH_TIMEOUT:-300}"   # 5 分钟
BAKE_SECONDS="${CATMAN_BAKE_SECONDS:-1800}"      # 30 分钟观察期
SMOKE_RETRY_WINDOW="${CATMAN_SMOKE_RETRY_WINDOW:-1800}" # 限流/网络类失败的退避总时长

report() { # report <outcome> <sha> <detail> [revertedTo] [interruptedBg]
  local outcome="$1" sha="$2" detail="$3" reverted="${4:-}" bg="${5:-0}"
  node -e '
    const [file, outcome, sha, detail, reverted, bg, requestedBy] = process.argv.slice(1);
    const fs = require("fs"), path = require("path");
    const r = {
      schema: 1,
      id: `${Date.now().toString(36)}-${sha.slice(0, 7)}`,
      outcome, sha,
      ...(reverted ? { revertedTo: reverted } : {}),
      finishedAt: new Date().toISOString(),
      detail,
      ...(requestedBy ? { requestedBy } : {}),
      ...(Number(bg) > 0 ? { interruptedBackgroundTurns: Number(bg) } : {}),
    };
    const tmp = file + ".tmp";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
    fs.renameSync(tmp, file);
  ' "$REPORT_FILE" "$outcome" "$sha" "$detail" "$reverted" "$bg" "$REQUESTED_BY"
  log "报告已写入:$outcome $sha"
}

# ── smoke:执法者亲自跑 ────────────────────────────────────────────
# 在**切换之前**跑。不通就中止,正在服务的旧版本一根汗毛没动 —— 中止的代价只是
# "这次改进没上线",这正是整套设计追求的最坏结果。
#
# 失败要分类:限流与网络是**环境**的错,退避重试;把它们判成"新版本坏了"会让
# 一次二十分钟的上游抖动废掉一个完好的版本。
smoke() { # smoke <sha>
  # 分两句:见 lib.sh 的 release_verify —— 同一句 local 里引用前一个声明,
  # 在 set -u 下是 unbound。
  local sha="$1"
  local dir="$RELEASES_DIR/$sha"
  local deadline out category
  deadline=$(( $(date +%s) + SMOKE_RETRY_WINDOW ))
  local attempt=0 backoff=30
  while true; do
    attempt=$((attempt + 1))
    log "smoke 第 $attempt 次(release $sha)"
    lock_beat
    # 自检的 stdout 是**结果通道**,约定只有一行 JSON(它自己把 console 改道到了
    # stderr,见 log-stamp.ts)。这里仍然只挑以 `{` 开头的最后一行 —— 跨版本契约
    # 的读取端一律防御式:自检代码属 Tier 1、每周都在变,某次改动把一行日志漏回
    # stdout,后果是好版本被判死,而那种误判在日志里长得跟真故障一模一样。
    # stderr **不丢弃**,它进 deployer 的容器日志 —— 自检失败时的现场只在那里。
    out="$(docker run --rm \
      --user 10001:10001 \
      --memory "${CATMAN_SMOKE_MEMORY:-1000m}" \
      --add-host host.docker.internal:host-gateway \
      -e CATMAN_SELFCHECK=1 \
      -e "TZ=${TZ:-UTC}" \
      -e "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}" \
      $(for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
          [ -n "${!v:-}" ] && printf -- '-e %s=%s ' "$v" "${!v}"
        done) \
      -v "${CATMAN_HOST_DATA_DIR:?}:/data:ro" \
      -w "$dir" \
      "$CATMAN_IMAGE" \
      node dist/src/index.js | grep -E '^\{' | tail -1)" || true

    if [ -z "$out" ]; then
      log "smoke 没有给出可解析的结论 —— 当作代码问题(连自检都跑不起来)"
      SMOKE_DETAIL="自检的 stdout 里没有 JSON 结论,多半是这份 release 根本起不来(现场见 deployer 日志)"
      return 1
    fi
    echo "$out" > /tmp/smoke.json
    if [ "$(json_get /tmp/smoke.json 'd.ok')" = "true" ]; then
      log "smoke 通过:$(json_get /tmp/smoke.json 'd.detail')"
      return 0
    fi
    category="$(json_get /tmp/smoke.json 'd.category')"
    SMOKE_DETAIL="$(json_get /tmp/smoke.json 'd.detail')"
    case "$category" in
      ratelimit|network)
        if [ "$(date +%s)" -ge "$deadline" ]; then
          log "smoke 因环境问题($category)持续失败到超时"
          SMOKE_DETAIL="环境问题($category)持续 ${SMOKE_RETRY_WINDOW}s 未恢复:$SMOKE_DETAIL"
          return 1
        fi
        log "smoke 遇到环境问题($category),${backoff}s 后重试:$SMOKE_DETAIL"
        sleep "$backoff"
        backoff=$(( backoff < 300 ? backoff * 2 : 300 ))
        ;;
      *)
        log "smoke 失败($category):$SMOKE_DETAIL"
        return 1
        ;;
    esac
  done
}

# ── 排水 ───────────────────────────────────────────────────────────
drain() {
  local deadline=$(( $(date +%s) + DRAIN_TIMEOUT ))
  log "排水(最多 ${DRAIN_TIMEOUT}s)"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    lock_beat
    if health_drained; then log "已排干"; return 0; fi
    sleep 5
  done
  log "排水超时 —— 仍有消息在处理,继续切换(会在报告里说明)"
  return 1
}

# ── 健康门 ─────────────────────────────────────────────────────────
await_health() { # await_health <期望sha>
  local want="$1" deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  log "健康门(最多 ${HEALTH_TIMEOUT}s,期望 sha=${want:0:7})"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    lock_beat
    if health_ok "$want"; then log "健康门通过"; return 0; fi
    sleep 5
  done
  return 1
}

# ── 观察期 ─────────────────────────────────────────────────────────
# 真正的门。启动能过不代表真实负载能过 —— 最常见的失败恰恰是"起来了,
# 第一个真实回合把它打崩"。这段时间 stable 还没前移,崩了就当场退回去。
bake() { # bake <sha>
  local sha="$1" deadline=$(( $(date +%s) + BAKE_SECONDS ))
  local base; base="$(container_restarts)"
  log "观察期 ${BAKE_SECONDS}s(期间 stable 不动,出事就地退回)"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    lock_beat
    sleep 15
    local now_restarts; now_restarts="$(container_restarts)"
    if [ "$now_restarts" -gt "$base" ]; then
      log "观察期内容器重启了($base → $now_restarts)"
      return 1
    fi
    if ! health_ok "$sha"; then
      log "观察期内健康检查失败"
      return 1
    fi
  done
  log "观察期通过"
  return 0
}

# ── 回滚到指定 sha ─────────────────────────────────────────────────
# 严格三段:停 → 换 → 起。理由见文件头纪律 ②。
revert_to() { # revert_to <sha>
  local sha="$1"
  container_stop
  pointer_set current "$sha"
  container_start
}

# 沿已验证清单往回找一个能用的目标(跳过校验不过的)。
pick_rollback_target() {
  local cur; cur="$(pointer_sha current)"
  local sha
  while read -r sha; do
    [ -n "$sha" ] || continue
    [ "$sha" = "$cur" ] && continue
    if release_verify "$sha"; then echo "$sha"; return 0; fi
    log "跳过 $sha:校验不通过"
  done < <(history_shas)
  return 1
}

# ── GC ─────────────────────────────────────────────────────────────
# 实现在 lib.sh(release_gc):它是这套脚本里最危险的一个函数,放在 lib.sh 才能被
# shell 层的单测直接跑起来验 —— 曾经有一版把 current/stable/pinned 三个指针当成
# release 目录删掉,把它们指向的内容全部掏空。

# ── 三种模式 ───────────────────────────────────────────────────────

do_deploy() {
  local sha="$1"
  [ -n "$sha" ] || die "deploy 要给出 sha"
  release_verify "$sha" || { report aborted "$sha" "release 校验不通过,没有做任何切换"; die "校验不通过"; }

  lock_acquire "deploy-$sha"
  trap 'lock_release' EXIT

  local prev; prev="$(pointer_sha current)"
  [ -n "$prev" ] || die "当前没有 current 指针 —— 先跑 init.sh"
  log "当前版本 $prev,目标 $sha"

  SMOKE_DETAIL=""
  if ! smoke "$sha"; then
    report aborted "$sha" "自检没过:${SMOKE_DETAIL:-未知原因}(线上版本一直没动过)"
    die "自检没过,已中止"
  fi

  local drained_ok=1
  drain || drained_ok=0
  local bg; bg="$(health_background)"

  container_stop
  pointer_set current "$sha"
  container_start

  if ! await_health "$sha"; then
    log "健康门没过,回滚到 $prev"
    revert_to "$prev"
    await_health "$prev" || log "警告:旧版本也没通过健康门 —— 多半是环境问题,需要人来看"
    report rolled-back "$sha" "新版本没通过健康门(${HEALTH_TIMEOUT}s 内没起来或版本对不上),已退回" "$prev" "$bg"
    exit 1
  fi

  if ! bake "$sha"; then
    log "观察期没过,回滚到 $prev"
    revert_to "$prev"
    await_health "$prev" || log "警告:旧版本也没通过健康门 —— 多半是环境问题,需要人来看"
    report rolled-back "$sha" "新版本在观察期内崩了(容器重启或健康检查失败),已退回" "$prev" "$bg"
    exit 1
  fi

  # 到这里才前移 stable —— 观察期是真正的门。
  pointer_set stable "$sha"
  history_push "$sha"
  release_gc
  local note="已上线并通过 ${BAKE_SECONDS}s 观察期。"
  [ "$drained_ok" = "1" ] || note="$note(切换时还有消息在处理,可能有丢失)"
  report deployed "$sha" "$note" "" "$bg"
  log "部署完成:$sha"
}

do_rollback() {
  lock_acquire "rollback"
  trap 'lock_release' EXIT

  local cur target; cur="$(pointer_sha current)"
  target="$(pick_rollback_target)" || {
    report aborted "${cur:-unknown}" "没有可回退的已验证版本 —— 需要人来处理"
    die "没有可回退的目标"
  }
  log "回滚 $cur → $target"
  local bg; bg="$(health_background)"
  drain || true
  revert_to "$target"
  if await_health "$target"; then
    # 回滚的目标本就在已验证清单里,stable 跟着回去 —— 否则下一次崩溃时
    # 看门狗会把 current 拨到一个我们刚刚判定为坏的版本上。
    pointer_set stable "$target"
    report rolled-back "$cur" "按请求回滚,已确认新版本健康" "$target" "$bg"
  else
    report rolled-back "$cur" "已回滚,但目标版本没通过健康门 —— 需要人来看" "$target" "$bg"
    die "回滚后仍不健康"
  fi
}

do_status() {
  echo "current: $(pointer_sha current)"
  echo "stable:  $(pointer_sha stable)"
  echo "已验证清单(新→旧):"
  history_shas | sed 's/^/  /'
  echo "健康:"
  health_json | sed 's/^/  /'
}

case "$MODE" in
  deploy) do_deploy "$TARGET_SHA" ;;
  rollback) do_rollback ;;
  status) do_status ;;
  *) die "用法:deployer.sh {deploy <sha>|rollback|status} [--requested-by <userKey>]" ;;
esac
