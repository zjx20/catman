import { readJsonFile, writeJsonFileAtomic } from "../core/file-store.js";
import { canonicalOf } from "../core/commands.js";
import { parseSendKind, type SendKind } from "../ipc/protocol.js";
import type { ReplyStore } from "./reply-store.js";

/**
 * 发件队列 —— 发不出去的消息在这里等额度回来,而不是就地丢掉。
 *
 * ## 它取代了什么
 *
 * 从前发送是**一次性**的:额度用尽时 `begin()` 拒绝,调用方吞掉异常记一行日志,
 * 那条消息就没了。最坏的一种没了是**正文** —— 用户等了几分钟的答案,只在日志里
 * 留下一行 `发正文失败`。
 *
 * 有了队列之后,"丢了"这件事本身消失了:发不出去就排队,下一条来信带来新的
 * `context_token`(计数归零),排空继续。
 *
 * ## 为什么住在信使
 *
 * ① 人格每周被自动进化重启、每次部署重启,队列放那边等于一次部署清空积压 ——
 *    而积压里正是那条还没送出去的答案;
 * ② 预算的权威在信使(`ReplyStore`),队列必须和它在同一个进程里,否则又成了两本账;
 * ③ 守护人格可能同时在往同一个 token 发东西,只有信使看得见全部。
 *
 * ## 队列只管顺序与去重,不管预算
 *
 * 预算的规则**全部**在 `reply-store.ts`:9 格谁先来谁用,最后 1 格只给额度提示。
 * 这里不再另记一本账 —— 从前这里有 `mustYield` / `claim` 这样一套并行的保留逻辑,
 * 只拦正文那一类,于是别的类别成了例外(2026-09-07 空闲提醒就这样吃掉了最后一格,
 * 早上的日报进了队列却没人说一声)。现在队列只问 `begin()` 的结果:发得出去就发,
 * 被拒就排队;因额度被拒时说一句提示,而提示能不能说、说过没有,也归 `ReplyStore` 管。
 *
 * ## 队列不是 FIFO,是**按 kind 定策略**
 *
 * 进度是"现在在干什么"这个**状态**,不是必须完整送达的流水。积压十分钟之后把当时
 * 那句「🔧 Bash: npm test」补发出去毫无意义,还白烧一格额度。所以每种 kind 的
 * 排队策略不同,见 `POLICY`。
 *
 * ## 排空:限速,但不留余地
 *
 * **限速**:一口气连发十几条容易被微信判成骚扰,而且那也不是人说话的样子。
 * 两条之间至少隔 `PACE_MS`。
 *
 * **不留余地**:新 token 的 9 格全用来还旧账,发到额度见底为止;没发完就说一句
 * "还有 N 条",用户再发一句 `/nop`。从前这里停在"还剩 4 格"以便用户的新问题能当场
 * 得到答案 —— 代价是旧消息与新消息乱序,而且 `/nop` 本身不是新问题,专门为续额度
 * 发的那句话被回敬一句"还有 N 条"很怪。按使用经验,积压很少多到发不完。
 *
 * ## 因额度入队的那一刻就得说
 *
 * 队列保证了消息不丢,但**没保证用户知道有东西没发出去**。他看到的只是话说到一半
 * 就停了,与卡死无从分辨 —— 而解药(发一句 `/nop`)恰恰只有那句提示会告诉他。
 * 真机上就这么静默过三次:14 分钟、2 小时 24 分、6 小时。
 *
 * 所以:**一条消息因为额度进了队列,当场就说提示**,不等下次排空(排空要等下一条
 * 来信来催,而用户正是因为没收到提示才不知道该开口 —— 那是个死锁)。
 * 因排序进队列的(队列非空、新消息排队尾)不说:那不是额度的事,排空马上就把它带出去。
 */

/** 两条排队消息之间至少隔多久。见文件头「限速」。 */
const PACE_MS = 1_500;

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
 * - `drop` 压根不排队。回执:"收到,正在处理中…"要是当场发不出去,等排到它时
 *   答案多半已经发过了,那时再补一句只会让人以为又要重来一轮。额度提示:它说的
 *   就是"现在发不出去",排队等发得出去的时候再说是自相矛盾;而且它有自己的格,
 *   发不出去只有一种可能 —— 这份 token 已经说过了。
 */
const POLICY: Record<SendKind, "append" | "replace" | "drop"> = {
  ack: "drop",
  progress: "replace",
  reminder: "replace",
  body: "append",
  fallback: "append",
  announce: "append",
  budget: "drop",
};

export interface OutboxItem {
  readonly kind: SendKind;
  readonly text: string;
  /** 入队时刻。只用于诊断 —— 排空顺序看的是数组顺序。 */
  readonly at: number;
}

export interface OutboxOptions {
  /** 预算的权威。队列只问它"还能发几条"与"提示欠着没有",自己不记账。 */
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
    // 答案来了,排在它前面的那些"正在算"就没有意义了 —— 清掉,别让它们挡路。
    //
    // 不清的话有个很坏的连锁:被拒的进度留在队里,队列从此非空,
    // 于是**答案再也走不了直发那条路**(队列非空一律排队尾)。
    if (POLICY[kind] === "append") this.dropSuperseded(userKey);
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
    if (queued) {
      // 因排序入队,不是因额度 —— 不说提示,排空马上就把它带出去。
      this.enqueue(userKey, text, kind);
      this.kick(userKey);
      return;
    }
    // **队列空着就直接试一次,不先问额度。** 问了反而更糟:预算的判断在渠道那一侧
    // (`begin()`),它拒绝时**不计数**,所以试一次是免费的;而在这里自己判一遍,
    // 等于把 iLink 的预算概念硬塞给所有渠道 —— 没有 replyCtx 的用户会连试都不试。
    try {
      await this.opts.deliver(userKey, text, kind);
    } catch (err) {
      // 发失败也要留住它 —— 这正是队列存在的理由。**但不立刻重试**:
      // 刚失败的那一下多半会再失败一次,而失败的尝试照样烧额度。
      this.enqueue(userKey, text, kind);
      await this.afterRefused(userKey, kind, err);
    }
  }

  /**
   * 一条消息被渠道拒了、已经入队 —— 判断是不是额度的事,是就当场说提示。
   *
   * 「额度用尽」是设计的一部分(核心不知道额度,一路推到被拒为止),长回合里每分钟
   * 都会发生 —— 按 warn 打就是拿预期行为刷屏,真正的异常反而淹在里面。所以额度
   * 那条路打 info,其余(信使不可达、token 死了)才是 warn。
   */
  private async afterRefused(userKey: string, kind: SendKind, err: unknown): Promise<void> {
    const budget = !!this.opts.replies.target(userKey) && this.opts.replies.remainingSends(userKey) <= 0;
    if (!budget) {
      console.warn(`[outbox] ${userKey} 的 ${kind} 发送失败,留在队列里等下一条来信:${String(err)}`);
      return;
    }
    console.info(`[outbox] ${userKey} 的 ${kind} 因额度用尽入队(积压 ${this.depth(userKey)} 条)`);
    await this.noticeExhausted(userKey);
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

  /**
   * 排空:一条条发,发到队列空或额度见底。**不留余地**,见文件头。
   *
   * 额度见底而队列未空时说一句"还有 N 条" —— 这里报得出准确条数,队列是稳定的。
   */
  private async pump(userKey: string): Promise<void> {
    while (this.running) {
      const q = this.queues.get(userKey);
      if (!q?.length) return;
      if (this.opts.replies.target(userKey) && this.opts.replies.remainingSends(userKey) <= 0) {
        await this.noticeBacklog(userKey);
        return;
      }
      try {
        await this.opts.deliver(userKey, q[0]!.text, q[0]!.kind);
      } catch (err) {
        // 留着它,等下一条来信再试。**不在这里重试**:token 废掉时是永不恢复的,
        // 原地重试就成了拿失败去烧剩下的额度。
        //
        // 被拒的原因可能就是额度 —— 在飞回合与排空同时在发,余量在上面那句判断
        // 与这次投递之间被别人用掉了。那时该说的仍然是"还有 N 条",不能静默返回。
        await this.afterRefused(userKey, q[0]!.kind, err);
        return;
      }
      q.shift();
      if (!q.length) this.queues.delete(userKey);
      this.flush();
      if (this.queues.has(userKey)) await this.sleep(this.opts.paceMs ?? PACE_MS);
    }
  }

  /**
   * 消息因额度进了队列时的那句提示。**不报条数**:这一刻回合可能还在跑,后面还有
   * 几段正文要交进来,此时数出来的"还有 1 条"下一秒就成了假话。
   *
   * 说不说、说过没有,都由 `ReplyStore` 判:它是预算的权威,保留格是它留的。
   */
  private async noticeExhausted(userKey: string): Promise<void> {
    if (!this.opts.replies.noticePending(userKey)) return;
    await this.deliverOrDrop(userKey, exhaustedText(), "budget");
  }

  /** 排空停下时的那句提示。队列稳定,报得出准确条数。 */
  private async noticeBacklog(userKey: string): Promise<void> {
    if (!this.opts.replies.noticePending(userKey)) return;
    await this.deliverOrDrop(userKey, backlogText(this.depth(userKey)), "budget");
  }

  /**
   * 清掉被内容作废的那些排队进度。**不记进 `dropped`** —— 那个计数是给
   * "本不该丢却丢了"的东西看的,而进度过期本就是 `replace` 策略的日常。
   */
  private dropSuperseded(userKey: string): void {
    const q = this.queues.get(userKey);
    if (!q?.some((x) => x.kind === "progress")) return;
    const kept = q.filter((x) => x.kind !== "progress");
    if (kept.length) this.queues.set(userKey, kept);
    else this.queues.delete(userKey);
    this.flush();
  }

  private async deliverOrDrop(userKey: string, text: string, kind: SendKind): Promise<void> {
    try {
      await this.opts.deliver(userKey, text, kind);
      if (kind === "budget") {
        console.info(`[outbox] ${userKey} 已发额度提示(积压 ${this.depth(userKey)} 条)`);
      }
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

/**
 * 消息因额度进队列时说的那句话。口令从指令表取,避免与 `/nop` 的规范形式脱节。
 *
 * 措辞刻意平淡:不说"这条来信的额度"(用户没有"来信"这个概念),不说"答案可能只发了
 * 一半"(那只是众多情形之一,多数时候排队的是进度或播报)。只说三件事:额度没了、
 * 还有东西没发、怎么续。
 */
export function exhaustedText(): string {
  return `回信额度已用完,还有更多消息待发送。发一句 ${canonicalOf("nop")} 补充额度,我接着发。`;
}

/** 排空停下时说的那句话,与上面同一口径,只是报得出条数。 */
export function backlogText(pending: number): string {
  return `回信额度已用完,还有 ${pending} 条消息待发送。发一句 ${canonicalOf("nop")} 补充额度,我接着发。`;
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
