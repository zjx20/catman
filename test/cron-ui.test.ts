import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCronDetail, renderCronList, type CronJobRow } from "../src/dashboard/ui-cron.js";
import { handleCronAdminApi, isCronAdminApiPath } from "../src/dashboard/api-cron-admin.js";
import { CronStore } from "../src/core/cron/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CronJob, CronRun } from "../src/core/cron/types.js";

const SH = "Asia/Shanghai";
const T0 = Date.parse("2026-08-13T10:00:00+08:00");
const dirs: string[] = [];

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function job(over: Partial<CronJob> = {}): CronJob {
  return {
    id: "j_1",
    userKey: "wechat:a:u1",
    name: "每天早八看磁盘",
    enabled: true,
    schedule: { kind: "every", ms: 3600_000 },
    task: {
      kind: "script",
      image: "catman-env:1",
      cmd: ["bash", "-lc", "df -h /"],
      env: {},
      network: "none",
      mounts: [],
      limits: { memory: "512m", cpus: 0.5, pids: 128 },
    },
    timeoutMs: 600_000,
    overlap: "skip",
    notify: { start: false, end: true, onlyFailure: false },
    keepRuns: 20,
    createdAt: T0,
    updatedAt: T0,
    nextAt: T0 + 3600_000,
    failStreak: 0,
    ...over,
  };
}

const row = (over: Partial<CronJob> = {}): CronJobRow => ({ job: job(over), owner: "老王" });

const list = (rows: CronJobRow[], enabled = true): string =>
  renderCronList({ rows, tz: SH, enabled, token: "tk" });

// ── 列表页 ────────────────────────────────────────────────────────

test("列表页:一眼看得到名字、周期、下次触发、归属", () => {
  const html = list([row()]);
  assert.match(html, /每天早八看磁盘/);
  assert.match(html, /每 1 小时/);
  assert.match(html, /下次 08-13 11:00/);
  assert.match(html, /老王/);
  assert.match(html, /href="\/cron\/j_1"/);
});

test("列表页:导航里有定时任务这一项(它是唯一入口)", () => {
  assert.match(list([]), /<a href="\/cron">定时任务<\/a>/);
});

test("列表页:空的时候告诉人怎么建,而不是干瞪眼", () => {
  assert.match(list([]), /跟助手说一句/);
});

test("列表页:总开关关掉时必须说清楚 —— 否则「为什么都不跑」要查很久", () => {
  assert.match(list([row()], false), /总开关是关的/);
  assert.doesNotMatch(list([row()], true), /总开关是关的/);
});

test("列表页:危险的那几项标出来 —— 出事时最先要查的就是它们", () => {
  const rw = row({
    task: {
      kind: "script",
      image: "catman-env:1",
      cmd: ["bash", "-lc", "rsync -a /svc /backup"],
      env: {},
      network: "mynet",
      mounts: [
        { host: "/opt/services/x", at: "/x", ro: false },
        { host: "/opt/services/y", at: "/y", ro: true },
      ],
      limits: { memory: "512m", cpus: 0.5, pids: 128 },
    },
  });
  const html = list([rw]);
  assert.match(html, /可写挂载 \/opt\/services\/x/);
  assert.match(html, /只读挂载 1 条/);
  assert.match(html, /联网 mynet/);
});

test("列表页:停用与连续失败都看得见", () => {
  const html = list([row({ enabled: false, nextAt: undefined, failStreak: 3, lastStatus: "failed" })]);
  assert.match(html, /已停用/);
  assert.match(html, /连续失败 3 次/);
  assert.match(html, /失败/);
  assert.match(html, /data-toggle="j_1" data-to="1"/, "停用的任务给的是「启用」按钮");
});

test("列表页:agent 任务显示那句话,而不是命令", () => {
  const html = list([
    row({ task: { kind: "agent", prompt: "看看有没有异常,变化了才说", session: "chain", maxTurns: 20 } }),
  ]);
  assert.match(html, /🧠 agent/);
  assert.match(html, /看看有没有异常/);
});

test("XSS:任务名、命令、归属都转义 —— 它们全是用户可控的", () => {
  const evil = row({
    name: `<script>alert(1)</script>`,
    task: {
      kind: "script",
      image: "catman-env:1",
      cmd: ["bash", "-lc", `echo "<img src=x onerror=alert(2)>"`],
      env: {},
      network: "none",
      mounts: [],
      limits: { memory: "512m", cpus: 0.5, pids: 128 },
    },
  });
  const html = renderCronList({
    rows: [{ ...evil, owner: `<b>坏名字</b>` }],
    tz: SH,
    enabled: true,
    token: "tk",
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>坏名字<\/b>/);
  assert.match(html, /&lt;script&gt;/);
});

// ── 详情页 ────────────────────────────────────────────────────────

function run(over: Partial<CronRun> = {}): CronRun {
  return {
    id: "20260813T020000Z-aaaa",
    jobId: "j_1",
    userKey: "wechat:a:u1",
    startedAt: T0,
    endedAt: T0 + 5000,
    status: "ok",
    trigger: "schedule",
    exitCode: 0,
    logBytes: 12,
    ...over,
  };
}

test("详情页:配置、执行记录、耗时与退出码", () => {
  const html = renderCronDetail({ row: row(), runs: [run()], tz: SH, token: "tk" });
  assert.match(html, /df -h \//);
  assert.match(html, /镜像 catman-env:1/);
  assert.match(html, /超时 10 分钟/);
  assert.match(html, /5 秒/);
  assert.match(html, /退出码 0/);
  assert.match(html, /最近 1 次执行/);
});

test("详情页:失败那次标红并带上原因", () => {
  const html = renderCronDetail({
    row: row(),
    runs: [run({ status: "timeout", note: "超过 10 分钟没跑完", exitCode: undefined })],
    tz: SH,
    token: "tk",
  });
  assert.match(html, /class="blk bad"/);
  assert.match(html, /超过 10 分钟没跑完/);
});

test("详情页:输出不塞进页面,按需拉 —— 几百 KB 会把页面拖垮", () => {
  const html = renderCronDetail({ row: row(), runs: [run()], tz: SH, token: "tk" });
  assert.match(html, /data-log="20260813T020000Z-aaaa"/);
  assert.match(html, /点开加载/);
  assert.match(html, /api\/admin\/cron\/j_1\/runs/);
});

test("详情页:agent 任务展示 prompt 与会话模式", () => {
  const html = renderCronDetail({
    row: row({ task: { kind: "agent", prompt: "巡检一下", session: "chain", maxTurns: 5 } }),
    runs: [],
    tz: SH,
    token: "tk",
  });
  assert.match(html, /巡检一下/);
  assert.match(html, /续上一次/);
  assert.match(html, /最多 5 轮/);
});

test("详情页:通知策略说人话", () => {
  const html = renderCronDetail({
    row: row({ notify: { start: true, end: true, onlyFailure: true, quiet: "23:00-08:00" } }),
    runs: [],
    tz: SH,
    token: "tk",
  });
  assert.match(html, /开跑 \/ 只在失败时 \/ 静默 23:00-08:00/);
});

// ── 管理员接口 ────────────────────────────────────────────────────

function adminSetup(): { store: CronStore; ran: string[]; call: (m: string, p: string, b?: unknown) => Promise<{ status: number; body: any }> } {
  const dir = mkdtempSync(join(tmpdir(), "catman-cronadmin-"));
  dirs.push(dir);
  const store = new CronStore({ dir, now: () => T0 });
  store.put(job());
  store.put(job({ id: "j_2", userKey: "wechat:a:u2", name: "别人的" }));
  const ran: string[] = [];
  const deps = {
    store,
    scheduler: {
      async runNow(jobId: string): Promise<CronRun | { error: string }> {
        ran.push(jobId);
        return run({ jobId });
      },
    },
  };
  return {
    store,
    ran,
    call: (m, p, b) => handleCronAdminApi(m, p, b, deps) as Promise<{ status: number; body: any }>,
  };
}

test("管理员接口:认领自己的路径,看得到所有人的任务", async () => {
  assert.equal(isCronAdminApiPath("/api/admin/cron"), true);
  assert.equal(isCronAdminApiPath("/api/admin/cron/j_1/run"), true);
  assert.equal(isCronAdminApiPath("/api/me/cron"), false);

  const s = adminSetup();
  const r = await s.call("GET", "/api/admin/cron");
  assert.equal(r.body.jobs.length, 2, "管理员视角是全站的,与 /api/me/cron 刻意不同");
});

test("管理员接口:启停,而且停用时把排期一起清掉", async () => {
  const s = adminSetup();
  const r = await s.call("PATCH", "/api/admin/cron/j_1", { enabled: false });
  assert.equal(r.status, 200);
  assert.equal(s.store.get("j_1")!.enabled, false);
  assert.equal(s.store.get("j_1")!.nextAt, undefined);

  await s.call("PATCH", "/api/admin/cron/j_1", { enabled: true });
  assert.equal(s.store.get("j_1")!.enabled, true);
});

test("管理员接口:只让改 enabled —— 别的改动必须走有完整校验的那条路", async () => {
  const s = adminSetup();
  const r = await s.call("PATCH", "/api/admin/cron/j_1", { schedule: { kind: "every", minutes: 1 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /只能改 enabled/);
  assert.equal((s.store.get("j_1")!.schedule as { ms: number }).ms, 3600_000, "没被改坏");
});

test("管理员接口:试跑与看输出", async () => {
  const s = adminSetup();
  const r = await s.call("POST", "/api/admin/cron/j_1/run");
  assert.equal(r.status, 200);
  assert.deepEqual(s.ran, ["j_1"]);

  const runId = s.store.newRunId(T0);
  s.store.saveRun(run({ id: runId }));
  s.store.writeLog("j_1", runId, "输出在这儿");
  const got = await s.call("GET", `/api/admin/cron/j_1/runs/${runId}`);
  assert.equal(got.body.log, "输出在这儿");

  assert.equal((await s.call("GET", "/api/admin/cron/j_1/runs/20200101T000000Z-ffff")).status, 404);
  assert.equal((await s.call("PATCH", "/api/admin/cron/j_nope", { enabled: false })).status, 404);
});
