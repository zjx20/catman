import { spawn } from "node:child_process";
import type { CronLimits, CronMount } from "./types.js";

/**
 * 脚本任务的执行面:把一条命令跑进一个**一次性容器**。
 *
 * ## 为什么是 detached 而不是子进程
 *
 * 与 deployer 是同一个理由(见 `deployer-run.sh` 的开头):catman 随时会被自我
 * 进化换掉。跑成子进程的话,一次部署就会把正在备份的任务从中间劈断,而现场
 * 只剩一条"跑到一半"的记录。独立容器完全不受影响 —— 进程回来之后,靠容器名
 * 把它认领回来接着看结果就行。
 *
 * 于是这里没有"等它跑完"这个动作:launch 起一个容器就返回,scheduler 每次 tick
 * 去 poll 一下。重启后的认领与正常轮询走的是**同一条路径**,不存在只在崩溃时
 * 才跑的代码。
 *
 * ## 隔离
 *
 * 默认断网、默认只读挂载、固定非 root uid、内存/CPU/PID 三个上限全给。
 * 这不是防谁 —— 任务是管理员自己建的,而 catman 本来就有 docker.sock。它防的是
 * **事故**:一条写错的命令在 2 核软路由上能把宿主拖到失去响应,而那时候连
 * 回滚都做不了。
 */

export interface LaunchSpec {
  readonly container: string;
  readonly jobId: string;
  readonly image: string;
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly network: "none" | "mynet";
  readonly mounts: readonly CronMount[];
  readonly limits: CronLimits;
  /** 工作目录在**宿主**上的路径。传容器内路径的话 docker 会静默建一个空目录。 */
  readonly hostWorkDir: string;
  /** 容器里的时区。不给的话容器里是 UTC,而任务里的 date 与 catman 的时间戳就对不上了。 */
  readonly tz?: string;
}

export type PollResult =
  | { readonly state: "running" }
  | { readonly state: "exited"; readonly exitCode: number }
  /** 容器不在了(被人手工删了,或宿主重启过)。 */
  | { readonly state: "gone" };

export interface ScriptRunner {
  launch(spec: LaunchSpec): Promise<{ ok: true } | { ok: false; error: string }>;
  poll(container: string): Promise<PollResult>;
  logs(container: string): Promise<string>;
  stop(container: string): Promise<void>;
  remove(container: string): Promise<void>;
  /**
   * 清掉没人认领的任务容器。可选 —— 假的执行面(测试)不必实现,
   * 而真实现里它要花一次 `docker ps`,所以只在启动时扫一遍。
   */
  reapOrphans?(alive: ReadonlySet<string>): Promise<number>;
}

/** 容器以它跑。与 catman 主进程同一个 uid —— 工作目录才写得进去。 */
const RUN_AS = "10001:10001";
/** 单条 docker 命令的超时。dockerd 卡住时不该把整个 tick 拖住。 */
const CLI_TIMEOUT_MS = 30_000;
/** 认领容器用的标签。孤儿清理靠它,不必去猜容器名。 */
export const CRON_LABEL = "catman.cron.job";

export function containerNameFor(jobId: string, runId: string): string {
  // 容器名只能是 [a-zA-Z0-9][a-zA-Z0-9_.-]*;jobId 与 runId 都已经满足。
  return `catman-cron-${jobId}-${runId}`.toLowerCase();
}

/**
 * 拼 `docker run` 的参数。
 *
 * **单独一个纯函数**,不是写在 launch 里的一段:这串参数里有一半是隔离闸门
 * (断网、非 root、三个资源上限、只读挂载),而它们出错的方式是"照跑不误,
 * 只是没有防护" —— 那种错没有症状,只能靠断言钉住。
 */
export function buildRunArgs(spec: LaunchSpec): string[] {
  const args = ["run", "-d", "--name", spec.container, "--label", `${CRON_LABEL}=${spec.jobId}`];
  // --init:容器里 PID 1 是任务本身时,docker stop 的 SIGTERM 常常没人处理,
  // 超时只能靠 SIGKILL;有了 init 进程,停止是干净的,僵尸进程也有人收。
  args.push("--init");
  // ⚠️ 与它配套的这一行不能省。默认镜像 catman-env 的 ENTRYPOINT 本身就是
  // `tini -- …`,加上 --init 之后就有**两个** tini,里面那个发现自己不是 PID 1
  // 会往 stderr 打三行告警。那三行会跟着任务输出一起进执行记录,而通知只截尾巴 ——
  // 于是一个没有输出的任务,用户收到的整条消息就是这堆告警。
  // 设了 TINI_SUBREAPER 之后里面那个注册成 child subreaper,既不再抱怨也照常收僵尸。
  // (真机实测出来的,不是照着文档写的。)
  args.push("-e", "TINI_SUBREAPER=1");
  args.push("--network", spec.network);
  args.push("--memory", spec.limits.memory);
  args.push("--cpus", String(spec.limits.cpus));
  args.push("--pids-limit", String(spec.limits.pids));
  args.push("--user", RUN_AS);
  // 容器自己的日志也要有上限:一个话痨任务能把宿主磁盘写满,而磁盘满会让
  // dockerd 全面异常 —— 那时候连回滚都做不了(与 compose 里那段是同一条理由)。
  args.push("--log-driver", "json-file", "--log-opt", "max-size=8m", "--log-opt", "max-file=1");
  args.push("-v", `${spec.hostWorkDir}:/work`);
  for (const m of spec.mounts) args.push("-v", `${m.host}:${m.at}${m.ro ? ":ro" : ""}`);
  args.push("-w", "/work");
  // 时区:容器**不继承**宿主也不继承 catman,不给就是 UTC —— 于是任务里一句
  // date 打出来的时间和微信里看到的差好几个小时,而这件事没有任何报错。
  // 任务自己在 env 里写了 TZ 就听他的。
  if (spec.tz && !("TZ" in spec.env)) args.push("-e", `TZ=${spec.tz}`);
  for (const [k, v] of Object.entries(spec.env)) args.push("-e", `${k}=${v}`);
  args.push(spec.image, ...spec.cmd);
  return args;
}

export class DockerScriptRunner implements ScriptRunner {
  async launch(spec: LaunchSpec): Promise<{ ok: true } | { ok: false; error: string }> {
    const args = buildRunArgs(spec);
    const r = await run(args);
    if (r.code === 0) return { ok: true };
    // 起不来的原因(镜像不存在、名字冲突、挂载路径在宿主上没有)必须原样留给用户 ——
    // 这条错误就是他要看的全部内容。
    return { ok: false, error: (r.stderr || r.stdout || `docker run 退出码 ${r.code}`).trim() };
  }

  async poll(container: string): Promise<PollResult> {
    const r = await run(["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", container]);
    if (r.code !== 0) return { state: "gone" };
    const [status, code] = r.stdout.trim().split(/\s+/);
    // created / restarting / paused 都当"还在跑"—— 它们都会自己走到 exited。
    if (status === "exited" || status === "dead") {
      return { state: "exited", exitCode: Number(code) || 0 };
    }
    return { state: "running" };
  }

  async logs(container: string): Promise<string> {
    const r = await run(["logs", "--tail", "5000", container]);
    // 失败也返回已有的部分:拿不到日志不该让一次成功的执行看起来像失败。
    return r.merged;
  }

  async stop(container: string): Promise<void> {
    await run(["stop", "-t", "10", container]);
  }

  async remove(container: string): Promise<void> {
    await run(["rm", "-f", container]);
  }

  /**
   * 清掉没人认领的任务容器。
   *
   * 会留下孤儿的路径不止一条:执行记录被保留策略删掉了、任务被删掉了、
   * 宿主重启后容器还在。它们都只占几十 KB,但会一直挂在 `docker ps -a` 里,
   * 而那正是管理员排查别的问题时看的地方。
   */
  async reapOrphans(alive: ReadonlySet<string>): Promise<number> {
    const r = await run(["ps", "-aq", "--filter", `label=${CRON_LABEL}`, "--format", "{{.Names}}"]);
    if (r.code !== 0) return 0;
    let n = 0;
    for (const name of r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (alive.has(name)) continue;
      await this.remove(name);
      n += 1;
    }
    return n;
  }
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 两个流按到达顺序拼起来 —— 脚本的输出交错在一起才读得懂。 */
  merged: string;
}

function run(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let merged = "";
    let done = false;
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, merged });
    };
    const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\ndocker ${args[0]} 超过 ${CLI_TIMEOUT_MS / 1000} 秒没返回,已放弃`;
      merged += stderr;
      finish(124);
    }, CLI_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
      merged += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
      merged += b.toString();
    });
    child.on("error", (err) => {
      // docker CLI 压根不存在(本地开发就是这样)。说清楚,别让它看起来像任务失败。
      stderr += `起不动 docker:${String(err)}`;
      merged += stderr;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 0));
  });
}
