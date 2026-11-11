import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, relative, resolve } from "node:path";
import { loadConfig } from "../../src/config.js";
import { Agent } from "../../src/core/agent.js";
import { CronStore } from "../../src/core/cron/store.js";
import { CapabilityBroker } from "../../src/core/execution/broker.js";
import { ContextStore, type ExecutionContext } from "../../src/core/execution/contexts.js";
import { ContextScriptRunner } from "../../src/core/execution/cron-runner.js";
import { RuntimeManager, dockerCommand, type RuntimeRecord } from "../../src/core/execution/runtime.js";
import type { TaskRecord } from "../../src/core/execution/task-supervisor.js";
import { TurnTokens } from "../../src/core/turn-tokens.js";
import { ExecutionApi } from "../../src/dashboard/api-execution.js";
import { OpsManager } from "../../src/core/execution/ops.js";
import { parseOpsMounts } from "../../src/core/execution/ops-config.js";
import { INSTRUCTION_PROBE_PROMPT, instructionFixture, isInstructionProbeRequest, verifyInstructionRequest } from "../../src/core/execution/instruction-check.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(get: () => Promise<T>, ready: (value: T) => boolean, label: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await get(); if (ready(value)) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await pause(100);
  }
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "0.0.0.0", resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== "string"); return addr.port;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

/** Opt-in: uses the actual runtime image, daemon, mount namespace, CLI and process groups.
 * No production data/credentials, external models, or existing application containers are used.
 * Run after building docker/Dockerfile as catman-env:integration (or set CATMAN_DOCKER_IMAGE).
 */
test("Docker 执行上下文端到端", { timeout: 240_000 }, async t => {
  const repo = resolve(import.meta.dirname, "../..");
  const suffix = randomBytes(4).toString("hex");
  const root = join(repo, "data", `docker-${suffix}`);
  const release = join(root, "release");
  const native = `claude-agent-sdk-linux-${process.arch}`;
  const containers = new Set<string>(); const notices: Array<{ owner: string; text: string }> = [];
  const managers: RuntimeManager[] = []; const agents: Agent[] = [];
  const savedEnv = { ...process.env };
  let networkCreated = false, connected = false, self: string | undefined;
  let upstream: Server | undefined, server: Server | undefined, broker: CapabilityBroker | undefined;
  let beforeRun: ((args: string[]) => Promise<void>) | undefined;
  const docker = async (args: string[], env?: NodeJS.ProcessEnv) => {
    if (args[0] === "run") { containers.add(args[args.indexOf("--name") + 1]!); await beforeRun?.(args); }
    return dockerCommand(args, env);
  };
  t.after(async () => {
    for (const agent of agents) agent.close();
    for (const manager of managers) manager.close();
    for (const name of containers) await dockerCommand(["rm", "-f", name]).catch(() => {});
    if (broker) await broker.close();
    if (server) await close(server); if (upstream) await close(upstream);
    if (connected) await dockerCommand(["network", "disconnect", "mynet", self!]);
    if (networkCreated) await dockerCommand(["network", "rm", "mynet"]);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(root, { recursive: true, force: true });
  });
  await dockerCommand(["version", "--format", "{{.Server.Version}}"]);
  const image = process.env.CATMAN_DOCKER_IMAGE || "catman-env:integration";
  await dockerCommand(["image", "inspect", image]);
  mkdirSync(join(release, "node_modules/@anthropic-ai", native), { recursive: true });
  cpSync(join(repo, "dist"), join(release, "dist"), { recursive: true });
  copyFileSync(join(repo, "node_modules/@anthropic-ai", native, "claude"), join(release, "node_modules/@anthropic-ai", native, "claude"));
  writeFileSync(join(release, "package.json"), '{"type":"module"}');
  // Docker-outside-of-Docker bind sources belong to the daemon host, not this container.
  let hostRoot = process.env.CATMAN_DOCKER_HOST_ROOT;
  const containerId = process.env.CATMAN_DOCKER_CONTROLLER || process.env.HOSTNAME;
  if (containerId) {
    try {
      const info = JSON.parse(await dockerCommand(["inspect", containerId]))[0]; self = info.Id;
      const mount = info.Mounts.filter((m: { Destination: string }) => repo === m.Destination || repo.startsWith(`${m.Destination}/`))
        .sort((a: { Destination: string }, b: { Destination: string }) => b.Destination.length - a.Destination.length)[0];
      hostRoot ??= mount ? join(mount.Source, relative(mount.Destination, repo)) : undefined;
    } catch { /* On a native host there is no controller container to inspect. */ }
  }
  hostRoot ??= repo;
  try { await dockerCommand(["network", "inspect", "mynet"]); }
  catch { await dockerCommand(["network", "create", "mynet"]); networkCreated = true; }
  const alias = `catman-integration-${suffix}`;
  if (self) {
    const info = JSON.parse(await dockerCommand(["inspect", self]))[0];
    if (!info.NetworkSettings.Networks.mynet) {
      await dockerCommand(["network", "connect", "--alias", alias, "mynet", self]); connected = true;
    }
  }
  const controlHost = self ? (connected ? alias : JSON.parse(await dockerCommand(["inspect", self]))[0].NetworkSettings.Networks.mynet.IPAddress) : "host.docker.internal";
  // Replace all model credentials with sentinels for the complete CLI -> broker -> upstream path.
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete process.env[key];
  process.env.CATMAN_RELEASE_LINK = release; process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.ANTHROPIC_API_KEY = "controller-model-secret-for-integration";
  process.env.CATMAN_ADMIN_TOKEN = "controller-admin-secret-for-integration";
  process.env.CATMAN_IPC_SECRET = "controller-ipc-secret-for-integration";
  process.env.CATMAN_HOST_ONLY_PROBE = "controller-host-only-for-integration";
  const seen: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: any }> = [];
  let modelTool: { command: string; run_in_background?: boolean } | { name: string; input: unknown } | undefined;
  let holdModel = false, mcpSession = 0;
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    let input: any; try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    seen.push({ path: req.url!, headers: { ...req.headers }, body: input });
    if (req.url?.includes("count_tokens")) { res.setHeader("content-type", "application/json"); res.end('{"input_tokens":5}'); return; }
    if (req.url?.startsWith("/v1/messages")) {
      if (holdModel) { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); return; }
      const tool = modelTool; modelTool = undefined;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, value: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
      send("message_start", { type: "message_start", message: { id: `msg_${seen.length}`, type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
      if (tool) {
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `tool_${seen.length}`, name: "name" in tool ? tool.name : "Bash", input: {} } });
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify("input" in tool ? tool.input : { ...tool, description: "Docker background probe" }) } });
      } else {
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "integration reply" } });
      }
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      send("message_stop", { type: "message_stop" }); res.end(); return;
    }
    if (req.url === "/mcp") {
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      if (input?.id === undefined) { res.writeHead(202); res.end(); return; }
      let result: unknown;
      if (input.method === "initialize") {
        res.setHeader("mcp-session-id", `upstream-${++mcpSession}`);
        result = { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "integration", version: "1.0.0" } };
      } else if (input.method === "tools/list") result = { tools: [{ name: "probe", description: "Local MCP probe", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] };
      else if (input.method === "tools/call") result = { content: [{ type: "text", text: `mcp-echo:${input.params.arguments.value}` }] };
      else result = {};
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result })); return;
    }
    res.setHeader("content-type", "application/json"); res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstreamPort}`;
  let now = Date.now();
  const contexts = new ContextStore(root, () => now);
  const config = { ...loadConfig(), dataDir: root, mainDataDir: root, hostDataDir: join(hostRoot, relative(repo, root)),
    srcDir: join(root, "src"), apiBase: "", sessionImage: image, sessionMemoryLimit: "700m", runtimeIdleMs: 3600_000, maxActiveRuntimes: 8 };
  mkdirSync(config.srcDir, { recursive: true }); writeFileSync(join(config.srcDir, "source-only"), "admin source");
  mkdirSync(join(root, "shared"), { recursive: true }); writeFileSync(join(root, "shared/CLAUDE.md"), "# Public persona\n");
  mkdirSync(join(root, "claude/skills/public-probe"), { recursive: true });
  writeFileSync(join(root, "claude/skills/public-probe/SKILL.md"), "---\nname: public-probe\ndescription: Integration probe\n---\nPublic skill.\n");
  mkdirSync(join(root, "control-only")); writeFileSync(join(root, "control-only/secret"), "control file");
  const options = { isAdmin: (owner: string) => owner === "admin", notify: async (owner: string, text: string) => { notices.push({ owner, text }); }, now: () => now, docker };
  let runtimes = new RuntimeManager(config, contexts, options); managers.push(runtimes);
  broker = new CapabilityBroker(join(root, "execution/shared-tools.json"), runtimes, options.isAdmin);
  broker.configure({ mcp: { shared: { url: `http://127.0.0.1:${upstreamPort}/mcp`, headers: { "x-provider-secret": "controller-mcp-secret" } } },
    services: { public: { url: `http://127.0.0.1:${upstreamPort}/service`, headers: { "x-provider-secret": "controller-service-secret" } },
      privileged: { url: `http://127.0.0.1:${upstreamPort}/admin`, adminOnly: true } } });
  let api = new ExecutionApi({ config, contexts, runtimes, broker, turns: new TurnTokens(), isAdmin: options.isAdmin });
  server = createServer((req, res) => { void api.handle(req, res, new URL(req.url!, "http://localhost"), false).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  config.apiBase = `http://${controlHost}:${await listen(server)}`;
  const agent = new Agent(config, { contexts, runtimes, broker }); agents.push(agent);
  const exec = (r: RuntimeRecord, code: string, env: Record<string, string> = {}) => docker(["exec", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), r.container, "node", "--input-type=module", "-e", code]);
  const fetchIn = async (r: RuntimeRecord, path: string, method = "GET", headers = {}, body?: unknown) => JSON.parse(await exec(r,
    `const response=await fetch(process.env.CATMAN_API_BASE+${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'X-Catman-Runtime':process.env.CATMAN_RUNTIME_TOKEN,...${JSON.stringify(headers)}},${body === undefined ? "" : `body:${JSON.stringify(JSON.stringify(body))},`}});console.log(JSON.stringify({status:response.status,text:await response.text()}));`));
  const task = async (r: RuntimeRecord, cmd: string[], timeoutMs = 20_000, cwd?: string, env?: Record<string, string>) => JSON.parse(await runtimes.rpc(r, "/tasks", "POST", { cmd, timeoutMs, cwd: cwd ?? contexts.paths(contexts.get(r.contextId)!).work, env })) as TaskRecord;
  const finished = (r: RuntimeRecord, id: string) => until(async () => (JSON.parse(await runtimes.rpc(r, "/tasks")) as TaskRecord[]).find(t => t.id === id)!, t => !!t.endedAt, `task ${id}`);
  const alice = contexts.chat("alice"), bob = contexts.chat("bob"), admin = contexts.chat("admin");
  const a = await runtimes.ensure(alice), b = await runtimes.ensure(bob), adm = await runtimes.ensure(admin);
  const aPaths = contexts.paths(alice), bPaths = contexts.paths(bob);
  let sdkSessionId = "", sdkAgentIds: string[] = [];

  await t.test("真实挂载：跨租户和跨会话隔离、共享只读、管理员源码、资源限制", async () => {
    writeFileSync(join(aPaths.home, "private"), "alice-only"); writeFileSync(join(bPaths.home, "private"), "bob-only");
    writeFileSync(join(aPaths.work, "session-only"), "alice-session");
    const second = contexts.chat("alice"), a2 = await runtimes.ensure(second);
    for (const [runtime, own, forbidden] of [[a, "alice-only", bPaths.root], [b, "bob-only", aPaths.root], [a2, "alice-only", aPaths.work]] as const) {
      const result = JSON.parse(await exec(runtime, `import fs from 'node:fs'; console.log(JSON.stringify({own:fs.readFileSync('/user/private','utf8'),other:fs.existsSync(${JSON.stringify(forbidden)}),control:fs.existsSync(${JSON.stringify(join(root, "control-only/secret"))}),socket:fs.existsSync('/var/run/docker.sock'),source:fs.existsSync('/catman-src'),key:process.env.ANTHROPIC_API_KEY,oauth:process.env.CLAUDE_CODE_OAUTH_TOKEN,admin:process.env.CATMAN_ADMIN_TOKEN,ipc:process.env.CATMAN_IPC_SECRET}));`));
      assert.deepEqual(result, { own, other: false, control: false, socket: false, source: false });
    }
    assert.equal(await exec(adm, "import fs from 'node:fs'; console.log(fs.readFileSync('/catman-src/source-only','utf8'))"), "admin source");
    await assert.rejects(exec(a, "import fs from 'node:fs'; fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR+'/skills/public-probe/SKILL.md','overwrite')"), /EROFS|EACCES/);
    await exec(a, "import fs from 'node:fs'; fs.mkdirSync('/user/skills/mine',{recursive:true});fs.writeFileSync('/user/skills/mine/SKILL.md','personal');fs.writeFileSync('generated','workspace')");
    assert.equal(await exec(a2, "import fs from 'node:fs'; console.log(fs.readFileSync('/user/skills/mine/SKILL.md','utf8'))"), "personal");
    assert.equal(readFileSync(join(aPaths.work, "generated"), "utf8"), "workspace");
    const inspect = JSON.parse(await docker(["inspect", a.container]))[0];
    assert.equal(inspect.HostConfig.ReadonlyRootfs, true); assert.equal(inspect.HostConfig.Privileged, false);
    assert.equal(inspect.HostConfig.Memory, 700 * 1024 * 1024); assert.equal(inspect.HostConfig.MemorySwap, inspect.HostConfig.Memory);
    assert.equal(inspect.HostConfig.PidsLimit, 256); assert.equal(inspect.HostConfig.NanoCpus, 1_500_000_000);
    assert.deepEqual(inspect.HostConfig.CapDrop, ["ALL"]); assert.ok(inspect.HostConfig.SecurityOpt.includes("no-new-privileges"));
    await runtimes.stop(second.id, "test cleanup", true);
  });
  await t.test("真实网络代理：公共密钥仅到上游，身份/管理员限制不能跨越", async () => {
    const response = await fetchIn(a, "/api/runtime/services/public", "POST", { authorization: "Bearer forged", cookie: "forged-cookie", "content-type": "application/json" }, { q: "probe" });
    assert.equal(response.status, 200);
    const seenService = seen.find(r => r.path === "/service")!;
    assert.equal(seenService.headers["x-provider-secret"], "controller-service-secret");
    assert.equal(seenService.headers.authorization, undefined); assert.equal(seenService.headers.cookie, undefined);
    assert.notEqual((await fetchIn(a, "/api/runtime/services/privileged")).status, 200);
    assert.equal((await fetchIn(adm, "/api/runtime/services/privileged")).status, 200);
    assert.equal((await fetchIn(a, "/api/execution/shared")).status, 403);
    const redacted = await fetchIn(adm, "/api/execution/shared"); assert.equal(redacted.status, 200); assert.ok(!redacted.text.includes("controller-service-secret"));
    assert.notEqual((await fetchIn(b, `/api/execution/${alice.id}/reclaim`, "POST", {}, {})).status, 200);
    const own = await fetchIn(a, "/api/execution"); assert.ok(!own.text.includes(b.token)); assert.ok(!own.text.includes(a.token)); assert.ok(!own.text.includes('"bob"'));
    for (const runtime of [a, b]) {
      assert.equal((await fetchIn(runtime, "/api/runtime/mcp/shared", "POST", { "content-type": "application/json", "mcp-session-id": "forged-session" }, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).status, 200);
      assert.equal((await fetchIn(runtime, "/api/runtime/mcp/shared", "POST", { "content-type": "application/json" }, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status, 200);
    }
    const mcp = seen.filter(r => r.path === "/mcp");
    assert.deepEqual(mcp.map(r => r.headers["mcp-session-id"]), [undefined, "upstream-1", undefined, "upstream-2"]);
    assert.ok(mcp.every(r => r.headers["x-provider-secret"] === "controller-mcp-secret"));
  });
  await t.test("真实挂载回收：删除实例临时文件,保留 workspace 与未认领容器的挂载", async () => {
    const c = contexts.chat("artifact-probe"), r = await runtimes.ensure(c), paths = contexts.paths(c);
    const projection = join(root, "execution/projections", c.id, r.container.slice(-16));
    const wrapper = runtimes.wrapper(c, r);
    await exec(r, "import fs from 'node:fs';fs.writeFileSync('keep','persistent')");
    await runtimes.stop(c.id, "test cleanup", true);
    assert.equal(existsSync(projection), false); assert.equal(existsSync(wrapper), false);
    assert.equal(readFileSync(join(paths.work, "keep"), "utf8"), "persistent");
    const orphan = contexts.chat("orphan-artifact"), mounted = contexts.chat("external-artifact");
    const old = join(root, "execution/projections", orphan.id, "a".repeat(16));
    const bound = join(root, "execution/projections", mounted.id, "a".repeat(16));
    mkdirSync(old, { recursive: true }); mkdirSync(bound, { recursive: true });
    const name = `catman-artifact-test-${suffix}`;
    await docker(["run", "-d", "--name", name, "--label", "catman.context=1", "--mount",
      `type=bind,src=${join(config.hostDataDir, relative(root, bound))},dst=/projection,readonly`,
      image, "node", "-e", "setInterval(()=>{},1000)"]);
    try {
      await runtimes.tick();
      assert.equal(existsSync(old), false); assert.ok(existsSync(bound));
      assert.ok(existsSync(join(root, "execution/projections", alice.id, a.container.slice(-16))));
    } finally { await docker(["rm", "-f", name]); }
  });
  await t.test("真实 Docker 启动与巡检交错：容器创建前的投影不能被回收", async () => {
    const c = contexts.chat("startup-race-probe");
    let entered!: () => void, resume!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    beforeRun = async args => {
      if (args[args.indexOf("--name") + 1]?.includes(c.id)) { entered(); await gate; }
    };
    const creating = runtimes.ensure(c);
    try {
      await waiting;
      const pending = runtimes.all("startup-race-probe")[0]!;
      await assert.rejects(docker(["inspect", pending.container]), /No such/);
      await runtimes.tick();
      assert.ok(runtimes.resolve(pending.token));
      assert.ok(existsSync(join(root, "execution/projections", c.id, pending.container.slice(-16))));
      assert.equal(notices.filter(n => n.owner === "startup-race-probe").length, 0);
      resume(); const started = await creating;
      assert.equal(started.container, pending.container);
      assert.equal(await exec(started, "console.log('worker-ready')"), "worker-ready");
    } finally {
      beforeRun = undefined; resume(); await creating.catch(() => {});
      await runtimes.stop(c.id, "test cleanup", true);
    }
  });
  await t.test("真实 worker/CLI 指令加载：主人格/守护人格 × 聊天/cron，三层指令和租户隔离", { timeout: 60_000 }, async () => {
    const previousApi = api;
    try {
      for (const persona of ["primary", "rescue"] as const) for (const kind of ["chat", "cron"] as const) {
        const memoryRoot = join(root, `instructions-${persona}-${kind}`);
        const fixture = instructionFixture(memoryRoot, kind);
        // This ancestor would be Project memory on the controller, but must not exist
        // in the worker mount namespace. Catch an accidental whole-data-root mount.
        writeFileSync(join(memoryRoot, "CLAUDE.md"), fixture.forbidden.control);
        const memoryConfig = { ...config, persona, dataDir: memoryRoot };
        const manager = new RuntimeManager(memoryConfig, fixture.contexts, options); managers.push(manager);
        const memoryBroker = new CapabilityBroker(join(memoryRoot, "execution/shared-tools.json"), manager, options.isAdmin);
        const memoryAgent = new Agent(memoryConfig, { contexts: fixture.contexts, runtimes: manager, broker: memoryBroker }); agents.push(memoryAgent);
        api = new ExecutionApi({ config: memoryConfig, contexts: fixture.contexts, runtimes: manager, broker: memoryBroker, turns: new TurnTokens(), isAdmin: options.isAdmin });
        try {
          const start = seen.length;
          const reply = await memoryAgent.run(INSTRUCTION_PROBE_PROMPT, { context: fixture.context, maxTurns: 1 });
          assert.equal(reply.isError, false, `${persona}/${kind}`);
          const first = seen.slice(start).find(r => r.path.startsWith("/v1/messages") && !r.path.includes("count_tokens") && isInstructionProbeRequest(r.body));
          verifyInstructionRequest(first?.body, fixture, persona);
        } finally {
          memoryAgent.close();
          await manager.stop(fixture.context.id, "instruction test cleanup", true);
          manager.close(); await memoryBroker.close();
        }
      }
    } finally { api = previousApi; }
  });
  await t.test("真实 CLI 发现和调用公共 MCP，协议会话和服务端凭据经过控制面", async () => {
    writeFileSync(join(aPaths.sdk, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }));
    modelTool = { name: "mcp__public_shared__probe", input: { value: "through-real-cli" } };
    const reply = await agent.run("Call the local public MCP probe.", { context: alice, maxTurns: 4 });
    assert.equal(reply.isError, false); assert.equal(reply.text, "integration reply");
    const call = seen.find(r => r.path === "/mcp" && r.body?.method === "tools/call");
    assert.ok(call, "CLI actually invoked the public MCP tool");
    assert.equal(call.headers["x-provider-secret"], "controller-mcp-secret");
    assert.equal(call.body.params.arguments.value, "through-real-cli");
    assert.ok(contexts.read(reply.sessionId, "alice").some(entry => JSON.stringify(entry).includes("mcp-echo:through-real-cli")));
  });
  await t.test("真实 SDK/CLI：原生后台进程保留，下一条消息复用同一个 CLI 和会话", async () => {
    modelTool = { command: "node -e 'setTimeout(()=>require(\"fs\").writeFileSync(\"native-finished\",\"same-workspace\"),7000)'", run_in_background: true };
    const first = await agent.run("Run the Docker background probe.", { context: contexts.get(alice.id)!, maxTurns: 4 });
    assert.equal(first.text, "integration reply"); assert.equal(first.isError, false);
    assert.ok(runtimes.all("alice").find(r => r.contextId === alice.id)!.sdkTasks.length > 0);
    const before = JSON.parse(await runtimes.rpc(a, "/processes")).agents;
    assert.equal(before.length, 1);
    const processEnv = JSON.parse(await exec(a, `import fs from 'node:fs'; const children=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).flatMap(p=>{try{const env=fs.readFileSync('/proc/'+p+'/environ','utf8');if(!env.includes('CATMAN_AGENT_ID='))return [];return [{capability:env.includes('CATMAN_RUNTIME_TOKEN='),rawSecret:env.includes('controller-model-secret-for-integration')||env.includes('controller-admin-secret-for-integration')||env.includes('controller-ipc-secret-for-integration')||env.includes('controller-host-only-for-integration')}]}catch{return []}});console.log(JSON.stringify(children));`));
    assert.ok(processEnv.length > 0); assert.ok(processEnv.every((p: { capability: boolean; rawSecret: boolean }) => p.capability && !p.rawSecret), "CLI 及其工具也只能继承 capability，不能继承控制面环境");
    const second = await agent.run("Reply while the background probe is running.", { context: contexts.get(alice.id)!, resumeSessionId: first.sessionId, maxTurns: 4 });
    assert.equal(second.text, "integration reply"); assert.equal(second.sessionId, first.sessionId);
    assert.deepEqual(JSON.parse(await runtimes.rpc(a, "/processes")).agents, before);
    await until(async () => existsSync(join(aPaths.work, "native-finished")), Boolean, "native background output");
    await until(async () => runtimes.pending(alice.id), events => events.some(e => e.text.includes("completed")), "SDK background completion event");
    assert.equal(readFileSync(join(aPaths.work, "native-finished"), "utf8"), "same-workspace");
    const requests = seen.filter(r => r.path.startsWith("/v1/messages")); assert.ok(requests.length >= 3);
    assert.ok(requests.every(r => r.headers["x-api-key"] === "controller-model-secret-for-integration" && !r.headers.authorization));
    assert.ok(contexts.read(first.sessionId, "alice").length > 0); assert.equal(contexts.read(first.sessionId, "bob").length, 0);
    sdkSessionId = first.sessionId; sdkAgentIds = before;
  });
  await t.test("后台任务全部结束后 CLI 自动闲置退出，新消息重新拉起并恢复原会话", async () => {
    await until(async () => JSON.parse(await runtimes.rpc(a, "/processes")).agents, ids => ids.length === 0, "automatic idle CLI close");
    const reply = await agent.run("Resume the same conversation after CLI idle exit.", { context: contexts.get(alice.id)!, resumeSessionId: sdkSessionId, maxTurns: 4 });
    assert.equal(reply.isError, false); assert.equal(reply.sessionId, sdkSessionId); assert.equal(reply.text, "integration reply");
    const ids = JSON.parse(await runtimes.rpc(a, "/processes")).agents; assert.equal(ids.length, 1); assert.notDeepEqual(ids, sdkAgentIds);
    agent.close();
  });
  await t.test("OAuth 凭据代理只替换上游身份，worker 不获取 OAuth 密钥", async () => {
    delete process.env.ANTHROPIC_API_KEY; process.env.CLAUDE_CODE_OAUTH_TOKEN = "controller-oauth-secret-for-integration";
    try {
      assert.equal((await fetchIn(b, "/api/runtime/model/v1/messages", "POST", { "content-type": "application/json", "anthropic-beta": "other-beta" }, {})).status, 200);
      const request = seen.at(-1)!;
      assert.equal(request.headers.authorization, "Bearer controller-oauth-secret-for-integration");
      assert.equal(request.headers["x-api-key"], undefined);
      assert.ok(String(request.headers["anthropic-beta"]).includes("oauth-2025-04-20"));
      assert.equal(await exec(b, "console.log(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? 'absent')"), "absent");
    } finally { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; process.env.ANTHROPIC_API_KEY = "controller-model-secret-for-integration"; }
  });
  await t.test("登记任务保留 cwd/env，CLI 退出后仍完成；缺少 timeout 拒绝执行", async () => {
    await assert.rejects(docker(["exec", a.container, "catman-task", "run", "--", "true"]), /timeout/);
    const result: TaskRecord = JSON.parse(await docker(["exec", "-w", aPaths.work, "-e", "PROBE_VALUE=from-cli", "-e", "CATMAN_SESSION_TOKEN=must-strip", a.container,
      "catman-task", "run", "--timeout", "15", "-n", "independent-probe", "--", "node", "-e", "setTimeout(()=>{require('fs').writeFileSync('registered-finished',process.cwd()+'|'+process.env.PROBE_VALUE+'|'+(process.env.CATMAN_SESSION_TOKEN||''));console.log('task-done')},800)"]));
    await until(async () => JSON.parse(await runtimes.rpc(a, "/processes")).agents, ids => ids.length === 0, "CLI fully exited");
    assert.equal((await finished(a, result.id)).status, "completed");
    assert.equal(readFileSync(join(aPaths.work, "registered-finished"), "utf8"), `${aPaths.work}|from-cli|`);
    await runtimes.tick();
    assert.ok(runtimes.pending(alice.id).some(e => e.text.includes("independent-probe") && e.text.includes("task-done")));
  });
  await t.test("超时杀死忽略 TERM 的进程及子进程，并记录通知", async () => {
    const timed = await task(a, ["node", "-e", "process.on('SIGTERM',()=>{});const c=require('child_process').spawn('node',['-e','process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync('timeout-pids',process.pid+','+c.pid);setInterval(()=>{},1000)"], 500);
    const ended = await finished(a, timed.id); assert.equal(ended.status, "timeout");
    const pids = readFileSync(join(aPaths.work, "timeout-pids"), "utf8").split(",").map(Number);
    const snapshot = JSON.parse(await runtimes.rpc(a, "/processes"));
    assert.ok(pids.every(pid => !snapshot.processes.some((line: string) => new RegExp(`^\\s*${pid}\\s`).test(line))));
    await runtimes.tick(); assert.ok(runtimes.pending(alice.id).some(e => e.text.includes("超过执行时限")));
  });
  await t.test("取消卡住的前台 CLI，不影响同容器内已登记的后台任务", async () => {
    const c = contexts.chat("cancel-probe"), r = await runtimes.ensure(c), paths = contexts.paths(c);
    writeFileSync(join(paths.sdk, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }));
    const background = await task(r, ["node", "-e", "setTimeout(()=>require('fs').writeFileSync('after-cancel','done'),3000)"], 15_000);
    const before = seen.filter(r => r.path.startsWith("/v1/messages")).length;
    const abortController = new AbortController(); holdModel = true;
    const cancelled = assert.rejects(agent.run("Wait for a response until cancelled.", { context: c, abortController }), /Docker cancellation probe/);
    try {
      await until(async () => seen.filter(r => r.path.startsWith("/v1/messages")).length, n => n > before, "foreground request blocked in model");
      abortController.abort(new Error("Docker cancellation probe")); await cancelled;
      await until(async () => JSON.parse(await runtimes.rpc(r, "/processes")).agents, ids => ids.length === 0, "cancelled CLI exited");
      assert.equal((await finished(r, background.id)).status, "completed");
      assert.equal(readFileSync(join(paths.work, "after-cancel"), "utf8"), "done");
    } finally { holdModel = false; abortController.abort(); await runtimes.stop(c.id, "test cleanup", true); }
  });
  await t.test("真实 cgroup 内存限制：内存失控任务被 OOM 杀掉，管理器继续响应", async () => {
    const c = contexts.chat("memory-probe"); const previousLimit = config.sessionMemoryLimit;
    let r: RuntimeRecord;
    // Leave room for the supervisor and RPC client before adding the memory
    // hog. Native Node baselines vary across architectures and runtime versions.
    try { config.sessionMemoryLimit = "192m"; r = await runtimes.ensure(c); }
    finally { config.sessionMemoryLimit = previousLimit; }
    // Reading a counter must not start another Node under the deliberately small
    // cgroup: the observer itself can otherwise become an unrelated OOM victim.
    const oomKills = async () => {
      const events = await docker(["exec", r.container, "cat", "/sys/fs/cgroup/memory.events"]);
      const match = /^oom_kill (\d+)$/m.exec(events); assert.ok(match, events);
      return Number(match[1]);
    };
    try {
      const before = await oomKills();
      const hungry = await task(r, ["node", "-e", "const pages=[];setInterval(()=>pages.push(Buffer.alloc(8*1024*1024,1)),5)"], 10_000);
      assert.equal((await finished(r, hungry.id)).status, "failed");
      assert.ok(await oomKills() > before, "kernel cgroup OOM counter increased");
      assert.ok(Array.isArray(JSON.parse(await runtimes.rpc(r, "/tasks"))));
    } finally { await runtimes.stop(c.id, "test cleanup", true); }
  });
  await t.test("cron 使用 owner home 和固定 workspace，容器重建后状态继续累加", async () => {
    const jobs = new CronStore({ dir: join(root, "cron"), contexts, hostDataRoot: config.hostDataDir });
    const cmd = ["node", "-e", "const fs=require('fs');const n=fs.existsSync('counter')?+fs.readFileSync('counter','utf8'):0;fs.writeFileSync('counter',String(n+1));console.log(fs.readFileSync('/user/private','utf8')+'|'+process.cwd()+'|'+process.env.CRON_PROBE)"];
    const job = jobs.put({ id: "probe", userKey: "alice", name: "cron-probe", enabled: true, schedule: { kind: "every", ms: 3600_000 }, task: { kind: "script", cmd, env: { CRON_PROBE: "owner-env" } }, timeoutMs: 5000,
      overlap: "skip", notify: { start: false, end: false, onlyFailure: false }, keepRuns: 5, createdAt: now, updatedAt: now, failStreak: 0 });
    const runner = new ContextScriptRunner(contexts, runtimes, jobs);
    const cron = contexts.cron("alice", job.id), work = contexts.paths(cron).work;
    for (const run of ["first", "second"]) {
      assert.deepEqual(await runner.launch({ container: run, jobId: job.id, userKey: "alice", cmd, env: job.task.kind === "script" ? job.task.env : {}, timeoutMs: job.timeoutMs }), { ok: true });
      assert.deepEqual(await until(() => runner.poll(run), r => r.state !== "running", "cron completion"), { state: "exited", exitCode: 0 });
      assert.match(await runner.logs(run), /alice-only/); assert.ok((await runner.logs(run)).includes(`${work}|owner-env`));
      assert.equal(runtimes.pending(cron.id).length, 0, "cron 入口的通用后台任务通知由调度器接管");
      await runtimes.stop(cron.id, "recreate cron runtime", true);
    }
    assert.equal(readFileSync(join(work, "counter"), "utf8"), "2"); assert.ok(!existsSync(join(aPaths.work, "counter")));
  });
  await t.test("控制面重启认领同一容器：杀掉孤立 CLI，保留登记任务和截止时间", async () => {
    const c = contexts.chat("restart-probe"), r = await runtimes.ensure(c);
    const running = await task(r, ["node", "-e", "setTimeout(()=>require('fs').writeFileSync('after-restart','done'),2500)"], 10_000);
    await docker(["exec", "-d", "-e", `CATMAN_AGENT_ID=${randomUUID()}`, r.container, "catman-task", "exec", "--", "node", "-e", "setInterval(()=>{},1000)"]);
    await until(async () => JSON.parse(await runtimes.rpc(r, "/processes")).agents, ids => ids.length === 1, "orphan agent registration");
    runtimes.close();
    const adopted = new RuntimeManager(config, contexts, options); managers.push(adopted);
    api = new ExecutionApi({ config, contexts, runtimes: adopted, broker: broker!, turns: new TurnTokens(), isAdmin: options.isAdmin });
    const restored = await adopted.ensure(c);
    assert.equal(restored.container, r.container); assert.equal(restored.token, r.token); assert.equal(restored.createdAt, r.createdAt);
    const snapshot = JSON.parse(await adopted.rpc(restored, "/processes")); assert.equal(snapshot.agents.length, 0);
    assert.equal(snapshot.tasks.find((t: TaskRecord) => t.id === running.id).deadlineAt, running.deadlineAt);
    await until(async () => existsSync(join(contexts.paths(c).work, "after-restart")), Boolean, "registered task after restart");
    runtimes = adopted;
    await runtimes.stop(c.id, "test cleanup", true);
  });
  await t.test("任务管理器无响应：容器外截止检查仍能杀掉整个容器", async () => {
    const c = contexts.chat("wedged-probe"), r = await runtimes.ensure(c);
    const running = await task(r, ["node", "-e", "setInterval(()=>{},1000)"], 5000);
    await until(async () => runtimes.all("wedged-probe")[0]?.tasks ?? [], tasks => tasks.some(t => t.id === running.id), "task registration callback");
    await docker(["pause", r.container]);
    now = running.deadlineAt + 6000;
    try {
      await runtimes.tick(); assert.ok(!runtimes.all().some(r => r.contextId === c.id));
      await assert.rejects(docker(["inspect", r.container]), /No such/);
      assert.ok(runtimes.pending(c.id).some(e => e.text.includes("超时且未退出")));
    } finally { now = Date.now(); }
  });
  await t.test("未知 server：提前十分钟提示进程，可延长，到期杀容器并保留文件", async () => {
    const c = contexts.chat("idle-probe"), r = await runtimes.ensure(c), paths = contexts.paths(c);
    writeFileSync(join(paths.work, "keep"), "retained");
    await docker(["exec", "-d", r.container, "node", "-e", "require('http').createServer((q,s)=>s.end('probe')).listen(0)"]);
    now = r.lastInteractionAt + 50 * 60_000; await runtimes.tick();
    await until(async () => notices, n => n.some(e => e.owner === "idle-probe" && e.text.includes("10 分钟") && e.text.includes("node")), "idle warning");
    const count = notices.filter(e => e.owner === "idle-probe").length; await runtimes.tick();
    assert.equal(notices.filter(e => e.owner === "idle-probe").length, count);
    assert.throws(() => runtimes.extend("alice", c.id, 30), /没有/);
    const extended = runtimes.extend("idle-probe", c.id, 30);
    now += 11 * 60_000; await runtimes.tick(); assert.ok(runtimes.all().some(r => r.contextId === c.id));
    now = extended; await runtimes.tick(); assert.ok(!runtimes.all().some(r => r.contextId === c.id));
    await assert.rejects(docker(["inspect", r.container]), /No such/);
    assert.equal(readFileSync(join(paths.work, "keep"), "utf8"), "retained");
    await until(async () => notices, n => n.some(e => e.owner === "idle-probe" && e.text.includes("已回收")), "reclaim notice");
    now = Date.now();
  });
  await t.test("真实运维授权：多目录、SSH 主机校验、共享 workspace、Docker 和父子回收", { timeout: 60_000 }, async () => {
    const services = join(root, "ops-host/services"), storage = join(root, "ops-host/storage");
    mkdirSync(services, { recursive: true }); mkdirSync(storage, { recursive: true });
    writeFileSync(join(services, "probe"), "services-probe"); writeFileSync(join(storage, "probe"), "storage-probe");
    const opsConfig = { ...config, ops: { image: process.env.CATMAN_OPS_TEST_IMAGE || "catman-ops:integration", mounts: parseOpsMounts(JSON.stringify([
      { source: join(hostRoot, relative(repo, services)), target: "/opt/services" },
      { source: join(hostRoot, relative(repo, storage)), target: "/mnt/usb" },
    ])), dockerSocket: true, memory: "256m", maxActive: 1 } };
    const ops = new OpsManager(opsConfig, contexts, runtimes, { isAdmin: options.isAdmin, notify: (owner, _context, text) => { notices.push({ owner, text }); } });
    api = new ExecutionApi({ config: opsConfig, contexts, runtimes, broker: broker!, turns: new TurnTokens(), isAdmin: options.isAdmin, ops });
    const context = contexts.chat("admin"), parent = await runtimes.ensure(context);
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    try {
      const pending = await fetchIn(parent, "/api/runtime/ops/request", "POST", { "content-type": "application/json" }, { reason: "真实 Docker 运维验证" });
      assert.equal(pending.status, 200); const id = JSON.parse(pending.text).id as string;
      assert.notEqual((await fetchIn(parent, "/api/runtime/ops/connection")).status, 200);
      await assert.rejects(docker(["exec", parent.container, "catman-ops", "exec", "--", "true"]), /尚未获得运维授权/);
      const routesBefore = await docker(["exec", parent.container, "ip", "-j", "route", "show", "default"]);
      const { record } = await ops.grant("admin", id);
      assert.equal(await docker(["exec", parent.container, "ip", "-j", "route", "show", "default"]), routesBefore, "授权不改变原 worker 的默认路由");
      const output = await docker(["exec", parent.container, "catman-ops", "connect"]);
      const configPath = /SSH 登录：ssh -F (\S+) catman-ops/.exec(output)?.[1]; assert.ok(configPath);
      assert.ok(output.includes("/opt/services")); assert.ok(output.includes("/mnt/usb")); assert.ok(output.includes("docker.sock")); assert.ok(!output.includes("BEGIN OPENSSH PRIVATE KEY"));
      const ssh = (command: string) => docker(["exec", parent.container, "ssh", "-F", configPath, "catman-ops", command]);
      const probe = "const fs=require('fs');console.log(fs.readFileSync('/opt/services/probe','utf8'),fs.readFileSync('/mnt/usb/probe','utf8'));fs.writeFileSync('ops-output','same-workspace');";
      assert.equal(await ssh(`node -e ${quote(probe)}`), "services-probe storage-probe");
      assert.equal(readFileSync(join(contexts.paths(context).work, "ops-output"), "utf8"), "same-workspace");
      await docker(["exec", parent.container, "scp", "-F", configPath, "catman-ops:ops-output", "ops-downloaded"]);
      assert.equal(readFileSync(join(contexts.paths(context).work, "ops-downloaded"), "utf8"), "same-workspace");
      assert.match(await ssh("docker version --format '{{.Server.Version}}'"), /^\d+\./);
      const trickyArgs = ["", "space here", "quote'\"", "line1\nline2", "$(exit 91)", "`exit 92`", "; exit 93", "$HOME", "*"];
      const wrapped = await docker(["exec", parent.container, "catman-ops", "exec", "--", "node", "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...trickyArgs]);
      assert.deepEqual(JSON.parse(wrapped), trickyArgs, "真实 SSH 保留 argv，不把参数解释成 shell");
      const scriptPath = join(contexts.paths(context).work, "script with quote'.sh");
      writeFileSync(scriptPath, 'set -euo pipefail\nprintf "%s" "$1" > "wrapped result"\nprintf "%s" "$PWD"\n');
      assert.equal(await docker(["exec", parent.container, "catman-ops", "run", scriptPath, "arg with quote' and $(exit 91)"]), contexts.paths(context).work);
      assert.equal(readFileSync(join(contexts.paths(context).work, "wrapped result"), "utf8"), "arg with quote' and $(exit 91)");
      // 从 Node 直传 stdin，不再引入本地 shell；检查 stderr、退出码与执行凭证清理。
      const commandProbe = `const {spawnSync}=await import('node:child_process');const fs=await import('node:fs');const before=fs.readdirSync('/tmp').filter(n=>n.startsWith('catman-ops-')).sort();const result=spawnSync('catman-ops',${JSON.stringify(["run", "-", "space ' $()"] )},{input:${JSON.stringify('printf "%s" "$1"; printf "probe-error" >&2; exit 23\n')},encoding:'utf8'});const after=fs.readdirSync('/tmp').filter(n=>n.startsWith('catman-ops-')).sort();console.log(JSON.stringify({code:result.status,out:result.stdout,err:result.stderr,clean:JSON.stringify(before)===JSON.stringify(after)}));`;
      assert.deepEqual(JSON.parse(await exec(parent, commandProbe)), { code: 23, out: "space ' $()", err: "probe-error", clean: true });
      const inspect = JSON.parse(await docker(["inspect", record.container]))[0];
      assert.equal(inspect.HostConfig.Privileged, false); assert.deepEqual(inspect.HostConfig.PortBindings, {});
      assert.equal(inspect.Config.User, "0:0");
      const badIdentity = `const {execFileSync}=await import('node:child_process');const key='/tmp/ops-wrong-identity';execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',key]);try{execFileSync('ssh',['-F','/dev/null','-i',key,'-p','2222','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',${JSON.stringify(`UserKnownHostsFile=${configPath.replace(/ssh_config$/, "known_hosts")}`)},${JSON.stringify(`root@${record.container}`)},'true'],{stdio:'pipe'});throw new Error('wrong key accepted')}catch(e){if(e.status!==255||!String(e.stderr).includes('Permission denied'))throw e;console.log('wrong-key-denied')}`;
      assert.equal(await exec(parent, badIdentity), "wrong-key-denied");
      // SSH 源码拉取：worker -> 已授权运维 SSH -> 控制服务 -> Git SSH 服务。
      // 所有仓库和密钥均为本测试创建，不连接真实远端或生产容器。
      const fetchController = `catman-fetch-${suffix}`;
      opsConfig.containerName = fetchController;
      containers.add(fetchController);
      try {
        const origin = "/tmp/catman-git-origin", seed = "/tmp/catman-git-seed";
        await ssh(`git init --bare ${quote(origin)} && git init ${quote(seed)} && git -C ${quote(seed)} -c user.name=Probe -c user.email=probe@example.invalid commit --allow-empty -m probe && git -C ${quote(seed)} push ${quote(origin)} HEAD:refs/heads/main`);
        const key = join(config.dataDir, "execution", "ops", id, "client_key"), hosts = join(root, "git-known-hosts");
        const connection = await ops.connection(parent);
        writeFileSync(hosts, `[${record.container}]:2222 ${connection.hostKey}\n`);
        await docker(["run", "-d", "--name", fetchController, "--network", record.network, "--user", `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`,
          "--mount", `type=bind,src=${join(hostRoot, relative(repo, root))},dst=${root}`, image, "node", "-e", "setInterval(()=>{},1000)"]);
        await docker(["exec", fetchController, "git", "-C", config.srcDir, "init"]);
        const remote = `ssh://root@${record.container}:2222${origin}`;
        await docker(["exec", fetchController, "git", "-C", config.srcDir, "remote", "add", "origin", remote]);
        await docker(["exec", fetchController, "git", "-C", config.srcDir, "config", "core.sshCommand", `ssh -i ${quote(key)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${quote(hosts)}`]);
        assert.equal(await exec(parent, `const fs = await import('node:fs'); console.log(fs.existsSync(${JSON.stringify(key)}))`), "false", "worker 看不到 Git SSH 密钥");
        const manifest = await docker(["exec", parent.container, "catman-ops", "connect"]);
        const command = manifest.split("\n").find(line => line.startsWith("catman-ops exec -- docker exec --user")); assert.ok(command);
        await docker(["exec", parent.container, "sh", "-c", command]);
        const fetched = await docker(["exec", parent.container, "git", "-C", "/catman-src", "rev-parse", "origin/main"]);
        assert.match(fetched, /^[a-f0-9]{40}$/);
        assert.equal(await docker(["exec", fetchController, "git", "-C", config.srcDir, "remote", "get-url", "origin"]), remote, "拉取后保持 SSH origin");
      } finally { await docker(["rm", "-f", fetchController]); }
      await ssh(`node -e ${quote("require('child_process').spawn('sleep',['120'],{detached:true,stdio:'ignore'}).unref()")}`);
      now += 31_000; await runtimes.tick(); assert.ok(runtimes.all().some(r => r.container === parent.container), "远端仍有任务时不触发空 worker 快速回收");
      await runtimes.stop(context.id, "运维父子回收验证", true);
      await assert.rejects(docker(["inspect", record.container]), /No such/);
      await assert.rejects(docker(["network", "inspect", record.network]), /not found|No such/);
      assert.equal(ops.list("admin").length, 0);
      const replacement = await runtimes.ensure(context);
      assert.notEqual((await fetchIn(replacement, "/api/runtime/ops/connection")).status, 200);
    } finally {
      for (const record of ops.list("admin")) await ops.revoke("admin", record.id);
      ops.close(); await runtimes.stop(context.id, "运维测试清理", true); now = Date.now();
    }
  });
});
