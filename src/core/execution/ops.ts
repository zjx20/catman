import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Config } from "../../config.js";
import { writeJsonFileAtomic } from "../file-store.js";
import { hostPath, readExecutionState, type ContextStore } from "./contexts.js";
import type { OpsConfig } from "./ops-config.js";
import { DockerFailure, type RuntimeManager, type RuntimeRecord } from "./runtime.js";

const exec = promisify(execFile);
const ID = /^o_[a-f0-9]{24}$/;
type OpsState = "pending" | "starting" | "active" | "revoking";
export interface OpsRecord {
  id: string; userKey: string; contextId: string; parent: string; container: string; network: string;
  state: OpsState; reason: string; requestedAt: number; grantedAt?: number; config: OpsConfig;
}
export interface OpsConnection { id: string; host: string; port: number; user: string; privateKey: string; hostKey: string; description: string }

function missing(error: unknown): boolean {
  return error instanceof DockerFailure && (error.missing || /network .*not found|is not connected|not connected to|No such network/i.test(error.message));
}
export async function createOpsKeys(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of ["client_key", "host_key"]) await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, name)], { timeout: 10_000 });
}

/** 授权仅由网关的硬指令调用 grant；运行时 HTTP 接口只能申请和领取已有凭证。
 * 授权绑定父容器实例，不设独立时限；父容器回收前必须先回收运维容器。
 */
export class OpsManager {
  private records: OpsRecord[];
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  private readonly root: string;
  private readonly file: string;
  private readonly detach: () => void;
  private readonly releaseRetention: () => void;
  constructor(private readonly config: Config, private readonly contexts: ContextStore, private readonly runtimes: RuntimeManager, private readonly opts: {
    isAdmin: (userKey: string) => boolean;
    notify: (userKey: string, contextId: string, text: string) => void;
    createKeys?: (dir: string) => Promise<void>;
    now?: () => number;
  }) {
    this.root = join(config.dataDir, "execution", "ops"); this.file = join(this.root, "registry.json");
    this.records = readExecutionState<OpsRecord[]>(this.file, []);
    if (!Array.isArray(this.records) || this.records.some(r => !ID.test(r.id) || r.container !== `catman-ops-${r.id}` || r.network !== r.container || !/^catman-ctx-c_[a-f0-9]{24}-[a-f0-9]{16}$/.test(r.parent) || !["pending", "starting", "active", "revoking"].includes(r.state) || !r.config || !Array.isArray(r.config.mounts))) throw new Error("运维环境注册表损坏");
    this.detach = runtimes.beforeRemove(r => this.reclaimParent(r));
    this.releaseRetention = runtimes.retainWhile(parent => this.records.some(r => r.parent === parent.container));
  }
  private now(): number { return (this.opts.now ?? Date.now)(); }
  private save(): void { writeJsonFileAtomic(this.file, this.records, 0o600); }
  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(operation); this.queue = next; return next;
  }
  private checkAdmin(userKey: string): void { if (!this.opts.isAdmin(userKey)) throw new Error("运维需要管理员权限"); }
  get enabled(): boolean { return !!this.config.ops; }
  private current(r: OpsRecord): RuntimeRecord | undefined {
    return this.runtimes.all(r.userKey).find(p => p.container === r.parent && p.contextId === r.contextId);
  }
  private async assertParent(r: OpsRecord): Promise<void> {
    this.checkAdmin(r.userKey);
    if (!this.current(r) || await this.runtimes.docker(["inspect", "-f", "{{.State.Running}}", r.parent]) !== "true") throw new Error("原会话容器已回收，请在新环境重新申请授权");
  }
  private active(runtime: RuntimeRecord): OpsRecord {
    this.checkAdmin(runtime.userKey);
    if (!this.config.ops) throw new Error("部署未启用临时运维环境");
    if (this.runtimes.resolve(runtime.token)?.container !== runtime.container) throw new Error("运行身份已失效");
    const r = this.records.find(r => r.parent === runtime.container && r.userKey === runtime.userKey && r.contextId === runtime.contextId && r.state === "active");
    if (!r) throw new Error("当前会话尚未获得运维授权，请先运行 catman-ops request <用途>");
    if (JSON.stringify(r.config) !== JSON.stringify(this.config.ops)) throw new Error("部署运维配置已经变化，请重新申请授权");
    return r;
  }
  list(userKey: string): OpsRecord[] { this.checkAdmin(userKey); return structuredClone(this.records.filter(r => r.userKey === userKey)); }
  description(r: OpsRecord): string {
    const work = this.contexts.paths(this.contexts.get(r.contextId, r.userKey)!).work;
    return [
      `运维环境 ${r.id}（${({ pending: "待授权", starting: "启动中", active: "已授权", revoking: "回收中" })[r.state]}）`,
      `所属会话：${r.contextId}`, `用途：${r.reason}`, `工具镜像：${r.config.image}`,
      "宿主机目录挂载：", ...r.config.mounts.map(m => `- ${m.source} → ${m.target}（${m.readOnly ? "只读" : "可读写"}）`),
      ...(r.config.mounts.length ? [] : ["- 无额外宿主目录"]),
      `当前 workspace：${hostPath(this.config.mainDataDir, this.config.hostDataDir!, work)} → ${work}（与主会话共享，可读写）`,
      r.config.dockerSocket ? "Docker socket：/var/run/docker.sock（完整宿主 Docker 权限，相当于宿主机 root 授权）" : "Docker socket：未挂载，不能直接管理宿主 Docker。",
      "独立 SSH shell，不运行第二个 agent。默认工具包含 shell、SSH/SCP、git、curl、文件与网络排查工具、Docker CLI/Compose。",
      "不设置独立时限，与原会话执行容器同生共死；原容器回收或重建后授权失效。原会话的闲置预告和回收规则继续生效。",
      r.state === "active" ? "连接：在原会话运行 catman-ops connect 查看清单及专属 SSH 登录方法；用 catman-ops exec -- <程序> [参数...] 或 catman-ops run <本地脚本或-> [参数...] 执行，工具处理 SSH 转义。" : `授权硬指令：/授权 ${r.id}`,
      `手动回收：/运维回收 ${r.id}`,
    ].join("\n");
  }
  request(runtime: RuntimeRecord, reason: string): Promise<OpsRecord> {
    return this.locked(async () => {
      this.checkAdmin(runtime.userKey);
      if (!this.config.ops) throw new Error("部署未启用临时运维环境");
      const context = this.contexts.get(runtime.contextId, runtime.userKey);
      if (!context || context.kind !== "chat" || this.runtimes.resolve(runtime.token)?.container !== runtime.container) throw new Error("仅当前聊天会话可以申请运维环境");
      if (!reason.trim() || reason.length > 500 || /[\x00-\x1f\x7f]/.test(reason)) throw new Error("请提供 1-500 字的单行运维用途");
      const old = this.records.find(r => r.parent === runtime.container);
      if (old) return structuredClone(old);
      const work = this.contexts.paths(context).work;
      if (this.config.ops.mounts.some(m => m.target === work || work.startsWith(`${m.target}/`) || m.target.startsWith(`${work}/`))) throw new Error("运维挂载与当前 workspace 重叠");
      const id = `o_${randomBytes(12).toString("hex")}`;
      const r: OpsRecord = { id, userKey: runtime.userKey, contextId: context.id, parent: runtime.container, container: `catman-ops-${id}`, network: `catman-ops-${id}`, state: "pending", reason: reason.trim(), requestedAt: this.now(), config: structuredClone(this.config.ops) };
      this.records.push(r); this.save();
      this.opts.notify(r.userKey, r.contextId, this.description(r));
      return structuredClone(r);
    });
  }
  grant(userKey: string, id: string): Promise<{ record: OpsRecord; newlyGranted: boolean }> {
    return this.locked(async () => {
      this.checkAdmin(userKey);
      const r = this.records.find(r => r.id === id && r.userKey === userKey);
      if (!r) throw new Error("没有属于你的运维申请，请使用完整申请 ID");
      if (!this.config.ops || JSON.stringify(r.config) !== JSON.stringify(this.config.ops)) throw new Error("部署运维配置已经变化，请回收旧申请后重新申请");
      if (r.state === "active") { await this.assertParent(r); return { record: structuredClone(r), newlyGranted: false }; }
      if (r.state !== "pending") throw new Error("运维环境正在切换，请稍后重试");
      if (this.records.filter(v => v.state !== "pending").length >= this.config.ops.maxActive) throw new Error("运维容器数量已达部署上限，请先回收已有环境");
      await this.assertParent(r);
      if (!this.config.hostDataDir) throw new Error("运维环境要求 CATMAN_HOST_DATA_DIR");
      r.state = "starting"; this.save();
      try {
        const dir = join(this.root, r.id);
        await (this.opts.createKeys ?? createOpsKeys)(dir);
        await this.runtimes.docker(["network", "create", "--internal", "--label", "catman.ops=1", r.network]);
        const context = this.contexts.get(r.contextId, userKey)!;
        const work = this.contexts.paths(context).work;
        const args = ["run", "-d", "--name", r.container, "--label", "catman.ops=1", "--label", `catman.ops.parent=${r.parent}`, "--network", r.network,
          "--user", "0:0", "--security-opt", "no-new-privileges", "--memory", r.config.memory, "--memory-swap", r.config.memory, "--cpus", "1", "--pids-limit", "256",
          "--log-driver", "json-file", "--log-opt", "max-size=8m", "--log-opt", "max-file=1", "--add-host", "host.docker.internal:host-gateway",
          "--mount", `type=bind,src=${hostPath(this.config.mainDataDir, this.config.hostDataDir, dir)},dst=/run/catman-ops,readonly`,
          "--mount", `type=bind,src=${hostPath(this.config.mainDataDir, this.config.hostDataDir, work)},dst=${work}`, "-w", work, "-e", `TZ=${this.config.tz}`];
        for (const m of r.config.mounts) args.push("--mount", `type=bind,src=${m.source},dst=${m.target}${m.readOnly ? ",readonly" : ""}`);
        if (r.config.dockerSocket) args.push("--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock");
        args.push(r.config.image);
        await this.runtimes.docker(args);
        let ready = false;
        for (let i = 0; i < 20; i++) {
          try { await this.runtimes.docker(["exec", r.container, "test", "-s", "/run/sshd.pid"]); ready = true; break; }
          catch { await new Promise(resolve => setTimeout(resolve, 100)); }
        }
        if (!ready) throw new Error("运维 SSH 服务未就绪，请确认运维镜像已正确构建");
        // SSH 已仅监听最初的内部地址；额外出口供运维下载工具，不向外部网络监听 SSH。
        // 主 worker 只加入无默认网关的 internal 网络，不改变原来的模型/代理路由。
        await this.runtimes.docker(["network", "connect", "bridge", r.container]);
        await this.runtimes.docker(["network", "connect", r.network, r.parent]);
        await this.assertParent(r);
        r.state = "active"; r.grantedAt = this.now(); this.save();
        return { record: structuredClone(r), newlyGranted: true };
      } catch (error) {
        try { await this.destroy(r, "启动失败", false); }
        catch (cleanup) { console.error(`[ops] ${r.id} 启动失败，残留资源待回收：${String(cleanup)}`); }
        throw error;
      }
    });
  }
  connection(runtime: RuntimeRecord): Promise<OpsConnection> {
    return this.locked(async () => {
      const r = this.active(runtime);
      await this.assertParent(r);
      if (await this.runtimes.docker(["inspect", "-f", "{{.State.Running}}", r.container]) !== "true") throw new Error("运维容器已经停止，请回收后重新申请");
      return { id: r.id, host: r.container, port: 2222, user: "root", privateKey: readFileSync(join(this.root, r.id, "client_key"), "utf8"), hostKey: readFileSync(join(this.root, r.id, "host_key.pub"), "utf8").trim(), description: this.description(r) };
    });
  }
  requireHostAccess(runtime: RuntimeRecord): Promise<void> {
    return this.locked(async () => {
      const r = this.active(runtime);
      if (!r.config.dockerSocket) throw new Error("此操作需要用户批准包含 Docker socket 的宿主机授权");
      await this.assertParent(r);
      if (await this.runtimes.docker(["inspect", "-f", "{{.State.Running}}", r.container]) !== "true") throw new Error("运维容器已停止，请重新申请授权");
    });
  }
  revoke(userKey: string, id: string, notify = true): Promise<void> {
    return this.locked(async () => {
      this.checkAdmin(userKey);
      const r = this.records.find(r => r.userKey === userKey && r.id === id);
      if (!r) throw new Error("没有属于你的运维环境");
      await this.destroy(r, "用户手动回收", notify);
    });
  }
  reclaimParent(parent: RuntimeRecord): Promise<void> {
    return this.locked(async () => { for (const r of [...this.records]) if (r.parent === parent.container) await this.destroy(r, "原会话执行容器已回收"); });
  }
  private async destroy(r: OpsRecord, reason: string, notify = true): Promise<void> {
    const pending = r.state === "pending";
    if (!pending) {
      r.state = "revoking"; this.save();
      // 所有清理都幂等；Docker 不可用时保留身份和材料，供巡检继续回收。
      for (const args of [["rm", "-f", r.container], ["network", "disconnect", "-f", r.network, r.parent], ["network", "rm", r.network]]) {
        try { await this.runtimes.docker(args); } catch (error) { if (!missing(error)) throw error; }
      }
    }
    this.records = this.records.filter(v => v.id !== r.id); this.save();
    rmSync(join(this.root, r.id), { recursive: true, force: true });
    if (notify) this.opts.notify(r.userKey, r.contextId, `运维环境 ${r.id} 已回收：${reason}。SSH 连接和容器内进程已终止，workspace 保留；宿主修改不自动撤销。`);
  }
  async tick(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try { await this.locked(async () => {
      for (const r of [...this.records]) {
        try {
          let reason: string | undefined;
          if (!this.config.ops || !this.opts.isAdmin(r.userKey)) reason = "运维已禁用或管理员权限已撤销";
          else if (JSON.stringify(r.config) !== JSON.stringify(this.config.ops)) reason = "部署运维配置已改变，请重新申请授权";
          else if (!this.current(r)) reason = "原会话执行容器已回收";
          else if (r.state === "starting" || r.state === "revoking") reason = "恢复中断的运维环境清理";
          else {
            try { if (await this.runtimes.docker(["inspect", "-f", "{{.State.Running}}", r.parent]) !== "true") reason = "原会话执行容器已停止"; }
            catch (error) { if (!missing(error)) throw error; reason = "原会话执行容器已不存在"; }
            if (!reason && r.state === "active") {
              try { if (await this.runtimes.docker(["inspect", "-f", "{{.State.Running}}", r.container]) !== "true") reason = "运维容器已停止"; }
              catch (error) { if (!missing(error)) throw error; reason = "运维容器已不存在"; }
            }
          }
          if (reason) await this.destroy(r, reason);
        } catch (error) { console.error(`[ops] ${r.id} 巡检失败：${String(error)}`); }
      }
    }); } finally { this.checking = false; }
  }
  start(): void { if (this.timer) return; void this.tick(); this.timer = setInterval(() => { void this.tick(); }, 10_000); this.timer.unref?.(); }
  close(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.detach(); this.releaseRetention(); }
}
