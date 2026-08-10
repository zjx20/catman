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
import type { IncomingMessage } from "../src/channels/types.js";

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
  bridge.onMessage(async (m) => {
    got.push(m);
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
    bridge.onMessage(async () => {
      order.push("deliver");
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
    bridge.onMessage(async (m) => {
      got.push(m);
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
    bridge.onMessage(async () => {
      order.push("deliver");
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

test("长回合期间照样拉取:控制帧不被投递挡住 —— detach 唯一该起作用的场景就是长回合", async () => {
  // 耦合版在这里必然失败:handler 等的是回合跑完,而 detach 要送到的正是那个回合。
  // 期间那一轮的正文照发,且没有出处前缀 —— 而 labelIfDetached 存在的理由就是它。
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [
      { messages: [msg("m1", "跑个长的")] },
      { controls: [{ schema: IPC_SCHEMA, type: "detach", userKey: "wechat:a:u1" }] },
    ];
    let releaseTurn: (() => void) | undefined;
    const detached: string[] = [];
    const bridge = new BridgeChannel({
      client: c,
      spoolDir: dir,
      onDetach: (u) => detached.push(u),
    });
    bridge.onMessage(
      () =>
        new Promise<void>((res) => {
          releaseTurn = res; // 模拟一个一直没跑完的回合
        }),
    );
    await bridge.start();
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(detached, ["wechat:a:u1"], "回合还没跑完,detach 就该已经应用了");
    releaseTurn?.();
    await bridge.stop();
  });
});

test("长回合期间 live 不该翻假 —— 它替换掉的 iLink 渠道没有这个耦合", async () => {
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [{ messages: [msg("m1", "跑个长的")] }];
    let releaseTurn: (() => void) | undefined;
    const bridge = new BridgeChannel({ client: c, spoolDir: dir });
    bridge.onMessage(
      () =>
        new Promise<void>((res) => {
          releaseTurn = res;
        }),
    );
    await bridge.start();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(bridge.health()[0]!.live, true, "拉取一直在继续,渠道当然是通的");
    releaseTurn?.();
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
    bridge.onMessage(async () => {
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
