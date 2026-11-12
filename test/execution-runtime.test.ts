import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { RuntimeManager } from "../src/core/execution/runtime.js";
import { ContextStore } from "../src/core/execution/contexts.js";
import { join } from "node:path";
import { executionFixture } from "./helpers/execution.js";

test("worker 只挂当前上下文和 owner home，不给控制面、Docker 或宿主树", async () => {
  const f = executionFixture();
  try {
    const c = f.contexts.chat("alice"); await f.runtimes.ensure(c);
    const call = f.calls.find(c => c.args[0] === "run")!;
    const mounts = call.args.flatMap((arg, i) => arg === "--mount" ? [call.args[i + 1]!] : []);
    assert.ok(mounts.some(m => m.includes(`dst=${f.contexts.paths(c).work}`)));
    assert.ok(mounts.some(m => m.includes("dst=/user")));
    assert.ok(mounts.every(m => !m.includes("docker.sock") && !m.includes("/opt/services") && !m.includes("dst=/data,")));
    assert.ok(!mounts.some(m => m.endsWith("dst=/runtime/release,readonly")), "不挂整个 release 的 .git 等内容");
    assert.ok(call.args.includes("--read-only")); assert.ok(call.args.includes("no-new-privileges"));
    assert.equal(call.env?.CATMAN_ADMIN_TOKEN, undefined); assert.equal(call.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(call.env?.CATMAN_IPC_SECRET, undefined);
  } finally { f.cleanup(); }
});
test("只有管理员的运行环境挂载自进化源码", async () => {
  const f = executionFixture(true);
  try { await f.runtimes.ensure(f.contexts.chat("admin")); assert.ok(f.calls.find(c => c.args[0] === "run")!.args.some(a => a.includes("dst=/catman-src"))); }
  finally { f.cleanup(); }
});
test("守护人格的上下文宿主路径保留 rescue 前缀，release 仍来自主数据根", async () => {
  const f = executionFixture();
  try {
    const dataDir = join(f.config.dataDir, "rescue");
    process.env.CLAUDE_CONFIG_DIR = join(dataDir, "claude");
    const contexts = new ContextStore(dataDir);
    const manager = new RuntimeManager({ ...f.config, dataDir, persona: "rescue" }, contexts, f.options);
    await manager.ensure(contexts.chat("alice"));
    const mounts = f.calls.find(c => c.args[0] === "run")!.args.filter(arg => arg.startsWith("type=bind"));
    assert.ok(mounts.some(m => m.includes("src=/host/catman/rescue/tenants/")));
    assert.ok(mounts.some(m => m.includes("src=/host/catman/releases/fixture/dist")));
    assert.ok(!mounts.some(m => m.includes("dst=/catman-src")));
  } finally { f.cleanup(); }
});
test("同一上下文并发请求只建一个容器，重启认领保留原身份与期限", async () => {
  const f = executionFixture();
  try {
    const c = f.contexts.chat("alice"); const [a, b] = await Promise.all([f.runtimes.ensure(c), f.runtimes.ensure(c)]);
    assert.equal(a.container, b.container); assert.equal(f.calls.filter(c => c.args[0] === "run").length, 1);
    f.advance(12345);
    const restarted = new RuntimeManager(f.config, f.contexts, f.options);
    const adopted = await restarted.ensure(c); assert.equal(adopted.token, a.token); assert.equal(adopted.createdAt, a.createdAt);
    assert.equal(f.calls.filter(c => c.args[0] === "run").length, 1);
  } finally { f.cleanup(); }
});
test("Docker 不可用时拒绝执行，不降级或重复启动", async () => {
  const f = executionFixture();
  try {
    const c = f.contexts.chat("alice"); await f.runtimes.ensure(c); f.failInspect(new Error("daemon unavailable"));
    await assert.rejects(f.runtimes.ensure(c), /unavailable/);
    assert.equal(f.calls.filter(c => c.args[0] === "run").length, 1);
  } finally { f.cleanup(); }
});
test("完全没有活动进程的环境短暂空闲后静默释放，不占用整小时的额度", async () => {
  const f = executionFixture();
  try {
    await f.runtimes.ensure(f.contexts.chat("alice")); f.emptySnapshot();
    f.advance(30_000); await f.runtimes.tick();
    assert.equal(f.runtimes.all().length, 0); assert.equal(f.notices.length, 0);
  } finally { f.cleanup(); }
});
test("提前十分钟只预告一次，没有响应则到期回收并记录", async () => {
  const f = executionFixture();
  try {
    const c = f.contexts.chat("alice"), r = await f.runtimes.ensure(c);
    f.advance(50 * 60_000); await f.runtimes.tick(); await f.runtimes.tick();
    assert.equal(f.notices.length, 1); assert.match(f.notices[0]!, /10 分钟/); assert.match(f.notices[0]!, /node/);
    assert.ok(!f.notices[0]!.includes(r.token));
    f.advance(10 * 60_000); await f.runtimes.tick();
    assert.equal(f.runtimes.all().length, 0); assert.equal(f.runtimes.resolve(r.token), undefined);
    assert.match(f.notices.at(-1)!, /已回收/);
  } finally { f.cleanup(); }
});
test("用户在状态采集期间发来消息，旧倒计时不得回收", async () => {
  const f = executionFixture();
  try {
    const c = f.contexts.chat("alice"); await f.runtimes.ensure(c); f.advance(3600_000);
    f.beforeSnapshot(async () => { f.runtimes.activity(c.id); });
    await f.runtimes.tick(); assert.equal(f.runtimes.all().length, 1); assert.equal(f.notices.length, 0);
  } finally { f.cleanup(); }
});
test("延长有上限且校验 owner；SDK 后台事件不刷新闲置期限", async () => {
  const f = executionFixture();
  try {
    const c = f.contexts.chat("alice"); await f.runtimes.ensure(c);
    assert.throws(() => f.runtimes.extend("bob", c.id, 30), /没有/);
    assert.throws(() => f.runtimes.extend("alice", c.id, 241), /1-240/);
    f.advance(50 * 60_000); const deadline = f.runtimes.extend("alice", c.id, 30);
    f.runtimes.sdkTasks(c.id, [{ task_id: "server", description: "preview server" }]);
    f.advance(20 * 60_000); await f.runtimes.tick(); assert.match(f.notices[0]!, /preview server/);
    f.advance(10 * 60_000); assert.equal(f.time(), deadline); await f.runtimes.tick(); assert.equal(f.runtimes.all().length, 0);
  } finally { f.cleanup(); }
});
test("登记任务保留其完整期限，管理器不响应时容器外超时兜底", async () => {
  const f = executionFixture();
  try {
    const c = f.contexts.chat("alice"), r = await f.runtimes.ensure(c);
    const task = { id: `t_${randomUUID()}`, name: "download", command: "curl", status: "running" as const, startedAt: f.time(), deadlineAt: f.time() + 2 * 3600_000 };
    f.runtimes.taskEvent(r.token, task, ""); f.tasks.push(task);
    f.advance(70 * 60_000); await f.runtimes.tick(); assert.equal(f.runtimes.all().length, 1);
    f.advance(50 * 60_000 + 5001); await f.runtimes.tick(); assert.equal(f.runtimes.all().length, 0); assert.match(f.notices.at(-1)!, /download.*超时/);
  } finally { f.cleanup(); }
});
test("任务结束事件去重，后台结果只在下一轮注入一次", async () => {
  const f = executionFixture();
  try {
    const c = f.contexts.chat("alice"), r = await f.runtimes.ensure(c);
    const task = { id: `t_${randomUUID()}`, name: "download", command: "curl", status: "completed" as const, startedAt: f.time(), deadlineAt: f.time() + 1000, endedAt: f.time() };
    f.runtimes.taskEvent(r.token, task, "done"); f.runtimes.taskEvent(r.token, task, "done");
    const pending = f.runtimes.pending(c.id); assert.equal(pending.length, 1);
    f.runtimes.acknowledge(pending.map(e => e.id)); assert.equal(f.runtimes.pending(c.id).length, 0);
    await f.runtimes.tick(); assert.equal(f.notices.length, 1);
  } finally { f.cleanup(); }
});

test("已完成任务不随容器重建重播；旧运行任务转为中断后仍报信，新任务同名也正常通知", async () => {
  const f = executionFixture();
  try {
    const c = f.contexts.chat("alice"), first = await f.runtimes.ensure(c);
    const done = { id: `t_${randomUUID()}`, name: "download", command: "curl", status: "completed" as const, startedAt: f.time(), deadlineAt: f.time() + 1000, endedAt: f.time() + 10 };
    f.advance(10);
    f.runtimes.taskEvent(first.token, done, "already reported");
    await f.runtimes.tick();
    assert.equal(f.notices.length, 1);
    f.runtimes.acknowledge(f.runtimes.pending(c.id).map(e => e.id));
    const running = { ...done, id: `t_${randomUUID()}`, status: "running" as const, endedAt: undefined };
    f.runtimes.taskEvent(first.token, running, "");
    writeFileSync(join(f.contexts.paths(c).tasks, "tasks.json"), JSON.stringify([done, running]));
    await f.runtimes.stop(c.id, "rebuild", true);
    f.advance(100);
    const second = await f.runtimes.ensure(c);
    f.tasks.push(done, { ...running, status: "interrupted", endedAt: f.time() });
    await f.runtimes.tick();
    assert.equal(f.notices.length, 2);
    assert.match(f.notices[1]!, /interrupted/);
    assert.ok(!f.notices[1]!.includes("already reported"));
    const newTask = { ...done, id: `t_${randomUUID()}`, startedAt: f.time(), deadlineAt: f.time() + 1000, endedAt: f.time() };
    f.runtimes.taskEvent(second.token, newTask, "new download");
    await f.runtimes.tick();
    assert.equal(f.notices.length, 3);
    assert.match(f.notices[2]!, /new download/);
  } finally { f.cleanup(); }
});

test("历史终态按建容器前的快照识别，不依赖时钟先后；重启认领保留基线并接收停机期间的新结果", async () => {
  const f = executionFixture();
  let restarted: RuntimeManager | undefined;
  try {
    const c = f.contexts.cron("alice", "checkin"), dir = f.contexts.paths(c).tasks;
    // A clock adjustment can make an old terminal timestamp look newer than the new runtime.
    const history = Array.from({ length: 105 }, () => ({ id: `t_${randomUUID()}`, name: "old checkin", command: "node", status: "completed" as const, startedAt: f.time(), deadlineAt: f.time() + 1000, endedAt: f.time() + 20 }));
    const running = { ...history[0]!, id: `t_${randomUUID()}`, status: "running" as const, endedAt: undefined };
    writeFileSync(join(dir, "tasks.json"), JSON.stringify([...history, running]));
    const runtime = await f.runtimes.ensure(c);
    assert.equal(runtime.inheritedTaskIds?.length, history.length);
    for (const task of history) f.runtimes.taskEvent(runtime.token, task, "old result");
    assert.equal(f.runtimes.pending(c.id).length, 0);
    f.runtimes.close();
    const current = { ...running, status: "completed" as const, endedAt: f.time() + 30 };
    writeFileSync(join(dir, "tasks.json"), JSON.stringify([...history, current]));
    restarted = new RuntimeManager(f.config, f.contexts, f.options);
    const adopted = await restarted.ensure(c);
    assert.equal(adopted.container, runtime.container);
    restarted.taskEvent(adopted.token, current, "finished during controller downtime");
    assert.equal(restarted.pending(c.id).length, 1);
    assert.match(restarted.pending(c.id)[0]!.text, /finished during controller downtime/);
  } finally { restarted?.close(); f.cleanup(); }
});
test("收到超时中的快照后仍接受最终退出事件，只在确认退出后通知", async () => {
  const f = executionFixture();
  try {
    const c = f.contexts.chat("alice"), r = await f.runtimes.ensure(c);
    const task = { id: `t_${randomUUID()}`, name: "slow", command: "node", status: "timeout" as const, startedAt: f.time(), deadlineAt: f.time() + 1000 };
    f.runtimes.taskEvent(r.token, task, ""); assert.equal(f.runtimes.pending(c.id).length, 0);
    f.runtimes.taskEvent(r.token, { ...task, endedAt: f.time() + 1001 }, "stopped");
    assert.equal(f.runtimes.all()[0]?.tasks[0]?.endedAt, f.time() + 1001);
    assert.equal(f.runtimes.pending(c.id).length, 1);
  } finally { f.cleanup(); }
});

for (const legacy of [false, true]) {
  test(`通知身份跨容器和控制面重启稳定，已消费结果不重新入队（${legacy ? "旧版事件键" : "当前事件键"}）`, async () => {
    const f = executionFixture();
    let restarted: RuntimeManager | undefined;
    try {
      const c = f.contexts.chat("alice"), first = await f.runtimes.ensure(c);
      const task = { id: `t_${randomUUID()}`, name: "download", command: "curl", status: "completed" as const, startedAt: f.time(), deadlineAt: f.time() + 1000, endedAt: f.time() };
      f.runtimes.taskEvent(first.token, task, "already delivered");
      await f.runtimes.tick();
      f.runtimes.acknowledge(f.runtimes.pending(c.id).map(e => e.id));
      await f.runtimes.stop(c.id, "recreate", true);
      f.runtimes.close();
      if (legacy) {
        const path = join(f.config.dataDir, "execution/events.json");
        const events = JSON.parse(readFileSync(path, "utf8"));
        events[0].id = `task:${first.container}:${task.id}:${task.status}`;
        writeFileSync(path, JSON.stringify(events));
      }
      restarted = new RuntimeManager(f.config, f.contexts, f.options);
      const second = await restarted.ensure(c);
      assert.equal(second.createdAt, task.endedAt, "用同毫秒场景验证稳定身份，而不依赖时间过滤");
      restarted.taskEvent(second.token, task, "should not replay");
      await restarted.tick();
      assert.equal(restarted.pending(c.id).length, 0);
      assert.equal(f.notices.length, 1);
    } finally { restarted?.close(); f.cleanup(); }
  });
}

test("任务数超过运行态缓存后，重复巡检仍只生成一条最终事件，渠道失败可继续投递原事件", async () => {
  const f = executionFixture();
  let fail = true;
  const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, notify: async (_user, text) => { if (fail) throw new Error("channel unavailable"); f.notices.push(text); } });
  try {
    const c = f.contexts.chat("alice"), runtime = await manager.ensure(c);
    const tasks = Array.from({ length: 105 }, (_, i) => ({ id: `t_${randomUUID()}`, name: `task ${i}`, command: "node", status: "completed" as const, startedAt: f.time(), deadlineAt: f.time() + 1000, endedAt: f.time() }));
    for (const task of tasks) manager.taskEvent(runtime.token, task, "done");
    f.tasks.push(...tasks);
    await manager.tick();
    // Delivery is deliberately detached from the deadline sweep. Let this failed
    // attempt drain before making the channel available for the next sweep.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.notices.length, 0);
    fail = false;
    await manager.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.notices.length, tasks.length);
    await manager.tick();
    const events = JSON.parse(readFileSync(join(f.config.dataDir, "execution/events.json"), "utf8"));
    assert.equal(events.length, tasks.length);
    assert.equal(f.notices.length, tasks.length, "重复快照和渠道重试都不能重建结果事件");
  } finally { manager.close(); f.cleanup(); }
});
test("通知渠道阻塞也不延迟容器截止回收", async () => {
  const f = executionFixture(); let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, notify: () => blocked });
  try {
    const c = f.contexts.chat("alice"); await manager.ensure(c);
    f.advance(50 * 60_000); await manager.tick();
    f.advance(10 * 60_000); await manager.tick();
    assert.equal(manager.all().length, 0);
  } finally { manager.close(); release(); await new Promise(resolve => setImmediate(resolve)); f.cleanup(); }
});
