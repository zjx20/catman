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
  const docker = async (args: string[], env?: NodeJS.ProcessEnv) => {
    if (args[0] === "run") containers.add(args[args.indexOf("--name") + 1]!);
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
    try { config.sessionMemoryLimit = "96m"; r = await runtimes.ensure(c); }
    finally { config.sessionMemoryLimit = previousLimit; }
    const oomKills = async () => Number(await exec(r, "import fs from 'node:fs'; console.log(/^oom_kill (\\d+)$/m.exec(fs.readFileSync('/sys/fs/cgroup/memory.events','utf8'))[1])"));
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
});
