import { randomBytes } from "node:crypto";
import type { Attachment } from "./attachments.js";

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
  /**
   * 本回合中途接住了几条追加输入。
   *
   * 必须由网关自己记账:被折进 turn 的消息**不会**在 SDK 的消息流里露面
   * (流里的 user 消息只有 tool_result),不记的话「我刚补的那句话进去了吗」
   * 就没有任何地方答得出。
   */
  fed: number;
}

/**
 * 把一批新消息追加进这个在飞回合。回合已收摊(或额度用尽)返回 false,
 * 调用方应回落到起一个新回合 —— 返回 false 不代表消息可以丢。
 */
export type TurnFeed = (text: string, attachments: readonly Attachment[]) => boolean;

export interface TurnContext {
  readonly userKey: string;
  /**
   * 本回合的会话已经不是前台了 —— 用户发了 `/新会话` 或 `/切换会话` 把它切走,
   * 或 agent 调了 `/api/me/session/reset`。
   *
   * **切走不等于停止**:回合继续在后台跑完。三处行为随之改变 ——
   * 中途进度不再推给用户(他已经在跟别的会话说话了)、正文发出时标明出处、
   * 产出记进 history 而不是 current(无脑写 current 会把用户刚切过去的会话顶掉)。
   */
  detached: boolean;
  /** /取消 用它中断本回合。 */
  readonly abort: AbortController;
  /** 本回合的实时进度,供 /状态 回答"现在在干什么"。 */
  readonly progress: TurnProgress;
  /**
   * 把新消息追加进本回合 —— 模型下一次请求就能看到,不必等这轮跑完。
   *
   * 由网关在 agent **真正跑起来之后**挂上,所以还在排队的回合这里是 undefined:
   * 那时候还没有 turn 可折,消息该照常排队。回合收摊后调用返回 false。
   */
  feed?: TurnFeed;
  /**
   * 本回合彻底结束(revoke)时兑现。
   *
   * 用途只有一个,但不可少:追加**没追进去**时(额度用尽、或回合正在收摊),
   * 那段输入得排在这一轮后面再起新回合 —— 它俩说的是**同一段会话**,
   * 并发 resume 同一个 sessionId 会把上下文撕坏。等的是这一个回合,
   * 不是整条队列,所以指令仍然畅通。
   */
  readonly done: Promise<void>;
}

export interface MintedTurn {
  readonly token: string;
  readonly ctx: TurnContext;
  revoke(): void;
}

export class TurnTokens {
  private readonly byToken = new Map<string, TurnContext>();
  /**
   * 每用户所有在飞回合:至多一个前台 + 若干个被切走仍在后台跑的。
   *
   * 一个用户能同时有多个回合,是因为"切走会话"不再意味着"停掉它的回合"。
   * 数组而不是单值 —— 后台回合各跑各的,谁先结束不确定。
   */
  private readonly byUser = new Map<string, TurnContext[]>();

  /** 时钟可注入,供单测用假时钟驱动 `progress` 的时刻。 */
  constructor(private readonly now: () => number = Date.now) {}

  mint(userKey: string): MintedTurn {
    const token = randomBytes(32).toString("hex");
    const startedAt = this.now();
    let settleDone!: () => void;
    const done = new Promise<void>((resolve) => (settleDone = resolve));
    const ctx: TurnContext = {
      userKey,
      detached: false,
      abort: new AbortController(),
      progress: { startedAt, steps: 0, lastAt: startedAt, fed: 0 },
      done,
    };
    this.byToken.set(token, ctx);
    const list = this.byUser.get(userKey) ?? [];
    list.push(ctx);
    this.byUser.set(userKey, list);
    let revoked = false;
    return {
      token,
      ctx,
      revoke: () => {
        if (revoked) return;
        revoked = true;
        this.byToken.delete(token);
        const rest = (this.byUser.get(userKey) ?? []).filter((t) => t !== ctx);
        if (rest.length) this.byUser.set(userKey, rest);
        else this.byUser.delete(userKey);
        // 最后一步:等着接班的那段输入这时才起新回合,那时它已经不在名单里了。
        settleDone();
      },
    };
  }

  /** 令牌 → 回合上下文。无效令牌返回 undefined。 */
  resolve(token: string): TurnContext | undefined {
    return this.byToken.get(token);
  }

  /**
   * 该用户的**前台**回合 —— 他正在等的那一个。追加输入、`/取消`、`/状态`
   * 的第一行说的都是它。
   *
   * 至多只会有一个:起回合的只有串行的分拣节点,而它一旦发现前台还在跑就走
   * 追加而不是另起一轮。切走的回合立刻 `detached`,从此不再是任何人的前台。
   */
  foregroundFor(userKey: string): TurnContext | undefined {
    return this.byUser.get(userKey)?.find((t) => !t.detached);
  }

  /** 该用户所有在飞回合(含后台)。供 `/状态` 交代"后台还有几段在跑"。 */
  allFor(userKey: string): readonly TurnContext[] {
    return this.byUser.get(userKey) ?? [];
  }
}
