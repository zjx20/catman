import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox, inboundOf } from "../src/courier/inbox.js";
import {
  LIVE_TURN_SENDS,
  MAX_PROGRESS_PER_TOKEN,
  ReplyStore,
  SEND_BUDGET,
} from "../src/courier/reply-store.js";
import { Spool } from "../src/courier/spool.js";
import type { InboundEnvelope } from "../src/ipc/protocol.js";

/**
 * 信使的持久层。三件东西各守一条"丢了就没救"的性质:
 *   inbox        —— 消息跨重启存活,且 ack 之前绝不出队
 *   reply-store  —— 发送预算不超发(超发 = 整段对话永久静默)
 *   spool        —— 附件字节不进内存队列,ack 之后才清理
 *
 * 全部用真实文件系统:这三件事的失败模式都在"进程重启"那一刻,打桩测的是我的想象。
 */

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "catman-courier-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function msg(id: string, text = "喂", userKey = "wechat:a:u1"): InboundEnvelope {
  return inboundOf({ msgId: id, userKey, text, attachmentRefs: [], greeted: true, ts: 1 });
}

// ── inbox ─────────────────────────────────────────────────────────

test("inbox:ack 之前反复 peek 拿到的是同一批 —— 人格拉走后崩了不需要租约兜底", () => {
  withDir((dir) => {
    const box = new Inbox({ path: join(dir, "primary.jsonl") });
    box.push(msg("m1"));
    box.push(msg("m2"));
    assert.deepEqual(box.peek(10).map((m) => m.msgId), ["m1", "m2"]);
    assert.deepEqual(box.peek(10).map((m) => m.msgId), ["m1", "m2"], "没 ack 就还在");
    assert.equal(box.ack(["m1"]), 1);
    assert.deepEqual(box.peek(10).map((m) => m.msgId), ["m2"]);
  });
});

test("inbox:跨重启存活 —— 「部署窗口不丢消息」只有这样才成立", () => {
  withDir((dir) => {
    const path = join(dir, "primary.jsonl");
    const first = new Inbox({ path });
    first.push(msg("m1"));
    first.push(msg("m2"));
    first.ack(["m1"]);

    // 换一个实例 = 模拟进程重启(信使跑 pinned release,人工 bless 时就会重启)。
    const second = new Inbox({ path });
    assert.deepEqual(second.peek(10).map((m) => m.msgId), ["m2"], "已 ack 的不该复活");
    assert.equal(second.depth(), 1);
  });
});

test("inbox:重放保持入队顺序 —— 顺序本身是语义(图文那对靠它)", () => {
  withDir((dir) => {
    const path = join(dir, "p.jsonl");
    const first = new Inbox({ path });
    for (const id of ["m1", "m2", "m3", "m4"]) first.push(msg(id));
    first.ack(["m2"]);
    const second = new Inbox({ path });
    assert.deepEqual(second.peek(10).map((m) => m.msgId), ["m1", "m3", "m4"]);
  });
});

test("inbox:半截的最后一行只丢它自己,不丢整个队列", () => {
  // 进程被 SIGKILL 时最多丢一条没写完的行。让整个队列跟着读不出来,
  // 等于把一次崩溃升级成"这个人格积压的消息全没了"。
  withDir((dir) => {
    const path = join(dir, "p.jsonl");
    const first = new Inbox({ path });
    first.push(msg("m1"));
    first.push(msg("m2"));
    writeFileSync(path, `${readFileSync(path, "utf8")}{"t":"m","msgId":"m3"`, "utf8");

    const second = new Inbox({ path });
    assert.deepEqual(second.peek(10).map((m) => m.msgId), ["m1", "m2"]);
  });
});

test("inbox:重复 ack 不算「又消化了几条」", () => {
  withDir((dir) => {
    const box = new Inbox({ path: join(dir, "p.jsonl") });
    box.push(msg("m1"));
    assert.equal(box.ack(["m1"]), 1);
    assert.equal(box.ack(["m1"]), 0, "人格重试是正常现象,不该被记成消化了两条");
  });
});

test("inbox:溢出丢最旧的并计数 —— 静默丢弃在用户那边就是「发了没反应」", () => {
  withDir((dir) => {
    // 丢旧不丢新:堆到上限说明目标人格死了/卡了,那时最新几条才是用户正在说的话。
    const box = new Inbox({ path: join(dir, "p.jsonl"), maxBytes: 400 });
    for (let i = 0; i < 20; i++) box.push(msg(`m${i}`, "x".repeat(50)));
    assert.ok(box.droppedCount() > 0, "必须计数,不能静默");
    const ids = box.peek(100).map((m) => m.msgId);
    assert.equal(ids.at(-1), "m19", "最新的那条必须留着");
    assert.equal(ids.includes("m0"), false, "最旧的先走");
  });
});

test("inbox:日志长度有界 —— 不能因为长期运行而无限增长", () => {
  // 断言的是**有界**而不是"很小":压实每 COMPACT_EVERY 条出队才做一次,所以两次压实
  // 之间文件当然会涨。它要守的是"不随总处理量线性增长",否则跑几个月之后
  // 一次重启要重放几十万行 —— 而重启恰恰发生在最需要它快的时候。
  withDir((dir) => {
    const path = join(dir, "p.jsonl");
    const box = new Inbox({ path });
    const rounds = 2000;
    for (let i = 0; i < rounds; i++) {
      box.push(msg(`m${i}`));
      box.ack([`m${i}`]);
    }
    box.push(msg("last"));
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(
      lines.length < rounds / 2,
      `跑了 ${rounds} 轮,日志 ${lines.length} 行 —— 说明压实没起作用`,
    );
    assert.deepEqual(new Inbox({ path }).peek(10).map((m) => m.msgId), ["last"]);
  });
});

// ── 发送预算 ──────────────────────────────────────────────────────

test("预算:那笔账 —— 10 条总额,回执 1,保留 3,进度 6", () => {
  // 保留额从 4 降到 2 又回到 3。降是因为有了发件队列:发不出去的消息进队列等
  // 额度回来,"丢了"这件事本身没有了。回到 3 是因为**两句交代分不开**:
  // "进度就报到这儿"许诺答案还会来,而正文分段超过一段时答案恰恰来不了,
  // 那时用户需要的是"还有 N 条没发出去"。合用一格就必然有一次要撒谎,
  // 而撒谎的代价是用户干等着 —— 真机上静默过 14 分钟和 2 小时 24 分。
  //
  // **10 是实测值,而且复测过**:2026-08-12 放宽到 20 试了一次,当天就撞回来 ——
  // 两次记录都是恰好 10 条成功,第 11 条起 ret=-2 且永不恢复。这里钉死它,
  // 再往上调是一次有代价的实验,不该被顺手改掉。
  assert.equal(SEND_BUDGET, 10);
  assert.equal(MAX_PROGRESS_PER_TOKEN, 6);
  // 排空的余地必须跟着这笔账走,不能各写各的。
  assert.equal(LIVE_TURN_SENDS, SEND_BUDGET - MAX_PROGRESS_PER_TOKEN);
});

test("预算:进度撞上限之后,正文与那句续额提示仍然发得出去", () => {
  // 进度把额度吃光的话,最不能丢的那两条就一定发不出去 —— 而它们恰恰是
  // "答案"和"怎么把额度要回来"。别的类别不再各占一格:它们进发件队列,
  // 一条都不会少(见 outbox.ts)。
  withDir((dir) => {
    const store = new ReplyStore(join(dir, "ctx.json"), () => 1000);
    store.remember("u", "raw-u", "tok-1");
    assert.equal(store.begin("u", "ack").allowed, true);
    for (let i = 0; i < MAX_PROGRESS_PER_TOKEN; i++) {
      assert.equal(store.begin("u", "progress").allowed, true, `第 ${i + 1} 条进度`);
    }
    const over = store.begin("u", "progress");
    assert.equal(over.allowed, false);
    assert.match(over.reason ?? "", /进度额度/);

    assert.equal(store.begin("u", "body").allowed, true, "正文必须还发得出去");
    // 第二格:那句"进度报到头了,发 /nop 续上"的交代。它走 reminder 的额度 ——
    // 新开一种 kind 会让老信使(跑 pinned,版本天然更老)读不懂整个信封。
    assert.equal(store.begin("u", "reminder").allowed, true, "续额提示还有一格");
  });
});

test("预算:remainingSends 答的是「这个 token 还剩多少」,与进度余量分开", () => {
  // 发件队列问的是这一个:它要决定排空停在哪儿,而那与"进度还能推几条"无关。
  withDir((dir) => {
    const store = new ReplyStore(join(dir, "ctx.json"), () => 1000);
    assert.equal(store.remainingSends("u"), 0, "没有上下文时压根发不出去");
    store.remember("u", "raw-u", "tok-1");
    assert.equal(store.remainingSends("u"), SEND_BUDGET);
    for (let i = 0; i < MAX_PROGRESS_PER_TOKEN; i++) store.begin("u", "progress");
    assert.equal(store.remainingProgress("u"), 0, "进度用完了");
    assert.equal(
      store.remainingSends("u"),
      SEND_BUDGET - MAX_PROGRESS_PER_TOKEN,
      "但总额还剩保留的那几条 —— 队列据此判断还能不能排空",
    );
  });
});

test("预算:总额用尽之后连正文都拒绝 —— 那时再发只会撞上永不恢复的 ret=-2", () => {
  withDir((dir) => {
    const store = new ReplyStore(join(dir, "ctx.json"));
    store.remember("u", "raw-u", "tok-1");
    for (let i = 0; i < SEND_BUDGET; i++) store.begin("u", "body");
    const over = store.begin("u", "body");
    assert.equal(over.allowed, false);
    assert.match(over.reason ?? "", /预算/);
  });
});

test("预算:没有回复上下文时如实说发不出去 —— iLink 不支持主动推送", () => {
  withDir((dir) => {
    const store = new ReplyStore(join(dir, "ctx.json"));
    const p = store.begin("从没说过话的人", "reminder");
    assert.equal(p.allowed, false);
    assert.equal(p.remainingProgress, 0);
  });
});

test("预算:新来信换一份上下文并把计数归零", () => {
  withDir((dir) => {
    const store = new ReplyStore(join(dir, "ctx.json"));
    store.remember("u", "raw-u", "tok-1");
    for (let i = 0; i < MAX_PROGRESS_PER_TOKEN; i++) store.begin("u", "progress");
    assert.equal(store.remainingProgress("u"), 0);
    store.remember("u", "raw-u", "tok-2");
    assert.equal(store.remainingProgress("u"), MAX_PROGRESS_PER_TOKEN, "新来信带来新预算");
  });
});

test("预算:计数跨重启存活 —— 丢了就会超发,而超发不可恢复", () => {
  withDir((dir) => {
    const path = join(dir, "ctx.json");
    const first = new ReplyStore(path);
    first.remember("u", "raw-u", "tok-1");
    for (let i = 0; i < 4; i++) first.begin("u", "progress");

    const second = new ReplyStore(path);
    assert.equal(second.remainingProgress("u"), MAX_PROGRESS_PER_TOKEN - 4);
    assert.equal(second.get("u")?.contextToken, "tok-1", "上下文本身也要活下来");
  });
});

test("预算:盘上计数坏掉时按「已用满」处理,不是按 0", () => {
  // 记录坏了说明我们**不知道**发过几条。乐观地从 0 开始就会超发,而超发的后果是
  // 连正文都发不出去、用户彻底静默 —— 代价完全不对称,所以往保守一侧倒。
  withDir((dir) => {
    const path = join(dir, "ctx.json");
    writeFileSync(
      path,
      JSON.stringify({ u: { toUserId: "raw", contextToken: "tok", cachedAt: 1, sent: "坏的" } }),
    );
    const store = new ReplyStore(path);
    assert.equal(store.remainingProgress("u"), 0);
    assert.equal(store.begin("u", "body").allowed, false);
  });
});

test("预算:上下文文件是 0600 —— context_token 能代替用户发消息", () => {
  withDir((dir) => {
    const path = join(dir, "ctx.json");
    new ReplyStore(path).remember("u", "raw-u", "tok");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

test("预算:forget 之后不再拿旧 token 往新用户发信", () => {
  withDir((dir) => {
    const store = new ReplyStore(join(dir, "ctx.json"));
    store.remember("u", "raw-u", "tok");
    store.forget("u");
    assert.equal(store.get("u"), undefined);
    assert.equal(store.begin("u", "body").allowed, false);
  });
});

// ── spool ─────────────────────────────────────────────────────────

test("spool:写进去读得回来,引用带格式与字节数", () => {
  withDir((dir) => {
    const spool = new Spool({ dir: join(dir, "spool") });
    const ref = spool.put(new Uint8Array([1, 2, 3]), "image/png", () => "abc");
    assert.equal(ref.bytes, 3);
    assert.equal(ref.mediaType, "image/png");
    assert.deepEqual([...(spool.get(ref.id) ?? [])], [1, 2, 3]);
  });
});

test("spool:越界的 id 一律读不到 —— 这一层是真正做文件 IO 的地方", () => {
  withDir((dir) => {
    const spool = new Spool({ dir: join(dir, "spool") });
    writeFileSync(join(dir, "secret"), "不该被读到");
    for (const id of ["../secret", "a/b", "..", ""]) {
      assert.equal(spool.get(id), undefined, `id=${JSON.stringify(id)}`);
    }
  });
});

test("spool:drop 之后文件才消失 —— 提早删会让人格读到 ENOENT 而消息还在队列里", () => {
  withDir((dir) => {
    const spoolDir = join(dir, "spool");
    const spool = new Spool({ dir: spoolDir });
    const ref = spool.put(new Uint8Array([9]), "image/jpeg", () => "x");
    assert.ok(existsSync(join(spoolDir, ref.id)));
    spool.drop([ref.id]);
    assert.equal(existsSync(join(spoolDir, ref.id)), false);
    assert.equal(spool.get(ref.id), undefined);
  });
});

test("spool:开机扫除超龄孤儿 —— 被 SIGKILL 时没人删,残骸会一直占磁盘", () => {
  withDir((dir) => {
    const spoolDir = join(dir, "spool");
    const ref = new Spool({ dir: spoolDir }).put(new Uint8Array([1]), "image/png", () => "orphan");
    assert.ok(existsSync(join(spoolDir, ref.id)));

    // 假时钟必须**相对真实时间**推:判据是文件的 mtime,那是真墙钟,注入的钟管不着它。
    // 写成绝对小值(比如 now:()=>0)会让断言静默失效 —— 那种用例比没有更糟。
    const twoDaysLater = Date.now() + 48 * 60 * 60 * 1000;
    new Spool({ dir: spoolDir, now: () => twoDaysLater });
    assert.equal(existsSync(join(spoolDir, ref.id)), false);
  });
});

test("spool:开机扫除不碰新鲜的文件", () => {
  withDir((dir) => {
    const spoolDir = join(dir, "spool");
    const ref = new Spool({ dir: spoolDir }).put(new Uint8Array([1]), "image/png", () => "fresh");
    new Spool({ dir: spoolDir });
    assert.ok(existsSync(join(spoolDir, ref.id)), "队列里可能还挂着这条引用");
  });
});

test("预算:同一个 token 再 remember 一次**不重置计数** —— 重放会导致超发", () => {
  // 信使崩在"已入队、游标未落盘"之间时整批会重放,于是同一条来信的 context_token
  // 会被 remember 第二次。清零之后我们以为还有满额,继续发 —— 而超发的后果是
  // `ret=-2 prepare failed` 且永不恢复:连正文都发不出去,用户彻底静默。
  withDir((dir) => {
    const store = new ReplyStore(join(dir, "ctx.json"));
    store.remember("u", "raw-u", "tok-1");
    for (let i = 0; i < 4; i++) store.begin("u", "progress");
    assert.equal(store.remainingProgress("u"), MAX_PROGRESS_PER_TOKEN - 4);

    store.remember("u", "raw-u", "tok-1"); // 重放
    assert.equal(
      store.remainingProgress("u"),
      MAX_PROGRESS_PER_TOKEN - 4,
      "同一个 token 就是同一条来信,账不该被清掉",
    );
  });
});

test("预算:换了 token 才重置 —— 新来信本来就带新预算", () => {
  withDir((dir) => {
    const store = new ReplyStore(join(dir, "ctx.json"));
    store.remember("u", "raw-u", "tok-1");
    for (let i = 0; i < 4; i++) store.begin("u", "progress");
    store.remember("u", "raw-u", "tok-2");
    assert.equal(store.remainingProgress("u"), MAX_PROGRESS_PER_TOKEN);
  });
});

test("spool:总量超限时从最旧的开始删 —— 磁盘满会让 dockerd 全面异常,那时连回滚都做不了", () => {
  // 代价是刻意选的:被删掉的图片若还挂在队列里,人格读它会 ENOENT,而那条路径
  // 已经有兜底(跳过这一张、文字与其余图片照常投递)。退化成"少看一张图",
  // 比磁盘满小得多。
  withDir((dir) => {
    const spoolDir = join(dir, "spool");
    const spool = new Spool({ dir: spoolDir, maxTotalBytes: 300 });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(spool.put(new Uint8Array(100), "image/png", () => `f${i}`).id);
    }
    const alive = ids.filter((id) => spool.get(id));
    assert.ok(alive.length <= 3, `上限没生效,还剩 ${alive.length} 个`);
    assert.ok(spool.get(ids.at(-1)!), "最新的那个必须还在 —— 它多半正被引用");
  });
});

test("spool:sweep 可以被周期性调用,不只是开机那一次", () => {
  // 只在构造函数里扫的话,一个跑几周的稳定面等于从不清扫 ——
  // 而它恰恰是最不该把磁盘吃光的那个进程。
  withDir((dir) => {
    const spoolDir = join(dir, "spool");
    const spool = new Spool({ dir: spoolDir, maxTotalBytes: 150 });
    const a = spool.put(new Uint8Array(100), "image/png", () => "a");
    const b = spool.put(new Uint8Array(100), "image/png", () => "b");
    void b;
    spool.sweep();
    assert.equal(spool.get(a.id), undefined, "扫过之后最旧的该没了");
  });
});

test("inbox:溢出淘汰时把被丢的信封交出去 —— 否则它引用的图片字节永远没人清", () => {
  withDir((dir) => {
    const evicted: string[] = [];
    const box = new Inbox({
      path: join(dir, "p.jsonl"),
      maxBytes: 400,
      onEvict: (env) => evicted.push(env.msgId),
    });
    for (let i = 0; i < 20; i++) box.push(msg(`m${i}`, "x".repeat(50)));
    assert.ok(evicted.length > 0);
    assert.equal(evicted[0], "m0", "先丢最旧的");
    assert.equal(evicted.length, box.droppedCount(), "回调次数要与计数一致");
  });
});
