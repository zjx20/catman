import { readJsonFile, writeJsonFileAtomic } from "../core/file-store.js";
import type { SendKind } from "../ipc/protocol.js";

/**
 * 回复上下文与**发送预算的唯一权威**。
 *
 * ## 那笔账
 *
 * iLink 的一个 `context_token` 能发几条是有限的:真机实测**第 11 条起**
 * `sendmessage` 返回 `ret=-2 prepare failed` 且**永不恢复** —— 之后连正文都发不出去,
 * 用户只收到"收到,正在处理中…"然后彻底静默。是条数不是时效(另一次记录里同一个
 * token 用到 4 分钟 7 条仍然正常),也不是限流(限流会放行,而它首败后 45 秒仍全败)。
 *
 * 这笔账原先记在网关顶部的常量里。搬到信使是因为**多了一个发送者**:守护人格可能
 * 也在往同一个 token 发东西,两边各按自己的数算就必然超发。预算必须有唯一权威。
 *
 *     SEND_BUDGET(20)
 *       − ack(1)                回执
 *       − 保留 4 条             正文 / 会话空闲提醒 / 部署结果播报 / 额度提示
 *       ────────────────────
 *       = 进度上限 15 条
 *
 * **保留就是靠进度的上限实现的**:进度撞到上限就再也发不出去,于是剩下的 4 条
 * 谁也抢不走。`fallback`(人格不可达时信使自己回的那句)与正文互斥,共用同一份保留额。
 *
 * 保留额里有 `announce` 是因为部署结果最不能丢 —— 用户接下来说的话都建立在
 * "改动已生效"这个前提上。有"额度提示"则见下。
 *
 * ## 额度花光了不是绝路,但得有人告诉他
 *
 * 用户随便发一句话就带来新的 `context_token`,计数跟着归零。`/nop` 就是为此存在的
 * 那句"随便的话":什么也不做,只把额度续上。
 *
 * 这句提示**单独占一格保留额**(`PROGRESS_CAP_NOTICE`,人格侧发),不附在最后一条
 * 进度的尾巴上 —— 它要是跟着进度走,就会跟进度一起被上限挤掉,而"进度用完了"
 * 正是它唯一该出现的时刻。占一格的代价是进度少一条,换来的是那段静默有个交代、
 * 而且交代里带着出路。
 *
 * ## 为什么按"尝试"计数而不是"成功"
 *
 * 失败的那一次有没有消耗服务端的额度,协议没说。两种猜法的代价完全不对称:
 * 多算一次只是少发一条进度;少算一次则可能把正文顶出预算,那是整段对话静默。
 * 所以按尝试计数,并把成功数单独记着 —— "第 4 次尝试但只成功过 1 条"这种形态
 * 是判断"到底是限流还是 token 死了"的关键,合成一个计数就看不出来了。
 *
 * ## 为什么落盘
 *
 * ① 计数丢了就会超发,而超发是不可恢复的;
 * ② replyCtx 本身持久化之后,**人格重启不再丢回信能力** —— 会话空闲提醒终于有机会
 *    送达(它的前提就是用户没再发消息,而 token 只在收到新消息时才更新)。
 *    这是信使架构送的礼物。
 */

/**
 * 一个 context_token 总共能发几条。别偷偷留余量 —— 余量在下面显式列支。
 *
 * **20 是在试,不是实测值。** 实测过的是 10(见文件头那段:第 11 条起 `ret=-2`
 * 且永不恢复)。放宽是因为 6 条进度在长回合里确实太紧,而那次观测已经有些日子了,
 * 服务端可能早就不是那个行为。
 *
 * **代价不对称,所以要盯着**:若 10 仍是硬上限,第 11 条起全败,而正文排在进度
 * 后面 —— 用户看到的就是"进度停住、答案永远不来",正是这套设计最想消灭的那个症状。
 * 判据是日志里那行 `send #11(前 10 条成功) … 失败 ret=-2 prepare failed`,
 * 真出现就把这里改回 10。
 */
export const SEND_BUDGET = 20;

/** 回执占 1 条。 */
const ACK_SENDS = 1;

/**
 * 给非进度用途预留的条数:正文 + 额度提示。
 *
 * **有了发件队列之后,保留额不再是安全机制。** 发不出去的消息现在进 `Outbox` 等额度
 * 回来,"丢了"这件事本身没有了 —— 而保留额存在的全部理由曾经就是给"丢了就没有第二次"
 * 的消息占位子。所以会话空闲提醒(`reminder`)与部署结果播报(`announce`)不再各占
 * 一格:它们排队,一条都不会少。
 *
 * 剩下这 2 格是**时延旋钮**,不是保险:
 * ① 正文 —— 让常见的那种长回合仍然当场就把答案发出去,而不是排队等用户刷额度;
 * ② 额度提示 —— "进度报到这儿,发 /nop 可以续上"那句话得有地方发,它是队列排空的开关。
 *
 * 提示走 `reminder` 而不新开一种 kind:**信使跑的是 pinned,版本天然比人格老**,
 * 而 `parseSendKind` 认不出的 kind 会让整个信封读不懂 —— 那句提示于是恰好在最需要
 * 它的时候消失。
 */
const RESERVED_SENDS = 2;

/** 一个回合里最多推几条进度。 */
export const MAX_PROGRESS_PER_TOKEN = SEND_BUDGET - ACK_SENDS - RESERVED_SENDS;

/** 每用户一份回复上下文。字段名会落盘,改名要考虑旧盘上的数据。 */
export interface ReplyContext {
  /** 发回去时用的**原始** from_user_id。归一化只服务我们自己的身份体系。 */
  readonly toUserId: string;
  readonly contextToken: string;
  /** 这份上下文入库的时刻,用来算"拿它发信时它已经多老了"。 */
  readonly cachedAt: number;
  /** 尝试发了几条(含失败)。预算按它算。 */
  attempts: number;
  /** 其中成功几条。与 attempts 分开记,见文件头。 */
  sent: number;
  /** 其中有几条是进度。进度的上限是保留额的实现方式。 */
  progress: number;
}

export interface SendPermit {
  readonly allowed: boolean;
  /** 还能再发几条**进度**。人格的节流器据此收缩。 */
  readonly remainingProgress: number;
  readonly reason?: string;
}

interface Persisted {
  [userKey: string]: ReplyContext;
}

export class ReplyStore {
  private readonly ctxs: Map<string, ReplyContext>;

  constructor(
    private readonly path: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    const raw = readJsonFile<Persisted>(path, {});
    this.ctxs = new Map();
    // 防御式:盘上的记录形状不对只丢那一条。丢了最坏是"这个人暂时收不到主动推送",
    // 而抛错会让信使起不来 —— 那是所有人都收不到任何东西。
    for (const [userKey, v] of Object.entries(raw)) {
      const c = parseCtx(v);
      if (c) this.ctxs.set(userKey, c);
    }
  }

  /**
   * 收到新来信:换一份上下文,**计数归零**。
   *
   * 计数的语义是「针对**这条来信**回了几条」。所以读日志时会看到:用户在回合进行中
   * 又发了一条,序号退回 #1 —— 那是对的,新来信带来新预算。
   */
  remember(userKey: string, toUserId: string, contextToken: string): void {
    // **同一个 token 不重置计数。** 计数的语义是"针对**这条来信**回了几条",而同一个
    // context_token 就是同一条来信 —— 重放(信使崩在"已入队、游标未落盘"之间时整批
    // 会重放)会让 remember 被同一个 token 调第二次,清零之后我们以为还有满额,
    // 于是超发,而超发是 `ret=-2` 且永不恢复。往保守一侧倒:只更新收件人,不动账。
    const existing = this.ctxs.get(userKey);
    if (existing && existing.contextToken === contextToken) {
      if (existing.toUserId !== toUserId) {
        this.ctxs.set(userKey, { ...existing, toUserId });
        this.flush();
      }
      return;
    }
    this.ctxs.set(userKey, {
      toUserId,
      contextToken,
      cachedAt: this.now(),
      attempts: 0,
      sent: 0,
      progress: 0,
    });
    this.flush();
  }

  get(userKey: string): ReplyContext | undefined {
    return this.ctxs.get(userKey);
  }

  /** 发给谁、用哪个 token。渠道只需要这两样,不该看到计数。 */
  target(userKey: string): { toUserId: string; contextToken: string } | undefined {
    const c = this.ctxs.get(userKey);
    return c ? { toUserId: c.toUserId, contextToken: c.contextToken } : undefined;
  }

  /**
   * 这条来信总共还能发几条(不分类别)。没有上下文时是 0。
   *
   * 发件队列据此决定"当场发还是排队",以及排空要停在哪儿。**它与
   * `remainingProgress` 是两个问题**:那个答的是"进度还能推几条"(人格的节流器问),
   * 这个答的是"这个 token 还剩多少"(队列问)。
   */
  remainingSends(userKey: string): number {
    const c = this.ctxs.get(userKey);
    if (!c) return 0;
    return Math.max(0, SEND_BUDGET - c.attempts);
  }

  /** 还能发几条进度。没有上下文时是 0(压根发不出去)。 */
  remainingProgress(userKey: string): number {
    const c = this.ctxs.get(userKey);
    if (!c) return 0;
    return Math.max(
      0,
      Math.min(MAX_PROGRESS_PER_TOKEN - c.progress, SEND_BUDGET - c.attempts),
    );
  }

  /**
   * 申请发一条。**允许则当场记账**(attempts 自增),不等结果 ——
   * 并发进来的发送因此拿到不同的序号,而硬指令与在飞回合确实会同时发消息。
   */
  begin(userKey: string, kind: SendKind): SendPermit {
    const c = this.ctxs.get(userKey);
    if (!c) {
      // iLink 协议**不支持主动推送**:没有这个用户最近一条来信的 context_token
      // 就真的发不出去。如实说,由调用方降级(网关对提醒本就是静默降级)。
      return { allowed: false, remainingProgress: 0, reason: "没有这个用户的回复上下文" };
    }
    if (c.attempts >= SEND_BUDGET) {
      return { allowed: false, remainingProgress: 0, reason: "这条来信的发送预算已用尽" };
    }
    if (kind === "progress" && c.progress >= MAX_PROGRESS_PER_TOKEN) {
      // 进度撞上限**不是错误**:它正是保留额起作用的样子。
      return {
        allowed: false,
        remainingProgress: 0,
        reason: "进度额度已用尽(正文与提醒的额度受保护)",
      };
    }
    c.attempts += 1;
    if (kind === "progress") c.progress += 1;
    this.flush();
    return { allowed: true, remainingProgress: this.remainingProgress(userKey) };
  }

  /** 记一次结果。只影响诊断计数,不影响预算(预算在 begin 时就扣了)。 */
  settle(userKey: string, ok: boolean): void {
    const c = this.ctxs.get(userKey);
    if (!c || !ok) return;
    c.sent += 1;
    this.flush();
  }

  /** 诊断行要用的三个量:第几次尝试、之前成功几条、这份上下文多老了。 */
  diag(userKey: string): { attempt: number; okBefore: number; ageMs: number } {
    const c = this.ctxs.get(userKey);
    if (!c) return { attempt: 0, okBefore: 0, ageMs: 0 };
    return { attempt: c.attempts, okBefore: c.sent, ageMs: this.now() - c.cachedAt };
  }

  /** 解绑/删账号时清掉。留着的话换人之后会拿旧 token 往新用户发信。 */
  forget(userKey: string): void {
    if (this.ctxs.delete(userKey)) this.flush();
  }

  private flush(): void {
    const out: Persisted = {};
    for (const [k, v] of this.ctxs) out[k] = v;
    // 0600:context_token 是能代替用户发消息的凭据,不该是 0644。
    writeJsonFileAtomic(this.path, out, 0o600);
  }
}

function parseCtx(v: unknown): ReplyContext | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const toUserId = r["toUserId"];
  const contextToken = r["contextToken"];
  if (typeof toUserId !== "string" || !toUserId) return undefined;
  if (typeof contextToken !== "string" || !contextToken) return undefined;
  const num = (k: string): number => {
    const x = r[k];
    return typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
  };
  return {
    toUserId,
    contextToken,
    cachedAt: num("cachedAt"),
    // 计数读不出来时按**已用满**处理而不是 0:盘上的记录坏了说明我们不知道发过几条,
    // 这时候乐观地从 0 开始就会超发,而超发是不可恢复的(连正文都发不出去)。
    attempts: typeof r["attempts"] === "number" ? num("attempts") : SEND_BUDGET,
    sent: num("sent"),
    progress: typeof r["progress"] === "number" ? num("progress") : MAX_PROGRESS_PER_TOKEN,
  };
}
