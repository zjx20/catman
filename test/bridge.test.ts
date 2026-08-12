import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeChannel } from "../src/channels/bridge.js";
import { WECHAT_CHANNEL } from "../src/channels/ilink-protocol.js";
import {
  IPC_SCHEMA,
  parsePull,
  type ParsedPull,
  type SendKind,
  type SendResult,
} from "../src/ipc/protocol.js";

// 复用**真实**解析器:假信使给的是原始 JSON,与真信使经 HTTP 送来的形状一致。
// 自己拼 ParsedPull 的话,就把"解析器怎么对待坏信封"这件事从用例里挖掉了。
const parse = (raw: unknown): ParsedPull | undefined => parsePull(raw);
import type { CourierLink } from "../src/ipc/client.js";
import type { Accepted, IncomingMessage } from "../src/channels/types.js";

/** "收下了,而且这批也已经处理完" —— 不关心回合的用例用它。 */
const took: Accepted = { settled: Promise.resolve() };

/** 一个永远跑不完的回合:收下了,但 settled 悬着,直到调用返回的那个函数。 */
function stuckTurn(): { accepted: Accepted; finish: () => void } {
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => (finish = resolve));
  return { accepted: { settled }, finish };
}

/**
 * bridge 的**时序**。它是整条链路上最容易出微妙错误的一段,而每一种错误在用户
 * 那边都长得一样("发了没反应"或"回答了两遍"),所以这里逐条钉死。
 */

/** 可编排的假信使。按轮次给出拉取结果,记录 ack/nack/send。 */
class FakeCourier implements CourierLink {
  rounds: Array<{
    controls?: Array<{ schema: number; type: "detach"; userKey: string }>;
    messages?: Array<Record<string, unknown>>;
  }> = [];
  acked: string[][] = [];
  nacked: Array<{ ids: readonly string[]; reason: string }> = [];
  sent: Array<{ userKey: string; text: string; kind: SendKind }> = [];
  sendResult: SendResult = { schema: IPC_SCHEMA, ok: true, remainingProgress: 3 };
  private i = 0;
  /** 从第几轮起挂住,直到 release() —— 用来精确摆出"重复在什么时候到达"。 */
  holdFrom = Number.POSITIVE_INFINITY;
  private gate?: () => void;
  release(): void {
    this.gate?.();
    this.gate = undefined;
    this.holdFrom = Number.POSITIVE_INFINITY;
  }

  async pull(): Promise<ParsedPull | undefined> {
    if (this.i >= this.holdFrom) {
      await new Promise<void>((res) => {
        this.gate = res;
      });
    }
    const r = this.rounds[this.i];
    this.i += 1;
    if (!r) {
      // 没有更多剧本了:挂一会儿,免得 while 循环空转打爆 CPU。
      await new Promise((res) => setTimeout(res, 20));
      return parse({ controls: [], messages: [] });
    }
    return parse({ controls: r.controls ?? [], messages: r.messages ?? [] });
  }
  async ack(msgIds: readonly string[]): Promise<void> {
    this.acked.push([...msgIds]);
  }
  async nack(msgIds: readonly string[], reason: string): Promise<void> {
    this.nacked.push({ ids: [...msgIds], reason });
  }
  async send(userKey: string, text: string, kind: SendKind): Promise<SendResult> {
    this.sent.push({ userKey, text, kind });
    return this.sendResult;
  }
}


function msg(id: string, text: string, refs: unknown[] = []): Record<string, unknown> {
  return {
    schema: IPC_SCHEMA,
    msgId: id,
    userKey: "wechat:a:u1",
    text,
    attachmentRefs: refs,
    greeted: true,
    ts: 1,
  };
}

/** 起 bridge,跑到收到 want 条消息(或超时),然后停掉。 */
async function run(
  courier: FakeCourier,
  spoolDir: string,
  want: number,
  onDetach?: (userKey: string) => void,
): Promise<IncomingMessage[]> {
  const got: IncomingMessage[] = [];
  const bridge = new BridgeChannel({
    client: courier,
    spoolDir,
    ...(onDetach ? { onDetach } : {}),
  });
  bridge.onMessage((m) => {
    got.push(m);
    return took;
  });
  await bridge.start();
  const deadline = Date.now() + 2000;
  while (got.length < want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  // 再多等一轮,好让 ack/nack 这些收尾动作也跑完。
  await new Promise((r) => setTimeout(r, 40));
  await bridge.stop();
  return got;
}

function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "catman-bridge-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("渠道名必须与 userKey 第一段一致 —— 写岔的话只有最后 send 那步会炸", async () => {
  // 真机踩过:准入、入队、agent 全都正常,额度已经花掉,而用户那边彻底没反应。
  await withDir(async (dir) => {
    const b = new BridgeChannel({ client: new FakeCourier(), spoolDir: dir });
    assert.equal(b.name, WECHAT_CHANNEL);
    assert.equal(msg("m", "x")["userKey"]!.toString().split(":")[0], b.name);
  });
});

test("**落进批之后才 ack** —— 提前 ack 时进程在聚合窗口里被杀就是真丢", async () => {
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [{ messages: [msg("m1", "喂")] }];
    const order: string[] = [];
    const bridge = new BridgeChannel({ client: c, spoolDir: dir });
    bridge.onMessage(() => {
      order.push("deliver");
      return took;
    });
    const origAck = c.ack.bind(c);
    c.ack = async (ids) => {
      order.push("ack");
      await origAck(ids);
    };
    await bridge.start();
    await new Promise((r) => setTimeout(r, 120));
    await bridge.stop();
    assert.deepEqual(order, ["deliver", "ack"]);
  });
});

test("同步逐条投递 —— 「图 + 文字」那 120ms 的一对靠它保持先后", async () => {
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [{ messages: [msg("m1", "先"), msg("m2", "中"), msg("m3", "后")] }];
    const got = await run(c, dir, 3);
    assert.deepEqual(got.map((m) => m.text), ["先", "中", "后"]);
    assert.deepEqual(c.acked.flat(), ["m1", "m2", "m3"]);
  });
});

test("重复在原件还排队时到达:直接忽略,不重复投也不重复 ack", async () => {
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [{ messages: [msg("m1", "喂")] }, { messages: [msg("m1", "喂")] }];
    const got = await run(c, dir, 1);
    assert.equal(got.length, 1);
    assert.equal(c.acked.flat().filter((x) => x === "m1").length, 1);
  });
});

test("重复在投递完成之后到达:**必须补 ack** —— 不出队就把整条队列钉死", async () => {
  // 信使还把它送来,说明上次的 ack 没生效(信使重启、网络抖动)。它是队头,
  // 不出队的话所有人的后续消息都堵在它后面,而且没有任何一轮会再动它。
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [{ messages: [msg("m1", "喂")] }, { messages: [msg("m1", "喂")] }];
    c.holdFrom = 1; // 第二轮挂住,等第一条投完再放行
    const got: unknown[] = [];
    const bridge = new BridgeChannel({ client: c, spoolDir: dir });
    bridge.onMessage((m) => {
      got.push(m);
      return took;
    });
    await bridge.start();
    while (!c.acked.flat().includes("m1")) await new Promise((r) => setTimeout(r, 10));
    c.release();
    await new Promise((r) => setTimeout(r, 120));
    await bridge.stop();
    assert.equal(got.length, 1, "不能再投一次");
    assert.equal(c.acked.flat().filter((x) => x === "m1").length, 2, "必须补 ack");
  });
});

test("greeted 标记要一路透传到网关 —— 信使算了没人消费等于没算", async () => {
  // 判定权在信使:它是唯一见过某个 userKey 全部历史的进程。bridge 把这个字段丢掉的话,
  // 人格照旧问自己那份 users.json,于是用户每切一次人格就吃一整份欢迎语,
  // 白烧一条发送预算(一个 context_token 只够发约 10 条)。
  const c = new FakeCourier();
  const dir = mkdtempSync(join(tmpdir(), "catman-bridge-greeted-"));
  try {
    c.rounds = [{ messages: [msg("g1", "你好")] }];
    const got = await run(c, dir, 1);
    assert.equal(got[0]!.greeted, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("控制帧先于消息应用 —— 后面那批不该落进一个刚被切走的会话", async () => {
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [
      {
        controls: [{ schema: IPC_SCHEMA, type: "detach", userKey: "wechat:a:u1" }],
        messages: [msg("m1", "喂")],
      },
    ];
    const order: string[] = [];
    const bridge = new BridgeChannel({
      client: c,
      spoolDir: dir,
      onDetach: () => order.push("detach"),
    });
    bridge.onMessage(() => {
      order.push("deliver");
      return took;
    });
    await bridge.start();
    await new Promise((r) => setTimeout(r, 120));
    await bridge.stop();
    assert.deepEqual(order, ["detach", "deliver"]);
  });
});

test("读不懂的单条要 NACK 亮红灯,不能静默丢", async () => {
  // 契约漂移的表现必须看得见 —— 静默丢弃会让它变成"消息神秘消失"。
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [{ messages: [{ msgId: "bad-1", userKey: "" }, msg("m1", "好的")] }];
    const got = await run(c, dir, 1);
    assert.deepEqual(got.map((m) => m.text), ["好的"], "好的那条照常投递");
    assert.deepEqual(c.nacked[0]?.ids, ["bad-1"]);
  });
});

test("附件按引用读回来;读不到只跳过那一张,文字照常投递", async () => {
  await withDir(async (dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a1.bin"), Buffer.from([1, 2, 3]));
    const c = new FakeCourier();
    c.rounds = [
      {
        messages: [
          msg("m1", "看图", [
            { id: "a1.bin", mediaType: "image/png", bytes: 3 },
            { id: "没有这个.bin", mediaType: "image/png", bytes: 9 },
          ]),
        ],
      },
    ];
    const got = await run(c, dir, 1);
    assert.equal(got[0]!.text, "看图");
    assert.equal(got[0]!.attachments?.length, 1);
    assert.equal(got[0]!.attachments![0]!.data, Buffer.from([1, 2, 3]).toString("base64"));
  });
});

test("交出去就算数:信使回 ok 就不再多问一句余量", async () => {
  // 从前这里缓存 remainingProgress 转给网关的节流器用 —— 那是"核心也得懂一点预算"
  // 的最后一块。现在额度整个归渠道那一侧:发得出去信使就发,发不出去它排队,
  // 两种都回 ok。核心只管把消息交出去。
  const c = new FakeCourier();
  const dir = mkdtempSync(join(tmpdir(), "catman-bridge-budget-"));
  try {
    const bridge = new BridgeChannel({ client: c, spoolDir: dir });
    c.sendResult = { schema: IPC_SCHEMA, ok: true, remainingProgress: 0 };
    // 余量报 0 也照发不误:那是信使的账,它自己会决定发还是排队。
    await bridge.send("wechat:a:u1", "第一条", "progress");
    await bridge.send("wechat:a:u1", "第二条", "progress");
    assert.equal(c.sent.length, 2, "不该有任何一条被人格自己挡下来");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("信使回 ok:false 才抛 —— 那是信封读不懂、路由切走、信使不可达这类真的坏事", async () => {
  const c = new FakeCourier();
  const dir = mkdtempSync(join(tmpdir(), "catman-bridge-budget2-"));
  try {
    const bridge = new BridgeChannel({ client: c, spoolDir: dir });
    c.sendResult = {
      schema: IPC_SCHEMA,
      ok: false,
      remainingProgress: 0,
      reason: "这个用户已经切到别的人格了",
    };
    await assert.rejects(
      () => bridge.send("wechat:a:u1", "一条", "progress"),
      /切到别的人格/,
      "拒绝的理由要原样抛给调用方",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("send 把 kind 原样交给信使 —— 预算是按它算的", async () => {
  await withDir(async (dir) => {
    const c = new FakeCourier();
    const b = new BridgeChannel({ client: c, spoolDir: dir });
    await b.send("wechat:a:u1", "在跑了", "progress");
    assert.deepEqual(c.sent, [{ userKey: "wechat:a:u1", text: "在跑了", kind: "progress" }]);
  });
});

test("信使拒绝发送时要抛 —— 网关据此判「这条没发出去」并记日志", async () => {
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.sendResult = { schema: IPC_SCHEMA, ok: false, remainingProgress: 0, reason: "预算用尽" };
    const b = new BridgeChannel({ client: c, spoolDir: dir });
    await assert.rejects(() => b.send("wechat:a:u1", "喂", "body"), /预算用尽/);
  });
});

test("没拉取成功过就不算 live —— 「已启动」不等于「收得到消息」", async () => {
  await withDir(async (dir) => {
    const b = new BridgeChannel({ client: new FakeCourier(), spoolDir: dir });
    assert.deepEqual(b.health(), [{ name: WECHAT_CHANNEL, started: false, live: false }]);
    await b.start();
    assert.equal(b.health()[0]!.started, true);
    await b.stop();
  });
});

test("长回合期间**照样投递** —— 中途插话的消息必须在那一轮还跑着的时候送到网关", async () => {
  // 这是"插话"整条链路上唯一没被守住的一段,而它坏了整整一个版本:
  // 拉取早就拆出去了,投递却还在 `await handler(...)` 上等回合跑完,于是
  //   ① 网关的追加通道(AgentFeed)只在消息够不到的时间里开着 —— 真机日志里
  //      「追加输入」一行都没有;
  //   ② 微信「图 + 文字」那 120ms 的第二条也进不来,1.5 秒的聚合窗口只等到它自己。
  // 用户那边两种都长成同一副样子:说了等于没说,得干等它跑完。
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [{ messages: [msg("m1", "帮我改那个脚本")] }, { messages: [msg("m2", "等下,用 sed")] }];
    const turn = stuckTurn(); // 第一条起的回合一直没跑完
    const got: string[] = [];
    const bridge = new BridgeChannel({ client: c, spoolDir: dir });
    bridge.onMessage((m) => {
      got.push(m.text);
      // 第一条起回合(settled 悬着),后面的是追加进去的,当场就算处理完。
      return got.length === 1 ? turn.accepted : took;
    });
    await bridge.start();
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(got, ["帮我改那个脚本", "等下,用 sed"], "插话必须在回合还跑着时就送到");
    assert.ok(!c.acked.flat().includes("m1"), "起回合的那条要等回合跑完才 ack");
    assert.ok(c.acked.flat().includes("m2"), "追加那条已经处理完,该 ack 了");
    turn.finish();
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(c.acked.flat().includes("m1"), "回合跑完之后才补上它的 ack");
    await bridge.stop();
  });
});

test("回合还没跑完时重复拉到同一条:不重投也不提前 ack —— ack 是它跑完的凭据", async () => {
  // ack 延后到 settled 才有意义:这段时间里信使会反复送来同一条(它还没出队),
  // 走 `seen` 的补 ack 分支就等于替一个没跑完的回合提前签收。
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [{ messages: [msg("m1", "跑个长的")] }, { messages: [msg("m1", "跑个长的")] }];
    const turn = stuckTurn();
    let delivered = 0;
    const bridge = new BridgeChannel({ client: c, spoolDir: dir });
    bridge.onMessage(() => {
      delivered += 1;
      return turn.accepted;
    });
    await bridge.start();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(delivered, 1, "同一条不能投两次");
    assert.deepEqual(c.acked.flat(), [], "回合没跑完,一次都不该 ack");
    turn.finish();
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(c.acked.flat(), ["m1"]);
    await bridge.stop();
  });
});

test("关停前把已跑完那些回合的 ack 补上 —— 漏掉就是重启后同一句话被回答两遍", async () => {
  // ack 从投递链上摘下来之后就不在 `delivering` 里了,stop() 不额外等的话,
  // 一条"回合跑完、只差 ack 那一下"的消息会留在信使队列里被重放。
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [{ messages: [msg("m1", "喂")] }];
    const turn = stuckTurn();
    const origAck = c.ack.bind(c);
    c.ack = async (ids) => {
      await new Promise((r) => setTimeout(r, 50)); // ack 本身也要一小会儿
      await origAck(ids);
    };
    const bridge = new BridgeChannel({ client: c, spoolDir: dir });
    bridge.onMessage(() => turn.accepted);
    await bridge.start();
    await new Promise((r) => setTimeout(r, 100));
    turn.finish(); // 回合刚跑完,ack 还在路上
    await bridge.stop();
    assert.deepEqual(c.acked.flat(), ["m1"], "stop() 返回之前 ack 必须落地");
  });
});

test("长回合期间照样拉取:控制帧不被投递挡住 —— detach 唯一该起作用的场景就是长回合", async () => {
  // 耦合版在这里必然失败:handler 等的是回合跑完,而 detach 要送到的正是那个回合。
  // 期间那一轮的正文照发,且没有出处前缀 —— 而 labelIfDetached 存在的理由就是它。
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [
      { messages: [msg("m1", "跑个长的")] },
      { controls: [{ schema: IPC_SCHEMA, type: "detach", userKey: "wechat:a:u1" }] },
    ];
    const turn = stuckTurn(); // 一个一直没跑完的回合
    const detached: string[] = [];
    const bridge = new BridgeChannel({
      client: c,
      spoolDir: dir,
      onDetach: (u) => detached.push(u),
    });
    bridge.onMessage(() => turn.accepted);
    await bridge.start();
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(detached, ["wechat:a:u1"], "回合还没跑完,detach 就该已经应用了");
    turn.finish();
    await bridge.stop();
  });
});

test("长回合期间 live 不该翻假 —— 它替换掉的 iLink 渠道没有这个耦合", async () => {
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [{ messages: [msg("m1", "跑个长的")] }];
    const turn = stuckTurn();
    const bridge = new BridgeChannel({ client: c, spoolDir: dir });
    bridge.onMessage(() => turn.accepted);
    await bridge.start();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(bridge.health()[0]!.live, true, "拉取一直在继续,渠道当然是通的");
    turn.finish();
    await bridge.stop();
  });
});

test("投递一直失败时要退避并最终交回信使 —— 否则是每秒上万次的热循环", async () => {
  // 实测过:原先只 break,不 ack 不 nack 不退避,而信使在队列非空时立刻返回,
  // 两者相乘就是两万次/秒 —— 软路由上 CPU 打满、日志把轮转刷穿,
  // 而且单 inbox 意味着所有用户的后续消息全堵在这一条后面。
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [{ messages: [msg("m1", "毒")] }];
    let tries = 0;
    const bridge = new BridgeChannel({ client: c, spoolDir: dir });
    bridge.onMessage(() => {
      tries += 1;
      throw new Error("投不下去");
    });
    await bridge.start();
    await new Promise((r) => setTimeout(r, 1600));
    await bridge.stop();
    assert.ok(tries <= 6, `1.6 秒内试了 ${tries} 次 —— 没有退避`);
    assert.deepEqual(c.nacked.at(-1)?.ids, ["m1"], "撞上限之后要交回信使,给它让位");
    assert.equal(bridge.poisonedCount, 1);
  });
});
