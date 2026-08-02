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
}

export interface MintedTurn {
  readonly token: string;
  readonly ctx: TurnContext;
  revoke(): void;
}

export class TurnTokens {
  private readonly byToken = new Map<string, TurnContext>();
  private readonly byUser = new Map<string, TurnContext>();

  mint(userKey: string): MintedTurn {
    const token = randomBytes(32).toString("hex");
    const ctx: TurnContext = { userKey, resetSession: false, abort: new AbortController() };
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
