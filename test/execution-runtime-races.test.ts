import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DockerFailure, RuntimeManager } from "../src/core/execution/runtime.js";
import { executionFixture } from "./helpers/execution.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("巡检发生在 docker run 创建容器前,不能撤销身份或删除待挂载的投影", async () => {
  const f = executionFixture(), entered = gate(), resume = gate();
  let creating: Promise<unknown> | undefined;
  try {
    const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, docker: async (args, env) => {
      if (args[0] === "run") { entered.resolve(); await resume.promise; }
      if ((args[0] === "exec" || args[0] === "inspect") && !f.containers.has(args[0] === "exec" ? args[1]! : args.at(-1)!)) {
        throw new DockerFailure("No such container", true);
      }
      return f.options.docker(args, env);
    } });
    const c = f.contexts.chat("alice");
    creating = manager.ensure(c); await entered.promise;
    const record = manager.all()[0]!;
    const projection = join(f.config.dataDir, "execution/projections", c.id, record.container.slice(-16));
    await manager.tick();
    assert.ok(manager.resolve(record.token), "容器尚在创建,身份必须保留");
    assert.ok(existsSync(projection), "Docker 尚未打开挂载源,不能删掉投影");
    assert.equal(f.notices.length, 0);
    resume.resolve(); await creating;
    assert.equal(manager.all()[0]!.container, record.container);
  } finally { resume.resolve(); await creating?.catch(() => {}); f.cleanup(); }
});

test("创建途中主动回收与后续重建按顺序执行,不能提前删除挂载目录", async () => {
  const f = executionFixture(), entered = gate(), resume = gate();
  let creating: Promise<unknown> | undefined, stopping: Promise<void> | undefined, rebuilding: Promise<unknown> | undefined;
  try {
    let first = true;
    const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, docker: async (args, env) => {
      if (args[0] === "run" && first) { first = false; entered.resolve(); await resume.promise; }
      return f.options.docker(args, env);
    } });
    const c = f.contexts.chat("alice");
    creating = manager.ensure(c); await entered.promise;
    const record = manager.all()[0]!;
    stopping = manager.stop(c.id, "manual", true);
    rebuilding = manager.ensure(c);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.filter(c => c.args[0] === "rm").length, 0);
    assert.ok(existsSync(join(f.config.dataDir, "execution/projections", c.id, record.container.slice(-16))));
    resume.resolve(); await creating; await stopping; await rebuilding;
    const replacement = manager.all()[0]!;
    assert.notEqual(record.container, replacement.container);
    assert.ok(f.containers.has(replacement.container)); assert.equal(f.containers.has(record.container), false);
    assert.equal(f.calls.filter(c => c.args[0] === "run").length, 2);
  } finally { resume.resolve(); await Promise.allSettled([creating, stopping, rebuilding]); f.cleanup(); }
});

for (const result of ["stopped", "missing"]) test(`巡检等待旧容器 inspect 时完成重建,过期 ${result} 结果不能影响新实例`, async () => {
  const f = executionFixture(), entered = gate(), resume = gate();
  let ticking: Promise<void> | undefined;
  try {
    let probe = false, inspected = false;
    const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, docker: async (args, env) => {
      if (probe && args.includes("/processes")) throw new Error("worker unavailable");
      if (probe && args[0] === "inspect" && args[1] === "-f" && !inspected) {
        inspected = true; entered.resolve(); await resume.promise;
        if (result === "missing") throw new DockerFailure("No such container", true);
        return "false";
      }
      return f.options.docker(args, env);
    } });
    const c = f.contexts.chat("alice"), old = await manager.ensure(c);
    f.containers.delete(old.container); probe = true;
    ticking = manager.tick(); await entered.promise;
    const replacement = await manager.ensure(c);
    let stoppedNewAgent = false;
    manager.onStop(c.id, () => { stoppedNewAgent = true; });
    const notices = manager.pending(c.id).length;
    resume.resolve(); await ticking;
    assert.ok(manager.resolve(replacement.token), "过期巡检不得回收新代际");
    assert.ok(f.containers.has(replacement.container));
    assert.equal(stoppedNewAgent, false);
    assert.equal(manager.pending(c.id).length, notices, "过期结果不重复发送旧实例回收通知");
  } finally { resume.resolve(); await ticking?.catch(() => {}); f.cleanup(); }
});

test("巡检等待进程快照时原实例被重建,旧的空闲快照不能回收新实例", async () => {
  const f = executionFixture(), entered = gate(), resume = gate();
  let ticking: Promise<void> | undefined;
  try {
    const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, docker: async (args, env) => {
      if (args.includes("/processes")) {
        entered.resolve(); await resume.promise;
        return JSON.stringify({ tasks: [], processes: [], agents: [], unmanaged: [] });
      }
      return f.options.docker(args, env);
    } });
    const c = f.contexts.chat("alice"); await manager.ensure(c); f.advance(3600_000);
    ticking = manager.tick(); await entered.promise;
    await manager.stop(c.id, "recreate", true);
    const replacement = await manager.ensure(c);
    resume.resolve(); await ticking;
    assert.ok(manager.resolve(replacement.token)); assert.ok(f.containers.has(replacement.container));
  } finally { resume.resolve(); await ticking?.catch(() => {}); f.cleanup(); }
});

test("容器移除仍在等待 Docker 确认时,巡检不能提前删除身份与挂载源", async () => {
  const f = executionFixture(), entered = gate(), resume = gate();
  let stopping: Promise<void> | undefined;
  try {
    const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, docker: async (args, env) => {
      if (args[0] === "rm") { entered.resolve(); await resume.promise; }
      if (args.includes("/processes")) throw new Error("worker stopping");
      if (args[0] === "inspect" && args[1] === "-f") throw new DockerFailure("No such container", true);
      return f.options.docker(args, env);
    } });
    const c = f.contexts.chat("alice"), record = await manager.ensure(c);
    stopping = manager.stop(c.id, "manual", true); await entered.promise;
    await manager.tick();
    assert.ok(manager.resolve(record.token));
    assert.ok(existsSync(join(f.config.dataDir, "execution/projections", c.id, record.container.slice(-16))));
    assert.equal(manager.pending(c.id).length, 0);
    resume.resolve(); await stopping;
    assert.equal(manager.resolve(record.token), undefined);
  } finally { resume.resolve(); await stopping?.catch(() => {}); f.cleanup(); }
});
