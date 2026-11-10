/** Execution transport contract. Handles refer to tasks, never arbitrary Docker resources. */
export interface LaunchSpec {
  readonly container: string;
  readonly jobId: string;
  readonly userKey: string;
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}
export type PollResult = { readonly state: "running" } | { readonly state: "exited"; readonly exitCode: number } | { readonly state: "gone" };
export interface ScriptRunner {
  launch(spec: LaunchSpec): Promise<{ ok: true } | { ok: false; error: string }>;
  poll(handle: string): Promise<PollResult>;
  logs(handle: string): Promise<string>;
  stop(handle: string): Promise<void>;
  remove(handle: string): Promise<void>;
  reapOrphans?(alive: ReadonlySet<string>): Promise<number>;
}
export function containerNameFor(jobId: string, runId: string): string { return `cron-${jobId}-${runId}`; }
