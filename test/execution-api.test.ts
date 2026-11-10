import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { CapabilityBroker } from "../src/core/execution/broker.js";
import { ExecutionApi } from "../src/dashboard/api-execution.js";
import { TurnTokens } from "../src/core/turn-tokens.js";
import { executionFixture } from "./helpers/execution.js";

test("公共能力持有服务端密钥，按运行身份代理；普通用户不能修改配置或回收他人环境", async () => {
  const f = executionFixture();
  const seen: Array<Record<string, string | string[] | undefined>> = [];
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    seen.push({ ...req.headers }); res.setHeader("content-type", "application/json"); res.end('{"result":"public-data"}');
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const broker = new CapabilityBroker(`${f.config.dataDir}/execution/shared-tools.json`, f.runtimes, key => key === "admin");
  broker.configure({ mcp: {}, services: {
    public_search: { url: `http://127.0.0.1:${address.port}/fixed`, headers: { "x-provider-token": "server-secret" }, methods: ["POST"] },
    admin_service: { url: `http://127.0.0.1:${address.port}/admin`, adminOnly: true },
  } });
  const api = new ExecutionApi({ config: f.config, contexts: f.contexts, runtimes: f.runtimes, broker, turns: new TurnTokens(), isAdmin: key => key === "admin" });
  const server = createServer((req, res) => { void api.handle(req, res, new URL(req.url!, "http://localhost"), false); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const local = server.address(); assert.ok(local && typeof local !== "string");
  const url = `http://127.0.0.1:${local.port}`;
  try {
    const alice = f.contexts.chat("alice"), a = await f.runtimes.ensure(alice);
    const b = await f.runtimes.ensure(f.contexts.chat("bob"));
    const admin = await f.runtimes.ensure(f.contexts.chat("admin"));
    const headers = { "X-Catman-Runtime": a.token, "content-type": "application/json" };
    const response = await fetch(`${url}/api/runtime/services/public_search`, { method: "POST", headers: { ...headers, authorization: "Bearer attacker-value", cookie: "private-cookie=never" }, body: '{"q":"hello"}' });
    assert.equal(response.status, 200); assert.equal((await response.json() as { result: string }).result, "public-data");
    assert.equal(seen[0]?.["x-provider-token"], "server-secret"); assert.equal(seen[0]?.authorization, undefined); assert.equal(seen[0]?.cookie, undefined);
    assert.equal((await fetch(`${url}/api/execution/shared`, { headers })).status, 403);
    const denied = await fetch(`${url}/api/runtime/services/admin_service`, { headers }); assert.notEqual(denied.status, 200); await denied.text();
    const other = await fetch(`${url}/api/execution/${alice.id}/reclaim`, { method: "POST", headers: { ...headers, "X-Catman-Runtime": b.token }, body: "{}" });
    assert.notEqual(other.status, 200); await other.text(); assert.equal(f.runtimes.all().length, 3);
    const config = await fetch(`${url}/api/execution/shared`, { headers: { "X-Catman-Runtime": admin.token } });
    assert.equal(config.status, 200); assert.ok(!(await config.text()).includes("server-secret"));
    const own = await fetch(`${url}/api/execution`, { headers }); const view = await own.text();
    assert.ok(!view.includes(a.token)); assert.ok(!view.includes(b.token)); assert.ok(!view.includes('"bob"'));
    assert.equal((await fetch(`${url}/api/execution`, { headers: { "X-Catman-Runtime": "invalid" } })).status, 401);
  } finally {
    server.closeAllConnections(); upstream.closeAllConnections(); await broker.close();
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]); f.cleanup();
  }
});
