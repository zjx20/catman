import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox, backlogText, exhaustedText } from "../src/courier/outbox.js";
import { NOTICE_RESERVE, ReplyStore, SEND_BUDGET } from "../src/courier/reply-store.js";
import type { SendKind } from "../src/ipc/protocol.js";

/**
 * **必须 `await fn`,不能 `return fn(dir)`。**
 *
 * 后者会在 fn 遇到第一个 await 就把 pending 的 promise 交出来,`finally` 当场
 * 执行 —— 临时目录在用例还跑到一半时就被删掉了。落盘那条用例长期靠一个巧合
 * 活着:从前第一次写盘发生在 `deliver` 抛错**之后**,而那时目录已经被删,
 * `writeJsonFileAtomic` 里的 `mkdirSync(recursive)` 又把它建了回来。改动一下
 * 写盘的时机,这条用例就会以"重启后积压没了"的面目失败 —— 而真正没了的是目录。
 */
async function withDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "catman-outbox-"));
  try {
    await fn(dir);
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

/**
 * 把这条来信的额度**连保留格一起**烧光:9 条普通消息 + 那句提示。
 *
 * 只烧 9 条会剩下保留格,下一条被拒的消息就会带出一句提示 —— 那是设计的一部分,
 * 但不是这些用例要看的东西。
 */
function exhaust(replies: ReplyStore, userKey = U): void {
  for (let i = 0; i < SEND_BUDGET; i++) replies.begin(userKey, i === 0 ? "budget" : "body");
  assert.equal(replies.remainingSends(userKey), 0);
  assert.equal(replies.noticePending(userKey), false);
}

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
    exhaust(replies);

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
    exhaust(replies);

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
    exhaust(replies);

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
    exhaust(replies);

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

test("发件队列:排空不留余地 —— 新额度全用来还旧账,见底了再说「还有 N 条」", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });
    exhaust(replies);

    // 攒一堆积压(远多于一份额度发得完的)。
    for (let i = 0; i < 30; i++) await box.submit(U, `第 ${i} 段`, "body");
    assert.ok(box.depth(U) > 20, "先确认真的积压了");

    replies.remember(U, "raw", "tok-2");
    box.kick(U);
    await waitUntil(
      () => ch.sent.some((s) => s.kind === "budget"),
      "排空停下来并交代还剩多少",
      15_000,
    );

    // 从前停在"还剩 4 格"给用户的新问题留位置 —— 代价是旧消息与新消息乱序,
    // 而且 /nop 本身不是新问题。现在 9 格全发,只有最后一格留给那句交代。
    const bodies = ch.sent.filter((s) => s.kind === "body");
    assert.equal(bodies.length, SEND_BUDGET - NOTICE_RESERVE, "普通额度要全用掉");
    assert.equal(replies.remainingSends(U), 0);
    const last = ch.sent.at(-1)!;
    assert.equal(last.kind, "budget");
    assert.equal(last.text, backlogText(30 - bodies.length), "报得出准确条数");

    // 同一份 token 不重复说 —— 那等于用剩下的额度刷屏,而不是发积压。
    const before = ch.sent.length;
    box.kick(U);
    await settle();
    assert.equal(ch.sent.length, before, "同一个 token 只说一次");

    // 再来一份额度,接着按顺序发。
    replies.remember(U, "raw", "tok-3");
    box.kick(U);
    await waitUntil(() => ch.sent.filter((s) => s.kind === "budget").length === 2, "第二轮", 15_000);
    assert.deepEqual(
      ch.sent.filter((s) => s.kind === "body").map((s) => s.text).slice(0, 18),
      Array.from({ length: 18 }, (_, i) => `第 ${i} 段`),
      "严格保序",
    );
  });
});

test("发件队列:落盘 —— 信使重启时积压里可能正躺着一条答案", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "outbox.json");
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    exhaust(replies);

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
    exhaust(replies);

    await box.submit(U, "🔧 进度", "progress");
    for (let i = 0; i < 60; i++) await box.submit(U, `正文 ${i}`, "body");
    assert.ok(box.depth(U) <= 40, "要有上限,否则最不该 OOM 的进程去扛峰值");
    assert.ok(box.dropped > 0, "丢了就要记一笔");
  });
});

test("发件队列:进度没有单独上限 —— 有额度就一直发,没了由信使说「发 /nop」", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });

    await box.submit(U, "收到,正在处理中…", "ack");
    const room = SEND_BUDGET - NOTICE_RESERVE - 1;
    for (let i = 0; i < room; i++) await box.submit(U, `进度 ${i}`, "progress");
    assert.equal(ch.sent.filter((s) => s.kind === "progress").length, room, "从前这里被封在 6 条");
    assert.equal(ch.sent.filter((s) => s.kind === "budget").length, 0, "还没被拒之前不该提前说");

    // 再来一条进度 —— 这条会被拒,而"被拒"正是该说那句话的时刻。
    await box.submit(U, "进度 再一条", "progress");
    const hint = ch.sent.filter((s) => s.kind === "budget");
    assert.equal(hint.length, 1, `该说一次:${JSON.stringify(ch.sent.map((s) => s.text))}`);
    assert.equal(hint[0]!.text, exhaustedText());
    assert.equal(box.depth(U), 1, "被拒的进度在队列里等下一份额度");

    // 同一份 token 不重复说。
    await box.submit(U, "进度 又一条", "progress");
    assert.equal(ch.sent.filter((s) => s.kind === "budget").length, 1, "只说一次");
    assert.equal(box.depth(U), 1, "进度只留最新一条");
  });
});

/**
 * 这条守的是整件事的目的:**没发全,用户一定会被告知**。
 *
 * 真机上的形态是长回合 + 长答案:回执 1、进度若干、答案分段。从前最后一格被
 * 正文的下一段吃掉,于是答案在半截处停住、一句话都没有 —— 与卡死无从分辨,
 * 而用户根本不知道发一句 /nop 就能接着收。静默过 14 分钟和 2 小时 24 分。
 */
test("发件队列:正文分段撞上预算时,最后一格拿去说话而不是再发一段", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });

    await box.submit(U, "收到,正在处理中…", "ack");
    for (let i = 0; i < 6; i++) await box.submit(U, `进度 ${i}`, "progress");

    // 一条 3 段的长答案:前 2 段发得出去,第 3 段额度不够了。
    for (const seg of ["答案 1/3", "答案 2/3", "答案 3/3"]) await box.submit(U, seg, "body");

    const texts = ch.sent.map((s) => s.text);
    assert.ok(texts.includes("答案 2/3"), `前两段该当场发出去:${JSON.stringify(texts)}`);
    assert.ok(!texts.includes("答案 3/3"), "第 3 段不许吃掉最后一格");
    const notice = ch.sent.filter((s) => s.kind === "budget");
    assert.equal(notice.length, 1, `必须交代一次:${JSON.stringify(texts)}`);
    assert.equal(notice[0]!.text, exhaustedText());
    // 交代必须是**最后**一条:它之后再塞半段正文,等于用最后一格换来一句谎话。
    assert.equal(ch.sent.at(-1)!.kind, "budget");
    assert.equal(replies.remainingSends(U), 0, "最后一格正是花在这句交代上");
    assert.equal(box.depth(U), 1, "没发出去的那段还在队列里(过期进度已被答案作废)");
  });
});

/**
 * 回归 2026-09-07:正文发完还剩 1 格,**会话空闲提醒**(reminder)不问保留额把它拿走;
 * 早上定时日报来时额度为 0,内容进了队列,那句"发 /nop"却一格都申请不到 ——
 * 用户从 02:32 静默到 08:24,而且日志里一行都没有。
 *
 * 根源是"最后一格留给交代"这条规矩只拦正文那一类,别的类别都是例外。
 * 现在它在 ReplyStore 里对所有类别生效。
 */
test("发件队列:回归 2026-09-07 —— 空闲提醒吃不掉最后一格,日报入队时提示一定发得出", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-0120");
    const ch = fakeChannel(replies);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });

    // 01:20 那一轮:回执 + 进度 + 正文,把普通额度正好用完。
    await box.submit(U, "收到,正在处理中…", "ack");
    for (let i = 0; i < SEND_BUDGET - NOTICE_RESERVE - 2; i++) await box.submit(U, `进度 ${i}`, "progress");
    await box.submit(U, "答案", "body");
    assert.equal(replies.remainingSends(U), 0, "普通额度用完,只剩保留格");

    // 02:32 空闲提醒 —— 从前这条直接拿走了最后一格。
    await box.submit(U, "这次对话已经安静了一会儿…", "reminder");
    assert.ok(!ch.sent.some((s) => s.text.includes("安静")), "空闲提醒不许碰最后一格");
    const notices = ch.sent.filter((s) => s.kind === "budget");
    assert.equal(notices.length, 1, "提醒进队列的那一刻就得交代");

    // 06:00 日报。
    await box.submit(U, "科技日报 (1/4)", "announce");
    await box.submit(U, "科技日报 (2/4)", "announce");
    assert.equal(ch.sent.filter((s) => s.kind === "budget").length, 1, "同一份 token 不再说第二次");
    assert.equal(box.depth(U), 3, "提醒 + 两段日报都在队列里");

    // 08:24 用户开口,新 token:按顺序排空,不再有假的"额度已用完"。
    replies.remember(U, "raw", "tok-0824");
    box.kick(U);
    await waitUntil(() => box.depth(U) === 0, "排空", 5_000);
    const after = ch.sent.slice(ch.sent.findIndex((s) => s.kind === "budget") + 1);
    assert.deepEqual(
      after.map((s) => s.text),
      ["这次对话已经安静了一会儿…", "科技日报 (1/4)", "科技日报 (2/4)"],
      "严格按入队顺序",
    );
  });
});

test("发件队列:新 token 下因排序入队的不说「额度已用完」—— 那时额度是满的", async () => {
  // 真机 08:24 的假话:/任务 是信使当场答的硬指令,它的回复因为"队列非空排队尾"入队,
  // 入队就触发了"这条来信的额度用完了" —— 而那一刻 token 是全新的。
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });
    exhaust(replies);
    await box.submit(U, "积压 A", "announce");
    await box.submit(U, "积压 B", "announce");

    replies.remember(U, "raw", "tok-2");
    await box.submit(U, "硬指令的回复", "body"); // 队列非空 → 排队尾 → 顺手催排空
    await waitUntil(() => box.depth(U) === 0, "排空", 5_000);
    assert.deepEqual(
      ch.sent.map((s) => s.text),
      ["积压 A", "积压 B", "硬指令的回复"],
      "全都发了,顺序不乱,没有一句提示",
    );
    assert.equal(ch.sent.filter((s) => s.kind === "budget").length, 0);
  });
});

test("发件队列:提示每份 token 只说一次,信使重启后也不再说", async () => {
  await withDir(async (dir) => {
    const ctxPath = join(dir, "ctx.json");
    const outPath = join(dir, "outbox.json");
    const first = new ReplyStore(ctxPath);
    first.remember(U, "raw", "tok-1");
    const ch1 = fakeChannel(first);
    const box1 = new Outbox({ replies: first, deliver: ch1.deliver, path: outPath, paceMs: 5 });
    for (let i = 0; i < SEND_BUDGET - NOTICE_RESERVE; i++) await box1.submit(U, `第 ${i}`, "body");
    await box1.submit(U, "发不出去的", "body");
    assert.equal(ch1.sent.filter((s) => s.kind === "budget").length, 1);
    await box1.stop();

    // 重启:两份状态都从盘上读回来。
    const second = new ReplyStore(ctxPath);
    const ch2 = fakeChannel(second);
    const box2 = new Outbox({ replies: second, deliver: ch2.deliver, path: outPath, paceMs: 5 });
    await box2.submit(U, "又一条发不出去的", "body");
    assert.equal(ch2.sent.length, 0, "重启后不该再说一遍 —— 那是拿不存在的格子说话");
    assert.equal(box2.depth(U), 2);
  });
});

test("发件队列:传输层失败(不是额度)不说提示 —— 那句话会是假的", async () => {
  await withDir(async (dir) => {
    const replies = new ReplyStore(join(dir, "ctx.json"));
    replies.remember(U, "raw", "tok-1");
    const ch = fakeChannel(replies);
    ch.setFail(true);
    const box = new Outbox({ replies, deliver: ch.deliver, paceMs: 5 });
    await box.submit(U, "答案", "body");
    ch.setFail(false);
    assert.equal(box.depth(U), 1);
    assert.equal(ch.sent.length, 0, "额度还满着,不该说「额度已用完」");
  });
});

test("两句提示同一口径:说额度没了、还有东西没发、怎么续;不说「来信」不说「一半」", () => {
  for (const t of [backlogText(7), exhaustedText()]) {
    assert.ok(t.startsWith("回信额度已用完"), t);
    assert.ok(t.includes("待发送"), t);
    assert.ok(t.includes("/nop"), t);
    assert.ok(!t.includes("来信") && !t.includes("一半"), t);
  }
  assert.ok(backlogText(7).includes("7 条"));
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
