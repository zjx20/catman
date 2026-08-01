import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { StateStore, StateMap } from "./session.js";

/**
 * JSON 文件持久化的公共实现。写入用"临时文件 + rename"保证原子性,
 * 避免进程在写一半时被杀导致文件损坏。
 *
 * 会话状态、用户注册表、账号凭据三处共用这里的函数。尤其是 mode 参数:
 * 凭据文件必须 0600,且临时文件也要以 0600 创建 —— 否则在 rename 之前
 * 存在一个内容已完整、权限却是 0644 的窗口。
 */

/** 读 JSON 文件。不存在或损坏都降级为 fallback,并对损坏告警。 */
export function readJsonFile<T>(path: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[file-store] 读取 ${path} 失败,按空内容处理: ${String(err)}`);
    }
    return fallback;
  }
}

/** 原子写 JSON。mode 同时作用于临时文件。 */
export function writeJsonFileAtomic(path: string, data: unknown, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
    renameSync(tmp, path);
  } catch (err) {
    // rename 失败会留下 tmp 残骸,清掉以免下次写入被半截内容干扰。
    try {
      unlinkSync(tmp);
    } catch {
      // tmp 本就没建成(writeFileSync 阶段就失败),忽略。
    }
    throw err;
  }
}

/** 基于 JSON 文件的会话状态持久化。 */
export class FileStore implements StateStore {
  constructor(private readonly path: string) {}

  load(): StateMap {
    return readJsonFile<StateMap>(this.path, {});
  }

  save(state: StateMap): void {
    writeJsonFileAtomic(this.path, state);
  }
}
