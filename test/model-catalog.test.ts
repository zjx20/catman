import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config, type HarnessId } from "../src/config.js";
import type { Agent, AgentReply, AgentRunOptions } from "../src/core/agent.js";
import { discoverAcpModels, spawnAcpSubprocess } from "../src/core/execution/acp-session.js";
import { ModelCatalog, type DiscoveredModel, type HarnessAvailability } from "../src/core/execution/model-catalog.js";
import { Gateway } from "../src/core/gateway.js";
import { PrefsStore } from "../src/core/prefs.js";
import { InMemoryStore, SessionManager } from "../src/core/session.js";
import { GlobalSettings } from "../src/core/settings.js";
import { TurnTokens } from "../src/core/turn-tokens.js";
import { UserRegistry } from "../src/core/users.js";
import type { Accepted, Channel, IncomingMessage } from "../src/channels/types.js";
import type { SendKind } from "../src/ipc/protocol.js";
import { handleSelfApi } from "../src/dashboard/api-self.js";

function baseConfig(root: string): Config {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("CATMAN_")) delete process.env[k];
  }
  process.env.CATMAN_DATA_DIR = root;
  const cfg = loadConfig();
  process.env = saved;
  return cfg;
}

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "catman-model-catalog-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("bind failed");
  return addr.port;
}

class FakeChannel implements Channel {
  readonly name = "stdin";
  readonly sent: Array<{ userKey: string; text: string; kind: SendKind }> = [];
  private handler?: (msg: IncomingMessage) => Accepted;

  onMessage(handler: (msg: IncomingMessage) => Accepted): void {
    this.handler = handler;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(userKey: string, text: string, kind: SendKind = "body"): Promise<void> {
    this.sent.push({ userKey, text, kind });
  }
  async receive(userKey: string, text: string): Promise<void> {
    const accepted = this.handler!({ userKey, text, attachments: [] });
    await accepted.settled;
  }
}

class FakeGatewayAgent {
  readonly calls: Array<{ prompt: string; opts: AgentRunOptions }> = [];
  nextReply?: (prompt: string, opts: AgentRunOptions) => Promise<AgentReply>;

  async run(prompt: string, opts: AgentRunOptions = {}): Promise<AgentReply> {
    this.calls.push({ prompt, opts });
    if (this.nextReply) return this.nextReply(prompt, opts);
    const sid = opts.resumeSessionId ?? `sess_${this.calls.length}`;
    opts.onSessionId?.(sid);
    return { text: `ok:${opts.harness}:${opts.model ?? "default"}:${prompt}`, sessionId: sid, isError: false, turns: 1 };
  }
}

test("零 Token 动态发现：Claude SDK supportedModels + 自定义 /v1/models 与 ACP configOptions 均不触发任何对话计费请求", async () => {
  await withTempDir(async (dir) => {
    let messageEndpointHit = false;
    const fakeUpstream = createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "custom-gateway-v3" }] }));
        return;
      }
      if (req.url?.startsWith("/v1/messages")) {
        messageEndpointHit = true;
        res.writeHead(500);
        res.end("must not call /v1/messages during catalog discovery");
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    const port = await listenLoopback(fakeUpstream);

    const acpScript = join(dir, "mock-acp-models.mjs");
    writeFileSync(
      acpScript,
      `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } } });
  } else if (msg.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "probe_1",
        configOptions: [{
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gemini-4.2-pro-live",
          options: [
            { value: "gemini-4.2-pro-live", name: "Gemini 4.2 Pro Live" },
            { value: "gemini-4.2-flash-live", name: "Gemini 4.2 Flash Live" }
          ]
        }]
      }
    });
  } else if (msg.method === "session/prompt") {
    process.exit(99); // 探测期绝不能发 prompt
  } else if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`,
      { mode: 0o600 },
    );

    try {
      // 1. 验证 ACP 零 Token 握手发现
      const acpDiscovered = await discoverAcpModels(
        () => spawnAcpSubprocess([process.execPath, acpScript], { cwd: dir, env: { ...process.env } }),
        { cwd: dir, timeoutMs: 10_000 },
      );
      assert.deepEqual(acpDiscovered, [
        { id: "gemini-4.2-pro-live", name: "Gemini 4.2 Pro Live" },
        { id: "gemini-4.2-flash-live", name: "Gemini 4.2 Flash Live" },
      ]);

      // 2. 验证 Claude SDK supportedModels() + 自定义网关 /v1/models 合并且零 /v1/messages 调用，并持久化缓存
      const cfg = baseConfig(dir);
      const cachePath = join(dir, "execution", "model-catalog.json");
      const catalog = new ModelCatalog({
        config: cfg,
        cachePath,
        env: () => ({
          ...process.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          ANTHROPIC_API_KEY: "local-probe-key",
        }),
      });
      await catalog.refresh("claude");
      assert.equal(messageEndpointHit, false, "探测模型目录绝不能调用 /v1/messages 花费 Token");
      const claudeEntry = catalog.entryOf("claude");
      assert.equal(claudeEntry.available, true);
      assert.equal(claudeEntry.source, "discovered");
      assert.ok(claudeEntry.models.some((m) => m.id === "opus"));
      assert.ok(claudeEntry.models.some((m) => m.id === "sonnet"));
      assert.ok(claudeEntry.models.some((m) => m.id === "custom-gateway-v3"), "合并自定义网关 /v1/models 返回的模型");

      // 3. 重启实例直接命中落盘缓存
      const reloaded = new ModelCatalog({
        config: cfg,
        cachePath,
        checkAvailability: () => ({ available: true }),
      });
      assert.equal(reloaded.entryOf("claude").source, "cached");
      assert.ok(reloaded.entryOf("claude").models.some((m) => m.id === "custom-gateway-v3"));
    } finally {
      fakeUpstream.closeAllConnections?.();
      await new Promise<void>((resolve) => fakeUpstream.close(() => resolve()));
    }
  });
});

test("GlobalSettings 与 PrefsStore：自动合并动态模型目录、可选白名单限流、跨引擎模型兼容回退", async () => {
  await withTempDir(async (dir) => {
    const cfg = baseConfig(dir);
    const catalog = new ModelCatalog({
      config: cfg,
      checkAvailability: (h) => ({ available: h === "claude" || h === "agy" }),
    });
    catalog.recordDiscoveredModels("claude", [{ id: "opus" }, { id: "sonnet" }]);
    catalog.recordDiscoveredModels("agy", [{ id: "gemini-4-carbon-high" }, { id: "gemini-3.8-flash-high" }]);

    const settings = new GlobalSettings({
      path: join(dir, "settings.json"),
      env: cfg,
      dynamicModels: () => catalog.dynamicAllowlist(),
    });
    const prefs = new PrefsStore({
      path: join(dir, "prefs.json"),
      defaults: () => settings.effective(),
      compatibleModel: (h, m) => catalog.compatibleModelFor(h, m),
    });

    // 未配置显式白名单时，自动合并两套就绪引擎的全部动态模型
    assert.equal(settings.hasExplicitModelAllowlist(), false);
    assert.deepEqual(settings.effective().modelAllowlist, [
      "opus",
      "sonnet",
      "gemini-4-carbon-high",
      "gemini-3.8-flash-high",
    ]);

    // 运行期新发现模型自动进入可用列表，无需改配置或重启
    catalog.recordDiscoveredModels("agy", [
      { id: "gemini-4-carbon-high" },
      { id: "gemini-3.8-flash-high" },
      { id: "gemini-4.5-ultra-preview" },
    ]);
    assert.ok(settings.effective().modelAllowlist.includes("gemini-4.5-ultra-preview"));

    // 全局默认是 claude + opus 时，某用户单切引擎到 agy，不会把 opus 错误带进 agy；切回默认引擎自动恢复 opus
    settings.set({ model: "opus" });
    prefs.set("u1", { harness: "agy" });
    assert.equal(prefs.effective("u1").harness, "agy");
    assert.equal(prefs.effective("u1").model, undefined);
    prefs.set("u1", { harness: null });
    assert.equal(prefs.effective("u1").harness, "claude");
    assert.equal(prefs.effective("u1").model, "opus");

    // 管理员可随时设显式 modelAllowlist 收窄范围，设为 null 恢复动态全量目录
    settings.set({ modelAllowlist: ["sonnet", "gemini-3.8-flash-high"] });
    assert.equal(settings.hasExplicitModelAllowlist(), true);
    assert.deepEqual(settings.effective().modelAllowlist, ["sonnet", "gemini-3.8-flash-high"]);
    settings.set({ modelAllowlist: null });
    assert.equal(settings.hasExplicitModelAllowlist(), false);
    assert.ok(settings.effective().modelAllowlist.includes("gemini-4.5-ultra-preview"));
  });
});

test("Gateway /引擎、/模型 跨引擎自动切换、多用户异构并发、不可用拦截与拼写纠错建议", async () => {
  await withTempDir(async (dir) => {
    const cfg = { ...baseConfig(dir), messageAggregationMs: 0 };
    const availability: Record<HarnessId, HarnessAvailability> = {
      claude: { available: true },
      agy: { available: true },
      acp: { available: false, reason: "未配置 CATMAN_ACP_COMMAND" },
    };
    let refreshHits = 0;
    const catalog = new ModelCatalog({
      config: cfg,
      checkAvailability: (h) => availability[h],
      discover: async (h): Promise<DiscoveredModel[]> => {
        refreshHits += 1;
        if (h === "claude") return [{ id: "opus" }, { id: "sonnet" }, { id: "haiku" }];
        if (h === "agy") return [{ id: "gemini-4-carbon-high" }, { id: "gemini-3.8-flash-high" }];
        return [];
      },
    });
    await catalog.refresh();

    const settings = new GlobalSettings({
      path: join(dir, "settings.json"),
      env: cfg,
      dynamicModels: () => catalog.dynamicAllowlist(),
    });
    const prefs = new PrefsStore({
      path: join(dir, "prefs.json"),
      defaults: () => settings.effective(),
      compatibleModel: (h, m) => catalog.compatibleModelFor(h, m),
    });
    const users = new UserRegistry({ path: join(dir, "users.json"), workspaceRoot: join(dir, "tenants") });
    const sessions = new SessionManager({ store: new InMemoryStore(), timeoutMs: 3600_000 });
    const turns = new TurnTokens();
    const channel = new FakeChannel();
    const agent = new FakeGatewayAgent();
    const gateway = new Gateway({
      modelCatalog: catalog,
      channel,
      agent: agent as unknown as Agent,
      sessions,
      users,
      prefs,
      settings,
      turns,
      apiBase: "http://catman:8787",
      reminderIntervalMs: 60_000,
    });
    await gateway.start();

    const U1 = "stdin:local:u1";
    const U2 = "stdin:local:u2";
    try {
      // 1. /引擎 查看所有引擎实时状态
      await channel.receive(U1, "/引擎");
      assert.match(channel.sent.at(-1)!.text, /✅ \*\*claude\*\*/);
      assert.match(channel.sent.at(-1)!.text, /✅ \*\*agy\*\*/);

      // 2. U1 在默认 claude 下直接发 `/模型 gemini-4-carbon-high` -> 自动联动切到 agy 引擎！
      await channel.receive(U1, "/模型 gemini-4-carbon-high");
      assert.match(channel.sent.at(-1)!.text, /模型已切到 gemini-4-carbon-high（已同步切到 agy 引擎）,下一轮生效/);
      assert.equal(prefs.effective(U1).harness, "agy");
      assert.equal(prefs.effective(U1).model, "gemini-4-carbon-high");

      // 3. 多用户并发异构：U1 跑在 agy 上，U2 保持在默认 claude 上，互不干扰
      await channel.receive(U1, "你好 agy");
      await channel.receive(U2, "你好 claude");
      assert.equal(agent.calls[0]!.opts.harness, "agy");
      assert.equal(agent.calls[0]!.opts.model, "gemini-4-carbon-high");
      assert.equal(agent.calls[1]!.opts.harness, "claude");

      // 4. 拼写输错时按编辑距离给出相近可用模型与一键复制代码块
      await channel.receive(U2, "/模型 gemni-4-carbon-hig");
      const typoReply = channel.sent.at(-1)!.text;
      assert.match(typoReply, /模型没改:/);
      assert.match(typoReply, /gemini-4-carbon-high/);
      assert.match(typoReply, /\/模型 gemini-4-carbon-high/);

      // 5. 当 agy 缺少凭据不可用时，U2 尝试切到 agy 或选 gemini 模型会被当场拦截并引导选可用模型
      availability.agy = { available: false, reason: "未配置 GEMINI_API_KEY" };
      await channel.receive(U2, "/模型 gemini-3.8-flash-high");
      const blockedModel = channel.sent.at(-1)!.text;
      assert.match(blockedModel, /模型没改:.*属于 `agy` 引擎.*未配置 GEMINI_API_KEY/);
      assert.match(blockedModel, /\/模型 opus/);
      assert.equal(prefs.effective(U2).harness, "claude", "被拒切换不得污染原有效配置");

      await channel.receive(U2, "/引擎 agy");
      const blockedHarness = channel.sent.at(-1)!.text;
      assert.match(blockedHarness, /引擎没改:agy 当前不可用（未配置 GEMINI_API_KEY）/);
      assert.match(blockedHarness, /\/引擎 claude/);

      // 6. `/模型 刷新` 主动触发零 Token 目录刷新
      const beforeRefresh = refreshHits;
      await channel.receive(U2, "/模型 刷新");
      assert.ok(refreshHits > beforeRefresh);
      assert.match(channel.sent.at(-1)!.text, /已刷新各引擎可用模型目录/);
    } finally {
      await gateway.stop();
    }
  });
});

test("回合事前拦截与事中故障逃生引导：不静默代切计费通道，自动附带健康引擎切换指令", async () => {
  await withTempDir(async (dir) => {
    const cfg = { ...baseConfig(dir), messageAggregationMs: 0 };
    const availability: Record<HarnessId, HarnessAvailability> = {
      claude: { available: true },
      agy: { available: true },
      acp: { available: false, reason: "未配置 CATMAN_ACP_COMMAND" },
    };
    const catalog = new ModelCatalog({
      config: cfg,
      checkAvailability: (h) => availability[h],
    });
    catalog.recordDiscoveredModels("claude", [{ id: "opus" }, { id: "sonnet" }]);
    catalog.recordDiscoveredModels("agy", [{ id: "gemini-4-carbon-high" }]);

    const settings = new GlobalSettings({
      path: join(dir, "settings.json"),
      env: cfg,
      dynamicModels: () => catalog.dynamicAllowlist(),
    });
    const prefs = new PrefsStore({
      path: join(dir, "prefs.json"),
      defaults: () => settings.effective(),
      compatibleModel: (h, m) => catalog.compatibleModelFor(h, m),
    });
    const users = new UserRegistry({ path: join(dir, "users.json"), workspaceRoot: join(dir, "tenants") });
    const sessions = new SessionManager({ store: new InMemoryStore(), timeoutMs: 3600_000 });
    const turns = new TurnTokens();
    const channel = new FakeChannel();
    const agent = new FakeGatewayAgent();
    const gateway = new Gateway({
      modelCatalog: catalog,
      channel,
      agent: agent as unknown as Agent,
      sessions,
      users,
      prefs,
      settings,
      turns,
      apiBase: "http://catman:8787",
      reminderIntervalMs: 60_000,
    });
    await gateway.start();

    const U = "stdin:local:alice";
    try {
      // 1. 事中报错（claude 429 限流，agy 健康）：保留错误原文并附上切去 agy 的代码块，且绝不自动偷跑第二次
      agent.nextReply = async () => ({
        text: "API Error: 429 rate limit exceeded",
        sessionId: "s_claude_1",
        isError: true,
        turns: 1,
      });
      await channel.receive(U, "帮我看看路由器状态");
      assert.equal(agent.calls.length, 1, "绝不背着用户静默切换到另一计费通道重跑");
      const rateLimitMsg = channel.sent.at(-1)!.text;
      assert.match(rateLimitMsg, /429 rate limit exceeded/);
      assert.match(rateLimitMsg, /检测到 `agy` 引擎当前可用/);
      assert.match(rateLimitMsg, /\/模型 gemini-4-carbon-high/);

      // 2. 事前拦截：用户切到 agy 后，宿主上的 agy 二进制或密钥突然丢失 -> 发消息立即给出原因与切回 claude 引导
      await channel.receive(U, "/模型 gemini-4-carbon-high");
      availability.agy = { available: false, reason: "未找到 agy 可执行文件" };
      agent.nextReply = undefined;
      const callsBefore = agent.calls.length;
      await channel.receive(U, "继续干活");
      assert.equal(agent.calls.length, callsBefore, "引擎未就绪时事前拦截，不起必败容器");
      const preflightMsg = channel.sent.at(-1)!.text;
      assert.match(preflightMsg, /当前选用的 `agy` 引擎不可用（未找到 agy 可执行文件）/);
      assert.match(preflightMsg, /检测到 `claude` 引擎当前可用/);
      assert.match(preflightMsg, /\/模型 opus/);

      // 3. `/api/me` 自然语言改设置接口同样支持跨引擎自动识别与不可用拦截
      availability.agy = { available: true };
      const selfDeps = { turns, prefs, users, sessions, settings, configDir: dir, modelCatalog: catalog };
      const u2 = "stdin:local:bob";
      users.ensureWorkspace(u2);
      const tok = turns.mint(u2).token;
      const okPatch = handleSelfApi("PATCH", "/api/me", tok, { model: "gemini-4-carbon-high" }, selfDeps);
      assert.equal(okPatch.status, 200);
      assert.equal(prefs.effective(u2).harness, "agy");
      assert.equal(prefs.effective(u2).model, "gemini-4-carbon-high");

      availability.agy = { available: false, reason: "未配置 GEMINI_API_KEY" };
      const badPatch = handleSelfApi("PATCH", "/api/me", tok, { harness: "agy" }, selfDeps);
      assert.equal(badPatch.status, 400);
      assert.match((badPatch.body as { error: string }).error, /未配置 GEMINI_API_KEY/);
    } finally {
      await gateway.stop();
    }
  });
});

test("ModelCatalog HTTP 回退探测自动继承 HTTP_PROXY（与 CapabilityBroker 一致）", async () => {
  await withTempDir(async (dir) => {
    const proxyRequests: Array<{ url: string; apiKey?: string }> = [];
    const proxyServer = createServer((req, res) => {
      proxyRequests.push({
        url: req.url ?? "",
        apiKey: typeof req.headers["x-goog-api-key"] === "string" ? req.headers["x-goog-api-key"] : undefined,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            {
              name: "models/gemini-2.5-pro",
              displayName: "Gemini 2.5 Pro",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxyServer.address() as { port: number }).port;

    // 构造一个不返回 configOptions 的最小 ACP 服务端，迫使 ModelCatalog 走 HTTP /v1beta/models 回退探测
    const emptyAcp = join(dir, "empty-acp.mjs");
    writeFileSync(
      emptyAcp,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
  } else if (msg.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s_1", configOptions: [] } }) + "\\n");
  } else if (msg.method === "session/close") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");
  }
});
`,
      { mode: 0o755 },
    );
    chmodSync(emptyAcp, 0o755);

    try {
      const cfg: Config = {
        ...baseConfig(dir),
        harness: "acp",
        acpCommand: [process.execPath, emptyAcp],
        acpUpstream: "gemini",
      };
      const catalog = new ModelCatalog({
        config: cfg,
        checkAvailability: (h) => ({ available: h === "acp" }),
        env: () => ({
          PATH: process.env.PATH,
          GEMINI_API_KEY: "test-gemini-key",
          GOOGLE_GEMINI_BASE_URL: "http://fake-gemini-upstream.example.com:8080",
          HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
          http_proxy: `http://127.0.0.1:${proxyPort}`,
        }),
      });
      await catalog.refresh("acp");
      assert.equal(proxyRequests.length, 1, "HTTP 回退模型列表探测应自动走 HTTP_PROXY");
      assert.match(proxyRequests[0]!.url, /^http:\/\/fake-gemini-upstream\.example\.com:8080\/v1beta\/models$/);
      assert.equal(proxyRequests[0]!.apiKey, "test-gemini-key");
      assert.deepEqual(
        catalog.entryOf("acp").models.map((m) => m.id),
        ["gemini-2.5-pro"],
      );
    } finally {
      proxyServer.closeAllConnections();
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    }
  });
});
