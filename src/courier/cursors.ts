import { readJsonFile, writeJsonFileAtomic } from "../core/file-store.js";
import type { CursorStore } from "../channels/wechat-ilink.js";

/**
 * 长轮询游标的落盘,每个账号一份。
 *
 * ## 它防的是「毒消息无限循环」
 *
 * 某条来信触发崩溃 → 进程重启 → 游标还在起点 → 同一条被重放 → 再崩。这个循环里
 * 微信是**全聋**的,而日志上只有一串一模一样的崩溃,看不出是哪条消息干的。
 * 游标落盘之后,那条消息最多被重放一次;真正的隔离由连接层的单条 try/catch 做,
 * 两者一起才完整 —— 只有隔离没有落盘,崩溃(而非抛错)那一路仍然循环。
 *
 * 顺带解决了一个旧问题:重启会丢游标,于是重启后总要把服务端缓冲里的旧消息再收一遍。
 */
export class FileCursorStore implements CursorStore {
  private readonly map: Record<string, string>;

  constructor(private readonly path: string) {
    const raw = readJsonFile<Record<string, unknown>>(path, {});
    this.map = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && v) this.map[k] = v;
    }
  }

  get(accountId: string): string | undefined {
    return this.map[accountId];
  }

  set(accountId: string, updatesBuf: string): void {
    if (this.map[accountId] === updatesBuf) return;
    this.map[accountId] = updatesBuf;
    // 写失败不抛:游标写不进去的后果是"重启后多收一批旧消息"(由 msgId 去重消化),
    // 而抛出去会掀翻正在跑的长轮询 —— 那是明显更坏的一侧。
    try {
      writeJsonFileAtomic(this.path, this.map);
    } catch (err) {
      console.warn(`[courier] 游标落盘失败(不影响本轮):${String(err)}`);
    }
  }
}
