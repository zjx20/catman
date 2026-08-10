import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile } from "../core/file-store.js";
import { parseDeployReport, formatDeployReport } from "../core/deploy-report.js";
import { parseVerifiedHistory } from "../core/deploy.js";
import { listPreparedReleases, pointerSha } from "../core/releases.js";
import { renderStatus, type StatusView } from "./status.js";
import { DEFAULT_THRESHOLDS, decide, type ContainerState, type WatchdogAction } from "./watchdog.js";

/**
 * 守护人格的机械层:看门狗循环 + 无 LLM 状态页。
 *
 * ## 它读什么、写什么
 *
 * **只读**主 `/data`(部署报告、指针、已验证清单、信使的队列文件),**不写**任何一个 ——
 * 那些状态各有自己的写者。它唯一的"写"是**起一个一次性 deployer 容器**,
 * 而那正是「更新者不能是被更新者」在这里的落点:它自己不换指针,由执法面去换。
 *
 * ## 观测靠 docker CLI
 *
 * 不引 docker SDK(运行时零依赖),就地 `docker inspect`。取不到时按"看不见"处理 ——
 * 看不见**不等于**坏了,那时什么都不做。一个把"我瞎了"当成"它死了"的看门狗,
 * 会在 dockerd 抖动时把版本一路退到底。
 */

export interface RunnerOptions {
  /** 主 /data(只读)。 */
  dataDir: string;
  releasesDir: string;
  deployDir: string;
  courierDir: string;
  primaryContainer: string;
  courierContainer: string;
  statusPort: number;
  /** 状态页的令牌。与主 dashboard 同一份 —— 守护人格不生成自己的。 */
  token: string;
  /** 看门狗的巡检间隔。 */
  intervalMs?: number;
  now?: () => number;
  /** 起一次性 deployer。单测注入。 */
  runDeployer?: (args: readonly string[]) => void;
  /** 读容器状态。单测注入。 */
  inspect?: (name: string) => ContainerState;
}

export class RescueRunner {
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private server?: Server;
  private lastAction?: { at: string; action: WatchdogAction };
  /** 本轮之前已经自动退过几级。**进程内**记 —— 见 tick 里的说明。 */
  private demotedSteps = 0;
  /** 上次看到的 current,用来判断"人插手过了"。 */
  private lastSeenCurrent?: string;
  /** 本轮之前已经把信使退过一次。见 tick 里的说明,与 demotedSteps 同一个理由。 */
  private courierFellBack = false;
  /** 上次看到的 pinned,用来判断"人重新 bless 过了"。 */
  private lastSeenPinned?: string;

  constructor(private readonly opts: RunnerOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    this.server = createServer((req, res) => {
      void this.serve(req.url ?? "/", req.method ?? "GET", res);
    });
    this.server.listen(this.opts.statusPort, () => {
      console.info(`[rescue] 状态页 http://0.0.0.0:${this.opts.statusPort}`);
    });
    // 巡检定时器**不 unref**:它欠着"发现主人格死了就把它救回来"这件事。
    // 与超时提醒那种纯观测的定时器不同 —— 那些晚一轮无所谓,这个不是。
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? 30_000);
    this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  /** 巡检一轮。**绝不抛** —— 它跑在定时器里,抛出去就是整个看门狗静悄悄地停了。 */
  tick(): void {
    try {
      const current = pointerSha(this.opts.releasesDir, "current");
      // **人插手过就把级数清零。** 有人手动 `/回滚` 或重新部署之后,"已经退过几级"
      // 这个计数就不再指代当前处境了 —— 不清零的话看门狗会以为还在往回退的半路上,
      // 于是下一次故障时直接跳过前几级。
      if (current && current !== this.lastSeenCurrent) {
        if (this.lastSeenCurrent !== undefined) this.demotedSteps = 0;
        this.lastSeenCurrent = current;
      }
      // pinned 变了有两种可能,必须分开:人重新 bless 了(拿新代码来救),
      // 或者就是上面那次兜底自己换的。**只有前一种该解闩** —— 否则人换了一份
      // 好代码上去,它再崩时看门狗会以为"退过了、没用"然后袖手旁观。
      //
      // 判据就是 `pinned-prev`:bless 换 pinned 之前会先把旧的存进去,所以人干的
      // 那次之后两者不同;而我们自己那次是把 pinned 挪到 pinned-prev 身上,两者相等。
      const pinned = pointerSha(this.opts.releasesDir, "pinned");
      if (pinned && pinned !== this.lastSeenPinned) {
        if (this.lastSeenPinned !== undefined && this.hasPinnedPrev()) this.courierFellBack = false;
        this.lastSeenPinned = pinned;
      }

      const obs = {
        primary: this.inspect(this.opts.primaryContainer),
        courier: this.inspect(this.opts.courierContainer),
        ...this.lockState(),
        currentIsStable: !!current && current === pointerSha(this.opts.releasesDir, "stable"),
        remainingHistory: Math.max(0, this.history().length - 1),
        demotedSteps: this.demotedSteps,
        hasPinnedPrev: this.hasPinnedPrev(),
        courierFellBack: this.courierFellBack,
      };
      const action = decide(obs, this.now(), DEFAULT_THRESHOLDS);
      if (action.kind !== "none") {
        this.lastAction = { at: new Date(this.now()).toISOString(), action };
        console.warn(`[rescue] 看门狗:${action.kind} —— ${action.why}`);
      }
      if (action.kind === "demote") {
        this.demotedSteps = action.step;
        this.runDeployer(["demote", "--step", String(action.step), "--why", action.why]);
      }
      if (action.kind === "courier-fallback") {
        // 决策那边已经过了三道闸(有 pinned-prev、没退过、主人格是好的),
        // 这里只负责执行**一次**。门闩记在进程里,与 demotedSteps 同一个理由:
        // 它描述的是"本轮故障处理进行到哪一步",而不是一个该持久化的事实。
        this.courierFellBack = true;
        this.runDeployer(["courier-fallback", "--why", action.why]);
      }
    } catch (err) {
      console.error("[rescue] 巡检失败(下一轮继续):", err);
    }
  }

  // --- 内部 ---

  private inspect(name: string): ContainerState {
    if (this.opts.inspect) return this.opts.inspect(name);
    try {
      const out = execFileSync(
        "docker",
        ["inspect", "-f", "{{.State.Running}} {{.RestartCount}} {{.State.StartedAt}}", name],
        { encoding: "utf8", timeout: 10_000 },
      ).trim();
      const [running, restarts, startedAt] = out.split(/\s+/);
      return {
        running: running === "true",
        restarts: Number(restarts) || 0,
        since: Date.parse(startedAt ?? "") || this.now(),
      };
    } catch {
      // **看不见 ≠ 坏了。** 报成"运行中、零重启"让 decide 给出 none ——
      // 一个把"我瞎了"当成"它死了"的看门狗,会在 dockerd 抖动时把版本一路退到底。
      return { running: true, restarts: 0, since: this.now() };
    }
  }

  /**
   * 有没有一份**不同于当前 pinned** 的 pinned-prev 可退。
   *
   * 两个条件缺一不可。`bless.sh` 在**第二次**钦定时才产生 pinned-prev,所以首次
   * 部署之后它不存在 —— 那时"切过去"就是切到空气。而一次兜底之后两者会相等,
   * 再退一次是空动作,却会让日志上看起来像是又救了一回。
   */
  private hasPinnedPrev(): boolean {
    const prev = pointerSha(this.opts.releasesDir, "pinned-prev");
    return !!prev && prev !== pointerSha(this.opts.releasesDir, "pinned");
  }

  private lockState(): { lockHeartbeatAt?: number } {
    const lock = readJsonFile<{ heartbeat?: unknown }>(
      join(this.opts.releasesDir, ".deploy-lock"),
      {},
    );
    // 锁文件里的心跳是**秒**(shell 的 date +%s),这里统一成毫秒。
    return typeof lock.heartbeat === "number" ? { lockHeartbeatAt: lock.heartbeat * 1000 } : {};
  }

  private history(): readonly { sha: string }[] {
    return parseVerifiedHistory(
      readJsonFile<unknown>(join(this.opts.releasesDir, "verified-history.json"), undefined),
    );
  }

  private runDeployer(args: readonly string[]): void {
    if (this.opts.runDeployer) return this.opts.runDeployer(args);
    const runner = join(this.opts.deployDir, "bin", "deployer-run.sh");
    // detached + unref:它会停掉别的容器,不该跟着本进程的生命周期走。
    const child = spawn(runner, [...args], { detached: true, stdio: "ignore" });
    child.on("error", (e) => console.error(`[rescue] 起 deployer 失败:${String(e)}`));
    child.unref();
  }

  private view(): StatusView {
    const depths: Record<string, number> = {};
    const losses: Record<string, { dropped: number; nacked: number }> = {};
    for (const persona of ["primary", "rescue"]) {
      // 直接数信使队列文件里未 ack 的行 —— 守护人格对 /data 是**只读**的,
      // 而这个数正是"排水的第二个真相源"(人格的 /health 结构上看不见它)。
      depths[persona] = countPending(join(this.opts.courierDir, "inbox", `${persona}.jsonl`));
      losses[persona] = { dropped: 0, nacked: 0 };
    }
    const report = parseDeployReport(
      readJsonFile<unknown>(join(this.opts.deployDir, "report.json"), undefined),
    );
    return {
      containers: [
        { name: this.opts.primaryContainer, ...pick(this.inspect(this.opts.primaryContainer)) },
        { name: this.opts.courierContainer, ...pick(this.inspect(this.opts.courierContainer)) },
      ],
      pointers: Object.fromEntries(
        ["current", "stable", "pinned", "pinned-prev"].map((n) => [
          n,
          pointerSha(this.opts.releasesDir, n) ?? "",
        ]),
      ),
      ...(this.lastAction ? { lastAction: this.lastAction } : {}),
      depths,
      losses,
      lost: 0,
      ...(report ? { lastDeploy: formatDeployReport(report) } : {}),
      logTail: [`已制备的 release:${listPreparedReleases(this.opts.releasesDir).length} 个`],
    };
  }

  private async serve(url: string, method: string, res: import("node:http").ServerResponse): Promise<void> {
    const u = new URL(url, "http://localhost");
    // 令牌读的是主 dashboard 那一份 —— 守护人格**不生成自己的**:两份令牌意味着
    // 出事时人要先想起来是哪一份,而那时他正着急。
    if (u.searchParams.get("token") !== this.opts.token) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      return void res.end("需要 token");
    }
    if (method === "POST" && u.pathname === "/act/demote") {
      this.runDeployer(["demote", "--step", "1", "--why", "状态页上的人工操作"]);
      res.writeHead(303, { location: `/?token=${encodeURIComponent(this.opts.token)}` });
      return void res.end();
    }
    if (method === "POST" && u.pathname === "/act/restart-primary") {
      try {
        execFileSync("docker", ["restart", this.opts.primaryContainer], { timeout: 60_000 });
      } catch (err) {
        console.error("[rescue] 重启主人格失败:", err);
      }
      res.writeHead(303, { location: `/?token=${encodeURIComponent(this.opts.token)}` });
      return void res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderStatus(this.view()));
  }
}

function pick(c: ContainerState): { running: boolean; restarts: number } {
  return { running: c.running, restarts: c.restarts };
}

/** 数一个 inbox 文件里还没被 ack 的消息条数。读不到当 0。 */
function countPending(path: string): number {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  const alive = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as { t?: string; id?: string; msgId?: string };
      if (r.t === "a" && r.id) alive.delete(r.id);
      else if (r.msgId) alive.add(r.msgId);
    } catch {
      // 半截行,跳过 —— 与 Inbox.replay 同一条纪律。
    }
  }
  return alive.size;
}
