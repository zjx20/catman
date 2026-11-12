import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, copyFileSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { ContextStore } from "../core/execution/contexts.js";
import type { RuntimeManager } from "../core/execution/runtime.js";
import type { CapabilityBroker, SharedTools } from "../core/execution/broker.js";
import type { TurnTokens } from "../core/turn-tokens.js";
import type { OpsManager } from "../core/execution/ops.js";
import { BUILTIN_ADMIN_USER_KEY } from "../core/identity.js";
import { formatPrepareReport, readPrepareTail } from "../core/prepare-report.js";

const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
const header = (req: IncomingMessage, key: string) => { const h = req.headers[key]; return Array.isArray(h) ? h[0] : h; };
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error("请求过大"); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}
export class ExecutionApi {
  private preparing = false;
  private readonly notifyHits = new Map<string, number[]>();
  constructor(readonly opts: { config: Config; contexts: ContextStore; runtimes: RuntimeManager; broker: CapabilityBroker; turns: TurnTokens; ops?: OpsManager; isAdmin: (userKey: string) => boolean }) {}
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, staticAdmin: boolean): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith("/api/runtime/") && path !== "/api/execution" && !path.startsWith("/api/execution/")) return false;
    const { runtimes, contexts } = this.opts;
    const token = header(req, "x-catman-runtime") || header(req, "x-catman-session") || header(req, "authorization")?.replace(/^Bearer /i, "");
    const runtime = runtimes.resolve(token);
    const principal = runtime?.userKey ?? (token ? this.opts.turns.resolve(token)?.userKey : undefined) ?? (staticAdmin ? BUILTIN_ADMIN_USER_KEY : undefined);
    if (!principal) { json(res, 401, { error: "需要有效的执行身份" }); return true; }
    try {
      if (path.startsWith("/api/runtime/")) {
        if (!runtime) { json(res, 401, { error: "需要有效的运行环境身份" }); return true; }
        if (path.startsWith("/api/runtime/ops/")) {
          if (!this.opts.isAdmin(principal)) { json(res, 403, { error: "运维需要管理员权限" }); return true; }
          const ops = this.opts.ops;
          if (!ops) throw new Error("运维管理不可用");
          if (path === "/api/runtime/ops/request" && req.method === "POST") {
            const input = await body(req);
            if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "reason") || typeof input.reason !== "string") throw new Error("运维申请只接受 reason；挂载和 Docker 权限由部署指定");
            const record = await ops.request(runtime, input.reason);
            json(res, 200, { id: record.id, description: ops.description(record) }); return true;
          }
          if (path === "/api/runtime/ops/connection" && req.method === "GET") {
            res.setHeader("cache-control", "no-store");
            json(res, 200, await ops.connection(runtime)); return true;
          }
          if (path === "/api/runtime/ops/status" && req.method === "GET") {
            const records = ops.list(principal).filter(r => r.parent === runtime.container);
            json(res, 200, { description: ops.enabled ? records.map(r => ops.description(r)).join("\n\n") || "当前会话没有运维申请。使用 catman-ops request <用途> 申请。" : "部署未启用临时运维环境，需要部署管理员配置 CATMAN_OPS_ENABLED 和挂载清单。" }); return true;
          }
          json(res, 404, { error: "没有这个运维接口；授权和回收使用用户硬指令" }); return true;
        }
        if (/^\/api\/runtime\/(model|mcp|services)\//.test(path)) {
          await this.opts.broker.proxy(req, res, runtime, path); return true;
        }
        const input = await body(req);
        if (req.method !== "POST") throw new Error("只支持 POST");
        if (path === "/api/runtime/events") {
          runtimes.taskEvent(runtime.token, input.task, String(input.tail ?? ""));
          json(res, 200, { ok: true }); return true;
        }
        if (path === "/api/runtime/notify") {
          const text = typeof input.text === "string" ? input.text.trim() : "";
          if (!text || text.length > 6000) throw new Error("text 长度必须为 1-6000");
          const hits = (this.notifyHits.get(principal) ?? []).filter(t => Date.now() - t < 3600_000);
          if (hits.length >= 20) { json(res, 429, { error: "通知过于频繁" }); return true; }
          hits.push(Date.now()); this.notifyHits.set(principal, hits);
          runtimes.report(runtime.contextId, text); json(res, 202, { ok: true }); return true;
        }
        throw new Error("未知运行时接口");
      }
      if (path === "/api/execution" && req.method === "GET") {
        const list = runtimes.all(principal).map(({ token: _secret, ...view }) => view);
        json(res, 200, { contexts: contexts.all(principal), runtimes: list }); return true;
      }
      if (path === "/api/execution/shared") {
        if (!this.opts.isAdmin(principal)) { json(res, 403, { error: "需要管理员权限" }); return true; }
        if (req.method === "GET") { json(res, 200, this.opts.broker.describe()); return true; }
        if (req.method === "PUT") { this.opts.broker.configure(await body(req) as SharedTools); json(res, 200, { ok: true }); return true; }
        throw new Error("只支持 GET / PUT");
      }
      if (path === "/api/execution/diagnostics" && req.method === "GET") {
        if (!this.opts.isAdmin(principal)) { json(res, 403, { error: "需要管理员权限" }); return true; }
        const names = [process.env.CATMAN_CONTAINER || "catman", process.env.CATMAN_COURIER_CONTAINER || "catman-courier"];
        const result = [];
        for (const name of names) {
          try {
            const state = await runtimes.docker(["inspect", "-f", "{{json .State}}", name]);
            const logs = await runtimes.docker(["logs", "--tail", "80", name]);
            result.push({ name, state, logs: logs.slice(-12000) });
          } catch (error) { result.push({ name, error: String(error) }); }
        }
        json(res, 200, result); return true;
      }
      if (path === "/api/execution/recover" && req.method === "POST") {
        if (!this.opts.isAdmin(principal) || this.opts.config.persona !== "rescue") { json(res, 403, { error: "需要守护人格管理员权限" }); return true; }
        const input = await body(req);
        if (input.action === "restart-primary") await runtimes.docker(["restart", process.env.CATMAN_CONTAINER || "catman"]);
        else if (input.action === "demote") {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(join(this.opts.config.deployDir, "bin", "deployer-run.sh"), ["demote", "--step", "1", "--why", "管理员请求恢复"], { stdio: "ignore" });
            const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("恢复请求超时")); }, 30_000);
            child.once("error", error => { clearTimeout(timer); reject(error); }); child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`恢复请求失败：${code}`)); });
          });
        } else throw new Error("未知恢复操作");
        json(res, 202, { ok: true }); return true;
      }
      if (path === "/api/execution/prepare" && req.method === "POST") {
        if (!this.opts.isAdmin(principal) || this.opts.config.persona !== "primary") { json(res, 403, { error: "需要主人格管理员权限" }); return true; }
        // 制备会执行可由 agent 修改的仓库脚本，不能绕过用户的宿主权限授权。
        if (this.opts.config.ops && !staticAdmin) {
          try {
            if (!runtime || !this.opts.ops) throw new Error("请先由用户硬指令批准当前会话的宿主机运维授权");
            await this.opts.ops.requireHostAccess(runtime);
          } catch (error) { json(res, 403, { error: String(error) }); return true; }
        }
        const input = await body(req); const ref = input.ref;
        if (typeof ref !== "string" || !/^(HEAD|[a-f0-9]{7,40})$/.test(ref)) throw new Error("ref 必须是 HEAD 或提交 SHA");
        if (this.preparing) { json(res, 409, { error: "已有制备任务运行中" }); return true; }
        const logDir = join(this.opts.config.dataDir, "execution", "builds"); mkdirSync(logDir, { recursive: true });
        const log = join(logDir, `${Date.now()}.log`); const fd = openSync(log, "wx", 0o600);
        let child: ReturnType<typeof spawn>;
        try { child = spawn(join(this.opts.config.deployDir, "bin", "prepare.sh"), [ref], { cwd: this.opts.config.srcDir, env: process.env, stdio: ["ignore", fd, fd] }); }
        finally { closeSync(fd); }
        this.preparing = true;
        const releaseRuntime = runtime ? runtimes.retainWhile(r => r.contextId === runtime.contextId) : () => {};
        let finished = false, timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 30 * 60_000);
        const finish = (status: string) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout); this.preparing = false;
          let tail = ""; try { tail = readPrepareTail(log); } catch {}
          let readableLog = log;
          let logNote = "";
          const context = runtime && contexts.get(runtime.contextId, principal);
          try {
            if (context) {
              const target = join(contexts.paths(context).tasks, `prepare-${randomUUID()}.log`);
              try { copyFileSync(log, target, constants.COPYFILE_EXCL); readableLog = target; }
              catch (error) { logNote = "\n\n原上下文日志副本保存失败，完整日志暂需管理员从控制面读取。"; console.error("[prepare] 日志副本保存失败:", String(error)); }
            }
            runtimes.notifyUser(principal, runtime?.contextId ?? "prepare", formatPrepareReport(status, tail, readableLog) + logNote, false, context ? "prepare" : undefined);
          } finally { releaseRuntime(); }
        };
        child.once("error", err => finish(`启动失败：${String(err)}`));
        child.once("exit", (code, signal) => finish(timedOut ? "超时" : code === 0 ? "完成" : `失败（${signal ?? code}）`));
        json(res, 202, { ok: true, note: "制备已开始，完成后通知；发布仍使用 /发布 指令。" }); return true;
      }
      const match = /^\/api\/execution\/(c_[a-f0-9]{24})\/(extend|reclaim)$/.exec(path);
      if (match && req.method === "POST") {
        const input = await body(req);
        if (match[2] === "extend") json(res, 200, { deadlineAt: runtimes.extend(principal, match[1]!, input.minutes) });
        else { await runtimes.reclaim(principal, match[1]!); json(res, 200, { ok: true }); }
        return true;
      }
      json(res, 404, { error: "没有这个执行接口" });
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: String(error) }); else res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }
}
