import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `catman-notify` —— 长任务的收尾工具,写进数据卷、挂进回合的 PATH。
 *
 * ## 为什么是脚本而不是"教它调 curl"
 *
 * 裸调 curl 这条路每次都要重新踩一遍同样的坑,而且每一处都**没有报错**、
 * 只是安静地不工作:
 *
 * - 容器里的 curl 默认走代理,打 127.0.0.1 会莫名其妙 503(要 `--noproxy '*'`);
 * - 日志写 `/tmp` 的话,任何别的容器都挂不到 —— docker 的 `-v` 用的是**宿主**路径;
 * - `setsid nohup` 少写一个 `< /dev/null` 就会在会话拆除时跟着死;
 * - 任意文本塞进 JSON 要转义,而任务输出里恰好全是引号和换行。
 *
 * 这些都是**一次性可以做对、每次重做必然做错**的事。封成脚本之后,
 * 助手只需要记住一句 `catman-notify run -- <命令>`。
 *
 * ## 与定时任务的分工(别混用)
 *
 * | | `catman-notify run` | cron 一次性任务 |
 * |---|---|---|
 * | 现场 | **本容器内**的脱钩进程 | 宿主上的独立容器 |
 * | 起步 | 立刻 | 等下一次 tick(≤30 秒) |
 * | 我被重新部署 | **跟着死,通知发不出来** | 照跑不误,回来认领 |
 * | 能用 docker.sock / 完整挂载 | 能(就是本容器) | 受限(断网、只读挂载、无 socket) |
 *
 * 所以:要快、要用本容器的现场(比如制备 release,它自己要起容器)→ 用这个;
 * 跑很久、横跨一次自我进化也不能丢 → 用 cron 一次性任务。
 *
 * ## 每次启动幂等覆盖
 *
 * 与 skills.ts 同一条规矩:真相源是代码,不是磁盘。用户改坏了、旧版本留下的,
 * 下次启动一律盖回去。
 */

export const NOTIFY_BIN_NAME = "catman-notify";

/** 生成脚本正文。`apiBase` 只作默认值 —— 环境里有 `CATMAN_API_BASE` 时以环境为准。 */
export function notifyBinBody(apiBase: string): string {
  return `#!/bin/bash
# catman-notify —— 由 catman 在每次启动时覆盖写。改这里没用,改 src/core/notify-bin.ts。
set -uo pipefail

API="\${CATMAN_API_BASE:-${apiBase}}"
TOKEN="\${CATMAN_NOTIFY_TOKEN:-}"
LOGDIR="\${CATMAN_DATA_DIR:-/data}/tmp"

usage() {
  cat <<'EOF'
catman-notify —— 让活得比回合久的东西给用户说一句话。

  catman-notify send <文本...>          立刻推一条(不给文本就从 stdin 读)
  catman-notify run [-n 名字] -- <命令>  脱钩跑,跑完把结果(成败 + 耗时 + 日志尾巴)推给用户

例:
  catman-notify run -n 制备 -- /data/deploy/bin/prepare.sh HEAD
  echo "备份好了" | catman-notify send

注意:run 起的是**本容器内**的进程 —— catman 自己被重新部署时它会跟着死,
那条通知就发不出来了。要跨越自我进化也不丢,用 cron 的一次性任务(见 catman-cron skill)。
EOF
}

# 任意文本 → JSON 字符串。不用 jq(镜像里不保证有),用 node(base image 就是 node)。
json_string() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))'
}

post() {
  # --noproxy '*':容器里配了代理,不加这个打自己会 503,且症状看着像服务坏了。
  local payload
  payload="{\\"text\\":$(json_string)}"
  curl -sS --noproxy '*' -m 20 -X POST \\
    -H "X-Catman-Notify: \$TOKEN" -H 'content-type: application/json' \\
    -d "\$payload" "\$API/api/me/notify"
}

need_token() {
  if [ -z "\$TOKEN" ]; then
    echo "catman-notify: 环境里没有 CATMAN_NOTIFY_TOKEN —— 这不像是 catman 的回合环境" >&2
    exit 2
  fi
}

human_duration() {
  local s=\$1
  if [ "\$s" -lt 60 ]; then echo "\${s} 秒"; return; fi
  local m=\$((s / 60)) r=\$((s % 60))
  if [ "\$m" -lt 60 ]; then
    if [ "\$r" -eq 0 ]; then echo "\${m} 分钟"; else echo "\${m} 分 \${r} 秒"; fi
    return
  fi
  echo "\$((m / 60)) 小时 \$((m % 60)) 分"
}

cmd_send() {
  need_token
  if [ "\$#" -gt 0 ]; then printf '%s' "\$*" | post; else post; fi
}

# 脱钩起来的那一半。用户不该直接调,所以名字带下划线前缀。
cmd_child() {
  local log="\$1" name="\$2"; shift 2
  local start end code
  start=\$(date +%s)
  "\$@" >>"\$log" 2>&1
  code=\$?
  end=\$(date +%s)

  local head tail_text
  if [ "\$code" -eq 0 ]; then
    head="✅ 「\$name」跑完了,\$(human_duration \$((end - start)))"
  else
    head="❌ 「\$name」失败了(退出码 \$code,\$(human_duration \$((end - start))))"
  fi
  # 只带尾巴:结论几乎总在最后。1200 字够看清、又不至于刷满一屏。
  tail_text=\$(tail -c 1200 "\$log" 2>/dev/null || true)
  printf '%s\\n%s\\n日志:%s' "\$head" "\$tail_text" "\$log" | post >/dev/null 2>&1
}

cmd_run() {
  need_token
  local name=""
  while [ "\$#" -gt 0 ]; do
    case "\$1" in
      -n) name="\$2"; shift 2 ;;
      --) shift; break ;;
      *) echo "catman-notify run: 命令前面要有 --" >&2; exit 2 ;;
    esac
  done
  if [ "\$#" -eq 0 ]; then echo "catman-notify run: -- 后面没有命令" >&2; exit 2; fi
  [ -n "\$name" ] || name=\$(basename -- "\$1")

  mkdir -p "\$LOGDIR"
  local log
  # 只替掉会把路径搞坏的那几个字符。用 tr -c '一堆白名单' 的话中文名字会被拆成
  # 一串下划线(tr 是按字节走的),日志文件从此谁也认不出是哪个任务的。
  log="\$LOGDIR/\$(printf '%s' "\$name" | tr '/ \\t' '___')-\$(date +%Y%m%d-%H%M%S).log"
  : > "\$log"

  # setsid + nohup + </dev/null 三件套缺一不可:少了最后一个,回合结束拆会话时
  # 它会跟着死,表现为日志停在中间、既没有失败也没有结果。
  setsid nohup "\$0" __child "\$log" "\$name" "\$@" >/dev/null 2>&1 </dev/null &
  disown 2>/dev/null || true

  echo "已经脱钩跑起来了:\$name"
  echo "日志:\$log"
  echo "跑完我会把结果推给用户 —— 不用守着它。"
}

case "\${1:-}" in
  send) shift; cmd_send "\$@" ;;
  run) shift; cmd_run "\$@" ;;
  __child) shift; cmd_child "\$@" ;;
  -h|--help|help|"") usage ;;
  *) echo "catman-notify: 不认识的子命令 \$1" >&2; usage >&2; exit 2 ;;
esac
`;
}

/** 写进 `<binDir>/catman-notify` 并置可执行位。启动时调用,幂等覆盖。 */
export function writeNotifyBin(binDir: string, apiBase: string): string {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, NOTIFY_BIN_NAME);
  writeFileSync(path, notifyBinBody(apiBase), "utf8");
  chmodSync(path, 0o755);
  return path;
}
