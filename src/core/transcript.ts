import {
  readdirSync,
  readFileSync,
  statSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

/**
 * 读取 Agent SDK 写出的会话 JSONL(位于 CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl)。
 *
 * 说明:各版本 SDK 的逐行 schema 可能有差异,这里采用防御式解析 —— 逐行 JSON.parse,
 * 从已知形态中尽量抽取角色与文本,遇到未知结构就跳过或按原样降级,不因个别脏行崩溃。
 *
 * ⚠️ 安全约束:所有函数都接受 projectDir 过滤参数,catman 只应操作**自己 workspace**
 * 对应的 project 子目录。绝不扫描/清理整个 projects/ 树 —— 否则一旦 CLAUDE_CONFIG_DIR
 * 指向共享的 ~/.claude,清理会误删无关的 Claude Code 会话历史。
 */

/** 把 cwd 编码成 SDK 使用的 project 目录名(非字母数字 → '-')。 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface SessionSummary {
  sessionId: string;
  projectDir: string;
  /** 归属用户的 userKey。跨用户聚合时由上层填入,单目录函数不设置。 */
  userKey?: string;
  /** 文件路径。 */
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  /** 首条用户消息的前若干字符,便于列表展示。 */
  preview: string;
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "system" | "result" | "other";
  text: string;
  /** 原始行里的时间戳(若有)。 */
  ts?: string;
}

export interface SearchHit {
  sessionId: string;
  path: string;
  /** 命中的文本片段。 */
  snippet: string;
}

function projectsRoot(configDir: string): string {
  return join(configDir, "projects");
}

/**
 * 列出会话文件,按修改时间倒序。
 * 必须传 projectDir(catman 自己 workspace 的编码目录名),只扫描该子目录,
 * 从设计上杜绝误碰其它项目的会话。
 */
export function listSessions(configDir: string, projectDir: string): SessionSummary[] {
  const dir = join(projectsRoot(configDir), projectDir);
  if (!existsSync(dir)) return [];
  const out: SessionSummary[] = [];

  let files: string[];
  try {
    if (!statSync(dir).isDirectory()) return [];
    files = readdirSync(dir);
  } catch {
    return [];
  }
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(dir, file);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    out.push({
      sessionId: file.replace(/\.jsonl$/, ""),
      projectDir,
      path,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      preview: firstUserPreview(path),
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** 解析单个会话的消息列表。 */
export function readSession(
  configDir: string,
  projectDir: string,
  sessionId: string,
): TranscriptEntry[] {
  const summary = listSessions(configDir, projectDir).find((s) => s.sessionId === sessionId);
  if (!summary) return [];
  return parseFile(summary.path);
}

/**
 * 关键词检索:扫描本 workspace 会话 JSONL 的文本内容,返回命中会话及片段。
 * 纯 JS 扫描(不依赖外部 ripgrep),对个人规模 + 30 天保留足够。
 */
export function search(
  configDir: string,
  projectDir: string,
  query: string,
  maxHits = 50,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];

  for (const s of listSessions(configDir, projectDir)) {
    for (const entry of parseFile(s.path)) {
      const idx = entry.text.toLowerCase().indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 40);
        hits.push({
          sessionId: s.sessionId,
          path: s.path,
          snippet: entry.text.slice(start, idx + q.length + 40),
        });
        break; // 每个会话取一条片段即可
      }
    }
    if (hits.length >= maxHits) break;
  }
  return hits;
}

/**
 * 清理本 workspace 下超过保留期(按文件 mtime)的会话。返回被删除的 sessionId 列表,
 * 供会话状态层同步 forget 死引用。
 *
 * 只在 projectDir 指定的子目录内操作;同时删除同名的会话子目录(subagents 等),
 * 避免残留孤儿文件。绝不触碰其它 project 目录。
 */
export function cleanupOldSessions(
  configDir: string,
  projectDir: string,
  retentionMs: number,
  now: number = Date.now(),
): string[] {
  const deleted: string[] = [];
  const dir = join(projectsRoot(configDir), projectDir);
  for (const s of listSessions(configDir, projectDir)) {
    if (now - s.mtimeMs > retentionMs) {
      try {
        rmSync(s.path);
        // 同名子目录(该会话的 subagents/workflows 记录)一并清理
        const subdir = join(dir, s.sessionId);
        if (existsSync(subdir)) rmSync(subdir, { recursive: true, force: true });
        deleted.push(s.sessionId);
      } catch (err) {
        console.warn(`[transcript] 删除 ${s.path} 失败: ${String(err)}`);
      }
    }
  }
  return deleted;
}

// --- 跨用户聚合 ---

/**
 * 多用户下,每个用户有自己的 cwd,因而有自己的 project 目录。下面这组函数在
 * **调用方给定的一组 projectDir** 上做聚合。
 *
 * 关键约束没有变:这组 projectDir 必须由调用方从自己创建的 workspace 目录精确算出
 * (见 core/users.ts 的 listWorkspaceDirs),**绝不能来自 readdir(projects/)**。
 * 一旦去遍历 projects/ 树,CLAUDE_CONFIG_DIR 指向共享 ~/.claude 时就会波及无关的
 * Claude Code 历史 —— 有专门的单测守护这一点。
 */

/** 一个用户的 project 目录,以及展示用的归属信息。 */
export interface ProjectScope {
  projectDir: string;
  userKey?: string;
}

export function listSessionsAcross(configDir: string, scopes: ProjectScope[]): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const scope of scopes) {
    for (const s of listSessions(configDir, scope.projectDir)) {
      out.push({ ...s, ...(scope.userKey ? { userKey: scope.userKey } : {}) });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

export function searchAcross(
  configDir: string,
  scopes: ProjectScope[],
  query: string,
  maxHits = 50,
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const scope of scopes) {
    for (const hit of search(configDir, scope.projectDir, query, maxHits - hits.length)) {
      hits.push(hit);
      if (hits.length >= maxHits) return hits;
    }
  }
  return hits;
}

/** 在多个 project 目录上执行保留期清理,返回 projectDir → 被删除的 sessionId 列表。 */
export function cleanupOldSessionsAcross(
  configDir: string,
  scopes: ProjectScope[],
  retentionMs: number,
  now: number = Date.now(),
): string[] {
  const deleted: string[] = [];
  for (const scope of scopes) {
    deleted.push(...cleanupOldSessions(configDir, scope.projectDir, retentionMs, now));
  }
  return deleted;
}

// --- 内部解析 ---

function parseFile(path: string): TranscriptEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 跳过脏行
    }
    const entry = toEntry(obj);
    if (entry) entries.push(entry);
  }
  return entries;
}

function firstUserPreview(path: string): string {
  for (const e of parseFile(path)) {
    if (e.role === "user" && e.text) return e.text.slice(0, 80);
  }
  return "";
}

/** 从一行(未知形态)提取角色与文本。 */
function toEntry(obj: unknown): TranscriptEntry | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const type = typeof o["type"] === "string" ? (o["type"] as string) : "";
  const ts = typeof o["timestamp"] === "string" ? (o["timestamp"] as string) : undefined;

  const role: TranscriptEntry["role"] =
    type === "user"
      ? "user"
      : type === "assistant"
        ? "assistant"
        : type === "system"
          ? "system"
          : type === "result"
            ? "result"
            : "other";

  const text = extractText(o);
  if (!text && role === "other") return null;
  return { role, text, ...(ts ? { ts } : {}) };
}

/** 尽量从多种消息形态里抽取纯文本。 */
function extractText(o: Record<string, unknown>): string {
  // result 消息:直接有 result 字段
  if (typeof o["result"] === "string") return o["result"] as string;

  // user/assistant:message.content 可能是字符串或 block 数组
  const message = o["message"];
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>)["content"];
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === "string") return block;
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (typeof b["text"] === "string") return b["text"] as string;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }

  // 顶层 content 兜底
  const content = o["content"];
  if (typeof content === "string") return content;
  return "";
}
