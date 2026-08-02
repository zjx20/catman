/**
 * 会话状态机 —— 核心规则:
 *  - 距上次活动 < 超时(默认 1h)→ 继续当前会话
 *  - 超时后:调用方标记了 continueRequested → 恢复旧会话;否则开新会话
 *  - touch() 把会话当作刚刚活动过 —— 供「纯 /继续」保活,不必起任何回合
 *  - 超时到点推送一次提醒(reminded 标记防重复)
 *  - 离开的会话不丢:归档进每用户的 history(新→旧,上限 HISTORY_LIMIT),
 *    switchTo() 按 id 前缀切回其中一段 —— 微信只有一个聊天窗,这是唯一的
 *    「多话题并行」出路
 *
 * 决策逻辑是纯函数(decide),便于用假时钟单测;持久化、时钟、每用户超时
 * 都通过依赖注入。
 *
 * **本模块不认识任何指令词汇。** decide() 收的是一个布尔标记而不是原始文本 ——
 * 「/继续」「/切换会话」长什么样,只住在 commands.ts 里。状态机只管状态。
 *
 * 状态按 **userKey**(`<channel>:<accountId>:<userId>`,见 identity.ts)索引,
 * 而不是渠道内的裸 userId —— 两份凭据下可能出现同一个 from_user_id。
 */

import { parseUserKey } from "./identity.js";

/** 一段会话的引用:切换/列表所需的全部信息。 */
export interface SessionRef {
  /** Claude 会话 id。SDK 的 resume 不 fork,同一段对话的 id 稳定不变。 */
  sessionId: string;
  /** 该会话最近一次活动时间戳(ms)。 */
  lastActive: number;
  /** 会话首条用户消息的开头,列表展示时当"主题"用。 */
  hint?: string;
}

export interface UserState {
  /** 当前会话;/新会话 之后为空,直到下一个回合 record()。 */
  current?: SessionRef;
  /** 当前空闲周期内是否已推送过超时提醒。 */
  reminded: boolean;
  /** 最近离开的会话,新→旧,不含 current。供「/切换会话」找回。 */
  history: SessionRef[];
}

/**
 * history 的条数上限。超出后最老的被挤掉 —— 挤掉的那段并没有被删除
 * (JSONL 还在磁盘上,由保留期清理管),只是从"能凭 id 切回"的名单里退场。
 */
export const HISTORY_LIMIT = 10;

/** 持久化格式:userKey → 状态。 */
export type StateMap = Record<string, UserState>;

export interface StateStore {
  load(): StateMap;
  save(state: StateMap): void;
}

/** 内存实现,用于测试。 */
export class InMemoryStore implements StateStore {
  constructor(private data: StateMap = {}) {}
  load(): StateMap {
    return structuredClone(this.data);
  }
  save(state: StateMap): void {
    this.data = structuredClone(state);
  }
}

export interface Decision {
  /** 是否开启新会话(true 时不 resume)。 */
  isNew: boolean;
  /** 需要恢复的会话 id(isNew 为 false 时有值)。 */
  resumeSessionId?: string;
}

/** decide() 的输入。文本已在 commands.ts 里解析过,这里只收结论。 */
export interface DecideInput {
  /** 这批消息里带着 /继续:超时后也恢复旧会话而不是新开。 */
  continueRequested: boolean;
}

/** switchTo() 的结果。文案由调用方组织,这里只给结论与素材。 */
export type SwitchResult =
  /** 切换成功:to 已成为当前会话;from 是切换前的当前会话(若有,已归档)。 */
  | { kind: "switched"; to: SessionRef; from?: SessionRef }
  /** 目标就是当前会话,无事发生(仅刷新时钟)。 */
  | { kind: "already-current"; current: SessionRef }
  /** 没有任何会话的 id 以给定前缀开头。 */
  | { kind: "not-found" }
  /** 前缀太短,命中多段历史会话。 */
  | { kind: "ambiguous"; matches: SessionRef[] }
  /** 命中的会话记录已不在磁盘上(isAlive 判死),条目已从 history 剔除。 */
  | { kind: "gone"; refs: SessionRef[] };

export interface SessionManagerOptions {
  store: StateStore;
  /** 默认超时时长;timeoutMsFor 未给出某用户的值时用它。 */
  timeoutMs: number;
  /** 时钟,默认 Date.now;测试可注入。 */
  now?: () => number;
  /** 每用户超时时长。和 now 一样是注入式,让状态机不必知道配置层的存在。 */
  timeoutMsFor?: (userKey: string) => number;
}

function isSessionRef(v: unknown): v is SessionRef {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o["sessionId"] === "string" && typeof o["lastActive"] === "number";
}

/** 加载时的形态校验。不认识的(含旧版扁平格式)一律丢弃,不迁移。 */
function isUserState(v: unknown): v is UserState {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o["reminded"] !== "boolean") return false;
  if (!Array.isArray(o["history"]) || !o["history"].every(isSessionRef)) return false;
  return o["current"] === undefined || isSessionRef(o["current"]);
}

function cloneRef(ref: SessionRef): SessionRef {
  return { ...ref };
}

export class SessionManager {
  private readonly states = new Map<string, UserState>();
  private readonly store: StateStore;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly timeoutMsFor: ((userKey: string) => number) | undefined;

  constructor(opts: SessionManagerOptions) {
    this.store = opts.store;
    this.timeoutMs = opts.timeoutMs;
    this.now = opts.now ?? Date.now;
    this.timeoutMsFor = opts.timeoutMsFor;
    let dropped = 0;
    for (const [userKey, st] of Object.entries(this.store.load())) {
      // 不是合法 userKey、或形态对不上的条目直接丢弃(例如旧版本的存储格式)。
      // 本程序不认识历史格式,也不迁移它 —— 丢掉一段最多 1 小时的上下文,
      // 换取代码里没有任何格式分支。
      if (!parseUserKey(userKey) || !isUserState(st)) {
        dropped += 1;
        continue;
      }
      this.states.set(userKey, st);
    }
    if (dropped) {
      console.warn(`[session] 丢弃了 ${dropped} 条无法识别的会话状态(非 userKey 或旧格式)`);
    }
  }

  /** 该用户的超时时长。未注入解析器时用全局默认。 */
  private timeoutFor(userKey: string): number {
    return this.timeoutMsFor?.(userKey) ?? this.timeoutMs;
  }

  /**
   * 决定 resume 还是新开会话。纯读,不改状态。
   * 状态的更新在 agent 跑完拿到真实 sessionId 后由 record() 完成。
   */
  decide(userKey: string, input: DecideInput): Decision {
    const cur = this.states.get(userKey)?.current;
    if (!cur) return { isNew: true };

    const idle = this.now() - cur.lastActive;
    if (idle < this.timeoutFor(userKey)) {
      return { isNew: false, resumeSessionId: cur.sessionId };
    }
    // 已超时:仅当用户明确 /继续 才恢复旧会话。
    if (input.continueRequested) {
      return { isNew: false, resumeSessionId: cur.sessionId };
    }
    return { isNew: true };
  }

  /** 该用户当前的空闲时长(ms);没有当前会话返回 undefined。供 /状态 使用。 */
  idleMsOf(userKey: string): number | undefined {
    const cur = this.states.get(userKey)?.current;
    return cur ? this.now() - cur.lastActive : undefined;
  }

  /** 当前会话的引用副本;没有则 undefined。 */
  currentOf(userKey: string): SessionRef | undefined {
    const cur = this.states.get(userKey)?.current;
    return cur ? cloneRef(cur) : undefined;
  }

  /** 历史会话的引用副本,新→旧,不含当前。 */
  historyOf(userKey: string): SessionRef[] {
    return (this.states.get(userKey)?.history ?? []).map(cloneRef);
  }

  /**
   * 把会话当作刚刚活动过:刷新时间戳并重置提醒标记,sessionId 不动。
   * 供「纯 /继续」保活会话 —— 不起回合,之后的消息在 decide() 里自然命中
   * 「未超时 → resume」。没有可续的会话时返回 false,由调用方告知用户。
   */
  touch(userKey: string): boolean {
    const st = this.states.get(userKey);
    if (!st?.current) return false;
    st.current.lastActive = this.now();
    st.reminded = false;
    this.persist();
    return true;
  }

  /**
   * agent 处理完后记录本轮 sessionId,刷新活动时间并重置提醒标记。
   * id 与当前会话不同(新会话)时,原当前会话归档进 history;
   * hint 只在建立新会话时记下 —— 它代表"这段对话是聊什么的",不逐轮覆盖。
   */
  record(userKey: string, sessionId: string, hint?: string): void {
    const st = this.states.get(userKey) ?? { reminded: false, history: [] };
    if (st.current?.sessionId === sessionId) {
      st.current.lastActive = this.now();
    } else {
      if (st.current) this.pushHistory(st, st.current);
      // 该 id 若还躺在 history 里(如切换后的第一轮),移除以免同一段会话双列。
      st.history = st.history.filter((h) => h.sessionId !== sessionId);
      st.current = {
        sessionId,
        lastActive: this.now(),
        ...(hint ? { hint } : {}),
      };
    }
    st.reminded = false;
    this.states.set(userKey, st);
    this.persist();
  }

  /**
   * 结束当前会话并归档进 history(/新会话 的核心动作)。
   * 返回被归档的会话引用,供调用方在确认语里教用户怎么切回来;
   * 没有当前会话时返回 undefined,不动任何状态。
   */
  archiveCurrent(userKey: string): SessionRef | undefined {
    const st = this.states.get(userKey);
    if (!st?.current) return undefined;
    const ref = st.current;
    this.pushHistory(st, ref);
    delete st.current;
    st.reminded = false;
    this.persist();
    return cloneRef(ref);
  }

  /**
   * 按 id 前缀(大小写不敏感)切换到某段历史会话。
   * 成功时目标成为当前会话(活动时间刷新为现在),原当前会话归档进 history ——
   * 之后的消息在 decide() 里自然命中「未超时 → resume」,不需要额外标记。
   *
   * isAlive 判断某段会话的记录是否还在(注入式,状态机不认识磁盘)。
   * 命中却判死的条目当场从 history 剔除 —— 记录没了 resume 必然失败,
   * 留着只会把用户再骗一次;歧义也只在活着的条目之间算。不传则视为都活着。
   */
  switchTo(
    userKey: string,
    idPrefix: string,
    isAlive: (ref: SessionRef) => boolean = () => true,
  ): SwitchResult {
    const st = this.states.get(userKey);
    const q = idPrefix.toLowerCase();
    if (!st || !q) return { kind: "not-found" };

    if (st.current && st.current.sessionId.toLowerCase().startsWith(q)) {
      return { kind: "already-current", current: cloneRef(st.current) };
    }
    const matches = st.history.filter((h) => h.sessionId.toLowerCase().startsWith(q));
    if (matches.length === 0) return { kind: "not-found" };

    const alive: SessionRef[] = [];
    const dead: SessionRef[] = [];
    for (const m of matches) (isAlive(m) ? alive : dead).push(m);
    if (dead.length) {
      const deadIds = new Set(dead.map((d) => d.sessionId));
      st.history = st.history.filter((h) => !deadIds.has(h.sessionId));
      this.persist();
    }
    if (alive.length === 0) return { kind: "gone", refs: dead.map(cloneRef) };
    if (alive.length > 1) return { kind: "ambiguous", matches: alive.map(cloneRef) };

    const target = alive[0]!;
    const from = st.current;
    if (from) this.pushHistory(st, from);
    st.history = st.history.filter((h) => h.sessionId !== target.sessionId);
    st.current = { ...target, lastActive: this.now() };
    st.reminded = false;
    this.persist();
    return {
      kind: "switched",
      to: cloneRef(st.current),
      ...(from ? { from: cloneRef(from) } : {}),
    };
  }

  /**
   * 返回本轮到点、且尚未提醒过的用户列表,并把它们标记为已提醒。
   * 运行时按固定间隔调用,对返回的每个用户尝试推送超时提醒。
   */
  dueReminders(): string[] {
    const due: string[] = [];
    const t = this.now();
    let changed = false;
    for (const [userKey, st] of this.states) {
      if (!st.current) continue; // 只有历史、没有进行中会话的用户没什么可提醒的
      if (!st.reminded && t - st.current.lastActive >= this.timeoutFor(userKey)) {
        st.reminded = true;
        due.push(userKey);
        changed = true;
      }
    }
    if (changed) this.persist();
    return due;
  }

  /**
   * 剔除已被清理(JSONL 已删)的会话 id:当前会话、历史里的条目都要清,
   * 否则 /切换会话 会把用户领到一段 resume 必然失败的死会话上。
   * 清空后的条目整个删除,state.json 不留空壳。
   */
  dropSessionIds(sessionIds: Iterable<string>): void {
    const dead = new Set(sessionIds);
    if (!dead.size) return;
    let changed = false;
    for (const [userKey, st] of this.states) {
      if (st.current && dead.has(st.current.sessionId)) {
        delete st.current;
        changed = true;
      }
      const kept = st.history.filter((h) => !dead.has(h.sessionId));
      if (kept.length !== st.history.length) {
        st.history = kept;
        changed = true;
      }
      if (!st.current && st.history.length === 0) {
        this.states.delete(userKey);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** 当前所有用户状态快照(dashboard 用)。 */
  snapshot(): StateMap {
    const out: StateMap = {};
    for (const [k, v] of this.states) {
      out[k] = {
        reminded: v.reminded,
        history: v.history.map(cloneRef),
        ...(v.current ? { current: cloneRef(v.current) } : {}),
      };
    }
    return out;
  }

  /** 归档并去重:同 id 的旧条目移除,新的插到最前,超限挤掉最老的。 */
  private pushHistory(st: UserState, ref: SessionRef): void {
    st.history = [cloneRef(ref), ...st.history.filter((h) => h.sessionId !== ref.sessionId)].slice(
      0,
      HISTORY_LIMIT,
    );
  }

  private persist(): void {
    const obj: StateMap = {};
    for (const [k, v] of this.states) obj[k] = v;
    this.store.save(obj);
  }
}
