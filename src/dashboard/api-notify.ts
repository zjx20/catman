import type { NotifyTokens } from "../core/notify-tokens.js";
import type { ApiResult } from "./api-self.js";

/**
 * `POST /api/me/notify` —— 让**活得比回合久**的进程给用户说一句话。
 *
 * 它存在的全部理由是一句一直兑现不了的承诺:脱钩的后台任务(制备、备份、
 * 长时间的构建)活得过会话,但没有任何人替它说话 —— 回合令牌随回合作废,
 * 而常驻的监视进程同样活不过会话。于是助手只能说"你下次开口时我再去看日志",
 * 而不能说"跑完通知你"。这个端点把后半句变成真的。
 *
 * ## 鉴权刻意与 /api/me 分开
 *
 * 用**另一个请求头** `X-Catman-Notify` 和另一枚令牌(`core/notify-tokens.ts`)。
 * 与 api-self 对 admin token 的态度是同一条:两种凭据作用域不同,同名迟早会写出
 * "该收 notify 的地方收了 session"这种错。而这两枚的寿命差着一个数量级 ——
 * 混用的后果是把一枚长期令牌的效力悄悄扩大到 /api/me 的全部读写。
 *
 * ## 为什么要限流
 *
 * 主动推送花的是用户**上一条来信**带来的发送预算(一份 10 条)。超了之后
 * 信使那边 ret=-2 不恢复 —— 一个写错的 `while true` 能把人打成永久静默,
 * 而那时候他连"别发了"都递不进来。定时任务靠最小间隔天然限住了,这个端点
 * 没有那道闸,所以自己带一个。
 */

export const NOTIFY_HEADER = "x-catman-notify";

/** 单条消息的硬上限。兜底而已 —— 正常调用方(catman-notify)自己就截过尾巴了。 */
const MAX_TEXT = 2000;

/** 限流窗口与额度。20 条/小时:比一份发送预算(10 条)略宽,又远够不到"刷屏"。 */
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 20;

export function isNotifyApiPath(path: string): boolean {
  return path === "/api/me/notify";
}

/**
 * 每用户滑动窗口限流。
 *
 * 状态放在实例里而不是模块级变量:模块级的话单测之间会互相串味,
 * 而"限流"这种东西一旦串味,测出来的绿是假的。
 */
export class NotifyRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxPerWindow: number = MAX_PER_WINDOW,
    private readonly windowMs: number = WINDOW_MS,
  ) {}

  /** 记一次并返回是否放行。超额时**不记账** —— 否则被限住的调用方会把窗口一直续下去。 */
  allow(userKey: string, now: number): boolean {
    const fresh = (this.hits.get(userKey) ?? []).filter((t) => now - t < this.windowMs);
    if (fresh.length >= this.maxPerWindow) {
      this.hits.set(userKey, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.set(userKey, fresh);
    return true;
  }
}

export interface NotifyApiDeps {
  tokens: NotifyTokens;
  limiter: NotifyRateLimiter;
  /** 推送出口。与定时任务播报同一条路径(gateway.push),因此也同样**不抛错**。 */
  push: (userKey: string, text: string) => Promise<void>;
  now?: () => number;
}

export async function handleNotifyApi(
  method: string,
  path: string,
  token: string | undefined,
  body: unknown,
  deps: NotifyApiDeps,
): Promise<ApiResult> {
  if (!isNotifyApiPath(path)) return { status: 404, body: { error: `未知路径 ${path}` } };
  if (method !== "POST") return { status: 405, body: { error: "只支持 POST" } };

  const userKey = token ? deps.tokens.resolve(token) : undefined;
  if (!userKey) {
    return { status: 401, body: { error: "需要有效的 X-Catman-Notify 请求头" } };
  }

  const raw = body && typeof body === "object" ? (body as { text?: unknown }).text : undefined;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { status: 400, body: { error: "text 不能为空" } };

  const now = (deps.now ?? Date.now)();
  if (!deps.limiter.allow(userKey, now)) {
    // 429 的正文要说清"被挡掉的是哪一条",否则调用方只知道失败、不知道丢了什么。
    return {
      status: 429,
      body: { error: `推送太频繁(上限 ${MAX_PER_WINDOW} 条/小时),这一条没有发出去`, dropped: text.slice(0, 200) },
    };
  }

  const sent = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…(太长,后面截掉了)` : text;
  await deps.push(userKey, sent);
  return { status: 200, body: { ok: true } };
}
