import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { listSessions, encodeProjectDir } from "../src/core/transcript.js";
import { ContextStore, hostPath, readTenantFile, requireExecutionLayout } from "../src/core/execution/contexts.js";
import { executionFixture } from "./helpers/execution.js";

test("聊天按 session 隔离，cron 按任务复用，两者继承同一 owner home", () => {
  const f = executionFixture();
  try {
    const a = f.contexts.chat("alice"), b = f.contexts.chat("alice"), other = f.contexts.chat("bob");
    const cron = f.contexts.cron("alice", "job1");
    assert.notEqual(a.id, b.id); assert.notEqual(f.contexts.paths(a).work, f.contexts.paths(b).work);
    assert.equal(f.contexts.paths(a).home, f.contexts.paths(cron).home);
    assert.notEqual(f.contexts.paths(a).home, f.contexts.paths(other).home);
    assert.equal(f.contexts.cron("alice", "job1").id, cron.id);
    assert.notEqual(f.contexts.cron("bob", "job1").id, cron.id);
    assert.throws(() => f.contexts.chat("bob", a.sdkSessionId), /不属于/);
    assert.equal(new ContextStore(f.config.dataDir).chat("alice", a.sdkSessionId).id, a.id);
  } finally { f.cleanup(); }
});
test("宿主路径只由控制面映射，不接受越界", () => {
  assert.equal(hostPath("/data", "/host/data", "/data/tenants/a"), "/host/data/tenants/a");
  for (const path of ["/etc/passwd", "/data/../etc", "/data-other/secrets"]) assert.throws(() => hostPath("/data", "/host/data", path));
});
test("个人配置不能通过软链让控制面读取别人的文件", () => {
  const f = executionFixture();
  try {
    const c = f.contexts.chat("alice"), p = f.contexts.paths(c);
    writeFileSync(join(f.config.dataDir, "secret"), "hidden");
    symlinkSync(join(f.config.dataDir, "secret"), join(p.home, "mcp.json"));
    assert.throws(() => readTenantFile(p.home, "mcp.json"), /越出/);
  } finally { f.cleanup(); }
});
test("旧数据必须显式迁移，不能静默创建一套空状态", () => {
  const f = executionFixture();
  try {
    const old = join(f.root, "old"); mkdirSync(old); writeFileSync(join(old, "users.json"), "{}");
    assert.throws(() => requireExecutionLayout(old), /迁移/);
    assert.equal(existsSync(join(old, "execution/schema.json")), false);
    const fresh = join(f.root, "fresh"); requireExecutionLayout(fresh); requireExecutionLayout(fresh);
    assert.equal(existsSync(join(fresh, "execution/schema.json")), true);
  } finally { f.cleanup(); }
});
test("SDK 会话软链不能通过控制面泄露另一个用户的记录", () => {
  const f = executionFixture();
  try {
    const a = f.contexts.chat("alice"), b = f.contexts.chat("bob");
    const ap = f.contexts.paths(a), bp = f.contexts.paths(b);
    const aProject = join(ap.sdk, "projects", encodeProjectDir(ap.work));
    const bProject = join(bp.sdk, "projects", encodeProjectDir(bp.work));
    mkdirSync(aProject, { recursive: true }); mkdirSync(bProject, { recursive: true });
    const secret = join(bProject, `${b.sdkSessionId}.jsonl`);
    writeFileSync(secret, JSON.stringify({ type: "user", message: { role: "user", content: "bob-private" } }) + "\n");
    symlinkSync(secret, join(aProject, `${a.sdkSessionId}.jsonl`));
    assert.deepEqual(listSessions(ap.sdk, encodeProjectDir(ap.work)), []);
  } finally { f.cleanup(); }
});
test("个人配置拒绝 FIFO 和超大文件，不让读取阻塞控制服务", () => {
  const f = executionFixture();
  try {
    const p = f.contexts.paths(f.contexts.chat("alice"));
    execFileSync("mkfifo", [join(p.home, "mcp.json")]);
    assert.throws(() => readTenantFile(p.home, "mcp.json"), /普通文件/);
    writeFileSync(join(p.home, "big"), Buffer.alloc(1024 * 1024 + 1));
    assert.throws(() => readTenantFile(p.home, "big"), /大小/);
  } finally { f.cleanup(); }
});
