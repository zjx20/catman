import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "../src/core/cron/store.js";
import type { CronJob, CronRun } from "../src/core/cron/types.js";

const dirs: string[] = [];
let clock = Date.parse("2026-08-13T10:00:00+08:00");

function make(): { store: CronStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "catman-cron-"));
  dirs.push(dir);
  return { store: new CronStore({ dir, now: () => clock }), dir };
}

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: "j_1",
    userKey: "wechat:a:u1",
    name: "备份",
    enabled: true,
    schedule: { kind: "every", ms: 3600_000 },
    task: { kind: "script", image: "catman-env:1", cmd: ["ls"], env: {}, network: "none", mounts: [], limits: { memory: "512m", cpus: 0.5, pids: 128 } },
    timeoutMs: 600_000,
    overlap: "skip",
    notify: { start: false, end: true, onlyFailure: false },
    keepRuns: 20,
    createdAt: clock,
    updatedAt: clock,
    failStreak: 0,
    ...over,
  };
}

function run(store: CronStore, jobId: string, at: number, over: Partial<CronRun> = {}): CronRun {
  const r: CronRun = {
    id: store.newRunId(at),
    jobId,
    userKey: "wechat:a:u1",
    startedAt: at,
    status: "ok",
    trigger: "schedule",
    ...over,
  };
  store.saveRun(r);
  return r;
}

test("任务的增删改查,以及重新打开还在", () => {
  const { store, dir } = make();
  store.put(job());
  store.put(job({ id: "j_2", userKey: "wechat:a:u2", name: "别人的" }));

  assert.equal(store.all().length, 2);
  assert.deepEqual(store.ofUser("wechat:a:u1").map((j) => j.id), ["j_1"]);
  assert.equal(store.get("j_1")?.name, "备份");

  store.patch("j_1", { enabled: false });
  assert.equal(store.get("j_1")?.enabled, false);
  assert.equal(store.patch("j_nope", { enabled: false }), undefined);

  const reopened = new CronStore({ dir, now: () => clock });
  assert.equal(reopened.all().length, 2);
  assert.equal(reopened.get("j_1")?.enabled, false);
});

test("删任务:执行记录与工作目录跟着一起走", () => {
  const { store } = make();
  store.put(job());
  const workDir = store.ensureWorkDir("j_1");
  writeFileSync(join(workDir, "state.txt"), "x", "utf8");
  run(store, "j_1", clock);
  assert.equal(store.listRuns("j_1").length, 1);

  assert.equal(store.remove("j_1"), true);
  assert.equal(store.remove("j_1"), false);
  assert.equal(store.listRuns("j_1").length, 0);
  assert.equal(existsSync(workDir), false);
});

test("认不出的任务被隔离而不是删掉 —— 回滚不能吃掉用户的任务", () => {
  const { store, dir } = make();
  store.put(job());
  // 模拟"新版本写的、本版本读不懂"的一条(比如将来某一期的 webhook 任务)。
  const path = join(dir, "jobs.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as { jobs: unknown[] };
  raw.jobs.push({ id: "j_future", userKey: "wechat:a:u1", name: "未来的", schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" }, task: { kind: "webhook", url: "https://example.com/hook" } });
  writeFileSync(path, JSON.stringify(raw), "utf8");

  const reopened = new CronStore({ dir, now: () => clock });
  assert.deepEqual(reopened.all().map((j) => j.id), ["j_1"], "认不出的不参与调度");
  // 写一次盘之后它必须还在 —— 这正是回滚安全的那条不变量。
  reopened.patch("j_1", { name: "改个名" });
  const after = JSON.parse(readFileSync(path, "utf8")) as { jobs: Array<{ id: string }> };
  assert.deepEqual(after.jobs.map((j) => j.id).sort(), ["j_1", "j_future"]);
});

test("任务表整个损坏时降级为空,不拖垮进程", () => {
  const { dir } = make();
  writeFileSync(join(dir, "jobs.json"), "{ 这不是 json", "utf8");
  const store = new CronStore({ dir, now: () => clock });
  assert.deepEqual(store.all(), []);
});

test("执行记录:新的在前,输出可读", () => {
  const { store } = make();
  store.put(job());
  const a = run(store, "j_1", clock - 2000);
  const b = run(store, "j_1", clock - 1000);
  store.writeLog("j_1", b.id, "hello\nworld\n");

  const list = store.listRuns("j_1");
  assert.deepEqual(list.map((r) => r.id), [b.id, a.id]);
  assert.equal(store.readLog("j_1", b.id), "hello\nworld\n");
  assert.equal(store.readLog("j_1", b.id, 6), "world\n", "只要尾巴时按字节截");
  assert.equal(store.readLog("j_1", a.id), "", "没有输出就是空串,不抛错");
  assert.equal(store.getRun("j_1", "../../etc/passwd"), undefined, "runId 要挡住路径穿越");
});

test("输出超上限时掐头留尾,并说明省了多少", () => {
  const { store } = make();
  store.put(job());
  const r = run(store, "j_1", clock);
  const bytes = store.writeLog("j_1", r.id, `HEAD${"x".repeat(400 * 1024)}TAIL`);
  assert.ok(bytes < 300 * 1024, `实际写入 ${bytes} 字节,应当被截断`);
  const log = store.readLog("j_1", r.id);
  assert.match(log, /^HEAD/);
  assert.match(log, /TAIL$/);
  assert.match(log, /中间省略 \d+ 字节/);
});

test("保留策略:按次数留最近的 N 条", () => {
  const { store } = make();
  store.put(job({ keepRuns: 3 }));
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) ids.push(run(store, "j_1", clock - (10 - i) * 60_000).id);
  store.writeLog("j_1", ids[0]!, "老日志");

  assert.equal(store.pruneRuns("j_1", 3), 7);
  assert.deepEqual(store.listRuns("j_1").map((r) => r.id), ids.slice(-3).reverse());
  assert.equal(store.readLog("j_1", ids[0]!), "", "记录删了,它的日志也要跟着删");
});

test("保留策略:太老的即便没超条数也清掉", () => {
  const { store, dir } = make();
  store.put(job({ keepRuns: 50 }));
  const old = run(store, "j_1", clock - 5000);
  const fresh = run(store, "j_1", clock);
  // 直接改文件 mtime:年龄看的是文件系统的事实,而不是 runId 里那串数字。
  const ancient = (clock - 200 * 24 * 3600_000) / 1000;
  utimesSync(join(dir, "runs", "j_1", `${old.id}.json`), ancient, ancient);

  assert.equal(store.pruneRuns("j_1", 50, 90 * 24 * 3600_000), 1);
  assert.deepEqual(store.listRuns("j_1").map((r) => r.id), [fresh.id]);
});

test("activeRuns 只捞还挂着 running 的那些", () => {
  const { store } = make();
  store.put(job());
  store.put(job({ id: "j_2" }));
  run(store, "j_1", clock - 3000, { status: "ok" });
  const live = run(store, "j_1", clock - 2000, { status: "running", container: "c1" });
  run(store, "j_2", clock - 1000, { status: "failed" });

  assert.deepEqual(store.activeRuns().map((r) => r.id), [live.id]);
});

test("runId 单调且不撞车", () => {
  const { store } = make();
  const a = store.newRunId(clock);
  const b = store.newRunId(clock);
  const later = store.newRunId(clock + 60_000);
  assert.notEqual(a, b, "同一秒内起两次(手动试跑)不能撞");
  assert.ok(later > a, "按文件名排序就是按时间排序");
  assert.match(a, /^\d{8}T\d{6}Z-[0-9a-f]{4}$/);
});

test("工作目录建得出来,而且落在 cron 目录下", () => {
  const { store, dir } = make();
  const p = store.ensureWorkDir("j_1");
  assert.equal(p, join(dir, "work", "j_1"));
  assert.ok(existsSync(p));
});

test("newJobId 不会撞上已有任务", () => {
  const { store } = make();
  const id = store.newJobId();
  store.put(job({ id }));
  assert.notEqual(store.newJobId(), id);
  assert.match(id, /^j_[0-9a-f]{8}$/);
});

test("读一个从来没有过的任务的记录不抛错", () => {
  const { store } = make();
  assert.deepEqual(store.listRuns("j_nobody"), []);
  assert.equal(store.getRun("j_nobody", "20260813T100000Z-abcd"), undefined);
  assert.equal(store.pruneRuns("j_nobody", 5), 0);
  // 目录存在但里面是垃圾文件也不该炸
  mkdirSync(join(make().dir, "runs", "j_x"), { recursive: true });
});
