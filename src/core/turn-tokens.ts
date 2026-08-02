import { randomBytes } from "node:crypto";

/**
 * 回合级一次性令牌。
 *
 * 每个 agent 回合开始时铸一枚,经环境变量注入子进程,回合结束立刻作废。
 * agent 拿它调 /api/me 读写**自己这个 userKey** 的配置 —— 别人的动不了。
 *
 * 这消除了误操作跨用户的可能,让正确路径就是安全路径。但它**不是对抗性边界**:
 * agent 跑在 bypassPermissions 下、与 dashboard 令牌文件同一个 uid,真要绕开
 * 是可以的。这与 README 里 docker socket 的口径一致 —— 隔离边界是对助手的信任。
 *
 * 查表用普通 Map 而不是 auth.ts 的定长比较:**这里防的是熵不是比较**。
 * 256 bit 随机、生命周期只有一个回合的令牌没有可枚举空间;定长比较是为
 * 固定不变的长期 admin token 准备的。
 */

/**
 * 在飞回合的实时快照。
 *
 * 存在的理由:用户看不见日志,而"到底有没有在处理"是他最先想知道的事。
 * `/状态` 是 immediate 硬指令、绕过串行队列,所以哪怕回合彻底卡住,
 * 这份快照仍然问得到 —— 它是用户侧唯一不受回合阻塞影响的观测点。
 *
 * 只读快照,更新它是幂等的写标量,与在飞回合并发无碍。
 */
export interface TurnProgress {
  /** 回合被受理的时刻(此刻起用户就在等了,哪怕还没轮到)。 */
  readonly startedAt: number;
  /**
   * 拿到并发名额、真正开始跑的时刻;未设置 = 还在排队。
   *
   * 与 `startedAt` 分开是因为两者的处置不同:排队等的是别人的回合,
   * `/取消` 自己这条没用;跑起来之后不动才是真卡住。并发上限默认不高,
   * 多人同时说话时排队是常态,而用户完全看不见队列。
   */
  running?: number;
  /** 已发生多少个可见步骤(思考 / 工具调用)。 */
  steps: number;
  /** 最后一个步骤的时刻;没有步骤时等于 startedAt。 */
  lastAt: number;
  /** 最后一步的人话描述,如「🔧 Bash: npm test」。 */
  last?: string;
}

export interface TurnContext {
  readonly userKey: string;
  /**
   * agent 调了 /api/me/session/reset,或用户发了 /新会话。
   * 网关在回合的 finally 里据此把当前会话归档进历史 —— 不能在别处直接归档,
   * 因为本回合结束时的 record() 会把它写回来。
   */
  resetSession: boolean;
  /** /取消 用它中断本回合。 */
  readonly abort: AbortController;
  /** 本回合的实时进度,供 /状态 回答"现在在干什么"。 */
  readonly progress: TurnProgress;
}

export interface MintedTurn {
  readonly token: string;
  readonly ctx: TurnContext;
  revoke(): void;
}

export class TurnTokens {
  private readonly byToken = new Map<string, TurnContext>();
  private readonly byUser = new Map<string, TurnContext>();

  /** 时钟可注入,供单测用假时钟驱动 `progress` 的时刻。 */
  constructor(private readonly now: () => number = Date.now) {}

  mint(userKey: string): MintedTurn {
    const token = randomBytes(32).toString("hex");
    const startedAt = this.now();
    const ctx: TurnContext = {
      userKey,
      resetSession: false,
      abort: new AbortController(),
      progress: { startedAt, steps: 0, lastAt: startedAt },
    };
    this.byToken.set(token, ctx);
    this.byUser.set(userKey, ctx);
    let revoked = false;
    return {
      token,
      ctx,
      revoke: () => {
        if (revoked) return;
        revoked = true;
        this.byToken.delete(token);
        // 同一用户串行,理论上 byUser 里就是自己;判一下以防被后来的回合覆盖后误删。
        if (this.byUser.get(userKey) === ctx) this.byUser.delete(userKey);
      },
    };
  }

  /** 令牌 → 回合上下文。无效令牌返回 undefined。 */
  resolve(token: string): TurnContext | undefined {
    return this.byToken.get(token);
  }

  /** 某用户当前在飞的回合。硬指令要对它打标记/中断。 */
  currentFor(userKey: string): TurnContext | undefined {
    return this.byUser.get(userKey);
  }
}
