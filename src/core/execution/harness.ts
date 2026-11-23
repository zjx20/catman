import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Config, HarnessId, ModelUpstreamKind, Persona } from "../../config.js";
import { DEFAULT_MODELS_BY_HARNESS } from "../../config.js";
import type { Attachment } from "../attachments.js";
import { AGENT_TRACE, describeSdkMessage } from "../agent-trace.js";
import { ProgressFan, buildUserMessage, type AgentProgressEvent } from "../agent.js";
import { readTokenExpiry } from "../token-alert.js";
import type { ContextPaths, ExecutionContext } from "./contexts.js";
import {
  executionRulesBlock,
  instructionOptions,
  projectInstructions,
  readUserAndSharedInstructions,
  systemInstructionSupplement,
} from "./instructions.js";
import { SdkSession } from "./sdk-session.js";
import { AcpSession, spawnAcpSubprocess, type AcpMcpServerSpec } from "./acp-session.js";
import { TranscriptRecorder } from "./transcript-recorder.js";

/**
 * Agent Harness 统一契约与内置实现（Claude SDK / Antigravity `agy acp` / 通用 ACP）。
 *
 * 设计目标：
 * - 让网关、多租户容器隔离、CapabilityBroker 零凭据反代、后台任务续接和自检门禁与具体 CLI 解耦；
 * - 对 Claude 保留 `@anthropic-ai/claude-agent-sdk` 原生直连，零额外桥接进程、零功能退化；
 * - 对 `agy`（及任意讲 ACP v1 的 CLI 如 `gemini --acp`、`codex-acp`）直接走 `stdio` JSON-RPC。
 */

export const sdkNativePackage = `claude-agent-sdk-linux-${process.arch}`;

export interface BindMountSpec {
  /** 位于 `config.mainDataDir` 内的本地源路径（由控制面 `hostPath()` 翻译为宿主路径）。 */
  source: string;
  /** 容器内挂载目标绝对路径。 */
  target: string;
  readonly?: boolean;
}

export interface HarnessTurnInput {
  prompt: string;
  attachments: readonly Attachment[];
  ambient?: string;
  signal?: AbortSignal;
  onSessionId?: (id: string) => void;
  onAlive?: () => void;
  onProgress?: (ev: AgentProgressEvent) => void;
  onNotice?: (text: string) => void;
}

export interface HarnessTurnResult {
  text: string;
  sessionId: string;
  isError: boolean;
  turns: number;
}

export interface HarnessSession {
  readonly alive: boolean;
  readonly busy: boolean;
  readonly hasBackgroundTasks: boolean;
  run(turn: HarnessTurnInput): Promise<HarnessTurnResult>;
  feed(prompt: string, attachments: readonly Attachment[]): boolean;
  close(error?: Error): void;
}

export interface OpenHarnessSessionInput {
  config: Config;
  context: ExecutionContext;
  paths: ContextPaths;
  wrapperPath: string;
  env: Record<string, string | undefined>;
  model?: string;
  effort?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  skills: string[];
  mcpServers: Record<string, McpServerConfig>;
  isAdmin: boolean;
  onStderr: (data: string) => void;
  stopAgent: () => Promise<unknown>;
  onClose: () => void;
  onBackgroundTasksChanged: (tasks: Array<{ task_id: string; description: string; ambient?: boolean }>) => void;
  onBackgroundNotice: (text: string, id?: string) => void;
}

export interface AgentHarness {
  readonly id: HarnessId;
  readonly defaultModelAllowlist: readonly string[];
  readonly defaultProbeModel: string | undefined;

  /** 校验 release 或挂载路径中的执行器是否就绪。 */
  verifyRelease(releaseDir: string, config: Config): void;

  /** 生成投影目录中的只读指令与引擎配置文件。 */
  writeProjectionFiles(input: {
    config: Config;
    home: string;
    projectionDir: string;
    isAdmin: boolean;
  }): void;

  /** 返回除基础 work/sdk/tasks/home 之外，容器需要追加的引擎专属挂载。 */
  containerMounts(input: {
    config: Config;
    paths: ContextPaths;
    projectionDir: string;
    releaseDir: string;
    sharedSkillNames: readonly string[];
  }): BindMountSpec[];

  /** 容器启动时的引擎专属环境变量（不含真实密钥）。 */
  containerEnv(paths: ContextPaths): Record<string, string>;

  /** 会话子进程启动时的引擎专属环境变量（通过 CapabilityBroker 代理模型流量）。 */
  sessionEnv(apiBase: string, runtimeToken: string, paths: ContextPaths): Record<string, string>;

  /** `wrapper` 在容器内经 `task-cli.js exec --` 拉起的实际命令与参数。 */
  containerCommand(input: { config: Config; releaseDir: string; isAdmin: boolean }): string[];

  /** 打开常驻多轮会话连接。 */
  openSession(input: OpenHarnessSessionInput): HarnessSession;

  /** 无容器轻量探测（用于部署前 `CATMAN_SELFCHECK=1` 的真实大脑连通性自检）。 */
  runProbe(
    prompt: string,
    opts: { cwd?: string; model?: string; abortController?: AbortController },
    config: Config,
  ): Promise<HarnessTurnResult>;

  /** 可选：读取本地 OAuth 凭据过期时间戳（API Key 模式无过期概念，返回 undefined）。 */
  credentialExpiry?(configDir: string): number | undefined;
}

function isInsideDir(baseDir: string, candidate: string): boolean {
  const rel = relative(resolve(baseDir), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

function cleanProcessEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function toAcpMcpServers(mcpServers: Record<string, McpServerConfig>): Record<string, AcpMcpServerSpec> {
  const out: Record<string, AcpMcpServerSpec> = {};
  for (const [name, cfg] of Object.entries(mcpServers)) {
    if (!cfg || typeof cfg !== "object") continue;
    const raw = cfg as Record<string, unknown>;
    if (raw["type"] === "http" && typeof raw["url"] === "string") {
      const headers = raw["headers"] && typeof raw["headers"] === "object"
        ? (raw["headers"] as Record<string, string>)
        : undefined;
      out[name] = { type: "http", url: raw["url"], ...(headers ? { headers } : {}) };
    } else if (typeof raw["command"] === "string") {
      const args = Array.isArray(raw["args"]) ? (raw["args"].filter((x): x is string => typeof x === "string")) : undefined;
      const env = raw["env"] && typeof raw["env"] === "object" ? (raw["env"] as Record<string, string>) : undefined;
      out[name] = { type: "stdio", command: raw["command"], ...(args ? { args } : {}), ...(env ? { env } : {}) };
    }
  }
  return out;
}

function upstreamSessionEnv(upstream: ModelUpstreamKind, apiBase: string, runtimeToken: string): Record<string, string> {
  switch (upstream) {
    case "gemini":
      return {
        GOOGLE_GEMINI_BASE_URL: `${apiBase}/api/runtime/model/gemini`,
        GEMINI_API_KEY: runtimeToken,
      };
    case "openai":
      return {
        OPENAI_BASE_URL: `${apiBase}/api/runtime/model/openai/v1`,
        OPENAI_API_KEY: runtimeToken,
      };
    case "anthropic":
      return {
        ANTHROPIC_BASE_URL: `${apiBase}/api/runtime/model/anthropic`,
        ANTHROPIC_AUTH_TOKEN: runtimeToken,
      };
    case "none":
      return {};
  }
}

/** 定位在 mainDataDir / releaseDir 内可挂载的 agy 二进制；若安装在基底镜像 PATH 中则返回 undefined。 */
function mountableAgyBinary(config: Config, releaseDir: string): string | undefined {
  const candidates = [
    ...(config.harnessBin ? [config.harnessBin] : []),
    join(config.mainDataDir, "harness", "agy"),
    join(releaseDir, "bin", "agy"),
  ];
  for (const candidate of candidates) {
    if (isInsideDir(config.mainDataDir, candidate) && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

// ── 1. Claude Agent SDK Harness ──────────────────────────────────────────────

class ClaudeSessionAdapter implements HarnessSession {
  private readonly inner: SdkSession;
  private readonly contextId: string;

  constructor(input: OpenHarnessSessionInput) {
    const { config, context, paths, wrapperPath, env, model, effort, maxTurns, maxBudgetUsd, skills, mcpServers } = input;
    this.contextId = context.id;
    this.inner = new SdkSession(
      (stream) =>
        query({
          prompt: stream,
          options: {
            pathToClaudeCodeExecutable: wrapperPath,
            cwd: paths.work,
            env,
            ...instructionOptions(config.persona, config.sessionMemoryLimit),
            ...(context.sdkStarted ? { resume: context.sdkSessionId } : { sessionId: context.sdkSessionId }),
            ...(model ?? config.model ? { model: model ?? config.model } : {}),
            ...(effort ? { effort: effort as any } : {}),
            ...(maxTurns ? { maxTurns } : {}),
            ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
            thinking: { type: "adaptive", display: "summarized" },
            skills,
            mcpServers,
            perTaskStopAffordance: true,
            stderr: input.onStderr,
          },
        }),
      {
        stopAgent: input.stopAgent,
        onClose: input.onClose,
        onBackground: (message) => {
          if (message.type === "system" && message.subtype === "background_tasks_changed") {
            input.onBackgroundTasksChanged(message.tasks);
          }
          if (message.type === "system" && message.subtype === "task_notification") {
            input.onBackgroundNotice(`SDK 后台任务 ${message.task_id}：${message.status}\n${message.summary}`, message.uuid);
          }
          if (message.type === "result" && message.subtype === "success" && message.result) {
            input.onBackgroundNotice(message.result, message.uuid);
          }
        },
      },
    );
  }

  get alive(): boolean { return this.inner.alive; }
  get busy(): boolean { return this.inner.busy; }
  get hasBackgroundTasks(): boolean { return this.inner.hasBackgroundTasks; }

  feed(prompt: string, attachments: readonly Attachment[]): boolean {
    return this.inner.feed(buildUserMessage(prompt, attachments));
  }

  async run(turn: HarnessTurnInput): Promise<HarnessTurnResult> {
    const fan = new ProgressFan();
    const message = buildUserMessage(turn.prompt, turn.attachments, turn.ambient);
    return this.inner.run({
      message,
      signal: turn.signal,
      onMessage: (sdkMsg) => {
        if ("session_id" in sdkMsg && sdkMsg.session_id) {
          turn.onSessionId?.(sdkMsg.session_id);
        }
        const trace = describeSdkMessage(sdkMsg);
        if (trace && (trace.level === "always" || AGENT_TRACE)) {
          console.info(`[agent ${this.contextId}] ${trace.text}`);
        }
        turn.onAlive?.();
        if (sdkMsg.type === "assistant") {
          for (const ev of fan.take(sdkMsg.message.content)) turn.onProgress?.(ev);
        }
      },
    });
  }

  close(error?: Error): void {
    this.inner.close(error);
  }
}

export const claudeHarness: AgentHarness = {
  id: "claude",
  defaultModelAllowlist: DEFAULT_MODELS_BY_HARNESS.claude,
  defaultProbeModel: "haiku",

  verifyRelease(releaseDir) {
    const binary = join(releaseDir, "node_modules/@anthropic-ai", sdkNativePackage, "claude");
    if (!existsSync(binary)) throw new Error("release 缺少执行运行时，请先构建");
  },

  writeProjectionFiles({ config, home, projectionDir, isAdmin }) {
    projectInstructions(config.dataDir, home, join(projectionDir, "CLAUDE.md"), Boolean(config.ops) && isAdmin);
  },

  containerMounts({ paths, projectionDir, releaseDir, sharedSkillNames }) {
    const binary = join(releaseDir, "node_modules/@anthropic-ai", sdkNativePackage, "claude");
    const mounts: BindMountSpec[] = [
      {
        source: dirname(binary),
        target: `/runtime/release/node_modules/@anthropic-ai/${sdkNativePackage}`,
        readonly: true,
      },
      { source: join(projectionDir, "CLAUDE.md"), target: join(paths.sdk, "CLAUDE.md"), readonly: true },
      { source: join(paths.home, "skills"), target: join(paths.sdk, "skills") },
    ];
    for (const name of sharedSkillNames) {
      mounts.push({
        source: join(projectionDir, "skills", name),
        target: join(paths.sdk, "skills", name),
        readonly: true,
      });
    }
    return mounts;
  },

  containerEnv(paths) {
    return { CLAUDE_CONFIG_DIR: paths.sdk };
  },

  sessionEnv(apiBase, runtimeToken, paths) {
    return {
      CLAUDE_CONFIG_DIR: paths.sdk,
      ANTHROPIC_BASE_URL: `${apiBase}/api/runtime/model`,
      ANTHROPIC_AUTH_TOKEN: runtimeToken,
    };
  },

  containerCommand() {
    return [`/runtime/release/node_modules/@anthropic-ai/${sdkNativePackage}/claude`];
  },

  openSession(input) {
    return new ClaudeSessionAdapter(input);
  },

  async runProbe(prompt, opts, config) {
    const q = query({
      prompt,
      options: {
        cwd: opts.cwd,
        model: opts.model ?? config.model,
        maxTurns: 1,
        abortController: opts.abortController,
        ...instructionOptions(config.persona),
      },
    });
    let text = "", sessionId = "", isError = false;
    try {
      for await (const m of q) {
        if (m.type === "result") {
          sessionId = m.session_id;
          isError = m.is_error;
          text = m.subtype === "success" ? m.result : m.errors.join("\n");
        }
      }
    } finally {
      q.close();
    }
    return { text, sessionId, isError, turns: 1 };
  },

  credentialExpiry(configDir) {
    return readTokenExpiry(configDir);
  },
};

// ── 2. Antigravity CLI (`agy acp`) Harness ───────────────────────────────────

export function writeAgyProjection(input: {
  dataDir: string;
  persona: Persona;
  memoryLimit?: string;
  home: string;
  projectionDir: string;
  ops: boolean;
}): void {
  // 不可变装配事实（人格身份、内存上限、回复格式、执行纪律）单独放进 ~/.gemini/GEMINI.md；
  // 共享与个人偏好放进 ~/.gemini/AGENTS.md。即使个人文件超长触发单文件 24KB 截断，
  // 也不会把人格身份与执行边界挤掉。
  const immutable = `${systemInstructionSupplement(input.persona, input.memoryLimit)}\n\n${executionRulesBlock(input.ops)}`;
  const { shared, personal } = readUserAndSharedInstructions(input.dataDir, input.home);
  writeFileSync(join(input.projectionDir, "GEMINI.md"), immutable, { mode: 0o600 });
  writeFileSync(join(input.projectionDir, "AGENTS.md"), `${shared}\n\n${personal}\n`, { mode: 0o600 });
  writeFileSync(
    join(input.projectionDir, "agy-settings.json"),
    JSON.stringify(
      {
        modelProvider: "gemini",
        toolPermission: "always-proceed",
        artifactReviewPolicy: "always-proceed",
        allowNonWorkspaceAccess: true,
        notifications: false,
        showTips: false,
        showFeedbackSurvey: false,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

export const agyHarness: AgentHarness = {
  id: "agy",
  defaultModelAllowlist: DEFAULT_MODELS_BY_HARNESS.agy,
  defaultProbeModel: "gemini-3.8-flash-medium",

  verifyRelease(_releaseDir, config) {
    if (config.harnessBin && isAbsolute(config.harnessBin) && isInsideDir(config.mainDataDir, config.harnessBin)) {
      if (!existsSync(config.harnessBin)) {
        throw new Error(`指定的 agy 二进制不存在: ${config.harnessBin}`);
      }
    }
  },

  writeProjectionFiles({ config, home, projectionDir, isAdmin }) {
    writeAgyProjection({
      dataDir: config.dataDir,
      persona: config.persona,
      memoryLimit: config.sessionMemoryLimit,
      home,
      projectionDir,
      ops: Boolean(config.ops) && isAdmin,
    });
  },

  containerMounts({ config, paths, projectionDir, releaseDir, sharedSkillNames }) {
    const mounts: BindMountSpec[] = [
      { source: join(projectionDir, "GEMINI.md"), target: join(paths.sdk, ".gemini", "GEMINI.md"), readonly: true },
      { source: join(projectionDir, "AGENTS.md"), target: join(paths.sdk, ".gemini", "AGENTS.md"), readonly: true },
      {
        source: join(projectionDir, "agy-settings.json"),
        target: join(paths.sdk, ".gemini", "antigravity-cli", "settings.json"),
        readonly: true,
      },
      { source: join(paths.home, "skills"), target: join(paths.sdk, ".gemini", "config", "skills") },
    ];
    for (const name of sharedSkillNames) {
      mounts.push({
        source: join(projectionDir, "skills", name),
        target: join(paths.sdk, ".gemini", "config", "skills", name),
        readonly: true,
      });
    }
    const localBin = mountableAgyBinary(config, releaseDir);
    if (localBin) {
      mounts.push({ source: localBin, target: "/runtime/harness/agy", readonly: true });
    }
    return mounts;
  },

  containerEnv() {
    return { AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
  },

  sessionEnv(apiBase, runtimeToken) {
    return {
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      ...upstreamSessionEnv("gemini", apiBase, runtimeToken),
    };
  },

  containerCommand({ config, releaseDir, isAdmin }) {
    const bin = mountableAgyBinary(config, releaseDir)
      ? "/runtime/harness/agy"
      : config.harnessBin || "agy";
    const extraDirs = ["/user", ...(isAdmin && config.persona === "primary" ? ["/catman-src"] : [])];
    return [
      bin,
      "acp",
      "--dangerously-skip-permissions",
      "--process-per-session",
      "--disable-telemetry",
      ...extraDirs.flatMap((d) => ["--add-dir", d]),
    ];
  },

  openSession(input) {
    const { config, context, paths, wrapperPath, env, model, effort, maxTurns, maxBudgetUsd, mcpServers, isAdmin } = input;
    const extraDirs = ["/user", ...(isAdmin && config.persona === "primary" ? ["/catman-src"] : [])];
    return new AcpSession(
      () => spawnAcpSubprocess([wrapperPath], { cwd: paths.work, env: cleanProcessEnv(env) }),
      {
        cwd: paths.work,
        attachmentFallbackDir: join(paths.work, ".catman-attachments"),
        ...(context.sdkStarted ? { resumeSessionId: context.sdkSessionId } : {}),
        model: model ?? config.model,
        effort,
        maxTurns,
        maxBudgetUsd,
        additionalDirectories: extraDirs,
        mcpServers: toAcpMcpServers(mcpServers),
        supportsSteering: true,
        transcript: new TranscriptRecorder(paths.transcripts),
        logLabel: context.id,
        onStderr: input.onStderr,
        onBackgroundTasksChanged: input.onBackgroundTasksChanged,
        onBackgroundNotice: input.onBackgroundNotice,
        onClose: input.onClose,
        stopAgent: input.stopAgent,
      },
    );
  },

  async runProbe(prompt, opts, config) {
    const cwd = opts.cwd ?? process.cwd();
    const home = join(cwd, ".agy-probe-home");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, ".gemini", "GEMINI.md"),
      systemInstructionSupplement(config.persona),
      { mode: 0o600 },
    );
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({
        modelProvider: "gemini",
        toolPermission: "always-proceed",
        artifactReviewPolicy: "always-proceed",
        notifications: false,
        showTips: false,
        showFeedbackSurvey: false,
      }),
      { mode: 0o600 },
    );
    const bin = config.harnessBin || "agy";
    const cmd = config.acpCommand ?? [bin, "acp", "--dangerously-skip-permissions", "--disable-telemetry"];
    const session = new AcpSession(
      () =>
        spawnAcpSubprocess(cmd, {
          cwd,
          env: {
            ...process.env,
            HOME: home,
            AGY_CLI_DISABLE_AUTO_UPDATE: "true",
          },
        }),
      {
        cwd,
        model: opts.model ?? config.model,
        maxTurns: 1,
        logLabel: "selfcheck",
        idleMs: 50,
        onClose: () => {},
        stopAgent: async () => {},
      },
    );
    try {
      return await session.run({
        prompt,
        attachments: [],
        signal: opts.abortController?.signal,
      });
    } finally {
      session.close();
    }
  },
};

// ── 3. Generic ACP Harness (`codex-acp`, `gemini --acp`, `opencode`, etc.) ──

export const genericAcpHarness: AgentHarness = {
  id: "acp",
  defaultModelAllowlist: DEFAULT_MODELS_BY_HARNESS.acp,
  defaultProbeModel: undefined,

  verifyRelease(_releaseDir, config) {
    if (!config.acpCommand?.length) {
      throw new Error("CATMAN_HARNESS=acp 需要配置 CATMAN_ACP_COMMAND（如 '[\"codex-acp\"]'）");
    }
  },

  writeProjectionFiles({ config, home, projectionDir, isAdmin }) {
    const supplement = systemInstructionSupplement(config.persona, config.sessionMemoryLimit);
    const { shared, personal } = readUserAndSharedInstructions(config.dataDir, home);
    const body = `${supplement}\n\n${shared}\n\n${personal}\n\n${executionRulesBlock(Boolean(config.ops) && isAdmin)}`;
    writeFileSync(join(projectionDir, "AGENTS.md"), body, { mode: 0o600 });
  },

  containerMounts({ paths, projectionDir, sharedSkillNames }) {
    const mounts: BindMountSpec[] = [
      { source: join(projectionDir, "AGENTS.md"), target: join(paths.sdk, "AGENTS.md"), readonly: true },
      { source: join(projectionDir, "AGENTS.md"), target: join(paths.sdk, ".agents", "AGENTS.md"), readonly: true },
      { source: join(projectionDir, "AGENTS.md"), target: join(paths.sdk, ".gemini", "AGENTS.md"), readonly: true },
      { source: join(paths.home, "skills"), target: join(paths.sdk, ".agents", "skills") },
    ];
    for (const name of sharedSkillNames) {
      mounts.push({
        source: join(projectionDir, "skills", name),
        target: join(paths.sdk, ".agents", "skills", name),
        readonly: true,
      });
    }
    return mounts;
  },

  containerEnv() {
    return {};
  },

  sessionEnv(_apiBase, _runtimeToken) {
    // Generic ACP 具体上游由 resolveHarness 注入 config.acpUpstream。
    return {};
  },

  containerCommand({ config }) {
    if (!config.acpCommand?.length) {
      throw new Error("CATMAN_HARNESS=acp 需要配置 CATMAN_ACP_COMMAND");
    }
    return [...config.acpCommand];
  },

  openSession(input) {
    const { config, context, paths, wrapperPath, env, model, effort, maxTurns, maxBudgetUsd, mcpServers, isAdmin } = input;
    const extraDirs = ["/user", ...(isAdmin && config.persona === "primary" ? ["/catman-src"] : [])];
    return new AcpSession(
      () => spawnAcpSubprocess([wrapperPath], { cwd: paths.work, env: cleanProcessEnv(env) }),
      {
        cwd: paths.work,
        attachmentFallbackDir: join(paths.work, ".catman-attachments"),
        ...(context.sdkStarted ? { resumeSessionId: context.sdkSessionId } : {}),
        model: model ?? config.model,
        effort,
        maxTurns,
        maxBudgetUsd,
        additionalDirectories: extraDirs,
        systemPromptAppend: systemInstructionSupplement(config.persona, config.sessionMemoryLimit),
        mcpServers: toAcpMcpServers(mcpServers),
        supportsSteering: false,
        transcript: new TranscriptRecorder(paths.transcripts),
        logLabel: context.id,
        onStderr: input.onStderr,
        onBackgroundTasksChanged: input.onBackgroundTasksChanged,
        onBackgroundNotice: input.onBackgroundNotice,
        onClose: input.onClose,
        stopAgent: input.stopAgent,
      },
    );
  },

  async runProbe(prompt, opts, config) {
    if (!config.acpCommand?.length) {
      throw new Error("CATMAN_HARNESS=acp 需要配置 CATMAN_ACP_COMMAND");
    }
    const cwd = opts.cwd ?? process.cwd();
    const session = new AcpSession(
      () => spawnAcpSubprocess(config.acpCommand!, { cwd, env: { ...process.env } }),
      {
        cwd,
        model: opts.model ?? config.model,
        maxTurns: 1,
        systemPromptAppend: systemInstructionSupplement(config.persona),
        logLabel: "selfcheck",
        idleMs: 50,
        onClose: () => {},
        stopAgent: async () => {},
      },
    );
    try {
      return await session.run({
        prompt,
        attachments: [],
        signal: opts.abortController?.signal,
      });
    } finally {
      session.close();
    }
  },
};

export function resolveHarness(config: Pick<Config, "harness" | "acpUpstream">): AgentHarness {
  if (config.harness === "claude") return claudeHarness;
  if (config.harness === "agy") return agyHarness;
  const upstream = config.acpUpstream ?? "none";
  return {
    ...genericAcpHarness,
    sessionEnv(apiBase, runtimeToken) {
      return upstreamSessionEnv(upstream, apiBase, runtimeToken);
    },
  };
}

/**
 * Gemini REST/SSE 本地回环假上游响应构造器（供 `agy` 本地指令隔离自检与集成测试共用）。
 */
export function startLocalGeminiProbeServer(
  onGenerateRequest: (url: string, body: unknown, headers: Record<string, string | string[] | undefined>) => void,
) {
  return createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawText = Buffer.concat(chunks).toString("utf8");
      const url = req.url ?? "/";
      if (url.includes(":countTokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ totalTokens: 8 }));
        return;
      }
      if (!url.includes(":generateContent") && !url.includes(":streamGenerateContent")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const parsed: unknown = rawText ? JSON.parse(rawText) : {};
      onGenerateRequest(url, parsed, req.headers);
      const candidate = {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, totalTokenCount: 9 },
      };
      if (url.includes(":streamGenerateContent") && url.includes("alt=sse")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(candidate)}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(candidate));
      }
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end("{}");
    }
  });
}
