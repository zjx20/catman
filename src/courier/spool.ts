import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageMediaType } from "../core/attachments.js";
import type { AttachmentRef } from "../ipc/protocol.js";

/**
 * 附件的落盘中转。
 *
 * ## 为什么字节不进 IPC、也不进队列
 *
 * 一张图 base64 之后好几 MB。部署窗口里可能积压着**全体用户**的消息,让那些字节驻留在
 * 信使的内存队列里,等于让**最不该 OOM 的那个进程**去扛峰值 —— 信使死了两个人格
 * 一起聋。所以:信使解密后写进 spool(0600),IPC 只传引用,人格按 id 去读。
 *
 * ## 清理的时机
 *
 * **ack 之后才删**。人格拿到引用、把消息落进自己的批、ack —— 那之后字节才没用了。
 * 提早删的后果是人格重启后拿着引用读到 ENOENT,而消息还在队列里(未 ack),
 * 于是它会永远重试一条永远读不到图的消息。
 *
 * 另有一道**开机扫除**:进程被 SIGKILL 时没人删,残骸会一直占着磁盘。启动时按
 * 修改时间清掉超龄的孤儿 —— 队列里活着的引用一定比这个年龄新(它们要么正在被处理,
 * 要么已经因为超时被别的机制处理掉了)。
 */

/** 孤儿文件的保留时长。比"一条消息从入队到被 ack"的最坏情况长得多。 */
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

export interface SpoolOptions {
  dir: string;
  now?: () => number;
  /**
   * 目录总字节上限。超了就从最旧的开始删。
   *
   * **这道闸不能省。** inbox 的 8MB 上限管的是几百字节的信封,管不到真正占地方的
   * 图片字节;而磁盘满会让 dockerd 全面异常,那时连回滚都做不了 —— 整套自进化
   * 的最后一道防线跟着一起没。
   *
   * 代价说清楚:被删掉的图片如果还挂在队列里,人格读它会 ENOENT。那条路径已经
   * 有兜底(跳过这一张、文字与其余图片照常投递),所以退化是"少看一张图",
   * 而不是"消息丢了"。这个取舍是刻意的:磁盘满的代价大得多。
   */
  maxTotalBytes?: number;
}

/** spool 目录的默认总量上限。 */
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export class Spool {
  private readonly now: () => number;
  private readonly maxTotalBytes: number;
  private seq = 0;

  constructor(private readonly opts: SpoolOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    mkdirSync(opts.dir, { recursive: true });
    this.sweep();
  }

  /**
   * 写一份字节,返回给 IPC 用的引用。
   *
   * id 只用 `[0-9a-z-]`:它会被拼进路径,而**解析器那一层已经拒收带 `/` 或 `..` 的 id**
   * (见 ipc/protocol.ts)——两头都守着,免得将来某次改动把其中一头拿掉。
   */
  put(bytes: Uint8Array, mediaType: ImageMediaType, rand: () => string): AttachmentRef {
    const id = `${(this.seq += 1).toString(36)}-${rand()}.bin`;
    // 0600:图片是用户的私人内容,而 /data 在几个容器之间共享。
    writeFileSync(join(this.opts.dir, id), bytes, { mode: 0o600 });
    this.enforceCap();
    return { id, mediaType, bytes: bytes.length };
  }

  /** 读回字节。读不到返回 undefined —— 由调用方决定是跳过这张图还是重试整条消息。 */
  get(id: string): Uint8Array | undefined {
    const path = this.pathOf(id);
    if (!path) return undefined;
    try {
      return readFileSync(path);
    } catch {
      return undefined;
    }
  }

  /** ack 之后调用。删不掉不抛 —— 它只是占点磁盘,开机扫除还会再来一次。 */
  drop(ids: readonly string[]): void {
    for (const id of ids) {
      const path = this.pathOf(id);
      if (path) rmSync(path, { force: true });
    }
  }

  /**
   * 解析 id 到路径。**再守一次越界**:`..` 或分隔符一律拒绝。
   * 与解析器那一层重复是故意的 —— 这里是真正做文件 IO 的地方。
   */
  private pathOf(id: string): string | undefined {
    if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) return undefined;
    return join(this.opts.dir, id);
  }

  /**
   * 扫除超龄孤儿 + 执行总量上限。
   *
   * **公开且要被周期性调用**:只在构造函数里扫一次的话,一个跑几周的稳定面等于
   * 从不清扫 —— 而它恰恰是最不该把磁盘吃光的那个进程。
   */
  sweep(): void {
    this.sweepOrphans();
    this.enforceCap();
  }

  /** 总量超限就从最旧的开始删。见 maxTotalBytes 的说明(退化成"少看一张图")。 */
  private enforceCap(): void {
    let entries: Array<{ path: string; mtime: number; size: number }>;
    try {
      entries = readdirSync(this.opts.dir).flatMap((name) => {
        const path = join(this.opts.dir, name);
        try {
          const st = statSync(path);
          return st.isFile() ? [{ path, mtime: st.mtimeMs, size: st.size }] : [];
        } catch {
          return [];
        }
      });
    } catch {
      return;
    }
    let total = entries.reduce((n, e) => n + e.size, 0);
    if (total <= this.maxTotalBytes) return;
    entries.sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    for (const e of entries) {
      if (total <= this.maxTotalBytes) break;
      try {
        rmSync(e.path, { force: true });
        total -= e.size;
        removed += 1;
      } catch {
        // 删不掉就跳过:少腾一点空间好过让整个流程挂掉。
      }
    }
    console.warn(
      `[courier] spool 超过 ${this.maxTotalBytes} 字节,删掉最旧的 ${removed} 个附件` +
        "(还挂在队列里的那些会退化成「少看一张图」)",
    );
  }

  private sweepOrphans(): void {
    let names: string[];
    try {
      names = readdirSync(this.opts.dir);
    } catch {
      return;
    }
    const deadline = this.now() - ORPHAN_TTL_MS;
    let removed = 0;
    for (const name of names) {
      const path = join(this.opts.dir, name);
      try {
        if (!existsSync(path)) continue;
        if (statSync(path).mtimeMs < deadline) {
          rmSync(path, { force: true });
          removed += 1;
        }
      } catch {
        // 并发删除等竞态:少扫一个不值得让启动失败。
      }
    }
    if (removed) console.info(`[courier] spool 清理了 ${removed} 个超龄孤儿附件`);
  }
}
