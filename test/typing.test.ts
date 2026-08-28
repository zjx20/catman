import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TypingKeeper } from "../src/courier/typing-keeper.js";
import { ILinkConnection } from "../src/channels/ilink-connection.js";
import { CompositeChannel } from "../src/channels/composite.js";
import { ReplyStore } from "../src/courier/reply-store.js";
import { makeUserKey } from "../src/core/identity.js";
import { WECHAT_CHANNEL } from "../src/channels/ilink-protocol.js";
import { FakeReplies } from "./helpers/replies.js";
import type { Account } from "../src/core/accounts.js";
import type { Channel } from "../src/channels/types.js";

const dirs: string[] = [];
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ── TypingKeeper:它是个活体信号,不是开关 ──────────────────────────

/**
 * **这条是整个功能的安全底线。**
 *
 * 输入气泡表达的是"它刚刚还动过"。人格崩在半路时不会有配对的那次关闭 ——
 * 若靠计数或显式关闭来熄灭,气泡就会一直跳,而用户以为还在干活,那比静默更糟。
 * deadline 让它自愈:信号一停,最多 holdMs 之后自己收摊。
 */
test("信号断了就自动熄灭 —— 人格崩掉时气泡不会一直跳", () => {
  const calls: Array<{ userKey: string; on: boolean }> = [];
  let now = 1000;
  const keeper = new TypingKeeper({
    send: async (userKey, on) => void calls.push({ userKey, on }),
    tickMs: 5_000,
    holdMs: 15_000,
    now: () => now,
  });

  keeper.signal("u1");
  assert.deepEqual(calls, [{ userKey: "u1", on: true }], "第一次信号要立刻点亮,不等下一个 tick");

  // 还在报活:续命,不熄。
  now += 5_000;
  keeper.signal("u1");
  keeper.tick();
  assert.equal(calls.filter((c) => !c.on).length, 0, "还在报活时不该熄灭");

  // 人格没了。deadline 之前照常续,过了就熄。
  now += 10_000; // 距最后一次信号 10s < holdMs
  keeper.tick();
  assert.equal(calls.at(-1)?.on, true, "还没到期,应该继续续命");
  now += 6_000; // 距最后一次信号 16s > holdMs
  keeper.tick();
  assert.deepEqual(calls.at(-1), { userKey: "u1", on: false }, "过期必须熄灭");
  assert.equal(keeper.activeCount, 0, "熄灭后不该再留状态");
});

test("正文发出时立刻熄灭;没亮过则一个请求都不发", () => {
  const calls: Array<{ userKey: string; on: boolean }> = [];
  const keeper = new TypingKeeper({
    send: async (userKey, on) => void calls.push({ userKey, on }),
    now: () => 0,
  });

  // 没亮过就 stop:白发一次熄灭还会在连接层触发一次没必要的 getconfig。
  keeper.stop("u1");
  assert.equal(calls.length, 0, "没亮过的用户不该发熄灭请求");

  keeper.signal("u1");
  keeper.stop("u1");
  assert.deepEqual(calls.at(-1), { userKey: "u1", on: false });
  assert.equal(keeper.activeCount, 0);
});

// ── 连接层:ticket 必须带 context_token 取,而且不能跨来信复用 ───────

function fakeAccount(): Account {
  return {
    accountId: "a1",
    channel: "wechat",
    botToken: "tok",
    baseUrl: "https://x",
    botId: "b1",
    displayName: "测试",
    createdAt: 0,
  };
}

/**
 * **这条钉的是 2026-08-28 真机实验的结论。**
 *
 * getconfig 不带 context_token 时,服务端照样 `ret=0` 并给回一份 ticket,
 * 但拿它发 typing 客户端**什么都不显示**。官方插件(openclaw-weixin)正是这么
 * 缓存 ticket 的,所以它那边从第二轮对话起就不亮,而没人发现 —— 因为
 * 失效的表现是"返回码正常 + 客户端安静",日志里一点痕迹都没有。
 *
 * 这个用例是我们唯一能自动守住它的地方:真机上"不亮"测不出来。
 */
test("取 typing ticket 必须带上这一轮的 context_token", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => {
    bodies.push({ url: String(input), ...JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ret: 0, typing_ticket: "TICKET-1" }), {
      headers: { "content-type": "application/json" },
    });
  });

  const replies = new FakeReplies();
  const userKey = makeUserKey(WECHAT_CHANNEL, "a1", "u@im.wechat");
  replies.remember(userKey, "u@im.wechat", "CTX-1");

  const conn = new ILinkConnection(fakeAccount(), () => {}, () => ({ maxImageBytes: 1, maxImagesPerTurn: 1 }), replies);
  await conn.typing(userKey, true);

  const getconfig = bodies.find((b) => String(b["url"]).includes("getconfig"));
  assert.ok(getconfig, "应当先去 getconfig 取一份 ticket");
  assert.equal(getconfig["context_token"], "CTX-1", "ticket 必须绑这一轮的 context_token");
  assert.equal(getconfig["ilink_user_id"], "u@im.wechat");

  const typing = bodies.find((b) => String(b["url"]).includes("sendtyping"));
  assert.ok(typing, "然后才发 sendtyping");
  assert.equal(typing["typing_ticket"], "TICKET-1");
  assert.equal(typing["status"], 1);

  // 同一轮里再发不该重复取 ticket —— 它已经存在 ReplyContext 上了。
  const before = bodies.filter((b) => String(b["url"]).includes("getconfig")).length;
  await conn.typing(userKey, true);
  const after = bodies.filter((b) => String(b["url"]).includes("getconfig")).length;
  assert.equal(after, before, "同一轮不该反复 getconfig");

  // 换一条来信 = 换 context_token,ticket 必须重取。
  replies.remember(userKey, "u@im.wechat", "CTX-2");
  await conn.typing(userKey, true);
  const last = bodies.filter((b) => String(b["url"]).includes("getconfig")).at(-1);
  assert.equal(last?.["context_token"], "CTX-2", "换了来信必须拿新的 context_token 重取 ticket");
});

/**
 * typing 是装饰。它失败一次就该整条连接停用 —— 5 秒一次的失败会把日志刷爆,
 * 而刷爆的日志比没有输入气泡严重得多。更要紧的是它**绝不能抛**:
 * 一个装饰功能不该让正常的回合走进错误分支。
 */
test("typing 失败不抛错,而且不再重试", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    throw new Error("网络炸了");
  });

  const replies = new FakeReplies();
  const userKey = makeUserKey(WECHAT_CHANNEL, "a1", "u@im.wechat");
  replies.remember(userKey, "u@im.wechat", "CTX-1");
  const conn = new ILinkConnection(fakeAccount(), () => {}, () => ({ maxImageBytes: 1, maxImagesPerTurn: 1 }), replies);

  await conn.typing(userKey, true); // 不该抛
  const afterFirst = calls;
  await conn.typing(userKey, true);
  assert.equal(calls, afterFirst, "失败之后不该再打请求");
});

test("没有回复上下文时 typing 直接放弃,不去 getconfig", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
  const conn = new ILinkConnection(fakeAccount(), () => {}, () => ({ maxImageBytes: 1, maxImagesPerTurn: 1 }), new FakeReplies());
  await conn.typing(makeUserKey(WECHAT_CHANNEL, "a1", "谁"), true);
  assert.equal(calls, 0);
});

// ── 复合渠道:形参必须原样转下去 ────────────────────────────────

/**
 * `send` 在这一层丢过 `kind`(少写一个形参,TypeScript 一声不吭),后果是
 * 进度上限整个失效、正文被挤掉。`typing` 的第二个形参是开还是关 —— 丢了它,
 * 熄灭会被当成点亮,气泡就永远不灭。同一个位置,同一类事故,所以照样钉一遍。
 */
test("CompositeChannel 把 typing 的两个形参都转下去", async () => {
  const seen: Array<[string, boolean]> = [];
  const fake: Channel = {
    name: "wechat",
    onMessage: () => {},
    send: async () => {},
    typing: async (userKey: string, on: boolean) => void seen.push([userKey, on]),
    start: async () => {},
    stop: async () => {},
  };
  const composite = new CompositeChannel([fake]);
  const userKey = makeUserKey("wechat", "a1", "u@im.wechat");

  assert.ok(composite.typing, "有子渠道支持时,复合渠道要对外声明支持");
  await composite.typing!(userKey, true);
  await composite.typing!(userKey, false);
  assert.deepEqual(seen, [[userKey, true], [userKey, false]], "on 必须原样传下去");
});

test("没有任何子渠道支持 typing 时,复合渠道不假装支持", () => {
  const fake: Channel = {
    name: "stdin",
    onMessage: () => {},
    send: async () => {},
    start: async () => {},
    stop: async () => {},
  };
  assert.equal(new CompositeChannel([fake]).typing, undefined);
});

// ── ReplyStore:ticket 与 context_token 同生共死 ─────────────────

test("换一条来信,ticket 一起作废;落盘能往返", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-typing-"));
  dirs.push(dir);
  const path = join(dir, "reply-ctx.json");
  const store = new ReplyStore(path);
  const userKey = "wechat:a1:u@im.wechat";

  store.remember(userKey, "u@im.wechat", "CTX-1");
  store.rememberTypingTicket(userKey, "TICKET-1");
  assert.equal(store.typingTicket(userKey), "TICKET-1");

  // 同一个 token 再 remember 一次(重放)不该动 ticket。
  store.remember(userKey, "u@im.wechat", "CTX-1");
  assert.equal(store.typingTicket(userKey), "TICKET-1", "同一条来信重放不该弄丢 ticket");

  // 新来信 = 新 context_token → ticket 必须没了,否则会拿旧的去发、客户端不亮。
  store.remember(userKey, "u@im.wechat", "CTX-2");
  assert.equal(store.typingTicket(userKey), undefined, "换了 context_token,ticket 必须作废");

  // 落盘往返:重启后不该丢。
  store.rememberTypingTicket(userKey, "TICKET-2");
  assert.equal(new ReplyStore(path).typingTicket(userKey), "TICKET-2");
});

/**
 * 旧盘上没有 typingTicket 字段。读出来是 undefined(= 还没取过),
 * 下次要发 typing 时自然会去取一份 —— 回滚到旧版本也一样安全:
 * 旧代码按白名单构造 ReplyContext,多出来的键直接忽略。
 */
test("读旧盘(没有 typingTicket 字段)不出问题", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-typing-old-"));
  dirs.push(dir);
  const path = join(dir, "reply-ctx.json");
  const store = new ReplyStore(path);
  store.remember("wechat:a1:u@im.wechat", "u@im.wechat", "CTX-1");
  assert.equal(store.typingTicket("wechat:a1:u@im.wechat"), undefined);
});
