import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { query, type SDKMessage, type SDKUserMessage, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import type { EffortLevel } from "./settings.js";
import type { Attachment } from "./attachments.js";
import { AGENT_TRACE, describeSdkMessage } from "./agent-trace.js";
import { instructionOptions } from "./execution/instructions.js";
import { ContextStore, readTenantFile, type ExecutionContext } from "./execution/contexts.js";
import { RuntimeManager, networkEnvironment } from "./execution/runtime.js";
import { CapabilityBroker } from "./execution/broker.js";
import { SdkSession } from "./execution/sdk-session.js";
import { GENERATED_SKILLS, skillsOnDisk } from "./skills.js";
/**
 * Agent SDK 封装。目标:尽量还原 Claude Code 的行为("脾气"),
 * 关键是三项非默认配置 —— 系统提示词 preset、加载 setting sources、启用 skills。
 * 参考:code.claude.com/docs/en/agent-sdk/claude-code-features
 */

export interface AgentReply {
  /** 要发回给用户的最终文本。 */
  text: string;
  /** 本轮的 session id;供会话层记录以便下次 resume。 */
  sessionId: string;
  /** 是否为错误结果(鉴权失败、超限等)。 */
  isError: boolean;
}

/** 一次回合中的中间过程事件,供上层向用户透出进度。 */
export type AgentProgressEvent =
  | { kind: "thinking"; text: string }
  /**
   * 助手**中途**说的话(不是最终答复)。
   *
   * "中途"这个限定是硬的:最终答复本身也是一个 text 块,原样透出去的话用户会
   * 收到两遍同一句话 —— 一遍当进度、一遍当正文。所以 text 块**延后一拍**发:
   * 只有当后面还有别的动作(又一个 text、思考、或工具调用)时,前一个 text 才
   * 确定不是答复,这时才把它交出去。回合结束时手上那个一律丢掉。
   */
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown };

/** SDK 内容块里我们认得的那几样。只声明用得上的字段,免得跟着 SDK 的类型走。 */
export interface ContentBlockLike {
  readonly type: string;
  readonly thinking?: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: unknown;
}

/**
 * 内容块 → 进度事件。**存在的理由只有一条:text 块要延后一拍。**
 *
 * 最终答复本身也是一个 text 块,当场透出去用户就会收到两遍同一句话 ——
 * 一遍当进度、一遍当正文。而"这个 text 是不是最终答复"只有看它后面还有没有动静
 * 才知道:后面又来了块,它就是中途说的话;回合结束时它还攒着,它就是答复。
 *
 * 单独拎出来是为了能测 —— `query()` 是直接 import 的,那个循环没法在单测里驱动。
 */
export class ProgressFan {
  private pending: AgentProgressEvent | undefined;

  /** 交一条 assistant 消息的内容块进来,拿回**此刻**该推出去的事件(按序)。 */
  take(blocks: readonly ContentBlockLike[]): AgentProgressEvent[] {
    const out: AgentProgressEvent[] = [];
    for (const block of blocks) {
      // display 未生效或被覆盖时 thinking 可能为空串,跳过以免发出空的 💭 消息。
      const ev: AgentProgressEvent | undefined =
        block.type === "thinking" && block.thinking?.trim()
          ? { kind: "thinking", text: block.thinking }
          : block.type === "tool_use" && block.name
            ? { kind: "tool", name: block.name, input: block.input }
            : block.type === "text" && block.text?.trim()
              ? { kind: "text", text: block.text }
              : undefined;
      if (!ev) continue;
      // 后面来了动静,攒着的那个就确定不是答复了 —— 按原顺序先放它出去。
      if (this.pending) {
        out.push(this.pending);
        this.pending = undefined;
      }
      if (ev.kind === "text") {
        this.pending = ev;
        continue;
      }
      out.push(ev);
    }
    return out;
  }
}

/**
 * 往**正在跑的**回合里追加一批输入。回合已收摊则返回 false。
 *
 * 追加进去的内容会被 SDK 折进当前 turn,模型在下一次请求就能看到 ——
 * 这正是"用户中途补一句话"该有的语义。调用方拿到 false 时应当回落到
 * 起一个新回合,而不是把消息丢掉。
 */
export type AgentFeed = (prompt: string, attachments: readonly Attachment[]) => boolean;

export interface AgentRunOptions {
  context?: ExecutionContext;
  /** 传入则 resume 该会话;不传则开启新会话。 */
  resumeSessionId?: string;
  /**
   * 本次回合的工作目录。多用户下每人一个,不传则回落到全局 workspaceDir。
   * cwd 同时决定 SDK 把会话 JSONL 写到哪个 project 目录,因此它也是会话隔离的载体。
   */
  cwd?: string;
  /**
   * 本回合用的模型。不传则回落到 config.model;两个都空就完全不传给 SDK,
   * 由它自己决定 —— 这是配置兜底链的末端,保证 agent 永远能起来。
   */
  model?: string;
  /**
   * 思考强度(SDK 的 effort)。不传就不给 SDK,由它按模型默认 —— 与 model 同一条
   * 兜底原则:设置项坏了也不能让回合起不来。
   */
  effort?: EffortLevel;
  /** 调用方提供的回合元数据；真实 worker 环境由执行计划统一生成。 */
  env?: Record<string, string | undefined>;
  /** 本回合可见的 skill 名单。注意这是上下文过滤而非沙箱,详见 skills.ts。 */
  skills?: string[];
  /**
   * 本回合最多几轮。不传则不限(日常对话就该不限:回合该跑多久由任务决定)。
   *
   * 存在的理由是自检:smoke 要的是"大脑通不通"这一个事实,一次请求就够了,
   * 而它跑在部署流水线里、没有人盯着 —— 万一模型开始自顾自地干活,烧的是订阅额度
   * 且会把部署门拖到超时。给它一个硬上限,自检就不可能跑飞。
   */
  maxTurns?: number;
  /** 供 /取消 中断本回合。abort 后 run() 抛错,由上层的错误分支处理。 */
  abortController?: AbortController;
  /** 中间过程回调(思考/工具调用)。回调应快速返回,耗时操作自行异步化。 */
  onProgress?: (ev: AgentProgressEvent) => void;
  /**
   * 「还在动」。**每条 SDK 消息都调一次**,与 onProgress 透出的那两类无关。
   *
   * 这跟心跳用的是同一个判据(见下面 lastAt 那行):工具结果回填、API 重试
   * 同样是活着的证据,只认 onProgress 会把一个正常推进、但半天没有新工具调用的
   * 回合误判成没动静。调用方要节流自己节流 —— 这里给的是原始事实。
   */
  onAlive?: () => void;
  /**
   * 日志里标识这是谁的回合(网关传 userKey)。多用户并发时,不带这个的话
   * 几个回合的日志会交织成一团分不开。
   */
  logLabel?: string;
  /**
   * 随本回合带上的图片。会作为 image content block **内联**进这一轮的用户消息,
   * 模型第一次推理就能看到 —— 而不是先落盘再让它自己去 Read(那要多一次
   * 工具往返,且模型可能压根不去读)。
   */
  attachments?: readonly Attachment[];
  /**
   * 回合已经可以接收追加输入了,把句柄交给调用方。
   *
   * 在 `query()` 建好之后**同步**调用一次。给出的 `feed` 在本回合收摊后失效
   * (返回 false),调用方不必自己判断时机。
   */
  onFeedReady?: (feed: AgentFeed) => void;
  /**
   * 给**用户**发一条带外通知(目前只有内存看门狗在用)。
   *
   * 与 onProgress 分开:进度是"助手在干什么",这条是"系统对这个回合做了什么"。
   * 混在进度里的话,用户按偏好关掉进度推送就再也看不到看门狗动手了 ——
   * 而那恰恰是最该让他知道的一类消息。
   */
  onNotice?: (text: string) => void;
  /**
   * 一拿到 sessionId 就喊一声(第一条 SDK 消息就带,远早于任何工具调用)。
   *
   * 存在的理由只有一个:**回合抛错时 `run()` 的返回值拿不到了**,而 sessionId
   * 恰好是那时最需要的东西 —— 没有它,被中止的那段对话在盘上完好无损却再也没人
   * 指得到,用户下一句话会开一个全新会话。真机上发生过:内存看门狗中止了某人
   * 会话的**第一个**回合,他说"再试试",大脑答"我没有之前的上下文"。
   */
  onSessionId?: (id: string) => void;
  /**
   * 环境信息,挂在**首条**消息的末尾当独立 block(见 buildUserMessage)。
   *
   * 只给首条 —— 回合中途的追加输入(tryFeed)不重复,那是同一个回合、
   * 同一份上下文,说第二遍只是噪音。
   */
  ambient?: string;
}

/**
 * 把文本与附件拼成一条 SDK 用户消息。
 *
 * 图片放在文字**前面**:提问往往在指代图片("这张图里是什么"),先图后文才让
 * 指代有对象。文本与附件**不能同时为空** —— 空 content 会被模型侧拒收;
 * 调用方(网关的 handle 与 tryFeed)负责挡在前面。
 */
export function buildUserMessage(
  prompt: string,
  attachments: readonly Attachment[],
  ambient?: string,
): SDKUserMessage {
  const content: SDKUserMessage["message"]["content"] = attachments.map((a) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: a.mediaType, data: a.data },
  }));
  // 空 text block 会被模型侧拒绝,所以只在真有文字时才加。
  if (prompt.trim()) content.push({ type: "text", text: prompt });
  // 环境信息(如版本变了)挂在**最后一个独立 block**,不拼进用户那句话里。
  //
  // 两个理由,都吃过亏才知道:
  // ① 拼进 text 会污染命令解析 —— 用户那句可能是 `/发布 abc1234`。
  // ② 单独发一条消息则会被读成"用户说了句他没说的话"(InputChannel.push 收的是
  //    SDKUserMessage,身份就是用户)。同一条消息里的另一个 block 才是环境信息
  //    该有的形态。
  if (ambient?.trim()) {
    content.push({ type: "text", text: `<system-reminder>\n${ambient.trim()}\n</system-reminder>` });
  }

  return {
    type: "user",
    session_id: "",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

/**
 * 把一个回合产出的各段正文拼成最终回复。
 *
 * 正常回合只有一段;追加输入落在 turn 边界上时会多出几段(见 run 的收尾注释)。
 *
 * 空正文的兜底话术**必须分失败与成功两种**:SDK 以错误结束时 `errors` 可能是空数组、
 * `result` 可能是空串,此时沿用"助手没有返回内容"会把一次失败伪装成一次无话可说 ——
 * 而这两者用户该做的事恰好相反(去查订阅/配置 vs 换个问法再问一遍)。
 */
export function joinReplyTexts(texts: readonly string[], isError: boolean): string {
  const joined = texts.filter((t) => t.trim()).join("\n\n");
  if (joined) return joined;
  return isError ? "(回合失败,SDK 没有给出错误详情)" : "(助手没有返回内容)";
}

/**
 * 回合的输入通道:一个**常开**的 AsyncIterable,回合跑起来之后仍能往里追加消息。
 *
 * **为什么必须常开**:SDK 只在流式输入下接受回合中途的追加输入。喂进来的消息会被
 * 折进**正在跑的那个 turn**,模型下一次请求就看到 —— 这正是"用户中途补一句话"
 * 该有的语义。传 string(或一个 yield 完就结束的 iterable)等于告诉 SDK
 * "输入到此为止",追加无从谈起。代价是纯文本回合也走流式输入,不再传 string。
 *
 * **关闭语义**:`close()` 只表示"不会再有新输入",**不丢**已经 push 进来的消息 ——
 * 它们照样会被执行,只是可能各自跑成一个 turn。所以回合收尾时无脑 close 是安全的,
 * 不存在"消息挤在 result 与 close 之间被吞掉"的竞态(实测确认,见 run 里的收尾注释)。
 */
export class InputChannel {
  private readonly queue: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  push(msg: SDKUserMessage): void {
    this.queue.push(msg);
    this.wake?.();
  }

  /** 幂等:回合的正常收尾与 finally 的兜底都会调它。 */
  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      // 先排空再判关闭:close() 之后剩在队列里的消息仍要交出去。
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

/**
 * 已知无害、每回合都会出现的 stderr。
 *
 * stderr 是 SDK 报错的唯一去处,所以 agent.ts 无条件转发它 —— 那条设计依赖
 * "正常回合一个字都不输出"。会话容器化之后 docker 每次都吐一句 swap 告警,
 * 这条性质就没了:一条固定噪音会把真正的错误淹掉(与双 tini 那三行同一个坑)。
 *
 * 只滤**已知的这一条**,其余照旧放行 —— 宁可多看几行,不可把没见过的错误藏起来。
 * (那句告警本身无害:宿主 SwapTotal=0,"只管 RAM"就等于管住一切,
 * 实测内存炸弹照样 2 秒被 OOM 掉。)
 */
function isBenignStderr(line: string): boolean {
  return /kernel does not support swap limit/i.test(line);
}

/** SDK transport for owner-scoped execution contexts. */
export class Agent {
  private readonly live = new Map<string, { session: SdkSession; options: AgentRunOptions; model?: string; effort?: string }>();
  constructor(private readonly config: Config, private readonly execution?: {
    contexts: ContextStore; runtimes: RuntimeManager; broker: CapabilityBroker;
  }, private readonly probe = false) {}

  static forProbe(config: Config): Agent { return new Agent(config, undefined, true); }

  async run(prompt: string, opts: AgentRunOptions = {}): Promise<AgentReply> {
    if (this.probe) return this.runProbe(prompt, opts);
    const e = this.execution, context = opts.context;
    if (!e || !context) throw new Error("agent 必须在有归属的执行上下文中运行");
    e.runtimes.activity(context.id);
    const runtime = await e.runtimes.ensure(context);
    const paths = e.contexts.paths(context);
    let entry = this.live.get(context.id);
    if (entry && !entry.session.alive) { this.live.delete(context.id); entry = undefined; }
    // A different SDK session (fresh cron) cannot attach to the previous CLI.
    if (entry && (opts.resumeSessionId === undefined && context.sdkStarted === false)) {
      entry.session.close(); this.live.delete(context.id); entry = undefined;
    }
    if (entry && (entry.model !== opts.model || entry.effort !== opts.effort)) {
      if (runtime.sdkTasks.length) throw new Error("此上下文仍有 SDK 后台任务；请先结束任务，再切换模型或思考设置");
      entry.session.close(); this.live.delete(context.id); entry = undefined;
    }
    if (!entry) {
      const agentId = randomUUID();
      const env: Record<string, string | undefined> = {
        ...networkEnvironment(this.config.apiBase),
        PATH: "/runtime/bin:/usr/local/bin:/usr/bin:/bin", HOME: paths.sdk, TZ: this.config.tz,
        CLAUDE_CONFIG_DIR: paths.sdk, ANTHROPIC_BASE_URL: `${this.config.apiBase}/api/runtime/model`,
        ANTHROPIC_AUTH_TOKEN: runtime.token, CATMAN_API_BASE: this.config.apiBase,
        CATMAN_SESSION_TOKEN: runtime.token, CATMAN_RUNTIME_TOKEN: runtime.token, CATMAN_AGENT_ID: agentId,
        CATMAN_CONTEXT_ID: context.id, CATMAN_CONTEXT_DIR: paths.work, CATMAN_USER_PRIVATE_DIR: "/user",
        ...(process.env.DOCKER_API_VERSION ? { DOCKER_API_VERSION: process.env.DOCKER_API_VERSION } : {}),
      };
      const personalMcp = readTenantFile(paths.home, "mcp.json");
      const privateServers: Record<string, McpServerConfig> = personalMcp ? JSON.parse(personalMcp) : {};
      for (const [name, server] of Object.entries(privateServers)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || !server || typeof server !== "object" || server.type === "sdk") throw new Error("个人 MCP 配置无效");
      }
      const mcpServers = {
        ...Object.fromEntries(Object.entries(privateServers).map(([name, config]) => [`user_${name}`, config])),
        ...Object.fromEntries(Object.entries(e.broker.mcpServers(runtime, this.config.apiBase)).map(([name, config]) => [`public_${name}`, config])),
      };
      const allSkills = [...new Set([...(opts.skills ?? []), ...skillsOnDisk(paths.home).filter(name => !(GENERATED_SKILLS as readonly string[]).includes(name))])];
      const slot: { session: SdkSession; options: AgentRunOptions; model?: string; effort?: string } = {
        session: undefined!, options: opts, model: opts.model, effort: opts.effort,
      };
      const session = new SdkSession(input => query({ prompt: input, options: {
        pathToClaudeCodeExecutable: e.runtimes.wrapper(context, runtime),
        cwd: paths.work, env, ...instructionOptions(this.config.persona, this.config.sessionMemoryLimit),
        ...(context.sdkStarted ? { resume: context.sdkSessionId } : { sessionId: context.sdkSessionId }),
        ...(opts.model ?? this.config.model ? { model: opts.model ?? this.config.model } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}), ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
        thinking: { type: "adaptive", display: "summarized" }, skills: allSkills, mcpServers,
        perTaskStopAffordance: true,
        stderr: data => { if (data.trim() && !isBenignStderr(data.trim())) console.warn(`[agent ${context.id}] ${data.slice(0, 2000)}`); },
      } }), {
        stopAgent: () => e.runtimes.rpc(runtime, `/agents/${agentId}`, "DELETE"),
        onClose: () => {
          if (this.live.get(context.id)?.session === slot.session) { this.live.delete(context.id); e.runtimes.sdkTasks(context.id, []); }
        },
        onBackground: message => {
          if (message.type === "system" && message.subtype === "background_tasks_changed") e.runtimes.sdkTasks(context.id, message.tasks);
          if (message.type === "system" && message.subtype === "task_notification") e.runtimes.report(context.id, `SDK 后台任务 ${message.task_id}：${message.status}\n${message.summary}`, message.uuid);
          if (message.type === "result" && message.subtype === "success" && message.result) e.runtimes.report(context.id, message.result, message.uuid);
        },
      });
      slot.session = session; entry = slot; this.live.set(context.id, slot);
      e.runtimes.onStop(context.id, () => session.close(new Error("执行环境已回收")));
    }
    entry.options = opts;
    e.runtimes.activity(context.id);
    const fan = new ProgressFan();
    opts.onFeedReady?.((text, attachments) => {
      if (!entry!.session.feed(buildUserMessage(text, attachments))) return false;
      e.runtimes.activity(context.id); return true;
    });
    const pendingEvents = e.runtimes.pending(context.id);
    const events = pendingEvents.map(event => event.text).join("\n\n").slice(-12000);
    const message = buildUserMessage(prompt, opts.attachments ?? [], [opts.ambient, events ? `后台任务记录：\n${events}` : ""].filter(Boolean).join("\n\n"));
    const reply = await entry.session.run({ message, signal: opts.abortController?.signal, onMessage: message => {
      if ("session_id" in message && message.session_id) { e.contexts.started(context.id, message.session_id); opts.onSessionId?.(message.session_id); }
      const trace = describeSdkMessage(message);
      if (trace && (trace.level === "always" || AGENT_TRACE)) console.info(`[agent ${context.id}] ${trace.text}`);
      opts.onAlive?.();
      if (message.type === "assistant") {
        e.runtimes.activity(context.id);
        for (const ev of fan.take(message.message.content)) opts.onProgress?.(ev);
      }
      if (message.type === "result") e.runtimes.activity(context.id);
    } });
    e.runtimes.acknowledge(pendingEvents.map(event => event.id));
    return reply;
  }

  close(): void { for (const { session } of this.live.values()) session.close(); this.live.clear(); }

  private async runProbe(prompt: string, opts: AgentRunOptions): Promise<AgentReply> {
    const q = query({ prompt, options: {
      cwd: opts.cwd, model: opts.model ?? this.config.model, maxTurns: 1,
      abortController: opts.abortController, ...instructionOptions(this.config.persona),
    } });
    let text = "", sessionId = "", isError = false;
    try { for await (const m of q) if (m.type === "result") { sessionId = m.session_id; isError = m.is_error; text = m.subtype === "success" ? m.result : m.errors.join("\n"); } }
    finally { q.close(); }
    return { text, sessionId, isError };
  }
}
