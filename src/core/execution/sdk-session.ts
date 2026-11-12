import type { SDKMessage, SDKUserMessage, Query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";

export interface SdkTurnResult { text: string; sessionId: string; isError: boolean }
export interface SdkTurn {
  message: SDKUserMessage;
  onMessage: (message: SDKMessage) => void;
  signal?: AbortSignal;
}

/** Input remains open across results. Native SDK tasks remain owned by the same CLI. */
export class SdkSession {
  private pending?: { resolve: (r: SdkTurnResult) => void; reject: (e: unknown) => void; turn: SdkTurn; abort: () => void; results: string[]; uuids: Set<string>; error: boolean };
  private closed = false;
  private sessionId = "";
  private readonly inputs: SDKUserMessage[] = [];
  private wake?: () => void;
  private tasks = new Map<string, boolean>(); // task id -> ambient
  private hasTaskSnapshot = false;
  private readonly detachedTasks = new Set<string>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly query: Query;
  constructor(factory: (input: AsyncIterable<SDKUserMessage>) => Query, private readonly hooks: {
    onBackground: (message: SDKMessage) => void;
    onClose: () => void;
    stopAgent: () => Promise<unknown>;
    idleMs?: number;
  }) {
    const self = this;
    this.query = factory({ async *[Symbol.asyncIterator]() {
      while (!self.closed) {
        if (!self.inputs.length) await new Promise<void>(resolve => { self.wake = resolve; });
        while (self.inputs.length) yield self.inputs.shift()!;
      }
    } });
    void this.pump();
  }
  get alive(): boolean { return !this.closed; }
  get busy(): boolean { return !!this.pending; }
  get hasBackgroundTasks(): boolean { return this.tasks.size > 0; }
  async run(turn: SdkTurn): Promise<SdkTurnResult> {
    if (this.closed) throw new Error("CLI 已退出");
    if (this.pending) throw new Error("同一上下文不能并发执行两个 agent 回合");
    if (turn.signal?.aborted) throw turn.signal.reason ?? new Error("回合已取消");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    return new Promise((resolve, reject) => {
      const abort = () => {
        // interrupt has SDK-specific background semantics; closing/killing is explicit on cancellation.
        void this.hooks.stopAgent().catch(() => {}); this.close(turn.signal?.reason ?? new Error("回合已取消"));
      };
      turn.message.uuid ??= randomUUID();
      this.pending = { resolve, reject, turn, abort, results: [], uuids: new Set([turn.message.uuid]), error: false };
      turn.signal?.addEventListener("abort", abort, { once: true });
      this.inputs.push(turn.message); this.wake?.(); this.wake = undefined;
    });
  }
  feed(message: SDKUserMessage): boolean {
    if (!this.pending || this.closed) return false;
    message.uuid ??= randomUUID();
    this.pending.uuids.add(message.uuid); this.inputs.push(message); this.wake?.(); this.wake = undefined; return true;
  }
  private async pump(): Promise<void> {
    try {
      for await (const message of this.query) {
        if ("session_id" in message && message.session_id) this.sessionId = message.session_id;
        if (message.type === "system" && message.subtype === "background_tasks_changed") {
          // Membership snapshots are authoritative. Bookends can arrive before or
          // after them; pairing the two streams can resurrect an already-ended task.
          this.hasTaskSnapshot = true;
          this.tasks = new Map(message.tasks.map(t => [t.task_id, !!t.ambient]));
          if (!this.pending) this.rememberDetachedTasks();
          this.hooks.onBackground(message);
          if (this.tasks.size && this.idleTimer) clearTimeout(this.idleTimer);
          if (!this.tasks.size && !this.pending) this.scheduleIdle();
        } else if (message.type === "system" && ["task_notification", "task_started", "task_updated", "task_progress"].includes(message.subtype)) {
          if (!this.hasTaskSnapshot) {
            if (message.subtype === "task_started" && message.is_backgrounded) this.tasks.set(message.task_id, !!(message.ambient || message.skip_transcript));
            if (message.subtype === "task_updated" && message.patch.is_backgrounded) this.tasks.set(message.task_id, this.tasks.get(message.task_id) ?? false);
          }
          if (!this.pending) this.rememberDetachedTasks();
          if (message.subtype === "task_notification") {
            const detached = this.detachedTasks.delete(message.task_id);
            if (!this.hasTaskSnapshot) this.tasks.delete(message.task_id);
            // Blocking Bash also emits these events. The foreground agent already
            // receives its tool result; only work that outlived a turn needs a
            // separate user notice. Unexpected worker loss is always surfaced.
            if ((detached || message.reason === "worker_restart") && !message.ambient && !message.skip_transcript) this.hooks.onBackground(message);
          } else this.hooks.onBackground(message);
          if (!this.pending && !this.tasks.size) this.scheduleIdle();
        }
        const p = this.pending;
        if (message.type === "result" && p) {
          const ids = [...(message.user_message_uuids ?? []), ...(message.user_message_uuid ? [message.user_message_uuid] : [])];
          if (!message.is_error && !ids.some(id => p.uuids.has(id))) { this.hooks.onBackground(message); continue; }
          for (const id of ids) p.uuids.delete(id);
          p.turn.onMessage(message);
          p.error ||= message.is_error;
          const text = message.subtype === "success" ? message.result : message.errors.join("\n");
          if (text) p.results.push(text);
          if (!p.uuids.size || message.is_error) {
            this.pending = undefined; p.turn.signal?.removeEventListener("abort", p.abort);
            this.rememberDetachedTasks();
            p.resolve({ text: p.results.join("\n\n") || (p.error ? "回合失败，SDK 未返回详情" : "(助手没有返回内容)"), sessionId: this.sessionId, isError: p.error });
            this.scheduleIdle();
          }
        } else if (p) p.turn.onMessage(message);
        else if (message.type === "assistant" || message.type === "result") this.hooks.onBackground(message);
      }
      this.close(new Error("CLI 已退出"));
    } catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); }
  }
  private rememberDetachedTasks(): void {
    for (const [id, ambient] of this.tasks) if (!ambient) this.detachedTasks.add(id);
  }
  private scheduleIdle(): void {
    if (this.tasks.size || this.pending || this.closed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.pending && !this.tasks.size) this.close(); }, this.hooks.idleMs ?? 5000);
    this.idleTimer.unref?.();
  }
  close(error = new Error("CLI 已关闭")): void {
    if (this.closed) return; this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const p = this.pending; this.pending = undefined;
    p?.turn.signal?.removeEventListener("abort", p.abort); p?.reject(error);
    this.wake?.(); this.query.close(); void this.hooks.stopAgent().catch(() => {}); this.hooks.onClose();
  }
}
