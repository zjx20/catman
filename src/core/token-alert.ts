import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "./file-store.js";

/**
 * OAuth token 到期告警。
 *
 * ## 为什么它值得单独一个模块
 *
 * token 过期是「失败域诚实条款」点名的三大死法之一(磁盘满 / 内存尽 / token 过期):
 * 它废掉的不只是主人格 —— 救援大脑用的是**同一份** token(§18 已定决策:第二份
 * 错开到期的 token 不配,因为换发必须人在宿主跑 `claude setup-token`,大脑多活一阵
 * 没有意义)。所以整个系统对它的唯一防线就是**提前告警**,而告警必须在它还没过期、
 * 人还来得及跑一趟宿主的时候送达。
 *
 * ## 过期时刻从哪来 —— 以及什么时候根本拿不到
 *
 * SDK 的凭据文件 `$CLAUDE_CONFIG_DIR/.credentials.json` 里有
 * `claudeAiOauth.expiresAt`(毫秒时间戳)—— 交互式登录会写它。
 * 而生产上用 `claude setup-token` 生成的长效 token 走 **env**(`CLAUDE_CODE_OAUTH_TOKEN`),
 * 那是个不透明字符串,凭据文件可能压根不存在 —— 那时到期时刻**真的不可知**。
 * 与 version.ts 同一条纪律:**读不到就是 undefined,绝不编。** 状态页如实显示
 * 「未知」,不发任何告警 —— 编一个假倒计时比没有倒计时糟得多(人会信它)。
 *
 * ## 告警的去重语义
 *
 * 阈值阶梯 14 → 7 → 3 → 1 天 → 已过期。**每个阈值只播一次**,记账落盘
 * (进程重启不重播);token 换新(expiresAt 变了)自动清零重来。
 * 只降不升:告过 3 天的不再回头告 7 天。
 */

/** 告警阈值(天),从宽到严。0 表示已过期。 */
export const TOKEN_ALERT_DAYS: readonly number[] = [14, 7, 3, 1];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 从凭据文件的 JSON 里挖出过期时刻。防御式:形状不对一律 undefined。
 * 过去的时间戳**照样返回** —— "已过期"本身就是最要紧的那条信息。
 */
export function parseCredentialsExpiry(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const oauth = (raw as Record<string, unknown>)["claudeAiOauth"];
  if (!oauth || typeof oauth !== "object") return undefined;
  const exp = (oauth as Record<string, unknown>)["expiresAt"];
  return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp : undefined;
}

/** 读 `$CLAUDE_CONFIG_DIR/.credentials.json` 的过期时刻。读不到 / 读不懂 → undefined。 */
export function readTokenExpiry(configDir: string): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(configDir, ".credentials.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseCredentialsExpiry(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export type TokenStatus =
  /** 凭据文件不存在或没有到期信息(env 长效 token 就是这种)。不告警。 */
  | { readonly kind: "unknown" }
  | { readonly kind: "ok"; readonly daysLeft: number }
  /** 进了某个告警阈值。threshold 是**当前所处**的最严阈值。 */
  | { readonly kind: "warn"; readonly daysLeft: number; readonly threshold: number }
  | { readonly kind: "expired" };

/** 现在处于哪一档。纯函数,时刻注入。 */
export function tokenStatus(expiresAt: number | undefined, now: number): TokenStatus {
  if (expiresAt === undefined) return { kind: "unknown" };
  if (now >= expiresAt) return { kind: "expired" };
  // ceil:剩 0.2 天算 1 天 —— 告警宁早勿晚,而"还剩 0 天"读起来像已经过期。
  const daysLeft = Math.ceil((expiresAt - now) / DAY_MS);
  const crossed = TOKEN_ALERT_DAYS.filter((t) => daysLeft <= t);
  const threshold = crossed[crossed.length - 1];
  return threshold === undefined ? { kind: "ok", daysLeft } : { kind: "warn", daysLeft, threshold };
}

/** 状态页上的一行。expired/warn/ok/unknown 四种口径都在这里,别在渲染层再造一份。 */
export function tokenStatusLine(s: TokenStatus): string {
  switch (s.kind) {
    case "unknown":
      return "到期时间未知(env 长效 token 没有到期信息;真正的探测靠回合报错原文)";
    case "ok":
      return `还有约 ${s.daysLeft} 天到期`;
    case "warn":
      return `⚠️ 还有约 ${s.daysLeft} 天到期 —— 到期前要人在宿主上跑一次 claude setup-token`;
    case "expired":
      return "❌ 已过期 —— 两个人格的大脑都废了,必须人在宿主上跑 claude setup-token 换新";
  }
}

/**
 * 该不该向管理员播一条告警。
 *
 * `lastAnnounced` 是上次播过的阈值(天;0 = 已过期),`undefined` = 还没播过。
 * 返回要播的阈值,或 undefined(不播)。**只在跨进更严的阈值时播** ——
 * 每天重复同一句"还有 6 天"是在训练人忽略它。
 */
export function shouldAnnounce(s: TokenStatus, lastAnnounced: number | undefined): number | undefined {
  const current = s.kind === "expired" ? 0 : s.kind === "warn" ? s.threshold : undefined;
  if (current === undefined) return undefined;
  if (lastAnnounced !== undefined && lastAnnounced <= current) return undefined;
  return current;
}

interface SeenState {
  /** 播过的最严阈值。 */
  announced?: number;
  /** 播报针对的那份 token 的到期时刻。换了 token 整个状态作废。 */
  expiresAt?: number;
}

/**
 * 告警的记账与出口拼装。IO 都在这里,判断全在上面的纯函数里。
 *
 * 用法(gateway.prelude):`pending()` 拿到要播的文本(没有就 undefined),
 * 发送**成功后**调 `markAnnounced()` —— 与部署结果播报同一条纪律:
 * 先标记就等于把这条告警永久吞掉,而它恰恰是最不能丢的一条。
 */
export class TokenAlerter {
  constructor(
    private readonly opts: {
      /** 现读过期时刻(每次都读:token 可能刚被人换新)。 */
      expiry: () => number | undefined;
      /** 记账文件路径(进程自己的可写区)。 */
      seenPath: string;
      now?: () => number;
    },
  ) {}

  private nowMs(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  status(): TokenStatus {
    return tokenStatus(this.opts.expiry(), this.nowMs());
  }

  /** 要播的那句话;不该播时 undefined。幂等只读,不改盘。 */
  pending(): string | undefined {
    const expiresAt = this.opts.expiry();
    const s = tokenStatus(expiresAt, this.nowMs());
    const seen = this.load(expiresAt);
    const threshold = shouldAnnounce(s, seen.announced);
    if (threshold === undefined) return undefined;
    return `【订阅凭据】${tokenStatusLine(s)}`;
  }

  /** 发送成功后落账。 */
  markAnnounced(): void {
    const expiresAt = this.opts.expiry();
    const s = tokenStatus(expiresAt, this.nowMs());
    const threshold = s.kind === "expired" ? 0 : s.kind === "warn" ? s.threshold : undefined;
    if (threshold === undefined) return;
    writeJsonFileAtomic(this.opts.seenPath, { announced: threshold, expiresAt } satisfies SeenState);
  }

  /** 读记账;token 换了(expiresAt 不同)就当没播过 —— 新 token 的倒计时从头告。 */
  private load(expiresAt: number | undefined): SeenState {
    const raw = readJsonFile<SeenState>(this.opts.seenPath, {});
    if (raw.expiresAt !== expiresAt) return {};
    return typeof raw.announced === "number" ? { announced: raw.announced } : {};
  }
}
