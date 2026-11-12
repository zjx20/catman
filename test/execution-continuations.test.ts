import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BackgroundContinuations, CONTINUATION_LIMIT, CONTINUATION_TIMEOUT_MS } from "../src/core/execution/continuations.js";
import { executionFixture } from "./helpers/execution.js";
import type { ExecutionContext } from "../src/core/execution/contexts.js";
import type { RuntimeEvent } from "../src/core/execution/runtime.js";

function started(f: ReturnType<typeof executionFixture>, user = "alice") {
  const c = f.contexts.chat(user); f.contexts.started(c.id, c.sdkSessionId); return f.contexts.get(c.id)!;
}
function event(f: ReturnType<typeof executionFixture>, c: ExecutionContext, text = "task result") {
  f.runtimes.notifyUser(c.userKey, c.id, text, false, "task");
}
function scheduler(f: ReturnType<typeof executionFixture>, run: (c: ExecutionContext, e: RuntimeEvent[], begin: () => boolean) => Promise<boolean>, ready = () => true) {
  return new BackgroundContinuations(f.config.dataDir, f.contexts, f.runtimes, { now: f.time, ready, run });
}

test("只调度新标记的聊天任务事件；按 owner/context 合并，普通通知、SDK 和 cron 不额外唤醒", async () => {
  const f = executionFixture();
  try {
    const a = started(f), b = started(f, "bob"), cron = f.contexts.cron("alice", "daily"); f.contexts.started(cron.id, cron.sdkSessionId);
    f.runtimes.notifyUser(a.userKey, a.id, "old notice");
    const r = await f.runtimes.ensure(a); f.runtimes.report(a.id, "native SDK result", "sdk-result");
    const task = { id: `t_${randomUUID()}`, name: "下载", command: "curl", status: "completed" as const, startedAt: f.time(), deadlineAt: f.time() + 1000, endedAt: f.time(), exitCode: 0 };
    f.runtimes.taskEvent(r.token, task, "output"); f.runtimes.taskEvent(r.token, task, "duplicate");
    event(f, a, "second task"); event(f, b); event(f, cron);
    const calls: Array<{ c: ExecutionContext; events: RuntimeEvent[] }> = [];
    const q = scheduler(f, async (c, events, begin) => { assert.equal(begin(), true); calls.push({ c, events }); f.runtimes.acknowledge(events.map(e => e.id)); return true; });
    await Promise.all([q.tick(), q.tick()]); await q.tick();
    assert.equal(calls.length, 2); assert.equal(calls.find(x => x.c.id === a.id)!.events.length, 2);
    const download = calls.flatMap(c => c.events).find(e => e.text.includes(task.id))!;
    assert.match(download.text, /退出码：0/); assert.ok(download.text.includes(join(f.contexts.paths(a).tasks, `${task.id}.log`)));
    assert.ok(download.text.includes("output")); assert.ok(calls.every(x => x.events.every(e => e.userKey === x.c.userKey)));
    assert.ok(f.runtimes.pending(a.id).some(e => e.text === "native SDK result"));
  } finally { f.cleanup(); }
});

test("有界重试和预算跨重启保留；到限只通知一次，用户新输入重新开放", async () => {
  const f = executionFixture();
  try {
    const c = started(f); event(f, c); let n = 0;
    const run = async (_c: ExecutionContext, _e: RuntimeEvent[], begin: () => boolean) => { assert.ok(begin()); n++; return false; };
    let q = scheduler(f, run);
    for (let i = 0; i < CONTINUATION_LIMIT; i++) {
      await q.tick(); await q.tick(); assert.equal(n, i + 1);
      q.close(); q = scheduler(f, run); await q.tick(); assert.equal(n, i + 1);
      f.advance(60_000);
    }
    await q.tick(); await q.tick(); q.close(); q = scheduler(f, run); await q.tick();
    assert.equal(n, CONTINUATION_LIMIT);
    assert.equal(f.runtimes.pending(c.id).filter(e => e.text.includes("达到")).length, 1);
    assert.equal(q.retains(c.id), false);
    q.reset(c.id); await q.tick(); assert.equal(n, CONTINUATION_LIMIT + 1);
    q.pause(c.id); f.advance(60_000); await q.tick(); assert.equal(n, CONTINUATION_LIMIT + 1);
  } finally { f.cleanup(); }
});

test("新输入、取消、消息已被消费及关闭发生在排队期间时，不启动旧续接", async () => {
  for (const kind of ["input", "cancel", "consumed", "closed"]) {
    const f = executionFixture();
    try {
      const c = started(f); event(f, c); let begin!: () => boolean, finish!: () => void;
      const gate = new Promise<void>(resolve => { finish = resolve; });
      const q = scheduler(f, async (_c, _events, claim) => { begin = claim; await gate; assert.equal(begin(), false, kind); return false; });
      const tick = q.tick();
      if (kind === "input") q.reset(c.id);
      if (kind === "cancel") q.pause(c.id);
      if (kind === "consumed") f.runtimes.acknowledge(f.runtimes.continuations().map(e => e.id));
      if (kind === "closed") q.close();
      finish(); await tick;
      const file = join(f.config.dataDir, "execution/continuations.json");
      const budgets = existsSync(file) ? readFileSync(file, "utf8") : "{}";
      assert.ok(!budgets.includes('"attempts": 1'));
    } finally { f.cleanup(); }
  }
});

test("控制面重启保留未消费事件和崩溃租约，新到事件不会被已运行批次误确认", async () => {
  const f = executionFixture();
  try {
    const c = started(f); event(f, c, "before crash");
    writeFileSync(join(f.config.dataDir, "execution/continuations.json"), JSON.stringify({ [c.id]: { attempts: 1, notBefore: f.time() + CONTINUATION_TIMEOUT_MS + 60_000 } }));
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; }); let n = 0;
    const q = scheduler(f, async (_c, events, begin) => { assert.ok(begin()); n++; await gate; f.runtimes.acknowledge(events.map(e => e.id)); return true; });
    await q.tick(); assert.equal(n, 0);
    f.advance(CONTINUATION_TIMEOUT_MS + 60_000);
    const tick = q.tick(); event(f, c, "arrived during continuation"); finish(); await tick;
    assert.deepEqual(f.runtimes.continuations().map(e => e.text), ["arrived during continuation"]);
    await q.tick(); assert.equal(n, 2); assert.equal(f.runtimes.continuations().length, 0);
  } finally { f.cleanup(); }
});

test("显式回收和手动停止任务不重新唤醒，历史事件缺少标记也不回放", async () => {
  const f = executionFixture();
  try {
    const c = started(f), r = await f.runtimes.ensure(c);
    f.runtimes.taskEvent(r.token, { id: `t_${randomUUID()}`, name: "stopped", command: "node", status: "stopped", startedAt: f.time(), deadlineAt: f.time() + 1000, endedAt: f.time() }, "stopped");
    assert.equal(f.runtimes.continuations().length, 0);
    event(f, c); assert.equal(f.runtimes.continuations().length, 1);
    await f.runtimes.reclaim(c.userKey, c.id);
    assert.equal(f.runtimes.continuations().length, 0); assert.ok(f.runtimes.pending(c.id).length > 0);
  } finally { f.cleanup(); }
});
