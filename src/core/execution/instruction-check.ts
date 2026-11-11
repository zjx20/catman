import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Persona } from "../../config.js";
import { personaBriefing } from "../persona.js";
import { ContextStore, type ContextKind } from "./contexts.js";
import { instructionOptions, projectInstructions } from "./instructions.js";

export const INSTRUCTION_PROBE_PROMPT = "Reply ok without using tools.";

/** Title generation also sends the user's text, wrapped inside <session>. Match the
 * actual user turn exactly, so auxiliary SDK requests cannot mask a missing layer. */
export function isInstructionProbeRequest(request: unknown): boolean {
  if (!request || typeof request !== "object") return false;
  const messages = (request as { messages?: Array<{ role?: string; content?: unknown }> }).messages;
  return Array.isArray(messages) && messages.some(message => message.role === "user" && (
    message.content === INSTRUCTION_PROBE_PROMPT || (Array.isArray(message.content) && message.content.some(block => block?.type === "text" && block.text === INSTRUCTION_PROBE_PROMPT))
  ));
}

/** Synthetic data only. Shared by the deployment selfcheck and the real Docker regression. */
export function instructionFixture(root: string, kind: ContextKind) {
  const contexts = new ContextStore(root);
  const context = kind === "chat" ? contexts.chat("instruction-owner") : contexts.cron("instruction-owner", "instruction-job");
  const other = contexts.chat("instruction-other-owner");
  const sibling = contexts.chat(context.userKey);
  const paths = contexts.paths(context);
  const nonce = randomBytes(12).toString("hex");
  const marker = (name: string) => `CATMAN_INSTRUCTION_${name}_${nonce}`;
  const expected = { shared: marker("SHARED"), personal: marker("PERSONAL"), workspace: marker("WORKSPACE") };
  const forbidden = { otherPersonal: marker("OTHER_PERSONAL"), otherWorkspace: marker("OTHER_WORKSPACE"), siblingWorkspace: marker("SIBLING_WORKSPACE"), control: marker("CONTROL") };
  const put = (path: string, value: string) => writeFileSync(path, `# Instruction probe\n\n${value}\n`, { mode: 0o600 });
  mkdirSync(join(root, "shared"), { recursive: true });
  mkdirSync(join(root, "control-only"), { recursive: true });
  put(join(root, "shared/CLAUDE.md"), expected.shared);
  put(join(paths.home, "CLAUDE.md"), expected.personal);
  put(join(paths.work, "CLAUDE.md"), expected.workspace);
  put(join(contexts.paths(other).home, "CLAUDE.md"), forbidden.otherPersonal);
  put(join(contexts.paths(other).work, "CLAUDE.md"), forbidden.otherWorkspace);
  put(join(contexts.paths(sibling).work, "CLAUDE.md"), forbidden.siblingWorkspace);
  put(join(root, "control-only/CLAUDE.md"), forbidden.control);
  return { contexts, context, paths, expected, forbidden };
}

/** Inspect the first outbound prompt, never an LLM's claim about what it read. */
export function verifyInstructionRequest(request: unknown, fixture: { expected: Record<string, string>; forbidden: Record<string, string> }, persona: Persona): void {
  if (!request || typeof request !== "object") throw new Error("未捕获 CLI 的模型请求");
  const body = request as { system?: unknown; messages?: unknown };
  const text = JSON.stringify([body.system, body.messages]);
  for (const [layer, marker] of Object.entries(fixture.expected)) {
    if (!text.includes(marker)) throw new Error(`指令未加载：${layer}`);
  }
  for (const [layer, marker] of Object.entries(fixture.forbidden)) {
    if (text.includes(marker)) throw new Error(`指令越界加载：${layer}`);
  }
  // The identity is an assembly fact, separate from editable CLAUDE.md files.
  if (!(JSON.stringify(body.system) ?? "").includes(JSON.stringify(personaBriefing(persona)).slice(1, -1))) throw new Error(`人格身份未加载：${persona}`);
}

/**
 * A native CLI with production instruction options, isolated owner/context layout and
 * a loopback fake provider. No real data, provider credentials, model calls or Docker
 * socket needed (the pre-deploy smoke container intentionally has none).
 * Mount namespace/isolation is additionally covered by test:docker.
 */
export async function checkInstructions(root: string, persona: Persona, timeoutMs = 45_000): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let firstRequest: unknown;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      if (req.url?.includes("count_tokens")) { res.setHeader("content-type", "application/json"); res.end('{"input_tokens":5}'); return; }
      if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404); res.end("{}"); return; }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (isInstructionProbeRequest(body)) firstRequest ??= body;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: "msg_instruction_probe", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      send("message_stop", { type: "message_stop" }); res.end();
    } catch { res.writeHead(400); res.end("{}"); }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("指令自检端点未启动");
    for (const kind of ["chat", "cron"] as const) {
      const fixture = instructionFixture(join(root, kind), kind);
      const { paths } = fixture;
      projectInstructions(fixture.contexts.root, paths.home, join(paths.sdk, "CLAUDE.md"));
      firstRequest = undefined;
      // Explicitly unset inherited secrets/proxy/provider switches, even if SDK merges env.
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
      Object.assign(env, {
        PATH: process.env.PATH, HOME: paths.sdk, CLAUDE_CONFIG_DIR: paths.sdk,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "instruction-selfcheck-local-only",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        NO_PROXY: "127.0.0.1", DISABLE_TELEMETRY: "1",
      });
      const session = query({ prompt: INSTRUCTION_PROBE_PROMPT, options: {
        ...instructionOptions(persona), cwd: paths.work, env, model: "claude-sonnet-4-5", tools: [],
        maxTurns: 1, abortController: abort,
      } });
      try {
        let completed = false;
        for await (const message of session) {
          if (message.type !== "result") continue;
          if (message.is_error) throw new Error(`CLI 指令自检失败：${message.subtype}`);
          completed = true;
        }
        if (!completed) throw new Error("CLI 指令自检未完成");
        verifyInstructionRequest(firstRequest, fixture, persona);
      } finally { session.close(); }
    }
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`指令自检超时(${timeoutMs}ms)`);
    throw error;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
