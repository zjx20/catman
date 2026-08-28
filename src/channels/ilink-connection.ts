import { randomBytes } from "node:crypto";
import type { Account } from "../core/accounts.js";
import { makeUserKey } from "../core/identity.js";
import {
  ilinkPost,
  baseInfo,
  fetchCdnMedia,
  LONG_POLL_PATH,
  LONG_POLL_TIMEOUT_MS,
  WECHAT_CHANNEL,
  fetchTypingTicket,
  sendTyping,
  type CdnMedia,
} from "./ilink-protocol.js";
import {
  describeReject,
  toImageAttachment,
  type Attachment,
  type AttachmentLimits,
} from "../core/attachments.js";
import type { SendKind } from "../ipc/protocol.js";

/**
 * 单个 iLink 账号的连接:一份 bot_token = 一条 getupdates 长轮询 + 一份回复上下文缓存。
 * 多账号由 wechat-ilink.ts 管理若干个本类实例。
 *
 * 协议要点:
 *   - 回复必须带上对应入站消息的 context_token,否则消息不投递(且 HTTP 200 静默失败)
 *   - 协议不支持主动推送:send() 只在有缓存的 context_token 时可用;
 *     超时提醒大概率失败(由网关降级)
 *   - 未发现撤回消息的端点:不实现 recall,网关的"处理中"回执在微信里会保留
 */

/**
 * item_list 里的消息条目类型(proto: MessageItemType)。
 * 完整枚举还有 VOICE=3 / FILE=4 / VIDEO=5 / TOOL_CALL_*=11,12,这里只处理前两种。
 */
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;

interface MessageItem {
  type: number;
  /** 条目是否已就绪。图片要先传 CDN,未传完时可能为 false —— 待真机确认。 */
  is_completed?: boolean;
  create_time_ms?: number;
  update_time_ms?: number;
  msg_id?: string;
  text_item?: { text: string };
  image_item?: {
    /** hex 编码的 AES key。给了就优先于 media.aes_key(它是 base64)。 */
    aeskey?: string;
    media?: CdnMedia;
  };
}

/**
 * proto: WeixinMessage。字段照官方 proto 列全 —— 后面几个当前只被 TRACE 读,
 * 它们是排查「图文分离」聚合键的候选,留着比每次要用再去翻协议强。
 */
interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  /** 消息级会话 id(不是我们自己的 SessionManager 那个)。 */
  session_id?: string;
  run_id?: string;
  context_token?: string;
  message_type?: number; // 1 = USER, 2 = BOT
  message_state?: number; // 0 = NEW, 1 = GENERATING, 2 = FINISH
  item_list?: MessageItem[];
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

/**
 * 回复上下文与发送预算的持有者。
 *
 * **不再由连接自己持有**:预算必须有唯一权威(信使的 `ReplyStore`),否则两个人格
 * 各按 10 条算就必然超发,而超发的后果是 `ret=-2` 且永不恢复。连接只负责"拿到 token
 * 就交出去"和"发之前问一句还能不能发"。
 *
 * 唯一的实现是信使的 `courier/reply-store.ts`。人格侧不再持有 iLink 连接
 * (它走 bridge),所以不存在第二份记账。
 */
export interface ReplyContexts {
  /** 新来信:换一份上下文,计数归零。 */
  remember(userKey: string, toUserId: string, contextToken: string): void;
  /** 申请发一条。allowed=false 时连接不发,并把 reason 抛给调用方。 */
  begin(userKey: string, kind: SendKind): { allowed: boolean; reason?: string };
  /** 记一次结果(只影响诊断计数)。 */
  settle(userKey: string, ok: boolean): void;
  /** 发给谁、用哪个 token。 */
  target(userKey: string): { toUserId: string; contextToken: string } | undefined;
  /** 这一轮的 typing ticket;没取过时是 undefined。 */
  typingTicket(userKey: string): string | undefined;
  /** 存下新取的 ticket。它跟着 context_token 走,换一条来信就作废。 */
  rememberTypingTicket(userKey: string, ticket: string): void;
  /** 诊断三量:第几次尝试、之前成功几条、这份上下文多老了。 */
  diag(userKey: string): { attempt: number; okBefore: number; ageMs: number };
}

/** 收到一条用户消息。userKey 已由连接拼好(含本账号的 accountId)。 */
export type ConnectionMessageHandler = (msg: {
  /** 协议派生的稳定标识。**重放时必须与上一次相同** —— 去重全靠它。 */
  readonly msgId: string;
  readonly userKey: string;
  readonly text: string;
  readonly attachments: readonly Attachment[];
}) => void | Promise<void>;

/** 连接向上回报的事件。都由 wechat-ilink.ts 接到 AccountStore 上。 */
export interface ConnectionHooks {
  /**
   * 把来信的原始 from_user_id 归一成规范身份,再据此拼 userKey。
   * 默认恒等;真正的实现是 `AccountStore.canonicalUserId`(重新扫码后换了标识时
   * 让它接回原来那个 userKey)。
   */
  canonicalUserId?: (rawUserId: string) => string;
  /** 凭据失效(errcode=-14)。落盘后账号页会提示"需要重新扫码"。 */
  onExpired?: () => void;
  /**
   * 长轮询游标推进了。**在这一批消息被成功消费之后**调用,由调用方落盘。
   *
   * 不落盘的后果有两个,都很难查:重启会重放整批(用户收到重复回答),而**毒消息**
   * ——某条来信触发崩溃 —— 会让进程重启后重放同一条、再崩,无限循环,微信全聋。
   */
  onCursor?: (updatesBuf: string) => void;
  /** 恢复上次落盘的游标。不给则从空开始(等价于旧行为)。 */
  initialCursor?: string;
}

/** 出错退避时长。 */
const BACKOFF_MS = 3000;

/**
 * 入站消息的协议追踪。默认关闭 —— 打开后每条来信都会打一行结构摘要。
 *
 * 存在的理由:微信发「图 + 文字」时**不是一条消息**,文本先到、图片要等 CDN 上传完
 * 才作为另一条消息到达(实测间隔 4~9 秒,图越大越久)。想只对"知道有图要来"的消息
 * 做聚合等待、而不拖慢纯文本,就得先确认协议里到底有没有这样的信号
 * (`session_id` / `run_id` / `is_completed` / `message_state` 都是候选)。
 * 类型定义看不出答案,只能看真机数据。
 *
 * **只打结构与标量,绝不打 base64 与 aeskey** —— 前者刷屏,后者是媒体密钥。
 */
const TRACE = process.env.CATMAN_ILINK_TRACE === "1";

/**
 * 把一条入站消息压成一行结构摘要。纯函数,所以能直接单测「不泄漏密钥」这条约束 ——
 * 它是唯一会把协议原始内容写进日志的地方,值得钉死。
 *
 * 挑的字段就是候选聚合键本身:同一次发送动作若共享 `session_id` / `run_id`,
 * 或带图那条先以 `is_completed=false` / `message_state≠2` 到达,都能成为
 * "值得等一等"的信号;全都对不上,则说明协议给不出提示,只能另想办法。
 *
 * **只输出键名与标量**:`aeskey` 是媒体密钥,`data` 是几 MB 的 base64,都只打键名。
 */
export function formatTrace(m: WeixinMessage): string {
  const items = (m.item_list ?? []).map((i) => {
    const fields = Object.keys(i).filter((k) => !k.endsWith("_item"));
    const inner = i.image_item
      ? `image_item{${Object.keys(i.image_item).join(",")}}` +
        (i.image_item.media ? `.media{${Object.keys(i.image_item.media).join(",")}}` : "")
      : i.text_item
        ? `text(${i.text_item.text?.length ?? 0}字)`
        : "";
    return `type=${i.type} completed=${i.is_completed ?? "-"} [${fields.join(",")}] ${inner}`;
  });
  return (
    `seq=${m.seq ?? "-"} msgId=${m.message_id ?? "-"} state=${m.message_state ?? "-"} ` +
    `sess=${m.session_id ?? "-"} run=${m.run_id ?? "-"} client=${m.client_id ?? "-"} ` +
    `ctime=${m.create_time_ms ?? "-"} utime=${m.update_time_ms ?? "-"} ` +
    `items=${items.length ? items.join(" ; ") : "(空)"}`
  );
}

/**
 * 一次 sendmessage 的诊断行。
 *
 * 存在的理由:sendmessage 失败时,光看 `ret`/`errmsg` 分不出到底是**限流**、
 * **context_token 过期**、还是**同一个 token 只允许回一条**。三者要靠三个量区分:
 *   - `#n`      针对这条来信这是第几次回复,以及前面成功了几条
 *                (n=2 就失败 ⇒ 两条之间只隔几秒,限流解释不通)
 *   - `ctx龄`   拿到 token 到用它发信之间过了多久(第一条就失败且龄很大 ⇒ 时效)
 *   - `字`      本条长度,用于对上是回执/进度/正文的哪一段
 *
 * 与 `formatTrace` 同一条约束:**只出标量,不出正文** —— 日志里不该有会话内容。
 * 做成纯函数就是为了把这条约束钉在单测里。
 */
export function formatSendDiag(
  attempt: number,
  okBefore: number,
  ageMs: number,
  chars: number,
  outcome: string,
): string {
  return `send #${attempt}(前 ${okBefore} 条成功) ctx龄=${ageMs}ms ${chars}字 → ${outcome}`;
}

export class ILinkConnection {
  readonly accountId: string;

  private readonly account: Account;
  private readonly onMessage: ConnectionMessageHandler;
  private readonly clientId = `catman-${randomBytes(8).toString("hex")}`;
  private readonly abort = new AbortController();

  private updatesBuf: string;
  private running = false;
  /** 被跳过的毒消息累计条数。非零就该在状态页与日志里显眼。 */
  private poisoned = 0;
  /** 服务端上次报的长轮询时长,只为「变了才打日志」而存。 */
  private serverPollTimeoutMs?: number;
  /** 轮询循环的 promise,stop() 时等它退出。 */
  private loop?: Promise<void>;
  /** 会话过期(需重新扫码)后置位,供 dashboard 展示。 */
  private expired = false;
  /** typing 出过错就整条连接停用 —— 见 typing() 的说明。 */
  private typingBroken = false;

  /**
   * limits 传的是**函数不是值**:管理员在 dashboard 上改了上限,下一张图就按新值走,
   * 不必重启进程、也不必给连接加一条配置变更通知。
   */
  constructor(
    account: Account,
    onMessage: ConnectionMessageHandler,
    private readonly limits: () => AttachmentLimits,
    private readonly replies: ReplyContexts,
    private readonly hooks: ConnectionHooks = {},
  ) {
    this.account = account;
    this.accountId = account.accountId;
    this.onMessage = onMessage;
    this.updatesBuf = hooks.initialCursor ?? "";
  }

  get isExpired(): boolean {
    return this.expired;
  }

  /** 被跳过的毒消息条数。供 /health 与状态页 —— 静默跳过等于没有隔离。 */
  get poisonedCount(): number {
    return this.poisoned;
  }

  /**
   * 本连接握着的凭据是否仍是该账号当前的凭据。
   *
   * 重新扫码只换凭据、不换 accountId,连接集合因此看不出变化 —— 少了这道比较,
   * reconcile 会认为"这个账号已经有连接了"而把作废的 token 一直用下去。
   */
  usesCredentialsOf(account: Account): boolean {
    return account.botToken === this.account.botToken && account.baseUrl === this.account.baseUrl;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.post("ilink/bot/msg/notifystart", {}).catch(() => {});
    this.loop = this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.post("ilink/bot/msg/notifystop", {}).catch(() => {});
    await this.loop?.catch(() => {});
  }

  /**
   * 发送文本。使用该用户最近入站消息缓存的 context_token。
   * 无缓存(如主动提醒且用户从未发过消息)时抛错,由网关判定推送失败并降级。
   */
  async send(userKey: string, text: string, kind: SendKind = "body"): Promise<void> {
    const target = this.replies.target(userKey);
    if (!target) {
      throw new Error(`无 ${userKey} 的 context_token,iLink 无法主动推送`);
    }
    // **预算在发之前问**,而权威不在这里 —— 见 ReplyContexts 的说明。
    const permit = this.replies.begin(userKey, kind);
    if (!permit.allowed) {
      throw new Error(permit.reason ?? "发送预算不允许");
    }
    const msg: WeixinMessage = {
      from_user_id: "",
      to_user_id: target.toUserId,
      client_id: `${this.clientId}-${randomBytes(4).toString("hex")}`,
      message_type: 2, // BOT
      message_state: 2, // FINISH
      context_token: target.contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    };
    // 诊断量在**发之前**取:失败路径要抛错,取晚了就得在两个分支各算一遍。
    // begin() 已经就地自增过 attempts,所以并发进来的发送拿到的是不同的序号 ——
    // 硬指令与在飞回合是会同时发消息的。
    const { attempt, okBefore, ageMs } = this.replies.diag(userKey);

    const resp = await this.post<{ ret?: number; errmsg?: string }>("ilink/bot/sendmessage", {
      msg,
      base_info: baseInfo(),
    });
    if (resp.ret !== undefined && resp.ret !== 0) {
      this.replies.settle(userKey, false);
      // 失败**无条件**打:上层的 trySend 会把回执/进度的失败吞掉,只在这里
      // 还能看到全貌。带上三个判别量,见 formatSendDiag 的说明。
      console.warn(
        `[ilink:${this.accountId}] ` +
          formatSendDiag(
            attempt,
            okBefore,
            ageMs,
            text.length,
            `失败 ret=${resp.ret} ${resp.errmsg ?? ""}`,
          ),
      );
      throw new Error(`sendmessage 失败 ret=${resp.ret} ${resp.errmsg ?? ""}`);
    }
    this.replies.settle(userKey, true);
    // 成功的量大(回执 + 每条进度 + 每段正文),跟入站 TRACE 同一个开关。
    // 但失败行自带 okBefore,所以不开 TRACE 也判得出"第几条开始坏的"。
    if (TRACE) {
      console.info(
        `[ilink:${this.accountId}] ` + formatSendDiag(attempt, okBefore, ageMs, text.length, "ok"),
      );
    }
  }

  /**
   * 「对方正在输入」的开关。**与 send 是两条信道**:走 sendtyping 端点、
   * 靠 typing_ticket 认身份,不碰 context_token 的那 10 条预算,所以它跟文本进度
   * 是并行的两件事 —— 进度说「在做什么」,它说「还活着」,谁也不替代谁。
   *
   * 全程不抛错:这是装饰,不该反过来把一个正常的回合搞挂。失败只记一行日志,
   * 而且**首次失败就整条连接停用** —— 5 秒一次的失败会把日志刷爆,而刷爆的日志
   * 比没有 typing 严重得多。
   */
  async typing(userKey: string, on: boolean): Promise<void> {
    if (this.typingBroken) return;
    try {
      const target = this.replies.target(userKey);
      if (!target) return; // 没有这一轮的上下文,本来也发不出任何东西

      // ticket 跟 context_token 同生共死(见 fetchTypingTicket 的说明),所以这里
      // 拿到的要么是这一轮取过的那份,要么就得现取 —— 绝不会是上一轮的。
      let ticket = this.replies.typingTicket(userKey);
      if (!ticket) {
        // 熄灭时不值得为了发这一下专门去取一份 ticket:没取过就说明这一轮
        // 压根没亮过,没有东西需要熄。
        if (!on) return;
        ticket = await fetchTypingTicket(target.toUserId, target.contextToken, this.postOpts());
        if (!ticket) throw new Error(`getconfig 没给 typing_ticket`);
        this.replies.rememberTypingTicket(userKey, ticket);
      }

      // ⚠️ ret 只表示「收下了」。参数残缺时它照样是 0 而客户端什么都不显示,
      // 所以这里的检查抓不到「不亮」,只抓得到明确的报错。
      const r = await sendTyping(target.toUserId, ticket, on, this.postOpts());
      if (r.ret !== undefined && r.ret !== 0) {
        throw new Error(`sendtyping ret=${r.ret} ${r.errmsg ?? ""}`);
      }
    } catch (err) {
      this.typingBroken = true;
      console.warn(
        `[ilink:${this.accountId}] typing 失败,本连接不再尝试(不影响收发消息):${String(err)}`,
      );
    }
  }

  // --- 内部 ---

  /** post 的公共参数。typing 那两个端点是模块级函数,要显式把凭据递进去。 */
  private postOpts(): { baseUrl: string; botToken: string; signal: AbortSignal } {
    return {
      baseUrl: this.account.baseUrl,
      botToken: this.account.botToken,
      signal: this.abort.signal,
    };
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const startedAt = Date.now();
      try {
        const resp = await this.post<GetUpdatesResp>(LONG_POLL_PATH, {
          get_updates_buf: this.updatesBuf,
          base_info: baseInfo(),
        });

        // 服务端报的长轮询时长。当前并不据此调整客户端超时(仍是常量),打出来是为了
        // 判断 AbortError 到底是不是「服务端挂得比 LONG_POLL_TIMEOUT_MS 久」——
        // 只在变化时打一行,稳定后不再刷屏。
        if (
          resp.longpolling_timeout_ms !== undefined &&
          resp.longpolling_timeout_ms !== this.serverPollTimeoutMs
        ) {
          this.serverPollTimeoutMs = resp.longpolling_timeout_ms;
          console.info(
            `[ilink:${this.accountId}] 服务端长轮询时长 ${resp.longpolling_timeout_ms}ms` +
              `(客户端超时 ${LONG_POLL_TIMEOUT_MS}ms)` +
              (resp.longpolling_timeout_ms >= LONG_POLL_TIMEOUT_MS
                ? " —— 客户端更短,每轮都会被自己 abort"
                : ""),
          );
        }

        if (resp.errcode === -14) {
          console.error(
            `[ilink:${this.accountId}] 会话过期(errcode=-14),需在 dashboard 的账号页点「重新扫码」`,
          );
          this.expired = true;
          this.running = false;
          this.hooks.onExpired?.();
          break;
        }
        if (resp.ret !== undefined && resp.ret !== 0) {
          await this.sleep(BACKOFF_MS); // 出错退避
          continue;
        }
        // 逐条 await:dispatch 可能要下载图片。代价是下载期间暂停拉取,
        // 好处是投递顺序严格等于收到顺序 —— 长轮询有 get_updates_buf 游标兜底,
        // 暂停不会丢消息;而乱序会让「先发图、后发问题」的两条消息颠倒着进队列。
        //
        // **单条消息是一个故障域**:解析/下载/入队任何一步抛错,只记录这一条并继续,
        // 绝不让它掀翻主循环。否则一条毒消息就能让整个渠道停摆 —— 而重启之后
        // 游标还没推进,它会被重放、再崩,无限循环,微信全聋。
        for (const m of resp.msgs ?? []) {
          try {
            await this.dispatch(m);
          } catch (err) {
            this.poisoned += 1;
            console.error(
              `[ilink:${this.accountId}] 消息处理失败,已跳过(累计 ${this.poisoned} 条):` +
                `${String(err)} — ${formatTrace(m)}`,
            );
          }
        }
        // 游标**在这一批消费完之后**才推进并落盘。放在消费之前的话,崩溃会丢掉
        // 整批;放在之后而不落盘,则重启会重放整批。两者都要避免,所以是这个顺序 +
        // 这个回调。重放本身由协议派生的稳定 msgId 兜底(见 dispatch),不会变成重复回答。
        if (resp.get_updates_buf && resp.get_updates_buf !== this.updatesBuf) {
          this.updatesBuf = resp.get_updates_buf;
          this.hooks.onCursor?.(this.updatesBuf);
        }
      } catch (err) {
        if (!this.running) break; // stop() 触发的 abort,正常退出
        // 带上已等时长:AbortError 贴着 LONG_POLL_TIMEOUT_MS 就是客户端超时太短
        // (服务端还在挂),明显更短则是真的网络异常 —— 两者的修法完全不同。
        const waited = Date.now() - startedAt;
        console.warn(
          `[ilink:${this.accountId}] 轮询异常(已等 ${waited}ms / 客户端上限 ` +
            `${LONG_POLL_TIMEOUT_MS}ms),${BACKOFF_MS}ms 后重试: ${String(err)}`,
        );
        await this.sleep(BACKOFF_MS);
      }
    }
  }

  private async dispatch(m: WeixinMessage): Promise<void> {
    if (TRACE) console.info(`[ilink:${this.accountId}] TRACE ${formatTrace(m)}`);
    // 跳过自身(BOT)消息
    if (m.message_type === 2 || m.from_user_id?.endsWith("@im.bot")) return;
    if (!m.from_user_id) return;

    const text = (m.item_list ?? [])
      .filter((i) => i.type === ITEM_TEXT && i.text_item?.text)
      .map((i) => i.text_item!.text)
      .join("")
      .trim();

    // 归一化后再拼 userKey:重新扫码换了 bot 之后,同一个人的 from_user_id 可能变,
    // 归一让他仍落在原来那个 userKey 上,会话与工作目录不断线(见 canonicalUserId)。
    const userId = this.hooks.canonicalUserId?.(m.from_user_id) ?? m.from_user_id;
    const userKey = makeUserKey(WECHAT_CHANNEL, this.accountId, userId);

    // 缓存回复上下文要在下载**之前**做:下载可能失败,而报错也得发得出去。
    // 注意按 userKey 存:同一 from_user_id 在别的账号下是另一个人。
    // `toUserId` 存的是**原始** from_user_id 而非归一后的:归一只服务于我们自己的
    // 身份体系,发回去必须用协议认得的那个标识。
    //
    // 每条新来信都换一份上下文,发送计数也跟着归零 —— 计数的语义是「针对**这条来信**
    // 回了几条」。所以读日志时留意:用户在回合进行中又发了一条,会看到序号退回 #1。
    if (m.context_token) {
      this.replies.remember(userKey, m.from_user_id, m.context_token);
    }

    const attachments = await this.collectImages(userKey, m.item_list ?? []);

    // 文字与图片同时为空才算无内容。只发一张图是完全正常的用法。
    if (!text && !attachments.length) return;
    await this.onMessage({ msgId: this.msgIdOf(m), userKey, text, attachments });
  }

  /**
   * 消息的稳定标识。**必须由协议派生,不能用自增计数器。**
   *
   * 它是重放去重的唯一依据:进程崩在"消息已入队、游标还没落盘"之间时,整批会被重放,
   * 而计数器生成的 id 每次都不同 —— 于是同一条话在用户那边被回答两次。
   *
   * `message_id` 缺失时退回到"内容 + 时刻"的指纹:比计数器稳,但不完美(同一毫秒内
   * 同一个人发两条一模一样的话会撞)。如实说明,不假装它总是可靠。
   */
  private msgIdOf(m: WeixinMessage): string {
    if (m.message_id !== undefined) return `${this.accountId}-${m.message_id}`;
    const items = (m.item_list ?? []).length;
    return `${this.accountId}-f${m.create_time_ms ?? 0}-${m.from_user_id ?? ""}-${items}`;
  }

  /**
   * 把消息里的图片 item 下载解密成附件。
   *
   * 单张图片失败不影响其余部分:该图跳过并单独告知用户,剩下的文字和其它图片
   * 照常投递 —— 整条消息因为一张图挂掉而消失,对用户来说就是"发了没反应"。
   */
  private async collectImages(
    userKey: string,
    items: readonly MessageItem[],
  ): Promise<Attachment[]> {
    const imageItems = items.filter((i) => i.type === ITEM_IMAGE);
    const images = imageItems.filter((i) => i.image_item?.media);
    if (imageItems.length > images.length) {
      // 协议里确实有图片,但我们没在预期的字段里找到下载信息 —— 多半是字段名与
      // 真机对不上。**只打字段名不打值**(aeskey 是媒体密钥),这份 key 列表正是
      // 校准所需要的;不打的话真机上的表现是"发了图没反应",日志里一点痕迹都没有。
      const shapes = imageItems
        .filter((i) => !i.image_item?.media)
        .map((i) => `{${Object.keys(i.image_item ?? {}).join(",") || "空"}}`);
      console.warn(
        `[ilink:${this.accountId}] 收到 ${shapes.length} 个图片条目但取不到下载信息,` +
          `image_item 的字段是 ${shapes.join(" ")} —— 期望里面有 media`,
      );
    }
    if (!images.length) return [];

    // 整条消息用同一份上限快照:中途被改的话,同一条消息里的图会按不同标准处理。
    const limits = this.limits();
    const out: Attachment[] = [];
    let skipped = 0;
    for (const item of images) {
      if (out.length >= limits.maxImagesPerTurn) {
        skipped += 1;
        continue;
      }
      const img = item.image_item!;
      try {
        // image_item.aeskey 是 hex,media.aes_key 是 base64 —— 统一成 base64 再传下去。
        const aesKeyBase64 = img.aeskey
          ? Buffer.from(img.aeskey, "hex").toString("base64")
          : undefined;
        const bytes = await fetchCdnMedia(img.media!, {
          ...(aesKeyBase64 ? { aesKeyBase64 } : {}),
          signal: this.abort.signal,
        });
        const result = toImageAttachment(bytes, limits);
        if (result.ok) {
          out.push(result.attachment);
        } else {
          await this.trySend(userKey, describeReject(result.reject));
        }
      } catch (err) {
        console.warn(`[ilink:${this.accountId}] 图片下载/解密失败: ${String(err)}`);
        await this.trySend(userKey, "有张图片我没取下来,你再发一次试试。");
      }
    }
    if (skipped) {
      await this.trySend(
        userKey,
        `一次最多看 ${limits.maxImagesPerTurn} 张图,后面 ${skipped} 张我先跳过了。`,
      );
    }
    return out;
  }

  /** 发一句提示,失败就算了 —— 它只是解释,不该反过来把这条消息整个搞挂。 */
  private async trySend(userKey: string, text: string): Promise<void> {
    await this.send(userKey, text).catch(() => {});
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return ilinkPost<T>(path, body, {
      baseUrl: this.account.baseUrl,
      botToken: this.account.botToken,
      signal: this.abort.signal,
    });
  }

  /** 可被 stop() 中断的 sleep,避免关机时白等一个退避周期。 */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
