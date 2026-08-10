import type { ReplyContexts } from "../../src/channels/ilink-connection.js";

/**
 * 测试用的回复上下文与预算记账。
 *
 * 真实实现是信使的 `ReplyStore`(要落盘、要真的算预算);渠道层的用例只关心
 * "连接会不会把 token 交出去、发之前会不会问一句",所以这里给个最小实现,
 * 免得每个用例都牵扯到文件系统。
 */
export class FakeReplies implements ReplyContexts {
  readonly ctxs = new Map<string, { toUserId: string; contextToken: string; n: number }>();
  /** 置 false 可模拟"预算用尽",验连接会不会照发。 */
  allow = true;

  remember(userKey: string, toUserId: string, contextToken: string): void {
    this.ctxs.set(userKey, { toUserId, contextToken, n: 0 });
  }
  begin(userKey: string): { allowed: boolean; reason?: string } {
    const c = this.ctxs.get(userKey);
    if (!c) return { allowed: false, reason: "没有上下文" };
    if (!this.allow) return { allowed: false, reason: "预算用尽" };
    c.n += 1;
    return { allowed: true };
  }
  settle(): void {}
  target(userKey: string): { toUserId: string; contextToken: string } | undefined {
    return this.ctxs.get(userKey);
  }
  diag(): { attempt: number; okBefore: number; ageMs: number } {
    return { attempt: 1, okBefore: 0, ageMs: 0 };
  }
}
