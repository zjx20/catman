import { readJsonFile, writeJsonFileAtomic } from "./file-store.js";

/**
 * 账号注册表:一份聊天渠道凭据 = 一个账号 = 一条独立连接。
 * 微信 iLink 下,一次扫码得到一份 bot_token,即一个账号。
 *
 * 文件含长期有效的凭据,固定以 0600 落盘(见 writeJsonFileAtomic 的 mode 参数)。
 */

/** 每账号最多保留的「被拒来信」记录数(按 userId 去重)。 */
const MAX_REJECTIONS = 10;

/** 备注名长度上限。与 users.ts 的展示名同一口径。 */
const DISPLAY_NAME_MAX = 64;

/** 没起备注名时的账号叫法。扫码时不填、或事后清空,都落到它。 */
export function defaultAccountName(accountId: string): string {
  return `微信账号 ${accountId}`;
}

/**
 * 规整备注名:去空白、超长截断,空则回落到默认名。
 *
 * 与 `UserRegistry.setDisplayName()`(空名直接抛错)刻意不同:那里的展示名没有
 * 天然默认值,空掉就没法称呼了;账号备注名纯属方便人辨认,有 accountId 兜底,
 * 所以"清空 = 恢复默认"比报错更顺手。
 */
export function normalizeAccountName(raw: string, accountId: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return defaultAccountName(accountId);
  return trimmed.length > DISPLAY_NAME_MAX ? `${trimmed.slice(0, DISPLAY_NAME_MAX)}…` : trimmed;
}

export interface Rejection {
  /** 被拒的对端标识。 */
  userId: string;
  /** 累计被拒次数。 */
  count: number;
  /** 最近一次被拒时间。 */
  lastAt: number;
}

export interface Account {
  accountId: string;
  /** 渠道名,当前只有 "wechat"。 */
  channel: string;
  botToken: string;
  baseUrl: string;
  botId: string;
  displayName: string;
  /**
   * 本账号唯一被授权的对端标识。undefined 表示尚未绑定 ——
   * 绑定后收到的第一条消息会把它的发送者记为主人(TOFU,见 gateway 的准入检查)。
   */
  boundUserId?: string;
  createdAt: number;
  /** 非 boundUserId 的来信记录,供 dashboard 核对。 */
  rejections?: Rejection[];
  /**
   * 凭据失效(长轮询返回 errcode=-14)的时刻,由渠道回填;重新扫码成功后清除。
   *
   * 落盘而不是只放在连接对象里,是因为失效是**凭据**的属性而非连接的属性:
   * 进程重启后那份 bot_token 依然是坏的,账号页仍该提示"需要重新扫码"。
   */
  expiredAt?: number;
  /**
   * 重新扫码后等待认领。置位期间收到的第一条来信,其 from_user_id 若与
   * `boundUserId` 不同,会被登记进 `userIdAliases`;相同则只是把标记清掉。
   * 见 `canonicalUserId()`。
   */
  pendingRebind?: boolean;
  /**
   * 重新扫码带来的新 from_user_id → 原主人的 from_user_id(即 `boundUserId`)。
   *
   * 存在的理由:userKey 的第三段就是 from_user_id,而换一份 bot 凭据后同一个人的
   * from_user_id 是否照旧由 iLink 决定,我们控制不了。这张表让"换了标识"退化成
   * "还是原来那个 userKey",于是会话、工作目录、个人配置全都接得上;标识没变时
   * 表是空的,整条路径等同于不存在。`unbind()` 会连同它一起清空 —— 换人的语义下
   * 旧主人的别名不该继续生效。
   */
  userIdAliases?: Record<string, string>;
}

/** 去掉凭据的账号视图。dashboard 只能拿到这个,botToken 不出进程。 */
export type PublicAccount = Omit<Account, "botToken">;

export type AccountMap = Record<string, Account>;

export function toPublic(a: Account): PublicAccount {
  const { botToken: _botToken, ...rest } = a;
  return rest;
}

export class AccountStore {
  private readonly accounts: AccountMap;
  private readonly listeners: Array<() => void> = [];

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.accounts = readJsonFile<AccountMap>(this.path, {});
  }

  list(): Account[] {
    return Object.values(this.accounts).map((a) => ({ ...a }));
  }

  listPublic(): PublicAccount[] {
    return this.list().map(toPublic);
  }

  get(accountId: string): Account | undefined {
    const a = this.accounts[accountId];
    return a ? { ...a } : undefined;
  }

  /** 新增账号并落盘,随后通知连接集合发生了变化。 */
  add(account: Account): void {
    this.accounts[account.accountId] = { ...account };
    this.persist();
    this.emit();
  }

  /** 移除账号。**不删除该账号下用户的会话与工作目录** —— 数据交给保留期自然清理。 */
  remove(accountId: string): boolean {
    if (!(accountId in this.accounts)) return false;
    delete this.accounts[accountId];
    this.persist();
    this.emit();
    return true;
  }

  /**
   * TOFU 绑定:把该账号的主人记为 userId。已绑定时不覆盖 ——
   * 换人必须先显式 unbind,避免任何一条来信能悄悄改写主人。
   */
  bind(accountId: string, userId: string): boolean {
    const a = this.accounts[accountId];
    if (!a || a.boundUserId) return false;
    a.boundUserId = userId;
    this.persist();
    return true;
  }

  /**
   * 改备注名。传空串等于恢复默认名。返回 false 表示账号不存在。
   * 只是给人看的标签,不影响连接与准入,所以不触发 emit()。
   */
  rename(accountId: string, displayName: string): boolean {
    const a = this.accounts[accountId];
    if (!a) return false;
    a.displayName = normalizeAccountName(displayName, accountId);
    this.persist();
    return true;
  }

  /**
   * 解除绑定,下一条来信会重新触发 TOFU。
   *
   * 别名与待认领标记一并清空:它们都是"接着服务同一个人"的机制,而 unbind 的语义
   * 恰恰是换人 —— 留着会让旧主人的标识继续被映射成新主人。
   */
  unbind(accountId: string): boolean {
    const a = this.accounts[accountId];
    if (!a) return false;
    delete a.boundUserId;
    delete a.pendingRebind;
    delete a.userIdAliases;
    this.persist();
    return true;
  }

  /**
   * 用重新扫码得到的凭据替换本账号的旧凭据。**accountId、备注名、绑定关系原样保留** ——
   * 这正是"重新扫码"与"删掉重加"的区别:userKey 的前两段不变,那位用户的会话、
   * 工作目录与个人配置才接得上。
   *
   * 已绑定的账号会置 `pendingRebind`,让下一条来信认领 userKey 的第三段(见
   * `canonicalUserId()`);未绑定的不置 —— 它下一条来信本来就走 TOFU。
   *
   * 触发 emit():连接集合虽然没变,但那条连接握的是旧 token,必须重建。
   */
  replaceCredentials(
    accountId: string,
    cred: { botToken: string; baseUrl: string; botId: string },
  ): boolean {
    const a = this.accounts[accountId];
    if (!a) return false;
    a.botToken = cred.botToken;
    a.baseUrl = cred.baseUrl;
    a.botId = cred.botId;
    delete a.expiredAt;
    if (a.boundUserId) a.pendingRebind = true;
    this.persist();
    this.emit();
    return true;
  }

  /** 记下凭据已失效(errcode=-14),供账号页提示"需要重新扫码"。 */
  markExpired(accountId: string): void {
    const a = this.accounts[accountId];
    if (!a || a.expiredAt) return;
    a.expiredAt = this.now();
    this.persist();
  }

  /**
   * 把来信的原始 from_user_id 归一成本账号的规范身份,供渠道拼 userKey。
   *
   * 两件事:消费 `pendingRebind`(重新扫码后的第一条来信),再查 `userIdAliases`。
   * 顺序不能反 —— 认领与命中必须发生在同一条来信上,否则第一条消息会以新标识
   * 开一个空白用户。
   *
   * 安全前提与 TOFU 同一条:扫码得到的 bot 属于扫码那个微信号自己,别人发不进来,
   * 所以"重新扫码后的第一条来信就是主人"和"账号建立后的第一条来信就是主人"一样成立。
   * 拿别人的微信去重新扫码 = 把该用户的会话与工作目录交给对方,这是管理员的选择,
   * 账号页上写明了。
   */
  canonicalUserId(accountId: string, rawUserId: string): string {
    const a = this.accounts[accountId];
    if (!a) return rawUserId;
    if (a.pendingRebind) {
      delete a.pendingRebind;
      if (a.boundUserId && a.boundUserId !== rawUserId) {
        a.userIdAliases = { ...(a.userIdAliases ?? {}), [rawUserId]: a.boundUserId };
        console.info(
          `[accounts] 账号 ${accountId} 重新扫码后换了对端标识,` +
            `${rawUserId} 归并到原主人 ${a.boundUserId}`,
        );
      }
      this.persist();
    }
    return a.userIdAliases?.[rawUserId] ?? rawUserId;
  }

  /** 记录一次被拒的来信(按 userId 去重累加,最多保留 MAX_REJECTIONS 个)。 */
  recordRejection(accountId: string, userId: string): void {
    const a = this.accounts[accountId];
    if (!a) return;
    const list = a.rejections ?? [];
    const hit = list.find((r) => r.userId === userId);
    if (hit) {
      hit.count += 1;
      hit.lastAt = this.now();
    } else {
      list.unshift({ userId, count: 1, lastAt: this.now() });
      if (list.length > MAX_REJECTIONS) list.length = MAX_REJECTIONS;
    }
    a.rejections = list;
    this.persist();
  }

  /**
   * 订阅「连接需要重新对齐」。渠道据此动态起停连接,从而让 dashboard 上扫码完成后
   * 无需重启进程就能开始收消息。
   *
   * 触发者是 add/remove(集合变了)与 replaceCredentials(集合没变但那条连接
   * 握着作废的 token,必须重建);bind/unbind/rename/recordRejection 不触发。
   */
  onConnectionSetChanged(listener: () => void): void {
    this.listeners.push(listener);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error("[accounts] 变更回调失败:", err);
      }
    }
  }

  private persist(): void {
    // 含 bot_token,必须 0600。
    writeJsonFileAtomic(this.path, this.accounts, 0o600);
  }
}
