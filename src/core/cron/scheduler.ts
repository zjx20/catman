import { containerNameFor, type ScriptRunner } from "./docker.js";
import { renderAutoDisabled, renderEnd, renderNextLine, renderStart } from "./notify.js";
import { formatAt, nextAt as computeNextAt } from "./schedule.js";
import { inQuietHours, mergeNotices, type NoticeSpool } from "./notices.js";
import type { AgentTaskRunner } from "./agent-runner.js";
import type { CronStore } from "./store.js";
import type { CronJob, CronRun, CronTask, RunStatus, RunTrigger } from "./types.js";

/**
 * 调度器:到点了就跑,跑完了就记账、就报信。
 *
 * ## 三条撑起整个设计的事实
 *
 * 1. **这个进程随时会被换掉。** 自我进化每周都在部署。所以没有任何调度状态只
 *    活在内存里 —— 下次触发时刻存盘,在飞的执行靠容器名认领回来,重启后走的
 *    是与平时**完全相同**的那条 tick 路径,不存在只在崩溃后才跑的代码。
 *
 * 2. **错过的那一档只补一次,而且要在窗口之内。** 部署一次要几分钟,期间到点的
 *    任务确实会错过。补跑一次是对的;把过去 8 小时错过的 16 次全补上则是灾难 ——
 *    而这正是朴素实现("nextAt <= now 就跑,跑完 nextAt += 周期")的默认行为。
 *
 * 3. **宿主只有 2 核。** 全局并发默认 1。名额不够时**什么都不做**,让它下一次
 *    tick 再来 —— 不排队、不记账,因为"排着队的定时任务"是另一套要维护的状态,
 *    而它带来的确定性并不值那个复杂度。
 */

export type NotifyKind = "announce" | "reminder";
export type CronNotifier = (userKey: string, text: string, kind: NotifyKind) => Promise<void>;

/** 每次 tick 现读的那几项配置 —— 管理员在 dashboard 改完不必重启。 */
export interface CronRuntime {
  readonly enabled: boolean;
  readonly maxConcurrent: number;
  readonly runMaxAgeMs: number;
  /** 错过多久之内还值得补跑。超过这个窗口就只记一笔然后等下一档。 */
  readonly catchUpMs: number;
}

export interface SchedulerOptions {
  readonly store: CronStore;
  readonly runner: ScriptRunner;
  /**
   * agent 任务的执行面。缺席时 agent 任务会记一条 error 而不是静默不跑 ——
   * 「建得出来但永远不执行」是最难查的一种坏。
   */
  readonly agentRunner?: AgentTaskRunner;
  /** 攒在静默时段里的结果通知。缺席则不攒(直接推)。 */
  readonly notices?: NoticeSpool;
  /** 现读配置。是函数不是快照 —— 与 prefs 那边同一个理由。 */
  readonly runtime: () => CronRuntime;
  /** 展示用时区。 */
  readonly tz: string;
  /**
   * 透传给**联网的**脚本任务的代理变量(`collectProxyEnv(process.env)`)。
   *
   * 由装配处给出:这台机器有没有代理是部署事实,调度器不该去猜,单测也不该
   * 受跑测试那台机器的环境影响。
   */
  readonly proxyEnv?: Readonly<Record<string, string>>;
  readonly notify?: CronNotifier;
  readonly now?: () => number;
  readonly tickMs?: number;
}

/** 连续失败到这个数就自动停用。 */
const FAIL_STREAK_LIMIT = 3;
/** 通知里带多少字节的输出尾巴。 */
const TAIL_BYTES = 2000;

export class CronScheduler {
  private readonly opts: SchedulerOptions;
  private readonly now: () => number;
  private readonly tickMs: number;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** 名额不够而没跑的事只说一次,免得每 30 秒刷一行。 */
  private warnedBusy = false;
  /**
   * 正在跑的 agent 任务:runId → 中断句柄。
   *
   * 脚本任务的现场在**宿主上**(容器),重启后靠容器名认领得回来;agent 任务的
   * 现场只在**这个进程里**,重启就没了。所以这张表是内存里的,而它空着恰恰是
   * 「这条 running 记录是上辈子留下的」的判据 —— reap 据此把它记成 interrupted,
   * 而不是永远挂着一条谁也收不了的 running。
   */
  private readonly inFlightAgents = new Map<string, AbortController>();

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? 30_000;
  }

  start(): void {
    // 起来先补一次 nextAt:新任务、以及上个版本还没算过这一项的任务。
    for (const job of this.opts.store.all()) {
      if (job.enabled && job.nextAt === undefined) {
        this.opts.store.patch(job.id, { nextAt: computeNextAt(job.schedule, this.now()) });
      }
    }
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    // unref:它只是"定期看一眼"。攥着待办的是磁盘上的任务表和宿主上的容器,
    // 两者都不在这个进程里,所以它没资格拦着进程退出(与 gateway 的提醒定时器同一条界线)。
    this.timer.unref?.();
    void this.bootSweep();
  }

  /**
   * 开机扫一次孤儿容器,然后才跑第一次 tick。
   *
   * 孤儿从哪来:任务在跑到一半时被删、执行记录被保留策略清掉、宿主重启后容器还在。
   * 它们没人认领、也没人回收,却一直占着内存和 PID。
   *
   * **只在开机扫一次**:它要花一次 `docker ps`,而孤儿的产生是稀有事件。
   * 扫的时候把 `ticking` 占住 —— 不然定时器可能在扫描中途起一个新容器,
   * 而它不在扫描开始时算出的"活着"名单里,于是刚起就被自己杀掉。
   */
  private async bootSweep(): Promise<void> {
    this.ticking = true;
    try {
      const alive = new Set<string>();
      for (const r of this.opts.store.activeRuns()) if (r.container) alive.add(r.container);
      const n = (await this.opts.runner.reapOrphans?.(alive)) ?? 0;
      if (n) console.info(`[cron] 清掉了 ${n} 个没人认领的任务容器`);
    } catch (err) {
      console.warn("[cron] 扫孤儿容器失败(不影响调度):", err);
    } finally {
      this.ticking = false;
    }
    await this.tick();
  }

  /**
   * 把这个任务在飞的那一轮停掉。删任务之前调用。
   *
   * 不推通知:用户刚亲手删了它,再收到一条"被中断了"只会让人以为出了岔子。
   * 不停的话那个容器会变成孤儿 —— 记录随任务一起删掉之后,再也没人认领得了它。
   */
  async cancelJob(jobId: string): Promise<void> {
    for (const run of this.opts.store.listRuns(jobId, 5)) {
      if (run.status !== "running" || !run.container) continue;
      try {
        await this.opts.runner.stop(run.container);
        await this.opts.runner.remove(run.container);
      } catch (err) {
        console.warn(`[cron] 停 ${run.container} 失败:${String(err)}`);
      }
      this.opts.store.saveRun({
        ...run,
        status: "interrupted",
        endedAt: this.now(),
        note: "任务被删掉了",
      });
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * 一次 tick:先收在飞的,再点新的火。
   *
   * 顺序不能反 —— 先收再点,那些"上一轮刚跑完"的任务才不会因为记录还挂着
   * `running` 而被 overlap 策略误判成"还在跑"。
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.reap();
      await this.fireDue();
      // 攒着的通知放在最后:这一轮刚收尾的那些也该有机会一起走。
      await this.flushNotices();
    } catch (err) {
      // tick 绝不能抛:它挂在 setInterval 上,一次未捕获的异常就是一条
      // unhandled rejection,而定时器还在,于是每 30 秒复现一次。
      console.error("[cron] tick 出错:", err);
    } finally {
      this.ticking = false;
    }
  }

  // ── 收尾 ────────────────────────────────────────────────────────

  private async reap(): Promise<void> {
    for (const run of this.opts.store.activeRuns()) {
      const job = this.opts.store.get(run.jobId);
      if (!job) continue;
      // agent 任务:现场只在本进程里。还在跑就别碰它(它自己会来收尾);
      // 不在表里说明这条记录是上一辈子留下的 —— 进程被部署换掉时它正跑着。
      if (job.task.kind === "agent") {
        if (this.inFlightAgents.has(run.id)) continue;
        await this.settle(job, run, "interrupted", undefined, "我被重启了,这一轮没跑完");
        continue;
      }
      if (!run.container) {
        // 没有容器名却挂着 running:只可能是记录写到一半进程没了。
        await this.settle(job, run, "interrupted", undefined, "这次执行的现场丢了");
        continue;
      }
      const r = await this.opts.runner.poll(run.container);
      if (r.state === "running") {
        const overdue = this.now() - run.startedAt - job.timeoutMs;
        if (overdue > 0) {
          await this.opts.runner.stop(run.container);
          const logs = await this.opts.runner.logs(run.container);
          await this.opts.runner.remove(run.container);
          await this.settle(job, run, "timeout", undefined, `超过 ${Math.round(job.timeoutMs / 60_000)} 分钟没跑完`, logs);
        }
        continue;
      }
      if (r.state === "gone") {
        await this.settle(job, run, "interrupted", undefined, "容器已经不在了(宿主重启过?)");
        continue;
      }
      const logs = await this.opts.runner.logs(run.container);
      await this.opts.runner.remove(run.container);
      await this.settle(job, run, r.exitCode === 0 ? "ok" : "failed", r.exitCode, undefined, logs);
    }
  }

  /** 给一次执行盖棺:写记录、修剪、更新任务统计、按需报信。 */
  private async settle(
    job: CronJob,
    run: CronRun,
    status: RunStatus,
    exitCode?: number,
    note?: string,
    logs?: string,
  ): Promise<void> {
    const store = this.opts.store;
    const endedAt = this.now();
    const logBytes = logs ? store.writeLog(job.id, run.id, logs) : (run.logBytes ?? 0);
    const done: CronRun = { ...run, status, endedAt, ...(exitCode !== undefined ? { exitCode } : {}), ...(note ? { note } : {}), logBytes };
    store.saveRun(done);
    store.pruneRuns(job.id, job.keepRuns, this.opts.runtime().runMaxAgeMs);

    const bad = status !== "ok" && status !== "skipped";
    const streak = bad ? job.failStreak + 1 : 0;
    let updated =
      store.patch(job.id, { lastRunAt: run.startedAt, lastStatus: status, failStreak: streak }) ?? job;

    // 连续失败到阈值就停用。一个每天失败的任务除了烧资源、刷记录、把真正的
    // 通知挤掉之外什么都不做,而**停用是可逆的**,继续跑不是。
    let autoDisabled = false;
    if (streak >= FAIL_STREAK_LIMIT && updated.enabled) {
      updated = store.patch(job.id, { enabled: false, nextAt: undefined }) ?? updated;
      autoDisabled = true;
    }

    await this.notifyEnd(updated, done);
    if (autoDisabled) await this.push(updated.userKey, renderAutoDisabled(updated, streak), "announce");
  }

  private async notifyEnd(job: CronJob, run: CronRun): Promise<void> {
    if (!job.notify.end) return;
    if (job.notify.onlyFailure && run.status === "ok") return;
    // 跳过这一轮不值得单独推一条:用户没损失什么,而记录里查得到。
    if (run.status === "skipped") return;
    const tail = this.opts.store.readLog(job.id, run.id, TAIL_BYTES);
    const next = renderNextLine(job.nextAt, this.opts.tz, job.enabled, job.schedule.kind === "once");
    const text = renderEnd(job, run, tail, next);

    // 静默时段:攒起来,出窗口时合并成一条。**不是丢掉** —— 半夜的结果照样是
    // 用户第二天要看的东西,只是不该在半夜一条条砸过去(而且那时多半也发不出去)。
    if (this.opts.notices && inQuietHours(job.notify.quiet, this.now(), this.opts.tz)) {
      this.opts.notices.add(job.userKey, {
        jobId: job.id,
        jobName: job.name,
        status: run.status,
        at: this.now(),
        text,
      });
      return;
    }
    await this.push(job.userKey, text, "announce");
  }

  /**
   * 推一条。给了 `job` 就先看它的静默时段 —— 开跑那条在窗口里**直接丢掉**
   * (它描述的是"现在开始了",天亮再说毫无意义),与结果那条攒起来不同。
   */
  private async push(userKey: string, text: string, kind: NotifyKind, job?: CronJob): Promise<void> {
    if (!this.opts.notify) return;
    if (job && inQuietHours(job.notify.quiet, this.now(), this.opts.tz)) return;
    try {
      await this.opts.notify(userKey, text, kind);
    } catch (err) {
      // 发不出去是渠道那边的事(它自己有发件队列)。这里唯一要保证的是:
      // 一条通知发送失败不能把调度器带下水。
      console.warn(`[cron] 通知发送失败(${userKey}):${String(err)}`);
    }
  }

  // ── 点火 ────────────────────────────────────────────────────────

  private async fireDue(): Promise<void> {
    const rt = this.opts.runtime();
    if (!rt.enabled) return;
    const now = this.now();
    for (const job of this.opts.store.all()) {
      if (!job.enabled || job.nextAt === undefined || job.nextAt > now) continue;

      // 错过太久:不补跑,直接推到下一档。这条分支在每次部署之后都会走到。
      const late = now - job.nextAt;
      if (late > rt.catchUpMs) {
        const missedAt = job.nextAt;
        this.advance(job, now);
        console.info(
          `[cron] ${job.id}「${job.name}」错过了 ${formatAt(missedAt, this.opts.tz)} 那一档` +
            `(晚了 ${Math.round(late / 60_000)} 分钟,超出补跑窗口),这一次不补。`,
        );
        continue;
      }

      // **自己跟自己撞车要先判**,排在全局并发之前。
      //
      // 反过来的话,并发上限是 1 时这条分支永远走不到:上一轮占着唯一的名额,
      // 到点的这一轮会被判成"并发已满、等下一轮" —— 于是 overlap=skip 的任务
      // 变成了"上一轮跑完立刻补跑",而用户要的恰恰是**这一档不要了**。
      const active = this.activeRunOf(job.id);
      if (active && job.overlap === "skip") {
        this.recordSkipped(job, "schedule");
        this.advance(job, now);
        continue;
      }
      // active 且 overlap=replace 时不看全局并发:它是换手,不是新增一个在跑的。
      if (!active && this.activeCount() >= rt.maxConcurrent) {
        if (!this.warnedBusy) {
          console.info(`[cron] 并发已满(${rt.maxConcurrent}),到点的任务等下一轮 tick`);
          this.warnedBusy = true;
        }
        // **不推进 nextAt**:它还欠着这一次,下次 tick 有名额了就跑。
        return;
      }
      this.warnedBusy = false;

      const trigger: RunTrigger = late > this.tickMs * 2 ? "catchup" : "schedule";
      this.advance(job, now);
      await this.fire(job, trigger);
    }
  }

  /** 把 nextAt 推到下一档。一次性任务跑完就停用 —— 留着记录,不留一个死排期。 */
  private advance(job: CronJob, from: number): void {
    const next = computeNextAt(job.schedule, from);
    if (next === undefined) {
      this.opts.store.patch(job.id, { enabled: false, nextAt: undefined });
      return;
    }
    this.opts.store.patch(job.id, { nextAt: next });
  }

  private activeCount(): number {
    return this.opts.store.activeRuns().length;
  }

  /** 这个任务自己有没有还在跑的一轮。 */
  private activeRunOf(jobId: string): CronRun | undefined {
    return this.opts.store.listRuns(jobId, 5).find((r) => r.status === "running");
  }

  /**
   * 记一条"这一轮跳过了"。
   *
   * 跳过也要留记录:它是排查"为什么昨天没结果"时最要紧的那条线索,静默跳过
   * 等于把它藏起来。不推通知 —— 用户没损失什么,而记录里查得到。
   */
  private recordSkipped(job: CronJob, trigger: RunTrigger): void {
    const store = this.opts.store;
    const at = this.now();
    store.saveRun({
      id: store.newRunId(at),
      jobId: job.id,
      userKey: job.userKey,
      startedAt: at,
      endedAt: at,
      status: "skipped",
      trigger,
      note: "上一轮还在跑,这一轮按 overlap=skip 跳过",
    });
    store.pruneRuns(job.id, job.keepRuns, this.opts.runtime().runMaxAgeMs);
    console.info(`[cron] ${job.id}「${job.name}」上一轮还在跑,跳过这一轮`);
  }

  /** 手动试跑。**不动排期** —— 它是用来验证任务写对没有的,不是提前触发一次。 */
  async runNow(jobId: string): Promise<CronRun | { error: string }> {
    const job = this.opts.store.get(jobId);
    if (!job) return { error: "任务不存在" };
    if (this.activeCount() >= this.opts.runtime().maxConcurrent) {
      return { error: "现在有别的定时任务在跑,等它跑完再试" };
    }
    const run = await this.fire(job, "manual");
    return run ?? { error: "这个任务上一轮还在跑" };
  }

  private async fire(job: CronJob, trigger: RunTrigger): Promise<CronRun | undefined> {
    const store = this.opts.store;
    // 到这儿还撞车的只剩两条路径:手动试跑,以及 overlap=replace。
    // 定时触发那一路已经在 fireDue 里判完了(它必须排在全局并发之前,见那里的说明)。
    const active = this.activeRunOf(job.id);
    if (active) {
      if (job.overlap === "skip") {
        this.recordSkipped(job, trigger);
        return undefined;
      }
      // replace:先把上一轮停掉,再跑新的。agent 任务的"停掉"就是 abort 它。
      const inflight = this.inFlightAgents.get(active.id);
      if (inflight) {
        inflight.abort();
        // 不在这里 settle:被 abort 的那一轮自己会走到收尾分支去(它手里有
        // 那条记录)。两边都写会让同一次执行被记两遍,而且第二遍会覆盖第一遍。
      } else if (active.container) {
        await this.opts.runner.stop(active.container);
        const logs = await this.opts.runner.logs(active.container);
        await this.opts.runner.remove(active.container);
        await this.settle(job, active, "interrupted", undefined, "被新的一轮顶掉(overlap=replace)", logs);
      } else {
        await this.settle(job, active, "interrupted", undefined, "被新的一轮顶掉(overlap=replace)");
      }
    }

    const startedAt = this.now();
    const runId = store.newRunId(startedAt);
    if (job.task.kind === "agent") return await this.fireAgent(job, job.task, runId, startedAt, trigger);

    const container = containerNameFor(job.id, runId);
    const run: CronRun = {
      id: runId,
      jobId: job.id,
      userKey: job.userKey,
      startedAt,
      status: "running",
      trigger,
      container,
    };
    // **先落盘再起容器**。反过来的话,写盘与起容器之间被杀就会留下一个谁也不认识的
    // 容器,它会一直跑到天荒地老,而记录里没有任何痕迹。
    store.saveRun(run);

    store.ensureWorkDir(job.id);
    const hostWork = store.hostWorkDir(job.id);
    if (!hostWork) {
      await this.settle(
        job,
        run,
        "error",
        undefined,
        "这台机器没配 CATMAN_HOST_DATA_DIR,工作目录挂不进容器",
      );
      return run;
    }

    if (job.notify.start && !job.notify.onlyFailure) {
      await this.push(job.userKey, renderStart(job, run), "reminder", job);
    }

    const r = await this.opts.runner.launch({
      container,
      jobId: job.id,
      image: job.task.image,
      cmd: job.task.cmd,
      env: job.task.env,
      network: job.task.network,
      mounts: job.task.mounts,
      limits: job.task.limits,
      hostWorkDir: hostWork,
      tz: this.opts.tz,
      ...(this.opts.proxyEnv ? { proxyEnv: this.opts.proxyEnv } : {}),
    });
    if (!r.ok) {
      await this.settle(job, run, "error", undefined, `容器没起来:${r.error}`);
      return { ...run, status: "error" };
    }
    console.info(`[cron] ${job.id}「${job.name}」起跑(${trigger},容器 ${container})`);
    return run;
  }

  /**
   * 起一轮 agent 任务。
   *
   * 与脚本任务的形状刻意不同:**不等它跑完**。tick 每 30 秒一次,而一轮 agent
   * 可能要跑好几分钟 —— 在 tick 里 await 它,整个调度器(包括别的任务的收尾)
   * 就一起卡在那儿了。所以这里只把它放出去,收尾由它自己那条 then 完成,
   * 而 reap 靠 inFlightAgents 知道"它还活着,别动"。
   */
  private async fireAgent(
    job: CronJob,
    task: Extract<CronTask, { kind: "agent" }>,
    runId: string,
    startedAt: number,
    trigger: RunTrigger,
  ): Promise<CronRun> {
    const store = this.opts.store;
    const run: CronRun = {
      id: runId,
      jobId: job.id,
      userKey: job.userKey,
      startedAt,
      status: "running",
      trigger,
    };
    store.saveRun(run);

    if (!this.opts.agentRunner) {
      // 「建得出来但永远不执行」是最难查的一种坏:任务表里一切正常,记录里空空如也。
      await this.settle(job, run, "error", undefined, "这个进程没有装配 agent 执行面,跑不了 agent 任务");
      return { ...run, status: "error" };
    }

    if (job.notify.start && !job.notify.onlyFailure) {
      await this.push(job.userKey, renderStart(job, run), "reminder", job);
    }

    const abort = new AbortController();
    this.inFlightAgents.set(runId, abort);
    // 超时靠它。**unref**:它要掐的那个回合就活在这个进程里,进程都没了的话
    // 也就没什么可掐的了 —— 与脚本任务那边刻意不同(那边的现场在宿主上,
    // 进程死了容器还在跑)。不 unref 的话,一个 30 分钟超时的任务会让进程
    // 在收尾时白等半小时。
    const timer = setTimeout(() => abort.abort(), job.timeoutMs);
    timer.unref?.();
    console.info(`[cron] ${job.id}「${job.name}」起跑(${trigger},agent)`);

    void this.opts.agentRunner
      .run({ job, task, abort })
      .then(async (r) => {
        // chain 模式要把会话 id 记下来,下一次接着它跑。
        if (task.session === "chain" && r.sessionId) {
          store.patch(job.id, { agentSessionId: r.sessionId });
        }
        const fresh = store.get(job.id) ?? job;
        await this.settle(fresh, run, r.ok ? "ok" : "failed", undefined, undefined, r.text);
      })
      .catch(async (err) => {
        const aborted = abort.signal.aborted;
        const fresh = store.get(job.id) ?? job;
        await this.settle(
          fresh,
          run,
          aborted ? "timeout" : "failed",
          undefined,
          aborted ? `超过 ${Math.round(job.timeoutMs / 60_000)} 分钟没跑完,已中止` : undefined,
          String(err),
        );
      })
      .finally(() => {
        clearTimeout(timer);
        this.inFlightAgents.delete(runId);
      });

    return run;
  }

  // ── 静默时段与积压合并 ──────────────────────────────────────────

  /**
   * 把攒着的通知发出去 —— 只发那些**已经出了静默窗口**的用户。
   *
   * 判据用的是每条通知自己那个任务的窗口:同一个用户可能有几个任务、各设各的
   * 静默时段,拿"随便哪一个"去判会让另一个任务的结果卡在里面出不来。
   */
  private async flushNotices(): Promise<void> {
    const spool = this.opts.notices;
    if (!spool) return;
    const now = this.now();
    for (const userKey of spool.users()) {
      const pending = spool.peek(userKey);
      // 还有任何一条仍在自己的静默窗口里,就整批再等等 —— 分两次发等于把
      // 「合并成一条」这件事本身破坏掉。
      const stillQuiet = pending.some((n) => {
        const job = this.opts.store.get(n.jobId);
        return job ? inQuietHours(job.notify.quiet, now, this.opts.tz) : false;
      });
      if (stillQuiet) continue;
      for (const text of mergeNotices(spool.take(userKey))) {
        await this.push(userKey, text, "announce");
      }
    }
  }
}
