import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnTokens } from "../src/core/turn-tokens.js";

const A = "stdin:local:alice";
const B = "wechat:acct-b:bob";

test("mint → resolve → revoke 的生命周期", () => {
  const t = new TurnTokens();
  const turn = t.mint(A);
  assert.equal(t.resolve(turn.token)?.userKey, A);
  turn.revoke();
  assert.equal(t.resolve(turn.token), undefined, "回合结束后令牌立即失效");
});

test("revoke 幂等", () => {
  const t = new TurnTokens();
  const turn = t.mint(A);
  turn.revoke();
  assert.doesNotThrow(() => turn.revoke());
});

test("无效令牌解析不出任何身份", () => {
  const t = new TurnTokens();
  t.mint(A);
  assert.equal(t.resolve("伪造的令牌"), undefined);
  assert.equal(t.resolve(""), undefined);
});

test("核心隔离断言:一个人的令牌只解析得出他自己", () => {
  // /api/me 不接受"改谁"这个参数,身份完全由令牌决定 —— 这条守护那个前提。
  const t = new TurnTokens();
  const a = t.mint(A);
  const b = t.mint(B);
  assert.equal(t.resolve(a.token)?.userKey, A);
  assert.equal(t.resolve(b.token)?.userKey, B);
  assert.notEqual(a.token, b.token);
});

test("令牌足够长且每次不同", () => {
  const t = new TurnTokens();
  const tokens = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const turn = t.mint(A);
    assert.equal(turn.token.length, 64, "32 字节十六进制");
    tokens.add(turn.token);
    turn.revoke();
  }
  assert.equal(tokens.size, 50);
});

test("currentFor 找到在飞回合,供硬指令打标记/中断", () => {
  const t = new TurnTokens();
  assert.equal(t.currentFor(A), undefined);
  const turn = t.mint(A);
  const ctx = t.currentFor(A);
  assert.equal(ctx, turn.ctx);

  ctx!.resetSession = true;
  assert.equal(turn.ctx.resetSession, true, "拿到的是同一个对象,标记能传回回合");

  turn.revoke();
  assert.equal(t.currentFor(A), undefined);
});

test("progress 快照:初始为零,时钟可注入", () => {
  // /状态 与心跳日志都读这份快照 —— 它是回合卡住时唯一还答得出话的东西。
  let now = 5_000;
  const t = new TurnTokens(() => now);
  const turn = t.mint(A);
  assert.deepEqual(turn.ctx.progress, { startedAt: 5000, steps: 0, lastAt: 5000 });
  assert.equal(turn.ctx.progress.running, undefined, "刚铸出来还没拿到并发名额");

  now = 9_000;
  turn.ctx.progress.running = now;
  turn.ctx.progress.steps = 1;
  turn.ctx.progress.lastAt = now;
  turn.ctx.progress.last = "🔧 Bash: npm test";
  // currentFor 拿到的是同一个对象,硬指令才看得见在飞回合的最新进展。
  assert.equal(t.currentFor(A)?.progress.last, "🔧 Bash: npm test");
});

test("resetSession 与 abort 初始都是干净的", () => {
  const t = new TurnTokens();
  const turn = t.mint(A);
  assert.equal(turn.ctx.resetSession, false);
  assert.equal(turn.ctx.abort.signal.aborted, false);
  turn.ctx.abort.abort();
  assert.equal(t.currentFor(A)?.abort.signal.aborted, true);
});

test("同一用户的新回合覆盖 currentFor;旧回合 revoke 不误删新的", () => {
  // 同一用户串行,理论上不会重叠;但退化时也不能让旧回合把新回合的记录抹掉。
  const t = new TurnTokens();
  const first = t.mint(A);
  const second = t.mint(A);
  assert.equal(t.currentFor(A), second.ctx);
  first.revoke();
  assert.equal(t.currentFor(A), second.ctx, "旧回合的 revoke 不该动新回合");
  assert.equal(t.resolve(first.token), undefined);
  assert.equal(t.resolve(second.token)?.userKey, A);
});
