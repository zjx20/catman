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
}

/**
 * 把文本与附件拼成一条 SDK 用户消息。
 *
 * 图片放在文字**前面**:提问往往在指代图片("这张图里是什么"),先图后文才让
 * 指代有对象。纯文本回合不走这里,仍旧直接把 string 交给 SDK。
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
 * 把单条消息包成 SDK 要的 AsyncIterable。
 *
 * 单条即结束:SDK 的 streamInput 写完就 endInput,与直接传 string 的行为一致,
 * 不会让它继续等后续输入。
 */
async function* singleMessage(msg: SDKUserMessage): AsyncIterable<SDKUserMessage> {
  yield msg;
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

    const q = query({
      // 无附件时保持传 string —— SDK 内部会包成单个 text block,行为与从前完全一致。
      prompt: attachments.length
        ? singleMessage(buildUserMessage(prompt, attachments))
        : prompt,
      options: {
        systemPrompt: { type: "preset", preset: "claude_code" },
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
    let text = "";
    let isError = false;

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
          isError = message.is_error;
          text = message.subtype === "success" ? message.result : message.errors.join("\n");
          this.logResult(tag, message, Date.now() - startedAt, steps);
        }
      }
    } catch (err) {
      // 回合以异常告终(abort / SDK 内部错误)也要留一行:上层网关只会打
      // 一句"处理失败",而这里能说清它跑了多久、走到第几步就断了。
      console.error(
        `${tag} 回合中断 ${shortMs(Date.now() - startedAt)} 第 ${steps} 步:${String(err)}`,
      );
      throw err;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    if (!text) text = "(助手没有返回内容)";
    return { text, sessionId, isError };
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
