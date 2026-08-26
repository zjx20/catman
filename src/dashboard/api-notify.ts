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
 *
 * ## 为什么要分页
 *
 * 长正文从前是直接截断的,而且截得**无声**:内容没了,调用方拿到的还是 200。
 * 一份两千多字符的日报会在半句话处断掉,看起来像服务坏了。现在改成先切页
 * 再发(最多 3 页),超过三页才真的开始丢 —— 丢的时候仍然留下那句
 * "(太长,后面截掉了)",因为那是外部已经在依赖的信号。
 *
 * 分页只能在这一层做:信使那边 `channels/types.ts` 虽然写着"实现方负责必要的
 * 分段",但 iLink 的实现并没有做,它把整段塞进一个 text_item。
 */

export const NOTIFY_HEADER = "x-catman-notify";

/**
 * 单条消息的硬上限。
 *
 * 从前这里写的是"兜底而已 —— 正常调用方(catman-notify)自己就截过尾巴了"。
 * 那句话只对 `catman-notify run` 成立(它 `tail -c 1200` 取日志尾巴),对
 * `send` 从来不成立:`cmd_send` 一个字都不截,直接 post。于是这道本该兜底的闸
 * 成了 send 路径上唯一的一道,而且是**无声**的 —— 一份 2522 字符的日报被切在
 * 第 2000 个字符,用户看到半句话就没了,还以为服务坏了。
 *
 * 信使那边也不会帮忙:`channels/types.ts` 写着"实现方负责必要的分段",但
 * iLink 的实现是把整段塞进一个 text_item(`ilink-connection.ts` 的 send),
 * 没有任何按长度切分。所以要分页,只能在这里分 —— 这里正好同时知道原文和限额。
 */
const MAX_PAGE = 2000;

/**
 * 一次推送最多切几页。
 *
 * 3 是权衡出来的:一个 iLink context_token 只够发 10 条(见 courier/reply-store.ts),
 * 一次推送吃掉 3 条已经不轻;再多就该反省是不是该发个链接而不是刷屏。
 */
const MAX_PAGES = 3;

/** 页码标记占的位置。"\n\n(第 3/3 页)" 撑死 13 个字符,留点余量。 */
const PAGE_MARK_RESERVE = 16;

/** 每页真正能装的正文。 */
const PAGE_BODY = MAX_PAGE - PAGE_MARK_RESERVE;

/** 准入门槛:超过这么长才真的开始丢内容。这个串是外部行为,别改它的字面。 */
const TRUNC_MARK = "\n…(太长,后面截掉了)";
const MAX_TEXT = PAGE_BODY * MAX_PAGES;

/** 限流窗口与额度。20 条/小时:比一份发送预算(10 条)略宽,又远够不到"刷屏"。 */
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 20;

export function isNotifyApiPath(path: string): boolean {
  return path === "/api/me/notify";
}

/**
 * 在 limit 以内找一个体面的断点:优先换行,其次空格,都没有就硬切。
 *
 * 断点太靠前就不值当了 —— 一页只装三分之一,页数白白多一页,
 * 所以设了下限:换行至少要出现在一半之后,空格至少要在八成之后。
 */
function cutAt(s: string, limit: number): number {
  if (s.length <= limit) return s.length;
  const window = s.slice(0, limit);
  const nl = window.lastIndexOf("\n");
  if (nl >= limit * 0.5) return nl + 1;
  const sp = window.lastIndexOf(" ");
  if (sp >= limit * 0.8) return sp + 1;
  return limit;
}

/**
 * 把一段正文切成 1~MAX_PAGES 页,每页都不超过 MAX_PAGE。
 *
 * 导出是为了单测能直接盯住边界:分页这种东西错一个字符就是"用户看不到后半篇",
 * 而那正是它当初被漏掉的方式 —— 从 API 外面观察不到,只能从里面钉住。
 */
export function paginateNotify(text: string): string[] {
  let rest = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  let truncated = rest.length < text.length;

  const pages: string[] = [];
  while (rest.length > 0 && pages.length < MAX_PAGES) {
    const n = cutAt(rest, PAGE_BODY);
    pages.push(rest.slice(0, n).trimEnd());
    rest = rest.slice(n);
  }
  // 页数用完还有剩:按换行切会让每页装不满,所以这条即使没触发上面的 slice 也可能成立。
  if (rest.length > 0) truncated = true;
  if (pages.length === 0) pages.push("");

  if (truncated) {
    const last = pages.length - 1;
    const room = PAGE_BODY - TRUNC_MARK.length;
    pages[last] = `${pages[last]!.slice(0, room).trimEnd()}${TRUNC_MARK}`;
  }

  const total = pages.length;
  if (total === 1) return pages;
  return pages.map((p, i) => `${p}\n\n(第 ${i + 1}/${total} 页)`);
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

  /**
   * 记 `cost` 次并返回是否放行。超额时**不记账** —— 否则被限住的调用方会把窗口一直续下去。
   *
   * `cost` 是这次实际要发几条消息。一次推送能切成三页之后,再按"一次调用记一次"
   * 算就等于把额度悄悄放大三倍,而这道闸挡的恰恰是"把人打成永久静默"。
   * 额度不够时整条拒收,不做半截投递 —— 收到前两页、第三页永远不来,
   * 比一条都没收到更难查。
   */
  allow(userKey: string, now: number, cost = 1): boolean {
    const fresh = (this.hits.get(userKey) ?? []).filter((t) => now - t < this.windowMs);
    if (fresh.length + cost > this.maxPerWindow) {
      this.hits.set(userKey, fresh);
      return false;
    }
    for (let i = 0; i < cost; i++) fresh.push(now);
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

  // 先分页再问额度:要发几条得先知道,否则限流按"一次调用"算,分页就成了绕过它的口子。
  const pages = paginateNotify(text);

  const now = (deps.now ?? Date.now)();
  if (!deps.limiter.allow(userKey, now, pages.length)) {
    // 429 的正文要说清"被挡掉的是哪一条",否则调用方只知道失败、不知道丢了什么。
    return {
      status: 429,
      body: {
        error: `推送太频繁(上限 ${MAX_PER_WINDOW} 条/小时,这次要发 ${pages.length} 条),这一条没有发出去`,
        dropped: text.slice(0, 200),
      },
    };
  }

  // 顺序发,一页一页等 —— 并发出去就是乱序,而分页的正文乱序等于没发。
  for (const page of pages) await deps.push(userKey, page);
  return { status: 200, body: { ok: true, pages: pages.length } };
}
