import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { Attachment } from "../attachments.js";
import { AGENT_TRACE, shortNum } from "../agent-trace.js";
import type { AgentProgressEvent } from "../agent.js";
import { ProgressFan, joinReplyTexts } from "../agent.js";
import { TranscriptRecorder, assertSafeSessionId, type RecordedAssistantBlock } from "./transcript-recorder.js";

/**
 * Agent Client Protocol (ACP v1) 客户端会话（JSON-RPC 2.0 over stdio）。
 *
 * 零外部依赖实现，直接驱动原生内置 `acp` 的 CLI（如 `agy acp`、`gemini --acp`）
 * 或官方桥接器（如 `codex-acp`），与 `SdkSession` 对齐生命周期：
 * - 单上下文保持常驻连接，回合空闲且无活跃子智能体后自动按 `idleMs` 释放；
 * - 流式分块在工具边界与回合边界聚合后再喂给 `ProgressFan`，避免逐 token 刷爆渠道额度；
 * - 拒绝任何未声明的 `fs/*`、`terminal/*` 反向调用，确保所有工具执行严格留在容器内。
 */

export type AcpMcpServerSpec =
  | { type?: "stdio"; command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }
  | { type: "http"; url: string; headers?: Readonly<Record<string, string>> };

export interface AcpDuplexStreams {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr?: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export type AcpProcessSpawner = () => AcpDuplexStreams;

export function spawnAcpSubprocess(
  command: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): AcpDuplexStreams {
  if (!command.length || !command[0]) throw new Error("ACP 启动命令不能为空");
  const child: ChildProcessWithoutNullStreams = spawn(command[0], command.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill(signal = "SIGTERM") {
      try { child.kill(signal); } catch {}
    },
    onExit(listener) {
      child.once("exit", listener);
    },
    onError(listener) {
      child.once("error", listener);
    },
  };
}

export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  mcpCapabilities?: {
    http?: boolean;
    sse?: boolean;
  };
  sessionCapabilities?: {
    resume?: Record<string, unknown> | null;
    close?: Record<string, unknown> | null;
    additionalDirectories?: Record<string, unknown> | null;
    systemPrompt?: { mode?: { override?: Record<string, unknown> | null } } | null;
  };
}

interface AcpSelectOption {
  value: string;
  name: string;
  description?: string;
}

interface AcpConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string | boolean;
  options?: Array<AcpSelectOption | { group: string; name: string; options: AcpSelectOption[] }>;
}

export interface AcpTurnInput {
  prompt: string;
  attachments: readonly Attachment[];
  ambient?: string;
  signal?: AbortSignal;
  onSessionId?: (id: string) => void;
  onAlive?: () => void;
  onProgress?: (ev: AgentProgressEvent) => void;
  onNotice?: (text: string) => void;
}

export interface AcpTurnResult {
  text: string;
  sessionId: string;
  isError: boolean;
  turns: number;
}

export interface AcpSessionOptions {
  cwd: string;
  /** 用于不支持内联 image 块的 ACP 服务端回退写入附件并发送 resource_link。 */
  attachmentFallbackDir?: string;
  resumeSessionId?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  additionalDirectories?: readonly string[];
  systemPromptAppend?: string;
  mcpServers?: Readonly<Record<string, AcpMcpServerSpec>>;
  /** 是否允许在 `session/prompt` 运行中途并发发送 steering `session/prompt`。 */
  supportsSteering?: boolean;
  transcript?: TranscriptRecorder;
  logLabel?: string;
  idleMs?: number;
  onStderr?: (line: string) => void;
  onBackgroundTasksChanged?: (tasks: Array<{ task_id: string; description: string; ambient?: boolean }>) => void;
  onBackgroundNotice?: (text: string, id?: string) => void;
  onClose: () => void;
  stopAgent: () => Promise<unknown>;
}

interface ChildSubagentState {
  sessionId: string;
  title: string;
  state?: "running" | "requires_action" | "idle" | "unknown" | string;
  detached?: boolean;
}

interface PendingTurnState {
  turn: AcpTurnInput;
  fan: ProgressFan;
  thoughtBuf: string;
  textBuf: string;
  currentMessageId?: string;
  replies: string[];
  followUps: Array<{ prompt: string; attachments: readonly Attachment[] }>;
  inFlightSteers: Set<Promise<void>>;
  toolNames: Map<string, string>;
  recordedTools: Set<string>;
  modelSteps: number;
  hadActivitySinceStep: boolean;
  startCostUsd?: number;
  latestCostUsd?: number;
  limitExceededReason?: string;
  cancelling: boolean;
  abortHandler: () => void;
}

function extForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: return "bin";
  }
}

function flattenSelectOptions(opt: AcpConfigOption): AcpSelectOption[] {
  if (!Array.isArray(opt.options)) return [];
  const out: AcpSelectOption[] = [];
  for (const item of opt.options) {
    if (item && typeof item === "object" && "options" in item && Array.isArray(item.options)) {
      out.push(...item.options);
    } else if (item && typeof item === "object" && "value" in item && typeof item.value === "string") {
      out.push(item);
    }
  }
  return out;
}

function matchEffortOption(effort: string, candidates: readonly AcpSelectOption[]): string | undefined {
  const target = effort.trim().toLowerCase();
  const aliases = target === "xhigh" ? ["xhigh", "extra", "extra high", "extra-high"] : [target];
  for (const alias of aliases) {
    const hit = candidates.find(
      (c) => c.value.toLowerCase() === alias || c.name.toLowerCase() === alias,
    );
    if (hit) return hit.value;
  }
  return undefined;
}

function extractTextFromToolContent(content: unknown, rawOutput: unknown): string {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (obj["type"] === "content" && obj["content"] && typeof obj["content"] === "object") {
        const inner = obj["content"] as Record<string, unknown>;
        if (typeof inner["text"] === "string") parts.push(inner["text"]);
      } else if (obj["type"] === "diff" && typeof obj["path"] === "string") {
        parts.push(`[diff] ${obj["path"]}`);
      } else if (typeof obj["text"] === "string") {
        parts.push(obj["text"]);
      }
    }
  }
  if (parts.length) return parts.join("\n");
  if (typeof rawOutput === "string") return rawOutput;
  if (rawOutput !== undefined && rawOutput !== null) {
    try { return JSON.stringify(rawOutput, null, 2); } catch { return String(rawOutput); }
  }
  return "";
}

export class AcpSession {
  private readonly proc: AcpDuplexStreams;
  private readonly rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private closed = false;
  private initPromise?: Promise<void>;
  private caps: AcpAgentCapabilities = {};
  private configOptions: AcpConfigOption[] = [];
  private sessionId = "";
  private replaying = false;
  private current?: PendingTurnState;
  private rejectRun?: (err: Error) => void;
  private readonly subagents = new Map<string, ChildSubagentState>();
  private cumulativeCostUsd?: number;
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(
    spawner: AcpProcessSpawner,
    private readonly opts: AcpSessionOptions,
  ) {
    this.proc = spawner();
    this.wireStreams();
  }

  get alive(): boolean {
    return !this.closed;
  }

  get busy(): boolean {
    return Boolean(this.current);
  }

  get hasBackgroundTasks(): boolean {
    for (const sub of this.subagents.values()) {
      if (sub.state === "running" || sub.state === "requires_action") return true;
    }
    return false;
  }

  private wireStreams(): void {
    const outDecoder = new StringDecoder("utf8");
    let outBuf = "";
    this.proc.stdout.on("data", (chunk: Buffer | string) => {
      outBuf += typeof chunk === "string" ? chunk : outDecoder.write(chunk);
      let nl: number;
      while ((nl = outBuf.indexOf("\n")) >= 0) {
        const line = outBuf.slice(0, nl).replace(/\r$/, "");
        outBuf = outBuf.slice(nl + 1);
        if (line.trim()) this.onStdoutLine(line);
      }
    });
    this.proc.stdout.once("end", () => {
      const tail = (outBuf + outDecoder.end()).trim();
      if (tail) this.onStdoutLine(tail);
    });

    if (this.proc.stderr) {
      const errDecoder = new StringDecoder("utf8");
      let errBuf = "";
      this.proc.stderr.on("data", (chunk: Buffer | string) => {
        errBuf += typeof chunk === "string" ? chunk : errDecoder.write(chunk);
        let nl: number;
        while ((nl = errBuf.indexOf("\n")) >= 0) {
          const line = errBuf.slice(0, nl).replace(/\r$/, "");
          errBuf = errBuf.slice(nl + 1);
          if (line.trim()) this.opts.onStderr?.(line);
        }
      });
      this.proc.stderr.once("end", () => {
        const tail = (errBuf + errDecoder.end()).trim();
        if (tail) this.opts.onStderr?.(tail);
      });
    }

    this.proc.onError((err) => {
      this.close(err);
    });
    this.proc.onExit((code, signal) => {
      const detail = signal ? `信号 ${signal}` : `退出码 ${code ?? 0}`;
      this.close(new Error(`ACP 进程已退出(${detail})`));
    });
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.closed) throw new Error("ACP 会话已关闭");
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rpc<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("ACP 会话已关闭"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.rpcPending.set(id, { resolve, reject });
      try {
        this.sendJson({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
      } catch (err) {
        this.rpcPending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.sendJson({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
    } catch {}
  }

  private onStdoutLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // 某些 CLI 在首行可能输出非 JSON 提示，转交 stderr 诊断而不直接崩掉连接。
      this.opts.onStderr?.(line);
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;

    if (typeof m["id"] === "number" && ("result" in m || "error" in m)) {
      const waiter = this.rpcPending.get(m["id"]);
      if (!waiter) return;
      this.rpcPending.delete(m["id"]);
      if (m["error"] && typeof m["error"] === "object") {
        const e = m["error"] as Record<string, unknown>;
        waiter.reject(
          new AcpRpcError(
            typeof e["code"] === "number" ? e["code"] : -32603,
            typeof e["message"] === "string" ? e["message"] : JSON.stringify(e),
            e["data"],
          ),
        );
      } else {
        waiter.resolve(m["result"]);
      }
      return;
    }

    if (typeof m["method"] === "string" && ("id" in m && m["id"] !== undefined)) {
      this.handleAgentRequest(m["id"] as number | string, m["method"], m["params"]);
      return;
    }

    if (typeof m["method"] === "string") {
      if (m["method"] === "session/update") {
        this.handleSessionUpdate(m["params"]);
      }
    }
  }

  private handleAgentRequest(id: number | string, method: string, params: unknown): void {
    const reply = (result: unknown) => {
      if (this.closed) return;
      try { this.sendJson({ jsonrpc: "2.0", id, result }); } catch {}
    };
    const replyError = (code: number, message: string) => {
      if (this.closed) return;
      try { this.sendJson({ jsonrpc: "2.0", id, error: { code, message } }); } catch {}
    };

    if (method === "session/request_permission") {
      if (!this.current || this.current.cancelling || this.closed) {
        reply({ outcome: { outcome: "cancelled" } });
        return;
      }
      const p = (params ?? {}) as { options?: Array<{ optionId?: string; kind?: string }> };
      const options = Array.isArray(p.options) ? p.options : [];
      const chosen =
        options.find((o) => o.kind === "allow_always" && typeof o.optionId === "string") ??
        options.find((o) => o.kind === "allow_once" && typeof o.optionId === "string") ??
        options.find((o) => typeof o.optionId === "string" && !String(o.kind ?? "").startsWith("reject"));
      if (chosen?.optionId) {
        reply({ outcome: { outcome: "selected", optionId: chosen.optionId } });
      } else {
        reply({ outcome: { outcome: "cancelled" } });
      }
      return;
    }

    if (method === "elicitation/create") {
      reply({ action: "cancel" });
      return;
    }

    // 严禁容器内的 ACP 进程反向调用控制面的文件系统或终端。
    replyError(-32601, `Unsupported client method: ${method}`);
  }

  private buildAcpMcpList(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const [name, spec] of Object.entries(this.opts.mcpServers ?? {})) {
      if (spec.type === "http") {
        if (!this.caps.mcpCapabilities?.http) continue;
        out.push({
          type: "http",
          name,
          url: spec.url,
          headers: Object.entries(spec.headers ?? {}).map(([k, v]) => ({ name: k, value: v })),
        });
      } else {
        out.push({
          name,
          command: spec.command,
          args: [...(spec.args ?? [])],
          env: Object.entries(spec.env ?? {}).map(([k, v]) => ({ name: k, value: v })),
        });
      }
    }
    return out;
  }

  private async ensureInitialized(onSessionId?: (id: string) => void): Promise<void> {
    if (this.sessionId) {
      onSessionId?.(this.sessionId);
      await this.applyConfigOptions();
      return;
    }
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const initRes = await this.rpc<{
          protocolVersion?: number;
          agentCapabilities?: AcpAgentCapabilities;
          agentInfo?: { name?: string; version?: string };
        }>("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            plan: {},
            subagents: {},
            session: {
              compaction: {},
              notices: {},
              configOptions: { boolean: {} },
            },
          },
          clientInfo: { name: "catman", title: "Catman", version: "0.1.0" },
        });
        if (initRes?.protocolVersion !== undefined && initRes.protocolVersion !== 1) {
          throw new Error(`不支持的 ACP 协议版本: ${initRes.protocolVersion}`);
        }
        this.caps = initRes?.agentCapabilities ?? {};

        const commonParams: Record<string, unknown> = {
          cwd: this.opts.cwd,
          mcpServers: this.buildAcpMcpList(),
        };
        if (this.opts.additionalDirectories?.length && this.caps.sessionCapabilities?.additionalDirectories) {
          commonParams["additionalDirectories"] = [...this.opts.additionalDirectories];
        }
        if (this.opts.systemPromptAppend?.trim() && this.caps.sessionCapabilities?.systemPrompt) {
          commonParams["systemPrompt"] = {
            mode: "append",
            content: [{ type: "text", text: this.opts.systemPromptAppend }],
          };
        }

        let setupRes: { sessionId?: string; configOptions?: AcpConfigOption[] } | undefined;
        const targetResume = this.opts.resumeSessionId;
        if (targetResume) {
          assertSafeSessionId(targetResume);
          if (this.caps.sessionCapabilities?.resume) {
            setupRes = await this.rpc("session/resume", { sessionId: targetResume, ...commonParams });
            this.sessionId = targetResume;
          } else if (this.caps.loadSession) {
            this.replaying = true;
            try {
              setupRes = await this.rpc("session/load", { sessionId: targetResume, ...commonParams });
            } finally {
              this.replaying = false;
            }
            this.sessionId = targetResume;
          } else {
            setupRes = await this.rpc("session/new", commonParams);
            this.sessionId = assertSafeSessionId(String(setupRes?.sessionId ?? ""));
          }
        } else {
          setupRes = await this.rpc("session/new", commonParams);
          this.sessionId = assertSafeSessionId(String(setupRes?.sessionId ?? ""));
        }

        if (Array.isArray(setupRes?.configOptions)) {
          this.configOptions = setupRes.configOptions;
        }
        this.logAlways(
          `init acp=${initRes?.agentInfo?.name ?? "agent"}@${initRes?.agentInfo?.version ?? "?"} ` +
            `session=${this.sessionId.slice(0, 8)} cwd=${this.opts.cwd}`,
        );
      })();
    }
    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = undefined;
      throw err;
    }
    onSessionId?.(this.sessionId);
    await this.applyConfigOptions();
  }

  private async applyConfigOptions(): Promise<void> {
    if (!this.sessionId || !this.configOptions.length) return;
    if (this.opts.model) {
      const modelOpt = this.configOptions.find((o) => o.category === "model" || o.id === "model");
      if (modelOpt && modelOpt.type === "select" && modelOpt.currentValue !== this.opts.model) {
        const choices = flattenSelectOptions(modelOpt);
        const target = this.opts.model.trim();
        const hit =
          choices.find((c) => c.value === target) ??
          choices.find((c) => c.value.toLowerCase() === target.toLowerCase() || c.name.toLowerCase() === target.toLowerCase());
        const valueToSet = hit ? hit.value : choices.length === 0 ? target : undefined;
        if (valueToSet && valueToSet !== modelOpt.currentValue) {
          const res = await this.rpc<{ configOptions?: AcpConfigOption[] }>("session/set_config_option", {
            sessionId: this.sessionId,
            configId: modelOpt.id,
            value: valueToSet,
          });
          if (Array.isArray(res?.configOptions) && res.configOptions.length > 0) {
            this.configOptions = res.configOptions;
          } else {
            modelOpt.currentValue = valueToSet;
          }
        }
      }
    }
    if (this.opts.effort) {
      const effortOpt = this.configOptions.find(
        (o) => o.category === "thought_level" || /^(thought_level|thinking_level|effort)$/i.test(o.id),
      );
      if (effortOpt && effortOpt.type === "select") {
        const matched = matchEffortOption(this.opts.effort, flattenSelectOptions(effortOpt));
        if (matched && matched !== effortOpt.currentValue) {
          const res = await this.rpc<{ configOptions?: AcpConfigOption[] }>("session/set_config_option", {
            sessionId: this.sessionId,
            configId: effortOpt.id,
            value: matched,
          });
          if (Array.isArray(res?.configOptions) && res.configOptions.length > 0) {
            this.configOptions = res.configOptions;
          } else {
            effortOpt.currentValue = matched;
          }
        }
      }
    }
  }

  private buildPromptBlocks(
    prompt: string,
    attachments: readonly Attachment[],
    ambient?: string,
  ): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];
    for (const a of attachments) {
      if (this.caps.promptCapabilities?.image) {
        blocks.push({ type: "image", mimeType: a.mediaType, data: a.data });
      } else if (this.opts.attachmentFallbackDir) {
        mkdirSync(this.opts.attachmentFallbackDir, { recursive: true, mode: 0o700 });
        const name = `attachment-${randomUUID()}.${extForMime(a.mediaType)}`;
        const fullPath = join(this.opts.attachmentFallbackDir, name);
        writeFileSync(fullPath, Buffer.from(a.data, "base64"), { mode: 0o600 });
        blocks.push({
          type: "resource_link",
          uri: pathToFileURL(fullPath).href,
          name,
          mimeType: a.mediaType,
        });
      }
    }
    if (prompt.trim()) blocks.push({ type: "text", text: prompt });
    if (ambient?.trim()) {
      blocks.push({ type: "text", text: `<system-reminder>\n${ambient.trim()}\n</system-reminder>` });
    }
    if (!blocks.length) blocks.push({ type: "text", text: " " });
    return blocks;
  }

  private flushThought(state: PendingTurnState): RecordedAssistantBlock | undefined {
    const thought = state.thoughtBuf;
    state.thoughtBuf = "";
    if (!thought.trim()) return undefined;
    for (const ev of state.fan.take([{ type: "thinking", thinking: thought }])) {
      state.turn.onProgress?.(ev);
    }
    return { type: "thinking", thinking: thought };
  }

  private flushIntermediateText(state: PendingTurnState): RecordedAssistantBlock | undefined {
    const text = state.textBuf;
    state.textBuf = "";
    state.currentMessageId = undefined;
    if (!text.trim()) return undefined;
    for (const ev of state.fan.take([{ type: "text", text }])) {
      state.turn.onProgress?.(ev);
    }
    return { type: "text", text };
  }

  private enforceGuardrails(state: PendingTurnState, reason: string): void {
    if (state.cancelling) return;
    state.limitExceededReason = reason;
    state.cancelling = true;
    this.logAlways(`触发回合护栏(${reason})，发送 session/cancel`);
    if (this.sessionId) this.notify("session/cancel", { sessionId: this.sessionId });
  }

  private handleSessionUpdate(params: unknown): void {
    if (this.replaying || !params || typeof params !== "object") return;
    const p = params as { sessionId?: string; update?: Record<string, unknown> };
    const targetSession = typeof p.sessionId === "string" ? p.sessionId : "";
    const u = p.update;
    if (!u || typeof u !== "object") return;
    const kind = typeof u["sessionUpdate"] === "string" ? u["sessionUpdate"] : "";

    const state = this.current;
    state?.turn.onAlive?.();

    if (kind === "config_option_update" && Array.isArray(u["configOptions"]) && targetSession === this.sessionId) {
      this.configOptions = u["configOptions"] as AcpConfigOption[];
      return;
    }

    if (kind === "subagent_update") {
      const childId = typeof u["sessionId"] === "string" ? u["sessionId"] : "";
      if (!childId) return;
      const existing = this.subagents.get(childId) ?? {
        sessionId: childId,
        title: typeof u["title"] === "string" && u["title"] ? u["title"] : childId.slice(0, 8),
      };
      if (typeof u["title"] === "string" && u["title"]) existing.title = u["title"];
      const stObj = u["state"] && typeof u["state"] === "object" ? (u["state"] as Record<string, unknown>) : undefined;
      const prevState = existing.state;
      if (stObj && typeof stObj["state"] === "string") {
        existing.state = stObj["state"];
      }
      if (!this.current && (existing.state === "running" || existing.state === "requires_action")) {
        existing.detached = true;
      }
      this.subagents.set(childId, existing);
      this.syncBackgroundTasks();

      if (state && prevState !== "running" && existing.state === "running") {
        for (const ev of state.fan.take([{ type: "tool_use", name: `subagent:${existing.title}`, input: u["description"] ?? {} }])) {
          state.turn.onProgress?.(ev);
        }
      }
      if (!state && existing.detached && existing.state === "idle") {
        existing.detached = false;
        const stopReason = typeof stObj?.["stopReason"] === "string" ? stObj["stopReason"] : "completed";
        this.opts.onBackgroundNotice?.(`ACP 子智能体「${existing.title}」已结束（${stopReason}）。`, `subagent:${childId}:${Date.now()}`);
      }
      if (!this.current && !this.hasBackgroundTasks) this.scheduleIdle();
      return;
    }

    // 子会话内部的细粒度块不混入根会话的正文缓冲，避免把子智能体的答复当成主助手最终正文拼进去。
    if (this.sessionId && targetSession && targetSession !== this.sessionId) {
      return;
    }

    if (kind === "usage_update") {
      const cost = u["cost"] && typeof u["cost"] === "object" ? (u["cost"] as Record<string, unknown>) : undefined;
      if (cost && cost["currency"] === "USD" && typeof cost["amount"] === "number" && Number.isFinite(cost["amount"])) {
        this.cumulativeCostUsd = cost["amount"];
        if (state) {
          state.startCostUsd ??= cost["amount"];
          state.latestCostUsd = cost["amount"];
          if (
            this.opts.maxBudgetUsd !== undefined &&
            cost["amount"] - state.startCostUsd >= this.opts.maxBudgetUsd
          ) {
            this.enforceGuardrails(state, `超出单轮预算上限 $${this.opts.maxBudgetUsd}`);
          }
        }
      }
      if (AGENT_TRACE && typeof u["used"] === "number" && typeof u["size"] === "number") {
        this.logTrace(`context used=${shortNum(u["used"])}/${shortNum(u["size"])}`);
      }
      return;
    }

    if (kind === "notice") {
      const title = typeof u["title"] === "string" ? u["title"].trim() : "";
      const desc = typeof u["description"] === "string" ? u["description"].trim() : "";
      const text = [title, desc].filter(Boolean).join("：");
      if (text) {
        this.logAlways(`notice(${String(u["severity"] ?? "info")}): ${text}`);
        state?.turn.onNotice?.(text);
      }
      return;
    }

    if (kind === "compaction_update") {
      const status = typeof u["status"] === "string" ? u["status"] : "unknown";
      this.logAlways(`上下文压缩 status=${status}`);
      return;
    }

    if (!state) return;

    if (kind === "agent_thought_chunk") {
      const c = u["content"] && typeof u["content"] === "object" ? (u["content"] as Record<string, unknown>) : undefined;
      if (c?.["type"] === "text" && typeof c["text"] === "string") {
        state.thoughtBuf += c["text"];
        state.hadActivitySinceStep = true;
      }
      return;
    }

    if (kind === "agent_message_chunk") {
      const msgId = typeof u["messageId"] === "string" ? u["messageId"] : undefined;
      // 思考阶段进入正文阶段：先把完整思考块刷给进度与记录。
      if (state.thoughtBuf.trim()) {
        const block = this.flushThought(state);
        if (block && this.sessionId) this.opts.transcript?.recordAssistant(this.sessionId, [block]);
      }
      // messageId 切换说明前一段话已结束、新一段话开始：前一段按中途发言推出。
      if (msgId && state.currentMessageId && msgId !== state.currentMessageId && state.textBuf.trim()) {
        const block = this.flushIntermediateText(state);
        if (block && this.sessionId) this.opts.transcript?.recordAssistant(this.sessionId, [block]);
      }
      if (msgId) state.currentMessageId = msgId;
      const c = u["content"] && typeof u["content"] === "object" ? (u["content"] as Record<string, unknown>) : undefined;
      if (c?.["type"] === "text" && typeof c["text"] === "string") {
        state.textBuf += c["text"];
        state.hadActivitySinceStep = true;
      }
      return;
    }

    if (kind === "tool_call") {
      const toolCallId = typeof u["toolCallId"] === "string" ? u["toolCallId"] : randomUUID();
      const rawName = typeof u["name"] === "string" && u["name"].trim()
        ? u["name"].trim()
        : typeof u["title"] === "string" && u["title"].trim()
          ? u["title"].trim()
          : "tool";
      const input = u["rawInput"] ?? (typeof u["title"] === "string" ? { description: u["title"] } : {});
      state.toolNames.set(toolCallId, rawName);

      // 从模型推理进入工具执行计为完成 1 次模型往返。
      if (state.hadActivitySinceStep || state.modelSteps === 0) {
        state.modelSteps += 1;
        state.hadActivitySinceStep = false;
      }
      if (this.opts.maxTurns !== undefined && state.modelSteps >= this.opts.maxTurns) {
        this.enforceGuardrails(state, `达到最大模型轮数上限(${this.opts.maxTurns})`);
        return;
      }

      const assistantBlocks: RecordedAssistantBlock[] = [];
      const thoughtBlock = this.flushThought(state);
      if (thoughtBlock) assistantBlocks.push(thoughtBlock);
      const textBlock = this.flushIntermediateText(state);
      if (textBlock) assistantBlocks.push(textBlock);
      assistantBlocks.push({ type: "tool_use", id: toolCallId, name: rawName, input });

      for (const ev of state.fan.take([{ type: "tool_use", name: rawName, input }])) {
        state.turn.onProgress?.(ev);
      }
      if (this.sessionId) {
        this.opts.transcript?.recordAssistant(this.sessionId, assistantBlocks);
        state.recordedTools.add(toolCallId);
      }
      this.logTrace(`tool_call ${rawName}`);
      return;
    }

    if (kind === "tool_call_update") {
      const toolCallId = typeof u["toolCallId"] === "string" ? u["toolCallId"] : "";
      if (typeof u["name"] === "string" && u["name"].trim() && toolCallId) {
        state.toolNames.set(toolCallId, u["name"].trim());
      }
      const status = typeof u["status"] === "string" ? u["status"] : "";
      if ((status === "completed" || status === "failed") && toolCallId && this.sessionId) {
        if (!state.recordedTools.has(toolCallId)) {
          const name = state.toolNames.get(toolCallId) ?? "tool";
          this.opts.transcript?.recordAssistant(this.sessionId, [
            { type: "tool_use", id: toolCallId, name, input: u["rawInput"] ?? {} },
          ]);
          state.recordedTools.add(toolCallId);
        }
        const outputText = extractTextFromToolContent(u["content"], u["rawOutput"]);
        this.opts.transcript?.recordToolResult(this.sessionId, toolCallId, outputText, status === "failed");
        this.logTrace(`tool_result status=${status} len=${outputText.length}`);
      }
    }
  }

  private syncBackgroundTasks(): void {
    const tasks: Array<{ task_id: string; description: string; ambient?: boolean }> = [];
    for (const sub of this.subagents.values()) {
      if (sub.state === "running" || sub.state === "requires_action") {
        tasks.push({ task_id: sub.sessionId, description: sub.title });
      }
    }
    this.opts.onBackgroundTasksChanged?.(tasks);
  }

  feed(prompt: string, attachments: readonly Attachment[]): boolean {
    const state = this.current;
    if (!state || this.closed || state.cancelling) return false;
    if (this.sessionId) this.opts.transcript?.recordUser(this.sessionId, prompt, attachments);

    if (this.opts.supportsSteering && this.sessionId) {
      const blocks = this.buildPromptBlocks(prompt, attachments);
      const steerPromise = this.rpc<{ stopReason?: string }>("session/prompt", {
        sessionId: this.sessionId,
        prompt: blocks,
      })
        .then(() => {
          // Steering 请求在主轮结束时一并收尾，正文已在统一流中收集。
        })
        .catch(() => {
          // 若服务端不支持并发 prompt（报错拒绝），转入顺序跟进队列在本回合紧接着跑完，绝不丢消息。
          if (this.current === state && !state.cancelling && !this.closed) {
            state.followUps.push({ prompt, attachments });
          }
        })
        .finally(() => {
          state.inFlightSteers.delete(steerPromise);
        });
      state.inFlightSteers.add(steerPromise);
      return true;
    }

    state.followUps.push({ prompt, attachments });
    return true;
  }

  async run(turn: AcpTurnInput): Promise<AcpTurnResult> {
    if (this.closed) throw new Error("ACP 进程已退出");
    if (this.current) throw new Error("同一上下文不能并发执行两个 agent 回合");
    if (turn.signal?.aborted) throw turn.signal.reason ?? new Error("回合已取消");
    if (this.idleTimer) clearTimeout(this.idleTimer);

    const state: PendingTurnState = {
      turn,
      fan: new ProgressFan(),
      thoughtBuf: "",
      textBuf: "",
      replies: [],
      followUps: [],
      inFlightSteers: new Set(),
      toolNames: new Map(),
      recordedTools: new Set(),
      modelSteps: 0,
      hadActivitySinceStep: false,
      startCostUsd: this.cumulativeCostUsd,
      cancelling: false,
      abortHandler: () => {
        state.cancelling = true;
        if (this.sessionId) this.notify("session/cancel", { sessionId: this.sessionId });
        void this.opts.stopAgent().catch(() => {});
        const reason = turn.signal?.reason instanceof Error
          ? turn.signal.reason
          : new Error(String(turn.signal?.reason ?? "回合已取消"));
        this.close(reason);
      },
    };
    this.current = state;
    turn.signal?.addEventListener("abort", state.abortHandler, { once: true });

    try {
      return await new Promise<AcpTurnResult>((resolve, reject) => {
        this.rejectRun = reject;
        void (async () => {
          try {
            await this.ensureInitialized(turn.onSessionId);
            this.opts.transcript?.recordUser(this.sessionId, turn.prompt, turn.attachments);

            let nextPrompt: { prompt: string; attachments: readonly Attachment[]; ambient?: string } | undefined = {
              prompt: turn.prompt,
              attachments: turn.attachments,
              ambient: turn.ambient,
            };
            let isError = false;

            while (nextPrompt && !state.cancelling && !this.closed) {
              const blocks = this.buildPromptBlocks(nextPrompt.prompt, nextPrompt.attachments, nextPrompt.ambient);
              state.hadActivitySinceStep = false;
              let stopReason = "end_turn";
              try {
                const res = await this.rpc<{ stopReason?: string }>("session/prompt", {
                  sessionId: this.sessionId,
                  prompt: blocks,
                });
                stopReason = typeof res?.stopReason === "string" ? res.stopReason : "end_turn";
              } catch (err) {
                if (turn.signal?.aborted) throw err;
                isError = true;
                const detail = err instanceof Error ? err.message : String(err);
                state.replies.push(detail);
                break;
              }

              if (state.inFlightSteers.size) {
                await Promise.allSettled([...state.inFlightSteers]);
              }

              const finalBlocks: RecordedAssistantBlock[] = [];
              const thoughtBlock = this.flushThought(state);
              if (thoughtBlock) finalBlocks.push(thoughtBlock);

              const finalSegment = state.textBuf;
              state.textBuf = "";
              state.currentMessageId = undefined;
              if (finalSegment.trim()) {
                state.replies.push(finalSegment);
                finalBlocks.push({ type: "text", text: finalSegment });
              }
              if (finalBlocks.length) {
                this.opts.transcript?.recordAssistant(this.sessionId, finalBlocks);
              }
              state.modelSteps += 1;

              if (stopReason === "refusal") {
                isError = true;
                if (!state.replies.length) state.replies.push("模型拒绝执行本次请求(stopReason=refusal)");
                break;
              }
              if (stopReason === "max_turn_requests" || stopReason === "max_tokens") {
                if (!state.replies.length) {
                  isError = true;
                  state.replies.push(`回合触及模型上限(${stopReason})`);
                }
                break;
              }
              if (state.limitExceededReason) {
                if (!state.replies.length) {
                  isError = true;
                  state.replies.push(state.limitExceededReason);
                }
                break;
              }

              nextPrompt = state.followUps.shift();
            }

            const text = joinReplyTexts(state.replies, isError);
            this.opts.transcript?.recordResult(this.sessionId, text, isError);
            resolve({
              text,
              sessionId: this.sessionId,
              isError,
              turns: Math.max(1, state.modelSteps),
            });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        })();
      });
    } finally {
      turn.signal?.removeEventListener("abort", state.abortHandler);
      if (this.current === state) this.current = undefined;
      this.rejectRun = undefined;
      for (const sub of this.subagents.values()) {
        if (sub.state === "running" || sub.state === "requires_action") sub.detached = true;
      }
      this.scheduleIdle();
    }
  }

  private scheduleIdle(): void {
    if (this.hasBackgroundTasks || this.current || this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.current && !this.hasBackgroundTasks) this.close();
    }, this.opts.idleMs ?? 5000);
    this.idleTimer.unref?.();
  }

  close(error = new Error("ACP 会话已关闭")): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);

    if (this.sessionId && this.caps.sessionCapabilities?.close) {
      try {
        this.proc.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "session/close", params: { sessionId: this.sessionId } })}\n`,
        );
      } catch {}
    }
    try { this.proc.stdin.end(); } catch {}
    this.proc.kill("SIGTERM");

    for (const [, waiter] of this.rpcPending) waiter.reject(error);
    this.rpcPending.clear();

    const rejectActive = this.rejectRun;
    this.rejectRun = undefined;
    this.current = undefined;
    rejectActive?.(error);

    void this.opts.stopAgent().catch(() => {});
    this.opts.onClose();
  }

  private logAlways(text: string): void {
    const label = this.opts.logLabel ?? this.sessionId.slice(0, 8) ?? "acp";
    console.info(`[agent ${label}] ${text}`);
  }

  private logTrace(text: string): void {
    if (!AGENT_TRACE) return;
    const label = this.opts.logLabel ?? this.sessionId.slice(0, 8) ?? "acp";
    console.info(`[agent ${label}] ${text}`);
  }
}
