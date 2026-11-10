import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { writeJsonFileAtomic } from "../file-store.js";
import { encodeProjectDir, listSessions, readSession, search, type SessionSummary } from "../transcript.js";
import { readScopedFile } from "../scoped-files.js";

export type ContextKind = "chat" | "cron";
export interface ExecutionContext {
  id: string;
  userKey: string;
  kind: ContextKind;
  jobId?: string;
  sdkSessionId: string;
  sdkStarted: boolean;
  createdAt: number;
  lastActivityAt: number;
}
export interface ContextPaths {
  root: string;
  work: string;
  sdk: string;
  tasks: string;
  home: string;
}
export const tenantId = (userKey: string): string => createHash("sha256").update(userKey).digest("hex").slice(0, 32);
export function readExecutionState<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw new Error(`执行状态损坏：${path}`, { cause: error }); }
}

/** This release deliberately requires an explicit, reviewed migration of existing data. */
export function requireExecutionLayout(root: string): void {
  const marker = join(root, "execution", "schema.json");
  if (existsSync(marker)) {
    const layout = readExecutionState<{ schema?: number; containerRoot?: string }>(marker, {});
    if (layout.schema !== 2) throw new Error("数据布局版本不受支持");
    if (layout.containerRoot !== resolve(root)) throw new Error(`SDK 会话按 ${layout.containerRoot ?? "未知路径"} 迁移，请使用同一容器数据路径或先显式重新定位数据`);
    return;
  }
  if (["users.json", "state.json"].some(file => existsSync(join(root, file)))) {
    throw new Error("需要先由管理员 agent 完成执行上下文 v2 数据迁移；步骤见 README 的迁移说明。不得直接删除旧状态继续启动。");
  }
  writeJsonFileAtomic(marker, { schema: 2, containerRoot: resolve(root) }, 0o600);
}

/** Control-plane registry owns identity and lifetime. Workers never mount this file or tenant roots. */
export class ContextStore {
  private readonly path: string;
  private readonly contexts: ExecutionContext[];
  constructor(readonly root: string, private readonly now: () => number = Date.now) {
    this.path = join(root, "execution", "contexts.json");
    const raw = readExecutionState<{ schema?: number; contexts?: ExecutionContext[] }>(this.path, {});
    if (raw.schema !== undefined && raw.schema !== 2) throw new Error("执行上下文格式不受支持，请先完成数据迁移");
    this.contexts = raw.contexts ?? [];
    if (!Array.isArray(this.contexts)) throw new Error("执行上下文注册表损坏");
    for (const c of this.contexts) {
      if (!/^c_[a-f0-9]{24}$/.test(c.id) || typeof c.userKey !== "string" || !["chat", "cron"].includes(c.kind)) {
        throw new Error("执行上下文注册表损坏，拒绝启动");
      }
    }
  }
  all(userKey?: string): ExecutionContext[] {
    return this.contexts.filter(c => userKey === undefined || c.userKey === userKey).map(c => ({ ...c }));
  }
  get(id: string, userKey?: string): ExecutionContext | undefined {
    const c = this.contexts.find(c => c.id === id && (userKey === undefined || c.userKey === userKey));
    return c && { ...c };
  }
  bySession(userKey: string, sessionId: string): ExecutionContext | undefined {
    const c = this.contexts.find(c => c.userKey === userKey && c.sdkSessionId === sessionId);
    return c && { ...c };
  }
  chat(userKey: string, resumeSessionId?: string): ExecutionContext {
    if (resumeSessionId) {
      const c = this.bySession(userKey, resumeSessionId);
      if (!c || c.kind !== "chat") throw new Error("会话不属于此用户或尚未迁移");
      return c;
    }
    return this.create(userKey, "chat");
  }
  cron(userKey: string, jobId: string): ExecutionContext {
    const c = this.contexts.find(c => c.userKey === userKey && c.kind === "cron" && c.jobId === jobId);
    return c ? { ...c } : this.create(userKey, "cron", jobId);
  }
  private create(userKey: string, kind: ContextKind, jobId?: string): ExecutionContext {
    const c: ExecutionContext = { id: `c_${randomUUID().replaceAll("-", "").slice(0, 24)}`, userKey, kind,
      ...(jobId ? { jobId } : {}), sdkSessionId: randomUUID(), sdkStarted: false,
      createdAt: this.now(), lastActivityAt: this.now() };
    this.contexts.push(c);
    this.ensure(c);
    this.save();
    return { ...c };
  }
  paths(c: ExecutionContext): ContextPaths {
    const user = join(this.root, "tenants", tenantId(c.userKey));
    const root = join(user, "contexts", c.id);
    return { root, work: join(root, "work"), sdk: join(root, "sdk"), tasks: join(root, "tasks"), home: join(user, "home") };
  }
  ensure(c: ExecutionContext): ContextPaths {
    const p = this.paths(c);
    if (p.work.length >= 180) throw new Error("执行路径过长，请使用较短的 CATMAN_DATA_DIR");
    for (const dir of [p.work, p.sdk, p.tasks, p.home, join(p.home, "skills")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const instructions = join(p.home, "CLAUDE.md");
    if (!existsSync(instructions)) writeFileSync(instructions, "# 个人偏好\n\n在这里维护本用户的偏好。个人 skill 放在 skills/。\n", { mode: 0o600 });
    return p;
  }
  started(id: string, sessionId: string): void {
    const c = this.contexts.find(c => c.id === id);
    if (!c) throw new Error("未知执行上下文");
    c.sdkSessionId = sessionId;
    c.sdkStarted = true;
    this.save();
  }
  fresh(id: string): ExecutionContext {
    const c = this.contexts.find(c => c.id === id);
    if (!c) throw new Error("未知执行上下文");
    c.sdkSessionId = randomUUID(); c.sdkStarted = false; this.save(); return { ...c };
  }
  touch(id: string): void {
    const c = this.contexts.find(c => c.id === id);
    if (c) { c.lastActivityAt = this.now(); this.save(); }
  }
  remove(id: string): void {
    const i = this.contexts.findIndex(c => c.id === id);
    if (i < 0) return;
    const p = this.paths(this.contexts[i]!);
    // Runtime must be stopped by the caller before removing a context.
    rmSync(p.root, { recursive: true, force: true });
    this.contexts.splice(i, 1); this.save();
  }
  sessions(userKey?: string): SessionSummary[] {
    return this.all(userKey).flatMap(c => listSessions(this.paths(c).sdk, encodeProjectDir(this.paths(c).work))
      .map(s => ({ ...s, userKey: c.userKey }))).sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
  read(sessionId: string, userKey?: string) {
    for (const c of this.all(userKey)) {
      const p = this.paths(c);
      const entries = readSession(p.sdk, encodeProjectDir(p.work), sessionId);
      if (entries.length) return entries;
    }
    return [];
  }
  search(query: string, userKey?: string) {
    return this.all(userKey).flatMap(c => { const p = this.paths(c); return search(p.sdk, encodeProjectDir(p.work), query).map(hit => ({ ...hit, userKey: c.userKey })); });
  }
  private save(): void { writeJsonFileAtomic(this.path, { schema: 2, contexts: this.contexts }, 0o600); }
}

/** Only trusted control-plane code translates local paths to daemon-host paths. */
export function hostPath(dataDir: string, hostDataDir: string, local: string): string {
  const rel = relative(resolve(dataDir), resolve(local));
  if (rel === ".." || rel.startsWith(`../`) || isAbsolute(rel)) throw new Error("挂载源越出数据目录");
  return join(hostDataDir, rel);
}

/** A tenant can write symlinks in its home. Never follow them into control-plane files. */
export function readTenantFile(home: string, name: string): string | undefined {
  const path = join(home, name);
  if (!existsSync(path)) return undefined;
  return readScopedFile(home, path);
}
