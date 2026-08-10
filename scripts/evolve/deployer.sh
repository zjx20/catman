#!/usr/bin/env bash
# deployer —— 执行切换与回滚的那一层。
#
# 用法:
#   deployer.sh deploy <sha> [--requested-by <userKey>]
#   deployer.sh rollback [--requested-by <userKey>]
#   deployer.sh demote [--step N] [--why <一句话>]
#   deployer.sh courier-fallback [--why <一句话>]
#   deployer.sh gc [--why <一句话>]
#   deployer.sh drill
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
DEMOTE_STEP=1
DEMOTE_WHY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --requested-by) REQUESTED_BY="${2:-}"; shift 2 ;;
    --step) DEMOTE_STEP="${2:-1}"; shift 2 ;;
    --why) DEMOTE_WHY="${2:-}"; shift 2 ;;
    -*) die "未知参数 $1" ;;
    *) TARGET_SHA="$1"; shift ;;
  esac
done

DRAIN_TIMEOUT="${CATMAN_DRAIN_TIMEOUT:-300}"     # 5 分钟
HEALTH_TIMEOUT="${CATMAN_HEALTH_TIMEOUT:-300}"   # 5 分钟
BAKE_SECONDS="${CATMAN_BAKE_SECONDS:-1800}"      # 30 分钟观察期
SMOKE_RETRY_WINDOW="${CATMAN_SMOKE_RETRY_WINDOW:-1800}" # 限流/网络类失败的退避总时长

# 本次运行的标识。里程碑的 id 由它加阶段名拼成,catman 靠 id 去重 ——
# **必须在这里算一次然后固定住**:每条里程碑各算各的时间戳,重启后就认不出
# "这条我播过了",于是同一条进度会被反复播出去。
RUN_ID="$(node -e 'process.stdout.write(Date.now().toString(36))')"

# 一条里程碑。失败不写(那归 report),细节见 lib.sh 的 progress_write。
milestone() { # milestone <stage> <sha> <detail> [ok]
  local stage="$1" sha="$2" detail="$3" ok="${4:-1}"
  progress_write "$RUN_ID-$stage" "$stage" "$sha" "$detail" "$ok" "$REQUESTED_BY"
}

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

# ── 七种模式 ───────────────────────────────────────────────────────

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

  # 健康门过了 = 新版本真的起来了,而且 /health 报的 sha 就是它。这是整条链上
  # 第一个**用户看得见**的事实(他刚经历了几分钟失联),而离最终结果还有半小时。
  milestone switched "$sha" "接下来是 ${BAKE_SECONDS}s 观察期,这期间崩了会自动退回 ${prev:0:7}。"

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
  milestone stable "$sha" "从现在起它是回滚回得去的那个版本。"
  release_gc
  # 推远端**放在这里**:此刻这个提交才真的"上线过并且活下来了"。失败不阻塞。
  push_upstream "$sha"
  milestone pushed "$sha" "$PUSH_DETAIL" "$PUSH_OK"
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

# ── demote:看门狗要求把 current 往回拨 ─────────────────────────────
#
# 与 rollback 的区别是**语义**,不是实现细节:
#
#   rollback  人主动要求退回上一个已验证版本。它会把 stable 一并拨回去 ——
#             因为那是人的判断:"刚上线那个是坏的"。
#   demote    机械看门狗在**没有人**的情况下判定主人格起不来。它只拨 current,
#             **绝不动 stable**。
#
# 为什么这条界线不能模糊:`stable` 是"最后一个被证明能跑的版本",而看门狗的判据
# (容器重启了几次)远弱于观察期。让它写 stable,等于允许一次误判永久改写
# "回退目标"这个概念本身 —— 而下一次真出事时,它会把 current 拨到那个被误判抬上去的
# 版本上。指针单主的具体含义就在这里:stable 只许 deployer 在观察期结束后前移。
#
# 每一级只退一次由调用方(看门狗)用 --step 表达,这里只负责按级数选目标。
do_demote() {
  local step="${DEMOTE_STEP:-1}"
  lock_acquire "demote"
  trap 'lock_release' EXIT

  local cur; cur="$(pointer_sha current)"
  local target; target="$(pick_demote_target "$step" || true)"

  if [ -z "$target" ]; then
    report aborted "${cur:-unknown}" "看门狗要求退到第 $step 级,但没有那么多可用的已验证版本 —— 需要人来处理"
    die "没有第 $step 级可退"
  fi

  log "看门狗降级:$cur → $target(第 $step 级;${DEMOTE_WHY:-无说明})"
  local bg; bg="$(health_background)"
  # 不排水:走到这一步说明主人格已经起不来了,没有"在处理的消息"可等。
  revert_to "$target"
  if await_health "$target"; then
    report rolled-back "${cur:-unknown}" "看门狗自动降级(第 $step 级):${DEMOTE_WHY:-主人格起不来}" "$target" "$bg"
  else
    # **stable 一个字都不动**,哪怕退完还是不健康。见上面的说明。
    report rolled-back "${cur:-unknown}" "看门狗降级后仍不健康(第 $step 级),需要人来看:${DEMOTE_WHY:-}" "$target" "$bg"
    die "降级后仍不健康"
  fi
}

# ── courier-fallback:信使自己崩了,把稳定面退回上一份 ───────────────
#
# 这是整套脚本里**唯一会自动改写稳定面**的动作,所以它比 demote 更保守。
#
# ## 它修的是哪一种故障
#
# `pinned` 是人钦定的,而钦定的依据是那份 release 当过 `stable` —— 但观察期只跑过
# **主人格**。信使的代码路径(iLink 连接、accounts.json、收件队列)在那 30 分钟里
# 一次都没被执行过。所以一份"过了门"的 release 完全可能有一个起不来的信使,
# 而后果是**微信整个聋掉**:两个人格都在它身后,连报警都发不出去。
# `pinned-prev` 就是为这一种故障留的,由 bless 在钦定新 pinned 时顺手存下。
#
# ## 三条比 demote 更严的纪律
#
# **① 只动 `pinned`。** `current` / `stable` / `pinned-prev` 一个都不碰 ——
# 主人格跑的是 current,信使崩了不是它的错,把它一起换掉是无谓地扩大故障面。
#
# **② 目标必须先过内容校验。** 退到一个字节已经损坏的 release 上,结果是
# 两份都起不来,而人还以为退过了。
#
# **③ 不重启守护人格。** 它跑的也是 pinned,但**换链接不影响已经跑起来的进程**
# (符号链接在启动时就解析完了)。而重启它等于杀掉正在执行这次兜底的那个决策者 ——
# 何况它此刻是唯一还活着的观测点。下次它自己重启时自然就在新 pinned 上。
do_courier_fallback() {
  lock_acquire "courier-fallback"
  trap 'lock_release' EXIT

  local cur prev
  cur="$(pointer_sha pinned)"
  prev="$(pointer_sha pinned-prev)"

  if [ -z "$prev" ]; then
    # 首次 bless 之后 pinned-prev 还不存在(它在**第二次**钦定时才产生)。
    report aborted "${cur:-unknown}" "信使起不来,但没有 pinned-prev 可退 —— 需要人:检查信使日志与 .env"
    die "没有 pinned-prev"
  fi
  if [ "$prev" = "$cur" ]; then
    report aborted "${cur:-unknown}" "信使起不来,而 pinned-prev 与 pinned 是同一份 —— 退了也没用,需要人"
    die "pinned-prev 与 pinned 相同"
  fi
  if ! release_verify "$prev"; then
    report aborted "${cur:-unknown}" "信使起不来,而 pinned-prev($prev)内容校验不过 —— 需要人"
    die "pinned-prev 校验不通过"
  fi

  log "信使兜底:pinned $cur → $prev(${DEMOTE_WHY:-信使 crash-loop})"
  local base; base="$(container_restarts "$CATMAN_COURIER_CONTAINER")"
  container_stop "$CATMAN_COURIER_CONTAINER"
  pointer_set pinned "$prev"
  container_start "$CATMAN_COURIER_CONTAINER"

  # 信使没有 HTTP 健康端点(它只有 IPC),所以判据只能是"起来了并且不再重启"。
  # 比主人格那道健康门弱得多 —— 如实写进报告,别让人以为它被验过了。
  local i ok=0
  for i in $(seq 1 "${CATMAN_COURIER_SETTLE:-60}"); do
    sleep 1
    if container_running "$CATMAN_COURIER_CONTAINER" &&
       [ "$(container_restarts "$CATMAN_COURIER_CONTAINER")" = "$base" ]; then
      ok=$((ok + 1))
    else
      ok=0
    fi
    [ "$ok" -ge 15 ] && break
  done

  if [ "$ok" -ge 15 ]; then
    report rolled-back "${cur:-unknown}" \
      "信使起不来,稳定面已退回上一份(pinned $cur → $prev);主人格未动。判据只是「连续 15 秒没再重启」,不是健康门 —— 请自己确认微信通了" \
      "$prev"
  else
    # **pinned 不再往回拨。** 退过还崩多半是环境问题(磁盘、.env、凭据),
    # 而反复换指针只会让人更难判断现在跑的到底是哪一份。
    report rolled-back "${cur:-unknown}" \
      "信使退到 $prev 之后仍起不来 —— 多半不是版本问题,需要人:看磁盘、.env 与信使日志" \
      "$prev"
    die "退回之后信使仍起不来"
  fi
}

# ── gc:磁盘红色水位时看门狗要求清一次超保留期的 release ─────────────
#
# 动作只有 release_gc 一个 —— 它有双重闸门(保留集 = 已验证清单 ∪ 全部指针的
# realpath;目录名必须是 40 位 hex),清不掉任何被指着的东西。**不写部署报告**:
# report.json 是"上一次部署的结果",catman 靠它向用户播报,清理覆写它会把一条
# (可能是失败的)部署结果永久顶掉。
do_gc() {
  lock_acquire "gc"
  trap 'lock_release' EXIT
  log "磁盘清理(${DEMOTE_WHY:-看门狗触发}):release GC"
  release_gc
  log "磁盘清理完成"
}

# ── drill:每周冷启动点火 ───────────────────────────────────────────
#
# 守护人格自己也会锈:活进程握着已删 inode 照常运行,pinned 的字节在磁盘上坏没坏、
# SELFCHECK 还过不过、部署机制还转不转,只有**从磁盘冷启动**才测得出来 ——
# 而那正是断电重启那天要走的路。每周由看门狗触发,结果写 ignition.json 上状态页。
#
# 四项检查按"断电重启那天的依赖顺序"排:字节完整 → 冷启动能过自检 →
# 主人格活着且版本对 → 回滚机制的每个环节还能动。
#
# **结果写 ignition.json,绝不写 report.json** —— 后者是部署结果的播报通道,
# 覆写它等于把一条(可能是失败的)部署结果永久顶掉。两份文件、两个消费者。
do_drill() {
  lock_acquire "drill"
  trap 'lock_release' EXIT

  ignition_report() { # ignition_report <ok> <failed> <detail>
    node -e '
      const [file, ok, failed, detail] = process.argv.slice(1);
      const fs = require("fs"), path = require("path");
      const r = {
        schema: 1,
        ranAt: new Date().toISOString(),
        ok: ok === "true",
        ...(failed ? { failed } : {}),
        detail,
      };
      const tmp = file + ".tmp";
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
      fs.renameSync(tmp, file);
    ' "$DEPLOY_DIR/ignition.json" "$@"
    log "点火报告已写入:$1 ${2:-}"
  }

  local pin
  pin="$(pointer_sha pinned)"
  if [ -z "$pin" ]; then
    ignition_report false pinned "没有 pinned 指针 —— 稳定面没被钦定过"
    die "点火失败:没有 pinned"
  fi

  # ① 字节完整:清单重验。热补丁、硬链接污染、误删都在这里现形。
  if ! release_verify "$pin"; then
    ignition_report false verify "pinned($pin)内容清单校验不过 —— 字节被改过或缺文件"
    die "点火失败:pinned 校验不过"
  fi

  # ② 冷启动自检:从磁盘起一次性容器跑 SELFCHECK(smoke 对限流/网络自带退避分类,
  #    不会把一次上游抖动记成点火失败)。
  if ! smoke "$pin"; then
    ignition_report false smoke "pinned($pin)冷启动自检不过:${SMOKE_DETAIL:-见 deployer 日志}"
    die "点火失败:smoke 不过"
  fi

  # ③ 主人格健康且版本与 current 一致 —— 顺带把 /health 契约的解析走一遍
  #    (pinned 侧的 deployer 读 current 侧的接口,这正是要防漂移的那条缝)。
  local cur
  cur="$(pointer_sha current)"
  if ! health_ok "$cur"; then
    ignition_report false health "主人格 /health 不健康或 sha 与 current($cur)不符"
    die "点火失败:health 不过"
  fi

  # ④ 回滚机制的关节:已验证清单解析得出、目标还在,指针机构能动(dry-run flip:
  #    在真名字之外立一个临时指针再拆掉 —— pointer_set 的清残留让它可从任意断点重跑)。
  if [ -z "$(history_shas | head -1)" ]; then
    ignition_report false history "verified-history 解析不出任何 sha —— 回滚没有目标"
    die "点火失败:history 空"
  fi
  rm -f "$RELEASES_DIR/drill-scratch" "$RELEASES_DIR/drill-scratch.tmp"
  if ! pointer_set drill-scratch "$pin"; then
    ignition_report false flip "指针机构 dry-run 失败 —— 真回滚那天它也动不了"
    die "点火失败:dry-run flip 失败"
  fi
  rm -f "$RELEASES_DIR/drill-scratch"

  ignition_report true "" "pinned=$pin 冷启动自检通过;主人格健康(current=$cur);history 可解析;指针机构可动"
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
  demote) do_demote ;;
  courier-fallback) do_courier_fallback ;;
  gc) do_gc ;;
  drill) do_drill ;;
  status) do_status ;;
  *) die "用法:deployer.sh {deploy <sha>|rollback|demote [--step N] [--why ...]|courier-fallback [--why ...]|gc [--why ...]|drill|status} [--requested-by <userKey>]" ;;
esac
