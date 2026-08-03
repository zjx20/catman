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

test("foregroundFor 找到前台回合,供硬指令打标记/中断", () => {
  const t = new TurnTokens();
  assert.equal(t.foregroundFor(A), undefined);
  const turn = t.mint(A);
  const ctx = t.foregroundFor(A);
  assert.equal(ctx, turn.ctx);

  ctx!.detached = true;
  assert.equal(turn.ctx.detached, true, "拿到的是同一个对象,标记能传回回合");

  turn.revoke();
  assert.equal(t.foregroundFor(A), undefined);
});

test("progress 快照:初始为零,时钟可注入", () => {
  // /状态 与心跳日志都读这份快照 —— 它是回合卡住时唯一还答得出话的东西。
  let now = 5_000;
  const t = new TurnTokens(() => now);
  const turn = t.mint(A);
  assert.deepEqual(turn.ctx.progress, { startedAt: 5000, steps: 0, lastAt: 5000, fed: 0 });
  assert.equal(turn.ctx.progress.running, undefined, "刚铸出来还没拿到并发名额");
  assert.equal(turn.ctx.feed, undefined, "agent 还没跑起来,追加输入无处可折");

  now = 9_000;
  turn.ctx.progress.running = now;
  turn.ctx.progress.steps = 1;
  turn.ctx.progress.lastAt = now;
  turn.ctx.progress.last = "🔧 Bash: npm test";
  // foregroundFor 拿到的是同一个对象,硬指令才看得见在飞回合的最新进展。
  assert.equal(t.foregroundFor(A)?.progress.last, "🔧 Bash: npm test");
});

test("detached 与 abort 初始都是干净的", () => {
  const t = new TurnTokens();
  const turn = t.mint(A);
  assert.equal(turn.ctx.detached, false);
  assert.equal(turn.ctx.abort.signal.aborted, false);
  turn.ctx.abort.abort();
  assert.equal(t.foregroundFor(A)?.abort.signal.aborted, true);
});

test("一个用户可以有多个在飞回合;detached 的不再是前台", () => {
  // 切走会话不等于停掉它的回合,所以同一用户会同时有 1 个前台 + 若干后台。
  const t = new TurnTokens();
  const bg = t.mint(A);
  bg.ctx.detached = true; // 被 /切换会话 切走,转后台继续跑
  const fg = t.mint(A);

  assert.equal(t.foregroundFor(A), fg.ctx, "前台是那个没被切走的");
  assert.equal(t.allFor(A).length, 2, "后台那个仍然在飞");

  fg.revoke();
  assert.equal(t.foregroundFor(A), undefined, "前台走了就没有前台了");
  assert.equal(t.allFor(A).length, 1, "但后台还在跑");
  assert.equal(t.resolve(fg.token), undefined);
  assert.equal(t.resolve(bg.token)?.userKey, A);
});

test("done 在 revoke 时兑现 —— 同一会话的下一段输入靠它排队", () => {
  const t = new TurnTokens();
  const turn = t.mint(A);
  let settled = false;
  void turn.ctx.done.then(() => (settled = true));
  return Promise.resolve()
    .then(() => assert.equal(settled, false, "回合还在跑时不该兑现"))
    .then(() => {
      turn.revoke();
      return turn.ctx.done;
    })
    .then(() => assert.equal(settled, true));
});
