import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompositeChannel, compositeAdmission } from "../src/channels/composite.js";
import { DashboardChannel, type ChatEvent } from "../src/channels/dashboard.js";
import { allowAll } from "../src/core/admission.js";
import { BUILTIN_ADMIN_USER_KEY, makeUserKey } from "../src/core/identity.js";
import { StdinChannel } from "../src/channels/stdin.js";
import { WechatILinkChannel } from "../src/channels/wechat-ilink.js";
import { WECHAT_CHANNEL } from "../src/channels/ilink-protocol.js";
import type { AccountStore } from "../src/core/accounts.js";
import type { Channel, MessageHandler } from "../src/channels/types.js";

class Fake implements Channel {
  sent: Array<{ userKey: string; text: string }> = [];
  recalled: string[] = [];
  started = 0;
  stopped = 0;
  handler?: MessageHandler;
  recall?: (userKey: string, messageId: string) => Promise<void>;

  constructor(
    readonly name: string,
    supportsRecall = false,
  ) {
    if (supportsRecall) {
      this.recall = async (_k, id) => {
        this.recalled.push(id);
      };
    }
  }
  onMessage(h: MessageHandler): void {
    this.handler = h;
  }
  async send(userKey: string, text: string): Promise<void> {
    this.sent.push({ userKey, text });
  }
  async start(): Promise<void> {
    this.started++;
  }
  async stop(): Promise<void> {
    this.stopped++;
  }
}

// --- CompositeChannel ---

test("按 userKey 的 channel 段路由 send", async () => {
  const a = new Fake("wechat");
  const b = new Fake("dashboard");
  const c = new CompositeChannel([a, b]);
  await c.send("wechat:acct:u1", "给微信的");
  await c.send("dashboard:admin:admin", "给面板的");
  assert.deepEqual(a.sent, [{ userKey: "wechat:acct:u1", text: "给微信的" }]);
  assert.deepEqual(b.sent, [{ userKey: "dashboard:admin:admin", text: "给面板的" }]);
});

test("未知渠道前缀报错,而不是发给随便某个渠道", async () => {
  const c = new CompositeChannel([new Fake("wechat")]);
  await assert.rejects(() => c.send("telegram:acct:u1", "x"), /没有能处理/);
  await assert.rejects(() => c.send("裸用户名", "x"), /没有能处理/);
});

test("start/stop 扇出到全部子渠道", async () => {
  const a = new Fake("wechat");
  const b = new Fake("dashboard");
  const c = new CompositeChannel([a, b]);
  await c.start();
  await c.stop();
  assert.equal(a.started, 1);
  assert.equal(b.started, 1);
  assert.equal(a.stopped, 1);
  assert.equal(b.stopped, 1);
});

test("onMessage 转发到全部子渠道", async () => {
  const a = new Fake("wechat");
  const b = new Fake("dashboard");
  const c = new CompositeChannel([a, b]);
  const got: string[] = [];
  c.onMessage(async (m) => {
    got.push(m.userKey);
  });
  await a.handler!({ userKey: "wechat:acct:u1", text: "x" });
  await b.handler!({ userKey: "dashboard:admin:admin", text: "y" });
  assert.deepEqual(got, ["wechat:acct:u1", "dashboard:admin:admin"]);
});

test("recall:任一子渠道支持就对外声明支持,并按 userKey 分派", async () => {
  const withRecall = new Fake("wechat", true);
  const without = new Fake("dashboard");
  const c = new CompositeChannel([withRecall, without]);
  assert.ok(c.recall, "网关按方法是否存在判断能力");
  await c.recall!("wechat:acct:u1", "msg-1");
  assert.deepEqual(withRecall.recalled, ["msg-1"]);
  // 不支持撤回的那一路要安静跳过,而不是抛错。
  await assert.doesNotReject(() => c.recall!("dashboard:admin:admin", "msg-2"));
});

test("全都不支持撤回时不声明该能力", () => {
  const c = new CompositeChannel([new Fake("wechat"), new Fake("dashboard")]);
  assert.equal(c.recall, undefined);
});

test("渠道名重复直接报错", () => {
  assert.throws(() => new CompositeChannel([new Fake("wechat"), new Fake("wechat")]), /重复/);
  assert.throws(() => new CompositeChannel([]), /至少需要一个/);
});

// --- compositeAdmission ---

test("准入按渠道分派;未登记的渠道一律拒绝", () => {
  const admission = compositeAdmission({
    dashboard: allowAll,
    wechat: () => ({ ok: false, reason: "没绑定" }),
  });
  assert.equal(admission("dashboard:admin:admin").ok, true);
  assert.equal(admission("wechat:acct:u1").ok, false);
  // 漏配应当表现为不工作,而不是没防护。
  const missing = admission("telegram:acct:u1");
  assert.equal(missing.ok, false);
  assert.match(missing.ok === false ? missing.reason : "", /没有配置准入策略/);
  assert.equal(admission("裸用户名").ok, false);
});

// --- DashboardChannel ---

const chatDirs: string[] = [];
/** 每个用例一个独立的记录文件,互不串味。 */
function chatPath(): string {
  const d = mkdtempSync(join(tmpdir(), "catman-chat-"));
  chatDirs.push(d);
  return join(d, "dashboard-chat.json");
}
test.after(() => {
  for (const d of chatDirs) rmSync(d, { recursive: true, force: true });
});

const mk = (over: { path?: string } = {}) => new DashboardChannel({ now: () => 1000, ...over });
/** 只关心正文的订阅者;删除事件记成 -<id>,便于一眼看出顺序。 */
const collect = (into: string[]) => (ev: ChatEvent) =>
  into.push(ev.type === "message" ? ev.msg.text : `-${ev.id}`);

test("无订阅者时 send 不抛错,消息进缓冲", async () => {
  // 浏览器刷新一下 SSE 就断了 —— 这时候抛错会把回复直接丢掉。
  const ch = mk();
  await assert.doesNotReject(() => ch.send(BUILTIN_ADMIN_USER_KEY, "回复"));
  assert.deepEqual(
    ch.history().map((m) => m.text),
    ["回复"],
  );
});

test("只服务内置管理员,发给别人直接报错", async () => {
  const ch = mk();
  await assert.rejects(() => ch.send("stdin:local:u1", "x"), /只服务/);
});

test("receive 把管理员的话回显进缓冲再交给网关", async () => {
  const ch = mk();
  const got: string[] = [];
  ch.onMessage(async (m) => {
    got.push(`${m.userKey}|${m.text}`);
  });
  await ch.receive("你好");
  assert.deepEqual(got, [`${BUILTIN_ADMIN_USER_KEY}|你好`]);
  assert.deepEqual(
    ch.history().map((m) => [m.role, m.text]),
    [["user", "你好"]],
  );
});

test("订阅先补发历史再接实时", async () => {
  const ch = mk();
  await ch.send(BUILTIN_ADMIN_USER_KEY, "一");
  await ch.send(BUILTIN_ADMIN_USER_KEY, "二");

  const seen: string[] = [];
  const off = ch.subscribe(collect(seen));
  assert.deepEqual(seen, ["一", "二"]);
  await ch.send(BUILTIN_ADMIN_USER_KEY, "三");
  assert.deepEqual(seen, ["一", "二", "三"]);
  off();
  await ch.send(BUILTIN_ADMIN_USER_KEY, "四");
  assert.equal(seen.length, 3, "退订后不再推送");
});

test("Last-Event-ID 只补发缺口,刷新页面不重不漏", async () => {
  const ch = mk();
  await ch.send(BUILTIN_ADMIN_USER_KEY, "一");
  await ch.send(BUILTIN_ADMIN_USER_KEY, "二");
  await ch.send(BUILTIN_ADMIN_USER_KEY, "三");

  const seen: string[] = [];
  ch.subscribe(collect(seen), 2); // 客户端已经收到 id<=2
  assert.deepEqual(seen, ["三"]);
});

test("环形缓冲有上限,老消息被挤掉但 id 继续递增", async () => {
  const ch = mk();
  for (let i = 1; i <= 250; i++) await ch.send(BUILTIN_ADMIN_USER_KEY, `m${i}`);
  const h = ch.history();
  assert.equal(h.length, 200);
  assert.equal(h[0]!.text, "m51");
  assert.equal(h[h.length - 1]!.id, 250, "id 单调递增,重连补发才对得上");
});

test("一个订阅者抛错不影响其它订阅者", async () => {
  const ch = mk();
  const seen: string[] = [];
  ch.subscribe(() => {
    throw new Error("boom");
  });
  ch.subscribe(collect(seen));
  await assert.doesNotReject(() => ch.send(BUILTIN_ADMIN_USER_KEY, "还是要送到"));
  assert.deepEqual(seen, ["还是要送到"]);
});

test("stop 清空订阅者", async () => {
  const ch = mk();
  const seen: string[] = [];
  ch.subscribe(collect(seen));
  await ch.stop();
  await ch.send(BUILTIN_ADMIN_USER_KEY, "关了之后");
  assert.deepEqual(seen, []);
});

test("聊天记录落盘:重启后仍在 —— 页面不会与助手记得的对不上", async () => {
  const path = chatPath();
  const first = mk({ path });
  await first.receive("你好");
  await first.send(BUILTIN_ADMIN_USER_KEY, "在的");

  // 新实例 = 进程重启。网页没有本地记录,这里丢了页面就是空白。
  const restarted = mk({ path });
  assert.deepEqual(
    restarted.history().map((m) => [m.role, m.text]),
    [
      ["user", "你好"],
      ["bot", "在的"],
    ],
  );
});

test("重启后 id 不重用,否则重连补发会对错位置", async () => {
  const path = chatPath();
  const first = mk({ path });
  await first.send(BUILTIN_ADMIN_USER_KEY, "一");
  await first.send(BUILTIN_ADMIN_USER_KEY, "二");

  const restarted = mk({ path });
  assert.equal(restarted.lastId(), 2);
  await restarted.send(BUILTIN_ADMIN_USER_KEY, "三");
  assert.equal(restarted.history().at(-1)!.id, 3);
});

test("撤回:回执从缓冲和盘上一起消失,并通知订阅者", async () => {
  const path = chatPath();
  const ch = mk({ path });
  const ackId = await ch.send(BUILTIN_ADMIN_USER_KEY, "收到,处理中…");
  await ch.send(BUILTIN_ADMIN_USER_KEY, "结果来了");

  const seen: string[] = [];
  ch.subscribe(collect(seen), 2);
  await ch.recall(BUILTIN_ADMIN_USER_KEY, ackId);

  assert.deepEqual(seen, [`-${ackId}`], "页面要收到删除事件才能把那条抹掉");
  assert.deepEqual(
    ch.history().map((m) => m.text),
    ["结果来了"],
  );
  // 不落盘的话,回执会在记录里永久留着 —— 每一轮攒一条。
  assert.deepEqual(
    mk({ path })
      .history()
      .map((m) => m.text),
    ["结果来了"],
  );
});

test("撤回末条后水位不回退 —— 否则订阅会把已推过的重发一遍", async () => {
  const ch = mk();
  await ch.send(BUILTIN_ADMIN_USER_KEY, "一");
  const last = await ch.send(BUILTIN_ADMIN_USER_KEY, "二");
  await ch.recall(BUILTIN_ADMIN_USER_KEY, last);
  assert.equal(ch.lastId(), 2);
});

test("撤回不存在的 id 是空操作,不抛错", async () => {
  const ch = mk();
  await ch.send(BUILTIN_ADMIN_USER_KEY, "一");
  await assert.doesNotReject(() => ch.recall(BUILTIN_ADMIN_USER_KEY, "999"));
  assert.equal(ch.history().length, 1);
});

test("记录文件损坏/被手改时丢掉坏条目,不影响启动", async () => {
  const path = chatPath();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, JSON.stringify({ seq: 7, messages: [{ id: 5, role: "bot" }, "垃圾", null] }));
  const ch = mk({ path });
  assert.deepEqual(ch.history(), [], "坏条目全丢掉");
  assert.equal(ch.lastId(), 7, "但 seq 还认,不重用已发过的 id");
});

// --- 渠道名必须能把回复路由回去 ---

/**
 * 收得到消息、发不出回复,是这个项目真机上踩过的坑:`Channel.name` 是
 * CompositeChannel 的路由键,而 userKey 的第一段是渠道自己拼的。两处写岔的话
 * 准入和入队全都正常,只有最后 send 那一步抛「没有能处理 X 的渠道」——
 * agent 已经跑完、额度已经花掉,用户那边则是彻底没反应。
 *
 * 所以这里守的是闭环:**拿该渠道真实产出的 userKey,必须能路由回该渠道**。
 */
test("每个渠道产出的 userKey 都能被 CompositeChannel 路由回自己", async () => {
  const limits = () => ({ maxImageBytes: 1_000_000, maxImagesPerTurn: 4 });
  const stdin = new StdinChannel(limits);
  const accounts = {
    list: () => [],
    onConnectionSetChanged: () => {},
  } as unknown as AccountStore;
  const wechat = new WechatILinkChannel(accounts, limits);

  const composite = new CompositeChannel([stdin, wechat]);

  // 各渠道真实使用的 userKey 形态(与 makeUserKey 的调用一致)。
  const samples: Array<[string, Channel]> = [
    [makeUserKey("stdin", "local", "local"), stdin],
    [makeUserKey(WECHAT_CHANNEL, "acc1", "o9cq80yCc7@im.wechat"), wechat],
  ];

  for (const [userKey, expected] of samples) {
    const routed = composite["route"](userKey);
    assert.equal(
      routed.name,
      expected.name,
      `${userKey} 应当路由到 ${expected.name},实际到了 ${routed.name}`,
    );
  }
});

test("路由不到时的报错要指出差在哪", () => {
  const limits = () => ({ maxImageBytes: 1_000_000, maxImagesPerTurn: 4 });
  const composite = new CompositeChannel([new StdinChannel(limits)]);
  assert.throws(
    () => composite["route"]("wechat:acc1:someone"),
    // 光说"没有能处理 X 的渠道"看不出是名字写岔了,真机上排查要绕很久。
    /需要名为 wechat 的渠道,已注册的是 stdin/,
  );
});
