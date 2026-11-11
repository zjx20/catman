import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { executionFixture } from "./helpers/execution.js";
import { OpsManager } from "../src/core/execution/ops.js";
import { parseOpsMounts } from "../src/core/execution/ops-config.js";
import { installOpsConnection } from "../src/core/execution/ops-cli.js";
import { RuntimeManager } from "../src/core/execution/runtime.js";

function fixture() {
  const f = executionFixture(true);
  const config = { ...f.config, ops: { image: "catman-ops:test", mounts: parseOpsMounts('["/opt/services","/mnt/usb"]'), dockerSocket: true, memory: "256m", maxActive: 1 } };
  let admin = true;
  const notices: string[] = [];
  const options = { isAdmin: () => admin, notify: (_user: string, _context: string, text: string) => { notices.push(text); }, now: f.time,
    createKeys: async (dir: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "client_key"), "private-key-secret"); writeFileSync(join(dir, "host_key.pub"), "ssh-ed25519 AAAATEST host"); } };
  const ops = new OpsManager(config, f.contexts, f.runtimes, options);
  return { ...f, config, ops, notices, opsOptions: options, demote: () => { admin = false; }, cleanup: () => { ops.close(); f.cleanup(); } };
}

test("部署运维目录支持多个完整目录和只读映射，拒绝危险或重叠目标", () => {
  assert.deepEqual(parseOpsMounts('["/opt/services","/mnt/usb"]'), [{ source: "/opt/services", target: "/opt/services", readOnly: false }, { source: "/mnt/usb", target: "/mnt/usb", readOnly: false }]);
  assert.deepEqual(parseOpsMounts('[{"source":"/host/config","target":"/config","readOnly":true}]'), [{ source: "/host/config", target: "/config", readOnly: true }]);
  for (const bad of ['{}', '["relative"]', '["/opt/../etc"]', '["/tmp"]', '["/usr/bin"]', '["/"]', '["/opt/x,readonly"]', '["/opt/services","/opt/services/a"]', '[{"source":"/opt/services","readOnly":"false"}]']) assert.throws(() => parseOpsMounts(bad), Error, bad);
});

test("申请不启动容器；硬授权冻结部署挂载，系统清单不泄露私钥", async () => {
  const f = fixture();
  try {
    const parent = await f.runtimes.ensure(f.contexts.chat("admin"));
    const request = await f.ops.request(parent, "排查宿主服务");
    assert.equal(f.calls.filter(c => c.args[0] === "run").length, 1);
    assert.match(f.notices[0]!, /\/授权 o_/);
    await assert.rejects(f.ops.connection(parent), /尚未/);
    await assert.rejects(f.ops.requireHostAccess(parent), /尚未/);
    await assert.rejects(f.ops.grant("other-admin", request.id), /没有属于/);
    const { record: active } = await f.ops.grant("admin", request.id);
    assert.equal(active.state, "active");
    await f.ops.requireHostAccess(parent);
    const call = f.calls.filter(c => c.args[0] === "run")[1]!;
    assert.ok(call.args.includes("type=bind,src=/opt/services,dst=/opt/services"));
    assert.ok(call.args.includes("type=bind,src=/mnt/usb,dst=/mnt/usb"));
    assert.ok(call.args.includes("type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock"));
    assert.ok(!call.args.includes("--privileged"));
    assert.ok(!call.args.includes("-p"));
    const repeated = await f.ops.grant("admin", request.id);
    assert.equal(repeated.record.container, active.container); assert.equal(repeated.newlyGranted, false);
    assert.equal(f.calls.filter(c => c.args[0] === "run").length, 2);
    const description = f.ops.description(active);
    assert.match(description, /挂载：\n\n- `/);
    assert.ok(description.includes(`\n\n\`\`\`text\n/运维回收 ${active.id}\n\`\`\``));
    for (const expected of ["/opt/services", "/mnt/usb", "/var/run/docker.sock", "root", "workspace", "SSH", "同生共死"]) assert.ok(description.includes(expected));
    assert.ok(!description.includes("private-key-secret"));
    assert.ok(description.includes(`catman-ops exec -- docker exec --user ${statSync(f.config.srcDir).uid} '${f.config.containerName}' git -C '${f.config.srcDir}' fetch --prune --no-recurse-submodules origin`));
    assert.ok(f.calls.some(c => c.args[0] === "network" && c.args[1] === "create" && c.args.includes("--internal")));
  } finally { f.cleanup(); }
});

test("凭证只给已授权的原容器；SSH 配置固定主机密钥，工具输出不含私钥", async () => {
  const f = fixture(); let temp: string | undefined;
  try {
    const context = f.contexts.chat("admin"), parent = await f.runtimes.ensure(context);
    const request = await f.ops.request(parent, "检查配置"); await f.ops.grant("admin", request.id);
    const other = await f.runtimes.ensure(f.contexts.chat("admin"));
    await assert.rejects(f.ops.connection(other), /尚未/);
    const connection = await f.ops.connection(parent), installed = installOpsConnection(connection); temp = dirname(installed.configPath);
    assert.ok(!installed.text.includes("private-key-secret"));
    assert.match(installed.text, /ssh -F/); assert.match(installed.text, /scp -F/);
    assert.match(readFileSync(installed.configPath, "utf8"), /StrictHostKeyChecking yes/);
    assert.equal(statSync(join(temp, "identity")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(temp, "identity"), "utf8"), "private-key-secret");
    await f.runtimes.stop(context.id, "回收");
    await assert.rejects(f.ops.connection(parent), /失效/);
    assert.equal(f.ops.list("admin").length, 0);
    const replacement = await f.runtimes.ensure(context);
    await assert.rejects(f.ops.connection(replacement), /尚未/);
    const removals = f.calls.filter(c => c.args[0] === "rm");
    assert.equal(removals[0]?.args.at(-1), request.container, "先终止运维进程，再终止父容器");
    assert.equal(removals[1]?.args.at(-1), parent.container);
  } finally { if (temp) rmSync(temp, { recursive: true, force: true }); f.cleanup(); }
});

test("运维没有独立时限；待授权和运行中阻止空容器快速回收，原闲置期限仍回收父子", async () => {
  const f = fixture();
  try {
    const parent = await f.runtimes.ensure(f.contexts.chat("admin"));
    const request = await f.ops.request(parent, "长任务"); f.emptySnapshot();
    f.advance(31_000); await f.runtimes.tick(); assert.equal(f.runtimes.all().length, 1);
    await f.ops.grant("admin", request.id);
    f.advance(31_000); await f.runtimes.tick(); assert.equal(f.runtimes.all().length, 1);
    f.advance(7 * 24 * 3600_000); await f.ops.tick(); assert.equal(f.ops.list("admin").length, 1);
    await f.runtimes.tick(); assert.equal(f.ops.list("admin").length, 0); assert.equal(f.runtimes.all().length, 0);
  } finally { f.cleanup(); }
});

test("控制服务重启保留原父容器授权，管理员降权回收运维环境", async () => {
  const f = fixture(); let restarted: OpsManager | undefined; let manager: RuntimeManager | undefined;
  try {
    const parent = await f.runtimes.ensure(f.contexts.chat("admin"));
    const request = await f.ops.request(parent, "排查"); await f.ops.grant("admin", request.id); f.ops.close();
    manager = new RuntimeManager(f.config, f.contexts, f.options);
    restarted = new OpsManager(f.config, f.contexts, manager, f.opsOptions);
    await restarted.tick(); assert.equal((await restarted.connection(parent)).id, request.id);
    f.demote(); await restarted.tick(); assert.equal(f.containers.has(request.container), false);
    await assert.rejects(restarted.connection(parent), /管理员/);
  } finally { restarted?.close(); manager?.close(); f.cleanup(); }
});

test("部署变更不能悄悄扩大已有申请，cron 和非管理员不能申请", async () => {
  const f = fixture();
  try {
    const parent = await f.runtimes.ensure(f.contexts.chat("admin"));
    const request = await f.ops.request(parent, "排查");
    f.config.ops.mounts.push({ source: "/opt/extra", target: "/extra", readOnly: false });
    await assert.rejects(f.ops.grant("admin", request.id), /配置已经变化/);
    assert.equal(f.calls.filter(c => c.args[0] === "run").length, 1);
    const cron = await f.runtimes.ensure(f.contexts.cron("admin", "job"));
    await assert.rejects(f.ops.request(cron, "后台提权"), /聊天会话/);
    f.demote(); await assert.rejects(f.ops.request(parent, "提权"), /管理员/);
  } finally { f.cleanup(); }
});

test("同用户不同会话不共享授权，部署并发上限机械生效", async () => {
  const f = fixture();
  try {
    const a = await f.runtimes.ensure(f.contexts.chat("admin")), b = await f.runtimes.ensure(f.contexts.chat("admin"));
    const ar = await f.ops.request(a, "A"), br = await f.ops.request(b, "B");
    await f.ops.grant("admin", ar.id);
    await assert.rejects(f.ops.grant("admin", br.id), /数量已达/);
    await assert.rejects(f.ops.connection(b), /尚未/);
    await f.ops.revoke("admin", ar.id); await f.ops.grant("admin", br.id);
    assert.equal(f.runtimes.all().length, 2, "手动回收运维环境保留主会话");
  } finally { f.cleanup(); }
});

test("父容器外部消失时巡检回收依附环境", async () => {
  const f = fixture();
  try {
    const parent = await f.runtimes.ensure(f.contexts.chat("admin"));
    const request = await f.ops.request(parent, "排查"); await f.ops.grant("admin", request.id);
    f.containers.delete(parent.container); await f.ops.tick();
    assert.equal(f.ops.list("admin").length, 0); assert.equal(f.containers.has(request.container), false);
  } finally { f.cleanup(); }
});

test("授权与父容器回收并发时不会遗留运维容器或把权限传到新实例", async () => {
  const f = fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  f.ops.close();
  const ops = new OpsManager(f.config, f.contexts, f.runtimes, { ...f.opsOptions, createKeys: async dir => { entered(); await gate; await f.opsOptions.createKeys(dir); } });
  try {
    const context = f.contexts.chat("admin"), parent = await f.runtimes.ensure(context), request = await ops.request(parent, "排查");
    const grant = ops.grant("admin", request.id); await started;
    const stop = f.runtimes.stop(context.id, "回收"); release(); await Promise.all([grant, stop]);
    assert.equal(ops.list("admin").length, 0); assert.equal(f.containers.has(request.container), false);
    const next = await f.runtimes.ensure(context); await assert.rejects(ops.connection(next), /尚未/);
  } finally { release(); ops.close(); f.cleanup(); }
});

test("无法确认运维容器已终止时保留父容器与清理记录，恢复后重试回收", async () => {
  const f = fixture(); f.ops.close(); let fail = false;
  const manager = new RuntimeManager(f.config, f.contexts, { ...f.options, docker: async (args, env) => {
    if (fail && args[0] === "rm" && args.at(-1)?.startsWith("catman-ops-")) throw new Error("daemon unavailable");
    return f.options.docker(args, env);
  } });
  const ops = new OpsManager(f.config, f.contexts, manager, f.opsOptions);
  try {
    const context = f.contexts.chat("admin"), parent = await manager.ensure(context), request = await ops.request(parent, "排查");
    await ops.grant("admin", request.id); fail = true;
    await assert.rejects(manager.stop(context.id, "停止"), /daemon unavailable/);
    assert.ok(manager.resolve(parent.token)); assert.ok(f.containers.has(request.container));
    assert.equal(ops.list("admin")[0]?.state, "revoking");
    assert.ok(existsSync(join(f.config.dataDir, "execution/ops", request.id, "client_key")));
    await assert.rejects(ops.connection(parent), /尚未/);
    fail = false; await manager.stop(context.id, "重试");
    assert.equal(manager.all().length, 0); assert.equal(ops.list("admin").length, 0);
    assert.ok(!existsSync(join(f.config.dataDir, "execution/ops", request.id)));
  } finally { ops.close(); manager.close(); f.cleanup(); }
});

test("仅目录运维不会获得 Docker 权限或借自进化制备扩大权限", async () => {
  const f = fixture(); f.config.ops.dockerSocket = false;
  try {
    const parent = await f.runtimes.ensure(f.contexts.chat("admin")), request = await f.ops.request(parent, "目录排查");
    const { record } = await f.ops.grant("admin", request.id);
    assert.match(f.ops.description(record), /Docker socket：未挂载/);
    assert.doesNotMatch(f.ops.description(record), /自进化源码拉取|docker exec/);
    assert.ok(!f.calls.filter(c => c.args[0] === "run")[1]!.args.some(a => a.includes("docker.sock")));
    await assert.rejects(f.ops.requireHostAccess(parent), /包含 Docker socket/);
  } finally { f.cleanup(); }
});

test("源码拉取命令按当前部署生成，容器名和路径保留为完整参数，不解释 shell 内容", async () => {
  const f = fixture();
  try {
    f.config.containerName = "catman-primary-custom";
    f.config.srcDir = join(f.root, "source '$(touch injected)' with spaces"); mkdirSync(f.config.srcDir);
    const ops = new OpsManager(f.config, f.contexts, f.runtimes, f.opsOptions);
    try {
      const parent = await f.runtimes.ensure(f.contexts.chat("admin"));
      const request = await ops.request(parent, "通过 SSH 拉取源码");
      const command = ops.description(request).split("\n").find(line => line.startsWith("catman-ops exec --")); assert.ok(command);
      const bin = join(f.root, "bin"); mkdirSync(bin);
      writeFileSync(join(bin, "catman-ops"), '#!/bin/sh\nprintf "%s\\0" "$@"\n', { mode: 0o700 });
      const result = execFileSync("sh", ["-c", command], { cwd: f.root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      assert.deepEqual(result.toString().split("\0").slice(0, -1), ["exec", "--", "docker", "exec", "--user", String(statSync(f.config.srcDir).uid), "catman-primary-custom", "git", "-C", f.config.srcDir, "fetch", "--prune", "--no-recurse-submodules", "origin"]);
      assert.equal(existsSync(join(f.root, "injected")), false);
    } finally { ops.close(); }
  } finally { f.cleanup(); }
});

test("部署配置收紧后不再发凭证，巡检回收旧授权且保留主会话", async () => {
  const f = fixture();
  try {
    const parent = await f.runtimes.ensure(f.contexts.chat("admin")), request = await f.ops.request(parent, "排查");
    await f.ops.grant("admin", request.id); f.config.ops.dockerSocket = false;
    await assert.rejects(f.ops.connection(parent), /配置已经变化/);
    await assert.rejects(f.ops.grant("admin", request.id), /配置已经变化/);
    await f.ops.tick(); assert.equal(f.ops.list("admin").length, 0); assert.equal(f.runtimes.all().length, 1);
  } finally { f.cleanup(); }
});
