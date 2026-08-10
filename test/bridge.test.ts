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

  async pull(): Promise<ParsedPull | undefined> {
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

test("重复投递被认出来直接跳过 —— 否则用户会看到同一句话被回答两次", async () => {
  // at-least-once 的正常代价:信使崩在"已入队、游标未落盘"之间时整批会重放。
  await withDir(async (dir) => {
    const c = new FakeCourier();
    c.rounds = [{ messages: [msg("m1", "喂")] }, { messages: [msg("m1", "喂")] }];
    const got = await run(c, dir, 1);
    assert.equal(got.length, 1);
    // 重复的那条仍然要 ack —— 不 ack 的话它会一直卡在信使队列头上。
    assert.equal(c.acked.flat().filter((x) => x === "m1").length, 2);
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
