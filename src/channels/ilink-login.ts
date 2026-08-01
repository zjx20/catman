import { randomBytes } from "node:crypto";
import { AccountStore, normalizeAccountName, type Account } from "../core/accounts.js";
import { newAccountId } from "../core/identity.js";
import { ILINK, ilinkGet } from "./ilink-protocol.js";
import { qrDataUri } from "../dashboard/qrcode.js";

/**
 * iLink 扫码登录流程。dashboard 与 CLI 脚本共用。
 *
 * QR 端点未在官方 api.ts 中出现,但已真机验证可用。两点与字面直觉不同:
 *   - `qrcode_img_content` 尽管名字里有 img,返回的是**授权 URL 文本**而非图片,
 *     所以二维码要自己编码(dashboard/qrcode.ts)
 *   - `get_qrcode_status` 是**长轮询**,无人扫码时阻塞约 30 秒才回 status:"wait",
 *     因此它单独用更长的超时,调用方也不必再自行等待
 *
 * 响应解析仍保持防御式:未知的 status 值按"未完成"处理并告警一次,
 * 不因协议演进而误判成失败。
 */

/** 二维码有效期。超过后 poll() 一律返回 expired。 */
const LOGIN_TTL_MS = 3 * 60 * 1000;

/**
 * get_qrcode_status 是**长轮询**:真机实测在无人扫码时阻塞约 30 秒才返回
 * `{"ret":0,"status":"wait"}`。用默认的 15 秒超时会每次都被中断,所以单独放宽。
 */
const STATUS_POLL_TIMEOUT_MS = 60_000;

/** 真机实测的"尚未完成"状态值;其余未知值也按未完成处理(只告警一次)。 */
const PENDING_STATUSES = new Set(["wait", "pending", "scan", "scanned"]);
/** 需要重新生成二维码的终态。 */
const DEAD_STATUSES = new Set(["expired", "cancel", "canceled", "cancelled", "invalid"]);

export interface LoginSession {
  loginId: string;
  /** 二维码 key(查询扫码状态的凭据)。**不是**二维码要编码的内容。 */
  qrcode: string;
  /**
   * 二维码承载的内容(一个 https://liteapp.weixin.qq.com/... 的授权 URL)。
   * 真机实测:接口字段名叫 `qrcode_img_content`,但返回的是 URL 而不是图片。
   */
  qrcodeContent?: string;
  /** 由 qrcodeContent 编码出的二维码,可直接用于 <img src>。 */
  qrcodeImage?: string;
  expiresAt: number;
}

export type LoginStatus = "pending" | "confirmed" | "expired";

export interface LoginPollResult {
  status: LoginStatus;
  /** confirmed 时返回新建的账号 id。 */
  accountId?: string;
}

interface QrcodeResp {
  qrcode?: string;
  qrcode_img_content?: string;
  errmsg?: string;
}

interface QrcodeStatusResp {
  status?: string;
  bot_token?: string;
  baseurl?: string;
  bot_id?: string;
  errmsg?: string;
}

interface PendingLogin extends LoginSession {
  /** 确认后置位,避免重复轮询重复建账号。 */
  accountId?: string;
  /**
   * 扫码前填的备注名。这里存着而不是等建完账号再改:多账号时二维码长得一模一样,
   * 扫完再回头认"刚才那个是谁"最容易配错人。
   */
  displayName?: string;
}

export class ILinkLogin {
  private readonly sessions = new Map<string, PendingLogin>();

  constructor(
    private readonly accounts: AccountStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** 申请一个二维码,返回可展示的登录会话。displayName 是可选备注名,留空用默认。 */
  async start(displayName = ""): Promise<LoginSession> {
    this.prune();
    const resp = await ilinkGet<QrcodeResp>("ilink/bot/get_bot_qrcode?bot_type=3");
    if (!resp.qrcode) {
      console.error("[ilink-login] get_bot_qrcode 响应无法识别:", JSON.stringify(resp));
      throw new Error(`获取二维码失败: ${resp.errmsg ?? JSON.stringify(resp)}`);
    }
    const content = resp.qrcode_img_content;
    if (!content) {
      // 没有可编码的内容就没法生成二维码;qrcode key 本身不是有效的扫码目标。
      console.error("[ilink-login] 响应缺少 qrcode_img_content:", JSON.stringify(resp));
    }
    const session: PendingLogin = {
      loginId: randomBytes(8).toString("hex"),
      qrcode: resp.qrcode,
      expiresAt: this.now() + LOGIN_TTL_MS,
      ...(displayName.trim() ? { displayName } : {}),
      ...(content ? { qrcodeContent: content, qrcodeImage: renderQrcode(content) } : {}),
    };
    this.sessions.set(session.loginId, session);
    return { ...session };
  }

  /**
   * 查询扫码状态。确认后就地创建账号并写入 AccountStore ——
   * AccountStore 的变更回调会让渠道立刻拉起这条连接,无需重启进程。
   */
  async poll(loginId: string): Promise<LoginPollResult> {
    const session = this.sessions.get(loginId);
    if (!session) return { status: "expired" };
    // 已确认过:幂等返回,不重复建账号。
    if (session.accountId) return { status: "confirmed", accountId: session.accountId };
    if (this.now() >= session.expiresAt) {
      this.sessions.delete(loginId);
      return { status: "expired" };
    }

    const st = await ilinkGet<QrcodeStatusResp>(
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`,
      { timeoutMs: STATUS_POLL_TIMEOUT_MS },
    );

    const status = st.status ?? "";
    if (DEAD_STATUSES.has(status)) {
      this.sessions.delete(loginId);
      return { status: "expired" };
    }
    if (status !== "confirmed" || !st.bot_token) {
      if (!PENDING_STATUSES.has(status)) {
        // 未知状态值:按未完成处理,但把原样响应记一次,便于真机校准字段。
        this.warnUnknownStatus(status, st);
      }
      return { status: "pending" };
    }

    const accountId = newAccountId();
    const account: Account = {
      accountId,
      channel: "wechat",
      botToken: st.bot_token,
      baseUrl: st.baseurl ?? ILINK.host,
      botId: st.bot_id ?? "",
      displayName: normalizeAccountName(session.displayName ?? "", accountId),
      createdAt: this.now(),
    };
    this.accounts.add(account);
    session.accountId = accountId;
    return { status: "confirmed", accountId };
  }

  /** 已告警过的未知状态值。长轮询每 30 秒一轮,不去重会刷屏。 */
  private readonly warnedStatuses = new Set<string>();

  private warnUnknownStatus(status: string, raw: unknown): void {
    if (this.warnedStatuses.has(status)) return;
    this.warnedStatuses.add(status);
    console.warn(
      `[ilink-login] get_qrcode_status 返回未知状态 "${status}",按未完成处理:`,
      JSON.stringify(raw),
    );
  }

  /** 丢弃已过期的登录会话,避免内存里无限堆积。 */
  private prune(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) {
      if (t >= s.expiresAt && !s.accountId) this.sessions.delete(id);
    }
  }
}

/**
 * 把二维码内容编成图片。接口只给内容不给图,所以这里自己编码
 * (dashboard/qrcode.ts,零依赖)。若内容本身已经是 data URI(接口日后改成直接返图)
 * 则原样透传。
 */
function renderQrcode(content: string): string | undefined {
  if (content.startsWith("data:")) return content;
  try {
    return qrDataUri(content);
  } catch (err) {
    console.error(`[ilink-login] 二维码编码失败(内容长度 ${content.length}):`, err);
    return undefined;
  }
}
