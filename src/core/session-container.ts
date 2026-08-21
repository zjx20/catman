import type { Attachment } from "./attachments.js";

/**
 * 把一个回合的大脑关进它自己的容器。
 *
 * ## 为什么要有这一层
 *
 * 2026-08-21 的事故:一个会话在 87 秒里吃掉 2.9GB 匿名内存(约 33MB/s),宿主没有
 * swap,内核只能丢 page cache —— 连所有进程的**可执行页**一起丢。而这台机器上
 * docker 的 data-root 在一块 USB 2.0 闪存盘上,于是全机器陷入"永远在重读自己的
 * 代码"的回收活锁:能 ping、老 ssh 能用但极慢、无线搜得到连不上(网卡与 U 盘共用
 * 一个 EHCI 控制器)、`docker restart` 十几分钟不返回。`oom_kill` 全程没涨过 ——
 * **OOM killer 根本没开火**,因为回收一直"在取得进展"。它不会自愈,只能断电。
 *
 * 根因不是哪一条命令写错了(那条被怀疑的 grep 原样复现只用了 1.5 秒 / 57MB),
 * 而是**没有任何东西给会话的内存划一条线**。划了线之后,失控撞的是自己的 cgroup
 * 上限,那一刻宿主还剩好几个 G,一切照常 —— 这是整件事的全部要点。
 *
 * ## 为什么是"每回合一个一次性容器"而不是"每会话常驻一个"
 *
 * `query()` 每条用户消息调一次,所以一次性容器就是每回合起停一次,实测约 1 秒。
 * 常驻容器能把这 1 秒摊掉,代价是三件事:空闲回收、崩溃恢复、以及自我进化换版本
 * 之后那个还活着的旧容器算谁的。为省 1 秒引入三个生命周期问题不划算,而且一次性
 * 容器正好复用 cron 那套已经在真机上跑了很久的模式(见 `cron/docker.ts`)。
 *
 * ## 这不是安全边界
 *
 * 会话容器里要能用 docker(助手日常就在用),所以 docker.sock 得挂进去 —— 那等于
 * 容器里能起一个兄弟容器绕开自己的上限。**它防的是事故,不是恶意**,与 CLAUDE.md
 * 里"护栏不是安全边界"是同一句话。
 */

/** 会话容器的资源上限。 */
export interface SessionLimits {
  /** docker `--memory`,如 "700m"。 */
  readonly memory: string;
  readonly cpus: number;
  readonly pids: number;
}

/**
 * 默认上限。
 *
 * 700m 是管理员拍的,依据是:claude 常态 RSS 实测约 293MB,留约 400MB 干活空间。
 * 宿主一共 3822MB,其余十几个容器加系统约占 800MB —— **所有并发会话的上限之和
 * 必须有界**,否则两个会话同时失控还是会把宿主拖垮。700m × 3 = 2.1GB 仍有余量。
 */
export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  memory: "700m",
  cpus: 1.5,
  pids: 256,
};

/** 挂进会话容器的一条路径。`host` 是**宿主**路径 —— docker 的 -v 左边从来是宿主视角。 */
export interface SessionMount {
  readonly host: string;
  readonly at: string;
  readonly ro?: boolean;
}

export interface SessionContainerSpec {
  readonly container: string;
  readonly image: string;
  /** 大脑二进制在容器里的路径(由挂载带进去)。 */
  readonly claudePath: string;
  readonly limits: SessionLimits;
  readonly mounts: readonly SessionMount[];
  /** 回合的工作目录。容器内外必须是同一个路径,否则 SDK 写的会话 JSONL 找不回来。 */
  readonly cwd: string;
  /** 要原样透传进容器的环境变量**名字**。值由 docker 从当前环境取。 */
  readonly passEnv: readonly string[];
  readonly tz?: string;
}

/** 认领会话容器的标签。孤儿清理靠它,不必去猜容器名。 */
export const SESSION_LABEL = "catman.session";

/**
 * SDK 传给可执行文件的参数是固定的七个 flag(实测:`--output-format stream-json
 * --verbose --input-format stream-json --permission-mode <mode>`),包装脚本原样
 * `"$@"` 转发即可,不必解析。
 *
 * 但**环境变量必须点名透传**:SDK 靠 `CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_SESSION_ID`、
 * `CLAUDE_CONFIG_DIR` 这些跟子进程对表,少一个就是一次"大脑起不来"而且报错含糊。
 * 这份名单是拿探针从真实调用里抄下来的,不是照文档猜的。
 */
export const PASS_THROUGH_ENV = [
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_EFFORT",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
] as const;

/**
 * 拼 `docker run` 的参数。
 *
 * **单独一个纯函数**,与 `cron/docker.ts` 的 `buildRunArgs` 同一条理由:这串参数里
 * 有一半是隔离闸门(三个资源上限、标签、非 root),而它们出错的方式是"照跑不误,
 * 只是没有防护" —— 那种错没有症状,只能靠断言钉住。
 */
export function buildSessionRunArgs(spec: SessionContainerSpec): string[] {
  const args = ["run", "--rm", "-i", "--name", spec.container];
  args.push("--label", `${SESSION_LABEL}=1`);
  // --init 与 cron 那边同一条理由(干净的 SIGTERM + 收僵尸),配套的 TINI_SUBREAPER
  // 也不能省:catman-env 的 ENTRYPOINT 本身就是 tini,不设的话里面那个会往 stderr
  // 打三行告警 —— 而 stderr 是 SDK 报错的唯一去处,那三行会把真的错误淹掉。
  args.push("--init", "-e", "TINI_SUBREAPER=1");
  args.push("--memory", spec.limits.memory);
  // 没有 swap 时 --memory-swap 必须等于 --memory,否则限制形同虚设。
  args.push("--memory-swap", spec.limits.memory);
  args.push("--cpus", String(spec.limits.cpus));
  args.push("--pids-limit", String(spec.limits.pids));
  args.push("--network", "mynet");
  // 容器日志也要有上限:大脑话痨起来能把宿主磁盘写满,而磁盘满会让 dockerd
  // 全面异常 —— 那时候连回滚都做不了。
  args.push("--log-driver", "json-file", "--log-opt", "max-size=8m", "--log-opt", "max-file=1");
  for (const m of spec.mounts) args.push("-v", `${m.host}:${m.at}${m.ro ? ":ro" : ""}`);
  // cwd 容器内外同路径。SDK 用 cwd 决定会话 JSONL 写进哪个 project 目录,
  // 两边不一致的话 resume 会找不到上一段 —— 表现为"助手失忆",而没有任何报错。
  args.push("-w", spec.cwd);
  if (spec.tz) args.push("-e", `TZ=${spec.tz}`);
  // `-e NAME`(不带 =)让 docker 从**当前进程环境**取值。值不落进 argv,
  // 于是 OAuth token 不会出现在 `docker inspect` 和 ps 里。
  for (const name of spec.passEnv) args.push("-e", name);
  args.push(spec.image, spec.claudePath);
  return args;
}

/**
 * 生成包装脚本的内容。SDK 会把它当原生二进制直接 exec(实测确认),
 * 于是 `exec docker run …` 就把大脑挪进了容器,而 SDK 那一侧毫无感知 ——
 * 它照旧在 stdio 上跑 stream-json,只是对面换了个地方。
 *
 * **必须 `exec`** 而不是 `docker run … &` 之类:SDK 等的是这个进程的生死,
 * 中间多一层 shell 的话,abort 杀掉的是 shell,docker 客户端会留下来(而客户端
 * 死掉也不会带走容器 —— 这正是 95% 那级必须用 cgroup.kill 的原因)。
 */
export function buildWrapperScript(args: readonly string[]): string {
  const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  return [
    "#!/bin/sh",
    "# 由 catman 生成 —— 把这一回合的大脑关进它自己的容器。请勿手工编辑。",
    "# SDK 以为自己在 exec 一个原生二进制,实际 exec 的是这个脚本;",
    "# 它把固定的七个 flag 原样转发进容器,stdio 直通,SDK 那侧无感。",
    `exec docker ${quoted} "$@"`,
    "",
  ].join("\n");
}

/** 会话容器的名字。一个会话同时只该有一个回合在跑,所以用 userKey 就够认。 */
export function sessionContainerName(userKey: string, turnId: string): string {
  const safe = userKey.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 40);
  return `catman-session-${safe}-${turnId}`.toLowerCase();
}

/** 附件不进容器 —— 它们是 SDK 侧内联进消息的,与容器无关。这里只是把类型钉住。 */
export type _AttachmentsStayOutside = Attachment;
