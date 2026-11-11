import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { RuntimeManager } from "../src/core/execution/runtime.js";
import { ContextScriptRunner } from "../src/core/execution/cron-runner.js";
import { CronStore } from "../src/core/cron/store.js";
import type { TaskRecord } from "../src/core/execution/task-supervisor.js";
import { executionFixture } from "./helpers/execution.js";

test("cron 入口任务先登记通知归属，立即结束、超时及重启均不发旁路通知，独立后台任务照常通知", async () => {
  const f = executionFixture();
  let current!: ReturnType<RuntimeManager["all"]>[number];
  let status: TaskRecord["status"] = "completed";
  const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, docker: async (args, env) => {
    const at = args.indexOf("rpc");
    if (at >= 0 && args[at + 1] === "/tasks" && args[at + 2] === "POST") {
      const request = JSON.parse(args[at + 3]!);
      const task: TaskRecord = { id: request.id, name: request.name, command: "node", status,
        startedAt: f.time(), deadlineAt: f.time() + request.timeoutMs, endedAt: f.time() };
      // Real worker callbacks can overtake the start RPC response.
      manager.taskEvent(current.token, task, "finished before RPC returned");
      return JSON.stringify(task);
    }
    return f.options.docker(args, env);
  } });
  let restarted: RuntimeManager | undefined;
  try {
    const context = f.contexts.cron("alice", "radio"); current = await manager.ensure(context);
    for (const state of ["completed", "failed", "timeout"] as const) {
      status = state;
      await manager.startCronTask(current, { name: "radio", cmd: ["node"], cwd: f.contexts.paths(context).work, timeoutMs: 1000 });
    }
    assert.equal(manager.pending(context.id).length, 0);
    assert.equal(manager.all()[0]!.tasks.length, 3, "任务结果仍持久化供调度器查询");
    restarted = new RuntimeManager(f.config, f.contexts, f.options);
    const id = `t_${randomUUID()}`; manager.ownCronTask(current, id);
    restarted.close(); restarted = new RuntimeManager(f.config, f.contexts, f.options);
    const task: TaskRecord = { id, name: "radio", command: "node", status: "timeout", startedAt: f.time(), deadlineAt: f.time() + 1000, endedAt: f.time() };
    restarted.taskEvent(current.token, task, "timed out after controller restart");
    assert.equal(restarted.pending(context.id).length, 0);
    // Same context and name, but not owned by cron. Worker metadata cannot silence it.
    restarted.taskEvent(current.token, { ...task, id: `t_${randomUUID()}`, notificationOwner: "cron" } as TaskRecord, "independent task timeout");
    assert.equal(restarted.pending(context.id).length, 1);
    assert.match(restarted.pending(context.id)[0]!.text, /超.*时限/);
    await restarted.tick(); assert.equal(f.notices.length, 1);
  } finally { restarted?.close(); manager.close(); f.cleanup(); }
});

test("从旧 cron handle 恢复控制面通知归属，聊天任务不能登记成 cron 入口", async () => {
  const f = executionFixture();
  try {
    const context = f.contexts.cron("alice", "job"), runtime = await f.runtimes.ensure(context), id = `t_${randomUUID()}`;
    writeFileSync(join(f.config.dataDir, "execution/cron-handles.json"), JSON.stringify([{ run: "old-run", contextId: context.id, taskId: id, userKey: "alice" }]));
    const jobs = new CronStore({ dir: join(f.config.dataDir, "cron"), contexts: f.contexts });
    new ContextScriptRunner(f.contexts, f.runtimes, jobs);
    f.runtimes.taskEvent(runtime.token, { id, name: "job", command: "node", status: "completed", startedAt: f.time(), deadlineAt: f.time() + 1000, endedAt: f.time() }, "success");
    assert.equal(f.runtimes.pending(context.id).length, 0);
    const chat = await f.runtimes.ensure(f.contexts.chat("alice"));
    assert.throws(() => f.runtimes.ownCronTask(chat, `t_${randomUUID()}`), /归属无效/);
  } finally { f.cleanup(); }
});
