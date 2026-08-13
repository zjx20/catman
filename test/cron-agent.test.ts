import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CronInputError,
  mergeJobPatch,
  validateJobInput,
  type ValidateContext,
} from "../src/core/cron/validate.js";
import { inQuietHours, mergeNotices, NoticeSpool, type PendingNotice } from "../src/core/cron/notices.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask, CronJob } from "../src/core/cron/types.js";

/** P2 加进来的两件事:agent 任务、静默时段与积压合并。 */

const NOW = Date.parse("2026-08-13T10:00:00+08:00");
const SH = "Asia/Shanghai";
const dirs: string[] = [];

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function ctx(over: Partial<ValidateContext> = {}): ValidateContext {
  return {
    defaultTz: SH,
    minIntervalMs: 5 * 60_000,
    defaultKeepRuns: 20,
    mountAllowlist: ["/opt/services"],
    hostDataDir: "/mnt/usb/catman_data",
    modelAllowlist: ["opus", "sonnet", "haiku"],
    now: NOW,
    ...over,
  };
}

/** agent 任务的最小输入。周期要过 15 分钟那道额外闸。 */
function agentInput(over: Record<string, unknown> = {}, task: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "每小时看一眼",
    schedule: { kind: "every", minutes: 60 },
    task: { kind: "agent", prompt: "看一眼有没有异常,变化了才说", ...task },
    ...over,
  };
}

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

const agentTaskOf = (raw: unknown): AgentTask => validateJobInput(raw, ctx()).task as AgentTask;

// ── agent 任务 ────────────────────────────────────────────────────

test("agent 任务:默认值,以及那道花钱的闸", () => {
  const v = validateJobInput(agentInput(), ctx());
  assert.equal(v.task.kind, "agent");
  const t = v.task as AgentTask;
  assert.equal(t.session, "fresh", "默认每次干净起步");
  assert.equal(t.maxTurns, 20, "没人盯着的回合必须有轮数上限");
  assert.equal(t.model, undefined, "不指定就跟着用户当时的偏好走");
});

test("agent 任务:比脚本更严的频率下限,而且两道闸互不干扰", () => {
  rejects(agentInput({ schedule: { kind: "every", minutes: 10 } }), /agent 任务最快 15 分钟一次/);
  assert.ok(validateJobInput(agentInput({ schedule: { kind: "every", minutes: 15 } }), ctx()));
  // 同样的周期换成脚本任务就没问题
  assert.ok(
    validateJobInput(
      { name: "脚本", schedule: { kind: "every", minutes: 10 }, task: { cmd: ["ls"] } },
      ctx(),
    ),
  );
});

test("agent 任务:prompt 允许换行,别的控制字符照挡", () => {
  assert.equal(agentTaskOf(agentInput({}, { prompt: "第一行\n第二行" })).prompt, "第一行\n第二行");
  rejects(agentInput({}, { prompt: "" }), /不能为空/);
  rejects(agentInput({}, { prompt: "x".repeat(4001) }), /太长了/);
  rejects(agentInput({}, { prompt: 42 }), /必须是字符串/);
  rejects(agentInput({}, { prompt: `带控制符` }), /控制字符/);
});

test("agent 任务:model 要在白名单里,maxTurns 有量程", () => {
  assert.equal(agentTaskOf(agentInput({}, { model: "sonnet" })).model, "sonnet");
  rejects(agentInput({}, { model: "gpt-4" }), /只能是 opus \/ sonnet \/ haiku/);
  rejects(agentInput({}, { maxTurns: 500 }), /应在 1-50 之间/);
  rejects(agentInput({}, { session: "keep" }), /只能是 fresh \/ chain/);
});

test("agent 任务:两种任务的字段写混了当场报错", () => {
  rejects(agentInput({}, { cmd: ["ls"] }), /不认识的字段 "cmd"/);
  rejects(agentInput({}, { network: "mynet" }), /不认识的字段 "network"/);
  rejects(agentInput({}, { mounts: [] }), /不认识的字段 "mounts"/);
  // 反过来:脚本任务写了 prompt
  rejects(
    { name: "脚本", schedule: { kind: "every", minutes: 10 }, task: { cmd: ["ls"], prompt: "看一眼" } },
    /不认识的字段 "prompt"/,
  );
});

test("agent 任务:PATCH 往返不丢字段", () => {
  const v = validateJobInput(agentInput({}, { session: "chain", model: "haiku", maxTurns: 5 }), ctx());
  const j: CronJob = {
    id: "j_1",
    userKey: "wechat:a:b",
    name: v.name,
    enabled: true,
    schedule: v.schedule,
    task: v.task,
    timeoutMs: v.timeoutMs,
    overlap: v.overlap,
    notify: v.notify,
    keepRuns: v.keepRuns,
    createdAt: NOW,
    updatedAt: NOW,
    failStreak: 0,
  };
  assert.deepEqual(validateJobInput(mergeJobPatch(j, {}), ctx()).task, j.task);
  // 只改一个字段,别的原样
  const patched = validateJobInput(mergeJobPatch(j, { task: { kind: "agent", prompt: "换个说法" } }), ctx());
  assert.equal((patched.task as AgentTask).prompt, "换个说法");
  assert.equal((patched.task as AgentTask).session, "fresh", "整体替换 task 时没写的字段回默认值");
});

// ── 静默时段的校验 ────────────────────────────────────────────────

test("notify.quiet:格式、跨零点、以及说不清的那种", () => {
  const q = (s: string) =>
    validateJobInput(
      { name: "x", schedule: { kind: "every", minutes: 30 }, task: { cmd: ["ls"] }, notify: { quiet: s } },
      ctx(),
    ).notify.quiet;
  assert.equal(q("23:00-08:00"), "23:00-08:00");
  assert.equal(q("09:30-18:00"), "09:30-18:00");
  const bad = (s: string, re: RegExp) =>
    rejects(
      { name: "x", schedule: { kind: "every", minutes: 30 }, task: { cmd: ["ls"] }, notify: { quiet: s } },
      re,
    );
  bad("23:00", /要写成/);
  bad("25:00-08:00", /要写成/);
  bad("8:00-9:00", /要写成/);
  // 起止相同两种理解都说得通,那就必然有一半人理解错
  bad("08:00-08:00", /说不清/);
});

// ── 静默时段的判定 ────────────────────────────────────────────────

test("inQuietHours:跨零点的窗口(最常见的那种)", () => {
  const at = (iso: string) => Date.parse(iso);
  const q = "23:00-08:00";
  assert.equal(inQuietHours(q, at("2026-08-13T23:30:00+08:00"), SH), true);
  assert.equal(inQuietHours(q, at("2026-08-13T03:00:00+08:00"), SH), true);
  assert.equal(inQuietHours(q, at("2026-08-13T07:59:00+08:00"), SH), true);
  assert.equal(inQuietHours(q, at("2026-08-13T08:00:00+08:00"), SH), false, "终点是开区间");
  assert.equal(inQuietHours(q, at("2026-08-13T12:00:00+08:00"), SH), false);
  assert.equal(inQuietHours(q, at("2026-08-13T22:59:00+08:00"), SH), false);
});

test("inQuietHours:同一天里的窗口,以及没设时一律不静默", () => {
  const at = (iso: string) => Date.parse(iso);
  assert.equal(inQuietHours("09:00-18:00", at("2026-08-13T12:00:00+08:00"), SH), true);
  assert.equal(inQuietHours("09:00-18:00", at("2026-08-13T20:00:00+08:00"), SH), false);
  assert.equal(inQuietHours(undefined, at("2026-08-13T03:00:00+08:00"), SH), false);
  // 判定按**任务自己的时区**,不是进程的
  assert.equal(inQuietHours("23:00-08:00", at("2026-08-13T03:00:00+08:00"), "UTC"), false);
});

// ── 积压合并 ──────────────────────────────────────────────────────

function notice(over: Partial<PendingNotice> = {}): PendingNotice {
  return { jobId: "j_1", jobName: "巡检", status: "ok", at: NOW, text: "✅ 跑完了", ...over };
}

test("只攒到一条就原样发 —— 那条本来就写得很全", () => {
  assert.deepEqual(mergeNotices([notice({ text: "✅ 「巡检」跑完了,3 秒\n一切正常" })]), [
    "✅ 「巡检」跑完了,3 秒\n一切正常",
  ]);
});

test("攒到多条折成摘要:说清跑了几次、成了几次、最后一次什么样", () => {
  const out = mergeNotices([
    notice({ at: NOW, text: "第一次" }),
    notice({ at: NOW + 1000, status: "failed", text: "第二次炸了" }),
    notice({ at: NOW + 2000, text: "第三次好了" }),
  ]);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /跑了 3 次:2 次成功、1 次失败/);
  assert.match(out[0]!, /最后一次是这样:\n第三次好了/);
});

test("失败按类型分开数 —— 「3 次失败」和「1 次超时 2 次没起来」是两种排查方向", () => {
  const out = mergeNotices([
    notice({ status: "timeout", text: "a" }),
    notice({ status: "error", text: "b" }),
    notice({ status: "error", text: "c" }),
  ]);
  assert.match(out[0]!, /0 次成功、1 次超时、2 次没起来/);
});

test("不同任务各出一条,不会混成一锅", () => {
  const out = mergeNotices([
    notice({ jobId: "j_1", jobName: "巡检", text: "A" }),
    notice({ jobId: "j_2", jobName: "备份", text: "B" }),
  ]);
  assert.deepEqual(out.sort(), ["A", "B"]);
});

test("攒着的通知落盘 —— 部署很可能就发生在攒着的那几个小时里", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-notices-"));
  dirs.push(dir);
  const path = join(dir, "notices.json");
  const a = new NoticeSpool(path);
  a.add("u1", notice({ text: "半夜那条" }));
  a.add("u2", notice({ text: "别人的" }));

  // 换一个实例 = 进程被部署换掉
  const b = new NoticeSpool(path);
  assert.deepEqual(b.users().sort(), ["u1", "u2"]);
  assert.equal(b.peek("u1").length, 1);
  assert.equal(b.take("u1")[0]!.text, "半夜那条");
  assert.deepEqual(b.users(), ["u2"], "取走之后就不再欠这个用户了");
  assert.deepEqual(new NoticeSpool(path).users(), ["u2"], "取走这件事也要落盘");
});
