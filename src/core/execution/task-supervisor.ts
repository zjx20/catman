import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { writeJsonFileAtomic, readJsonFile } from "../file-store.js";

export const TASK_SOCKET = "/tmp/catman-runtime.sock";
export const MAX_TASK_MS = 24 * 60 * 60 * 1000;
export interface TaskRecord {
  id: string; name: string; command: string; startedAt: number; deadlineAt: number;
  status: "running" | "completed" | "failed" | "timeout" | "stopped" | "interrupted";
  pid?: number; exitCode?: number; endedAt?: number;
}
export interface TaskRequest { id?: string; name?: string; cmd: string[]; cwd: string; env?: Record<string, string>; timeoutMs: number }

/** A child of tini, independent of CLI lifetime. All tracked jobs have finite deadlines. */
export class TaskSupervisor {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly agents = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly escalation = new Set<ReturnType<typeof setTimeout>>();
  private server?: Server;
  private closed = false;
  constructor(private readonly opts: {
    dir: string; socket?: string; maxTaskMs?: number; killGraceMs?: number;
    onEvent?: (task: TaskRecord, tail: string) => Promise<void> | void;
  }) {
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    for (const task of readJsonFile<TaskRecord[]>(join(opts.dir, "tasks.json"), [])) {
      if (task.status === "running") { task.status = "interrupted"; task.endedAt = Date.now(); delete task.pid; }
      this.tasks.set(task.id, task);
    }
    this.persist();
  }
  list(): TaskRecord[] { return [...this.tasks.values()].map(t => ({ ...t })); }
  start(input: TaskRequest): TaskRecord {
    if (this.closed) throw new Error("运行环境正在关闭");
    if (!Array.isArray(input.cmd) || !input.cmd.length || input.cmd.length > 128 || input.cmd.some(s => typeof s !== "string" || s.includes("\0") || s.length > 16384)) throw new Error("cmd 必须为命令参数数组");
    const max = Math.min(this.opts.maxTaskMs ?? MAX_TASK_MS, MAX_TASK_MS);
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > max) throw new Error(`必须指定 timeoutMs，范围 1-${max}`);
    if (typeof input.cwd !== "string" || !input.cwd.startsWith("/") || !existsSync(input.cwd)) throw new Error("cwd 必须是存在的绝对路径");
    const id = input.id ?? `t_${randomUUID()}`;
    if (!/^t_[a-f0-9-]{36}$/.test(id) || this.tasks.has(id)) throw new Error("任务 ID 无效或已存在");
    if (this.list().filter(t => t.status === "running").length >= 16) throw new Error("此上下文最多同时运行 16 个后台任务");
    const env = { ...process.env, ...input.env };
    // A turn/admin credential must not outlive its turn. Runtime capability has a separate scope.
    for (const k of ["CATMAN_SESSION_TOKEN", "CATMAN_ADMIN_TOKEN", "CATMAN_IPC_SECRET"]) delete env[k];
    const now = Date.now();
    const task: TaskRecord = { id, name: (input.name || basename(input.cmd[0]!)).replace(/[\r\n]/g, " ").slice(0, 100),
      command: basename(input.cmd[0]!), startedAt: now, deadlineAt: now + input.timeoutMs, status: "running" };
    this.tasks.set(task.id, task); this.persist();
    const child = spawn(input.cmd[0]!, input.cmd.slice(1), { cwd: input.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    task.pid = child.pid;
    const log = join(this.opts.dir, `${task.id}.log`);
    let tail = Buffer.alloc(0);
    const capture = (data: Buffer) => {
      tail = Buffer.concat([tail, data]);
      if (tail.length > 256 * 1024) tail = tail.subarray(tail.length - 256 * 1024);
      writeFileSync(log, tail, { mode: 0o600 });
    };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const finish = (code: number | null, error?: Error) => {
      if (error) capture(Buffer.from(String(error)));
      if (task.status === "running") task.status = code === 0 && !error ? "completed" : "failed";
      task.exitCode = code ?? -1; task.endedAt = Date.now();
      const timer = this.timers.get(task.id); if (timer) clearTimeout(timer); this.timers.delete(task.id);
      // A script can spawn descendants and exit. They do not inherit an unlimited lifetime.
      this.killGroup(task.pid);
      delete task.pid; this.persist();
      this.emit(task, tail.toString("utf8").slice(-1200));
    };
    child.once("error", err => finish(null, err));
    child.once("close", code => { if (task.endedAt === undefined) finish(code); });
    this.timers.set(task.id, setTimeout(() => this.stop(task.id, "timeout"), input.timeoutMs));
    this.emit(task, "");
    return { ...task };
  }
  stop(id: string, reason: "timeout" | "stopped" = "stopped"): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return;
    task.status = reason; this.persist();
    this.killGroup(task.pid);
  }
  private killGroup(pid?: number): void {
    if (!pid) return;
    try { process.kill(-pid, "SIGTERM"); } catch { return; }
    const timer = setTimeout(() => { this.escalation.delete(timer); try { process.kill(-pid, "SIGKILL"); } catch {} }, this.opts.killGraceMs ?? 2000);
    this.escalation.add(timer);
  }
  private persist(): void { writeJsonFileAtomic(join(this.opts.dir, "tasks.json"), this.list(), 0o600); }
  private emit(task: TaskRecord, tail: string): void {
    const snapshot = { ...task };
    appendFileSync(join(this.opts.dir, "events.jsonl"), JSON.stringify({ at: Date.now(), task, tail }) + "\n", { mode: 0o600 });
    Promise.resolve().then(() => this.opts.onEvent?.(snapshot, tail)).catch(err => console.warn("[tasks] 事件上报失败:", String(err)));
  }
  async listen(): Promise<void> {
    const socket = this.opts.socket ?? TASK_SOCKET;
    mkdirSync(dirname(socket), { recursive: true }); rmSync(socket, { force: true });
    this.server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 128 * 1024) throw new Error("请求过大"); chunks.push(chunk); }
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        let result: unknown;
        if (req.url === "/tasks" && req.method === "GET") result = this.list();
        else if (req.url === "/tasks" && req.method === "POST") result = this.start(body);
        else if (req.url?.startsWith("/tasks/") && req.method === "DELETE") { this.stop(req.url.slice(7)); result = { ok: true }; }
        else if (req.url === "/agents" && req.method === "POST") {
          if (!Number.isSafeInteger(body.pid) || body.pid <= 1) throw new Error("无效 agent pid");
          if (typeof body.id !== "string" || !/^[a-f0-9-]{36}$/.test(body.id)) throw new Error("无效 agent id");
          this.agents.set(body.id, body.pid); result = { ok: true };
        } else if (req.url?.startsWith("/agents/") && req.method === "DELETE") {
          const id = req.url.slice(8); const pid = this.agents.get(id); this.agents.delete(id);
          if (!body.exited) this.killGroup(pid); result = { ok: true };
        } else if (req.url === "/agents" && req.method === "DELETE") {
          for (const pid of this.agents.values()) try { process.kill(-pid, "SIGKILL"); } catch {}
          result = { ok: true };
        } else if (req.url === "/processes") {
          const { stdout } = await promisify(execFile)("ps", ["-eo", "pid,ppid,stat,comm,etimes"], { timeout: 3000, maxBuffer: 64 * 1024 });
          const rows = stdout.trim().split("\n").slice(1).map(line => {
            const [pid, ppid, state, command] = line.trim().split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), state: state ?? "", command: command ?? "", line };
          });
          const internal = new Set<number>([Number(req.headers["x-catman-client-pid"])]);
          let ancestor = process.pid;
          while (ancestor && !internal.has(ancestor)) { internal.add(ancestor); ancestor = rows.find(p => p.pid === ancestor)?.ppid ?? 0; }
          for (const [id, pid] of this.agents) if (!rows.some(p => p.pid === pid && !p.state.startsWith("Z"))) this.agents.delete(id);
          const unmanaged = rows.filter(p => !internal.has(p.pid) && !(p.ppid === process.pid && p.command === "ps") && !p.state.startsWith("Z"));
          result = { tasks: this.list(), processes: stdout.trim().split("\n").slice(0, 40), agents: [...this.agents.keys()], unmanaged: unmanaged.map(p => p.command) };
        } else throw new Error("未知运行时请求");
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
      } catch (error) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(error) })); }
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(socket, resolve); });
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.tasks.values()) this.stop(task.id);
    for (const pid of this.agents.values()) this.killGroup(pid);
    for (const timer of this.timers.values()) clearTimeout(timer);
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
  }
}

export function taskRequest(path: string, method = "GET", body?: unknown, socket = process.env.CATMAN_TASK_SOCKET ?? TASK_SOCKET): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method, timeout: 10_000, headers: { "content-type": "application/json", "x-catman-client-pid": String(process.pid) } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", chunk => { size += chunk.length; if (size > 512 * 1024) req.destroy(new Error("运行时响应过大")); else chunks.push(chunk); });
      res.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString()); res.statusCode === 200 ? resolve(value) : reject(new Error(value.error)); } catch (e) { reject(e); } });
    });
    req.once("error", reject); req.once("timeout", () => req.destroy(new Error("运行时请求超时")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
