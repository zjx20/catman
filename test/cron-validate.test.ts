import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CronInputError,
  mergeJobPatch,
  validateJobInput,
  type ValidateContext,
} from "../src/core/cron/validate.js";
import type { CronJob, ScriptTask } from "../src/core/cron/types.js";

/** 断言这是脚本任务并窄化 —— 联合类型之后,直接取 mounts/limits 编译不过。 */
function script(t: { kind: string }): ScriptTask {
  assert.equal(t.kind, "script");
  return t as ScriptTask;
}

const NOW = Date.parse("2026-08-13T10:00:00+08:00");

function ctx(over: Partial<ValidateContext> = {}): ValidateContext {
  return {
    defaultTz: "Asia/Shanghai",
    minIntervalMs: 5 * 60_000,
    defaultKeepRuns: 20,
    hostDataDir: "/mnt/usb/catman_data",
    modelAllowlist: ["opus", "sonnet", "haiku"],
    now: NOW,
    ...over,
  };
}

/** 最小可用输入。各用例只改自己关心的那一处。 */
function input(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "每天早八看磁盘",
    schedule: { kind: "cron", expr: "0 8 * * *" },
    task: { cmd: ["bash", "-lc", "df -h /"] },
    ...over,
  };
}

/** 断言拒收,并且错误文案里有那句能直接念给用户听的话。 */
function rejects(raw: unknown, re: RegExp, c = ctx()): void {
  assert.throws(
    () => validateJobInput(raw, c),
    (err: unknown) => {
      assert.ok(err instanceof CronInputError, `应当是 CronInputError,实际:${String(err)}`);
      assert.match((err as Error).message, re);
      return true;
    },
  );
}

test("最小输入:默认值全部填满,而且是保守的那一端", () => {
  const v = validateJobInput(input(), ctx());
  assert.equal(v.name, "每天早八看磁盘");
  assert.equal(v.enabled, true);
  assert.equal(v.timeoutMs, 10 * 60_000);
  assert.equal(v.overlap, "skip");
  assert.equal(v.keepRuns, 20);
  assert.deepEqual(v.notify, { start: false, end: true, onlyFailure: false });
  assert.equal(v.task.kind, "script");
  assert.equal(v.nextAt, Date.parse("2026-08-14T08:00:00+08:00"));
});

// ── LLM 最容易犯的那几类错 ────────────────────────────────────────

test("拼错的字段名一律拒收,并把认识的字段列出来", () => {
  rejects(input({ timeoutMinute: 30 }), /不认识的字段 "timeoutMinute".*timeoutMinutes/s);
  rejects(input({ schedule: { kind: "cron", expression: "0 8 * * *" } }), /不认识的字段 "expression"/);
  rejects(input({ task: { cmd: ["ls"], workdir: "/tmp" } }), /不认识的字段 "workdir"/);
  rejects(input({ notify: { onFailure: true } }), /不认识的字段 "onFailure"/);
});

test("cmd 写成一整行 shell 时,错误里直接给出正确写法", () => {
  rejects(input({ task: { cmd: "df -h /" } }), /必须是字符串数组.*bash.*-lc/s);
});

test("单位记错一个量级会被拦下(字段名自带单位,值也要在量程里)", () => {
  rejects(input({ timeoutMinutes: 600_000 }), /timeoutMinutes 应在 1-120 之间/);
  rejects(input({ schedule: { kind: "every", minutes: 1800_000 } }), /schedule.minutes 应在/);
  rejects(input({ timeoutMinutes: 10.5 }), /必须是整数/);
  rejects(input({ timeoutMinutes: "10" }), /必须是数字,给的是 string/);
});

test("频率下限:形状一样但真实间隔太密的也拦得住", () => {
  rejects(input({ schedule: { kind: "cron", expr: "* * * * *" } }), /最快 1 分钟就触发一次/);
  rejects(input({ schedule: { kind: "cron", expr: "0,1 * * * *" } }), /最快 1 分钟就触发一次/);
  rejects(input({ schedule: { kind: "every", minutes: 1 } }), /最快 1 分钟就触发一次/);
  // 正好等于下限是允许的,而且默认超时会跟着周期缩到 5 分钟(不必显式写)
  const tight = validateJobInput(input({ schedule: { kind: "every", minutes: 5 } }), ctx());
  assert.equal(tight.timeoutMs, 5 * 60_000);
  // 管理员放宽之后同一个输入就该通过
  assert.ok(
    validateJobInput(input({ schedule: { kind: "every", minutes: 1 } }), ctx({ minIntervalMs: 60_000 })),
  );
});

test("永远不会触发的表达式当场拒收,而不是存一个死任务", () => {
  rejects(input({ schedule: { kind: "cron", expr: "0 0 30 2 *" } }), /算不出一年内的下次触发/);
});

test("超时比触发间隔还长:每一轮都会撞上下一轮,当场说清楚", () => {
  rejects(
    input({ schedule: { kind: "every", minutes: 10 }, timeoutMinutes: 30 }),
    /比触发间隔.*还长/s,
  );
});

test("一次性任务:时刻必须带时区,且必须在未来", () => {
  rejects(input({ schedule: { kind: "once", at: "2026-08-20T03:00:00" } }), /要带时区的 ISO 时刻/);
  rejects(input({ schedule: { kind: "once", at: "2020-01-01T03:00:00+08:00" } }), /过去的时刻/);
  const v = validateJobInput(input({ schedule: { kind: "once", at: "2026-08-20T03:00:00+08:00" } }), ctx());
  assert.equal(v.schedule.kind, "once");
  assert.equal(v.nextAt, Date.parse("2026-08-20T03:00:00+08:00"));
});

test("name 的边界", () => {
  rejects(input({ name: "" }), /不能为空/);
  rejects(input({ name: "   " }), /不能为空/);
  rejects(input({ name: "x".repeat(65) }), /太长了/);
  rejects(input({ name: "两\n行" }), /控制字符/);
  rejects(input({ name: 42 }), /必须是字符串,给的是 number/);
  assert.equal(validateJobInput(input({ name: "  留白会被吃掉  " }), ctx()).name, "留白会被吃掉");
});

// ── 隔离相关的闸门 ────────────────────────────────────────────────

test("脚本任务不能选择宿主挂载、镜像、网络或资源参数", () => {
  for (const field of ["mounts", "image", "network", "limits"]) {
    rejects(input({ task: { cmd: ["true"], [field]: field === "mounts" ? [{ host: "/opt/services/catman/userdata", at: "/all-users", ro: false }] : "custom" } }), /不认识的字段/);
  }
});

test("没配宿主 /data 路径时,脚本任务在创建这一步就被拒", () => {
  rejects(input(), /CATMAN_HOST_DATA_DIR/, ctx({ hostDataDir: undefined }));
});

test("network 与 env 的取值", () => {
  rejects(input({ task: { cmd: ["ls"], network: "host" } }), /不认识的字段/);
  rejects(input({ task: { cmd: ["ls"], env: { "BAD-KEY": "v" } } }), /不是合法环境变量名/);
  rejects(input({ task: { cmd: ["ls"], env: { OK: 1 } } }), /必须是字符串/);
});


test("整个输入不是对象、缺必填项", () => {
  rejects("每天八点跑一下", /必须是一个 JSON 对象/);
  rejects(null, /必须是一个 JSON 对象/);
  rejects({ name: "x", task: { cmd: ["ls"] } }, /schedule 必填/);
  rejects({ name: "x", schedule: { kind: "cron", expr: "0 8 * * *" } }, /task 必填/);
});

// ── PATCH ─────────────────────────────────────────────────────────

function job(over: Partial<CronJob> = {}): CronJob {
  const v = validateJobInput(input(), ctx());
  return {
    id: "j_test",
    userKey: "wechat:a:b",
    name: v.name,
    enabled: v.enabled,
    schedule: v.schedule,
    task: v.task,
    timeoutMs: v.timeoutMs,
    overlap: v.overlap,
    notify: v.notify,
    keepRuns: v.keepRuns,
    createdAt: NOW,
    updatedAt: NOW,
    nextAt: v.nextAt,
    failStreak: 0,
    ...over,
  };
}

test("PATCH:补丁合到现有任务上再整体校验", () => {
  const merged = mergeJobPatch(job(), { enabled: false });
  const v = validateJobInput(merged, ctx());
  assert.equal(v.enabled, false);
  assert.equal(v.name, "每天早八看磁盘", "没改的字段要原样保留");
  assert.equal(v.timeoutMs, 10 * 60_000);
});

test("PATCH:改一个字段照样绕不过任何一条不变量", () => {
  // 只改周期,原来合法的 10 分钟超时就比新间隔还长了 —— 局部校验会漏掉这种。
  const merged = mergeJobPatch(job(), { schedule: { kind: "every", minutes: 6 } });
  rejects(merged, /比触发间隔.*还长/s);
  // 补丁里的未知字段同样拒收
  assert.throws(() => mergeJobPatch(job(), { enable: false }), /不认识的字段 "enable"/);
  assert.throws(() => mergeJobPatch(job(), "关掉"), /必须是一个 JSON 对象/);
});

test("PATCH:换一种周期不会留下上一种的残字段", () => {
  const merged = mergeJobPatch(job(), { schedule: { kind: "every", minutes: 30 } });
  const v = validateJobInput(merged, ctx());
  assert.deepEqual(v.schedule, { kind: "every", ms: 30 * 60_000 });
});

test("PATCH:能原样吃回自己吐出来的任务(往返一致)", () => {
  const j = job({ schedule: { kind: "every", ms: 30 * 60_000 } });
  const v = validateJobInput(mergeJobPatch(j, {}), ctx());
  assert.deepEqual(v.schedule, j.schedule);
  assert.deepEqual(v.task, j.task);
  assert.equal(v.timeoutMs, j.timeoutMs);
  assert.equal(v.keepRuns, j.keepRuns);
});
