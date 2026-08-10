import type { Channel, ChannelHealth, MessageHandler } from "./types.js";
import type { AccountStore } from "../core/accounts.js";
import { parseUserKey } from "../core/identity.js";
import { ILinkConnection, type ReplyContexts } from "./ilink-connection.js";
import type { AttachmentLimits } from "../core/attachments.js";
import { WECHAT_CHANNEL } from "./ilink-protocol.js";
import type { SendKind } from "../ipc/protocol.js";

/**
 * 长轮询游标的落盘。**每个账号一份。**
 *
 * 默认实现什么都不做(等价于旧行为:游标只在内存里),信使会注入真正的那个。
 * 不落盘的代价见 ConnectionHooks.onCursor 的说明 —— 毒消息会让进程重启后
 * 重放同一条、再崩,无限循环。
 */
export interface CursorStore {
  get(accountId: string): string | undefined;
  set(accountId: string, updatesBuf: string): void;
}

/**
 * 微信 iLink 渠道:管理若干个 ILinkConnection,每个账号一条独立的长轮询。
 *
 * 一次扫码 = 一份 bot_token = 一个账号 = 这里的一条连接。多人使用时各自扫码,
 * 消息在此汇总成统一的 userKey 流交给网关;回复按 userKey 里的 accountId 路由回
 * 对应连接 —— 两份凭据下出现相同的 from_user_id 也不会串。
 *
 * 连接集合跟随 AccountStore 变化:dashboard 上扫码完成后 AccountStore 触发回调,
 * 这里立刻把新账号的连接拉起来,不需要重启进程。
 */
export class WechatILinkChannel implements Channel {
  // 必须与 userKey 的第一段一致,否则回复路由不回来 —— 见 WECHAT_CHANNEL 的说明。
  readonly name = WECHAT_CHANNEL;

  private handler?: MessageHandler;
  private readonly connections = new Map<string, ILinkConnection>();
  private started = false;

  constructor(
    private readonly accounts: AccountStore,
    private readonly limits: () => AttachmentLimits,
    private readonly replies: ReplyContexts,
    private readonly cursors: CursorStore = { get: () => undefined, set: () => {} },
  ) {
    this.accounts.onConnectionSetChanged(() => {
      // 账号增删或凭据替换后立刻对齐连接。start() 之前的变更留给 start() 统一处理。
      if (this.started) void this.reconcile();
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.started = true;
    await this.reconcile();
    if (this.connections.size === 0) {
      console.warn(
        "[ilink] 尚未绑定任何微信账号。打开 dashboard 的「账号」页扫码接入后会自动开始收消息。",
      );
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(all.map((c) => c.stop()));
  }

  /** 按 userKey 中的 accountId 路由到对应连接。 */
  async send(userKey: string, text: string, kind: SendKind = "body"): Promise<void> {
    const parts = parseUserKey(userKey);
    if (!parts) throw new Error(`非法 userKey: ${userKey}`);
    const conn = this.connections.get(parts.accountId);
    if (!conn) {
      throw new Error(`账号 ${parts.accountId} 无活动连接,无法发送`);
    }
    await conn.send(userKey, text, kind);
  }

  /** 各连接累计跳过的毒消息条数。非零说明有来信我们处理不了,状态页要显眼。 */
  poisonedCount(): number {
    let n = 0;
    for (const c of this.connections.values()) n += c.poisonedCount;
    return n;
  }

  /** 当前活动连接数(dashboard/日志用)。 */
  activeAccountIds(): string[] {
    return [...this.connections.keys()];
  }

  /**
   * 健康自述。`live` 要求**至少有一条没失效的连接** —— 凭据失效的连接留在表里
   * 但故意不重启(见 reconcile 的说明),此时渠道已启动却聋着,部署的健康门必须
   * 分得出这两种状态。一个账号都还没绑时同样是 live=false:那时确实收不到消息。
   */
  health(): readonly ChannelHealth[] {
    const live = [...this.connections.values()].some((c) => !c.isExpired);
    return [{ name: this.name, started: this.started, live }];
  }

  /**
   * 让连接集合与 AccountStore 对齐:新账号起连接,已删除的账号停连接,
   * **凭据被换过的账号重建连接**。幂等,可反复调用。
   *
   * 凭据失效(errcode=-14)后连接会自行停摆并留在表里,这里不重启它 ——
   * token 没换的话重连只会再吃一次 -14,徒然刷屏。它要等重新扫码把凭据换掉,
   * 那时下面的 usesCredentialsOf 会认出不同并重建。
   */
  private async reconcile(): Promise<void> {
    const wanted = new Map(
      this.accounts
        .list()
        .filter((a) => a.channel === "wechat")
        .map((a) => [a.accountId, a] as const),
    );

    const stopping: Array<Promise<void>> = [];
    for (const [id, conn] of this.connections) {
      const account = wanted.get(id);
      if (!account || !conn.usesCredentialsOf(account)) {
        this.connections.delete(id);
        stopping.push(conn.stop().catch(() => {}));
        if (account) console.info(`[ilink] 账号 ${id} 凭据已更新,重建连接`);
      }
    }

    for (const [id, account] of wanted) {
      if (this.connections.has(id)) continue;
      const conn = new ILinkConnection(
        account,
        // **同步 await**:投递顺序严格等于收到顺序。「图 + 文字」那 120ms 的一对
        // 靠它保持先后 —— 并发投递会让它们颠倒着进队列。
        async (msg) => {
          await this.handler?.({
            msgId: msg.msgId,
            userKey: msg.userKey,
            text: msg.text,
            ...(msg.attachments.length ? { attachments: msg.attachments } : {}),
          });
        },
        this.limits,
        this.replies,
        {
          canonicalUserId: (raw) => this.accounts.canonicalUserId(id, raw),
          onExpired: () => this.accounts.markExpired(id),
          onCursor: (buf) => this.cursors.set(id, buf),
          ...(this.cursors.get(id) ? { initialCursor: this.cursors.get(id)! } : {}),
        },
      );
      this.connections.set(id, conn);
      try {
        await conn.start();
        console.info(`[ilink] 账号 ${id}(${account.displayName})连接已建立`);
      } catch (err) {
        this.connections.delete(id);
        console.error(`[ilink] 账号 ${id} 连接失败:`, err);
      }
    }

    await Promise.all(stopping);
  }
}
