import { createDecipheriv, randomInt } from "node:crypto";

/**
 * 微信 iLink 协议(腾讯官方 ClawBot 协议,ilinkai.weixin.qq.com)的公共部分:
 * 端点常量、App 标识、请求头与 POST 封装。连接(ilink-connection.ts)与扫码登录
 * (ilink-login.ts)共用,避免两处各自维护一份 header 拼装。
 *
 * 规格来自 Tencent/openclaw-weixin 源码(src/api/api.ts、types.ts)与三个独立 demo 交叉验证。
 *
 * App 标识说明(已据官方源码 + package.json 确认,无需申请):
 *   - iLink-App-Id 官方固定为 "bot"(所有 openclaw-weixin 实例共用)
 *   - iLink-App-ClientVersion 由包版本号编码为 uint32(0x00MMNNPP),不是凭证
 *   - 唯一属于个人的凭据是扫码换来的 bot_token
 *
 * 已真机验证:
 *   - get_bot_qrcode 返回 { ret, qrcode, qrcode_img_content },其中 qrcode_img_content
 *     是**授权 URL 文本**(https://liteapp.weixin.qq.com/q/...)而非图片,尽管字段名叫 img
 *   - get_qrcode_status 是**长轮询**,无人扫码时阻塞约 30 秒返回 { ret:0, status:"wait" }
 *   - 上面这套请求头(含 appid="bot")足以调通这两个端点
 *
 * ⚠️ 仍需真机验证的细节:
 *   - SKRouteTag 的来源与何时必带
 *   - base_info.channel_version 取值(demo 用 "1.0.2",官方包 version 为 2.4.x,以实测为准)
 *   - 具体限流阈值
 */

/** 把 semver 编码成 iLink 客户端版本 uint32:0x00MMNNPP(major/minor/patch 各一字节)。 */
export function buildClientVersion(version: string): number {
  const [maj = 0, min = 0, patch = 0] = version.split(".").map((n) => parseInt(n, 10) || 0);
  return ((maj & 0xff) << 16) | ((min & 0xff) << 8) | (patch & 0xff);
}

export const ILINK = {
  host: process.env.ILINK_HOST ?? "https://ilinkai.weixin.qq.com",
  channelVersion: process.env.ILINK_CHANNEL_VERSION ?? "1.0.2",
  botAgent: "catman/0.1.0",
  // 官方固定值;保留 env 覆盖以便随官方包升级或真机校准。
  appId: process.env.ILINK_APP_ID ?? "bot",
  // 兼容官方包当前版本;可用 env 覆盖为实测所需版本字符串。
  appClientVersion: String(buildClientVersion(process.env.ILINK_APP_VERSION ?? "2.4.6")),
};

/**
 * 本渠道的名字。**同时是 `Channel.name` 和 userKey 的第一段**,两处必须是同一个值:
 * `CompositeChannel` 拿 userKey 的 channel 段去 `byName` 里找渠道来发送回复,
 * 对不上就收得到消息、发不出回复(agent 跑完了,回复在路由这一步抛错)。
 * 所以这里用一个常量供两边引用,而不是各写一遍字面量。
 */
export const WECHAT_CHANNEL = "wechat";

/** 长轮询端点用更长的超时;其余用短超时。 */
export const LONG_POLL_PATH = "ilink/bot/getupdates";
const LONG_POLL_TIMEOUT_MS = 40_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: ILINK.channelVersion, bot_agent: ILINK.botAgent };
}

/** 带 bot_token 的鉴权请求头。botToken 为空时用于未登录阶段的公开端点。 */
export function ilinkHeaders(botToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "X-WECHAT-UIN": Buffer.from(String(randomInt(0, 2 ** 31))).toString("base64"),
  };
  if (botToken) {
    h["AuthorizationType"] = "ilink_bot_token";
    h["Authorization"] = `Bearer ${botToken}`;
  }
  // 已确认的固定标识(见文件头);为空只可能是被 env 显式清空。
  if (ILINK.appId) h["iLink-App-Id"] = ILINK.appId;
  if (ILINK.appClientVersion) h["iLink-App-ClientVersion"] = ILINK.appClientVersion;
  return h;
}

/**
 * 媒体 CDN。图片不随消息正文下发,消息里只带一份「去哪取 + 怎么解」的凭据,
 * 字节要另外去 CDN 拉,且是 **AES-128-ECB 加密**的。
 *
 * 规格同样来自 Tencent/openclaw-weixin(src/cdn/、src/media/media-download.ts)。
 * 与主机地址一样允许 env 覆盖,便于随官方变更校准。
 */
export const CDN_BASE_URL = process.env.ILINK_CDN_BASE_URL ?? "https://novac2c.cdn.weixin.qq.com/c2c";

/** 消息里描述一份 CDN 媒体的字段。字段全是可选的 —— 服务端给什么全看媒体类型。 */
export interface CdnMedia {
  /** 服务端直接给的完整下载地址。给了就用它,不必自己拼。 */
  full_url?: string;
  /** 没有 full_url 时用它拼下载地址。 */
  encrypt_query_param?: string;
  /** base64 的 AES key。图片还可能把 key 放在 image_item.aeskey(hex)里。 */
  aes_key?: string;
}

/**
 * 解析 CDN 的 AES key。
 *
 * 野外有两种编码,必须都认(openclaw-weixin 的 parseAesKey 同样如此):
 *   - base64(16 字节原文)  —— 图片走 media.aes_key 时是这种
 *   - base64(32 位 hex 字符串) —— 文件/语音/视频是这种
 * 只认第一种的话,解出来的 key 是 32 字节,createDecipheriv 会直接抛错。
 */
export function parseCdnAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) {
    return Buffer.from(ascii, "hex");
  }
  throw new Error(`CDN aes_key 长度异常:解出 ${decoded.length} 字节,既不是 16 也不是 32 位 hex`);
}

/** 拼 CDN 下载地址。仅在服务端没给 full_url 时用。 */
export function buildCdnDownloadUrl(encryptedQueryParam: string, baseUrl = CDN_BASE_URL): string {
  return `${baseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/**
 * 从 CDN 取一份媒体的明文字节。
 *
 * 没有 aes_key 时按未加密处理 —— 协议里确实存在这种情况(openclaw-weixin 对图片
 * 留了 downloadPlainCdnBuffer 这条分支),硬要求 key 会把这类图片全丢掉。
 */
export async function fetchCdnMedia(
  media: CdnMedia,
  opts: { aesKeyBase64?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const url = media.full_url || (media.encrypt_query_param
    ? buildCdnDownloadUrl(media.encrypt_query_param)
    : undefined);
  if (!url) throw new Error("CDN 媒体既无 full_url 也无 encrypt_query_param,无法下载");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? MEDIA_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`CDN 下载失败 ${res.status} ${res.statusText}`);
    const raw = Buffer.from(await res.arrayBuffer());

    const keyBase64 = opts.aesKeyBase64 ?? media.aes_key;
    if (!keyBase64) return raw; // 未加密的那条分支
    const decipher = createDecipheriv("aes-128-ecb", parseCdnAesKey(keyBase64), null);
    return Buffer.concat([decipher.update(raw), decipher.final()]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** 媒体下载超时。比普通接口宽松:走的是 CDN,几 MB 的图片正常也要几秒。 */
const MEDIA_TIMEOUT_MS = 30_000;

export interface PostOptions {
  baseUrl?: string;
  botToken?: string;
  /** 覆盖超时;默认按端点是否为长轮询自动选择。 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** POST 一个 JSON 请求并解析 JSON 响应。 */
export async function ilinkPost<T>(
  path: string,
  body: unknown,
  opts: PostOptions = {},
): Promise<T> {
  const base = (opts.baseUrl || ILINK.host).replace(/\/$/, "");
  const timeoutMs =
    opts.timeoutMs ?? (path === LONG_POLL_PATH ? LONG_POLL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  return request<T>(`${base}/${path}`, {
    method: "POST",
    headers: ilinkHeaders(opts.botToken),
    body: JSON.stringify(body),
    timeoutMs,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/** GET 一个 JSON 端点(扫码登录用)。 */
export async function ilinkGet<T>(path: string, opts: PostOptions = {}): Promise<T> {
  const base = (opts.baseUrl || ILINK.host).replace(/\/$/, "");
  return request<T>(`${base}/${path}`, {
    method: "GET",
    headers: ilinkHeaders(opts.botToken),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

interface RequestInitPlus {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

async function request<T>(url: string, init: RequestInitPlus): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  // 外部 signal(如渠道停机)与超时任一触发都要中断。
  const onAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: controller.signal,
    });
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}
