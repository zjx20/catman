import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentProgressEvent } from "./agent.js";
import { formatStamp } from "./log-stamp.js";

/**
 * LLM 侧的可观测性:把 Agent SDK 的消息流压成日志。
 *
 * **为什么需要**:iLink 那一侧有 `CATMAN_ILINK_TRACE` 可查,而 agent 回合从
 * `query()` 开始到 result 结束全程静默 —— 用户没收到回复时,日志里分不出
 * 「模型还在跑」「卡在一次长工具调用里」「API 在重试」「被限流了」「已经报错但错误被
 * 当成正文发出去了」。这几种的处置完全不同,而它们在日志上长得一模一样:什么都没有。
 *
 * 分两级,理由是频率差了两个数量级:
 *   - `always` —— 每回合至多几行,且每一行都直接回答"为什么没反应"(重试、限流、
 *     自动压缩、回合起止)。这类**不带开关**:需要它的时候往往是事后翻日志,
 *     那时再去开开关重启已经晚了。
 *   - `trace`  —— 每条 SDK 消息一行,`CATMAN_AGENT_TRACE=1` 打开。用于看清
 *     "这一步到底在干什么"。
 *
 * 与 `formatTrace`(iLink)同一条约束:**只出标量与截断摘要,不出完整正文** ——
 * 日志不该成为会话内容的第二份副本。图片只出字节数,工具结果只出长度。
 */

/** 逐条 SDK 消息的追踪开关。 */
export const AGENT_TRACE = process.env.CATMAN_AGENT_TRACE === "1";

/**
 * 回合进行中的心跳间隔(ms),0 = 关。
 *
 * 存在的理由:SDK 消息流在一次长工具调用(跑测试、拉镜像)期间**完全静默**,
 * 那正是最像"卡死"的时候。心跳把"还活着,已经等了多久,卡在哪一步"变成
 * 可见的事实。只进日志、不发给用户 —— 用户侧的进度受 `context_token` 发送
 * 预算约束(见 gateway 的 ProgressThrottle),日志没有这个约束。
 *
 * 这里用定时器**不违反**「进度纯事件驱动、不用定时器」那条不变量:那条约束的
 * 理由是定时器会让进度消息插到正文之后、在用户那边乱序,而日志只有时间轴,
 * 没有相对正文的位置可言。
 */
export const HEARTBEAT_MS = envMs("CATMAN_AGENT_HEARTBEAT_MS", 30_000);

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** 摘要的截断长度。日志一行要能一眼扫过,所以比发给用户的进度更短。 */
const TRACE_MAX_CHARS = 140;

export type TraceLevel = "always" | "trace";

export interface TraceLine {
  text: string;
  level: TraceLevel;
}

function cut(s: string, max = TRACE_MAX_CHARS): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

/** 大数缩写,让 token 数在一行里不占地方。 */
export function shortNum(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 毫秒缩写。 */
export function shortMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 从工具入参里挑一个最能说明"在干什么"的字段做摘要。
 *
 * 住在这里而不是 gateway,是因为发给用户的进度与日志要说**同一件事** ——
 * 两处各写一份的话,用户看到的步骤和日志里的步骤会渐渐对不上,而排查时
 * 「用户说他看到 X」正是最重要的线索。
 */
export function summarizeToolInput(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["description", "command", "file_path", "pattern", "prompt", "query", "url"]) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
}

/** 进度事件的单行描述。心跳与 /状态 都用它,保证"最后一步"到处是同一句话。 */
export function describeProgress(ev: AgentProgressEvent): string {
  if (ev.kind === "thinking") return `💭 ${cut(ev.text, 60)}`;
  // 💬 与 💭 分开:一个是它想的,一个是它说的。混成同一个符号之后,
  // "它在琢磨"和"它在跟你交代"就分不出来了,而那两件事的意味完全不同。
  if (ev.kind === "text") return `💬 ${cut(ev.text, 60)}`;
  const summary = cut(summarizeToolInput(ev.input), 60);
  return summary ? `🔧 ${ev.name}: ${summary}` : `🔧 ${ev.name}`;
}

/**
 * 限流恢复时刻。
 *
 * SDK 只把 `resetsAt` 声明为 number,秒与毫秒两种编码都可能出现 —— 按量级判断,
 * 免得打出 1970 年或五万年后这种"一眼假但没人细看"的时间。用与日志前缀相同的
 * 本地时区格式(`formatStamp`),否则这一行的时刻和它上下两行对不上。
 */
export function formatResetAt(resetsAt: number | undefined): string {
  if (!resetsAt || !Number.isFinite(resetsAt)) return "";
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  return ` 恢复于 ${formatStamp(new Date(ms))}`;
}

/** 按 `type` 分派、按需读字段的宽松 content block 视图。 */
type ContentBlockLike = { type: string } & Record<string, unknown>;

/** assistant 消息里一个 content block 的摘要。**图片只出字节数,不出 base64**。 */
function describeBlock(block: ContentBlockLike): string {
  switch (block.type) {
    case "text":
      return `text(${String(block.text ?? "").length}字)`;
    case "thinking":
      return `thinking(${String(block.thinking ?? "").length}字)`;
    case "redacted_thinking":
      return "thinking(已脱敏)";
    case "tool_use":
    case "server_tool_use": {
      const summary = cut(summarizeToolInput(block.input), 80);
      return summary ? `tool:${String(block.name)}(${summary})` : `tool:${String(block.name)}`;
    }
    case "image": {
      // 只出体积。base64 本身既是刷屏源头,也是不该进日志的用户内容。
      const src = (block["source"] ?? {}) as Record<string, unknown>;
      const data = src["data"];
      return `image(${shortNum(typeof data === "string" ? data.length : 0)} base64字符)`;
    }
    default:
      return block.type;
  }
}

/** user 消息(工具结果回填)的摘要:只出长度与成败,内容可能有几万字。 */
function describeToolResults(content: unknown): string {
  if (typeof content === "string") return `text(${content.length}字)`;
  if (!Array.isArray(content)) return "(空)";
  return content
    .map((b: unknown) => {
      const o = (b ?? {}) as Record<string, unknown>;
      if (o["type"] !== "tool_result") return String(o["type"] ?? "?");
      const body = o["content"];
      const chars =
        typeof body === "string"
          ? body.length
          : Array.isArray(body)
            ? body.reduce(
                (n: number, x: unknown) =>
                  n + String((x as Record<string, unknown>)?.["text"] ?? "").length,
                0,
              )
            : 0;
      return `result(${chars}字${o["is_error"] ? " 出错" : ""})`;
    })
    .join(" ");
}

/**
 * 把一条 SDK 消息压成一行。返回 undefined 表示不值得记。
 *
 * 纯函数,所以「不泄漏图片 base64 与工具结果全文」这条约束能直接钉进单测 ——
 * 它是唯一会把 SDK 原始内容写进日志的地方。
 *
 * `result` 刻意返回 undefined:回合结束行由 `Agent.run` 自己打(它还知道
 * 墙钟耗时与步数),这里再打一条就是重复。
 */
export function describeSdkMessage(msg: SDKMessage): TraceLine | undefined {
  switch (msg.type) {
    case "assistant": {
      // content block 的联合类型很宽(web search 结果、MCP 结果……),而这里只按
      // `type` 分派并读几个已知字段,所以退化成字典读更贴合实际,也不会随 SDK 扩类型而崩。
      const blocks = (msg.message.content as unknown as ContentBlockLike[])
        .map(describeBlock)
        .join(" ");
      const u = msg.message.usage;
      const usage = u ? ` [in=${shortNum(u.input_tokens)} out=${shortNum(u.output_tokens)}]` : "";
      const stop = msg.message.stop_reason ? ` stop=${msg.message.stop_reason}` : "";
      // SDK 在 assistant 消息上挂 error 字段来表达"这一轮模型调用本身出错了"。
      // 这类错误不一定终止回合(会重试),但静默过去就查不到源头。
      if (msg.error) {
        return { level: "always", text: `assistant 出错:${cut(JSON.stringify(msg.error))}` };
      }
      return { level: "trace", text: `assistant ${blocks || "(空)"}${stop}${usage}` };
    }

    case "user":
      return { level: "trace", text: `user ${describeToolResults(msg.message.content)}` };

    case "result":
      return undefined;

    case "rate_limit_event": {
      const i = msg.rate_limit_info;
      const reset = formatResetAt(i.resetsAt);
      const util = i.utilization === undefined ? "" : ` 已用 ${Math.round(i.utilization)}%`;
      return {
        // 被拒或接近上限是"没反应"的常见真因,且无法从别处推断出来。
        level: i.status === "allowed" ? "trace" : "always",
        text: `限流 status=${i.status}${i.rateLimitType ? ` 类型=${i.rateLimitType}` : ""}${util}${reset}`,
      };
    }

    case "system":
      switch (msg.subtype) {
        case "init":
          // 这一行是"三件套是否真的生效"的唯一事实来源:preset 系统提示词、
          // settingSources、bypassPermissions 出问题时,症状是助手"脾气不对",
          // 而不是报错 —— 只能靠核对这里。
          return {
            level: "always",
            text:
              `init model=${msg.model} mode=${msg.permissionMode} ` +
              `tools=${msg.tools.length} skills=${msg.skills.length} cwd=${msg.cwd}`,
          };
        case "api_retry":
          // 头号"看起来卡死"的真因:上游 529/超时,SDK 在静默退避重试。
          return {
            level: "always",
            text:
              `API 重试 第${msg.attempt}/${msg.max_retries}次 ` +
              `${msg.retry_delay_ms}ms 后重试 status=${msg.error_status ?? "连接错误"}`,
          };
        case "compact_boundary": {
          const m = msg.compact_metadata;
          // 自动压缩要几十秒且期间没有任何别的消息,不记就是一段无解的空白。
          return {
            level: "always",
            text:
              `上下文压缩(${m.trigger}) ${shortNum(m.pre_tokens)}→` +
              `${m.post_tokens === undefined ? "?" : shortNum(m.post_tokens)} tokens` +
              (m.duration_ms === undefined ? "" : ` 耗时 ${shortMs(m.duration_ms)}`),
          };
        }
        case "status":
          return msg.compact_result === "failed"
            ? { level: "always", text: `压缩失败:${cut(msg.compact_error ?? "")}` }
            : { level: "trace", text: `status ${JSON.stringify(msg.status)}` };
        default:
          return { level: "trace", text: `system/${(msg as { subtype: string }).subtype}` };
      }

    default: {
      const m = msg as { type: string; subtype?: string };
      // 纯计数类的流式增量:一次模型往返能来好几条,而它们说不出任何
      // "在干什么"。留着只会把有用的行挤出屏幕。
      if (m.type === "thinking_tokens") return undefined;
      return { level: "trace", text: m.subtype ? `${m.type}/${m.subtype}` : m.type };
    }
  }
}

/**
 * 心跳行:回合还在跑时定期打的那一句。
 *
 * 两个时长缺一不可:`已 Xs` 说明这个回合总共等了多久(判断要不要 /取消),
 * `最后一步 Ys 前` 说明距上一次有动静过了多久 —— 前者一直涨而后者不涨,
 * 就是卡在某一步上;两者同步涨则是在正常推进。
 */
export function formatHeartbeat(
  elapsedMs: number,
  sinceLastMs: number,
  steps: number,
  last?: string,
): string {
  const tail = last ? ` · ${last}` : "";
  return `进行中 已 ${shortMs(elapsedMs)} · 第 ${steps} 步(${shortMs(sinceLastMs)} 前)${tail}`;
}
