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
  readonly tz?: string;
  /**
   * 容器以谁的身份跑,`uid:gid`。
   *
   * **不给就是 root**,而 root 建出来的文件 catman(uid 10001)下一回合就改不动了 ——
   * 工作区会慢慢积满改不动的文件,而且没有任何报错。取值由装配处从**catman 自己的
   * 进程**读(`process.getuid()`),不是写死也不是再开一个配置项。
   */
  readonly user: string;
  /**
   * 附加组。docker.sock 在这台机器上是 `root:32768` 且权限 660 ——
   * 不把那个组带进去,容器里的 `docker` 一律 permission denied,而助手日常就在用它。
   * GID **属于宿主、各机器不同**(与 compose 里 DOCKER_GID 那条注释同一个理由),
   * 所以同样从 catman 自己的进程读(`process.getgroups()`)。
   */
  readonly groupAdd: readonly number[];
  /** 额外的 hosts 映射,如 `host.docker.internal:host-gateway`。与 catman 自己保持一致。 */
  readonly addHosts?: readonly string[];
}

/** 认领会话容器的标签。孤儿清理靠它,不必去猜容器名。 */
export const SESSION_LABEL = "catman.session";

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
  args.push("--user", spec.user);
  for (const g of spec.groupAdd) args.push("--group-add", String(g));
  for (const h of spec.addHosts ?? []) args.push("--add-host", h);
  // 容器日志也要有上限:大脑话痨起来能把宿主磁盘写满,而磁盘满会让 dockerd
  // 全面异常 —— 那时候连回滚都做不了。
  args.push("--log-driver", "json-file", "--log-opt", "max-size=8m", "--log-opt", "max-file=1");
  for (const m of spec.mounts) args.push("-v", `${m.host}:${m.at}${m.ro ? ":ro" : ""}`);
  // cwd 容器内外同路径。SDK 用 cwd 决定会话 JSONL 写进哪个 project 目录,
  // 两边不一致的话 resume 会找不到上一段 —— 表现为"助手失忆",而没有任何报错。
  args.push("-w", spec.cwd);
  if (spec.tz) args.push("-e", `TZ=${spec.tz}`);
  // ⚠️ 环境变量**不在这里加**。它们由包装脚本在运行时整个转发 ——
  // 这个函数拼不出那份名单,因为 SDK 还会往子进程环境里塞它自己的变量,
  // 而那要等进程真的起来才看得到。见 buildWrapperScript 的说明。
  return args;
}

/** 镜像与要在容器里执行的命令。**必须排在所有 flag 之后**,所以单独给。 */
export function buildSessionImageArgs(spec: SessionContainerSpec): string[] {
  return [spec.image, spec.claudePath];
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
export function buildWrapperScript(
  preArgs: readonly string[],
  imageAndCmd: readonly string[],
): string {
  const q = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# 由 catman 生成 —— 把这一回合的大脑关进它自己的容器。请勿手工编辑。",
    "# SDK 以为自己在 exec 一个原生二进制,实际 exec 的是这个脚本;",
    "# 它把固定的七个 flag 原样转发进容器,stdio 直通,SDK 那侧无感。",
    "",
    "# 环境变量**在运行时整个转发**,而不是照一份白名单挑。",
    "#",
    "# 白名单栽过一次:网关的契约本来就是「把 process.env 整个传下去,只剔除两个密钥」",
    "# (见 turn-env.ts),而我照白名单挑,于是容器里悄悄少了 12 个变量 ——",
    "# PATH 少了 /data/bin(catman-notify 直接 command not found)、管理员少了",
    "# CATMAN_ADMIN_TOKEN、助手少了 CATMAN_HOST_DATA_DIR(共享人设教它拿这个做 docker -v)。",
    "# 每一个都是「能跑,只是某个功能没了」,而且要等踩到才知道。",
    "#",
    "# 改成转发全部之后,网关以后加什么变量都自动跟着进来,不必两处同步。",
    "# 值不进 argv:`-e NAME` 让 docker 从本进程环境取,于是 token 不会出现在",
    "# `docker inspect` 和宿主的 ps 里。",
    "#",
    "# ⚠️ 这里**不能用 `set --`** 去攒参数:那会覆盖掉位置参数,而位置参数正是 SDK",
    "# 传进来的那七个 flag,它们必须原样排在最后交给容器里的 claude。",
    "# (写错过一次,症状是大脑拿不到 --output-format 直接起不来。)",
    "# 环境变量**名**不含空格(正则已经限定),所以用变量拼、最后不加引号让它拆词是安全的。",
    "_e=",
    "for _k in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'); do",
    '  case "$_k" in',
    "    # IPC 密钥是 turn-env 刻意剔掉的,别在这里又漏回去;",
    "    # HOSTNAME/_/PWD 是当前进程自己的,带进去只会让人困惑。",
    "    CATMAN_IPC_SECRET|HOSTNAME|PWD|_) continue ;;",
    "  esac",
    '  _e="$_e -e $_k"',
    "done",
    `exec docker ${preArgs.map(q).join(" ")} $_e ${imageAndCmd.map(q).join(" ")} "$@"`,
    "",
  ].join("\n");
}

/**
 * 大脑二进制在一个 release 目录里的位置。
 *
 * 提出来是为了能测:这条路径拼错的话,症状是"容器起来了又立刻退出",而 SDK 那侧
 * 只报一句含糊的子进程失败 —— 从那里回溯到"少了一段目录名"很贵。
 * (`linux-x64` 是 glibc 那个变体,与 `catman-env` 的 Debian 底对得上;
 * 换成 musl 底的镜像就要改这里。)
 */
export function claudePathIn(releaseDir: string): string {
  return `${releaseDir}/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`;
}

/** 包装脚本的文件名前缀。生成与清扫两处都用它,免得两边各写一份而慢慢走样。 */
export const WRAPPER_PREFIX = "session-exec-";

/** 多久算过期。给足余量 —— 一个回合跑几小时是正常的,删掉正在用的那个是灾难。 */
export const WRAPPER_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * 挑出该删的包装脚本。
 *
 * 纯函数是为了能测:这里唯一致命的错是**把还在用的那个删掉** ——
 * 那会让正在跑的回合下一次 exec 时找不到文件,而症状是"助手忽然不回话了"。
 * 所以判据只有两条,都保守:名字前缀对得上、而且**足够老**。
 */
export function staleWrappers(
  entries: ReadonlyArray<{ name: string; mtimeMs: number }>,
  now: number,
  ttlMs: number = WRAPPER_TTL_MS,
): string[] {
  return entries
    .filter((e) => e.name.startsWith(WRAPPER_PREFIX) && e.name.endsWith(".sh"))
    .filter((e) => now - e.mtimeMs > ttlMs)
    .map((e) => e.name);
}

/** 会话容器的名字。一个会话同时只该有一个回合在跑,所以用 userKey 就够认。 */
export function sessionContainerName(userKey: string, turnId: string): string {
  const safe = userKey.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 40);
  return `catman-session-${safe}-${turnId}`.toLowerCase();
}

/** 附件不进容器 —— 它们是 SDK 侧内联进消息的,与容器无关。这里只是把类型钉住。 */
export type _AttachmentsStayOutside = Attachment;

/**
 * 挑出该回收的孤儿会话容器。
 *
 * 会话容器带 `--rm`,正常退出时 docker 自己清掉。但**有两条路会留下孤儿**:
 * catman 被换版本/杀掉时,那些 `docker run` 客户端一起没了,而容器不随客户端死
 * (实测:SIGKILL 掉客户端,容器 Up 3s → Up 7s 照跑);dockerd 自己重启也一样。
 *
 * 这里唯一致命的错是**把还在跑的那个删掉** —— 症状是"助手忽然不回话了",
 * 而且完全看不出跟回收有关。所以判据保守到两条同时成立:
 *   ① 不在活跃名单里(catman 记得自己起了哪些)
 *   ② 而且**足够老** —— 刚起来还没来得及登记的那个,不能碰
 */
export function orphanSessionContainers(
  running: ReadonlyArray<{ name: string; startedMsAgo: number }>,
  alive: ReadonlySet<string>,
  minAgeMs: number = 10 * 60 * 1000,
): string[] {
  return running
    .filter((c) => !alive.has(c.name))
    .filter((c) => c.startedMsAgo > minAgeMs)
    .map((c) => c.name);
}
