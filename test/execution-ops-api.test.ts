import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionFixture } from "./helpers/execution.js";
import { OpsManager } from "../src/core/execution/ops.js";
import { CapabilityBroker } from "../src/core/execution/broker.js";
import { ExecutionApi } from "../src/dashboard/api-execution.js";
import { TurnTokens } from "../src/core/turn-tokens.js";
import { Dashboard } from "../src/dashboard/server.js";
import { DashboardChannel } from "../src/channels/dashboard.js";
import { GlobalSettings } from "../src/core/settings.js";
import { UserRegistry } from "../src/core/users.js";
import { PrefsStore } from "../src/core/prefs.js";
import { SessionManager, InMemoryStore } from "../src/core/session.js";
import { loadConfig } from "../src/config.js";
import { BUILTIN_ADMIN_USER_KEY } from "../src/core/identity.js";

test("HTTP 只能申请部署能力，管理员 agent 也不能调用授权接口或代领别的会话凭证", async () => {
  const f = executionFixture(true);
  const config = { ...f.config, ops: { image: "catman-ops:test", mounts: [], dockerSocket: false, memory: "256m", maxActive: 1 } };
  const isAdmin = (key: string) => key === "admin";
  const ops = new OpsManager(config, f.contexts, f.runtimes, { isAdmin, notify: () => {} });
  const broker = new CapabilityBroker(join(f.config.dataDir, "shared-tools.json"), f.runtimes, isAdmin);
  const api = new ExecutionApi({ config, contexts: f.contexts, runtimes: f.runtimes, broker, ops, turns: new TurnTokens(), isAdmin });
  const server = createServer((req, res) => { void api.handle(req, res, new URL(req.url!, "http://localhost"), false); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/runtime/ops`;
  try {
    const parent = await f.runtimes.ensure(f.contexts.chat("admin")), ordinary = await f.runtimes.ensure(f.contexts.chat("alice"));
    const call = async (path: string, token = parent.token, body?: unknown) => {
      const response = await fetch(`${base}/${path}`, { method: body === undefined ? "GET" : "POST", headers: { "X-Catman-Runtime": token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as { id: string; description: string } };
    };
    assert.equal((await call("request", ordinary.token, { reason: "提权" })).status, 403);
    assert.equal((await call("request", parent.token, { reason: "提权", mounts: ["/"] })).status, 400);
    const request = await call("request", parent.token, { reason: "排查" }); assert.equal(request.status, 200);
    assert.match(request.body.description, /未挂载/);
    assert.equal((await call("grant", parent.token, { id: request.body.id })).status, 404);
    assert.equal((await call("connection")).status, 400);
    const prepare = await fetch(`http://127.0.0.1:${address.port}/api/execution/prepare`, { method: "POST", headers: { "X-Catman-Runtime": parent.token, "content-type": "application/json" }, body: '{"ref":"HEAD"}' });
    assert.equal(prepare.status, 403); await prepare.text();
    assert.equal((await call("status", "invalid")).status, 401);
    assert.equal(f.calls.filter(c => c.args[0] === "run").length, 2, "所有 HTTP 请求都没有创建运维容器");
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await broker.close(); ops.close(); f.cleanup(); }
});

test("管理员会话令牌不能读取含 Dashboard 凭据的页面或伪造用户硬指令，独立用户认证仍可聊天", async () => {
  const root = mkdtempSync(join(tmpdir(), "catman-ops-auth-"));
  const config = loadConfig(), turns = new TurnTokens(), token = "independent-dashboard-secret";
  const settings = new GlobalSettings({ path: join(root, "settings.json"), env: config });
  const prefs = new PrefsStore({ path: join(root, "prefs.json"), defaults: () => settings.effective() });
  const users = new UserRegistry({ path: join(root, "users.json"), workspaceRoot: join(root, "tenants") });
  const sessions = new SessionManager({ store: new InMemoryStore(), timeoutMs: 3600_000 });
  const chat = new DashboardChannel(); const received: string[] = [];
  chat.onMessage(message => { received.push(message.text); return { settled: Promise.resolve() }; });
  const dashboard = new Dashboard({ port: 0, adminToken: token, configDir: root, workspaceRoot: root, users, chat, selfApi: { turns, prefs, users, sessions, settings, configDir: root }, adminApi: { settings, prefs, users } });
  dashboard.start();
  const server = Reflect.get(dashboard, "server") as Server;
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const turn = turns.mint(BUILTIN_ADMIN_USER_KEY), delegated = { "X-Catman-Session": turn.token };
  try {
    for (const path of ["/chat", "/users", "/api/chat/stream"]) {
      const response = await fetch(`${base}${path}`, { headers: delegated });
      assert.equal(response.status, 401); assert.ok(!(await response.text()).includes(token));
    }
    const denied = await fetch(`${base}/api/chat`, { method: "POST", headers: { ...delegated, "content-type": "application/json" }, body: JSON.stringify({ text: "/授权 o_123" }) });
    assert.equal(denied.status, 403); await denied.text(); assert.deepEqual(received, []);
    const settingsResponse = await fetch(`${base}/api/settings`, { headers: delegated });
    assert.equal(settingsResponse.status, 200); assert.ok(!(await settingsResponse.text()).includes(token));
    const accepted = await fetch(`${base}/api/chat`, { method: "POST", headers: { "X-Catman-Token": token, "content-type": "application/json" }, body: JSON.stringify({ text: "/授权 o_123" }) });
    assert.equal(accepted.status, 200); await accepted.text(); assert.deepEqual(received, ["/授权 o_123"]);
  } finally { turn.revoke(); server.closeAllConnections(); await dashboard.stop(); rmSync(root, { recursive: true, force: true }); }
});
