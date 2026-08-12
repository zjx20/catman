import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox, backlogText } from "../src/courier/outbox.js";
import { MAX_PROGRESS_PER_TOKEN, ReplyStore, SEND_BUDGET } from "../src/courier/reply-store.js";
import type { SendKind } from "../src/ipc/protocol.js";

function withDir(fn: (dir: string) => void | Promise<void>): void | Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "catman-outbox-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Sent {
  userKey: string;
  text: string;
  kind: SendKind;
}

/**
 * 假渠道:按 `ReplyStore` 的账判断发不发得出去,与真机同构 ——
 * 预算不够时 `begin()` 拒绝、**不计数**,所以"试一次"是免费的。
 */
function fakeChannel(replies: ReplyStore) {
  const sent: Sent[] = [];
  let fail = false;
  return {
    sent,
    setFail: (v: boolean): void => {
      fail = v;
    },
    deliver: async (userKey: string, text: string, kind: SendKind): Promise<void> => {
      if (fail) throw new Error("发不出去");
      const permit = replies.begin(userKey, kind);
      if (!permit.allowed) throw new Error(permit.reason ?? "预算不允许");
      sent.push({ userKey, text, kind });
    },
  };
}

const U = "wechat:acct:u1";

test("发件队列:有额度就当场发,与从前一模一样", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });

    await box.submit(U, "答案", "body");
    assert.deepEqual(ch.sent, [{ userKey: U, text: "答案", kind: "body" }]);
    assert.equal(box.depth(), 0, "发出去了就不该留在队列里");
  });
});

test("发件队列:额度用尽时正文进队列而不是消失 —— 这是整件事的理由", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });

    // 把这条来信的额度烧光。
    for (let i = 0; i < SEND_BUDGET; i++) replies.begin(U, "body");
    assert.equal(replies.remainingSends(U), 0);

    await box.submit(U, "跑了五分钟才得出的答案", "body");
    assert.equal(ch.sent.length, 0, "发不出去");
    assert.equal(box.depth(U), 1, "但它必须还在 —— 从前这里就是一行日志然后没了");

    // 用户发了一句话(/nop 或别的),新 token 带来新额度。
    replies.remember(U, "raw", "tok-2");
    box.kick(U);
    await waitUntil(() => ch.sent.length === 1, "额度回来之后要自动补发");
    assert.equal(ch.sent[0]!.text, "跑了五分钟才得出的答案");
    assert.equal(box.depth(U), 0);
  });
});

test("发件队列:进度只留最新一条 —— 补发十分钟前的工具调用毫无意义", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });
    for (let i = 0; i < SEND_BUDGET; i++) replies.begin(U, "body");

    await box.submit(U, "🔧 Bash: 第一步", "progress");
    await box.submit(U, "🔧 Bash: 第二步", "progress");
    await box.submit(U, "🔧 Bash: 第三步", "progress");
    assert.equal(box.depth(U), 1, "三条进度只该留一条");

    replies.remember(U, "raw", "tok-2");
    box.kick(U);
    await waitUntil(() => ch.sent.length === 1, "补发");
    assert.equal(ch.sent[0]!.text, "🔧 Bash: 第三步", "留下的该是最新那条");
  });
});

test("发件队列:回执压根不排队 —— 排到它时答案早发过了", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });
    for (let i = 0; i < SEND_BUDGET; i++) replies.begin(U, "body");

    await box.submit(U, "答案", "body");
    await box.submit(U, "收到,正在处理中…", "ack");
    assert.equal(box.depth(U), 1, "只有正文该排队");
    assert.equal(box.dropped, 1, "被丢掉的回执要记一笔,不能静默");
  });
});

test("发件队列:新消息排到队尾,不插队", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    const box = new Outbox({ replies, deliver: ch.deliver, now: () => 1000, paceMs: 5 });
    for (let i = 0; i < SEND_BUDGET; i++) replies.begin(U, "body");

    await box.submit(U, "上一个问题的答案", "body");
    await box.submit(U, "部署完成了", "announce");
    replies.remember(U, "raw", "tok-2");
    box.kick(U);
    await waitUntil(() => ch.sent.length === 2, "两条都要发出去");
    assert.deepEqual(
      ch.sent.map((s) => s.text),
      ["上一个问题的答案", "部署完成了"],
      "顺序在聊天里是有意义的",
    );
  });
});

test("发件队列:排空留余地,停下时说一句「还有 N 条」", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });
    for (let i = 0; i < SEND_BUDGET; i++) replies.begin(U, "body");

    // 攒一堆积压(远多于一份额度发得完的)。
    for (let i = 0; i < 30; i++) await box.submit(U, `第 ${i} 段`, "body");
    assert.ok(box.depth(U) > 20, "先确认真的积压了");

    replies.remember(U, "raw", "tok-2");
    box.kick(U);
    await waitUntil(
      () => ch.sent.some((s) => s.text.includes("还有")),
      "排空停下来并交代还剩多少",
      15_000,
    );

    // 没有一口气把新额度用光 —— 用户刚发的那一轮也要有得用。
    assert.ok(replies.remainingSends(U) > 0, "不该把额度榨干");
    assert.ok(box.depth(U) > 0, "没发完的还在队列里等下一次");
    const last = ch.sent.at(-1)!;
    assert.ok(last.text.includes("/nop"), "并且给出下一次排空的开关");
    assert.equal(last.kind, "reminder");

    // 同一份 token 不重复说 —— 那等于用剩下的额度刷屏,而不是发积压。
    const before = ch.sent.length;
    box.kick(U);
    await settle();
    assert.equal(ch.sent.length, before, "同一个 token 只说一次");
  });
});

test("发件队列:落盘 —— 信使重启时积压里可能正躺着一条答案", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "outbox.json");
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    for (let i = 0; i < SEND_BUDGET; i++) replies.begin(U, "body");

    const first = new Outbox({ replies, deliver: fakeChannel(replies).deliver, path });
    await first.submit(U, "还没送出去的答案", "body");
    await first.stop();

    // 重启:换一个实例读同一个文件。
    const ch = fakeChannel(replies);
    const second = new Outbox({ replies, deliver: ch.deliver, path, paceMs: 5 });
    assert.equal(second.depth(U), 1, "重启后积压必须还在");
    replies.remember(U, "raw", "tok-2");
    second.kick(U);
    await waitUntil(() => ch.sent.length === 1, "接着发");
    assert.equal(ch.sent[0]!.text, "还没送出去的答案");
  });
});

test("发件队列:发送失败留在队列里,而且不原地重试", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    ch.setFail(true);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });

    await box.submit(U, "答案", "body");
    assert.equal(box.depth(U), 1, "失败的不能丢");
    await settle();
    assert.equal(ch.sent.length, 0);

    // 原地重试是错的:token 废掉时是永不恢复的,重试只是拿失败去烧剩下的额度。
    ch.setFail(false);
    box.kick(U);
    await waitUntil(() => ch.sent.length === 1, "下一次触发才重发");
  });
});

test("发件队列:积压超上限时先丢可丢的,不先丢正文", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });
    for (let i = 0; i < SEND_BUDGET; i++) replies.begin(U, "body");

    await box.submit(U, "🔧 进度", "progress");
    for (let i = 0; i < 60; i++) await box.submit(U, `正文 ${i}`, "body");
    assert.ok(box.depth(U) <= 40, "要有上限,否则最不该 OOM 的进程去扛峰值");
    assert.ok(box.dropped > 0, "丢了就要记一笔");
  });
});

test("发件队列:进度撞上限时由信使说那句「发 /nop」—— 人格不该知道预算这回事", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });

    // 把进度额度用光(总额还剩保留的那几条 —— 那句提示的落脚点就在里面)。
    for (let i = 0; i < MAX_PROGRESS_PER_TOKEN; i++) await box.submit(U, `进度 ${i}`, "progress");
    assert.equal(replies.remainingProgress(U), 0);
    assert.ok(replies.remainingSends(U) > 0, "保留额还在");
    assert.equal(
      ch.sent.filter((s) => s.text.includes("/nop")).length,
      0,
      "还没被拒之前不该提前说",
    );

    // 再来一条进度 —— 这条会被拒,而"被拒"正是该说那句话的时刻。
    await box.submit(U, "进度 再一条", "progress");
    const hint = ch.sent.filter((s) => s.text.includes("/nop"));
    assert.equal(hint.length, 1, `该说一次:${JSON.stringify(ch.sent.map((s) => s.text))}`);
    assert.ok(hint[0]!.text.includes("进度就报到这儿"));
    assert.equal(hint[0]!.kind, "reminder", "走保留额,不占进度的名额");

    // 同一份 token 不重复说 —— 说这句话本身也花一格。
    await box.submit(U, "进度 又一条", "progress");
    assert.equal(ch.sent.filter((s) => s.text.includes("/nop")).length, 1, "只说一次");
  });
});

test("backlogText 说得出还剩几条,并带上口令", () => {
  const t = backlogText(7);
  assert.ok(t.includes("7"));
  assert.ok(t.includes("/nop"));
});

// --- 小工具 ---

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30));
}

async function waitUntil(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等不到:${what}`);
}
