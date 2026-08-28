/**
 * 「对方正在输入」的节流器。**信使侧唯一持有 typing 状态的地方。**
 *
 * ## 为什么频率归信使管
 *
 * 人格只报事实(「这一轮还在动」),爱推多密推多密 —— 它不该知道微信要求 5 秒
 * 一次续命。频率是渠道知识,跟着渠道走;人格换个渠道跑,这段逻辑一行都不用动。
 *
 * ## 为什么是 deadline 而不是引用计数
 *
 * typing 是**活体信号**:亮着的含义是「它刚刚还动过」,不是「有人开了一次」。
 * 计数配不平 —— 人格可能崩在半路,那时永远没有配对的那次关闭,气泡会一直跳,
 * 而用户会以为还在干活。deadline 则天然自愈:信号一断,最多 `holdMs` 之后
 * 自己熄灭。人格死了、被 `/救援` 切走了、IPC 断了,都是同一条路。
 *
 * 这也是为什么兜底超时可以很短(十几秒),而不是我们原先设想的十分钟 ——
 * 有持续的信号在,就不必靠猜。
 */
export interface TypingKeeperOptions {
  /** 真正往渠道打一次。失败必须自己吞掉 —— 这里不处理异常。 */
  send: (userKey: string, on: boolean) => Promise<void>;
  /** 多久续一次命。默认 5 秒,官方 openclaw-weixin 用的就是这个值。 */
  tickMs?: number;
  /**
   * 最后一次信号之后还维持多久。默认 15 秒 —— 约等于三个 tick,
   * 容得下一次 IPC 抖动或一次慢工具调用,又不至于在人格死后还跳很久。
   */
  holdMs?: number;
  now?: () => number;
}

export class TypingKeeper {
  private readonly send: TypingKeeperOptions["send"];
  private readonly tickMs: number;
  private readonly holdMs: number;
  private readonly now: () => number;
  /** userKey → 这个时刻之后就该熄灭。 */
  private readonly until = new Map<string, number>();
  /** 正在飞的那次 send,避免慢请求堆成一摞。 */
  private readonly inflight = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: TypingKeeperOptions) {
    this.send = opts.send;
    this.tickMs = opts.tickMs ?? 5_000;
    this.holdMs = opts.holdMs ?? 15_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * 人格报了一次「还在动」。
   *
   * 第一次(或熄灭之后的第一次)**立刻点亮**,不等下一个 tick —— 等的话用户会
   * 先看到 5 秒空白,而这 5 秒恰好是回合刚起步、最需要有个交代的时候。
   */
  signal(userKey: string): void {
    const fresh = !this.until.has(userKey);
    this.until.set(userKey, this.now() + this.holdMs);
    if (fresh) this.fire(userKey, true);
    this.ensureTimer();
  }

  /**
   * 立刻熄灭。正文发出去时调 —— 答案到了就不该再装作在打字。
   *
   * 没亮过就什么都不做:那时候发一次熄灭是白打一个请求,而且在连接层还会
   * 触发一次没必要的 getconfig。
   */
  stop(userKey: string): void {
    if (!this.until.delete(userKey)) return;
    this.fire(userKey, false);
    this.ensureTimer();
  }

  /** 停机:把所有还亮着的都熄掉,别在用户那儿留一个永远跳着的气泡。 */
  stopAll(): void {
    for (const userKey of [...this.until.keys()]) this.stop(userKey);
  }

  /** 活跃用户数。诊断用。 */
  get activeCount(): number {
    return this.until.size;
  }

  /**
   * 走一格。**导出给单测直接驱动** —— 定时器本身没什么好测的,
   * 该被钉住的是「过期了会不会熄、没过期会不会续」。
   */
  tick(): void {
    const now = this.now();
    for (const [userKey, deadline] of [...this.until]) {
      if (now >= deadline) {
        this.until.delete(userKey);
        this.fire(userKey, false);
      } else {
        this.fire(userKey, true);
      }
    }
    this.ensureTimer();
  }

  private fire(userKey: string, on: boolean): void {
    // **只有续命可以跳过。** 续命丢一次无所谓 —— 下一个 tick 还会来;
    // 熄灭丢一次却是永久的:那条 userKey 已经从 until 里删掉了,再没有人会
    // 重发这次熄灭,气泡就一直亮到用户下次说话为止。一次卡住的续命请求
    // (网络慢)恰好撞上熄灭,就是这个下场。
    if (on && this.inflight.has(userKey)) return;
    this.inflight.add(userKey);
    void this.send(userKey, on)
      .catch(() => {})
      .finally(() => this.inflight.delete(userKey));
  }

  /** 有人才开定时器。空转的 interval 是没必要的常驻开销。 */
  private ensureTimer(): void {
    if (this.until.size && !this.timer) {
      this.timer = setInterval(() => this.tick(), this.tickMs);
      // 观测性质的定时器不该拖着进程不退出。
      this.timer.unref?.();
    } else if (!this.until.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
