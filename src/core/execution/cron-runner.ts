import { join } from "node:path";
import { ContextStore, readTenantFile } from "./contexts.js";
import { RuntimeManager } from "./runtime.js";
import type { CronStore } from "../cron/store.js";
import type { LaunchSpec, PollResult, ScriptRunner } from "../cron/runner.js";
import type { TaskRecord } from "./task-supervisor.js";
import { readJsonFile, writeJsonFileAtomic } from "../file-store.js";

interface Handle { run: string; contextId: string; taskId: string; userKey: string }
/** Both script and agent cron use the owner's persistent cron context and home. */
export class ContextScriptRunner implements ScriptRunner {
  private handles: Handle[];
  private readonly path: string;
  constructor(private readonly contexts: ContextStore, private readonly runtimes: RuntimeManager, private readonly jobs: CronStore) {
    this.path = join(contexts.root, "execution", "cron-handles.json");
    this.handles = readJsonFile<Handle[]>(this.path, []);
    // Also claim in-flight handles from a release that predated explicit ownership.
    for (const handle of this.handles) {
      const runtime = runtimes.all(handle.userKey).find(r => r.contextId === handle.contextId);
      if (runtime) runtimes.ownCronTask(runtime, handle.taskId);
    }
  }
  async launch(spec: LaunchSpec): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const job = this.jobs.get(spec.jobId); if (!job) throw new Error("cron 任务不存在");
      const context = this.contexts.cron(job.userKey, job.id);
      const runtime = await this.runtimes.ensure(context);
      const task = await this.runtimes.startCronTask(runtime, {
        name: job.name, cmd: [...spec.cmd], env: spec.env, cwd: this.contexts.paths(context).work, timeoutMs: job.timeoutMs,
      });
      this.handles.push({ run: spec.container, contextId: context.id, taskId: task.id, userKey: job.userKey }); this.save();
      return { ok: true };
    } catch (error) { return { ok: false, error: String(error) }; }
  }
  async poll(run: string): Promise<PollResult> {
    const handle = this.handles.find(h => h.run === run); if (!handle) return { state: "gone" };
    const runtime = this.runtimes.all(handle.userKey).find(r => r.contextId === handle.contextId);
    // 容器消失不等于任务没跑完:执行环境有空闲回收(15 秒巡检,任务一结束就可能被删),
    // 而调度器 30 秒才收一次结果,慢一点也不稀奇。supervisor 会把终态写进 tasks.json,
    // 容器已经不在时改读盘上这份,否则一次成功的执行会被记成 interrupted。
    const tasks: TaskRecord[] = runtime
      ? JSON.parse(await this.runtimes.rpc(runtime, "/tasks"))
      : this.persistedTasks(handle);
    const task = tasks.find(t => t.id === handle.taskId);
    if (!task) return { state: "gone" };
    // 还挂着 running 却没有容器:现场确实丢了,让调度器照实记。
    if (task.status === "running") return runtime ? { state: "running" } : { state: "gone" };
    return { state: "exited", exitCode: task.status === "completed" ? 0 : task.exitCode || 1 };
  }
  private persistedTasks(handle: Handle): TaskRecord[] {
    const c = this.contexts.get(handle.contextId, handle.userKey); if (!c) return [];
    return readJsonFile<TaskRecord[]>(join(this.contexts.paths(c).tasks, "tasks.json"), []);
  }
  async logs(run: string): Promise<string> {
    const handle = this.handles.find(h => h.run === run); if (!handle) return "";
    const c = this.contexts.get(handle.contextId, handle.userKey); if (!c) return "";
    return readTenantFile(this.contexts.paths(c).tasks, `${handle.taskId}.log`) ?? "";
  }
  async stop(run: string): Promise<void> {
    const h = this.handles.find(h => h.run === run); if (!h) return;
    const runtime = this.runtimes.all(h.userKey).find(r => r.contextId === h.contextId);
    if (runtime) await this.runtimes.rpc(runtime, `/tasks/${h.taskId}`, "DELETE");
  }
  async remove(run: string): Promise<void> { this.handles = this.handles.filter(h => h.run !== run); this.save(); }
  private save(): void { writeJsonFileAtomic(this.path, this.handles); }
}
