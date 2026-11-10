import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SdkSession } from "../src/core/execution/sdk-session.js";
import { buildUserMessage } from "../src/core/agent.js";

/** Real CLI + real Bash background execution, with an entirely local fake model (no API credentials). */
test("真实 SDK：后台 Bash 留在原 CLI，前台回复后还能处理下一条用户消息", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "catman-native-sdk-"));
  let requests = 0; const events: SDKMessage[] = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume locally; never log prompts */ }
    if (req.url?.includes("count_tokens")) { res.setHeader("content-type", "application/json"); res.end('{"input_tokens":5}'); return; }
    if (!req.url?.includes("/messages")) { res.writeHead(404); res.end("{}"); return; }
    requests++;
    const tool = requests <= 2;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send("message_start", { type: "message_start", message: { id: `msg_local_${requests}`, type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
    if (tool) {
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `tool_local_${requests}`, name: "Bash", input: {} } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({
        command: `${JSON.stringify(process.execPath)} -e 'setTimeout(()=>console.log("probe-done"),${requests === 1 ? 4500 : 1800})'`, run_in_background: requests === 2, description: requests === 1 ? "local foreground probe" : "local background probe",
      }) } });
    } else {
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "local reply" } });
    }
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    send("message_stop", { type: "message_stop" }); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const session = new SdkSession(input => query({ prompt: input, options: {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, "config"),
      ANTHROPIC_API_KEY: "local-test-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    model: "claude-sonnet-4-5", systemPrompt: "Use Bash when requested.", settingSources: [], tools: ["Bash"], permissionMode: "bypassPermissions", perTaskStopAffordance: true,
  } }), { onBackground: message => { events.push(message); }, onClose: () => {}, stopAgent: async () => {}, idleMs: 100 });
  try {
    const foreground: SDKMessage[] = [];
    const first = await session.run({ message: buildUserMessage("start a bounded local probe", []), onMessage: m => { foreground.push(m); } });
    assert.equal(first.text, "local reply");
    assert.ok(foreground.some(m => m.type === "system" && m.subtype === "task_notification" && m.summary === "local foreground probe"), "实际前台 Bash 也发任务结束事件");
    assert.ok(!events.some(m => m.type === "system" && m.subtype === "task_notification" && m.summary === "local foreground probe"), "前台事件不转为单独用户通知");
    assert.ok(events.some(m => m.type === "system" && m.subtype === "background_tasks_changed" && m.tasks.length > 0), "实际 CLI 发出后台任务完整快照");
    await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(session.alive, true);
    const second = await session.run({ message: buildUserMessage("second user turn", []), onMessage: () => {} });
    assert.equal(second.text, "local reply"); assert.equal(second.sessionId, first.sessionId);
    const deadline = Date.now() + 8000;
    while (!events.some(m => m.type === "system" && m.subtype === "task_notification") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(events.some(m => m.type === "system" && m.subtype === "task_notification" && m.status === "completed"));
  } finally {
    session.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  }
});
