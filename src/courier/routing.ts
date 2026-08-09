import { readJsonFile, writeJsonFileAtomic } from "../core/file-store.js";
import { canonicalOf } from "../core/commands.js";
import { parsePersonaId, type PersonaId } from "../ipc/protocol.js";

/**
 * 路由表:每个 userKey 的消息该投给哪个人格。
 *
 * ## 默认与切换
 *
 * 默认 `primary`。管理员发 `/救援` 切到 `rescue`,`/主人格` 切回。切换由**信使**
 * 就地消化 —— 主人格卡死时它照样管用,那正是这条指令存在的理由。
 *
 * ## 为什么必须有 TTL
 *
 * 「忘了切回」是这套机制最现实的失败模式:人切到守护人格排查完问题就去忙别的了,
 * 而主人格从此**再也收不到他的消息**——在他那边表现为"catman 答非所问"或"变傻了",
 * 而且他根本想不到是路由的问题。所以非默认路由若干小时无活动就自动拨回,并**告知**。
 *
 * 自动回落只针对**非默认**路由:回到 primary 之后不再有任何超时,那是常态。
 *
 * ## 落盘
 *
 * 信使跑 pinned release,人工 bless 时会重启。路由丢了的后果是"人明明切到了救援,
 * 重启后消息又回到那个卡死的主人格" —— 恰好发生在最需要救援的时候。
 */

/** 非默认路由的空闲上限。到点自动拨回 primary。 */
export const DEFAULT_ROUTE_TTL_MS = 6 * 60 * 60 * 1000;

export const DEFAULT_PERSONA: PersonaId = "primary";

interface Route {
  persona: PersonaId;
  /** 最近一次有活动的时刻。TTL 从它算起。 */
  touchedAt: number;
}

interface Persisted {
  [userKey: string]: { persona?: unknown; touchedAt?: unknown };
}

export interface RoutingOptions {
  path: string;
  ttlMs?: number;
  now?: () => number;
}

/** 一次自动回落。信使据此给用户发一句告知。 */
export interface RouteExpiry {
  readonly userKey: string;
  readonly from: PersonaId;
}

export class RoutingTable {
  private readonly routes = new Map<string, Route>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: RoutingOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_ROUTE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    const raw = readJsonFile<Persisted>(opts.path, {});
    for (const [userKey, v] of Object.entries(raw)) {
      const persona = parsePersonaId(v?.persona);
      // 读不懂的条目直接丢 —— 丢了就是回到默认 primary,那是安全的一侧。
      if (!persona || persona === DEFAULT_PERSONA) continue;
      const touchedAt = typeof v?.touchedAt === "number" ? v.touchedAt : 0;
      this.routes.set(userKey, { persona, touchedAt });
    }
  }

  /** 这个用户现在归谁。**只读,不做回落** —— 回落要发告知,必须走 sweep。 */
  personaFor(userKey: string): PersonaId {
    return this.routes.get(userKey)?.persona ?? DEFAULT_PERSONA;
  }

  /**
   * 切到某个人格。返回切换前的归属(没变则 `changed:false`)。
   *
   * 调用方拿 `previous` 决定要不要给**切换前**那个人格发 detach 控制帧 ——
   * 评审指出:需要标出处的是**被切走的**那一个。
   */
  switchTo(userKey: string, persona: PersonaId): { changed: boolean; previous: PersonaId } {
    const previous = this.personaFor(userKey);
    if (previous === persona) {
      // 没变也刷新时钟:用户刚刚明确表达过"我还要待在这儿"。
      this.touch(userKey);
      return { changed: false, previous };
    }
    if (persona === DEFAULT_PERSONA) this.routes.delete(userKey);
    else this.routes.set(userKey, { persona, touchedAt: this.now() });
    this.flush();
    return { changed: true, previous };
  }

  /** 有活动就刷新 TTL。默认路由不记账 —— 它本来也不会过期。 */
  touch(userKey: string): void {
    const r = this.routes.get(userKey);
    if (!r) return;
    r.touchedAt = this.now();
    this.flush();
  }

  /**
   * 把超时的非默认路由拨回 primary,返回刚刚回落的那些。
   *
   * **调用方必须把回落告诉用户**:悄悄拨回去的话,他下一句话落到主人格那儿,
   * 而他以为还在跟守护人格说话 —— 那比忘了切回还糟。
   */
  sweepExpired(): RouteExpiry[] {
    const deadline = this.now() - this.ttlMs;
    const out: RouteExpiry[] = [];
    for (const [userKey, r] of [...this.routes]) {
      if (r.touchedAt > deadline) continue;
      this.routes.delete(userKey);
      out.push({ userKey, from: r.persona });
    }
    if (out.length) this.flush();
    return out;
  }

  /** 当前所有非默认路由,供状态页与 admin API。 */
  snapshot(): ReadonlyArray<{ userKey: string; persona: PersonaId; touchedAt: number }> {
    return [...this.routes].map(([userKey, r]) => ({ userKey, ...r }));
  }

  private flush(): void {
    const out: Persisted = {};
    for (const [k, v] of this.routes) out[k] = { persona: v.persona, touchedAt: v.touchedAt };
    writeJsonFileAtomic(this.opts.path, out);
  }
}

/** 切到守护人格时给用户的确认语。 */
export function switchedToRescueText(): string {
  return (
    "已切到守护人格。它跑的是钉住的稳定版本,只做诊断与恢复,不会改代码。\n" +
    `弄完发「${canonicalOf("primaryPersona")}」切回来;` +
    "忘了也没关系,闲置几小时会自动切回并告诉你。"
  );
}

/** 切回主人格时给用户的确认语。 */
export function switchedToPrimaryText(): string {
  return "已切回主人格。";
}

/** 自动回落时的告知。**必须说清"现在是谁在跟你说话"**。 */
export function routeExpiredText(from: PersonaId): string {
  const who = from === "rescue" ? "守护人格" : "上一个人格";
  return (
    `你和${who}已经有一阵没说话了,我把你切回主人格了 —— ` +
    `接下来的消息由它来答。还要回去的话发「${canonicalOf("rescue")}」。`
  );
}
