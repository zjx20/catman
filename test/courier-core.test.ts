import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CourierCore } from "../src/courier/core.js";
import { Inbox } from "../src/courier/inbox.js";
import { ReplyStore } from "../src/courier/reply-store.js";
import { RoutingTable } from "../src/courier/routing.js";
import { SettingsView } from "../src/courier/settings-view.js";
import { Spool } from "../src/courier/spool.js";
import { canonicalOf } from "../src/core/commands.js";
import type { PersonaId, SendKind } from "../src/ipc/protocol.js";

/**
 * 信使核心的分流:一条来信落到哪个人格、哪些话由信使自己回、控制帧发给谁。
 *
 * 除了"真正把字节发出去"之外全用真实实现(队列、路由、预算、spool 都落到临时目录)——
 * 这几件东西的失败模式都在持久化与时序上,打桩就把要验的东西打掉了。
 */

const ADMIN = "wechat:acc1:admin";
const USER = "wechat:acc1:someone";

interface Harness {
  core: CourierCore;
  sent: Array<{ userKey: string; text: string; kind: SendKind }>;
  inboxes: Map<PersonaId, Inbox>;
  routing: RoutingTable;
  dir: string;
}

function build(dir: string, opts: { now?: () => number } = {}): Harness {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ adminUserKeys: [ADMIN] }));
  const inboxes = new Map<PersonaId, Inbox>([
    ["primary", new Inbox({ path: join(dir, "primary.jsonl") })],
    ["rescue", new Inbox({ path: join(dir, "rescue.jsonl") })],
  ]);
  const routing = new RoutingTable({ path: join(dir, "routes.json") });
  const sent: Array<{ userKey: string; text: string; kind: SendKind }> = [];
  const core = new CourierCore({
    inboxes,
    routing,
    replies: new ReplyStore(join(dir, "ctx.json")),
    spool: new Spool({ dir: join(dir, "spool") }),
    settings: new SettingsView(join(dir, "settings.json")),
    greetedPath: join(dir, "greeted.json"),
    send: async (userKey, text, kind) => {
      sent.push({ userKey, text, kind });
    },
    bindPassphrase: "开门芝麻",
    onForceBind: () => "已强制绑定。",
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { core, sent, inboxes, routing, dir };
}

async function withHarness(fn: (h: Harness) => Promise<void>, opts?: { now?: () => number }) {
  const dir = mkdtempSync(join(tmpdir(), "catman-core-"));
  try {
    await fn(build(dir, opts ?? {}));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_SIGNAL = new AbortController().signal;

test("来信默认落进主人格的队列", async () => {
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: USER, text: "喂" });
    assert.equal(h.inboxes.get("primary")!.depth(), 1);
    assert.equal(h.inboxes.get("rescue")!.depth(), 0);
  });
});

test("/救援 由信使就地消化,**不进任何队列** —— 主人格卡死时它才管用", async () => {
  // 这是这条指令存在的全部理由。进了队列就等于"要主人格活着才能召唤救援"。
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: ADMIN, text: canonicalOf("rescue") });
    assert.equal(h.inboxes.get("primary")!.depth(), 0);
    assert.equal(h.inboxes.get("rescue")!.depth(), 0);
    assert.equal(h.routing.personaFor(ADMIN), "rescue");
    assert.match(h.sent.at(-1)!.text, /守护人格/);
  });
});

test("切换时给**被切走的**那个人格发 detach —— 标出处的是它", async () => {
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: ADMIN, text: canonicalOf("rescue") });
    const toPrimary = await h.core.pull("primary", 0, NO_SIGNAL);
    assert.deepEqual(
      toPrimary.controls.map((c) => [c.type, c.userKey]),
      [["detach", ADMIN]],
    );
    const toRescue = await h.core.pull("rescue", 0, NO_SIGNAL);
    assert.deepEqual(toRescue.controls, [], "切过去的那个不该收到 detach");
  });
});

test("切过去之后的消息落进守护人格", async () => {
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: ADMIN, text: canonicalOf("rescue") });
    await h.core.accept({ msgId: "m2", userKey: ADMIN, text: "看看日志" });
    assert.equal(h.inboxes.get("rescue")!.depth(), 1);
    assert.equal(h.inboxes.get("primary")!.depth(), 0);
  });
});

test("非管理员的 /救援 当它不是指令 —— 照常投递,不透露它存在", async () => {
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: USER, text: canonicalOf("rescue") });
    assert.equal(h.routing.personaFor(USER), "primary");
    assert.equal(h.inboxes.get("primary")!.depth(), 1, "该当成普通消息投给人格");
    assert.deepEqual(h.sent, [], "一个字都不该回");
  });
});

test("/绑定 口令不对时同样当它不是指令 —— 说「口令错了」等于告诉别人有这条路", async () => {
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: USER, text: `${canonicalOf("bind")} 瞎猜的` });
    assert.deepEqual(h.sent, []);
    assert.equal(h.inboxes.get("primary")!.depth(), 1);
  });
});

test("/绑定 口令对上就强制绑定,而且**不需要**是管理员", async () => {
  // 它要救的正是"被准入挡在门外"的人 —— 那种处境下他不可能被认作管理员。
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: USER, text: `${canonicalOf("bind")} 开门芝麻` });
    assert.equal(h.inboxes.get("primary")!.depth(), 0, "指令本身不该进队列");
    assert.match(h.sent.at(-1)!.text, /已强制绑定/);
  });
});

test("greeting 只推一次,而且判定权在信使 —— 否则首次 /救援 会白吃一份欢迎语", async () => {
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: USER, text: "第一次" });
    await h.core.accept({ msgId: "m2", userKey: USER, text: "第二次" });
    const msgs = h.inboxes.get("primary")!.peek(10);
    assert.equal(msgs[0]!.greeted, false, "第一条:人格该发使用指引");
    assert.equal(msgs[1]!.greeted, true, "之后就不该再发了");
  });
});

test("greeting 记录跨重启存活 —— 重启后重发欢迎语是白吃预算", async () => {
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: USER, text: "第一次" });
    const second = build(h.dir);
    await second.core.accept({ msgId: "m2", userKey: USER, text: "重启之后" });
    assert.equal(second.inboxes.get("primary")!.peek(10).at(-1)!.greeted, true);
  });
});

test("附件落盘,队列里只留引用 —— base64 驻留会把最不该 OOM 的进程顶爆", async () => {
  await withHarness(async (h) => {
    await h.core.accept({
      msgId: "m1",
      userKey: USER,
      text: "看图",
      attachments: [{ kind: "image", mediaType: "image/png", data: "AQID", bytes: 3 }],
    });
    const m = h.inboxes.get("primary")!.peek(1)[0]!;
    assert.equal(m.attachmentRefs.length, 1);
    assert.equal(m.attachmentRefs[0]!.mediaType, "image/png");
    assert.equal(JSON.stringify(m).includes("AQID"), false, "字节不该出现在队列记录里");
  });
});

test("ack 之后附件才被清理 —— 提早删会让人格永远重试一条读不到图的消息", async () => {
  await withHarness(async (h) => {
    await h.core.accept({
      msgId: "m1",
      userKey: USER,
      text: "看图",
      attachments: [{ kind: "image", mediaType: "image/png", data: "AQID", bytes: 3 }],
    });
    const ref = h.inboxes.get("primary")!.peek(1)[0]!.attachmentRefs[0]!;
    const spool = new Spool({ dir: join(h.dir, "spool") });
    assert.ok(spool.get(ref.id), "ack 之前必须还在");
    await h.core.ack("primary", ["m1"]);
    assert.equal(spool.get(ref.id), undefined);
  });
});

test("NACK 亮红灯并出队 —— 留着它会把队列钉死在这一条上", async () => {
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: USER, text: "喂" });
    await h.core.nack("primary", ["m1"], "读不懂");
    assert.equal(h.inboxes.get("primary")!.depth(), 0);
    assert.equal(h.core.losses()["primary"]!.nacked, 1, "必须计数,不能静默");
  });
});

test("已经切到别的人格的用户,旧人格的**进度**不再送出去", async () => {
  // 让用户在跟守护人格说话的中途收到主人格的进度,既莫名其妙又白吃一条预算。
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: ADMIN, text: canonicalOf("rescue") });
    const r = await h.core.send("primary", {
      schema: 1,
      userKey: ADMIN,
      kind: "progress",
      text: "还在跑",
    });
    assert.equal(r.ok, false);
    assert.equal(h.sent.filter((s) => s.text === "还在跑").length, 0);
  });
});

test("但被切走那一轮的**正文**照样送 —— 它带着出处前缀,是用户主动要的", async () => {
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: ADMIN, text: canonicalOf("rescue") });
    const r = await h.core.send("primary", {
      schema: 1,
      userKey: ADMIN,
      kind: "body",
      text: "【后台对话 abc 的结果】改好了",
    });
    assert.equal(r.ok, true);
    assert.ok(h.sent.some((s) => s.text.includes("后台对话")));
  });
});

test("排水的第二个真相源:每人格的队列深度", async () => {
  // 只看人格 /health 的三个计数是"假清零" —— 还躺在信使队列里的一条都不算。
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: USER, text: "喂" });
    assert.deepEqual(h.core.depths(), { primary: 1, rescue: 0 });
  });
});

test("路由 TTL 回落会告知用户,并给旧人格发 detach", async () => {
  let now = 1000;
  const dir = mkdtempSync(join(tmpdir(), "catman-core-"));
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ adminUserKeys: [ADMIN] }));
    const routing = new RoutingTable({ path: join(dir, "routes.json"), ttlMs: 500, now: () => now });
    const inboxes = new Map<PersonaId, Inbox>([
      ["primary", new Inbox({ path: join(dir, "p.jsonl") })],
      ["rescue", new Inbox({ path: join(dir, "r.jsonl") })],
    ]);
    const sent: Array<{ userKey: string; text: string; kind: SendKind }> = [];
    const core = new CourierCore({
      inboxes,
      routing,
      replies: new ReplyStore(join(dir, "ctx.json")),
      spool: new Spool({ dir: join(dir, "spool") }),
      settings: new SettingsView(join(dir, "settings.json")),
      greetedPath: join(dir, "greeted.json"),
      send: async (userKey, text, kind) => {
        sent.push({ userKey, text, kind });
      },
      now: () => now,
    });
    routing.switchTo(ADMIN, "rescue");
    now = 2000;
    await core.sweepRoutes();
    assert.equal(routing.personaFor(ADMIN), "primary");
    assert.match(sent.at(-1)!.text, /切回主人格/);
    const toRescue = await core.pull("rescue", 0, NO_SIGNAL);
    assert.deepEqual(toRescue.controls.map((c) => c.userKey), [ADMIN]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("处理来信时任何一步抛错都只跳过这一条,绝不掀翻循环", async () => {
  // 调用方是长轮询主循环:抛出去就等于让一条毒消息停掉整个渠道,
  // 而重启之后游标还没推进,它会被重放、再崩,无限循环,微信全聋。
  await withHarness(async (h) => {
    // 造一条会让 spool 写入炸掉的消息(data 不是合法 base64 也不至于抛,所以
    // 直接把 inbox 换成会抛的)—— 这里用一个不存在的人格来触发内部错误路径。
    h.routing.switchTo(USER, "rescue");
    h.inboxes.delete("rescue");
    await h.core.accept({ msgId: "m1", userKey: USER, text: "喂" }); // 不该抛
    assert.equal(h.inboxes.get("primary")!.depth(), 0);
  });
});

test("没有消息时 pull 真的挂住 waitMs —— 否则 bridge 会以最高速度空转", async () => {
  // 与 ipc-transport 里那条"signal 进门时不能已经 aborted"是同一件事的两半:
  // 那条验信号,这条验**行为**。只验信号的话,别处再加一个提前返回同样测不出来。
  await withHarness(async (h) => {
    const started = Date.now();
    const r = await h.core.pull("primary", 200, NO_SIGNAL);
    const elapsed = Date.now() - started;
    assert.deepEqual(r.messages, []);
    assert.ok(elapsed >= 150, `只挂了 ${elapsed}ms —— 长轮询没生效`);
  });
});

test("有消息时立刻返回,不必等满 waitMs", async () => {
  await withHarness(async (h) => {
    await h.core.accept({ msgId: "m1", userKey: USER, text: "喂" });
    const started = Date.now();
    await h.core.pull("primary", 5000, NO_SIGNAL);
    assert.ok(Date.now() - started < 200, "有货就该马上给");
  });
});

test("挂着的时候来了新消息要**立刻唤醒**,而不是等超时", async () => {
  await withHarness(async (h) => {
    const started = Date.now();
    const pulling = h.core.pull("primary", 5000, NO_SIGNAL);
    setTimeout(() => void h.core.accept({ msgId: "m1", userKey: USER, text: "喂" }), 50);
    const r = await pulling;
    assert.equal(r.messages.length, 1);
    assert.ok(Date.now() - started < 1000, "唤醒没生效,白等了一整个 waitMs");
  });
});

test("写盘失败不能静默吞掉 —— 计数,并且**告诉用户重发**", async () => {
  // 磁盘满时:消息没进队列、dropped 覆盖不到这条路、用户一个字收不到,
  // 而 accept 正常返回 → iLink 游标照常推进 → 这条消息永远不会被重放。
  // 用户侧就是"发了没反应",也就是整套设计最想消灭的那个症状。
  await withHarness(async (h) => {
    h.inboxes.delete("primary"); // 模拟"这条消息落不了地"
    await h.core.accept({ msgId: "m1", userKey: USER, text: "喂" });
    assert.equal(h.core.lostCount(), 1, "必须计数");
    assert.match(h.sent.at(-1)!.text, /再发一次/, "必须让他知道要重发");
  });
});

test("没收下的那条,它的附件也要清掉 —— 否则成了永远没人引用的孤儿", async () => {
  await withHarness(async (h) => {
    h.inboxes.delete("primary");
    await h.core.accept({
      msgId: "m1",
      userKey: USER,
      text: "看图",
      attachments: [{ kind: "image", mediaType: "image/png", data: "AQID", bytes: 3 }],
    });
    const spool = new Spool({ dir: join(h.dir, "spool") });
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(join(h.dir, "spool")), [], "spool 该是空的");
    void spool;
  });
});
