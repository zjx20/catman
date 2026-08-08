import type { Channel, ChannelHealth, MessageHandler } from "./types.js";
import type { AccountStore } from "../core/accounts.js";
import { parseUserKey } from "../core/identity.js";
import { ILinkConnection } from "./ilink-connection.js";
import type { AttachmentLimits } from "../core/attachments.js";
import { WECHAT_CHANNEL } from "./ilink-protocol.js";

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
  async send(userKey: string, text: string): Promise<void> {
    const parts = parseUserKey(userKey);
    if (!parts) throw new Error(`非法 userKey: ${userKey}`);
    const conn = this.connections.get(parts.accountId);
    if (!conn) {
      throw new Error(`账号 ${parts.accountId} 无活动连接,无法发送`);
    }
    await conn.send(userKey, text);
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
        (userKey, text, attachments) => {
          void this.handler?.({
            userKey,
            text,
            ...(attachments.length ? { attachments } : {}),
          });
        },
        this.limits,
        {
          canonicalUserId: (raw) => this.accounts.canonicalUserId(id, raw),
          onExpired: () => this.accounts.markExpired(id),
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
