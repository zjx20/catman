/**
 * 会话状态机 —— 核心规则:
 *  - 距上次活动 < 超时(默认 1h)→ 继续当前会话
 *  - 超时后:调用方标记了 continueRequested → 恢复旧会话;否则开新会话
 *  - 超时到点推送一次提醒(reminded 标记防重复)
 *
 * 决策逻辑是纯函数(decide),便于用假时钟单测;持久化、时钟、每用户超时
 * 都通过依赖注入。
 *
 * **本模块不认识任何指令词汇。** decide() 收的是一个布尔标记而不是原始文本 ——
 * 「/继续」长什么样、有哪些别名,只住在 commands.ts 里。状态机只管状态。
 *
 * 状态按 **userKey**(`<channel>:<accountId>:<userId>`,见 identity.ts)索引,
 * 而不是渠道内的裸 userId —— 两份凭据下可能出现同一个 from_user_id。
 */

import { parseUserKey } from "./identity.js";

export interface UserState {
  /** 该用户最近一次使用的 Claude 会话 id。 */
  sessionId: string;
  /** 最近一次活动时间戳(ms)。 */
  lastActive: number;
  /** 当前空闲周期内是否已推送过超时提醒。 */
  reminded: boolean;
}

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
  /** 用户发的是 /继续:超时后也恢复旧会话而不是新开。 */
  continueRequested: boolean;
}

export interface SessionManagerOptions {
  store: StateStore;
  /** 默认超时时长;timeoutMsFor 未给出某用户的值时用它。 */
  timeoutMs: number;
  /** 时钟,默认 Date.now;测试可注入。 */
  now?: () => number;
  /** 每用户超时时长。和 now 一样是注入式,让状态机不必知道配置层的存在。 */
  timeoutMsFor?: (userKey: string) => number;
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
      // 不是合法 userKey 的条目直接丢弃(例如旧版本按裸 userId 存的状态)。
      // 本程序不认识历史格式,也不迁移它 —— 丢掉一段最多 1 小时的上下文,
      // 换取代码里没有任何格式分支。
      if (!parseUserKey(userKey)) {
        dropped += 1;
        continue;
      }
      this.states.set(userKey, st);
    }
    if (dropped) {
      console.warn(`[session] 丢弃了 ${dropped} 条无法识别的会话状态(非 userKey 格式)`);
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
    const st = this.states.get(userKey);
    if (!st) return { isNew: true };

    const idle = this.now() - st.lastActive;
    if (idle < this.timeoutFor(userKey)) {
      return { isNew: false, resumeSessionId: st.sessionId };
    }
    // 已超时:仅当用户明确 /继续 才恢复旧会话。
    if (input.continueRequested) {
      return { isNew: false, resumeSessionId: st.sessionId };
    }
    return { isNew: true };
  }

  /** 该用户当前的空闲时长(ms);没有记录返回 undefined。供 /状态 使用。 */
  idleMsOf(userKey: string): number | undefined {
    const st = this.states.get(userKey);
    return st ? this.now() - st.lastActive : undefined;
  }

  /** agent 处理完后记录本轮 sessionId,刷新活动时间并重置提醒标记。 */
  record(userKey: string, sessionId: string): void {
    this.states.set(userKey, {
      sessionId,
      lastActive: this.now(),
      reminded: false,
    });
    this.persist();
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
      if (!st.reminded && t - st.lastActive >= this.timeoutFor(userKey)) {
        st.reminded = true;
        due.push(userKey);
        changed = true;
      }
    }
    if (changed) this.persist();
    return due;
  }

  /** 删除指定用户的状态(会话被清理时同步调用)。 */
  forget(userKey: string): void {
    if (this.states.delete(userKey)) this.persist();
  }

  /** 当前所有用户状态快照(dashboard 用)。 */
  snapshot(): StateMap {
    const out: StateMap = {};
    for (const [k, v] of this.states) out[k] = { ...v };
    return out;
  }

  private persist(): void {
    const obj: StateMap = {};
    for (const [k, v] of this.states) obj[k] = v;
    this.store.save(obj);
  }
}
