import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExecutionArtifacts } from "../src/core/execution/artifacts.js";
import { RuntimeManager } from "../src/core/execution/runtime.js";
import { executionFixture } from "./helpers/execution.js";

test("回收只删除当前实例投影与 wrapper,重建不累积;用户持久数据保留", async () => {
  const f = executionFixture();
  try {
    const c = f.contexts.chat("alice"), p = f.contexts.paths(c);
    const first = await f.runtimes.ensure(c);
    const artifacts = new ExecutionArtifacts(f.config.dataDir);
    const projection = artifacts.projection(c.id, first.container.slice(-16));
    const wrapper = f.runtimes.wrapper(c, first);
    for (const dir of [p.work, p.home, p.sdk, p.tasks]) writeFileSync(join(dir, "keep"), "persist");
    assert.ok(existsSync(join(projection, "CLAUDE.md")));
    await f.runtimes.stop(c.id, "test", true);
    assert.equal(existsSync(projection), false); assert.equal(existsSync(wrapper), false);
    for (const dir of [p.work, p.home, p.sdk, p.tasks]) assert.equal(readFileSync(join(dir, "keep"), "utf8"), "persist");
    const second = await f.runtimes.ensure(c);
    assert.notEqual(first.container, second.container);
    assert.ok(existsSync(artifacts.projection(c.id, second.container.slice(-16))));
  } finally { f.cleanup(); }
});

test("Docker 尚未启动时配置报错也回收投影", async () => {
  const f = executionFixture(true);
  try {
    const c = f.contexts.chat("admin");
    const manager = new RuntimeManager({ ...f.config, srcDir: join(f.root, "absent") }, f.contexts, f.options);
    await assert.rejects(manager.ensure(c), /源码目录不存在/);
    assert.equal(f.calls.filter(call => call.args[0] === "run").length, 0);
    assert.equal(existsSync(join(f.config.dataDir, "execution/projections", c.id)), false);
  } finally { f.cleanup(); }
});

test("启动结果未知且无法确认移除时保留身份和投影,确认移除后再清理", async () => {
  const f = executionFixture();
  try {
    let removalFails = true;
    const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, docker: async (args, env) => {
      if (args[0] === "run") { await f.options.docker(args, env); throw new Error("launch timed out"); }
      if (args[0] === "rm" && removalFails) throw new Error("daemon unavailable");
      return f.options.docker(args, env);
    } });
    const c = f.contexts.chat("alice");
    await assert.rejects(manager.ensure(c), /launch timed out/);
    const r = manager.all()[0]!;
    const projection = new ExecutionArtifacts(f.config.dataDir).projection(c.id, r.container.slice(-16));
    assert.ok(existsSync(projection)); assert.ok(manager.resolve(r.token));
    removalFails = false;
    await manager.stop(c.id, "test", true);
    assert.equal(existsSync(projection), false); assert.equal(manager.all().length, 0);
  } finally { f.cleanup(); }
});

test("启动失败但已确认容器移除时立即回收投影", async () => {
  const f = executionFixture();
  try {
    const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, docker: async (args, env) => {
      if (args[0] === "run") throw new Error("launch failed");
      return f.options.docker(args, env);
    } });
    const c = f.contexts.chat("alice");
    await assert.rejects(manager.ensure(c), /launch failed/);
    assert.equal(existsSync(join(f.config.dataDir, "execution/projections", c.id)), false);
    assert.equal(manager.all().length, 0);
    assert.equal(manager.pending(c.id).length, 0, "启动失败由调用方报告,不叠加回收通知");
  } finally { f.cleanup(); }
});

test("重启对账清理孤儿,保护未认领容器和其他数据根", async () => {
  const f = executionFixture();
  try {
    const artifacts = new ExecutionArtifacts(f.config.dataDir);
    const orphan = f.contexts.chat("orphan"), mounted = f.contexts.chat("mounted"), rescue = f.contexts.chat("rescue");
    for (const c of [orphan, mounted, rescue]) mkdirSync(artifacts.projection(c.id, "a".repeat(16)), { recursive: true });
    const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, docker: async (args, env) => {
      if (args[0] === "ps") return "deadbeef\nfeedface";
      if (args[0] === "inspect" && args[1] === "--format") return [
        [{ Source: `/host/catman/execution/projections/${mounted.id}/${"a".repeat(16)}` }],
        [{ Source: `/host/catman/rescue/execution/projections/${rescue.id}/${"a".repeat(16)}` }],
      ].map(entry => JSON.stringify(entry)).join("\n");
      return f.options.docker(args, env);
    } });
    await manager.tick();
    assert.equal(existsSync(join(artifacts.projections, orphan.id)), false);
    assert.ok(existsSync(join(artifacts.projections, mounted.id)));
    assert.equal(existsSync(join(artifacts.projections, rescue.id)), false, "不同宿主数据根不能误保护同名上下文");
  } finally { f.cleanup(); }
});

for (const failure of ["unavailable", "partial", "malformed"]) test(`Docker 挂载快照 ${failure} 时不清理孤儿`, async () => {
  const f = executionFixture();
  try {
    const artifacts = new ExecutionArtifacts(f.config.dataDir), c = f.contexts.chat("alice");
    const projection = artifacts.projection(c.id, "a".repeat(16)); mkdirSync(projection, { recursive: true });
    const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, docker: async args => {
      if (failure === "unavailable") throw new Error("daemon unavailable");
      if (args[0] === "ps") return "deadbeef";
      return failure === "partial" ? "" : "{}";
    } });
    await manager.tick(); assert.ok(existsSync(projection));
  } finally { f.cleanup(); }
});

test("对账等待 Docker 期间创建的新实例受创建锁保护", async () => {
  const f = executionFixture();
  try {
    let onListing!: () => void, continueListing!: () => void, onRun!: () => void, continueRun!: () => void;
    const listing = new Promise<void>(resolve => { onListing = resolve; });
    const listingGate = new Promise<void>(resolve => { continueListing = resolve; });
    const running = new Promise<void>(resolve => { onRun = resolve; });
    const runGate = new Promise<void>(resolve => { continueRun = resolve; });
    const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, docker: async (args, env) => {
      if (args[0] === "ps") { onListing(); await listingGate; return ""; }
      if (args[0] === "run") { onRun(); await runGate; }
      return f.options.docker(args, env);
    } });
    const c = f.contexts.chat("alice"), orphan = f.contexts.chat("orphan");
    const artifacts = new ExecutionArtifacts(f.config.dataDir);
    mkdirSync(artifacts.projection(orphan.id, "a".repeat(16)), { recursive: true });
    const tick = manager.tick(); await listing;
    const ensure = manager.ensure(c); await running; continueListing(); await tick;
    assert.ok(existsSync(join(artifacts.projections, c.id)));
    assert.equal(existsSync(join(artifacts.projections, orphan.id)), false);
    continueRun(); await ensure;
  } finally { f.cleanup(); }
});

test("清理不跟随软链,保留未知名称与受保护上下文", () => {
  const f = executionFixture();
  try {
    const artifacts = new ExecutionArtifacts(f.config.dataDir), a = f.contexts.chat("alice"), b = f.contexts.chat("bob");
    const outside = join(f.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "keep"), "keep");
    mkdirSync(join(artifacts.projections, a.id), { recursive: true });
    symlinkSync(outside, artifacts.projection(a.id, "a".repeat(16)));
    mkdirSync(join(artifacts.projections, a.id, "unknown"));
    symlinkSync(outside, join(artifacts.projections, b.id));
    artifacts.collect(new Set());
    assert.equal(readFileSync(join(outside, "keep"), "utf8"), "keep");
    assert.ok(existsSync(join(artifacts.projections, a.id, "unknown")));
    assert.ok(existsSync(join(artifacts.projections, b.id)));
    assert.throws(() => artifacts.projection("../outside", "a".repeat(16)), /标识无效/);
  } finally { f.cleanup(); }
});
