import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * dashboard 鉴权。整站(含只读页面)都要 token —— 会话记录本身就是敏感内容,
 * 里面可能有密钥、家庭信息、命令历史。
 *
 * 读与写的取值来源刻意不同:
 *   - 读:Cookie 或 ?token=,便于日常一个链接打开
 *   - 写:**只认 X-Catman-Token 请求头**
 *
 * 写操作不认 Cookie 是防 CSRF:浏览器会自动带上 Cookie,任何外部页面都能诱导
 * 当前浏览器向内网 dashboard 发一个删账号的请求;而自定义请求头无法被跨站表单
 * 伪造(且会触发 CORS 预检)。
 */

export const TOKEN_COOKIE = "catman_token";
export const TOKEN_HEADER = "x-catman-token";
export const TOKEN_QUERY = "token";

/** 定长时间比较,避免逐字符比较泄露 token 前缀。 */
export function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // 长度不同时 timingSafeEqual 会抛错;比较一个等长副本以保持恒定耗时。
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export class DashboardAuth {
  constructor(private readonly token: string) {}

  /**
   * 读操作是否获准:请求头、Cookie、?token= 任一命中即可。
   *
   * 请求头也算数,是因为它是比 Cookie 更强的凭据(不会被跨站自动携带) ——
   * 只认 Cookie 会让纯 API 客户端(只带头)连读都被拒,写操作更是无从谈起。
   */
  allowsRead(req: IncomingMessage, url: URL): boolean {
    if (this.allowsWrite(req)) return true;
    const q = url.searchParams.get(TOKEN_QUERY);
    if (q && tokenEquals(q, this.token)) return true;
    const cookie = parseCookies(req.headers.cookie)[TOKEN_COOKIE];
    return !!cookie && tokenEquals(cookie, this.token);
  }

  /** 写操作是否获准:仅接受请求头(见文件头关于 CSRF 的说明)。 */
  allowsWrite(req: IncomingMessage): boolean {
    const raw = req.headers[TOKEN_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    return !!header && tokenEquals(header, this.token);
  }

  /** URL 里带了正确的 token,应当种 Cookie 并重定向到去掉 token 的地址。 */
  shouldExchangeQueryToken(url: URL): boolean {
    const q = url.searchParams.get(TOKEN_QUERY);
    return !!q && tokenEquals(q, this.token);
  }

  cookieHeader(): string {
    // 不设 Secure:内网多为 http 访问,设了会导致 Cookie 根本不被保存。
    return `${TOKEN_COOKIE}=${encodeURIComponent(this.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
  }
}

/** 去掉 token 参数后的路径 + 查询串,用于换 Cookie 后的重定向目标。 */
export function urlWithoutToken(url: URL): string {
  const clean = new URL(url.toString());
  clean.searchParams.delete(TOKEN_QUERY);
  return `${clean.pathname}${clean.search}`;
}
