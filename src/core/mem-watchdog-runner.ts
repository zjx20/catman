import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideMemAction,
  killNoticeText,
  parseAnonBytes,
  parseOomKills,
  warnText,
  type MemAction,
  type MemObservation,
} from "./mem-watchdog.js";

/**
 * 内存看门狗的**执行面**。决策在 `mem-watchdog.ts`(纯函数),这里只负责读数和动手。
 *
 * ## 为什么观测走 cgroup 文件而不是 `docker stats`
 *
 * 实测:`readFileSync(memory.stat)` **58 微秒**,`docker stats --no-stream` **1.05 秒** ——
 * 差约 18000 倍。每秒对每个会话轮询一次的话,后者根本跑不动,而且它还把守护进程
 * 拽进了观测路径。
 *
 * ## 为什么兜底那一刀走 cgroup.kill 而不是 `docker kill`
 *
 * 事故当下 dockerd 本身就是废的(管理员实测 `docker restart` 十几分钟不返回)。
 * 写 `cgroup.kill` 是一次几字节的文件写,内核直接把该 cgroup 里所有进程 SIGKILL,
 * **完全不经过守护进程** —— 这是整条阶梯上唯一有保证的动作,所以它必须在末端。
 *
 * 中间那一级(90% 杀单个进程)倒是可以用 `docker exec`:那一刻会话撞的是自己的
 * 700m 上限,宿主还剩好几个 G、守护进程是健康的。它只求方便,不求保证 ——
 * 超时或失败就让 95% 那级兜底,所以给它一个短超时、失败不阻塞。
 */

/** 宿主 cgroup 里 docker 子树的默认位置。只挂这个子树,catman 就动不了系统的 cgroup。 */
export const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup/docker";

/** 90% 那一刀的超时。dockerd 慢的时候不该把轮询拖住。 */
const EXEC_TIMEOUT_MS = 2_000;

export interface WatchTarget {
  /** 容器完整 id —— cgroup 目录名用的是它,不是容器名。 */
  readonly id: string;
  readonly name: string;
}

/** 一次观测的原始读数。读不到时给 undefined,由调用方当成"这一轮没观测到"。 */
export interface CgroupReading {
  readonly anonBytes: number;
  readonly limitBytes: number;
  readonly oomKills: number;
}

/**
 * 读一个容器的 cgroup。
 *
 * 任何一步读不到都返回 undefined 而**不是 0**:返回 0 会让看门狗永远不开火,
 * 而且没有任何症状 —— 那比误杀更难发现。挂载没生效时正是走这条路。
 */
export function readCgroup(root: string, id: string): CgroupReading | undefined {
  try {
    const dir = join(root, id);
    const anonBytes = parseAnonBytes(readFileSync(join(dir, "memory.stat"), "utf8"));
    if (anonBytes === undefined) return undefined;
    const rawMax = readFileSync(join(dir, "memory.max"), "utf8").trim();
    // "max" = 没设上限。这时看门狗一律放行(见 decideMemAction 的第一条)。
    const limitBytes = rawMax === "max" ? 0 : Number(rawMax);
    if (!Number.isFinite(limitBytes)) return undefined;
    let oomKills = 0;
    try {
      oomKills = parseOomKills(readFileSync(join(dir, "memory.events"), "utf8"));
    } catch {
      // memory.events 读不到不致命 —— 只是失去"内核抢先开火"这一路检测。
    }
    return { anonBytes, limitBytes, oomKills };
  } catch {
    return undefined;
  }
}

/** 跑一条 docker 命令,带超时。看门狗的每一次外部调用都必须有上限。 */
function dockerRun(args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const p = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const done = (ok: boolean) => {
      clearTimeout(timer);
      resolve({ ok, out });
    };
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      done(false);
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += String(d)));
    p.stderr.on("data", (d) => (out += String(d)));
    p.on("error", () => done(false));
    p.on("close", (code) => done(code === 0));
  });
}

/**
 * 在容器里找出吃内存最多的那个**非大脑**进程,杀掉它。
 *
 * "非大脑"这个限定是硬的:占用最大的通常就是 claude 本身(常态 RSS 约 293MB),
 * 杀了它等于杀掉整个回合 —— 而这一级存在的全部意义正是**保住回合**。
 * 要杀的是它起的那条失控命令。
 *
 * 返回被杀进程的名字(拿去写进给大脑的通知);没找到或失败返回 undefined。
 */
export async function killLargestChild(name: string): Promise<string | undefined> {
  // 在容器里遍历 /proc 取 RSS。用 sed 取前一条而不是 head —— 这个环境里
  // 管道接 head 会 segfault(见共享人设)。
  const script =
    "for p in /proc/[0-9]*; do " +
    "[ -r $p/statm ] || continue; " +
    'c=$(cat $p/comm 2>/dev/null); ' +
    'case "$c" in claude|node) continue;; esac; ' +
    'echo "$(awk \'{print $2}\' $p/statm 2>/dev/null) $(basename $p) $c"; ' +
    "done | sort -rn | sed -n 1p";
  const r = await dockerRun(["exec", name, "sh", "-c", script], EXEC_TIMEOUT_MS);
  if (!r.ok) return undefined;
  const [, pid, comm] = r.out.trim().split(/\s+/);
  if (!pid || !/^\d+$/.test(pid)) return undefined;
  const k = await dockerRun(["exec", name, "kill", "-9", pid], EXEC_TIMEOUT_MS);
  return k.ok ? comm : undefined;
}

/**
 * 把容器里所有进程杀干净。先试内核那一下,不行再走 dockerd。
 *
 * ## 为什么需要退路(这里栽过一次)
 *
 * `cgroup.kill` 的权限是 `--w------- root root`,而 catman 跑在 uid 10001 上 ——
 * **写不进去**。当初我"端到端验证通过"是在一个没加 `--user` 的容器里以 root 跑的,
 * 验证条件和生产条件不一致,等于没验。
 *
 * 于是内核那条路在当前部署形态下用不了,得靠 `docker kill`(实测 364ms,
 * 8 个进程的容器整个带走,退出码 137)。代价是它经过 dockerd,而事故当下
 * dockerd 可能是废的 —— 但那种"整机活锁"恰恰是 700m 上限要防止的事:
 * 会话撞的是自己的上限,那一刻宿主还剩好几个 G,dockerd 是健康的。
 *
 * 内核那条路仍然留着放在前面:哪天 catman 以 root 跑、或者做了 cgroup 委派,
 * 它会自动变回"不经过守护进程"的那条。
 *
 * 返回走的是哪条路,给日志用 —— 事后要能一眼看出当时是哪种。
 */
export async function killContainerHard(
  root: string,
  id: string,
  name: string,
): Promise<"cgroup" | "docker" | "failed"> {
  try {
    // cgroupfs 的控制文件只认一个整数,写 "1" 即触发。
    writeFileSync(join(root, id, "cgroup.kill"), "1");
    return "cgroup";
  } catch {
    // 落到这里是常态,不是异常 —— 见上面的权限说明。
  }
  const r = await dockerRun(["kill", name], EXEC_TIMEOUT_MS);
  return r.ok ? "docker" : "failed";
}

/** 看门狗在一个回合里累积的状态。决策是纯函数,状态得由这里带着。 */
export class TurnMemState {
  warned = false;
  procKilled = false;
  procKilledAt = 0;
  /** 回合开始时的内核 oom_kill 基线 —— 只关心**本回合**的增量。 */
  private oomBaseline: number | undefined;

  observe(reading: CgroupReading, now: number): MemObservation {
    if (this.oomBaseline === undefined) this.oomBaseline = reading.oomKills;
    return {
      anonBytes: reading.anonBytes,
      limitBytes: reading.limitBytes,
      kernelOomKills: Math.max(0, reading.oomKills - this.oomBaseline),
      warned: this.warned,
      procKilled: this.procKilled,
      msSinceProcKill: this.procKilled ? now - this.procKilledAt : 0,
    };
  }

  /** 记下这一刻做了什么,好让下一轮的决策看得到。 */
  record(action: MemAction, now: number): void {
    if (action.kind === "warn") this.warned = true;
    if (action.kind === "kill-process") {
      this.procKilled = true;
      this.procKilledAt = now;
    }
  }
}

/** 把读数直接走一遍决策。给调用方一个不用自己拼观测的入口。 */
export function stepWatchdog(
  state: TurnMemState,
  reading: CgroupReading,
  now: number,
): MemAction {
  const action = decideMemAction(state.observe(reading, now));
  state.record(action, now);
  return action;
}

/** 轮询间隔。实测那次爬升是 33MB/s,1 秒一采能在 80%→95% 之间拿到好几次机会。 */
const POLL_MS = 1_000;
/** 等容器出现的上限。SDK exec 包装脚本、docker 起容器都要时间,但不该无限等。 */
const RESOLVE_TIMEOUT_MS = 20_000;

export interface TurnWatchdogHooks {
  /** 往正在跑的回合里塞一条消息(就是 agent 的 feed)。 */
  readonly feed: (text: string) => void;
  /** 中止这一回合。 */
  readonly abort: (reason: string) => void;
  /** 当前跑到哪一步,用来写进警告文案。 */
  readonly step: () => string | undefined;
  readonly log: (line: string) => void;
}

/** 名字 → 完整 id。容器还没起来时返回 undefined,由调用方重试。 */
async function resolveId(name: string): Promise<string | undefined> {
  const r = await dockerRun(["inspect", "-f", "{{.Id}}", name], EXEC_TIMEOUT_MS);
  const id = r.out.trim();
  return r.ok && /^[0-9a-f]{12,}$/.test(id) ? id : undefined;
}

/**
 * 盯住一个回合的会话容器,直到 stop() 被调用。
 *
 * 返回的 stop 是**幂等**的:回合正常结束、abort、以及 SDK 内部抛错三条路径都会调它,
 * 漏掉任何一条都会留下一个空转的定时器,而它还握着 feed 句柄。
 */
export function startTurnWatchdog(
  cgroupRoot: string,
  containerName: string,
  memoryLimit: string,
  hooks: TurnWatchdogHooks,
): () => void {
  const state = new TurnMemState();
  let id: string | undefined;
  let stopped = false;
  const startedAt = Date.now();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (!id) {
      // 容器还没起来。超时就彻底放弃 —— 一个永远解析不出 id 的看门狗,
      // 留着只会每秒敲一次 dockerd,而它保护不了任何东西。
      if (Date.now() - startedAt > RESOLVE_TIMEOUT_MS) {
        hooks.log("看门狗:等不到会话容器,本回合不设防");
        stopped = true;
        return;
      }
      id = await resolveId(containerName);
      if (!id) return;
      hooks.log(`看门狗:盯住 ${containerName.slice(0, 40)} 上限 ${memoryLimit}`);
    }

    const reading = readCgroup(cgroupRoot, id);
    if (!reading) {
      // 读不到就是读不到 —— **不要当成 0**。挂载没生效时正是这条路,
      // 而当成 0 会让看门狗永远不开火且毫无症状。
      return;
    }

    const now = Date.now();
    const action = stepWatchdog(state, reading, now);
    const pct = reading.limitBytes > 0 ? Math.round((reading.anonBytes / reading.limitBytes) * 100) : 0;

    if (action.kind === "warn") {
      hooks.log(`看门狗:anon 到 ${pct}%,喂警告`);
      hooks.feed(warnText(action.ratio, memoryLimit, hooks.step()));
      return;
    }

    if (action.kind === "kill-process") {
      // **先喂消息、再动手** —— 这个顺序是承重的,见 mem-watchdog.ts 的说明与
      // session-memory 用例。反过来的话工具结果先被消化,大脑可能已经原样重试了
      // 一遍才读到解释。
      hooks.feed(killNoticeText(action.ratio, undefined));
      hooks.log(`看门狗:anon 到 ${pct}%,杀掉最大的非大脑进程`);
      const victim = await killLargestChild(containerName);
      hooks.log(victim ? `看门狗:已杀 ${victim}` : "看门狗:没找到可杀的进程(等复查升级)");
      return;
    }

    if (action.kind === "kill-container") {
      stopped = true;
      // **先杀后收**:反过来的话,abort 与容器真正死掉之间那段窗口里内存还在涨。
      // (而且实测 SIGKILL 掉 docker 客户端根本带不走容器,abort 一个人办不成这件事。)
      const via = await killContainerHard(cgroupRoot, id, containerName);
      // 事故记录先落日志再中止:catman 的容器日志是持久的,而这一行是事后
      // 唯一说得清"死在哪一步"的东西。
      hooks.log(
        `⛔ 看门狗:回合被中止 原因=${action.reason} anon=${pct}% ` +
          `上限=${memoryLimit} 当时在跑=${hooks.step() ?? "(未知)"} 杀法=${via}`,
      );
      hooks.abort(action.reason);
      return;
    }
  };

  const timer = setInterval(() => {
    void tick().catch(() => {
      // 看门狗自己抛错绝不能把回合带走 —— 它是观测,不是工作。
    });
  }, POLL_MS);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
