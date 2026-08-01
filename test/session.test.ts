import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, InMemoryStore, type StateMap } from "../src/core/session.js";

/**
 * decide() 收的是布尔标记而不是文本 —— 指令词汇只住在 commands.ts 里,
 * 状态机不认识它们。这两个常量让用例读起来仍然像在说"普通消息"/"发了 /继续"。
 */
const GO = { continueRequested: false };
const CONT = { continueRequested: true };

const TIMEOUT = 60 * 60 * 1000; // 1h

/** 可控假时钟。 */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

function mgr(store = new InMemoryStore(), c = clock()) {
  return {
    sm: new SessionManager({ store, timeoutMs: TIMEOUT, now: c.now }),
    c,
    store,
  };
}

test("首个用户消息 → 新会话", () => {
  const { sm } = mgr();
  const d = sm.decide("stdin:local:u1", GO);
  assert.equal(d.isNew, true);
  assert.equal(d.resumeSessionId, undefined);
});

test("超时窗口内的后续消息 → 恢复当前会话", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  c.advance(TIMEOUT - 1);
  const d = sm.decide("stdin:local:u1", GO);
  assert.equal(d.isNew, false);
  assert.equal(d.resumeSessionId, "sess-A");
});

test("超时后的普通消息 → 开新会话", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  c.advance(TIMEOUT + 1);
  const d = sm.decide("stdin:local:u1", GO);
  assert.equal(d.isNew, true);
  assert.equal(d.resumeSessionId, undefined);
});

test('超时后回复"继续" → 恢复旧会话', () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  c.advance(TIMEOUT + 5 * 60 * 1000); // 超时后 5 分钟
  const d = sm.decide("stdin:local:u1", CONT);
  assert.equal(d.isNew, false);
  assert.equal(d.resumeSessionId, "sess-A");
});

test('超时后先开新会话,之后的"继续"属于新会话(不再恢复旧的)', () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  c.advance(TIMEOUT + 1);
  // 普通消息触发新会话
  assert.equal(sm.decide("stdin:local:u1", GO).isNew, true);
  sm.record("stdin:local:u1", "sess-B"); // agent 返回了新会话 id
  // 紧接着"继续"应恢复 sess-B(当前会话),而不是 sess-A
  const d = sm.decide("stdin:local:u1", CONT);
  assert.equal(d.isNew, false);
  assert.equal(d.resumeSessionId, "sess-B");
});

test("dueReminders 在到点时返回用户且只提醒一次", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  assert.deepEqual(sm.dueReminders(), []); // 还没到点
  c.advance(TIMEOUT);
  assert.deepEqual(sm.dueReminders(), ["stdin:local:u1"]); // 到点
  assert.deepEqual(sm.dueReminders(), []); // 不重复提醒
});

test("record 之后重置提醒标记,可再次提醒", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  c.advance(TIMEOUT);
  assert.deepEqual(sm.dueReminders(), ["stdin:local:u1"]);
  // 用户回来发消息,恢复会话
  sm.record("stdin:local:u1", "sess-A");
  assert.deepEqual(sm.dueReminders(), []);
  c.advance(TIMEOUT);
  assert.deepEqual(sm.dueReminders(), ["stdin:local:u1"]); // 新一轮空闲再次到点
});

test("状态持久化并可从 store 恢复", () => {
  const store = new InMemoryStore();
  const c = clock();
  const first = new SessionManager({ store, timeoutMs: TIMEOUT, now: c.now });
  first.record("stdin:local:u1", "sess-A");

  // 用同一 store 新建实例,模拟重启
  const second = new SessionManager({ store, timeoutMs: TIMEOUT, now: c.now });
  c.advance(TIMEOUT - 1);
  const d = second.decide("stdin:local:u1", GO);
  assert.equal(d.isNew, false);
  assert.equal(d.resumeSessionId, "sess-A");
});

test("forget 删除用户状态", () => {
  const { sm } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  sm.forget("stdin:local:u1");
  assert.equal(sm.decide("stdin:local:u1", GO).isNew, true);
});

test("多用户互不干扰", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-1");
  c.advance(30 * 60 * 1000);
  sm.record("stdin:local:u2", "sess-2");
  c.advance(TIMEOUT - 30 * 60 * 1000); // u1 累计超时,u2 未超时
  assert.equal(sm.decide("stdin:local:u1", GO).isNew, true);
  assert.equal(sm.decide("stdin:local:u2", GO).resumeSessionId, "sess-2");
});

test("每用户超时:timeoutMsFor 覆盖全局默认", () => {
  const c = clock();
  const shortFor = "stdin:local:short";
  const sm = new SessionManager({
    store: new InMemoryStore(),
    timeoutMs: TIMEOUT,
    now: c.now,
    timeoutMsFor: (k) => (k === shortFor ? 60_000 : TIMEOUT),
  });
  sm.record(shortFor, "sess-S");
  sm.record("stdin:local:normal", "sess-N");
  c.advance(120_000); // 超过 short 的 1 分钟,远未到默认的 1 小时

  assert.equal(sm.decide(shortFor, GO).isNew, true, "短超时的用户应当开新会话");
  assert.equal(sm.decide("stdin:local:normal", GO).isNew, false, "默认超时的用户仍在窗口内");
  // dueReminders 也要按每用户超时算,否则短超时的人永远等不到提醒。
  assert.deepEqual(sm.dueReminders(), [shortFor]);
});

test("idleMsOf:无记录返回 undefined,有记录返回空闲时长", () => {
  const { sm, c } = mgr();
  assert.equal(sm.idleMsOf("stdin:local:u1"), undefined);
  sm.record("stdin:local:u1", "sess-A");
  c.advance(5_000);
  assert.equal(sm.idleMsOf("stdin:local:u1"), 5_000);
});

test("snapshot 返回副本,不泄漏内部引用", () => {
  const { sm } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  const snap: StateMap = sm.snapshot();
  snap["stdin:local:u1"]!.sessionId = "tampered";
  assert.equal(sm.decide("stdin:local:u1", GO).resumeSessionId, "sess-A");
});

test("加载时丢弃非 userKey 格式的状态(不认识历史格式,也不迁移)", () => {
  // 旧版本按裸 userId 存状态。本程序不迁移它 —— 丢掉一段最多 1 小时的上下文,
  // 换取代码里没有任何格式分支。
  const store = new InMemoryStore({
    "o9cq80yCc7@im.wechat": { sessionId: "legacy", lastActive: 0, reminded: false },
    "stdin:local:u1": { sessionId: "sess-A", lastActive: 0, reminded: false },
  });
  const sm = new SessionManager({ store, timeoutMs: TIMEOUT, now: () => 1 });
  const snap = sm.snapshot();
  assert.deepEqual(Object.keys(snap), ["stdin:local:u1"]);
  // 丢弃的用户下次发消息就是全新会话,不会误 resume 到别人的上下文。
  assert.equal(sm.decide("o9cq80yCc7@im.wechat", GO).isNew, true);
});
