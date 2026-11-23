import { closeSync, constants, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Attachment } from "../attachments.js";

/**
 * 会话 ID 校验。
 *
 * 会话 ID 可能来自外部 CLI / ACP 子进程（跑在不受信任的租户容器内）。控制面用它拼
 * `<context.root>/transcripts/<sessionId>.jsonl`，必须彻底拒绝路径分隔符、`..` 与控制字符，
 * 防止恶意子进程借伪造 `sessionId` 越出当前上下文目录覆盖控制面文件。
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isSafeSessionId(id: string): boolean {
  return SAFE_SESSION_ID.test(id) && !id.includes("..");
}

export function assertSafeSessionId(id: string): string {
  if (!isSafeSessionId(id)) {
    throw new Error(`非法的会话标识: ${JSON.stringify(id.slice(0, 64))}`);
  }
  return id;
}

export type RecordedAssistantBlock =
  | { type: "thinking"; thinking: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

/**
 * 控制面自持的标准会话记录写入器。
 *
 * 写入位置固定为 `<context.root>/transcripts/<sessionId>.jsonl`：
 * - `<context.root>` 本身不挂进 worker 容器（worker 只挂 `work`、`sdk`、`tasks`），
 *   因此租户内的代码既不能篡改审计记录，也无法通过软链诱导控制面越界写文件。
 * - 行格式与 `core/transcript.ts` 的既有 JSONL 解析器完全一致，使得 Dashboard 会话页、
 *   全文检索、`/切换会话` 存活探测与过期清理无视底层 Harness 差异统一工作。
 */
export class TranscriptRecorder {
  constructor(private readonly dir: string) {}

  private append(sessionId: string, record: Record<string, unknown>): void {
    assertSafeSessionId(sessionId);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, `${sessionId}.jsonl`);
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      (constants.O_NOFOLLOW ?? 0);
    const fd = openSync(file, flags, 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`, undefined, "utf8");
    } finally {
      closeSync(fd);
    }
  }

  recordUser(sessionId: string, prompt: string, attachments: readonly Attachment[]): void {
    const content: Array<Record<string, unknown>> = attachments.map(() => ({
      type: "text",
      text: "[图片]",
    }));
    if (prompt.trim()) content.push({ type: "text", text: prompt });
    if (!content.length) return;
    this.append(sessionId, {
      type: "user",
      message: { role: "user", content },
    });
  }

  recordAssistant(sessionId: string, blocks: readonly RecordedAssistantBlock[]): void {
    const filtered = blocks.filter((b) => {
      if (b.type === "thinking") return Boolean(b.thinking.trim());
      if (b.type === "text") return Boolean(b.text.trim());
      return Boolean(b.name);
    });
    if (!filtered.length) return;
    this.append(sessionId, {
      type: "assistant",
      message: { role: "assistant", content: filtered },
    });
  }

  recordToolResult(sessionId: string, toolUseId: string, content: string, isError = false): void {
    this.append(sessionId, {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content,
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
    });
  }

  recordResult(sessionId: string, result: string, isError: boolean): void {
    this.append(sessionId, {
      type: "result",
      subtype: isError ? "error" : "success",
      result,
      is_error: isError,
    });
  }
}
