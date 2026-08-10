import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  ILinkConnection,
  formatTrace,
  formatSendDiag,
  type ConnectionHooks,
} from "../src/channels/ilink-connection.js";
import type { AttachmentLimits } from "../src/core/attachments.js";
import type { Account } from "../src/core/accounts.js";
import type { Attachment } from "../src/core/attachments.js";
import { FakeReplies } from "./helpers/replies.js";

/**
 * iLink 图片入站:item_list 里 type=2 的条目要被下载、解密、还原成附件。
 *
 * 这条路径以前整个不存在 —— 旧实现只 filter type===1,图片连同它所在的消息
 * 一起被静默丢弃。这里直接驱动私有的 dispatch(与 gateway.test.ts 同样的做法),
 * 避开长轮询循环。
 */

const ACCOUNT: Account = {
  accountId: "acc1",
  botToken: "tok",
  displayName: "test",
  createdAt: 0,
} as Account;

/** 测试用的上限。真实默认值在 SETTING_SCHEMA 里,这里只要一个稳定的已知值。 */
const LIMITS: AttachmentLimits = { maxImageBytes: 3_500_000, maxImagesPerTurn: 4 };

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 3),
]);

function encrypt(plain: Buffer, key: Buffer): Buffer {
  const c = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([c.update(plain), c.final()]);
}

interface Received {
  userKey: string;
  text: string;
  attachments: readonly Attachment[];
}

/** 造一条入站消息 + 收集器。 */
function setup(hooks?: ConnectionHooks) {
  const got: Received[] = [];
  const conn = new ILinkConnection(
    ACCOUNT,
    (msg) => {
      got.push({ userKey: msg.userKey, text: msg.text, attachments: msg.attachments });
    },
    () => LIMITS,
    new FakeReplies(),
    hooks ?? {},
  );
  return { conn, got };
}


function imageItem(media: Record<string, unknown>, aeskeyHex?: string) {
  return {
    type: 2,
    image_item: { ...(aeskeyHex ? { aeskey: aeskeyHex } : {}), media },
  };
}

function textItem(text: string) {
  return { type: 1, text_item: { text } };
}

/** 把 fetch 换成:CDN 下载返回给定字节,其余(sendmessage 等)一律返回空 JSON。 */
function mockFetch(t: { mock: { method: typeof import("node:test").mock.method } }, body: Buffer) {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("cdn") || url.includes("download")) {
      return new Response(body, { status: 200 });
    }
    return new Response(JSON.stringify({ ret: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

test("type=2 的图片被下载解密成附件,文字照常带上", async (t) => {
  const key = randomBytes(16);
  mockFetch(t, encrypt(PNG, key));
  const { conn, got } = setup();

  await conn["dispatch"]({
    from_user_id: "u1",
    context_token: "ctx",
    item_list: [
      imageItem({ full_url: "https://cdn.example/a", aes_key: key.toString("base64") }),
      textItem("这是什么?"),
    ],
  });

  assert.equal(got.length, 1);
  assert.equal(got[0]!.userKey, "wechat:acc1:u1");
  assert.equal(got[0]!.text, "这是什么?");
  assert.equal(got[0]!.attachments.length, 1);
  assert.equal(got[0]!.attachments[0]!.mediaType, "image/png");
  assert.deepEqual(Buffer.from(got[0]!.attachments[0]!.data, "base64"), PNG);
});

test("image_item.aeskey(hex)优先于 media.aes_key,且被正确转码", async (t) => {
  // 两处 key 编码不同:aeskey 是 hex,media.aes_key 是 base64。
  // 弄混的话解出来是乱码 —— 乱码过不了图片格式嗅探,附件会整个消失。
  const key = randomBytes(16);
  mockFetch(t, encrypt(PNG, key));
  const { conn, got } = setup();

  await conn["dispatch"]({
    from_user_id: "u1",
    item_list: [
      imageItem(
        { full_url: "https://cdn.example/a", aes_key: randomBytes(16).toString("base64") },
        key.toString("hex"),
      ),
    ],
  });

  assert.equal(got.length, 1, "hex key 应当被优先采用并成功解密");
  assert.equal(got[0]!.attachments.length, 1);
});

test("只发图不发字也会投递(text 为空串)", async (t) => {
  const key = randomBytes(16);
  mockFetch(t, encrypt(PNG, key));
  const { conn, got } = setup();

  await conn["dispatch"]({
    from_user_id: "u1",
    item_list: [imageItem({ full_url: "https://cdn.example/a", aes_key: key.toString("base64") })],
  });

  assert.equal(got.length, 1);
  assert.equal(got[0]!.text, "");
  assert.equal(got[0]!.attachments.length, 1);
});

test("图片下载失败时,消息里的文字仍然投递出去", async (t) => {
  // 整条消息因为一张图挂掉而消失,对用户来说就是"发了没反应"。
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    if (String(input).includes("cdn")) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ ret: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const { conn, got } = setup();

  await conn["dispatch"]({
    from_user_id: "u1",
    context_token: "ctx",
    item_list: [imageItem({ full_url: "https://cdn.example/a" }), textItem("看看这个")],
  });

  assert.equal(got.length, 1, "文字部分不该被连累");
  assert.equal(got[0]!.text, "看看这个");
  assert.equal(got[0]!.attachments.length, 0);
});

test("图片全部失败且没有文字时不投递空消息", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    if (String(input).includes("cdn")) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ ret: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const { conn, got } = setup();

  await conn["dispatch"]({
    from_user_id: "u1",
    context_token: "ctx",
    item_list: [imageItem({ full_url: "https://cdn.example/a" })],
  });

  assert.equal(got.length, 0, "没内容就不该起一个回合");
});

test("解出来不是图片的字节被拒,不当附件塞给模型", async (t) => {
  // CDN 给了东西、解密也没报错,但内容不是图片(key 错、或者根本不是图)。
  const key = randomBytes(16);
  mockFetch(t, encrypt(Buffer.from("这不是图片的字节", "utf8"), key));
  const { conn, got } = setup();

  await conn["dispatch"]({
    from_user_id: "u1",
    context_token: "ctx",
    item_list: [
      imageItem({ full_url: "https://cdn.example/a", aes_key: key.toString("base64") }),
      textItem("附言"),
    ],
  });

  assert.equal(got[0]!.attachments.length, 0);
  assert.equal(got[0]!.text, "附言");
});

test("超过上限的图片被跳过,不是整条消息失败", async (t) => {
  const key = randomBytes(16);
  mockFetch(t, encrypt(PNG, key));
  const { conn, got } = setup();
  const media = { full_url: "https://cdn.example/a", aes_key: key.toString("base64") };

  await conn["dispatch"]({
    from_user_id: "u1",
    context_token: "ctx",
    item_list: [
      ...Array.from({ length: LIMITS.maxImagesPerTurn + 3 }, () => imageItem(media)),
      textItem("一堆图"),
    ],
  });

  assert.equal(got.length, 1);
  assert.equal(got[0]!.attachments.length, LIMITS.maxImagesPerTurn);
  assert.equal(got[0]!.text, "一堆图");
});

test("过大的图片被拒收,不会内联进回合", async (t) => {
  const key = randomBytes(16);
  const huge = Buffer.concat([PNG, Buffer.alloc(LIMITS.maxImageBytes)]);
  mockFetch(t, encrypt(huge, key));
  const { conn, got } = setup();

  await conn["dispatch"]({
    from_user_id: "u1",
    context_token: "ctx",
    item_list: [
      imageItem({ full_url: "https://cdn.example/a", aes_key: key.toString("base64") }),
      textItem("大图"),
    ],
  });

  assert.equal(got[0]!.attachments.length, 0);
});

test("BOT 自己发的消息不回环处理", async (t) => {
  mockFetch(t, PNG);
  const { conn, got } = setup();
  await conn["dispatch"]({
    from_user_id: "bot@im.bot",
    item_list: [imageItem({ full_url: "https://cdn.example/a" })],
  });
  await conn["dispatch"]({
    from_user_id: "u1",
    message_type: 2,
    item_list: [imageItem({ full_url: "https://cdn.example/a" })],
  });
  assert.equal(got.length, 0);
});

test("纯文本消息完全不碰 CDN", async (t) => {
  const calls = mockFetch(t, PNG);
  const { conn, got } = setup();
  await conn["dispatch"]({ from_user_id: "u1", item_list: [textItem("只有文字")] });
  assert.equal(got.length, 1);
  assert.equal(got[0]!.attachments.length, 0);
  assert.deepEqual(calls, [], "没有图片时不该发起任何请求");
});

test("没有可下载地址的图片 item 被忽略,不发无意义的请求", async (t) => {
  const calls = mockFetch(t, PNG);
  const { conn, got } = setup();
  await conn["dispatch"]({
    from_user_id: "u1",
    item_list: [{ type: 2, image_item: {} }, textItem("附言")],
  });
  assert.equal(got[0]!.text, "附言");
  assert.equal(got[0]!.attachments.length, 0);
  assert.deepEqual(calls, []);
});

test("图片条目取不到下载信息时留下日志线索,而不是无声无息", async (t) => {
  // 真机字段名尚未校准:静默忽略的话,"发了图没反应"在日志里一点痕迹都没有。
  const warns: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  });
  mockFetch(t, PNG);
  const { conn, got } = setup();

  await conn["dispatch"]({
    from_user_id: "u1",
    item_list: [
      // 故意用一个类型里没有的字段名:模拟真机字段与我们的假设对不上。
      { type: 2, image_item: { some_unexpected_field: "x" } as Record<string, string> },
      textItem("附言"),
    ],
  });

  assert.equal(got[0]!.attachments.length, 0);
  const hit = warns.find((w) => w.includes("取不到下载信息"));
  assert.ok(hit, `应当有一条提示,实际:${JSON.stringify(warns)}`);
  // 字段名要出现在日志里 —— 这正是校准时需要看到的东西。
  assert.ok(hit.includes("some_unexpected_field"), hit);
  // 但不能把值打出去(aeskey 是媒体密钥)。
  assert.ok(!hit.includes('"x"'), hit);
});

test("协议追踪:候选聚合键全部出现,密钥与 base64 只出现键名", () => {
  // 这是唯一会把协议原始内容写进日志的地方。少打一个候选键,真机上就得让用户
  // 重发一轮才能拿到答案;多打一个值,媒体密钥就进了日志。
  const line = formatTrace({
    from_user_id: "u1",
    seq: 42,
    message_id: 7,
    message_state: 2,
    session_id: "sess-abc",
    run_id: "run-xyz",
    client_id: "cli-1",
    create_time_ms: 1000,
    update_time_ms: 2000,
    item_list: [
      {
        type: 2,
        is_completed: false,
        image_item: {
          aeskey: "deadbeefdeadbeefdeadbeefdeadbeef",
          media: { full_url: "u", aes_key: "SECRETKEYVALUE==" },
        },
      },
      { type: 1, text_item: { text: "你好" } },
    ],
  });

  for (const key of ["seq=42", "msgId=7", "state=2", "sess=sess-abc", "run=run-xyz",
                     "client=cli-1", "ctime=1000", "utime=2000", "completed=false"]) {
    assert.ok(line.includes(key), `TRACE 少了 ${key}:${line}`);
  }
  // 键名要有(校准字段名靠它),值不能有。
  assert.ok(line.includes("aeskey"), line);
  assert.ok(!line.includes("deadbeef"), `aeskey 的值泄漏了:${line}`);
  assert.ok(!line.includes("SECRETKEYVALUE"), `aes_key 的值泄漏了:${line}`);
  assert.ok(line.includes("text(2字)"), `文本应只报长度:${line}`);
});

test("发送诊断:三个判别量齐全,且不带回复正文", () => {
  // sendmessage 失败时要靠这一行分清「限流 / context_token 过期 / 同 token 只能回一条」。
  // 少一个量就分不出来,而多打正文就等于把会话内容写进了日志。
  const secret = "这是回复正文,不该出现在日志里";
  const line = formatSendDiag(3, 2, 45_000, secret.length, "失败 ret=-2 prepare failed");

  assert.ok(line.includes("#3"), `缺第几次:${line}`);
  assert.ok(line.includes("2"), `缺已成功条数:${line}`);
  assert.ok(line.includes("45000ms"), `缺 context_token 龄:${line}`);
  assert.ok(line.includes(`${secret.length}字`), `缺长度:${line}`);
  assert.ok(line.includes("ret=-2"), `缺服务端错误:${line}`);
  assert.ok(!line.includes(secret), `正文泄漏了:${line}`);
});

// --- 重新扫码:换了对端标识仍落回原来那个 userKey ---

/**
 * 重新扫码换了一份 bot 凭据后,同一个人的 from_user_id 是否照旧由 iLink 决定。
 * 变了的话,userKey 的第三段就变了 —— 那位用户会以新人的身份进来,会话、工作目录、
 * 个人配置全都对不上。归一化这一步就是为了消除这个差别。
 */
test("拼 userKey 前先归一化 from_user_id,但回信仍发给原始标识", async (t) => {
  const calls = mockFetch(t, Buffer.alloc(0));
  const { conn, got } = setup({
    canonicalUserId: (raw) => (raw === "new@im.wechat" ? "old@im.wechat" : raw),
  });

  await conn["dispatch"]({
    from_user_id: "new@im.wechat",
    context_token: "ctx",
    item_list: [textItem("在吗")],
  });

  assert.equal(got[0]!.userKey, "wechat:acc1:old@im.wechat", "会话与工作目录靠这一段接上");

  // 归一只服务于我们自己的身份体系:发回去必须用协议认得的那个标识,
  // 否则消息投不到人 —— 而 replyCtx 是按归一后的 userKey 存的,最容易在这里写岔。
  calls.length = 0;
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    return new Response(JSON.stringify({ ret: 0 }), {
      headers: { "content-type": "application/json" },
    });
  });
  await conn.send("wechat:acc1:old@im.wechat", "在的");
  assert.match(bodies[0]!, /"to_user_id":"new@im\.wechat"/);
});

test("没装归一化钩子时,userKey 用原始 from_user_id(默认恒等)", async (t) => {
  mockFetch(t, Buffer.alloc(0));
  const { conn, got } = setup();
  await conn["dispatch"]({ from_user_id: "u1", item_list: [textItem("在吗")] });
  assert.equal(got[0]!.userKey, "wechat:acc1:u1");
});
