import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { IPC_SCHEMA, parseInbound, type InboundEnvelope } from "../ipc/protocol.js";

/**
 * 每人格一个的持久化收件队列。
 *
 * ## 为什么必须持久化,以及为什么是 at-least-once
 *
 * 「部署窗口不丢消息」这句话,只有队列**跨重启存活**时才成立 —— 否则信使自己被换一次
 * (它跑 pinned release,人工 bless 时会重启)就把攒着的消息全丢了。
 *
 * 更要紧的是 **ack 的时机**。评审毙掉了"拉走即出队"(at-most-once):消息被人格拉走后,
 * 还要在聚合窗口里待 1.5 秒以上才变成回合 —— 此刻崩溃或被部署杀掉,它既不在信使的
 * 缓冲里、也没进回合,**真丢**;而信使按"拉取间隔"判活,恰好判不出这种死法。
 * 所以约定是:**人格把消息落进自己的批之后才 ack**,在那之前它一直留在这里。
 *
 * 代价是重复投递,由 msgId 幂等去重消化 —— 那是廉价的,而丢消息不是。
 *
 * ## 没有 inflight 状态
 *
 * `peek()` 每次都返回同一批未 ack 的队头,直到 ack 才出队。这样"人格拉走后崩了"
 * 不需要任何租约/超时机制来兜底:它重启后再拉,拿到的还是那批。
 * 引入 inflight 反而会多出"租约没到期但进程已经没了"这个必须靠时间猜的状态。
 *
 * ## 落盘格式
 *
 * 单个 append-only JSONL,两种记录:入队 `{"t":"m",...}` 与出队 `{"t":"a","id":...}`。
 * 崩溃时最多丢最后一条没写完的行(解析失败即跳过)。启动时重放并**压实重写**一次,
 * 于是文件不会因为长期运行而无限增长。
 */

interface AckRecord {
  readonly t: "a";
  readonly id: string;
}

/** 缓冲的字节上限。超了丢**最旧**的并计数 —— 见 push 的说明。 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** 累计出队多少条之后压实一次日志。纯粹是"别让文件无限长"的工程值。 */
const COMPACT_EVERY = 200;

export interface InboxOptions {
  /** JSONL 路径,如 /data/courier/inbox/primary.jsonl。 */
  path: string;
  maxBytes?: number;
}

export class Inbox {
  private readonly maxBytes: number;
  private queue: InboundEnvelope[] = [];
  private bytes = 0;
  private acksSinceCompact = 0;
  /** 因为超出字节上限被丢掉的条数。只增,供告警与 /health。 */
  private dropped = 0;

  constructor(private readonly opts: InboxOptions) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    mkdirSync(dirname(opts.path), { recursive: true });
    this.replay();
    // 启动即压实:重放之后内存里就是真相,把它写回去,日志长度回到与队列等长。
    this.compact();
  }

  /**
   * 入队。**这是唯一会增长队列的地方**,而它只在信使把一条来信完整处理完
   * (含图片下载解密落盘)之后调用 —— 「图 + 文字」那 120ms 的顺序保证在新边界上
   * 就是靠这一条重建的:入队顺序严格等于到达顺序。
   */
  push(env: InboundEnvelope): void {
    const line = JSON.stringify({ t: "m", ...env });
    appendFileSync(this.opts.path, `${line}\n`, "utf8");
    this.queue.push(env);
    this.bytes += line.length;
    this.evictIfNeeded();
  }

  /**
   * 看一眼队头(**不出队**)。同一批会被反复返回直到 ack —— 见文件头「没有 inflight」。
   */
  peek(limit: number): readonly InboundEnvelope[] {
    return this.queue.slice(0, Math.max(0, limit));
  }

  /**
   * 出队。返回**真正出队的条数** —— 重复 ack 是正常现象(人格重试),
   * 但它不该被当成"又消化了几条"记进任何计数。
   */
  ack(msgIds: readonly string[]): number {
    if (!msgIds.length) return 0;
    const want = new Set(msgIds);
    const before = this.queue.length;
    const kept: InboundEnvelope[] = [];
    let freed = 0;
    for (const env of this.queue) {
      if (want.has(env.msgId)) {
        freed += JSON.stringify({ t: "m", ...env }).length;
        appendFileSync(this.opts.path, `${JSON.stringify({ t: "a", id: env.msgId })}\n`, "utf8");
      } else {
        kept.push(env);
      }
    }
    this.queue = kept;
    this.bytes = Math.max(0, this.bytes - freed);
    const removed = before - kept.length;
    this.acksSinceCompact += removed;
    if (this.acksSinceCompact >= COMPACT_EVERY) this.compact();
    return removed;
  }

  /**
   * 待拉取 + 未 ack 的条数。
   *
   * **排水的第二个真相源**:只看人格 `/health` 的三个计数是"假清零" —— 那三个数只
   * 覆盖已经拉进人格的消息,还躺在这里的那些一条都不算。评审确认过这一点。
   */
  depth(): number {
    return this.queue.length;
  }

  /** 因为溢出被丢掉的累计条数。非零就该在状态页与日志里显眼。 */
  droppedCount(): number {
    return this.dropped;
  }

  // --- 内部 ---

  /**
   * 溢出时丢**最旧**的。
   *
   * 丢旧不丢新是因为:目标人格长时间不拉取(死了/卡了)才会堆到上限,而那时最新的
   * 几条才是用户正在说的话;丢新等于"越是刚说的越收不到"。丢掉的条数必须计数 ——
   * 静默丢弃在用户那边就是"发了没反应",而这是我们整套设计最想消灭的症状。
   */
  private evictIfNeeded(): void {
    while (this.bytes > this.maxBytes && this.queue.length > 1) {
      const oldest = this.queue.shift()!;
      this.bytes -= JSON.stringify({ t: "m", ...oldest }).length;
      this.dropped += 1;
      appendFileSync(this.opts.path, `${JSON.stringify({ t: "a", id: oldest.msgId })}\n`, "utf8");
      console.warn(
        `[courier] inbox ${this.opts.path} 超过 ${this.maxBytes} 字节,丢弃最旧的一条` +
          `(${oldest.userKey},累计丢弃 ${this.dropped} 条)`,
      );
    }
  }

  /** 重放日志。**单行读不懂就跳过**:崩溃时最后一行可能只写了一半。 */
  private replay(): void {
    if (!existsSync(this.opts.path)) return;
    let raw: string;
    try {
      raw = readFileSync(this.opts.path, "utf8");
    } catch {
      return;
    }
    const byId = new Map<string, InboundEnvelope>();
    const order: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // 半截行:崩溃时最多这一条
      }
      const t = (rec as Record<string, unknown>)["t"];
      if (t === "a") {
        const id = (rec as AckRecord).id;
        if (typeof id === "string") byId.delete(id);
        continue;
      }
      const env = parseInbound(rec);
      if (!env) continue;
      if (!byId.has(env.msgId)) order.push(env.msgId);
      byId.set(env.msgId, env);
    }
    // 按首次入队顺序还原 —— 顺序本身是语义(图文那对靠它)。
    this.queue = order.map((id) => byId.get(id)).filter((x): x is InboundEnvelope => !!x);
    this.bytes = this.queue.reduce((n, e) => n + JSON.stringify({ t: "m", ...e }).length, 0);
  }

  /** 压实:把内存里的队列整份写回去。tmp + rename,半截文件读起来就是"队列空了"。 */
  private compact(): void {
    const tmp = `${this.opts.path}.tmp`;
    const body = this.queue.map((e) => `${JSON.stringify({ t: "m", ...e })}\n`).join("");
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, this.opts.path);
    this.acksSinceCompact = 0;
  }
}

/** 生成一个 msgId。单调 + 随机,重启后也不会与旧的撞。 */
export function makeMsgId(seq: number, rand: () => string): string {
  return `${seq.toString(36)}-${rand()}`;
}

/** 一条空信封的形状,给调用方拼消息时对齐字段用。 */
export function inboundOf(
  fields: Omit<InboundEnvelope, "schema">,
): InboundEnvelope {
  return { schema: IPC_SCHEMA, ...fields };
}
