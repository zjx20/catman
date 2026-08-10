import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import type { Attachment } from "./attachments.js";
import {
  AGENT_TRACE,
  HEARTBEAT_MS,
  describeProgress,
  describeSdkMessage,
  formatHeartbeat,
  shortMs,
  shortNum,
} from "./agent-trace.js";
import { personaBriefing } from "./persona.js";

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
  | { kind: "tool"; name: string; input: unknown };

/**
 * 往**正在跑的**回合里追加一批输入。回合已收摊则返回 false。
 *
 * 追加进去的内容会被 SDK 折进当前 turn,模型在下一次请求就能看到 ——
 * 这正是"用户中途补一句话"该有的语义。调用方拿到 false 时应当回落到
 * 起一个新回合,而不是把消息丢掉。
 */
export type AgentFeed = (prompt: string, attachments: readonly Attachment[]) => boolean;

export interface AgentRunOptions {
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
   * 子进程环境变量。**SDK 会用它整体替换子进程环境**(不是合并),
   * 调用方必须自己展开 process.env,并对不该下放的变量做剔除。
   */
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
): SDKUserMessage {
  const content: SDKUserMessage["message"]["content"] = attachments.map((a) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: a.mediaType, data: a.data },
  }));
  // 空 text block 会被模型侧拒绝,所以只在真有文字时才加。
  if (prompt.trim()) content.push({ type: "text", text: prompt });

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

export class Agent {
  constructor(private readonly config: Config) {}

  /**
   * 处理一条用户消息,返回助手回复。
   * 每条消息一次 query();通过 resume 维持多轮上下文,由 SDK 负责
   * auto-compaction 与 JSONL 持久化。
   */
  async run(prompt: string, opts: AgentRunOptions = {}): Promise<AgentReply> {
    const attachments = opts.attachments ?? [];
    const tag = `[agent${opts.logLabel ? ` ${opts.logLabel}` : ""}]`;
    const startedAt = Date.now();
    const model = opts.model ?? this.config.model;
    console.info(
      `${tag} 回合开始 model=${model ?? "(交给 SDK)"} ` +
        `${opts.resumeSessionId ? `resume=${opts.resumeSessionId.slice(0, 8)}` : "新会话"} ` +
        `${prompt.length}字 图${attachments.length}`,
    );

    // 输入一律走常开通道(不再按有无附件分叉):回合中途的追加输入只有流式输入下才收得进。
    const input = new InputChannel();
    input.push(buildUserMessage(prompt, attachments));

    const q = query({
      prompt: input,
      options: {
        // append 是**唯一**无条件在场的身份出口:skill 正文按需加载(模型可能压根
        // 不去读)、CLAUDE.md 住在数据卷里(用户能改能删),而"我是哪个人格"是装配
        // 事实。守护人格真机上正是因为缺这一段,张口就自称主人格。见 persona.ts。
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: personaBriefing(this.config.persona),
        },
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
        // 当前模型的 API 默认 display="omitted":thinking 块存在但文本为空。
        // 要向用户透出思考摘要必须显式开启 summarized。
        thinking: { type: "adaptive", display: "summarized" },
        cwd: opts.cwd ?? this.config.workspaceDir,
        // 两个都空就整个不传 model —— 兜底链的末端,交给 SDK 决定。
        ...(model ? { model } : {}),
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.skills ? { skills: opts.skills } : {}),
        ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
        ...(opts.abortController ? { abortController: opts.abortController } : {}),
        // CLI 子进程的 stderr 是启动失败/鉴权报错的唯一去处,不接就彻底看不见。
        // 无条件转发(不受 TRACE 开关约束):正常回合它一个字都不输出,
        // 一旦有内容就正是要找的东西。
        stderr: (data: string) => {
          const line = data.trim();
          if (line) console.warn(`${tag} stderr: ${line.slice(0, 2000)}`);
        },
      },
    });

    let sessionId = opts.resumeSessionId ?? "";
    let isError = false;
    /** 各 result 的正文。正常回合只有一段;追加输入落在 turn 边界上时会多出几段。 */
    const texts: string[] = [];

    // 追加窗口。收到 result 就关,而 feed 本身是同步函数 —— JS 单线程保证两者
    // 不会交错,不存在"判定通过之后窗口才关"的半开状态。窗口关了返回 false,
    // 调用方据此回落去起新回合。
    let accepting = true;
    let fed = 0;
    opts.onFeedReady?.((feedPrompt, feedAttachments) => {
      if (!accepting) return false;
      input.push(buildUserMessage(feedPrompt, feedAttachments));
      fed += 1;
      console.info(
        `${tag} 追加输入 #${fed} ${feedPrompt.length}字 图${feedAttachments.length}`,
      );
      return true;
    });

    // 心跳所需的状态。**覆盖所有 SDK 消息**而不只是 onProgress 透出的那两类:
    // 工具结果回填、API 重试同样是"还在动"的证据,漏掉它们会把正常推进的回合
    // 误报成卡住。计时器起在 query() 之后、紧挨着 finally 所在的 try ——
    // 中间任何一步抛错都不会留下一个空转着打日志的定时器。
    let steps = 0;
    let lastAt = startedAt;
    let lastStep: string | undefined;
    const heartbeat =
      HEARTBEAT_MS > 0
        ? setInterval(() => {
            const now = Date.now();
            console.info(
              `${tag} ${formatHeartbeat(now - startedAt, now - lastAt, steps, lastStep)}`,
            );
          }, HEARTBEAT_MS)
        : undefined;
    // 心跳不该拖着进程不退出 —— 它是观测,不是工作。
    heartbeat?.unref?.();

    try {
      for await (const message of q) {
        // 每条消息都带 session_id;新会话时从这里捕获。
        if ("session_id" in message && message.session_id) {
          sessionId = message.session_id;
        }

        const line = describeSdkMessage(message);
        if (line && (line.level === "always" || AGENT_TRACE)) {
          console.info(`${tag} ${line.text}`);
        }
        // 心跳的"上次动静"以任何一条 SDK 消息为准,与要不要打日志无关。
        lastAt = Date.now();

        if (message.type === "assistant") {
          for (const block of message.message.content) {
            // display 未生效或被覆盖时 thinking 可能为空串,跳过以免发出空的 💭 消息。
            const ev: AgentProgressEvent | undefined =
              block.type === "thinking" && block.thinking.trim()
                ? { kind: "thinking", text: block.thinking }
                : block.type === "tool_use"
                  ? { kind: "tool", name: block.name, input: block.input }
                  : undefined;
            if (!ev) continue;
            steps += 1;
            lastStep = describeProgress(ev);
            opts.onProgress?.(ev);
          }
        }

        if (message.type === "result") {
          // 先关追加窗口再 close 输入流。close **不会**丢掉已 push 的消息:
          // 挤在 result 与 close 之间的那条(管道延迟造成的窄窗口)照样会跑,
          // 只是自成一个 turn 并再吐一个 result —— 所以这里不 break,继续把
          // 后续 result 的正文接在后面。就此收摊等于把用户那条话静默吞掉。
          accepting = false;
          input.close();
          isError ||= message.is_error;
          const body = message.subtype === "success" ? message.result : message.errors.join("\n");
          if (body) texts.push(body);
          this.logResult(tag, message, Date.now() - startedAt, steps);
        }
      }
      if (texts.length > 1) {
        console.info(
          `${tag} 本回合产出 ${texts.length} 段正文 —— 有追加输入正好落在 turn 边界上,各自成了一轮`,
        );
      }
    } catch (err) {
      // 回合以异常告终(abort / SDK 内部错误)也要留一行:上层网关只会打
      // 一句"处理失败",而这里能说清它跑了多久、走到第几步就断了。
      console.error(
        `${tag} 回合中断 ${shortMs(Date.now() - startedAt)} 第 ${steps} 步:${String(err)}`,
      );
      throw err;
    } finally {
      // 抛错(abort / SDK 内部错误)路径同样要关掉窗口与输入流:
      // 窗口不关的话,已经收摊的回合还会对 feed 返回 true,那条消息就没人跑了。
      accepting = false;
      input.close();
      if (heartbeat) clearInterval(heartbeat);
    }

    return { text: joinReplyTexts(texts, isError), sessionId, isError };
  }

  /**
   * 回合结束的那一行。**无条件打** —— 一个回合只有一条,而它回答的问题
   * (成功没有、花了多久、几轮、多少 token)正是事后翻日志最先要看的。
   */
  private logResult(
    tag: string,
    msg: Extract<SDKMessage, { type: "result" }>,
    wallMs: number,
    steps: number,
  ): void {
    const u = msg.usage;
    const usage = u
      ? ` in=${shortNum(u.input_tokens)} out=${shortNum(u.output_tokens)}` +
        ` 缓存读=${shortNum(u.cache_read_input_tokens ?? 0)}`
      : "";
    const body =
      `${shortMs(wallMs)}(API ${shortMs(msg.duration_api_ms)}) 第${steps}步 ` +
      `${msg.num_turns}轮 $${msg.total_cost_usd.toFixed(4)}${usage}`;
    if (msg.subtype === "success" && !msg.is_error) {
      console.info(`${tag} 回合完成 ${body}`);
      return;
    }
    // is_error 以前被读出来却从没人看 —— SDK 报错(鉴权失败、超限、达到轮数上限)
    // 时,错误文本被当成正文发给用户,日志里一个字都没有。
    const detail = msg.subtype === "success" ? "" : ` errors=${msg.errors.map((e) => e).join(" | ")}`;
    console.error(`${tag} 回合失败 subtype=${msg.subtype} ${body}${detail}`);
  }
}
