import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TaskSupervisor, taskRequest } from "../src/core/execution/task-supervisor.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("等待任务超时"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
test("后台任务保留调用 cwd 和环境，不继承短期或管理员令牌", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-task-")); const events: string[] = [];
  const manager = new TaskSupervisor({ dir, socket: join(dir, "rpc.sock"), killGraceMs: 20, onEvent: task => { events.push(task.status); } });
  try {
    await manager.listen();
    const task = await taskRequest("/tasks", "POST", { cmd: [process.execPath, "-e", 'require("fs").writeFileSync("result.json", JSON.stringify({cwd:process.cwd(),value:process.env.PROBE,admin:process.env.CATMAN_ADMIN_TOKEN,turn:process.env.CATMAN_SESSION_TOKEN}))'], cwd: dir,
      env: { PROBE: "owner-context", CATMAN_ADMIN_TOKEN: "never", CATMAN_SESSION_TOKEN: "never" }, timeoutMs: 3000 }, join(dir, "rpc.sock"));
    await waitFor(() => manager.list()[0]?.endedAt !== undefined);
    const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    assert.deepEqual(result, { cwd: dir, value: "owner-context" });
    assert.equal(manager.list()[0]?.status, "completed"); assert.equal(task.status, "running"); assert.deepEqual(events, ["running", "completed"]);
  } finally { await manager.close(); await new Promise(resolve => setTimeout(resolve, 30)); rmSync(dir, { recursive: true, force: true }); }
});
test("超时不可缺省或无限；任务忽略 SIGTERM 也会被杀", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-task-")); const manager = new TaskSupervisor({ dir, killGraceMs: 20 });
  try {
    const input = { cmd: [process.execPath, "-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},100)'], cwd: dir };
    for (const timeoutMs of [undefined, 0, Infinity, 86400_001, -1]) assert.throws(() => manager.start({ ...input, timeoutMs: timeoutMs as number }), /timeoutMs/);
    manager.start({ ...input, timeoutMs: 200 });
    await waitFor(() => manager.list()[0]?.endedAt !== undefined);
    assert.equal(manager.list()[0]?.status, "timeout");
  } finally { await manager.close(); await new Promise(resolve => setTimeout(resolve, 30)); rmSync(dir, { recursive: true, force: true }); }
});
test("停止整个任务进程组，子进程不能继续生成文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-task-")); const manager = new TaskSupervisor({ dir, killGraceMs: 20 });
  try {
    const child = join(dir, "child.js");
    writeFileSync(child, 'setTimeout(()=>require("fs").writeFileSync(process.argv[2],"leaked"),800);');
    const task = manager.start({ cmd: ["sh", "-c", 'node "$1" "$2" & wait', "sh", child, join(dir, "leaked")], cwd: dir, timeoutMs: 200 });
    await waitFor(() => manager.list()[0]?.endedAt !== undefined);
    await new Promise(resolve => setTimeout(resolve, 850));
    assert.equal(manager.list().find(t => t.id === task.id)?.status, "timeout"); assert.equal(existsSync(join(dir, "leaked")), false);
  } finally { await manager.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("执行环境重启只认定旧任务已中断，不重置 deadline 或自动重跑", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-task-"));
  try {
    const deadlineAt = Date.now() + 1000;
    writeFileSync(join(dir, "tasks.json"), JSON.stringify([{ id: "old", name: "old", command: "old", status: "running", startedAt: Date.now(), deadlineAt, pid: 99999 }]));
    const manager = new TaskSupervisor({ dir });
    assert.equal(manager.list()[0]?.status, "interrupted"); assert.equal(manager.list()[0]?.deadlineAt, deadlineAt); assert.equal(manager.list()[0]?.pid, undefined);
    await manager.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("控制面预分配的任务身份贯穿事件且不能重复启动", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-task-id-"));
  const events: string[] = [], manager = new TaskSupervisor({ dir, onEvent: task => { events.push(task.id); } });
  try {
    const id = `t_${randomUUID()}`, request = { id, cmd: [process.execPath, "-e", "process.exit(0)"], cwd: dir, timeoutMs: 3000 };
    assert.equal(manager.start(request).id, id);
    await waitFor(() => manager.list()[0]?.endedAt !== undefined);
    assert.deepEqual(events, [id, id]);
    assert.throws(() => manager.start(request), /任务.*存在/);
    assert.throws(() => manager.start({ ...request, id: "../outside" }), /任务.*无效/);
  } finally { await manager.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("CLI 在登记完成前快速退出，仍转发真实退出码而不是误报成功", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-fast-cli-"));
  const socket = join(dir, "rpc.sock"); const manager = new TaskSupervisor({ dir, socket, killGraceMs: 20 });
  try {
    await manager.listen();
    const cli = fileURLToPath(new URL("../src/core/execution/task-cli.ts", import.meta.url));
    await assert.rejects(promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "exec", "--", process.execPath, "-e", "process.exit(7)"], {
      env: { ...process.env, CATMAN_TASK_SOCKET: socket, CATMAN_AGENT_ID: randomUUID() }, timeout: 5000,
    }), (error: unknown) => (error as { code?: number }).code === 7);
  } finally { await manager.close(); rmSync(dir, { recursive: true, force: true }); }
});
