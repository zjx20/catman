import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "../src/core/cron/store.js";
import { CronScheduler, type CronRuntime, type NotifyKind } from "../src/core/cron/scheduler.js";
import type { LaunchSpec, PollResult, ScriptRunner } from "../src/core/cron/docker.js";
import type { CronJob } from "../src/core/cron/types.js";

const dirs: string[] = [];
const SH = "Asia/Shanghai";
const T0 = Date.parse("2026-08-13T10:00:00+08:00");

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** 假的执行面。容器的生死由用例说了算,于是每条时序都测得动。 */
class FakeRunner implements ScriptRunner {
  readonly launched: LaunchSpec[] = [];
  readonly stopped: string[] = [];
  readonly removed: string[] = [];
  private readonly state = new Map<string, PollResult>();
  private readonly out = new Map<string, string>();
  launchError?: string;

  async launch(spec: LaunchSpec): Promise<{ ok: true } | { ok: false; error: string }> {
    this.launched.push(spec);
    if (this.launchError) return { ok: false, error: this.launchError };
    this.state.set(spec.container, { state: "running" });
    return { ok: true };
  }
  async poll(container: string): Promise<PollResult> {
    return this.state.get(container) ?? { state: "gone" };
  }
  async logs(container: string): Promise<string> {
    return this.out.get(container) ?? "";
  }
  async stop(container: string): Promise<void> {
    this.stopped.push(container);
    this.state.set(container, { state: "exited", exitCode: 137 });
  }
  async remove(container: string): Promise<void> {
    this.removed.push(container);
    this.state.delete(container);
  }
  /** 让最后起的那个容器结束。 */
  finish(exitCode: number, output = ""): string {
    const c = this.launched[this.launched.length - 1]!.container;
    this.state.set(c, { state: "exited", exitCode });
    this.out.set(c, output);
    return c;
  }
  vanish(): void {
    this.state.delete(this.launched[this.launched.length - 1]!.container);
  }
}

interface Harness {
  store: CronStore;
  runner: FakeRunner;
  sched: CronScheduler;
  notes: Array<{ text: string; kind: NotifyKind }>;
  now: () => number;
  set: (t: number) => void;
  add: (over?: Partial<CronJob>) => CronJob;
}

function harness(runtime: Partial<CronRuntime> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "catman-sched-"));
  dirs.push(dir);
  let clock = T0;
  const store = new CronStore({ dir, hostDir: "/mnt/usb/catman_data/cron", now: () => clock });
  const runner = new FakeRunner();
  const notes: Array<{ text: string; kind: NotifyKind }> = [];
  const sched = new CronScheduler({
    store,
    runner,
    runtime: () => ({
      enabled: true,
      maxConcurrent: 1,
      catchUpMs: 15 * 60_000,
      runMaxAgeMs: 90 * 24 * 3600_000,
      ...runtime,
    }),
    tz: SH,
    notify: async (_userKey, text, kind) => {
      notes.push({ text, kind });
    },
    now: () => clock,
    tickMs: 30_000,
  });
  let n = 0;
  const add = (over: Partial<CronJob> = {}): CronJob => {
    const job: CronJob = {
      id: `j_${++n}`,
      userKey: "wechat:a:u1",
      name: `任务${n}`,
      enabled: true,
      schedule: { kind: "every", ms: 3600_000 },
      task: {
        kind: "script",
        image: "catman-env:1",
        cmd: ["bash", "-lc", "df -h /"],
        env: { FOO: "bar" },
        network: "none",
        mounts: [],
        limits: { memory: "512m", cpus: 0.5, pids: 128 },
      },
      timeoutMs: 600_000,
      overlap: "skip",
      notify: { start: false, end: true, onlyFailure: false },
      keepRuns: 20,
      createdAt: clock,
      updatedAt: clock,
      nextAt: clock - 1000,
      failStreak: 0,
      ...over,
    };
    return store.put(job);
  };
  return { store, runner, sched, notes, now: () => clock, set: (t) => (clock = t), add };
}

test("到点就起容器,而且隔离参数一个不少", async () => {
  const h = harness();
  h.add();
  await h.sched.tick();

  assert.equal(h.runner.launched.length, 1);
  const spec = h.runner.launched[0]!;
  assert.equal(spec.network, "none");
  assert.deepEqual(spec.limits, { memory: "512m", cpus: 0.5, pids: 128 });
  // 工作目录必须换算成**宿主**路径 —— 传容器内路径进去,dockerd 会静默建个空目录。
  assert.equal(spec.hostWorkDir, "/mnt/usb/catman_data/cron/work/j_1");
  assert.match(spec.container, /^catman-cron-j_1-/);
  // 记录先落盘再起容器:反过来会留下没人认领的容器。
  assert.equal(h.store.listRuns("j_1")[0]?.status, "running");
  // 排期已经推到下一档了,不会同一档点两次火。
  assert.equal(h.store.get("j_1")!.nextAt, h.now() + 3600_000);
});

test("跑完:记录 ok、输出存盘、通知带下次触发时刻", async () => {
  const h = harness();
  h.add();
  await h.sched.tick();
  h.runner.finish(0, "根分区 62%\n");
  h.set(T0 + 38_000);
  await h.sched.tick();

  const run = h.store.listRuns("j_1")[0]!;
  assert.equal(run.status, "ok");
  assert.equal(run.exitCode, 0);
  assert.equal(run.endedAt, T0 + 38_000);
  assert.equal(h.store.readLog("j_1", run.id), "根分区 62%\n");
  assert.equal(h.runner.removed.length, 1, "收完尸要把容器删掉");

  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.kind, "announce");
  assert.match(h.notes[0]!.text, /✅.*跑完了/);
  assert.match(h.notes[0]!.text, /根分区 62%/);
  assert.match(h.notes[0]!.text, /下次:08-13 11:00/);
});

test("失败:退出码进记录也进通知", async () => {
  const h = harness();
  h.add();
  await h.sched.tick();
  h.runner.finish(1, "tar: 没有这个文件");
  await h.sched.tick();

  assert.equal(h.store.listRuns("j_1")[0]!.status, "failed");
  assert.match(h.notes[0]!.text, /❌.*失败了.*退出码 1/s);
  assert.match(h.notes[0]!.text, /tar: 没有这个文件/);
  assert.equal(h.store.get("j_1")!.failStreak, 1);
});

test("超时:到点把容器停掉并记 timeout", async () => {
  const h = harness();
  h.add({ timeoutMs: 60_000 });
  await h.sched.tick();
  h.set(T0 + 61_000);
  await h.sched.tick();

  assert.equal(h.runner.stopped.length, 1);
  const run = h.store.listRuns("j_1")[0]!;
  assert.equal(run.status, "timeout");
  assert.match(h.notes[0]!.text, /⏱.*超时被中止/);
});

test("容器不见了(宿主重启过)记 interrupted,而不是永远挂着 running", async () => {
  const h = harness();
  h.add();
  await h.sched.tick();
  h.runner.vanish();
  await h.sched.tick();

  assert.equal(h.store.listRuns("j_1")[0]!.status, "interrupted");
  assert.equal(h.store.activeRuns().length, 0);
});

test("重启之后接着收上一轮的结果 —— 认领走的是同一条路径", async () => {
  const h = harness();
  h.add();
  await h.sched.tick();
  h.runner.finish(0, "跨重启也收得到");

  // 换一个 scheduler 实例(等价于进程被部署换掉),盘上状态原样。
  const reborn = new CronScheduler({
    store: h.store,
    runner: h.runner,
    runtime: () => ({ enabled: true, maxConcurrent: 1, catchUpMs: 15 * 60_000, runMaxAgeMs: 1e12 }),
    tz: SH,
    notify: async (_u, text, kind) => {
      h.notes.push({ text, kind });
    },
    now: h.now,
  });
  await reborn.tick();

  assert.equal(h.store.listRuns("j_1")[0]!.status, "ok");
  assert.match(h.notes[0]!.text, /跨重启也收得到/);
});

test("overlap=skip:上一轮还在跑就记一条 skipped,不再起容器", async () => {
  const h = harness();
  h.add({ schedule: { kind: "every", ms: 600_000 }, timeoutMs: 600_000 });
  await h.sched.tick();
  h.set(T0 + 600_000);
  await h.sched.tick();

  assert.equal(h.runner.launched.length, 1, "不能起第二个容器");
  const runs = h.store.listRuns("j_1");
  assert.equal(runs[0]!.status, "skipped");
  assert.match(runs[0]!.note ?? "", /上一轮还在跑/);
  assert.equal(h.notes.length, 0, "跳过不值得单独推一条 —— 记录里查得到");
});

test("overlap=replace:先把上一轮顶掉再跑新的", async () => {
  const h = harness();
  h.add({ overlap: "replace", schedule: { kind: "every", ms: 600_000 } });
  await h.sched.tick();
  h.set(T0 + 600_000);
  await h.sched.tick();

  assert.equal(h.runner.launched.length, 2);
  assert.equal(h.runner.stopped.length, 1);
  const runs = h.store.listRuns("j_1");
  assert.equal(runs[0]!.status, "running");
  assert.equal(runs[1]!.status, "interrupted");
  assert.match(runs[1]!.note ?? "", /被新的一轮顶掉/);
});

test("并发满了就等下一轮 tick,而且**不推进排期**", async () => {
  const h = harness({ maxConcurrent: 1 });
  h.add();
  h.add();
  await h.sched.tick();
  assert.equal(h.runner.launched.length, 1);
  const waiting = h.store.get("j_2")!;
  assert.ok(waiting.nextAt! <= h.now(), "还欠着这一次,排期不能往前推");

  h.runner.finish(0);
  await h.sched.tick(); // 收上一个 + 点第二个
  assert.equal(h.runner.launched.length, 2);
});

test("错过太久:不补跑,直接推到下一档并记一行", async () => {
  const h = harness({ catchUpMs: 15 * 60_000 });
  h.add({ nextAt: T0 - 3 * 3600_000 });
  await h.sched.tick();

  assert.equal(h.runner.launched.length, 0);
  assert.equal(h.store.get("j_1")!.nextAt, T0 + 3600_000);
  assert.equal(h.store.listRuns("j_1").length, 0);
});

test("错过但在窗口内:补跑一次,记成 catchup", async () => {
  const h = harness({ catchUpMs: 15 * 60_000 });
  h.add({ nextAt: T0 - 10 * 60_000 });
  await h.sched.tick();

  assert.equal(h.runner.launched.length, 1);
  assert.equal(h.store.listRuns("j_1")[0]!.trigger, "catchup");
});

test("总开关关掉:一个都不跑,而且排期不丢", async () => {
  const h = harness({ enabled: false });
  const job = h.add();
  await h.sched.tick();
  assert.equal(h.runner.launched.length, 0);
  assert.equal(h.store.get("j_1")!.nextAt, job.nextAt, "关掉不等于把排期作废");
});

test("一次性任务跑完就停用,通知里如实说不再触发", async () => {
  const h = harness();
  h.add({ schedule: { kind: "once", at: T0 - 1000 } });
  await h.sched.tick();
  h.runner.finish(0, "done");
  await h.sched.tick();

  const job = h.store.get("j_1")!;
  assert.equal(job.enabled, false);
  assert.equal(job.nextAt, undefined);
  assert.match(h.notes[0]!.text, /不再触发/);
});

test("连续失败 3 次自动停用,并且明说停了", async () => {
  const h = harness();
  h.add();
  for (let i = 0; i < 3; i++) {
    h.set(T0 + i * 3600_000);
    h.store.patch("j_1", { nextAt: h.now() - 1000, enabled: true });
    await h.sched.tick();
    h.runner.finish(2, "又炸了");
    await h.sched.tick();
  }
  const job = h.store.get("j_1")!;
  assert.equal(job.failStreak, 3);
  assert.equal(job.enabled, false);
  assert.ok(h.notes.some((n) => /停用了/.test(n.text)), "得有一条说清楚为什么不跑了");
});

test("成功一次就把失败计数清零", async () => {
  const h = harness();
  h.add({ failStreak: 2 });
  await h.sched.tick();
  h.runner.finish(0);
  await h.sched.tick();
  assert.equal(h.store.get("j_1")!.failStreak, 0);
  assert.equal(h.store.get("j_1")!.enabled, true);
});

test("通知开关:开跑那条走 reminder,onlyFailure 时成功不吭声", async () => {
  const h = harness();
  h.add({ notify: { start: true, end: true, onlyFailure: false } });
  await h.sched.tick();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.kind, "reminder");
  assert.match(h.notes[0]!.text, /开始跑了/);

  const h2 = harness();
  h2.add({ notify: { start: false, end: true, onlyFailure: true } });
  await h2.sched.tick();
  h2.runner.finish(0, "一切正常");
  await h2.sched.tick();
  assert.equal(h2.notes.length, 0, "成功就该闭嘴");

  const h3 = harness();
  h3.add({ notify: { start: false, end: false, onlyFailure: false } });
  await h3.sched.tick();
  h3.runner.finish(1);
  await h3.sched.tick();
  assert.equal(h3.notes.length, 0, "关掉 end 就一条都不推");
});

test("容器起不来:记 error 并把 docker 的原话带给用户", async () => {
  const h = harness();
  h.add();
  h.runner.launchError = "Unable to find image 'nope:1' locally";
  await h.sched.tick();

  const run = h.store.listRuns("j_1")[0]!;
  assert.equal(run.status, "error");
  assert.match(run.note ?? "", /Unable to find image/);
  assert.match(h.notes[0]!.text, /压根没起来/);
});

test("没配宿主 /data 路径:记 error,而不是挂一个永远收不了的 running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-sched-"));
  dirs.push(dir);
  let clock = T0;
  // **刻意不给 hostDir** —— 这正是这条用例要测的处境。
  const store = new CronStore({ dir, now: () => clock });
  const runner = new FakeRunner();
  const sched = new CronScheduler({
    store,
    runner,
    runtime: () => ({ enabled: true, maxConcurrent: 1, catchUpMs: 900_000, runMaxAgeMs: 1e12 }),
    tz: SH,
    now: () => clock,
  });
  store.put({
    id: "j_1", userKey: "wechat:a:u1", name: "x", enabled: true,
    schedule: { kind: "every", ms: 3600_000 },
    task: { kind: "script", image: "catman-env:1", cmd: ["ls"], env: {}, network: "none", mounts: [], limits: { memory: "512m", cpus: 0.5, pids: 128 } },
    timeoutMs: 600_000, overlap: "skip", notify: { start: false, end: true, onlyFailure: false },
    keepRuns: 20, createdAt: clock, updatedAt: clock, nextAt: clock - 1, failStreak: 0,
  });
  await sched.tick();
  assert.equal(runner.launched.length, 0);
  assert.equal(store.listRuns("j_1")[0]!.status, "error");
});

test("手动试跑:立刻跑,但**不动排期**", async () => {
  const h = harness();
  const job = h.add({ nextAt: T0 + 3600_000 });
  const r = await h.sched.runNow("j_1");
  assert.ok(!("error" in r));
  assert.equal(h.runner.launched.length, 1);
  assert.equal(h.store.get("j_1")!.nextAt, job.nextAt, "试跑不该顶掉下一次");
  assert.equal(h.store.listRuns("j_1")[0]!.trigger, "manual");

  assert.deepEqual(await h.sched.runNow("j_nope"), { error: "任务不存在" });
});

test("停用的任务也能手动试跑 —— 那正是修好之后要做的事", async () => {
  const h = harness();
  h.add({ enabled: false, nextAt: undefined });
  const r = await h.sched.runNow("j_1");
  assert.ok(!("error" in r));
  assert.equal(h.runner.launched.length, 1);
});

test("执行记录按每任务的 keepRuns 修剪", async () => {
  const h = harness();
  h.add({ keepRuns: 2, schedule: { kind: "every", ms: 60_000 }, timeoutMs: 60_000 });
  for (let i = 0; i < 4; i++) {
    h.set(T0 + i * 60_000);
    h.store.patch("j_1", { nextAt: h.now() - 1 });
    await h.sched.tick();
    h.runner.finish(0);
    await h.sched.tick();
  }
  assert.equal(h.store.listRuns("j_1", 50).length, 2);
});

test("start() 给缺 nextAt 的任务补算一次", async () => {
  const h = harness();
  h.add({ nextAt: undefined });
  h.sched.start();
  h.sched.stop();
  assert.equal(h.store.get("j_1")!.nextAt, T0 + 3600_000);
});

test("tick 不会因为通知抛错就死掉", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-sched-"));
  dirs.push(dir);
  const clock = T0;
  const store = new CronStore({ dir, hostDir: "/mnt/usb/catman_data/cron", now: () => clock });
  const runner = new FakeRunner();
  const sched = new CronScheduler({
    store,
    runner,
    runtime: () => ({ enabled: true, maxConcurrent: 1, catchUpMs: 900_000, runMaxAgeMs: 1e12 }),
    tz: SH,
    notify: async () => {
      throw new Error("渠道没起来");
    },
    now: () => clock,
  });
  store.put({
    id: "j_1", userKey: "wechat:a:u1", name: "x", enabled: true,
    schedule: { kind: "every", ms: 3600_000 },
    task: { kind: "script", image: "i", cmd: ["ls"], env: {}, network: "none", mounts: [], limits: { memory: "512m", cpus: 0.5, pids: 128 } },
    timeoutMs: 600_000, overlap: "skip", notify: { start: true, end: true, onlyFailure: false },
    keepRuns: 20, createdAt: clock, updatedAt: clock, nextAt: clock - 1, failStreak: 0,
  });
  await sched.tick();
  runner.finish(0);
  await sched.tick();
  assert.equal(store.listRuns("j_1")[0]!.status, "ok", "通知发不出去不影响执行本身");
});

test("删任务前先把在飞的那一轮停掉,并记成 interrupted", async () => {
  const h = harness();
  h.add();
  await h.sched.tick();
  const container = h.runner.launched[0]!.container;

  await h.sched.cancelJob("j_1");

  assert.deepEqual(h.runner.stopped, [container]);
  assert.deepEqual(h.runner.removed, [container]);
  assert.equal(h.store.listRuns("j_1")[0]!.status, "interrupted");
  assert.match(h.store.listRuns("j_1")[0]!.note ?? "", /任务被删掉了/);
  // 用户刚亲手删的,再推一条"被中断了"只会让人以为出了岔子。
  assert.equal(h.notes.length, 0);
});

test("开机扫一次孤儿容器,活着的那些一个都不能碰", async () => {
  const h = harness();
  h.add();
  await h.sched.tick(); // 起一个,它是活的
  const alive = h.runner.launched[0]!.container;
  const seen: Array<ReadonlySet<string>> = [];
  (h.runner as unknown as { reapOrphans: (a: ReadonlySet<string>) => Promise<number> }).reapOrphans =
    async (a) => {
      seen.push(a);
      return 2;
    };

  h.sched.start();
  h.sched.stop();
  // start() 里的扫描是异步的,让出一轮事件循环等它跑完。
  await new Promise((r) => setImmediate(r));

  assert.equal(seen.length, 1, "只在开机扫一次 —— 它要花一次 docker ps");
  assert.ok(seen[0]!.has(alive), "还在跑的那个必须在'活着'名单里,否则刚起就被自己杀掉");
});

test("没有 reapOrphans 的执行面(测试替身)照样能启动", async () => {
  const h = harness();
  h.add();
  h.sched.start();
  h.sched.stop();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.store.get("j_1")!.nextAt !== undefined, true);
});
