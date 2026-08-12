import { readJsonFile, writeJsonFileAtomic } from "../core/file-store.js";
import { canonicalOf } from "../core/commands.js";
import { parseSendKind, type SendKind } from "../ipc/protocol.js";
import { LIVE_TURN_SENDS, type ReplyStore } from "./reply-store.js";

/**
 * 发件队列 —— 发不出去的消息在这里等额度回来,而不是就地丢掉。
 *
 * ## 它取代了什么
 *
 * 从前发送是**一次性**的:额度用尽时 `begin()` 拒绝,调用方吞掉异常记一行日志,
 * 那条消息就没了。最坏的一种没了是**正文** —— 用户等了几分钟的答案,只在日志里
 * 留下一行 `发正文失败`。保留额(`RESERVED_SENDS`)存在的全部理由就是给这类
 * "丢了就没有第二次"的消息占位子。
 *
 * 有了队列之后,"丢了"这件事本身消失了:发不出去就排队,下一条来信带来新的
 * `context_token`(计数归零),排空继续。于是保留额从**安全机制**降级成
 * **时延旋钮** —— 它现在只决定"答案是当场就到,还是等用户刷一下额度",
 * 所以从 4 格砍到 2 格(正文 + 额度提示)。
 *
 * ## 为什么住在信使
 *
 * ① 人格每周被自动进化重启、每次部署重启,队列放那边等于一次部署清空积压 ——
 *    而积压里正是那条还没送出去的答案;
 * ② 预算的权威在信使(`ReplyStore`),队列必须和它在同一个进程里,否则又成了两本账;
 * ③ 守护人格可能同时在往同一个 token 发东西,只有信使看得见全部。
 *
 * ## 队列不是 FIFO,是**按 kind 定策略**
 *
 * 进度是"现在在干什么"这个**状态**,不是必须完整送达的流水。积压十分钟之后把当时
 * 那句「🔧 Bash: npm test」补发出去毫无意义,还白烧一格额度。所以每种 kind 的
 * 排队策略不同,见 `POLICY`。这正是 `SendKind` 换了岗位:从"预留几条"变成
 * "发不出去时怎么办"。
 *
 * ## 排空要留余地,也要限速
 *
 * **限速**:一口气连发十几条容易被微信判成骚扰,而且那也不是人说话的样子。
 * 两条之间至少隔 `PACE_MS`。
 *
 * **留余地**:排空停在 `DRAIN_FLOOR` 而不是 0。用户刚发的那条消息也需要额度 ——
 * 回执、进度、以及这一轮的答案。把新额度全用来还旧账,等于让他每问一句都得先
 * 替上一轮买单。停下时队列还没空的话说一句"还有 N 条",那句话本身就是下一次
 * 排空的开关。
 */

/** 两条排队消息之间至少隔多久。见文件头「限速」。 */
const PACE_MS = 1_500;

/**
 * 排空停在还剩几条时 —— 留给用户刚发的这一轮:回执 + 答案 + 那句"还有 N 条"。
 *
 * 填 0 的话新问题的答案会排在旧积压后面,而他要的是新问题的答案。
 * 取自那笔账而不是另写一个常量:`SEND_BUDGET` 一动(20 试过、又改回 10),
 * 排空的余地必须跟着动。
 */
const DRAIN_FLOOR = LIVE_TURN_SENDS;

/** 每个用户最多积压几条。到顶了先丢可丢的,见 `enqueue`。 */
const MAX_ITEMS_PER_USER = 40;

/** 单个用户积压的总字数上限。正文可以很长,只数条数挡不住内存。 */
const MAX_CHARS_PER_USER = 200_000;

/**
 * 每种 kind 发不出去时怎么办。
 *
 * - `append` 一条不丢,严格保序。正文、部署结果播报、兜底说明属于这类:
 *   它们各说各的事,少一条就是少一件事。
 * - `replace` 只留最新的一条。进度与会话空闲提醒属于这类 —— 它们描述的是
 *   **当前状态**,旧的那条在新的面前没有意义。
 * - `drop` 压根不排队。只有回执:"收到,正在处理中…"要是当场发不出去,等排到它时
 *   答案多半已经发过了,那时再补一句只会让人以为又要重来一轮。
 */
const POLICY: Record<SendKind, "append" | "replace" | "drop"> = {
  ack: "drop",
  progress: "replace",
  reminder: "replace",
  body: "append",
  fallback: "append",
  announce: "append",
};

export interface OutboxItem {
  readonly kind: SendKind;
  readonly text: string;
  /** 入队时刻。只用于诊断 —— 排空顺序看的是数组顺序。 */
  readonly at: number;
}

export interface OutboxOptions {
  /** 预算的权威。队列只问它"还能发几条",自己不记账。 */
  readonly replies: ReplyStore;
  /** 真把字节发出去(渠道)。 */
  deliver(userKey: string, text: string, kind: SendKind): Promise<void>;
  /**
   * 落盘路径。省略 = 只在内存里(单测)。
   *
   * 真机上**必须落盘**:信使重启(bless、改配置、OOM)时积压里可能正躺着一条
   * 已经跑完却还没送出去的答案,而队列存在的全部意义就是别丢它。
   */
  readonly path?: string;
  now?: () => number;
  /** 两条排队消息之间的间隔。只为单测可注入 —— 真机用 `PACE_MS`。 */
  readonly paceMs?: number;
}

interface Persisted {
  [userKey: string]: OutboxItem[];
}

export class Outbox {
  private readonly now: () => number;
  private readonly queues = new Map<string, OutboxItem[]>();
  /** 每个用户至多一个在跑的排空循环。 */
  private readonly pumping = new Map<string, Promise<void>>();
  /**
   * 排空跑着的时候又被催了一次 —— 跑完要再跑一遍。
   *
   * **少了这个就是丢催促**:上一轮可能正停在"额度不够"那句判断上、或者正睡在限速里,
   * 而这一次催促带来的恰恰是新额度。表现出来就是用户发了 `/nop` 却什么也没发生,
   * 得再发一句才动 —— 而那句提示正是我们让他信的。
   */
  private readonly rekick = new Set<string>();
  /**
   * 已经就哪一份 context_token 提示过额度的事 —— 每份只说一次,不刷屏。
   *
   * "进度报到头了"和"还有 N 条没发"共用这一份记录:两句话结尾都是"发 /nop",
   * 同一个 token 里说两遍就是噪音。
   */
  private readonly hinted = new Map<string, string>();
  /** 睡在限速里的那些,stop() 时叫醒。 */
  private waking: Array<() => void> = [];
  private running = true;
  private droppedCount = 0;

  constructor(private readonly opts: OutboxOptions) {
    this.now = opts.now ?? (() => Date.now());
    if (!opts.path) return;
    // 防御式:盘上某个用户的记录形状不对只丢那一个人的积压。抛错会让信使起不来,
    // 那是所有人都收不到任何东西。
    const raw = readJsonFile<Persisted>(opts.path, {});
    for (const [userKey, v] of Object.entries(raw)) {
      const items = parseItems(v);
      if (items.length) this.queues.set(userKey, items);
    }
  }

  /**
   * 交一条消息出去。**有额度就当场发,没有就排队**,两种都算收下了。
   *
   * 队列非空时新消息一律排到队尾,不插队 —— 顺序在聊天里是有意义的,
   * "先回答上一个问题"这件事必须看得出来。
   */
  async submit(userKey: string, text: string, kind: SendKind): Promise<void> {
    const queued = this.queues.get(userKey)?.length ?? 0;
    if (POLICY[kind] === "drop") {
      // 排不上队的那类:当场发得出去就发,发不出去就算了(还要记一笔)。
      if (queued) {
        this.droppedCount += 1;
        return;
      }
      await this.deliverOrDrop(userKey, text, kind);
      return;
    }
    // **队列空着就直接试一次,不先问额度。** 问了反而更糟:预算的判断在渠道那一侧
    // (`begin()`),它拒绝时**不计数**,所以试一次是免费的;而在这里自己判一遍,
    // 等于把 iLink 的预算概念硬塞给所有渠道 —— 没有 replyCtx 的用户会连试都不试。
    if (!queued) {
      try {
        await this.opts.deliver(userKey, text, kind);
        return;
      } catch (err) {
        // 发失败也要留住它 —— 这正是队列存在的理由。**但不立刻重试**:
        // 刚失败的那一下多半会再失败一次,而失败的尝试照样烧额度。
        //
        // 「进度撞上限」不算异常,它是设计的一部分(核心不知道额度,一路推到被拒
        // 为止),长回合里每分钟都会发生一次 —— 按 warn 打就是拿预期行为刷屏,
        // 真正的异常反而淹在里面。
        const expected = kind === "progress" && this.opts.replies.remainingProgress(userKey) <= 0;
        if (!expected) console.warn(`[outbox] ${userKey} 直发失败,转入队列:${String(err)}`);
        await this.queueIt(userKey, text, kind);
        return;
      }
    }
    await this.queueIt(userKey, text, kind);
    this.kick(userKey);
  }

  /**
   * 入队,并在该说的时候说那句"进度报到头了"。
   *
   * 两条路都要走这里:队列本来就非空时是直接入队,队列空着时是**直发失败之后**
   * 入队 —— 而进度撞上限恰恰走的是后面那条(它是被渠道拒的)。
   */
  private async queueIt(userKey: string, text: string, kind: SendKind): Promise<void> {
    this.enqueue(userKey, text, kind);
    if (kind === "progress") await this.noticeProgressCapped(userKey);
  }

  /**
   * 额度可能回来了,催一下排空。
   *
   * 由信使在**每条来信**进来时调 —— iLink 的每条来信都换一份新的 `context_token`,
   * 计数随之归零,那就是积压唯一等得到的东西。
   */
  kick(userKey: string): void {
    if (!this.running) return;
    // 正在跑就记一笔,等它跑完再来一遍 —— 直接返回会把这次催促连同它带来的
    // 新额度一起丢掉(见 `rekick`)。
    if (this.pumping.has(userKey)) {
      this.rekick.add(userKey);
      return;
    }
    if (!this.queues.get(userKey)?.length) return;
    const p = this.pump(userKey)
      .catch((err) => console.warn(`[outbox] ${userKey} 排空意外失败:${String(err)}`))
      .finally(() => {
        this.pumping.delete(userKey);
        if (this.rekick.delete(userKey)) this.kick(userKey);
      });
    this.pumping.set(userKey, p);
  }

  /** 还积压着几条。不给 userKey 就是全部人的总和。供 /health 与状态页。 */
  depth(userKey?: string): number {
    if (userKey !== undefined) return this.queues.get(userKey)?.length ?? 0;
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  /** 因为策略(回执)或容量上限被丢掉的条数。只增,非零就该在状态页显眼。 */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * 关停:停止排空并把在飞的那一轮等完。**队列本身不清空** —— 它已经落盘,
   * 下次起来接着发。
   */
  async stop(): Promise<void> {
    this.running = false;
    const wake = this.waking;
    this.waking = [];
    for (const w of wake) w();
    await Promise.all([...this.pumping.values()]).catch(() => undefined);
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private enqueue(userKey: string, text: string, kind: SendKind): void {
    const q = this.queues.get(userKey) ?? [];
    const item: OutboxItem = { kind, text, at: this.now() };
    if (POLICY[kind] === "replace") {
      const i = q.findIndex((x) => x.kind === kind);
      if (i >= 0) {
        // 换掉旧的那条,但**留在原来的位置**:它与前后那些正文的先后关系没变。
        q[i] = item;
        this.queues.set(userKey, q);
        this.flush();
        return;
      }
    }
    q.push(item);
    this.queues.set(userKey, q);
    this.trim(q, userKey);
    this.flush();
  }

  /**
   * 执行容量上限。**先丢可丢的**(进度、提醒),它们本来就是"最新那条才算数";
   * 真到了全是正文还超限,只能丢最旧的正文,那时要亮红灯 —— 那是在丢答案。
   */
  private trim(q: OutboxItem[], userKey: string): void {
    const over = (): boolean =>
      q.length > MAX_ITEMS_PER_USER ||
      q.reduce((n, x) => n + x.text.length, 0) > MAX_CHARS_PER_USER;
    while (over()) {
      const i = q.findIndex((x) => POLICY[x.kind] === "replace");
      const cut = i >= 0 ? i : 0;
      if (i < 0) {
        console.error(`[outbox] ${userKey} 积压超限,丢掉一条 ${q[0]!.kind} —— 这是在丢内容`);
      }
      q.splice(cut, 1);
      this.droppedCount += 1;
    }
  }

  private async pump(userKey: string): Promise<void> {
    while (this.running) {
      const q = this.queues.get(userKey);
      if (!q?.length) return;
      if (this.opts.replies.remainingSends(userKey) <= DRAIN_FLOOR) {
        await this.noticeBacklog(userKey, q.length);
        return;
      }
      try {
        await this.opts.deliver(userKey, q[0]!.text, q[0]!.kind);
      } catch (err) {
        // 留着它,等下一条来信再试。**不在这里重试**:token 废掉时是永不恢复的,
        // 原地重试就成了拿失败去烧剩下的额度。
        console.warn(`[outbox] ${userKey} 排空时发送失败,留在队列里:${String(err)}`);
        return;
      }
      q.shift();
      if (!q.length) this.queues.delete(userKey);
      this.flush();
      if (this.queues.has(userKey)) await this.sleep(this.opts.paceMs ?? PACE_MS);
    }
  }

  /**
   * 停在积压上时说一句"还有 N 条"。
   *
   * **每份 context_token 只说一次**:说这句话本身也要花一格额度,而积压期间
   * 每条来信都会走到这里。同一个 token 反复说 = 用剩下的额度刷屏,而不是发积压。
   */
  private async noticeBacklog(userKey: string, pending: number): Promise<void> {
    if (!this.claimHint(userKey)) return;
    await this.deliverOrDrop(userKey, backlogText(pending), "reminder");
  }

  /**
   * 进度额度到头时说一句"后面没了,发 /nop 可以续上"。
   *
   * **这句话归信使说,不归人格说。** 人格那边不该知道预算这回事(那是渠道的事),
   * 而知道预算的是这里。触发条件写成"进度**被拒**了"而不是"余量等于 1",
   * 顺带得到一个好性质:还带着自己那份余量判断的老人格根本不会撞到这个条件
   * (它在上限之前就收手了),于是新旧两侧不会各说一遍。
   *
   * 例外是罕见的抢跑:人格手里的余量落后一条时会多发一条被拒的进度,那时两边
   * 可能各说一次。要等人格侧那份判断删掉之后才彻底没有 —— 那是下一步的事。
   */
  private async noticeProgressCapped(userKey: string): Promise<void> {
    if (this.opts.replies.remainingProgress(userKey) > 0) return;
    if (!this.claimHint(userKey)) return;
    await this.deliverOrDrop(userKey, progressCapText(), "reminder");
  }

  /** 这份 token 还没提示过就占下它,返回 true。提示本身也花一格,所以只说一次。 */
  private claimHint(userKey: string): boolean {
    const token = this.opts.replies.target(userKey)?.contextToken;
    if (!token || this.hinted.get(userKey) === token) return false;
    if (this.opts.replies.remainingSends(userKey) <= 0) return false;
    this.hinted.set(userKey, token);
    return true;
  }

  private async deliverOrDrop(userKey: string, text: string, kind: SendKind): Promise<void> {
    try {
      await this.opts.deliver(userKey, text, kind);
    } catch (err) {
      this.droppedCount += 1;
      console.warn(`[outbox] ${userKey} 的 ${kind} 发不出去,丢弃:${String(err)}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      // **不 unref**:它欠着一次投递。unref 掉的话进程会在积压还没发完时退出,
      // 而队列存在的理由正是别丢那些。
      this.waking.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private flush(): void {
    if (!this.opts.path) return;
    const out: Persisted = {};
    for (const [k, v] of this.queues) if (v.length) out[k] = v;
    // 0600:积压里有正文,那是对话内容。
    writeJsonFileAtomic(this.opts.path, out, 0o600);
  }
}

/** 停在积压上时说的那句话。口令从指令表取,避免与 `/nop` 的规范形式脱节。 */
export function backlogText(pending: number): string {
  return `还有 ${pending} 条没发出去(这条来信的额度用完了)。发一句 ${canonicalOf("nop")} 我接着发。`;
}

/** 进度额度到头时说的那句话。 */
export function progressCapText(): string {
  return (
    `进度就报到这儿,接下来直接等答案。` +
    `想接着看进度就发一句 ${canonicalOf("nop")} —— 它什么也不做,只把额度续上。`
  );
}

function parseItems(v: unknown): OutboxItem[] {
  if (!Array.isArray(v)) return [];
  const out: OutboxItem[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const kind = parseSendKind(r["kind"]);
    const text = r["text"];
    if (!kind || typeof text !== "string" || !text) continue;
    const at = typeof r["at"] === "number" && Number.isFinite(r["at"]) ? r["at"] : 0;
    out.push({ kind, text, at });
  }
  return out;
}
