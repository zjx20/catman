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
 *     SEND_BUDGET(10)
 *       − 额度提示 1            「回信额度已用完,发 /nop 补充额度」
 *       ────────────────────
 *       = 其余 9 条,谁先来谁用
 *
 * **规则只有这一条,没有例外。** 回执、进度、正文、空闲提醒、部署播报、兜底说明 ——
 * 全部走同一个计数,谁都不许碰最后一格;最后一格只给额度提示,而且每份 token 只说
 * 一次(标记落盘)。发不出去的进发件队列(`outbox.ts`),下一条来信带来新 token
 * 再排空。
 *
 * ### 为什么不再按类别预留
 *
 * 从前这里是一张表:回执 1、进度上限 6、正文 / 两句交代各留 1。保留靠"进度的上限"
 * 实现,而"最后一格留给交代"这条规矩不在这里,散在 `outbox.ts` 的策略表里 ——
 * 只拦正文那一类,进度靠自己的上限挡住,回执与提醒谁都不拦。于是每个没被列进去
 * 的类别都是一个例外。2026-09-07 就这么撞上了:正文发完还剩 1 格,**会话空闲提醒**
 * (`reminder`)不问保留额直接把它拿走;早上定时日报来时额度为 0,内容进了队列,
 * 那句"发 /nop"却一格都申请不到,用户从 02:32 静默到 08:24,而且这条路上一行日志
 * 都没有。
 *
 * 规则挂在类别上就会有例外;挂在预算本身上就没有。所以现在保留额只认一样东西:
 * 那条提示自己的 kind(`budget`),其余一视同仁。进度的子上限也一并去掉 —— 它是
 * 给正文留位置的时延旋钮,与"没发全一定有人说"无关;有进度就发,没额度就续。
 *
 * ## 额度花光了不是绝路,但得有人告诉他
 *
 * 用户随便发一句话就带来新的 `context_token`,计数跟着归零。`/nop` 就是为此存在的
 * 那句"随便的话":什么也不做,只把额度续上。那条提示的全部意义就是把这个口令
 * 在**正确的时刻**送到他手里 —— 所以它必须有格可用,而且必须只由知道预算的这里放行。
 *
 * ## 为什么按"尝试"计数而不是"成功"
 *
 * 失败的那一次有没有消耗服务端的额度,协议没说。两种猜法的代价完全不对称:
 * 多算一次只是少发一条;少算一次则可能把正文顶出预算,那是整段对话静默。
 * 所以按尝试计数,并把成功数单独记着 —— "第 4 次尝试但只成功过 1 条"这种形态
 * 是判断"到底是限流还是 token 死了"的关键,合成一个计数就看不出来了。
 *
 * ## 为什么落盘
 *
 * ① 计数丢了就会超发,而超发是不可恢复的;
 * ② replyCtx 本身持久化之后,**人格重启不再丢回信能力** —— 会话空闲提醒终于有机会
 *    送达(它的前提就是用户没再发消息,而 token 只在收到新消息时才更新);
 * ③ "这份 token 的额度提示说过没有"也在里面:信使重启后忘掉它,要么重复说,
 *    要么(更糟)以为说过了而不说。
 */

/**
 * 一个 context_token 总共能发几条。别偷偷留余量 —— 余量在下面显式列支。
 *
 * **10 是实测值,而且复测过了。** 2026-08-12 放宽到 20 试了一次,当天就撞回来:
 *
 *     send #10(前 9 条成功)  ctx龄=668571ms  53字   → ok
 *     send #11(前 10 条成功) ctx龄=797522ms  41字   → 失败 ret=-2 prepare failed
 *     send #12 … #15                                → 全部失败
 *
 * 两次记录里都是**恰好 10 条成功**,与 token 年龄无关(那次 #11 的 token 已经
 * 13 分钟了,而另一次 4 分钟的 token 同样停在 10)。之后永不恢复。
 *
 * 那次实验的代价是真的:失败的第 14 条是一整段汇报,1175 字,用户没收到 ——
 * 这正是发件队列(`outbox.ts`)后来要接住的东西。**别再往上调**;真想再试,
 * 先确认队列已经上线(积压至少能补发),并且盯着 `ret=-2` 那行。
 */
export const SEND_BUDGET = 10;

/**
 * 留给额度提示的那一格。**这是整份预算里唯一的保留额。**
 *
 * 提示说过之后这一格就释放给别人 —— 留着只是浪费,而它要说的话已经说了。
 */
export const NOTICE_RESERVE = 1;

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
  /**
   * 这份 token 的额度提示说过没有。说过之后保留格释放,而且不再说第二次。
   *
   * 落盘的理由见文件头③。旧代码读到这个字段会忽略(它按白名单构造),回滚安全。
   */
  noticeSaid: boolean;
  /**
   * 「对方正在输入」用的 ticket(见 channels/ilink-protocol.ts 的 fetchTypingTicket)。
   *
   * **故意跟 contextToken 放在同一个对象里**:ticket 里编码了 context,换一条来信
   * 就得换一份,拿旧的去发 typing 会「ret=0 但客户端不亮」。放这儿之后 remember()
   * 重建 ctx 时它自然一起作废,没有单独的过期逻辑可以忘记写。
   *
   * 懒取:只有真要发 typing 时才去 getconfig 换一份填进来,没人发就一直是空的。
   */
  typingTicket?: string;
}

export interface SendPermit {
  readonly allowed: boolean;
  /** 放行之后这条来信还能再发几条**普通**消息(不含保留格)。 */
  readonly remaining: number;
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
      noticeSaid: false,
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
   * 这条来信还能发几条**普通**消息 —— 已经扣掉留给额度提示的那一格。
   * 没有上下文时是 0。
   *
   * 发件队列据此决定"当场发还是排队",以及排空该不该停:它为 0 时普通消息一律
   * 进队列,而那一刻正是该说提示的时刻(`noticePending`)。
   */
  remainingSends(userKey: string): number {
    const c = this.ctxs.get(userKey);
    if (!c) return 0;
    return Math.max(0, SEND_BUDGET - c.attempts - (c.noticeSaid ? 0 : NOTICE_RESERVE));
  }

  /**
   * 这份 token 的额度提示**还欠着**吗:有上下文、没说过、而且还有格说。
   *
   * 队列在把消息因额度塞进队列时问这个:是 → 立刻说;否 → 已经说过了(或压根
   * 没有上下文),不必再说。
   */
  noticePending(userKey: string): boolean {
    const c = this.ctxs.get(userKey);
    return !!c && !c.noticeSaid && c.attempts < SEND_BUDGET;
  }

  /**
   * 申请发一条。**允许则当场记账**(attempts 自增),不等结果 ——
   * 并发进来的发送因此拿到不同的序号,而硬指令与在飞回合确实会同时发消息。
   *
   * `budget` 是那条额度提示:它是唯一能用保留格的,而且每份 token 只放行一次。
   * 其余 kind 一律受保留格约束 —— **这里没有第二条分支,也不该有。**
   */
  begin(userKey: string, kind: SendKind): SendPermit {
    const c = this.ctxs.get(userKey);
    if (!c) {
      // iLink 协议**不支持主动推送**:没有这个用户最近一条来信的 context_token
      // 就真的发不出去。如实说,由调用方降级(网关对提醒本就是静默降级)。
      return { allowed: false, remaining: 0, reason: "没有这个用户的回复上下文" };
    }
    if (kind === "budget") {
      if (c.noticeSaid) {
        return { allowed: false, remaining: 0, reason: "这条来信的额度提示已经说过了" };
      }
      if (c.attempts >= SEND_BUDGET) {
        return { allowed: false, remaining: 0, reason: "这条来信的发送预算已用尽" };
      }
      c.attempts += 1;
      c.noticeSaid = true;
      this.flush();
      return { allowed: true, remaining: this.remainingSends(userKey) };
    }
    if (this.remainingSends(userKey) <= 0) {
      const reason =
        c.attempts >= SEND_BUDGET
          ? "这条来信的发送预算已用尽"
          : "这条来信只剩留给额度提示的那一格";
      return { allowed: false, remaining: 0, reason };
    }
    c.attempts += 1;
    this.flush();
    return { allowed: true, remaining: this.remainingSends(userKey) };
  }

  /** 记一次结果。只影响诊断计数,不影响预算(预算在 begin 时就扣了)。 */
  settle(userKey: string, ok: boolean): void {
    const c = this.ctxs.get(userKey);
    if (!c || !ok) return;
    c.sent += 1;
    this.flush();
  }

  /**
   * 这一轮的 typing ticket。**没有就是没有** —— 调用方负责去 getconfig 取一份
   * 回来交给 rememberTypingTicket,而不是在这里同步取:取 ticket 要发 HTTP,
   * 而这个类是纯记账的、还要被单测拿假时钟驱动。
   */
  typingTicket(userKey: string): string | undefined {
    return this.ctxs.get(userKey)?.typingTicket;
  }

  /** 收下一份新取的 ticket。上下文已经被换掉时直接丢弃 —— 它属于上一条来信。 */
  rememberTypingTicket(userKey: string, ticket: string): void {
    const c = this.ctxs.get(userKey);
    if (!c || c.typingTicket === ticket) return;
    c.typingTicket = ticket;
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
    // 旧盘上没有这个字段(旧代码把"说过没有"记在内存里)。读成"没说过"而不是
    // "说过了":两种猜错的代价不对称 —— 多说一次是一句废话,少说一次是一段静默。
    noticeSaid: r["noticeSaid"] === true,
    // 旧盘上没有这个字段,读出来是 undefined —— 那只是「还没取过 ticket」,
    // 下次要发 typing 时自然会去取一份。反过来旧代码读到带这个字段的新盘也无妨:
    // 它按白名单构造,多出来的键直接忽略。回滚安全。
    ...(typeof r["typingTicket"] === "string" && r["typingTicket"]
      ? { typingTicket: r["typingTicket"] }
      : {}),
  };
}
