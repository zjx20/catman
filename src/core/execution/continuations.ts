import { join } from "node:path";
import { writeJsonFileAtomic } from "../file-store.js";
import { readExecutionState, type ContextStore, type ExecutionContext } from "./contexts.js";
import type { RuntimeEvent, RuntimeManager } from "./runtime.js";

export const CONTINUATION_LIMIT = 3;
export const CONTINUATION_TIMEOUT_MS = 5 * 60_000;
export const CONTINUATION_MAX_TURNS = 12;
export const CONTINUATION_MAX_USD = 2;
interface Budget { attempts: number; notBefore: number; paused?: boolean; warned?: boolean }

/** Durable, bounded dispatch. Only explicit task/prepare events can start inference. */
export class BackgroundContinuations {
  private readonly path: string;
  private readonly budgets: Record<string, Budget>;
  private readonly active = new Set<string>();
  private stopped = false;
  constructor(dataDir: string, private readonly contexts: ContextStore, private readonly runtimes: RuntimeManager, private readonly opts: {
    ready: (context: ExecutionContext, starting?: boolean) => boolean;
    run: (context: ExecutionContext, events: RuntimeEvent[], begin: () => boolean) => Promise<boolean>;
    now?: () => number;
  }) {
    this.path = join(dataDir, "execution", "continuations.json");
    this.budgets = readExecutionState(this.path, {});
    for (const b of Object.values(this.budgets)) if (!b || !Number.isSafeInteger(b.attempts) || b.attempts < 0 || !Number.isFinite(b.notBefore)) throw new Error("后台续接预算状态损坏");
  }
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private save(): void { writeJsonFileAtomic(this.path, this.budgets, 0o600); }
  reset(contextId: string): void { this.budgets[contextId] = { attempts: 0, notBefore: 0 }; this.save(); }
  pause(contextId: string): void {
    const b = this.budgets[contextId] ??= { attempts: 0, notBefore: 0 };
    b.paused = true; this.save();
  }
  close(): void { this.stopped = true; }
  retains(contextId: string): boolean {
    const b = this.budgets[contextId];
    return !this.stopped && this.contexts.get(contextId)?.kind === "chat" && !b?.paused && (b?.attempts ?? 0) < CONTINUATION_LIMIT
      && this.runtimes.continuations().some(e => e.contextId === contextId);
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    const grouped = new Map<string, RuntimeEvent[]>();
    for (const e of this.runtimes.continuations()) {
      const batch = grouped.get(e.contextId) ?? [];
      if (batch.length < 10) batch.push(e);
      grouped.set(e.contextId, batch);
    }
    await Promise.all([...grouped].map(async ([id, events]) => {
      if (this.active.has(id) || this.stopped) return;
      const context = this.contexts.get(id, events[0]!.userKey);
      // Cron entry completion/notification policy belongs to its scheduler. Never
      // turn a script cron's result into an unsolicited chat/second cron run.
      if (!context || context.kind !== "chat" || !context.sdkStarted || !this.opts.ready(context)) return;
      const budget = this.budgets[id] ??= { attempts: 0, notBefore: 0 };
      if (budget.paused || this.now() < budget.notBefore) return;
      if (budget.attempts >= CONTINUATION_LIMIT) {
        if (!budget.warned) {
          budget.warned = true; this.save();
          this.runtimes.notifyUser(context.userKey, id, `会话 ${context.sdkSessionId.slice(0, 8)} 的后台自动续接已达到 ${CONTINUATION_LIMIT} 次上限。任务结果已保留，请在原会话发消息继续。`);
        }
        return;
      }
      this.active.add(id);
      let began = false;
      try {
        const ok = await this.opts.run(context, events, () => {
          // Revalidate after waiting for an inference slot. /取消 or new user
          // input may have replaced this budget object while the turn queued.
          if (began || this.stopped || this.budgets[id] !== budget || budget.paused || !this.opts.ready(context, true)) return false;
          if (!this.runtimes.continuations().some(e => events.some(x => x.id === e.id))) return false;
          began = true; budget.attempts += 1;
          // A crash leaves a lease, not an endlessly retried pending invocation.
          budget.notBefore = this.now() + CONTINUATION_TIMEOUT_MS + 60_000;
          this.save();
          console.info(`[continuation] ${id} attempt=${budget.attempts} events=${events.map(e => e.id).join(",")}`);
          return true;
        });
        if (began && this.budgets[id] === budget) {
          budget.notBefore = ok ? 0 : this.now() + 60_000; this.save();
        }
      } catch (error) { console.error(`[continuation] ${id}:`, String(error)); }
      finally { this.active.delete(id); }
    }));
  }
}
