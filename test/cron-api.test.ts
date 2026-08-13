import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "../src/core/cron/store.js";
import { handleCronApi, isCronApiPath, type CronApiDeps } from "../src/dashboard/api-cron.js";
import { TurnTokens } from "../src/core/turn-tokens.js";
import type { CronRun } from "../src/core/cron/types.js";

const dirs: string[] = [];
const T0 = Date.parse("2026-08-13T10:00:00+08:00");
const ME = "wechat:a:u1";
const OTHER = "wechat:a:u2";

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Setup {
  deps: CronApiDeps;
  store: CronStore;
  token: string;
  otherToken: string;
  ran: string[];
  cancelled: string[];
  call: (method: string, path: string, body?: unknown, token?: string) => Promise<{ status: number; body: any }>;
}

function setup(opts: { scheduler?: boolean } = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), "catman-cronapi-"));
  dirs.push(dir);
  const store = new CronStore({ dir, hostDir: "/host/cron", now: () => T0 });
  const turns = new TurnTokens();
  const token = turns.mint(ME).token;
  const otherToken = turns.mint(OTHER).token;
  const ran: string[] = [];
  const cancelled: string[] = [];
  const deps: CronApiDeps = {
    turns,
    store,
    ...(opts.scheduler === false
      ? {}
      : {
          scheduler: {
            async cancelJob(jobId: string): Promise<void> {
              cancelled.push(jobId);
            },
            async runNow(jobId: string): Promise<CronRun | { error: string }> {
              ran.push(jobId);
              return {
                id: "20260813T020000Z-aaaa",
                jobId,
                userKey: ME,
                startedAt: T0,
                status: "running",
                trigger: "manual",
              };
            },
          },
        }),
    validateContext: () => ({
      defaultTz: "Asia/Shanghai",
      minIntervalMs: 5 * 60_000,
      defaultKeepRuns: 20,
      mountAllowlist: ["/opt/services"],
      hostDataDir: "/host",
      now: T0,
    }),
    tz: "Asia/Shanghai",
    now: () => T0,
  };
  const call = (method: string, path: string, body?: unknown, tok: string = token) =>
    handleCronApi(method, path, tok, body, deps) as Promise<{ status: number; body: any }>;
  return { deps, store, token, otherToken, ran, cancelled, call };
}

const NEW_JOB = {
  name: "每天早八看磁盘",
  schedule: { kind: "cron", expr: "0 8 * * *" },
  task: { cmd: ["bash", "-lc", "df -h /"] },
};

test("路径认领:只认 /api/me/cron 这一支", () => {
  assert.equal(isCronApiPath("/api/me/cron"), true);
  assert.equal(isCronApiPath("/api/me/cron/j_1/runs"), true);
  assert.equal(isCronApiPath("/api/me"), false);
  assert.equal(isCronApiPath("/api/me/sessions"), false);
  assert.equal(isCronApiPath("/api/cron"), false);
});

test("没有回合令牌一律 401", async () => {
  const s = setup();
  const r = await handleCronApi("GET", "/api/me/cron", undefined, undefined, s.deps);
  assert.equal(r.status, 401);
  const r2 = await handleCronApi("GET", "/api/me/cron", "瞎编的", undefined, s.deps);
  assert.equal(r2.status, 401);
});

test("建 → 查 → 改 → 删 的一条龙", async () => {
  const s = setup();
  const created = await s.call("POST", "/api/me/cron", NEW_JOB);
  assert.equal(created.status, 201);
  const id = created.body.id as string;
  assert.equal(created.body.enabled, true);
  assert.equal(created.body.nextAtText, "08-14 08:00 周五");
  assert.equal(created.body.timeoutMinutes, 10);
  assert.match(created.body.scheduleText, /0 8 \* \* \*/);

  const list = await s.call("GET", "/api/me/cron");
  assert.equal(list.body.jobs.length, 1);

  const patched = await s.call("PATCH", `/api/me/cron/${id}`, { enabled: false });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.enabled, false);
  assert.equal(patched.body.nextAt, undefined, "停用要把排期一起清掉");
  assert.equal(patched.body.nextAtText, "已停用");

  const removed = await s.call("DELETE", `/api/me/cron/${id}`);
  assert.equal(removed.status, 200);
  // 删之前必须先把在飞的那一轮停掉 —— 记录一删,那个容器就再也没人认领得了。
  assert.deepEqual(s.cancelled, [id]);
  assert.equal((await s.call("GET", "/api/me/cron")).body.jobs.length, 0);
  assert.equal((await s.call("GET", `/api/me/cron/${id}`)).status, 404);
});

test("别人的任务:连存在都看不出来(404 而不是 403)", async () => {
  const s = setup();
  const mine = (await s.call("POST", "/api/me/cron", NEW_JOB)).body.id as string;

  for (const [method, path] of [
    ["GET", `/api/me/cron/${mine}`],
    ["PATCH", `/api/me/cron/${mine}`],
    ["DELETE", `/api/me/cron/${mine}`],
    ["POST", `/api/me/cron/${mine}/run`],
    ["GET", `/api/me/cron/${mine}/runs`],
  ] as const) {
    const r = await s.call(method, path, {}, s.otherToken);
    assert.equal(r.status, 404, `${method} ${path} 对别人必须是 404`);
  }
  // 列表里也不该出现别人的
  assert.deepEqual((await s.call("GET", "/api/me/cron", undefined, s.otherToken)).body.jobs, []);
  assert.equal(s.store.get(mine)?.userKey, ME, "别人碰不掉它");
});

test("校验失败回 400,而且文案就是能念给用户听的那句", async () => {
  const s = setup();
  const bad = await s.call("POST", "/api/me/cron", { ...NEW_JOB, timeoutMinute: 30 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /不认识的字段 "timeoutMinute"/);

  const dense = await s.call("POST", "/api/me/cron", {
    ...NEW_JOB,
    schedule: { kind: "cron", expr: "* * * * *" },
  });
  assert.equal(dense.status, 400);
  assert.match(dense.body.error, /最快 1 分钟/);

  // 一条都没存进去
  assert.deepEqual((await s.call("GET", "/api/me/cron")).body.jobs, []);
});

test("PATCH 的补丁同样过整体校验", async () => {
  const s = setup();
  const id = (await s.call("POST", "/api/me/cron", NEW_JOB)).body.id as string;
  const r = await s.call("PATCH", `/api/me/cron/${id}`, { schedule: { kind: "every", minutes: 1 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /最快 1 分钟/);
  // 失败的 PATCH 不能改坏盘上的任务
  assert.equal(s.store.get(id)!.schedule.kind, "cron");
});

test("改周期会重算下次触发", async () => {
  const s = setup();
  const id = (await s.call("POST", "/api/me/cron", NEW_JOB)).body.id as string;
  const r = await s.call("PATCH", `/api/me/cron/${id}`, {
    schedule: { kind: "cron", expr: "0 20 * * *" },
  });
  assert.equal(r.body.nextAt, Date.parse("2026-08-13T20:00:00+08:00"));
});

test("试跑:不动排期,并明说这是异步的", async () => {
  const s = setup();
  const id = (await s.call("POST", "/api/me/cron", NEW_JOB)).body.id as string;
  const before = s.store.get(id)!.nextAt;

  const r = await s.call("POST", `/api/me/cron/${id}/run`);
  assert.equal(r.status, 200);
  assert.deepEqual(s.ran, [id]);
  assert.equal(s.store.get(id)!.nextAt, before);
  assert.match(r.body.note, /不等它跑完/);
});

test("没有调度器时试跑回 503,而不是假装成功", async () => {
  const s = setup({ scheduler: false });
  const id = (await s.call("POST", "/api/me/cron", NEW_JOB)).body.id as string;
  const r = await s.call("POST", `/api/me/cron/${id}/run`);
  assert.equal(r.status, 503);
});

test("执行记录:列表与单条(带完整输出)", async () => {
  const s = setup();
  const id = (await s.call("POST", "/api/me/cron", NEW_JOB)).body.id as string;
  const runId = s.store.newRunId(T0);
  s.store.saveRun({
    id: runId,
    jobId: id,
    userKey: ME,
    startedAt: T0,
    endedAt: T0 + 5000,
    status: "ok",
    trigger: "schedule",
    exitCode: 0,
  });
  s.store.writeLog(id, runId, "磁盘 62%");

  const list = await s.call("GET", `/api/me/cron/${id}/runs`);
  assert.equal(list.body.runs.length, 1);
  assert.equal(list.body.runs[0].durationMs, 5000);
  assert.equal(list.body.runs[0].log, undefined, "列表不带正文,免得刷屏");

  const one = await s.call("GET", `/api/me/cron/${id}/runs/${runId}`);
  assert.equal(one.body.log, "磁盘 62%");

  const missing = await s.call("GET", `/api/me/cron/${id}/runs/20260101T000000Z-ffff`);
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /保留策略/);
});

test("方法不对、路径不对都有说法", async () => {
  const s = setup();
  const id = (await s.call("POST", "/api/me/cron", NEW_JOB)).body.id as string;
  assert.equal((await s.call("PUT", "/api/me/cron")).status, 405);
  assert.equal((await s.call("POST", `/api/me/cron/${id}`)).status, 405);
  assert.equal((await s.call("GET", `/api/me/cron/${id}/什么`)).status, 404);
});

test("任务数量有上限", async () => {
  const s = setup();
  for (let i = 0; i < 50; i++) {
    const r = await s.call("POST", "/api/me/cron", { ...NEW_JOB, name: `任务 ${i}` });
    assert.equal(r.status, 201, `第 ${i} 个应当能建`);
  }
  const over = await s.call("POST", "/api/me/cron", { ...NEW_JOB, name: "第 51 个" });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /上限 50/);
});

test("回合结束令牌作废后就调不动了", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-cronapi-"));
  dirs.push(dir);
  const turns = new TurnTokens();
  const minted = turns.mint(ME);
  const deps: CronApiDeps = {
    turns,
    store: new CronStore({ dir, now: () => T0 }),
    validateContext: () => ({
      defaultTz: "UTC",
      minIntervalMs: 300_000,
      defaultKeepRuns: 20,
      mountAllowlist: [],
      hostDataDir: "/host",
      now: T0,
    }),
    tz: "UTC",
  };
  assert.equal((await handleCronApi("GET", "/api/me/cron", minted.token, undefined, deps)).status, 200);
  minted.revoke();
  assert.equal((await handleCronApi("GET", "/api/me/cron", minted.token, undefined, deps)).status, 401);
});
