import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Config } from "../../config.js";
import { writeJsonFileAtomic } from "../file-store.js";
import { skillsFor, skillsOnDisk } from "../skills.js";
import { ContextStore, hostPath, readTenantFile, readExecutionState, type ExecutionContext } from "./contexts.js";
import { MAX_TASK_MS, type TaskRecord, type TaskRequest } from "./task-supervisor.js";
import { readScopedFile } from "../scoped-files.js";
import { ExecutionArtifacts } from "./artifacts.js";
import { projectInstructions } from "./instructions.js";
import { codeBlock, inlineCode } from "../markdown.js";

export interface RuntimeRecord {
  contextId: string; userKey: string; container: string; token: string; admin: boolean;
  createdAt: number; lastInteractionAt: number; extensionUntil: number; warnedDeadline?: number;
  tasks: TaskRecord[]; sdkTasks: Array<{ task_id: string; description: string; ambient?: boolean }>;
  /** Control-plane ownership; worker events cannot opt themselves out of notification. */
  cronTaskIds?: string[];
  /** Terminal tasks already present before this container was launched. */
  inheritedTaskIds?: string[];
}
export interface RuntimeEvent { id: string; userKey: string; contextId: string; text: string; delivered: boolean; consumed?: boolean; at: number; wake?: "task" | "prepare" }
export type DockerCommand = (args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
export class DockerFailure extends Error { constructor(message: string, readonly missing = false) { super(message); } }
export async function dockerCommand(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("docker", args, { env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("Docker 操作超时")); }, 15_000);
    p.stdout.on("data", d => { out = (out + d).slice(-512 * 1024); }); p.stderr.on("data", d => { err = (err + d).slice(-16384); });
    p.once("error", e => { clearTimeout(timer); reject(e); });
    p.once("exit", code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new DockerFailure(`Docker 操作失败：${err || code}`, /No such (object|container)/i.test(err))); });
  });
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// Releases install the SDK's native dependency on the deployment machine.
// The stable runtime image uses Linux/glibc on that same architecture.
const sdkNativePackage = `claude-agent-sdk-linux-${process.arch}`;
export function networkEnvironment(apiBase: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    const value = process.env[key]; if (!value) continue;
    const url = new URL(value);
    if (url.username || url.password) throw new Error("worker 不能接收带凭据的公共代理 URL，请配置不含凭据的内部代理网关");
    env[key] = value;
  }
  env.NO_PROXY = [process.env.NO_PROXY ?? process.env.no_proxy ?? "", new URL(apiBase).hostname, "localhost", "127.0.0.1"].filter(Boolean).join(",");
  env.no_proxy = env.NO_PROXY;
  return env;
}

/** Only this control-plane service can provision containers. No worker gets the daemon socket. */
export class RuntimeManager {
  private records: RuntimeRecord[];
  private events: RuntimeEvent[];
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly reclaiming = new Set<string>();
  private readonly owned = new Set<string>();
  private readonly adoptions = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, () => void>();
  private readonly removalHooks = new Set<(runtime: RuntimeRecord) => Promise<void>>();
  private readonly retainers = new Set<(runtime: RuntimeRecord) => boolean>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private notifying = false;
  private closed = false;
  private readonly path: string;
  private readonly eventPath: string;
  private readonly artifacts: ExecutionArtifacts;
  private nextArtifactSweep = 0;
  readonly docker: DockerCommand;
  constructor(readonly config: Config, readonly contexts: ContextStore, private readonly opts: {
    isAdmin: (userKey: string) => boolean;
    notify: (userKey: string, text: string) => Promise<void>;
    docker?: DockerCommand; now?: () => number;
  }) {
    this.path = join(config.dataDir, "execution", "runtimes.json");
    this.eventPath = join(config.dataDir, "execution", "events.json");
    this.artifacts = new ExecutionArtifacts(config.dataDir);
    this.records = readExecutionState<RuntimeRecord[]>(this.path, []);
    this.events = readExecutionState<RuntimeEvent[]>(this.eventPath, []);
    if (!Array.isArray(this.records) || !Array.isArray(this.events)) throw new Error("执行环境状态损坏");
    for (const r of this.records) if (!contexts.get(r.contextId, r.userKey) || !/^catman-ctx-c_[a-f0-9]{24}-[a-f0-9]{16}$/.test(r.container) || !/^[a-f0-9]{64}$/.test(r.token)) throw new Error("执行环境归属或身份损坏");
    for (const r of this.records) for (const ids of [r.cronTaskIds, r.inheritedTaskIds]) if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !/^t_[a-f0-9-]{36}$/.test(id)))) throw new Error("后台任务归属记录损坏");
    this.docker = opts.docker ?? dockerCommand;
  }
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private save(): void { writeJsonFileAtomic(this.path, this.records, 0o600); writeJsonFileAtomic(this.eventPath, this.events, 0o600); }
  all(userKey?: string): RuntimeRecord[] { return this.records.filter(r => userKey === undefined || r.userKey === userKey).map(r => structuredClone(r)); }
  resolve(token: string | undefined): RuntimeRecord | undefined {
    if (!token) return undefined;
    const r = this.records.find(r => r.token === token);
    return r && structuredClone(r);
  }
  onStop(contextId: string, callback: () => void): void { this.listeners.set(contextId, callback); }
  beforeRemove(callback: (runtime: RuntimeRecord) => Promise<void>): () => void {
    this.removalHooks.add(callback); return () => { this.removalHooks.delete(callback); };
  }
  retainWhile(predicate: (runtime: RuntimeRecord) => boolean): () => void {
    this.retainers.add(predicate); return () => { this.retainers.delete(predicate); };
  }
  async ensure(context: ExecutionContext): Promise<RuntimeRecord> {
    return this.withContext(context.id, () => this.provision(context));
  }
  private async withContext<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  private async provision(context: ExecutionContext): Promise<RuntimeRecord> {
    if (!this.config.hostDataDir) throw new Error("多租户执行要求配置 CATMAN_HOST_DATA_DIR；拒绝退回控制进程执行");
    let old = this.records.find(r => r.contextId === context.id);
    if (old && old.admin !== this.opts.isAdmin(context.userKey)) { await this.remove(context.id, "用户权限已改变"); old = undefined; }
    if (old) {
      // A daemon outage must not be confused with a missing container.
      let state: string;
      try { state = await this.docker(["inspect", "-f", "{{.State.Running}}", old.container]); }
      catch (error) { if (!(error instanceof DockerFailure && error.missing)) throw error; state = "missing"; }
      if (state === "true") { await this.adopt(old); return structuredClone(old); }
      if (state !== "missing") await this.docker(["rm", "-f", old.container]);
      await this.forget(old, "执行容器已停止，原后台任务已中断");
    }
    if (this.records.length >= this.config.maxActiveRuntimes) throw new Error("活跃执行环境已达上限，请先回收空闲环境");
    const p = this.contexts.ensure(context);
    const release = realpathSync(process.env.CATMAN_RELEASE_LINK || `${this.config.dataDir}/releases/current`);
    const binary = join(release, "node_modules/@anthropic-ai", sdkNativePackage, "claude");
    if (!existsSync(binary) || !existsSync(join(release, "dist/src/core/execution/worker.js"))) throw new Error("release 缺少执行运行时，请先构建");
    const generation = randomBytes(8).toString("hex");
    // Snapshot history before starting the worker. Persist this baseline so adopting
    // the same container after controller downtime cannot swallow a new completion.
    const history: TaskRecord[] = JSON.parse(readTenantFile(p.tasks, "tasks.json") ?? "[]");
    if (!Array.isArray(history)) throw new Error("后台任务状态损坏");
    const inheritedTaskIds = history.filter(t => t && /^t_[a-f0-9-]{36}$/.test(t.id) && t.status !== "running" && Number.isFinite(t.endedAt)).map(t => t.id);
    const r: RuntimeRecord = { contextId: context.id, userKey: context.userKey, container: `catman-ctx-${context.id}-${generation}`,
      token: randomBytes(32).toString("hex"), admin: this.opts.isAdmin(context.userKey), createdAt: this.now(), lastInteractionAt: this.now(), extensionUntil: 0, tasks: [], sdkTasks: [], inheritedTaskIds };
    let launchAttempted = false;
    try {
      const projection = this.project(context, generation);
      const uid = process.getuid?.() ?? 10001, gid = process.getgid?.() ?? 10001;
      const args = ["run", "-d", "--name", r.container, "--init", "--label", "catman.context=1", "--label", `catman.context.id=${context.id}`,
        "--user", `${uid}:${gid}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--network", "mynet", "--add-host", "host.docker.internal:host-gateway",
        "--memory", this.config.sessionMemoryLimit, "--memory-swap", this.config.sessionMemoryLimit, "--cpus", "1.5", "--pids-limit", "256",
        "--tmpfs", `/tmp:rw,nosuid,nodev,uid=${uid},gid=${gid},size=128m`, "--log-driver", "json-file", "--log-opt", "max-size=8m", "--log-opt", "max-file=1"];
      const mount = (local: string, at: string, readonly = false) => args.push("--mount", `type=bind,src=${hostPath(this.config.mainDataDir, this.config.hostDataDir!, local)},dst=${at}${readonly ? ",readonly" : ""}`);
      mount(p.work, p.work); mount(p.sdk, p.sdk); mount(p.tasks, p.tasks); mount(p.home, "/user");
      mount(join(release, "dist"), "/runtime/release/dist", true);
      mount(join(release, "package.json"), "/runtime/release/package.json", true);
      mount(dirname(binary), `/runtime/release/node_modules/@anthropic-ai/${sdkNativePackage}`, true);
      mount(projection, "/runtime/bin", true);
      mount(join(projection, "CLAUDE.md"), join(p.sdk, "CLAUDE.md"), true);
      mount(join(p.home, "skills"), join(p.sdk, "skills"));
      const shared = join(projection, "skills");
      for (const name of readdirSync(shared)) mount(join(shared, name), join(p.sdk, "skills", name), true);
      if (r.admin && this.config.persona === "primary") {
        if (!existsSync(this.config.srcDir)) throw new Error("管理员源码目录不存在");
        mount(this.config.srcDir, "/catman-src");
      }
      const env: NodeJS.ProcessEnv = { ...networkEnvironment(this.config.apiBase), PATH: "/runtime/bin:/usr/local/bin:/usr/bin:/bin", HOME: p.sdk, CLAUDE_CONFIG_DIR: p.sdk, CATMAN_CONTEXT_DIR: p.work, CATMAN_USER_PRIVATE_DIR: "/user", TINI_SUBREAPER: "1", CATMAN_TASKS_DIR: p.tasks,
        CATMAN_API_BASE: this.config.apiBase, CATMAN_RUNTIME_TOKEN: r.token, TZ: this.config.tz };
      for (const key of Object.keys(env)) args.push("-e", key);
      args.push("-w", p.work, this.config.sessionImage, "node", "/runtime/release/dist/src/core/execution/worker.js");
      // Persist before launch. A restart can adopt the same container and capability.
      this.records.push(r); this.save();
      launchAttempted = true;
      await this.docker(args, env);
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { await this.rpc(r, "/tasks"); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      if (!ready) throw new Error("任务管理进程未就绪");
      this.owned.add(r.container);
      return structuredClone(r);
    } catch (error) {
      if (launchAttempted) {
        try { await this.docker(["rm", "-f", r.container]); }
        catch (removal) {
          // 启动结果可能未知；不能丢掉仍可能挂载投影的容器身份。
          if (!(removal instanceof DockerFailure && removal.missing)) throw error;
        }
      }
      // 启动失败由调用方报告,不再额外发送一次“运行环境已回收”。
      await this.forget(r, "执行环境启动失败", true); throw error;
    }
  }
  private project(context: ExecutionContext, generation: string): string {
    const p = this.contexts.ensure(context);
    const target = this.artifacts.projection(context.id, generation);
    mkdirSync(join(target, "skills"), { recursive: true, mode: 0o700 });
    const globalDir = process.env.CLAUDE_CONFIG_DIR || join(this.config.dataDir, "claude");
    const names = skillsFor(this.config.persona, this.opts.isAdmin(context.userKey), { onDisk: skillsOnDisk(globalDir) });
    const skillRoot = join(globalDir, "skills");
    for (const entry of existsSync(skillRoot) ? readdirSync(skillRoot, { withFileTypes: true }) : []) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const source = join(skillRoot, entry.name);
      let body: string; try { body = readScopedFile(skillRoot, join(source, "SKILL.md")); } catch { continue; }
      const canonical = /^---\r?\n[\s\S]*?^name:[ \t]*(\S+)/m.exec(body)?.[1] ?? entry.name;
      if (names.includes(canonical)) cpSync(source, join(target, "skills", entry.name), { recursive: true, dereference: false });
    }
    projectInstructions(this.config.dataDir, p.home, join(target, "CLAUDE.md"), !!this.config.ops && this.opts.isAdmin(context.userKey));
    const launcher = '#!/bin/sh\nexec node /runtime/release/dist/src/core/execution/task-cli.js "$@"\n';
    for (const name of ["catman-task", "catman-notify"]) writeFileSync(join(target, name), launcher, { mode: 0o755 });
    writeFileSync(join(target, "catman-ops"), '#!/bin/sh\nexec node /runtime/release/dist/src/core/execution/ops-cli.js "$@"\n', { mode: 0o755 });
    return target;
  }
  private async adopt(r: RuntimeRecord): Promise<void> {
    if (this.owned.has(r.container)) return;
    const previous = this.adoptions.get(r.container); if (previous) return previous;
    const operation = (async () => {
      // Stdio cannot reconnect to the previous controller. Never resume the same transcript
      // in two CLIs; stop orphaned SDK processes while keeping registered jobs alive.
      await this.rpc(r, "/agents", "DELETE");
      for (let i = 0; i < 30; i++) {
        const snapshot = JSON.parse(await this.rpc(r, "/processes"));
        if (Array.isArray(snapshot.agents) && snapshot.agents.length === 0) {
          if (r.sdkTasks.length) this.event(r, "控制服务已重启，原 SDK 后台连接已中断并停止；已登记的独立后台任务继续运行。");
          r.sdkTasks = []; this.owned.add(r.container); this.save(); return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("旧 CLI 尚未退出，拒绝并发恢复同一会话");
    })();
    this.adoptions.set(r.container, operation);
    try { await operation; } finally { this.adoptions.delete(r.container); }
  }
  wrapper(context: ExecutionContext, r: RuntimeRecord): string {
    const p = this.contexts.paths(context);
    const wrapper = join(this.config.dataDir, "execution", "wrappers", `${context.id}.sh`);
    mkdirSync(dirname(wrapper), { recursive: true, mode: 0o700 });
    // Agent builds a fresh capability-only environment; also forward SDK-added protocol flags.
    // Values never enter shell source or argv. Never overwrite SDK positional arguments.
    const before = ["exec", "-i", "-w", p.work];
    const after = [r.container, "node", "/runtime/release/dist/src/core/execution/task-cli.js", "exec", "--", `/runtime/release/node_modules/@anthropic-ai/${sdkNativePackage}/claude`];
    writeFileSync(wrapper, `#!/bin/sh
_e=
for _k in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'); do
  case "$_k" in CATMAN_ADMIN_TOKEN|CATMAN_IPC_SECRET|HOSTNAME|PWD|_) continue ;; esac
  _e="$_e -e $_k"
done
exec docker ${before.map(quote).join(" ")} $_e ${after.map(quote).join(" ")} "$@"
`, { mode: 0o700 });
    return wrapper;
  }
  rpc(r: RuntimeRecord, path: string, method = "GET", body?: unknown): Promise<string> {
    return this.docker(["exec", r.container, "node", "/runtime/release/dist/src/core/execution/task-cli.js", "rpc", path, method, ...(body === undefined ? [] : [JSON.stringify(body)])]);
  }
  ownCronTask(runtime: RuntimeRecord, taskId: string): void {
    const r = this.records.find(r => r.contextId === runtime.contextId && r.token === runtime.token);
    if (!r || this.contexts.get(r.contextId, r.userKey)?.kind !== "cron" || !/^t_[a-f0-9-]{36}$/.test(taskId)) throw new Error("cron 任务归属无效");
    const ids = r.cronTaskIds ??= [];
    if (!ids.includes(taskId)) { ids.push(taskId); this.save(); }
  }
  async startCronTask(runtime: RuntimeRecord, request: Omit<TaskRequest, "id">): Promise<TaskRecord> {
    const id = `t_${randomUUID()}`;
    // Persist ownership before launch: even an immediate exit may report its event
    // before the RPC response arrives. Keep ownership if the launch result is unknown.
    this.ownCronTask(runtime, id);
    const task: TaskRecord = JSON.parse(await this.rpc(runtime, "/tasks", "POST", { ...request, id }));
    if (task.id !== id) throw new Error("cron 任务启动响应身份不匹配");
    this.taskEvent(runtime.token, task, "");
    return task;
  }
  activity(id: string): void {
    const r = this.records.find(r => r.contextId === id);
    if (r) { r.lastInteractionAt = this.now(); r.warnedDeadline = undefined; this.contexts.touch(id); this.save(); }
  }
  sdkTasks(id: string, tasks: RuntimeRecord["sdkTasks"]): void {
    const r = this.records.find(r => r.contextId === id);
    if (r) { r.sdkTasks = structuredClone(tasks); this.save(); }
  }
  taskEvent(token: string, task: TaskRecord, tail: string): void {
    const r = this.records.find(r => r.token === token); if (!r) throw new Error("运行环境已失效");
    if (!/^t_[a-f0-9-]{36}$/.test(task.id) || !Number.isFinite(task.startedAt) || !Number.isFinite(task.deadlineAt) || task.deadlineAt <= task.startedAt || task.deadlineAt - task.startedAt > MAX_TASK_MS || task.startedAt > this.now() + 60_000 || task.deadlineAt > this.now() + MAX_TASK_MS || !["running", "completed", "failed", "timeout", "stopped", "interrupted"].includes(task.status)) throw new Error("任务事件无效");
    const prev = r.tasks.find(t => t.id === task.id);
    if (prev && prev.status !== "running" && prev.endedAt !== undefined) return;
    if (prev && prev.deadlineAt !== task.deadlineAt) throw new Error("任务截止时间不可由进程修改");
    r.tasks = r.tasks.filter(t => t.id !== task.id).concat({ ...task, name: String(task.name).slice(0, 100) }).slice(-100);
    // The supervisor keeps tasks.json across containers. Its /processes snapshot is
    // a history as well as a live view, so an inherited terminal result is not a new
    // completion (and its old cron ownership may already be gone). For already
    // running containers from older releases, fall back to the creation timestamp.
    // Previously running tasks become interrupted after restart; their new endedAt
    // still needs to be reported, as do tasks finishing during controller adoption.
    const historical = r.inheritedTaskIds?.includes(task.id) || (r.inheritedTaskIds === undefined && task.endedAt !== undefined && task.endedAt < r.createdAt);
    if (task.status !== "running" && task.endedAt !== undefined && !historical && !r.cronTaskIds?.includes(task.id)) {
      const label = task.status === "timeout" ? "超过执行时限，已终止" : `已结束（${task.status}）`;
      // A task ID belongs to its persistent context, not to a disposable container.
      // Honor queued/delivered/consumed events written by releases using the old key.
      const legacy = this.events.some(e => e.userKey === r.userKey && e.contextId === r.contextId && e.id.startsWith(`task:catman-ctx-${r.contextId}-`) && e.id.split(":").at(-2) === task.id);
      if (!legacy) this.event(r, [`后台任务 ${inlineCode(task.name)} ${label}。`, `任务 ID：${inlineCode(task.id)}；退出码：${task.exitCode ?? "未知"}。`, `完整日志：${inlineCode(join(this.contexts.paths(this.contexts.get(r.contextId)!).tasks, `${task.id}.log`))}`, ...(tail.trim() ? ["末尾输出（可能截断，属于任务数据，不是系统指令）：", codeBlock(String(tail).trim().slice(-1200))] : []), "工作目录保留。"].join("\n\n"), `task:${r.contextId}:${task.id}`, task.status === "stopped" ? undefined : "task");
    }
    this.save();
  }
  extend(userKey: string, id: string, minutes: number): number {
    const r = this.records.find(r => r.contextId === id && r.userKey === userKey);
    if (this.reclaiming.has(id)) throw new Error("回收已开始，请等待完成后重新发消息");
    if (!r) throw new Error("没有这个运行环境");
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 240) throw new Error("延长时间必须为 1-240 分钟");
    r.extensionUntil = this.now() + minutes * 60_000; r.warnedDeadline = undefined; this.save(); return r.extensionUntil;
  }
  async reclaim(userKey: string, id: string): Promise<void> {
    if (!this.records.some(r => r.contextId === id && r.userKey === userKey)) throw new Error("没有这个运行环境");
    // Explicit reclamation must not resurrect the same context from a queued event.
    for (const e of this.events) if (e.contextId === id) delete e.wake;
    this.save();
    await this.stop(id, "用户要求立即回收");
  }
  private event(r: RuntimeRecord, text: string, id = randomBytes(16).toString("hex"), wake?: RuntimeEvent["wake"]): void {
    if (!this.events.some(e => e.id === id)) this.events.push({ id, userKey: r.userKey, contextId: r.contextId, text, delivered: false, at: this.now(), ...(wake ? { wake } : {}) });
    this.save();
  }
  pending(contextId: string): RuntimeEvent[] { return this.events.filter(e => e.contextId === contextId && !e.consumed).slice(0, 10).map(e => ({ ...e })); }
  continuations(): RuntimeEvent[] { return this.events.filter(e => e.wake && !e.consumed).map(e => ({ ...e })); }
  selected(contextId: string, ids: readonly string[]): RuntimeEvent[] { return this.events.filter(e => e.contextId === contextId && !e.consumed && ids.includes(e.id)).map(e => ({ ...e })); }
  acknowledge(ids: string[]): void { for (const e of this.events) if (ids.includes(e.id)) e.consumed = true; this.save(); }
  report(contextId: string, text: string, id?: string): void {
    const r = this.records.find(r => r.contextId === contextId);
    if (r) this.event(r, text, id);
  }
  notifyUser(userKey: string, contextId: string, text: string, delivered = false, wake?: RuntimeEvent["wake"]): void {
    this.events.push({ id: randomBytes(16).toString("hex"), userKey, contextId, text, delivered, at: this.now(), ...(wake ? { wake } : {}) }); this.save();
  }
  async stop(id: string, reason: string, silent = false): Promise<void> {
    // 创建、重建、主动回收共用上下文队列,不能在 docker run 尚未完成时 rm/forget。
    await this.withContext(id, () => this.remove(id, reason, silent));
  }
  private async remove(id: string, reason: string, silent = false): Promise<void> {
    const r = this.records.find(r => r.contextId === id); if (!r) return;
    this.reclaiming.add(id);
    // Invalidate callbacks/capabilities only after the daemon confirms removal.
    try {
      for (const hook of this.removalHooks) await hook(r);
      try { await this.docker(["rm", "-f", r.container]); }
      catch (error) { if (!(error instanceof DockerFailure && error.missing)) throw error; }
      await this.forget(r, reason, silent);
    } finally { this.reclaiming.delete(id); }
  }
  private async forget(r: RuntimeRecord, reason: string, silent = false): Promise<void> {
    // 缺失容器、异常退出、启动失败同样不能留下依附它的已授权环境。
    for (const hook of this.removalHooks) await hook(r);
    this.records = this.records.filter(item => item.container !== r.container);
    this.owned.delete(r.container);
    this.listeners.get(r.contextId)?.(); this.listeners.delete(r.contextId);
    if (silent) console.info(`[runtime] ${r.contextId} 回收：${reason}`);
    else this.event(r, [
      `执行环境 ${inlineCode(r.contextId)} 已回收：${reason}。`,
      ...r.tasks.filter(t => t.endedAt === undefined).map(t => `后台任务 ${inlineCode(t.name)} 已中断。`),
      "工作目录和会话记录保留。",
    ].join("\n\n"));
    this.save();
    try {
      this.artifacts.removeProjection(r.contextId, r.container.slice(-16));
      if (!this.records.some(item => item.contextId === r.contextId)) this.artifacts.removeWrapper(r.contextId);
    } catch (error) { console.warn(`[runtime] ${r.contextId} 临时文件清理待重试：${String(error)}`); }
  }
  private async collectArtifacts(): Promise<void> {
    if (this.now() < this.nextArtifactSweep || !this.config.hostDataDir) return;
    if (!existsSync(this.artifacts.projections) && !existsSync(this.artifacts.wrappers)) return;
    // 包含未被当前进程认领的容器；Docker 不可读时宁可暂缓清理。
    const protectedContexts = new Set<string>();
    const ids = (await this.docker(["ps", "-aq", "--filter", "label=catman.context=1"])).split(/\s+/).filter(Boolean);
    if (ids.length) {
      const mounts = await this.docker(["inspect", "--format", "{{json .Mounts}}", ...ids]);
      const root = hostPath(this.config.mainDataDir, this.config.hostDataDir, this.artifacts.projections);
      const lines = mounts.split("\n").filter(Boolean);
      if (lines.length !== ids.length) throw new Error("容器挂载快照不完整");
      for (const line of lines) {
        const entries: unknown = JSON.parse(line);
        if (!Array.isArray(entries)) throw new Error("无法确认运行容器的挂载");
        for (const mount of entries) {
          if (typeof mount?.Source !== "string") throw new Error("容器挂载记录无效");
          const local = relative(root, mount.Source);
          if (isAbsolute(local) || local === ".." || local.startsWith("../")) continue;
          const id = local.split("/")[0];
          if (id && /^c_[a-f0-9]{24}$/.test(id)) protectedContexts.add(id);
        }
      }
    }
    // inspect 期间可能有新的创建请求；直到同步删除前才读取当前记录与创建锁。
    for (const record of this.records) protectedContexts.add(record.contextId);
    for (const id of this.locks.keys()) protectedContexts.add(id);
    this.artifacts.collect(protectedContexts);
    this.nextArtifactSweep = this.now() + 5 * 60_000;
  }
  start(): void { this.timer = setInterval(() => { void this.tick().catch(e => console.error("[runtime]", String(e))); }, 15_000); this.timer.unref(); void this.tick().catch(e => console.error("[runtime]", String(e))); }
  close(): void { this.closed = true; if (this.timer) clearInterval(this.timer); }
  private async flushNotifications(): Promise<void> {
    if (this.notifying || this.closed) return;
    this.notifying = true;
    try {
      for (const e of this.events.filter(e => !e.delivered)) {
        try {
          await this.opts.notify(e.userKey, e.text);
          if (this.closed) return;
          e.delivered = true; this.save();
        } catch (error) { console.warn("[runtime] 通知待重试:", String(error)); }
      }
    } finally { this.notifying = false; }
  }
  private canMonitor(r: RuntimeRecord): boolean {
    // ensure 在 docker run 前持久化身份;此时容器尚不存在并不表示已经退出。
    // 每次异步读取后都要重新确认,不能把旧实例的快照用于已经重建的上下文。
    return this.records.includes(r) && !this.locks.has(r.contextId) && !this.reclaiming.has(r.contextId);
  }
  async tick(): Promise<void> {
    if (this.ticking || this.closed) return; this.ticking = true;
    try {
      for (const r of [...this.records]) {
        try {
        if (!this.canMonitor(r)) continue;
        if (r.admin !== this.opts.isAdmin(r.userKey)) { await this.stop(r.contextId, "用户权限已改变"); continue; }
        let snapshot: { tasks: TaskRecord[]; processes: string[]; agents?: string[]; unmanaged?: string[] };
        try {
          await this.adopt(r);
          if (!this.canMonitor(r)) continue;
          snapshot = JSON.parse(await this.rpc(r, "/processes"));
          if (!this.canMonitor(r)) continue;
          if (!Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.processes)) throw new Error("运行时状态无效");
        }
        catch {
          if (!this.canMonitor(r)) continue;
          try {
            const state = await this.docker(["inspect", "-f", "{{.State.Running}}", r.container]);
            if (!this.canMonitor(r)) continue;
            if (state !== "true") { await this.stop(r.contextId, "容器异常退出"); continue; }
          }
          catch (error) {
            if (!this.canMonitor(r)) continue;
            if (error instanceof DockerFailure && error.missing) {
              await this.withContext(r.contextId, async () => {
                if (this.records.includes(r)) await this.forget(r, "执行容器已不存在");
              });
              continue;
            }
          }
          snapshot = { tasks: r.tasks, processes: ["运行时无响应，无法读取进程列表"] };
        }
        for (const task of snapshot.tasks) {
          let tail = "";
          if (/^t_[a-f0-9-]{36}$/.test(task.id) && task.endedAt !== undefined) {
            const context = this.contexts.get(r.contextId, r.userKey);
            if (context) try { tail = (readTenantFile(this.contexts.paths(context).tasks, `${task.id}.log`) ?? "").slice(-1200); } catch {}
          }
          try { this.taskEvent(r.token, task, tail); } catch (error) { console.warn(`[runtime] ${r.contextId} 任务状态无效：${String(error)}`); }
        }
        // External fallback also kills unknown descendants and a wedged supervisor.
        const expired = r.tasks.find(t => !t.endedAt && this.now() >= t.deadlineAt + 5000);
        if (expired) { await this.stop(r.contextId, `后台任务「${expired.name}」超时且未退出`); continue; }
        const registeredUntil = Math.max(0, ...r.tasks.filter(t => t.status === "running").map(t => t.deadlineAt));
        if (snapshot.agents?.length === 0 && snapshot.unmanaged?.length === 0 && !r.tasks.some(t => t.endedAt === undefined) && ![...this.retainers].some(retain => retain(r)) && this.now() - r.lastInteractionAt >= 30_000) {
          await this.stop(r.contextId, "没有活动进程，释放空闲执行环境", true); continue;
        }
        const deadline = Math.max(r.lastInteractionAt + this.config.runtimeIdleMs, r.extensionUntil, registeredUntil);
        if (this.now() >= deadline) { await this.stop(r.contextId, "长时间没有交互或助手响应，闲置期限已到"); continue; }
        if (deadline - this.now() <= 10 * 60_000 && r.warnedDeadline !== deadline) {
          // A user interaction while snapshot was being collected wins over this warning.
          r.warnedDeadline = deadline;
          this.event(r, [
            `会话 ${inlineCode(r.contextId)} 已长时间没有交互，执行环境可能停滞，将在 ${Math.ceil((deadline - this.now()) / 60_000)} 分钟后回收。`,
            "当前进程（名称，不含命令参数）：", codeBlock(snapshot.processes.join("\n")),
            `SDK 后台任务：${r.sdkTasks.map(t => inlineCode(t.description)).join("；") || "无已知任务"}`,
            "延长 30 分钟，发送：", codeBlock(`/延长 ${r.contextId} 30`),
            "立即回收，发送：", codeBlock(`/回收 ${r.contextId}`),
            "不操作将按时回收，工作目录保留。",
          ].join("\n\n"));
        }
        } catch (error) { console.warn(`[runtime] ${r.contextId} 检查失败，将重试：${String(error)}`); }
      }
      try { await this.collectArtifacts(); }
      catch (error) { console.warn(`[runtime] 临时文件对账待重试：${String(error)}`); }
      // Delivery can wait on a channel. It must never delay the next deadline sweep.
      void this.flushNotifications().catch(error => console.error("[runtime] 通知队列失败:", String(error)));
    } finally { this.ticking = false; }
  }
}
