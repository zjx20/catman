import { mkdirSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "./file-store.js";
import {
  userDirName,
  parseUserKey,
  SDK_PROJECT_PATH_LIMIT,
  USER_DIR_NAME_MAX,
} from "./identity.js";
import { encodeProjectDir } from "./transcript.js";

/**
 * 每用户工作目录与用户注册表。
 *
 * 目录布局:
 *   <workspaceRoot>/CLAUDE.md            共享人设,所有用户继承
 *   <workspaceRoot>/<dirName>/           某个用户的 cwd
 *   <workspaceRoot>/<dirName>/CLAUDE.md  `@../CLAUDE.md` + 个人段落
 *
 * 共享人设走 CLAUDE.md 的 `@` import 语法显式引入,而不是依赖「向上递归查找父目录
 * CLAUDE.md」的隐式行为 —— 后者在 Agent SDK 的 preset 系统提示词下没有验证过。
 * 注意 project settings(`.claude/settings.json`)没有类似的继承机制:要让某项
 * setting 对所有用户生效,得放到 user settings($CLAUDE_CONFIG_DIR/settings.json)。
 */

export interface UserRecord {
  /** 工作目录名(workspaceRoot 下的一级子目录)。 */
  dirName: string;
  channel: string;
  accountId: string;
  /** dashboard 上展示的名字,默认取 userId 前若干字符。 */
  displayName: string;
  createdAt: number;
  lastSeenAt: number;
  /**
   * 首次使用指引推送成功的时刻。缺席表示还没推过 ——
   * 推送失败时刻意不写,让它下次重试(指引值得重试)。
   */
  greetedAt?: number;
}

/** displayName 的长度上限。太长会把 dashboard 列表撑坏。 */
const DISPLAY_NAME_MAX = 64;

export type UserMap = Record<string, UserRecord>;

/** 新建用户 workspace 时写入的 CLAUDE.md 初始内容。 */
function initialUserClaudeMd(userKey: string): string {
  return `# 个人偏好

@../CLAUDE.md

以上一行引入共享人设(workspace 根目录的 CLAUDE.md),下面写只对本用户生效的偏好。

- 用户标识:\`${userKey}\`
`;
}

export interface UserRegistryOptions {
  /** users.json 路径。 */
  path: string;
  /** 工作目录根,即各用户 cwd 的父目录。 */
  workspaceRoot: string;
  /** 时钟,默认 Date.now;测试可注入。 */
  now?: () => number;
}

export class UserRegistry {
  private readonly users: UserMap;
  private readonly path: string;
  private readonly workspaceRoot: string;
  private readonly now: () => number;

  constructor(opts: UserRegistryOptions) {
    this.path = opts.path;
    this.workspaceRoot = opts.workspaceRoot;
    this.now = opts.now ?? Date.now;
    this.users = readJsonFile<UserMap>(this.path, {});
  }

  /** 某用户的工作目录(cwd)绝对路径。不保证目录已存在。 */
  workspaceDirOf(userKey: string): string {
    return join(this.workspaceRoot, userDirName(userKey));
  }

  /**
   * 确保该用户的工作目录存在并已注册,返回 cwd。
   * 幂等:已存在的目录与 CLAUDE.md 都不覆盖(用户可能已经改过个人偏好)。
   */
  ensureWorkspace(userKey: string): string {
    const dir = this.workspaceDirOf(userKey);
    assertPathFitsSdkLimit(dir);
    mkdirSync(dir, { recursive: true });

    const claudeMd = join(dir, "CLAUDE.md");
    if (!existsSync(claudeMd)) {
      writeFileSync(claudeMd, initialUserClaudeMd(userKey), "utf8");
    }

    const t = this.now();
    const existing = this.users[userKey];
    if (existing) {
      existing.lastSeenAt = t;
    } else {
      const parts = parseUserKey(userKey);
      this.users[userKey] = {
        dirName: userDirName(userKey),
        channel: parts?.channel ?? "",
        accountId: parts?.accountId ?? "",
        displayName: defaultDisplayName(userKey),
        createdAt: t,
        lastSeenAt: t,
      };
    }
    this.persist();
    return dir;
  }

  /**
   * 该用户是否还没收到过使用指引。
   *
   * 判据是 greetedAt 缺席,所以本次改动之前就存在的用户下次发消息时也会收到一次 ——
   * 无害,且按「不做数据迁移」的口径,不该为此写格式分支。
   */
  needsGreeting(userKey: string): boolean {
    return this.users[userKey]?.greetedAt === undefined;
  }

  /** 标记指引已送达。**仅在发送成功后调用** —— 失败要留给下次重试。 */
  markGreeted(userKey: string): void {
    const rec = this.users[userKey];
    if (!rec) return;
    rec.greetedAt = this.now();
    this.persist();
  }

  /** 改展示名。返回 false 表示用户尚未注册。 */
  setDisplayName(userKey: string, name: string): boolean {
    const rec = this.users[userKey];
    if (!rec) return false;
    const trimmed = name.trim();
    if (!trimmed) throw new Error("展示名不能为空");
    rec.displayName =
      trimmed.length > DISPLAY_NAME_MAX ? `${trimmed.slice(0, DISPLAY_NAME_MAX)}…` : trimmed;
    this.persist();
    return true;
  }

  /** 单个用户的记录副本。 */
  get(userKey: string): UserRecord | undefined {
    const rec = this.users[userKey];
    return rec ? { ...rec } : undefined;
  }

  /** 已注册用户快照(dashboard 用)。 */
  snapshot(): UserMap {
    const out: UserMap = {};
    for (const [k, v] of Object.entries(this.users)) out[k] = { ...v };
    return out;
  }

  /** 某个 workspace 目录名属于哪个 userKey;未注册返回 undefined。 */
  userKeyOfDir(dirName: string): string | undefined {
    for (const [userKey, rec] of Object.entries(this.users)) {
      if (rec.dirName === dirName) return userKey;
    }
    return undefined;
  }

  private persist(): void {
    writeJsonFileAtomic(this.path, this.users);
  }
}

function defaultDisplayName(userKey: string): string {
  const parts = parseUserKey(userKey);
  const id = parts?.userId ?? userKey;
  return id.length > 24 ? `${id.slice(0, 24)}…` : id;
}

/**
 * 工作目录路径必须短于 SDK 的 project 路径阈值。超过后 SDK 会改用
 * 「截断 + djb2 哈希」的编码,而 encodeProjectDir() 是朴素替换,两者分叉后
 * dashboard 读不到会话、清理也删不掉 —— 是静默的数据问题,所以在建目录时就拦。
 */
function assertPathFitsSdkLimit(dir: string): void {
  if (dir.length >= SDK_PROJECT_PATH_LIMIT) {
    throw new Error(
      `工作目录路径过长(${dir.length} ≥ ${SDK_PROJECT_PATH_LIMIT}),` +
        `会导致会话存储目录编码与 encodeProjectDir 不一致。请缩短 CATMAN_WORKSPACE_DIR:${dir}`,
    );
  }
}

/**
 * 扫描 workspaceRoot 下的一级子目录,返回各用户的目录名与对应的 project 目录名。
 *
 * **这是会话清理的真相源**,而不是 users.json 或 state.json:后两者会因为
 * history 被挤出/删账号而失去条目,但 JSONL 还躺在磁盘上,只按它们清理会造成永久堆积。
 * workspace 目录是本程序自己创建的、与用户一一对应且完备的。
 *
 * 同样重要的是它**只读自己的 workspaceRoot,完全不去遍历 projects/ 树** ——
 * 满足「绝不扫描整个 projects/」这条不变量(CLAUDE_CONFIG_DIR 可能指向共享的
 * ~/.claude,遍历它会误删无关的 Claude Code 历史)。
 */
export interface WorkspaceDirInfo {
  dirName: string;
  path: string;
  /** 该 cwd 对应的 CLAUDE_CONFIG_DIR/projects/ 下的子目录名。 */
  projectDir: string;
}

export function listWorkspaceDirs(workspaceRoot: string): WorkspaceDirInfo[] {
  let entries;
  try {
    entries = readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WorkspaceDirInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // 只认本程序生成的目录名形态,避免把用户手动放进来的目录当成某个人的 workspace。
    if (!isUserDirName(e.name)) continue;
    const path = join(workspaceRoot, e.name);
    out.push({ dirName: e.name, path, projectDir: encodeProjectDir(path) });
  }
  return out;
}

/** userDirName() 生成的目录名形态:可读前缀 + '-' + 8 位十六进制哈希,或纯哈希。 */
function isUserDirName(name: string): boolean {
  if (name.length > USER_DIR_NAME_MAX) return false;
  return /^(?:[a-zA-Z0-9-]*-)?[0-9a-f]{8}$/.test(name);
}
