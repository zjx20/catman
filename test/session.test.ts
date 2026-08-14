import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SessionManager,
  InMemoryStore,
  HISTORY_LIMIT,
  type StateMap,
} from "../src/core/session.js";

/**
 * decide() 收的是布尔标记而不是文本 —— 指令词汇只住在 commands.ts 里,
 * 状态机不认识它们。这两个常量让用例读起来仍然像在说"普通消息"/"发了 /继续"。
 */

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
  const d = sm.decide("stdin:local:u1");
  assert.equal(d.isNew, true);
  assert.equal(d.resumeSessionId, undefined);
});

test("超时窗口内的后续消息 → 恢复当前会话", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  c.advance(TIMEOUT - 1);
  const d = sm.decide("stdin:local:u1");
  assert.equal(d.isNew, false);
  assert.equal(d.resumeSessionId, "sess-A");
});

test("超时后的普通消息 → 开新会话", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  c.advance(TIMEOUT + 1);
  const d = sm.decide("stdin:local:u1");
  assert.equal(d.isNew, true);
  assert.equal(d.resumeSessionId, undefined);
});

test("超时后 /继续 → touch 保活 → 恢复旧会话", () => {
  // /继续 不再作为标记传进 decide():网关的分拣节点收到它就 touch(),
  // 把时钟拨到现在,同一批里后面的话自然命中「未超时 → resume」。
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  c.advance(TIMEOUT + 5 * 60 * 1000); // 超时后 5 分钟
  assert.equal(sm.touch("stdin:local:u1"), true);
  const d = sm.decide("stdin:local:u1");
  assert.equal(d.isNew, false);
  assert.equal(d.resumeSessionId, "sess-A");
});

test('超时后先开新会话,之后的"继续"属于新会话(不再恢复旧的)', () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  c.advance(TIMEOUT + 1);
  // 普通消息触发新会话
  assert.equal(sm.decide("stdin:local:u1").isNew, true);
  sm.record("stdin:local:u1", "sess-B"); // agent 返回了新会话 id
  // 紧接着"继续"应恢复 sess-B(当前会话),而不是 sess-A
  sm.touch("stdin:local:u1");
  const d = sm.decide("stdin:local:u1");
  assert.equal(d.isNew, false);
  assert.equal(d.resumeSessionId, "sess-B");
});

test("touch:超时后保活,下一条普通消息仍恢复旧会话", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  c.advance(TIMEOUT + 1);
  assert.equal(sm.decide("stdin:local:u1").isNew, true, "超时后普通消息本该开新会话");

  assert.equal(sm.touch("stdin:local:u1"), true);
  const d = sm.decide("stdin:local:u1");
  assert.equal(d.isNew, false, "touch 之后普通消息也能续上,不再依赖任何标记");
  assert.equal(d.resumeSessionId, "sess-A");
});

test("touch:没有任何记录时返回 false,不凭空造状态", () => {
  const { sm } = mgr();
  assert.equal(sm.touch("stdin:local:u1"), false);
  assert.deepEqual(sm.snapshot(), {});
});

test("touch 重置提醒标记:续上后的新一轮空闲会再次提醒", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  c.advance(TIMEOUT);
  assert.deepEqual(sm.dueReminders(), ["stdin:local:u1"]);

  sm.touch("stdin:local:u1");
  assert.deepEqual(sm.dueReminders(), [], "刚 touch 过,不该立刻再提醒");
  c.advance(TIMEOUT);
  assert.deepEqual(sm.dueReminders(), ["stdin:local:u1"], "新一轮空闲到点应当再次提醒");
});

test("touch 持久化:重启后保活效果仍在", () => {
  const store = new InMemoryStore();
  const c = clock();
  const first = new SessionManager({ store, timeoutMs: TIMEOUT, now: c.now });
  first.record("stdin:local:u1", "sess-A");
  c.advance(TIMEOUT + 1);
  first.touch("stdin:local:u1");

  const second = new SessionManager({ store, timeoutMs: TIMEOUT, now: c.now });
  c.advance(TIMEOUT - 1);
  assert.equal(second.decide("stdin:local:u1").resumeSessionId, "sess-A");
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
  const d = second.decide("stdin:local:u1");
  assert.equal(d.isNew, false);
  assert.equal(d.resumeSessionId, "sess-A");
});

test("archiveCurrent:结束当前会话但不丢历史,下一条消息开新会话", () => {
  const { sm } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  const archived = sm.archiveCurrent("stdin:local:u1");
  assert.equal(archived?.sessionId, "sess-A");
  assert.equal(sm.decide("stdin:local:u1").isNew, true);
  // 归档不等于删除:还能凭 id 切回去。
  assert.deepEqual(
    sm.historyOf("stdin:local:u1").map((h) => h.sessionId),
    ["sess-A"],
  );
  // 没有进行中会话时 /继续 无从续起 —— 用户明确说过要新开。
  assert.equal(sm.touch("stdin:local:u1"), false);
});

test("archiveCurrent:没有当前会话时返回 undefined,不动状态", () => {
  const { sm } = mgr();
  assert.equal(sm.archiveCurrent("stdin:local:u1"), undefined);
  assert.deepEqual(sm.snapshot(), {});
});

test("record:换会话时旧会话自动归档,hint 记的是首条消息", () => {
  const { sm } = mgr();
  sm.record("stdin:local:u1", "sess-A", "聊聊 docker");
  sm.record("stdin:local:u1", "sess-A", "第二轮的话不覆盖 hint");
  sm.record("stdin:local:u1", "sess-B", "新话题");

  assert.equal(sm.currentOf("stdin:local:u1")?.sessionId, "sess-B");
  const history = sm.historyOf("stdin:local:u1");
  assert.equal(history.length, 1);
  assert.equal(history[0]!.sessionId, "sess-A");
  assert.equal(history[0]!.hint, "聊聊 docker", "hint 应保留会话首条消息的样子");
});

test("switchTo:按前缀切回历史会话,原当前会话归档", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "aaaa1111", "话题甲");
  sm.archiveCurrent("stdin:local:u1");
  sm.record("stdin:local:u1", "bbbb2222", "话题乙");
  c.advance(5_000);

  const res = sm.switchTo("stdin:local:u1", "aaaa");
  assert.equal(res.kind, "switched");
  assert.equal(res.kind === "switched" && res.to.sessionId, "aaaa1111");
  assert.equal(res.kind === "switched" && res.to.hint, "话题甲", "切回后主题提示还在");
  assert.equal(res.kind === "switched" && res.from?.sessionId, "bbbb2222");

  // 切回的会话即刻生效:普通消息直接 resume,不需要 /继续。
  const d = sm.decide("stdin:local:u1");
  assert.equal(d.resumeSessionId, "aaaa1111");
  // 原当前会话进了历史,还能再切回去。
  assert.deepEqual(
    sm.historyOf("stdin:local:u1").map((h) => h.sessionId),
    ["bbbb2222"],
  );
});

test("switchTo:超时已久的历史会话也能切回(这正是它存在的理由)", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "aaaa1111");
  sm.archiveCurrent("stdin:local:u1");
  c.advance(TIMEOUT * 24); // 远超超时窗口
  assert.equal(sm.switchTo("stdin:local:u1", "aaaa").kind, "switched");
  assert.equal(sm.decide("stdin:local:u1").resumeSessionId, "aaaa1111");
});

test("switchTo:大小写不敏感;目标是当前会话时如实说明", () => {
  const { sm } = mgr();
  sm.record("stdin:local:u1", "AbCd1234");
  const res = sm.switchTo("stdin:local:u1", "abcd");
  assert.equal(res.kind, "already-current");
  assert.equal(res.kind === "already-current" && res.revived, false, "没超时,不算救回来");
});

test("switchTo:切到已超时的**当前**会话,同样即刻生效", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "aaaa1111");
  c.advance(TIMEOUT * 3); // 放凉了 —— decide() 此刻会判新会话
  assert.equal(sm.decide("stdin:local:u1").isNew, true, "前提:不切的话就是新会话");

  const res = sm.switchTo("stdin:local:u1", "aaaa");
  assert.equal(res.kind, "already-current");
  assert.equal(res.kind === "already-current" && res.revived, true, "如实说明它刚才已经断了");
  // 这条是本用例的全部理由:切完必须能 resume,否则确认语在骗人。
  assert.equal(sm.decide("stdin:local:u1").resumeSessionId, "aaaa1111");
});

test("switchTo:切到当前会话会清掉超时提醒标记,下轮闲置能再提醒一次", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "aaaa1111");
  c.advance(TIMEOUT * 2);
  assert.deepEqual(sm.dueReminders(), ["stdin:local:u1"], "先提醒过一次");

  sm.switchTo("stdin:local:u1", "aaaa");
  c.advance(TIMEOUT * 2);
  assert.deepEqual(sm.dueReminders(), ["stdin:local:u1"], "接回来又放凉,该再提醒");
});

test("switchTo:找不到与有歧义分别报出,状态不动", () => {
  const { sm } = mgr();
  sm.record("stdin:local:u1", "aaaa1111");
  sm.archiveCurrent("stdin:local:u1");
  sm.record("stdin:local:u1", "aaab2222");
  sm.archiveCurrent("stdin:local:u1");

  assert.equal(sm.switchTo("stdin:local:u1", "zzzz").kind, "not-found");
  assert.equal(sm.switchTo("stdin:local:u1", "").kind, "not-found");
  const amb = sm.switchTo("stdin:local:u1", "aaa");
  assert.equal(amb.kind, "ambiguous");
  assert.equal(amb.kind === "ambiguous" && amb.matches.length, 2);
  // 歧义/未找到都不该动当前会话。
  assert.equal(sm.currentOf("stdin:local:u1"), undefined);
});

test("switchTo:isAlive 判死的目标报 gone 并当场剔除,不做切换", () => {
  const { sm } = mgr();
  sm.record("stdin:local:u1", "aaaa1111", "被清理的话题");
  sm.archiveCurrent("stdin:local:u1");
  sm.record("stdin:local:u1", "bbbb2222");

  const res = sm.switchTo("stdin:local:u1", "aaaa", () => false);
  assert.equal(res.kind, "gone");
  assert.equal(res.kind === "gone" && res.refs[0]?.sessionId, "aaaa1111");
  // 记录没了 resume 必然失败,留着条目只会把用户再骗一次。
  assert.deepEqual(sm.historyOf("stdin:local:u1"), []);
  assert.equal(sm.currentOf("stdin:local:u1")?.sessionId, "bbbb2222", "当前会话不动");
});

test("switchTo:同前缀下死条目让位,歧义只在活着的条目之间算", () => {
  const { sm } = mgr();
  for (const id of ["aaaa1111", "aaab2222", "aaac3333"]) {
    sm.record("stdin:local:u1", id);
    sm.archiveCurrent("stdin:local:u1");
  }
  // 三段都以 aaa 开头,其中两段已死:活着的那段直接胜出,不再报歧义。
  const res = sm.switchTo("stdin:local:u1", "aaa", (ref) => ref.sessionId === "aaab2222");
  assert.equal(res.kind, "switched");
  assert.equal(res.kind === "switched" && res.to.sessionId, "aaab2222");
  // 死条目在判定过程中已剔除。
  assert.deepEqual(sm.historyOf("stdin:local:u1"), []);
});

test("history 有上限:最老的被挤掉,同一 id 不重复列", () => {
  const { sm } = mgr();
  for (let i = 0; i < HISTORY_LIMIT + 3; i += 1) {
    sm.record("stdin:local:u1", `sess-${i}`);
    sm.archiveCurrent("stdin:local:u1");
  }
  // 重复归档同一个 id 不产生新条目。
  sm.record("stdin:local:u1", `sess-${HISTORY_LIMIT + 2}`);
  sm.archiveCurrent("stdin:local:u1");

  const ids = sm.historyOf("stdin:local:u1").map((h) => h.sessionId);
  assert.equal(ids.length, HISTORY_LIMIT);
  assert.equal(ids[0], `sess-${HISTORY_LIMIT + 2}`);
  assert.equal(new Set(ids).size, ids.length, "不该有重复 id");
});

test("dropSessionIds:当前与历史里的死引用都剔除,空壳条目整个删掉", () => {
  const { sm } = mgr();
  sm.record("stdin:local:u1", "sess-A");
  sm.archiveCurrent("stdin:local:u1");
  sm.record("stdin:local:u1", "sess-B");
  sm.record("stdin:local:u2", "sess-C");

  sm.dropSessionIds(["sess-A", "sess-C"]);
  assert.deepEqual(sm.historyOf("stdin:local:u1"), [], "历史里的死引用应剔除");
  assert.equal(sm.currentOf("stdin:local:u1")?.sessionId, "sess-B");
  assert.equal(sm.snapshot()["stdin:local:u2"], undefined, "清空的条目不该留空壳");
});

test("多用户互不干扰", () => {
  const { sm, c } = mgr();
  sm.record("stdin:local:u1", "sess-1");
  c.advance(30 * 60 * 1000);
  sm.record("stdin:local:u2", "sess-2");
  c.advance(TIMEOUT - 30 * 60 * 1000); // u1 累计超时,u2 未超时
  assert.equal(sm.decide("stdin:local:u1").isNew, true);
  assert.equal(sm.decide("stdin:local:u2").resumeSessionId, "sess-2");
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

  assert.equal(sm.decide(shortFor).isNew, true, "短超时的用户应当开新会话");
  assert.equal(sm.decide("stdin:local:normal").isNew, false, "默认超时的用户仍在窗口内");
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
  snap["stdin:local:u1"]!.current!.sessionId = "tampered";
  assert.equal(sm.decide("stdin:local:u1").resumeSessionId, "sess-A");
});

test("加载时丢弃非 userKey 或旧格式的状态(不认识历史格式,也不迁移)", () => {
  // 旧版本按裸 userId、或扁平的 {sessionId,...} 形态存状态。本程序不迁移它们 ——
  // 丢掉一段最多 1 小时的上下文,换取代码里没有任何格式分支。
  const store = new InMemoryStore({
    "o9cq80yCc7@im.wechat": {
      current: { sessionId: "legacy", lastActive: 0 },
      reminded: false,
      history: [],
    },
    // 旧版扁平格式,挂在合法 userKey 下 —— 形态校验要能认出来并丢弃。
    "stdin:local:old": { sessionId: "flat", lastActive: 0, reminded: false },
    "stdin:local:u1": {
      current: { sessionId: "sess-A", lastActive: 0 },
      reminded: false,
      history: [{ sessionId: "sess-old", lastActive: 0, hint: "旧话题" }],
    },
  } as unknown as StateMap);
  const sm = new SessionManager({ store, timeoutMs: TIMEOUT, now: () => 1 });
  const snap = sm.snapshot();
  assert.deepEqual(Object.keys(snap), ["stdin:local:u1"]);
  assert.equal(sm.historyOf("stdin:local:u1")[0]?.sessionId, "sess-old");
  // 丢弃的用户下次发消息就是全新会话,不会误 resume 到别人的上下文。
  assert.equal(sm.decide("o9cq80yCc7@im.wechat").isNew, true);
  assert.equal(sm.decide("stdin:local:old").isNew, true);
});
