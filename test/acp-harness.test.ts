import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  parseCommandSpec,
  parseHarnessId,
  parseModelUpstream,
} from "../src/config.js";
import { Agent, type AgentProgressEvent } from "../src/core/agent.js";
import { AcpSession, spawnAcpSubprocess } from "../src/core/execution/acp-session.js";
import { ExecutionArtifacts } from "../src/core/execution/artifacts.js";
import { CapabilityBroker } from "../src/core/execution/broker.js";
import { ContextStore } from "../src/core/execution/contexts.js";
import { startLocalGeminiProbeServer } from "../src/core/execution/harness.js";
import { checkInstructions } from "../src/core/execution/instruction-check.js";
import { RuntimeManager } from "../src/core/execution/runtime.js";
import { TranscriptRecorder } from "../src/core/execution/transcript-recorder.js";
import { TurnTokens } from "../src/core/turn-tokens.js";
import { ExecutionApi } from "../src/dashboard/api-execution.js";
import { executionFixture } from "./helpers/execution.js";

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "catman-acp-test-"));
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
  if (!addr || typeof addr === "string") throw new Error("server failed to bind");
  return addr.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * 生成真实走 stdio JSON-RPC 2.0 的模拟 ACP v1 服务端脚本（用 `node` 子进程运行，覆盖真实管道与分帧）。
 */
function writeMockAcpAgentScript(dir: string): string {
  const scriptPath = join(dir, "mock-acp-agent.mjs");
  writeFileSync(
    scriptPath,
    `import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";

const mode = process.env.MOCK_ACP_MODE || "standard";
const logFile = process.env.MOCK_ACP_LOG || "";
const log = [];
function record(entry) {
  log.push(entry);
  if (logFile) writeFileSync(logFile, JSON.stringify(log, null, 2));
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

let activePrompt = false;
let cancelled = false;
let turnCounter = 0;
let pendingPermissionResolve = null;
const pendingClientRequests = new Map();
let nextServerReqId = 9000;

function requestClient(method, params) {
  const id = nextServerReqId++;
  return new Promise((resolve, reject) => {
    pendingClientRequests.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  record({ dir: "in", msg });

  if (msg.id !== undefined && !msg.method) {
    const waiter = pendingClientRequests.get(msg.id);
    if (waiter) {
      pendingClientRequests.delete(msg.id);
      if (msg.error) waiter.reject(msg.error);
      else waiter.resolve(msg.result);
    }
    return;
  }

  if (msg.method === "session/cancel") {
    cancelled = true;
    return;
  }

  if (msg.method === "initialize") {
    const imageCap = mode !== "no-image-cap";
    const resumeCap = mode === "load-replay" ? undefined : {};
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "mock-agy", version: "1.0.0" },
        agentCapabilities: {
          loadSession: mode === "load-replay",
          promptCapabilities: { image: imageCap, embeddedContext: true },
          mcpCapabilities: { http: true },
          sessionCapabilities: {
            ...(resumeCap ? { resume: resumeCap } : {}),
            close: {},
            additionalDirectories: {},
            systemPrompt: { mode: { override: {} } },
          },
        },
      },
    });
    return;
  }

  if (msg.method === "session/new" || msg.method === "session/resume" || msg.method === "session/load") {
    if (mode === "evil-session-id") {
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "../../etc/passwd", configOptions: [] } });
      return;
    }
    const sessionId = msg.params?.sessionId || "acp_sess_001";
    if (msg.method === "session/load" && mode === "load-replay") {
      // 模拟历史回放：客户端必须在 replaying 期间静默忽略这些通知
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "HISTORICAL_REPLAY_LEAK" } },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: "hist_1", name: "Bash", rawInput: { command: "old" } },
        },
      });
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId,
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "gemini-3.8-flash-medium",
            options: [
              { value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash Medium" },
              { value: "gemini-4-carbon-high", name: "Gemini 4 Carbon High" },
            ],
          },
          {
            id: "thinking_level",
            name: "Thinking Level",
            category: "thought_level",
            type: "select",
            currentValue: "High",
            options: [
              { value: "Low", name: "Low" },
              { value: "Medium", name: "Medium" },
              { value: "High", name: "High" },
              { value: "Extra", name: "Extra" },
              { value: "Max", name: "Max" },
            ],
          },
        ],
      },
    });
    return;
  }

  if (msg.method === "session/set_config_option") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { configOptions: [] },
    });
    return;
  }

  if (msg.method === "session/close") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }

  if (msg.method === "session/prompt") {
    const sessionId = msg.params.sessionId;
    turnCounter += 1;

    if (activePrompt && mode === "reject-steer") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Agent busy, concurrent prompt unsupported" } });
      return;
    }

    if (mode === "steer-wait") {
      if (!activePrompt) {
        activePrompt = true;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "等待补充输入..." } },
          },
        });
        await new Promise((r) => setTimeout(r, 120));
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", messageId: "m_final", content: { type: "text", text: "综合主输入与补充后的答复" } },
          },
        });
        activePrompt = false;
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        return;
      } else {
        // 收到并发 steering prompt
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        return;
      }
    }

    if (mode === "reject-steer") {
      if (turnCounter === 1) {
        activePrompt = true;
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "第一段思考" } },
          },
        });
        await new Promise((r) => setTimeout(r, 100));
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一段答复" } },
          },
        });
        activePrompt = false;
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        return;
      } else {
        const text = msg.params.prompt.find((b) => b.type === "text")?.text ?? "";
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "跟进答复:" + text } },
          },
        });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        return;
      }
    }

    if (mode === "permission-and-unauthorized-fs") {
      const perm = await requestClient("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "tc_perm", title: "Run command" },
        options: [
          { optionId: "opt_once", name: "Allow once", kind: "allow_once" },
          { optionId: "opt_always", name: "Allow always", kind: "allow_always" },
        ],
      });
      let fsBlocked = false;
      try {
        await requestClient("fs/read_text_file", { sessionId, path: "/etc/shadow" });
      } catch (err) {
        fsBlocked = err.code === -32601;
      }
      let termBlocked = false;
      try {
        await requestClient("terminal/create", { sessionId, command: "id" });
      } catch (err) {
        termBlocked = err.code === -32601;
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: JSON.stringify({ perm: perm.outcome, fsBlocked, termBlocked }),
            },
          },
        },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }

    if (mode === "budget-overflow") {
      cancelled = false;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "usage_update", used: 100, size: 100000, cost: { amount: 1.0, currency: "USD" } },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "usage_update", used: 500, size: 100000, cost: { amount: 3.5, currency: "USD" } },
        },
      });
      for (let i = 0; i < 30 && !cancelled; i++) await new Promise((r) => setTimeout(r, 20));
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: cancelled ? "cancelled" : "end_turn" } });
      return;
    }

    if (mode === "max-turns-loop") {
      cancelled = false;
      for (let step = 1; step <= 5 && !cancelled; step++) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "step " + step } },
          },
        });
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: { sessionUpdate: "tool_call", toolCallId: "tc_" + step, name: "Bash", rawInput: { command: "echo " + step } },
          },
        });
        await new Promise((r) => setTimeout(r, 30));
      }
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: cancelled ? "cancelled" : "end_turn" } });
      return;
    }

    if (mode === "subagent-detached") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "subagent_update",
            sessionId: "child_sub_1",
            title: "Background Researcher",
            state: { state: "running" },
          },
        },
      });
      // 子会话自己的输出块不应混入主回复
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "child_sub_1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "CHILD_INTERNAL_OUTPUT_DO_NOT_MIX" },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "已派发后台子智能体，稍后汇报。" },
          },
        },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "subagent_update",
              sessionId: "child_sub_1",
              title: "Background Researcher",
              state: { state: "idle", stopReason: "end_turn" },
            },
          },
        });
      }, 120);
      return;
    }

    // 默认 standard 模式：测试分块思考 + 中途发言 + 工具调用 + 最终答复（含多字节 UTF-8 跨块写）
    const chunks = [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "先分析" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "磁盘状态" } },
      { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "我先检查一下" } },
      { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "当前目录。" } },
      { sessionUpdate: "tool_call", toolCallId: "call_1", name: "Bash", rawInput: { command: "df -h" } },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "/dev/root 42% used" } }],
      },
      { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "检查完毕：" } },
      { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "空间充足🚀" } },
    ];
    for (const update of chunks) {
      const raw = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }) + "\\n", "utf8");
      // 故意把 UTF-8 多字节字符从字节中间拆成两半写出，验证 StringDecoder 不会产生乱码字符
      const mid = Math.max(1, raw.length - 3);
      process.stdout.write(raw.subarray(0, mid));
      process.stdout.write(raw.subarray(mid));
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`,
    { mode: 0o600 },
  );
  return scriptPath;
}

test("Config 解析多 Harness、命令规格与默认模型白名单", () => {
  assert.equal(parseHarnessId(undefined), "claude");
  assert.equal(parseHarnessId("CLAUDE"), "claude");
  assert.equal(parseHarnessId("agy"), "agy");
  assert.equal(parseHarnessId("antigravity"), "agy");
  assert.equal(parseHarnessId("acp"), "acp");
  assert.throws(() => parseHarnessId("unknown-cli"), /不支持的 CATMAN_HARNESS/);

  assert.equal(parseModelUpstream(undefined, "claude"), "anthropic");
  assert.equal(parseModelUpstream(undefined, "agy"), "gemini");
  assert.equal(parseModelUpstream("openai", "acp"), "openai");
  assert.throws(() => parseModelUpstream("bedrock", "acp"), /不支持的 CATMAN_ACP_UPSTREAM/);

  assert.deepEqual(parseCommandSpec('["codex-acp", "--stdio"]', "CATMAN_ACP_COMMAND"), ["codex-acp", "--stdio"]);
  assert.deepEqual(parseCommandSpec("gemini --acp", "CATMAN_ACP_COMMAND"), ["gemini", "--acp"]);
  assert.throws(() => parseCommandSpec("[]", "CATMAN_ACP_COMMAND"), /非空字符串数组/);

  const savedHarness = process.env.CATMAN_HARNESS;
  const savedCmd = process.env.CATMAN_ACP_COMMAND;
  const savedAllow = process.env.CATMAN_MODEL_ALLOWLIST;
  try {
    delete process.env.CATMAN_MODEL_ALLOWLIST;
    process.env.CATMAN_HARNESS = "agy";
    const agyCfg = loadConfig();
    assert.equal(agyCfg.harness, "agy");
    assert.ok(agyCfg.modelAllowlist.includes("gemini-4-carbon-high"));

    process.env.CATMAN_HARNESS = "acp";
    delete process.env.CATMAN_ACP_COMMAND;
    assert.throws(() => loadConfig(), /CATMAN_ACP_COMMAND/);

    process.env.CATMAN_ACP_COMMAND = '["gemini","--acp"]';
    const acpCfg = loadConfig();
    assert.equal(acpCfg.harness, "acp");
    assert.deepEqual(acpCfg.acpCommand, ["gemini", "--acp"]);
  } finally {
    if (savedHarness === undefined) delete process.env.CATMAN_HARNESS;
    else process.env.CATMAN_HARNESS = savedHarness;
    if (savedCmd === undefined) delete process.env.CATMAN_ACP_COMMAND;
    else process.env.CATMAN_ACP_COMMAND = savedCmd;
    if (savedAllow === undefined) delete process.env.CATMAN_MODEL_ALLOWLIST;
    else process.env.CATMAN_MODEL_ALLOWLIST = savedAllow;
  }
});

test("AcpSession 握手、模型/xhigh->Extra 配置映射、分块聚合与 Transcript 记录", async () => {
  await withTempDir(async (dir) => {
    const script = writeMockAcpAgentScript(dir);
    const rpcLog = join(dir, "rpc.json");
    const transcriptDir = join(dir, "transcripts");
    const progress: AgentProgressEvent[] = [];
    let observedSessionId = "";

    const session = new AcpSession(
      () =>
        spawnAcpSubprocess([process.execPath, script], {
          cwd: dir,
          env: { ...process.env, MOCK_ACP_LOG: rpcLog },
        }),
      {
        cwd: dir,
        model: "gemini-4-carbon-high",
        effort: "xhigh",
        additionalDirectories: ["/user"],
        mcpServers: {
          public_docs: { type: "http", url: "http://catman:8787/api/runtime/mcp/docs", headers: { "X-Catman-Runtime": "tok" } },
        },
        transcript: new TranscriptRecorder(transcriptDir),
        idleMs: 50,
        onClose: () => {},
        stopAgent: async () => {},
      },
    );

    try {
      const res = await session.run({
        prompt: "检查磁盘",
        attachments: [],
        ambient: "当前版本 abc1234",
        onSessionId: (id) => { observedSessionId = id; },
        onProgress: (ev) => progress.push(ev),
      });

      assert.equal(res.isError, false);
      assert.equal(res.sessionId, "acp_sess_001");
      assert.equal(observedSessionId, "acp_sess_001");
      assert.equal(res.text, "检查完毕：空间充足🚀");

      // 验证流式分块被正确聚合并遵循 ProgressFan 的「中途发言透出、最终答复不重复透出」契约
      assert.deepEqual(progress, [
        { kind: "thinking", text: "先分析磁盘状态" },
        { kind: "text", text: "我先检查一下当前目录。" },
        { kind: "tool", name: "Bash", input: { command: "df -h" } },
      ]);

      const recorded = JSON.parse(readFileSync(rpcLog, "utf8")) as Array<{ msg: any }>;
      const setConfigs = recorded
        .filter((e) => e.msg.method === "session/set_config_option")
        .map((e) => ({ id: e.msg.params.configId, value: e.msg.params.value }));
      assert.deepEqual(setConfigs, [
        { id: "model", value: "gemini-4-carbon-high" },
        { id: "thinking_level", value: "Extra" },
      ]);

      const newSessionReq = recorded.find((e) => e.msg.method === "session/new")!.msg;
      assert.deepEqual(newSessionReq.params.additionalDirectories, ["/user"]);
      assert.equal(newSessionReq.params.mcpServers[0].name, "public_docs");
      assert.equal(newSessionReq.params.mcpServers[0].type, "http");

      const promptReq = recorded.find((e) => e.msg.method === "session/prompt")!.msg;
      assert.equal(promptReq.params.prompt.length, 2);
      assert.match(promptReq.params.prompt[1].text, /<system-reminder>\n当前版本 abc1234\n<\/system-reminder>/);
    } finally {
      session.close();
    }
  });
});

test("AcpSession 支持 session/load 历史回放静默抑制，不把旧消息当新进度或回复发出", async () => {
  await withTempDir(async (dir) => {
    const script = writeMockAcpAgentScript(dir);
    const progress: AgentProgressEvent[] = [];
    const session = new AcpSession(
      () =>
        spawnAcpSubprocess([process.execPath, script], {
          cwd: dir,
          env: { ...process.env, MOCK_ACP_MODE: "load-replay" },
        }),
      {
        cwd: dir,
        resumeSessionId: "resumed_sess_42",
        idleMs: 50,
        onClose: () => {},
        stopAgent: async () => {},
      },
    );
    try {
      const res = await session.run({
        prompt: "继续",
        attachments: [],
        onProgress: (ev) => progress.push(ev),
      });
      assert.equal(res.sessionId, "resumed_sess_42");
      assert.ok(!res.text.includes("HISTORICAL_REPLAY_LEAK"));
      assert.ok(!JSON.stringify(progress).includes("HISTORICAL_REPLAY_LEAK"));
      assert.ok(!JSON.stringify(progress).includes("hist_1"));
    } finally {
      session.close();
    }
  });
});

test("AcpSession 多模态图片：支持 image 块直传，不支持时自动落盘发送 resource_link", async () => {
  await withTempDir(async (dir) => {
    const script = writeMockAcpAgentScript(dir);
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pngBase64 = pngBytes.toString("base64");
    const pngAttachment = { kind: "image" as const, mediaType: "image/png" as const, data: pngBase64, bytes: pngBytes.length };

    // 1. 支持 image capability：直接发内联 image block
    const logInline = join(dir, "inline.json");
    const s1 = new AcpSession(
      () => spawnAcpSubprocess([process.execPath, script], { cwd: dir, env: { ...process.env, MOCK_ACP_LOG: logInline } }),
      { cwd: dir, attachmentFallbackDir: join(dir, "fb1"), onClose: () => {}, stopAgent: async () => {} },
    );
    try {
      await s1.run({ prompt: "看图", attachments: [pngAttachment] });
      const req = (JSON.parse(readFileSync(logInline, "utf8")) as any[]).find((x) => x.msg.method === "session/prompt").msg;
      assert.equal(req.params.prompt[0].type, "image");
      assert.equal(req.params.prompt[0].data, pngBase64);
    } finally {
      s1.close();
    }

    // 2. 不支持 image capability：写入受控目录并发送 resource_link
    const logFallback = join(dir, "fallback.json");
    const fbDir = join(dir, "fb2");
    const s2 = new AcpSession(
      () =>
        spawnAcpSubprocess([process.execPath, script], {
          cwd: dir,
          env: { ...process.env, MOCK_ACP_MODE: "no-image-cap", MOCK_ACP_LOG: logFallback },
        }),
      { cwd: dir, attachmentFallbackDir: fbDir, onClose: () => {}, stopAgent: async () => {} },
    );
    try {
      await s2.run({ prompt: "看图", attachments: [pngAttachment] });
      const req = (JSON.parse(readFileSync(logFallback, "utf8")) as any[]).find((x) => x.msg.method === "session/prompt").msg;
      assert.equal(req.params.prompt[0].type, "resource_link");
      const savedPath = fileURLToPath(req.params.prompt[0].uri);
      assert.ok(savedPath.startsWith(fbDir));
      assert.equal(readFileSync(savedPath).toString("base64"), pngBase64);
    } finally {
      s2.close();
    }
  });
});

test("AcpSession 中途补话 feed()：支持并发 steering，且被服务端拒收时无损降级为同回合顺序跟进", async () => {
  await withTempDir(async (dir) => {
    const script = writeMockAcpAgentScript(dir);

    // 1. 服务端接受并发 steering prompt
    const steerLog = join(dir, "steer.json");
    const s1 = new AcpSession(
      () =>
        spawnAcpSubprocess([process.execPath, script], {
          cwd: dir,
          env: { ...process.env, MOCK_ACP_MODE: "steer-wait", MOCK_ACP_LOG: steerLog },
        }),
      { cwd: dir, supportsSteering: true, onClose: () => {}, stopAgent: async () => {} },
    );
    try {
      let steered = false;
      const runPromise = s1.run({
        prompt: "原始问题",
        attachments: [],
        onAlive: () => {
          // 收到首个思考块后立刻补话一次
          if (!steered) {
            steered = true;
            assert.equal(s1.feed("顺便查内存", []), true);
          }
        },
      });
      const reply = await runPromise;
      assert.equal(reply.text, "综合主输入与补充后的答复");
      const prompts = (JSON.parse(readFileSync(steerLog, "utf8")) as any[]).filter((x) => x.msg.method === "session/prompt");
      assert.equal(prompts.length, 2);
    } finally {
      s1.close();
    }

    // 2. 服务端拒绝并发 prompt (-32000)：自动转入 followUps 顺序执行，绝不丢消息
    const fallbackSession = new AcpSession(
      () =>
        spawnAcpSubprocess([process.execPath, script], {
          cwd: dir,
          env: { ...process.env, MOCK_ACP_MODE: "reject-steer" },
        }),
      { cwd: dir, supportsSteering: true, onClose: () => {}, stopAgent: async () => {} },
    );
    try {
      let fed = false;
      const reply = await fallbackSession.run({
        prompt: "主问题",
        attachments: [],
        onAlive: () => {
          if (!fed) {
            fed = true;
            assert.equal(fallbackSession.feed("补充要求", []), true);
          }
        },
      });
      assert.equal(reply.isError, false);
      assert.equal(reply.text, "第一段答复\n\n跟进答复:补充要求");
    } finally {
      fallbackSession.close();
    }
  });
});

test("AcpSession 自动放行工具权限请求，并以 -32601 拦截容器反向读写控制面文件或终端", async () => {
  await withTempDir(async (dir) => {
    const script = writeMockAcpAgentScript(dir);
    const session = new AcpSession(
      () =>
        spawnAcpSubprocess([process.execPath, script], {
          cwd: dir,
          env: { ...process.env, MOCK_ACP_MODE: "permission-and-unauthorized-fs" },
        }),
      { cwd: dir, onClose: () => {}, stopAgent: async () => {} },
    );
    try {
      const res = await session.run({ prompt: "test", attachments: [] });
      const parsed = JSON.parse(res.text);
      assert.deepEqual(parsed, {
        perm: { outcome: "selected", optionId: "opt_always" },
        fsBlocked: true,
        termBlocked: true,
      });
    } finally {
      session.close();
    }
  });
});

test("AcpSession 护栏：预算超限与最大轮数超限均发送 session/cancel 中止失控回合", async () => {
  await withTempDir(async (dir) => {
    const script = writeMockAcpAgentScript(dir);

    const budgetLog = join(dir, "budget.json");
    const sBudget = new AcpSession(
      () =>
        spawnAcpSubprocess([process.execPath, script], {
          cwd: dir,
          env: { ...process.env, MOCK_ACP_MODE: "budget-overflow", MOCK_ACP_LOG: budgetLog },
        }),
      { cwd: dir, maxBudgetUsd: 2.0, onClose: () => {}, stopAgent: async () => {} },
    );
    try {
      const res = await sBudget.run({ prompt: "run", attachments: [] });
      assert.equal(res.isError, true);
      assert.match(res.text, /预算上限/);
      const incoming = JSON.parse(readFileSync(budgetLog, "utf8")) as any[];
      assert.ok(incoming.some((e) => e.msg.method === "session/cancel"));
    } finally {
      sBudget.close();
    }

    const turnsLog = join(dir, "turns.json");
    const sTurns = new AcpSession(
      () =>
        spawnAcpSubprocess([process.execPath, script], {
          cwd: dir,
          env: { ...process.env, MOCK_ACP_MODE: "max-turns-loop", MOCK_ACP_LOG: turnsLog },
        }),
      { cwd: dir, maxTurns: 2, onClose: () => {}, stopAgent: async () => {} },
    );
    try {
      const res = await sTurns.run({ prompt: "loop", attachments: [] });
      assert.equal(res.isError, true);
      assert.match(res.text, /最大模型轮数上限/);
      const incoming = JSON.parse(readFileSync(turnsLog, "utf8")) as any[];
      assert.ok(incoming.some((e) => e.msg.method === "session/cancel"));
    } finally {
      sTurns.close();
    }
  });
});

test("AcpSession 跟踪后台子智能体生命周期并拒绝包含路径穿越的恶意 sessionId", async () => {
  await withTempDir(async (dir) => {
    const script = writeMockAcpAgentScript(dir);
    const taskSnapshots: Array<Array<{ task_id: string; description: string }>> = [];
    const bgNotices: string[] = [];

    const session = new AcpSession(
      () =>
        spawnAcpSubprocess([process.execPath, script], {
          cwd: dir,
          env: { ...process.env, MOCK_ACP_MODE: "subagent-detached" },
        }),
      {
        cwd: dir,
        idleMs: 40,
        onBackgroundTasksChanged: (tasks) => taskSnapshots.push(tasks),
        onBackgroundNotice: (text) => bgNotices.push(text),
        onClose: () => {},
        stopAgent: async () => {},
      },
    );
    try {
      const res = await session.run({ prompt: "spawn research", attachments: [] });
      assert.equal(res.text, "已派发后台子智能体，稍后汇报。");
      assert.ok(!res.text.includes("CHILD_INTERNAL_OUTPUT_DO_NOT_MIX"));
      assert.equal(session.hasBackgroundTasks, true, "子智能体仍在运行时保持后台任务标记并推迟空闲回收");

      await new Promise((r) => setTimeout(r, 180));
      assert.equal(session.hasBackgroundTasks, false);
      assert.ok(bgNotices.some((n) => n.includes("Background Researcher") && n.includes("已结束")));
      assert.deepEqual(taskSnapshots.at(-1), []);
    } finally {
      session.close();
    }

    const evil = new AcpSession(
      () =>
        spawnAcpSubprocess([process.execPath, script], {
          cwd: dir,
          env: { ...process.env, MOCK_ACP_MODE: "evil-session-id" },
        }),
      { cwd: dir, onClose: () => {}, stopAgent: async () => {} },
    );
    try {
      await assert.rejects(evil.run({ prompt: "hi", attachments: [] }), /非法的会话标识/);
    } finally {
      evil.close();
    }
  });
});

test("TranscriptRecorder 拒绝软链越界写入，且 ContextStore 同时索引 SDK 与 ACP 会话记录", async () => {
  await withTempDir(async (dir) => {
    const contexts = new ContextStore(dir);
    const ctx = contexts.chat("wechat:acct:alice");
    const paths = contexts.paths(ctx);
    const recorder = new TranscriptRecorder(paths.transcripts);

    recorder.recordUser("acp_100", "帮我查看路由器负载", []);
    recorder.recordAssistant("acp_100", [
      { type: "thinking", thinking: "准备跑 uptime" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "uptime" } },
    ]);
    recorder.recordToolResult("acp_100", "t1", "load average: 0.12", false);
    recorder.recordAssistant("acp_100", [{ type: "text", text: "当前负载很低（0.12）。" }]);
    recorder.recordResult("acp_100", "当前负载很低（0.12）。", false);
    contexts.started(ctx.id, "acp_100", "agy");

    assert.equal(contexts.sessionExists("wechat:acct:alice", "acp_100"), true);
    assert.equal(contexts.sessionExists("wechat:acct:bob", "acp_100"), false);

    const summaries = contexts.sessions("wechat:acct:alice");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.sessionId, "acp_100");
    assert.match(summaries[0]!.preview, /查看路由器负载/);

    const detail = contexts.read("acp_100", "wechat:acct:alice");
    assert.ok(detail.length >= 4);
    assert.ok(detail.some((m) => m.role === "assistant" && m.text.includes("0.12")));

    const hits = contexts.search("0.12", "wechat:acct:alice");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.sessionId, "acp_100");

    // 软链攻击防御：目标为符号链接时 O_NOFOLLOW 必须抛 ELOOP 拒绝追随覆写外部敏感文件
    const secretTarget = join(dir, "outside-secret.txt");
    writeFileSync(secretTarget, "DO_NOT_OVERWRITE", { mode: 0o600 });
    symlinkSync(secretTarget, join(paths.transcripts, "symlink_sess.jsonl"));
    assert.throws(() => recorder.recordUser("symlink_sess", "attacker payload", []), /ELOOP/);
    assert.equal(readFileSync(secretTarget, "utf8"), "DO_NOT_OVERWRITE");
  });
});

test("RuntimeManager 与 Agent 在 agy 模式下装配零凭据投影，并在切换引擎时自动重建容器与重绑会话", async () => {
  const f = executionFixture(true);
  try {
    // 1. 先以默认 claude 引擎启动会话上下文
    const ctx = f.contexts.chat("admin");
    const firstRuntime = await f.runtimes.ensure(ctx);
    assert.equal(firstRuntime.harness, "claude");
    const oldClaudeSessionId = ctx.sdkSessionId;
    f.contexts.started(ctx.id, oldClaudeSessionId, "claude");

    // 2. 在主数据目录放入可挂载的 agy 二进制并切换到 CATMAN_HARNESS=agy
    const agyBin = join(f.config.mainDataDir, "harness", "agy");
    mkdirSync(join(f.config.mainDataDir, "harness"), { recursive: true });
    writeFileSync(agyBin, "#!/bin/sh\n", { mode: 0o755 });

    const agyConfig = {
      ...f.config,
      harness: "agy" as const,
      harnessBin: agyBin,
      acpUpstream: "gemini" as const,
    };
    const agyRuntimes = new RuntimeManager(agyConfig, f.contexts, f.options);
    try {
      const secondRuntime = await agyRuntimes.ensure(ctx);
      assert.notEqual(secondRuntime.container, firstRuntime.container, "切换 Harness 后必须回收旧容器并创建新容器");
      assert.equal(secondRuntime.harness, "agy");

      const runCalls = f.calls.filter((c) => c.args[0] === "run");
      const agyRun = runCalls.at(-1)!;
      const mounts = agyRun.args.flatMap((arg, i) => (arg === "--mount" ? [agyRun.args[i + 1]!] : []));
      const p = f.contexts.paths(ctx);
      assert.ok(mounts.some((m) => m.includes(`dst=${p.sdk}/.gemini/GEMINI.md,readonly`)));
      assert.ok(mounts.some((m) => m.includes(`dst=${p.sdk}/.gemini/AGENTS.md,readonly`)));
      assert.ok(mounts.some((m) => m.includes(`dst=${p.sdk}/.gemini/antigravity-cli/settings.json,readonly`)));
      assert.ok(mounts.some((m) => m.includes(`dst=${p.sdk}/.gemini/config/skills`)));
      assert.ok(mounts.some((m) => m.includes("dst=/runtime/harness/agy,readonly")));
      assert.equal(agyRun.env?.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
      assert.equal(agyRun.env?.GEMINI_API_KEY, undefined, "docker run 环境绝不包含真实 GEMINI_API_KEY");

      const projection = new ExecutionArtifacts(agyConfig.dataDir).projection(ctx.id, secondRuntime.container.slice(-16));
      const settingsJson = JSON.parse(readFileSync(join(projection, "agy-settings.json"), "utf8"));
      assert.equal(settingsJson.modelProvider, "gemini");

      const wrapperContent = readFileSync(agyRuntimes.wrapper(ctx, secondRuntime), "utf8");
      assert.match(wrapperContent, /\/runtime\/harness\/agy/);
      assert.match(wrapperContent, /--process-per-session/);
      assert.match(wrapperContent, /'--add-dir' '\/user'/);
      assert.match(wrapperContent, /'--add-dir' '\/catman-src'/);

      // 3. 通过 Agent 驱动跨引擎会话重绑与真实 ACP 子进程执行
      const mockScript = writeMockAcpAgentScript(f.root);
      const envCapturePath = join(f.root, "captured-session-env.json");
      const rpcLog = join(f.root, "agent-acp-rpc.json");
      const mockWrapper = join(f.root, "mock-wrapper.sh");
      writeFileSync(
        mockWrapper,
        `#!/bin/sh
"${process.execPath}" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL,
  AGY_CLI_DISABLE_AUTO_UPDATE: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
  CONTROLLER_SECRET_LEAK_TEST: process.env.CONTROLLER_SECRET_LEAK_TEST
}))' "${envCapturePath}"
MOCK_ACP_LOG="${rpcLog}" exec "${process.execPath}" "${mockScript}"
`,
        { mode: 0o755 },
      );
      chmodSync(mockWrapper, 0o755);
      agyRuntimes.wrapper = () => mockWrapper;

      const broker = new CapabilityBroker(join(agyConfig.dataDir, "execution/shared-tools.json"), agyRuntimes, () => true);
      const agent = new Agent(agyConfig, { contexts: f.contexts, runtimes: agyRuntimes, broker });
      process.env.CONTROLLER_SECRET_LEAK_TEST = "must-not-leak-into-worker";
      try {
        const reply = await agent.run("切换引擎后的第一句话", {
          context: f.contexts.get(ctx.id)!,
          resumeSessionId: oldClaudeSessionId,
          model: "gemini-4-carbon-high",
          effort: "xhigh",
        });

        assert.equal(reply.isError, false);
        assert.equal(reply.sessionId, "acp_sess_001");

        // 验证传给子进程的仅是 runtime.token 能力令牌与控制面反代地址，控制面自身环境变量绝不泄漏
        const capturedEnv = JSON.parse(readFileSync(envCapturePath, "utf8"));
        assert.equal(capturedEnv.GEMINI_API_KEY, secondRuntime.token);
        assert.equal(capturedEnv.GOOGLE_GEMINI_BASE_URL, `${agyConfig.apiBase}/api/runtime/model/gemini`);
        assert.equal(capturedEnv.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
        assert.equal(capturedEnv.CONTROLLER_SECRET_LEAK_TEST, undefined);

        // 验证旧 Claude sessionId 被归档到 previousSessionIds，/切换会话 仍可按旧 ID 寻回该上下文
        const updatedCtx = f.contexts.bySession("admin", oldClaudeSessionId);
        assert.ok(updatedCtx, "旧引擎 sessionId 仍能定位回原上下文");
        assert.equal(updatedCtx!.id, ctx.id);
        assert.equal(updatedCtx!.sdkSessionId, "acp_sess_001");
        assert.equal(updatedCtx!.harness, "agy");

        // 验证跨引擎切换提示通过 ambient 注入，且新会话走了 session/new 而非拿着旧 Claude UUID 调 session/resume
        const rpcs = JSON.parse(readFileSync(rpcLog, "utf8")) as Array<{ msg: any }>;
        assert.ok(rpcs.some((r) => r.msg.method === "session/new"));
        assert.ok(!rpcs.some((r) => r.msg.method === "session/resume"));
        const promptBlocks = rpcs.find((r) => r.msg.method === "session/prompt")!.msg.params.prompt;
        assert.match(JSON.stringify(promptBlocks), /系统执行引擎已由 claude 切换为 agy/);
        assert.equal(f.contexts.sessionExists("admin", "acp_sess_001"), true);
      } finally {
        delete process.env.CONTROLLER_SECRET_LEAK_TEST;
        agent.close();
        await broker.close();
      }
    } finally {
      agyRuntimes.close();
    }
  } finally {
    f.cleanup();
  }
});

test("CapabilityBroker 与 ExecutionApi 代理 Gemini / OpenAI 模型请求：鉴权 runtime token、剥离 ?key= 并注入真实上游凭据", async () => {
  const f = executionFixture();
  const savedGeminiKey = process.env.GEMINI_API_KEY;
  const savedGeminiBase = process.env.GOOGLE_GEMINI_BASE_URL;
  const savedOpenAiKey = process.env.OPENAI_API_KEY;
  const savedOpenAiBase = process.env.OPENAI_BASE_URL;

  const geminiSeen: Array<{ url: string; headers: Record<string, unknown>; body: unknown }> = [];
  const geminiUpstream = startLocalGeminiProbeServer((url, body, headers) => {
    geminiSeen.push({ url, headers, body });
  });

  const openAiSeen: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
  const openAiUpstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    openAiSeen.push({
      url: req.url ?? "",
      auth: req.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {},
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_1", output_text: "openai-ok" }));
  });

  let apiServer: Server | undefined;
  let broker: CapabilityBroker | undefined;
  try {
    const geminiPort = await listenLoopback(geminiUpstream);
    const openAiPort = await listenLoopback(openAiUpstream);
    process.env.GEMINI_API_KEY = "real-control-plane-gemini-key";
    process.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${geminiPort}`;
    process.env.OPENAI_API_KEY = "real-control-plane-openai-key";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${openAiPort}`;

    const ctx = f.contexts.chat("alice");
    const runtime = await f.runtimes.ensure(ctx);
    broker = new CapabilityBroker(join(f.config.dataDir, "execution/shared-tools.json"), f.runtimes, () => false);
    const api = new ExecutionApi({
      config: f.config,
      contexts: f.contexts,
      runtimes: f.runtimes,
      broker,
      turns: new TurnTokens(),
      isAdmin: () => false,
    });
    apiServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void api.handle(req, res, url, false);
    });
    const apiPort = await listenLoopback(apiServer);

    // 1. Gemini SDK 经 ?key=<runtime.token> 发起请求：验证鉴权通过、?key= 被剥离且注入真实 x-goog-api-key
    const gRes = await fetch(
      `http://127.0.0.1:${apiPort}/api/runtime/model/gemini/v1beta/models/gemini-3.8-flash-high:generateContent?alt=json&key=${runtime.token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] }),
      },
    );
    assert.equal(gRes.status, 200);
    const gJson = (await gRes.json()) as any;
    assert.equal(gJson.candidates[0].content.parts[0].text, "ok");
    assert.equal(geminiSeen.length, 1);
    assert.equal(geminiSeen[0]!.url, "/v1beta/models/gemini-3.8-flash-high:generateContent?alt=json");
    assert.ok(!geminiSeen[0]!.url.includes(runtime.token), "绝不能把 runtime.token 透传到上游 URL");
    assert.equal(geminiSeen[0]!.headers["x-goog-api-key"], "real-control-plane-gemini-key");

    // 2. Gemini SSE 流式请求 + x-goog-api-key 头传递 runtime.token
    const gStream = await fetch(
      `http://127.0.0.1:${apiPort}/api/runtime/model/gemini/v1beta/models/gemini-4-carbon-high:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": runtime.token },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "stream" }] }] }),
      },
    );
    assert.equal(gStream.status, 200);
    assert.match(await gStream.text(), /data: /);

    // 3. OpenAI Responses 请求
    const oRes = await fetch(`http://127.0.0.1:${apiPort}/api/runtime/model/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${runtime.token}` },
      body: JSON.stringify({ model: "gpt-5", input: "hello" }),
    });
    assert.equal(oRes.status, 200);
    assert.equal(openAiSeen.length, 1);
    assert.equal(openAiSeen[0]!.auth, "Bearer real-control-plane-openai-key");

    // 4. 未列入白名单的模型端点一律拦截
    const blocked = await fetch(
      `http://127.0.0.1:${apiPort}/api/runtime/model/gemini/v1beta/files?key=${runtime.token}`,
    );
    assert.equal(blocked.status, 400);
    assert.match(await blocked.text(), /模型接口未授权/);
  } finally {
    if (savedGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedGeminiKey;
    if (savedGeminiBase === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
    else process.env.GOOGLE_GEMINI_BASE_URL = savedGeminiBase;
    if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAiKey;
    if (savedOpenAiBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedOpenAiBase;
    await broker?.close();
    if (apiServer) await closeServer(apiServer);
    await closeServer(geminiUpstream);
    await closeServer(openAiUpstream);
    f.cleanup();
  }
});

test("checkInstructions 支持 agy 与 acp 模式：校验三层指令加载、人格自述与租户隔离", async () => {
  await withTempDir(async (dir) => {
    const fakeAgyScript = join(dir, "fake-agy-cli.mjs");
    writeFileSync(
      fakeAgyScript,
      `import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HOME;
const baseUrl = process.env.GOOGLE_GEMINI_BASE_URL;
const apiKey = process.env.GEMINI_API_KEY;
const leakOther = process.env.TEST_LEAK_MARKER || "";

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "probe_sess", configOptions: [] } });
  } else if (msg.method === "session/prompt") {
    const geminiMd = readFileSync(join(home, ".gemini/GEMINI.md"), "utf8");
    const agentsMd = readFileSync(join(home, ".gemini/AGENTS.md"), "utf8");
    const workAgents = existsSync(join(process.cwd(), "AGENTS.md"))
      ? readFileSync(join(process.cwd(), "AGENTS.md"), "utf8")
      : "";
    const promptText = msg.params.prompt.map((b) => b.text || "").join("\\n");
    const resp = await fetch(baseUrl + "/v1beta/models/gemini-3.8-flash-medium:generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: geminiMd + "\\n" + agentsMd + "\\n" + workAgents + "\\n" + leakOther }] },
        contents: [{ role: "user", parts: [{ text: promptText }] }],
      }),
    });
    const data = await resp.json();
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "ok";
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "probe_sess", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: replyText } } },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  }
});
`,
      { mode: 0o600 },
    );

    // 1. 正常三层隔离通过（primary 与 rescue 两个人格）
    for (const persona of ["primary", "rescue"] as const) {
      await checkInstructions(join(dir, `agy-${persona}`), persona, 15_000, {
        harness: "agy",
        harnessBin: undefined,
        acpCommand: [process.execPath, fakeAgyScript],
      });
    }

    // 2. 通用 ACP 模式投影隔离检查通过
    await checkInstructions(join(dir, "generic-acp"), "primary", 10_000, {
      harness: "acp",
      harnessBin: undefined,
      acpCommand: [process.execPath, fakeAgyScript],
    });
  });
});
