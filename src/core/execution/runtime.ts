import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../../config.js";
import { writeJsonFileAtomic } from "../file-store.js";
import { skillsFor, skillsOnDisk } from "../skills.js";
import { ContextStore, hostPath, readTenantFile, readExecutionState, type ExecutionContext } from "./contexts.js";
import { MAX_TASK_MS, type TaskRecord } from "./task-supervisor.js";
import { readScopedFile } from "../scoped-files.js";

export interface RuntimeRecord {
  contextId: string; userKey: string; container: string; token: string; admin: boolean;
  createdAt: number; lastInteractionAt: number; extensionUntil: number; warnedDeadline?: number;
  tasks: TaskRecord[]; sdkTasks: Array<{ task_id: string; description: string; ambient?: boolean }>;
}
export interface RuntimeEvent { id: string; userKey: string; contextId: string; text: string; delivered: boolean; consumed?: boolean; at: number }
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
  private readonly stops = new Map<string, Promise<void>>();
  private readonly owned = new Set<string>();
  private readonly adoptions = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, () => void>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private notifying = false;
  private closed = false;
  private readonly path: string;
  private readonly eventPath: string;
  readonly docker: DockerCommand;
  constructor(readonly config: Config, readonly contexts: ContextStore, private readonly opts: {
    isAdmin: (userKey: string) => boolean;
    notify: (userKey: string, text: string) => Promise<void>;
    docker?: DockerCommand; now?: () => number;
  }) {
    this.path = join(config.dataDir, "execution", "runtimes.json");
    this.eventPath = join(config.dataDir, "execution", "events.json");
    this.records = readExecutionState<RuntimeRecord[]>(this.path, []);
    this.events = readExecutionState<RuntimeEvent[]>(this.eventPath, []);
    if (!Array.isArray(this.records) || !Array.isArray(this.events)) throw new Error("执行环境状态损坏");
    for (const r of this.records) if (!contexts.get(r.contextId, r.userKey) || !/^catman-ctx-c_[a-f0-9]{24}-[a-f0-9]{16}$/.test(r.container) || !/^[a-f0-9]{64}$/.test(r.token)) throw new Error("执行环境归属或身份损坏");
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
  async ensure(context: ExecutionContext): Promise<RuntimeRecord> {
    const previous = this.locks.get(context.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.provision(context));
    this.locks.set(context.id, next);
    try { return await next; } finally { if (this.locks.get(context.id) === next) this.locks.delete(context.id); }
  }
  private async provision(context: ExecutionContext): Promise<RuntimeRecord> {
    await this.stops.get(context.id);
    if (!this.config.hostDataDir) throw new Error("多租户执行要求配置 CATMAN_HOST_DATA_DIR；拒绝退回控制进程执行");
    let old = this.records.find(r => r.contextId === context.id);
    if (old && old.admin !== this.opts.isAdmin(context.userKey)) { await this.stop(context.id, "用户权限已改变"); old = undefined; }
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
    const projection = this.project(context);
    const generation = randomBytes(8).toString("hex");
    const r: RuntimeRecord = { contextId: context.id, userKey: context.userKey, container: `catman-ctx-${context.id}-${generation}`,
      token: randomBytes(32).toString("hex"), admin: this.opts.isAdmin(context.userKey), createdAt: this.now(), lastInteractionAt: this.now(), extensionUntil: 0, tasks: [], sdkTasks: [] };
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
    try {
      await this.docker(args, env);
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { await this.rpc(r, "/tasks"); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      if (!ready) throw new Error("任务管理进程未就绪");
      this.owned.add(r.container);
      return structuredClone(r);
    } catch (error) { try { await this.docker(["rm", "-f", r.container]); } catch {} await this.forget(r, "执行环境启动失败"); throw error; }
  }
  private project(context: ExecutionContext): string {
    const p = this.contexts.ensure(context);
    const target = join(this.config.dataDir, "execution", "projections", context.id, randomBytes(8).toString("hex"));
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
    const globalInstructions = join(this.config.dataDir, "shared", "CLAUDE.md");
    const common = existsSync(globalInstructions) ? readFileSync(globalInstructions, "utf8") : "";
    const personal = readTenantFile(p.home, "CLAUDE.md") ?? "";
    writeFileSync(join(target, "CLAUDE.md"), `${common}\n\n${personal}\n\n## 执行环境\n默认把产物写在当前 workspace。个人持久文件和 skill 放 /user。后台命令必须通过 catman-task run --timeout <秒> -- <命令> 登记；最长 86400 秒。长期服务需要部署。\n`, { mode: 0o600 });
    const launcher = '#!/bin/sh\nexec node /runtime/release/dist/src/core/execution/task-cli.js "$@"\n';
    for (const name of ["catman-task", "catman-notify"]) writeFileSync(join(target, name), launcher, { mode: 0o755 });
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
    if (task.status !== "running" && task.endedAt !== undefined) {
      const label = task.status === "timeout" ? "超过执行时限，已终止" : `已结束（${task.status}）`;
      this.event(r, `后台任务「${task.name}」${label}。\n${String(tail).slice(-1200)}\n工作目录保留。`, `task:${r.container}:${task.id}:${task.status}`);
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
    await this.stop(id, "用户要求立即回收");
  }
  private event(r: RuntimeRecord, text: string, id = randomBytes(16).toString("hex")): void {
    if (!this.events.some(e => e.id === id)) this.events.push({ id, userKey: r.userKey, contextId: r.contextId, text, delivered: false, at: this.now() });
    this.save();
  }
  pending(contextId: string): RuntimeEvent[] { return this.events.filter(e => e.contextId === contextId && !e.consumed).slice(0, 10).map(e => ({ ...e })); }
  acknowledge(ids: string[]): void { for (const e of this.events) if (ids.includes(e.id)) e.consumed = true; this.save(); }
  report(contextId: string, text: string, id?: string): void {
    const r = this.records.find(r => r.contextId === contextId);
    if (r) this.event(r, text, id);
  }
  notifyUser(userKey: string, contextId: string, text: string): void {
    this.events.push({ id: randomBytes(16).toString("hex"), userKey, contextId, text, delivered: false, at: this.now() }); this.save();
  }
  async stop(id: string, reason: string, silent = false): Promise<void> {
    const previous = this.stops.get(id); if (previous) return previous;
    const r = this.records.find(r => r.contextId === id); if (!r) return;
    this.reclaiming.add(id);
    // Invalidate callbacks/capabilities only after the daemon confirms removal.
    const stopping = (async () => {
      try { await this.docker(["rm", "-f", r.container]); }
      catch (error) { if (!(error instanceof DockerFailure && error.missing)) throw error; }
      await this.forget(r, reason, silent);
    })();
    this.stops.set(id, stopping);
    try { await stopping; }
    finally { this.reclaiming.delete(id); this.stops.delete(id); }
  }
  private async forget(r: RuntimeRecord, reason: string, silent = false): Promise<void> {
    this.records = this.records.filter(item => item.container !== r.container);
    this.owned.delete(r.container);
    this.listeners.get(r.contextId)?.(); this.listeners.delete(r.contextId);
    if (silent) console.info(`[runtime] ${r.contextId} 回收：${reason}`);
    else this.event(r, `执行环境 ${r.contextId} 已回收：${reason}。\n${r.tasks.filter(t => t.endedAt === undefined).map(t => `后台任务「${t.name}」已中断`).join("\n")}\n工作目录和会话记录保留。`);
    this.save();
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
  async tick(): Promise<void> {
    if (this.ticking || this.closed) return; this.ticking = true;
    try {
      for (const r of [...this.records]) {
        try {
        if (r.admin !== this.opts.isAdmin(r.userKey)) { await this.stop(r.contextId, "用户权限已改变"); continue; }
        let snapshot: { tasks: TaskRecord[]; processes: string[]; agents?: string[]; unmanaged?: string[] };
        try {
          await this.adopt(r); snapshot = JSON.parse(await this.rpc(r, "/processes"));
          if (!Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.processes)) throw new Error("运行时状态无效");
        }
        catch {
          try { if (await this.docker(["inspect", "-f", "{{.State.Running}}", r.container]) !== "true") { await this.forget(r, "容器异常退出"); continue; } }
          catch (error) { if (error instanceof DockerFailure && error.missing) { await this.forget(r, "执行容器已不存在"); continue; } }
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
        if (snapshot.agents?.length === 0 && snapshot.unmanaged?.length === 0 && !r.tasks.some(t => t.endedAt === undefined) && this.now() - r.lastInteractionAt >= 30_000) {
          await this.stop(r.contextId, "没有活动进程，释放空闲执行环境", true); continue;
        }
        const deadline = Math.max(r.lastInteractionAt + this.config.runtimeIdleMs, r.extensionUntil, registeredUntil);
        if (this.now() >= deadline) { await this.stop(r.contextId, "长时间没有交互或助手响应，闲置期限已到"); continue; }
        if (deadline - this.now() <= 10 * 60_000 && r.warnedDeadline !== deadline) {
          // A user interaction while snapshot was being collected wins over this warning.
          r.warnedDeadline = deadline;
          this.event(r, `会话 ${r.contextId} 已长时间没有交互，执行环境可能停滞，将在 ${Math.ceil((deadline - this.now()) / 60_000)} 分钟后回收。\n当前进程（名称，不含命令参数）：\n${snapshot.processes.join("\n")}\nSDK 后台任务：${r.sdkTasks.map(t => t.description).join("；") || "无已知任务"}\n延长 30 分钟：/延长 ${r.contextId} 30\n立即回收：/回收 ${r.contextId}\n不操作将按时回收，工作目录保留。`);
        }
        } catch (error) { console.warn(`[runtime] ${r.contextId} 检查失败，将重试：${String(error)}`); }
      }
      // Delivery can wait on a channel. It must never delay the next deadline sweep.
      void this.flushNotifications().catch(error => console.error("[runtime] 通知队列失败:", String(error)));
    } finally { this.ticking = false; }
  }
}
