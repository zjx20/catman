import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IPC_SCHEMA,
  checkIpcSecret,
  PERSONA_IDS,
  SEND_KINDS,
  parseAck,
  parseAttachmentRef,
  parseControl,
  parseInbound,
  parseOutbound,
  parsePersonaId,
  parsePull,
  parseSendKind,
  parseSendResult,
  resolvePersona,
  type PersonaId,
} from "../src/ipc/protocol.js";

/**
 * 跨版本契约。写它的信使是人工钦定的 pinned release,读它的人格每周被自动进化改一遍 ——
 * 两个二进制可以差几十个版本。
 *
 * 所以这里有两类用例,缺一不可:
 *   ① **golden 字面样例** —— 钉死形状。仓内两端的单测会跟着改动一起改,同步改完照样
 *      全绿;唯有写死字面 JSON 的用例会在破坏性变更时变红,它是唯一的提问者。
 *   ② **防御式解析** —— 读不懂返回 undefined 而不是抛。IPC 读不懂等于聋,
 *      一个能让人格崩掉的畸形信封会把"契约漂移"升级成"永久下线"。
 */

// ── golden:这些字面量**就是**契约 ────────────────────────────────
// 改动它们 = 破坏性变更,必须同时 bless 一份新信使。别顺手改成"更合理"的样子。

const GOLDEN_INBOUND = {
  schema: 1,
  msgId: "m-1",
  userKey: "wechat:acc1:u1",
  text: "你好",
  attachmentRefs: [{ id: "a1.bin", mediaType: "image/png", bytes: 1234 }],
  greeted: true,
  ts: 1754697600000,
};

const GOLDEN_OUTBOUND = {
  schema: 1,
  userKey: "wechat:acc1:u1",
  kind: "body",
  text: "好的",
};

const GOLDEN_CONTROL = { schema: 1, type: "detach", userKey: "wechat:acc1:u1" };

const GOLDEN_SEND_RESULT = { schema: 1, ok: true, messageId: "s-9", remainingProgress: 4 };

test("golden:契约版本号钉死为 1 —— 改它等于宣告破坏性变更", () => {
  assert.equal(IPC_SCHEMA, 1);
});

test("golden:人格标识与消息类别的字面取值", () => {
  // 信使按这些字符串分 inbox、分预算。改名 = 老信使认不出新人格。
  assert.deepEqual([...PERSONA_IDS], ["primary", "rescue"]);
  assert.deepEqual([...SEND_KINDS], [
    "ack",
    "progress",
    "body",
    "reminder",
    "fallback",
    "announce",
  ]);
});

test("golden:入站信封原样解析,字段一个不少一个不多", () => {
  const m = parseInbound(GOLDEN_INBOUND);
  assert.deepEqual(m, {
    schema: 1,
    msgId: "m-1",
    userKey: "wechat:acc1:u1",
    text: "你好",
    attachmentRefs: [{ id: "a1.bin", mediaType: "image/png", bytes: 1234 }],
    greeted: true,
    ts: 1754697600000,
  });
});

test("golden:出站信封与发送结果的形状", () => {
  assert.deepEqual(parseOutbound(GOLDEN_OUTBOUND), {
    schema: 1,
    userKey: "wechat:acc1:u1",
    kind: "body",
    text: "好的",
  });
  assert.deepEqual(parseSendResult(GOLDEN_SEND_RESULT), {
    schema: 1,
    ok: true,
    messageId: "s-9",
    remainingProgress: 4,
  });
});

test("golden:控制帧的形状", () => {
  assert.deepEqual(parseControl(GOLDEN_CONTROL), {
    schema: 1,
    type: "detach",
    userKey: "wechat:acc1:u1",
  });
});

test("未来版本多出来的字段不影响解析 —— 字段只增不改,旧读者要能读新信封", () => {
  const m = parseInbound({ ...GOLDEN_INBOUND, schema: 99, 未来字段: { a: 1 } });
  assert.equal(m?.msgId, "m-1");
  assert.equal(m?.schema, 99);
});

// ── 防御式解析 ────────────────────────────────────────────────────

test("入站:形状不对一律 undefined,绝不抛", () => {
  for (const bad of [
    undefined,
    null,
    "字符串",
    42,
    [],
    {},
    { ...GOLDEN_INBOUND, msgId: "" },
    { ...GOLDEN_INBOUND, msgId: 7 },
    { ...GOLDEN_INBOUND, userKey: "" },
    // 文字与附件同时为空 = 没有内容,与渠道侧那条判断一致。
    { ...GOLDEN_INBOUND, text: "", attachmentRefs: [] },
  ]) {
    assert.equal(parseInbound(bad), undefined, JSON.stringify(bad));
  }
});

test("入站:单个坏附件只丢它自己,文字与其余图片照常送达", () => {
  // 整条消息因为一张图挂掉,在用户那边就是"发了没反应"—— 与渠道侧同一条纪律。
  const m = parseInbound({
    ...GOLDEN_INBOUND,
    attachmentRefs: [
      { id: "ok.bin", mediaType: "image/png", bytes: 1 },
      { id: "bad.bin", mediaType: "image/tiff", bytes: 1 }, // 模型接不了的格式
      "不是对象",
    ],
  });
  assert.equal(m?.text, "你好");
  assert.deepEqual(m?.attachmentRefs.map((a) => a.id), ["ok.bin"]);
});

test("附件引用:id 必须是安全文件名 —— 它会被拼进 spool 路径去读文件", () => {
  // 越界的引用要在**解析器**这一层就消失,不能指望每个调用方都记得校验。
  for (const id of ["../secrets", "a/b", "a\\b", "..", ""]) {
    assert.equal(
      parseAttachmentRef({ id, mediaType: "image/png", bytes: 1 }),
      undefined,
      `id=${JSON.stringify(id)} 必须被拒`,
    );
  }
  assert.ok(parseAttachmentRef({ id: "ok.bin", mediaType: "image/png", bytes: 1 }));
});

test("附件引用:格式必须在模型能接的四种里", () => {
  for (const t of ["image/tiff", "application/pdf", "", 7]) {
    assert.equal(parseAttachmentRef({ id: "a", mediaType: t, bytes: 1 }), undefined);
  }
});

test("控制帧:认不出的类型一律丢弃,不能把整批拉取判成失败", () => {
  // 旧人格遇到新版本才有的控制帧,应当"不做这件事"而不是聋掉一整批。
  assert.equal(parseControl({ schema: 1, type: "未来帧", userKey: "a:b:c" }), undefined);
  assert.equal(parseControl({ schema: 1, type: "detach" }), undefined);
});

test("拉取:坏消息能认出 msgId 的进 badMsgIds,认不出的只计数", () => {
  // 静默丢弃会让契约漂移表现为"消息神秘消失",那是最难查的一种失败。
  const r = parsePull({
    schema: 1,
    controls: [GOLDEN_CONTROL, { type: "未来帧" }],
    messages: [
      GOLDEN_INBOUND,
      { msgId: "m-bad", userKey: "" }, // 认得出 id
      "整个不是对象", // 连 id 都认不出
    ],
  });
  assert.equal(r?.messages.length, 1);
  assert.equal(r?.controls.length, 1);
  assert.deepEqual(r?.badMsgIds, ["m-bad"]);
  assert.equal(r?.unparsable, 1);
});

test("拉取:整体读不懂才返回 undefined;缺字段按空处理", () => {
  assert.equal(parsePull("不是对象"), undefined);
  assert.deepEqual(parsePull({}), {
    controls: [],
    messages: [],
    badMsgIds: [],
    unparsable: 0,
  });
});

test("出站:kind 不认识就拒收 —— 预算是按它算的,猜错等于算错账", () => {
  assert.equal(parseOutbound({ ...GOLDEN_OUTBOUND, kind: "未来类别" }), undefined);
  assert.equal(parseOutbound({ ...GOLDEN_OUTBOUND, kind: undefined }), undefined);
  assert.equal(parseOutbound({ ...GOLDEN_OUTBOUND, text: "" }), undefined, "空正文没有意义");
});

test("发送结果:读不出剩余额度时按 0 —— 宁可不发进度,也不能超发", () => {
  // 超发的后果是 `ret=-2 prepare failed` 且永不恢复:连正文都发不出去。
  assert.equal(parseSendResult({ ok: true })?.remainingProgress, 0);
  assert.equal(parseSendResult({ ok: true, remainingProgress: "五" })?.remainingProgress, 0);
  assert.equal(parseSendResult({ ok: true, remainingProgress: -3 })?.remainingProgress, 0);
  assert.equal(parseSendResult({ remainingProgress: 3 }), undefined, "ok 缺失就是读不懂");
});

test("ack:非字符串的 id 被剔掉,不让它们污染出队", () => {
  assert.deepEqual(parseAck({ schema: 1, msgIds: ["a", "", 7, null, "b"] })?.msgIds, ["a", "b"]);
  assert.equal(parseAck({ schema: 1 }), undefined);
});

// ── 身份 ──────────────────────────────────────────────────────────

test("身份由 secret 反查,请求体里声称的身份一个字都不信", () => {
  const secrets = new Map<string, PersonaId>([
    ["s-primary", "primary"],
    ["s-rescue", "rescue"],
  ]);
  assert.equal(resolvePersona("s-primary", secrets), "primary");
  assert.equal(resolvePersona("s-rescue", secrets), "rescue");
  assert.equal(resolvePersona("猜的", secrets), undefined);
});

test("空 secret 一律拒绝 —— 两个忘了配 env 的人格会以空串串到一起", () => {
  const secrets = new Map<string, PersonaId>([["", "primary"]]);
  assert.equal(resolvePersona("", secrets), undefined);
  assert.equal(resolvePersona(undefined, secrets), undefined);
});

test("parsePersonaId / parseSendKind 只认表里的字面量", () => {
  assert.equal(parsePersonaId("primary"), "primary");
  assert.equal(parsePersonaId("Primary"), undefined);
  assert.equal(parsePersonaId(7), undefined);
  assert.equal(parseSendKind("progress"), "progress");
  assert.equal(parseSendKind("PROGRESS"), undefined);
});

test("secret 必须是可打印 ASCII —— 它要进 HTTP 请求头,中文会让客户端发之前就抛", () => {
  // 这条不是洁癖:HTTP 头只能是 latin-1,node 的 setHeader 对非 ASCII 直接
  // ERR_INVALID_CHAR。检查放在装配时,起不来好过"起来了每次 IPC 都崩",
  // 而且那时人正看着日志。
  assert.equal(checkIpcSecret("abcdefgh1234"), undefined);
  assert.match(checkIpcSecret("我的密钥我的密钥") ?? "", /ASCII/);
  assert.match(checkIpcSecret("has space here") ?? "", /ASCII/);
  assert.match(checkIpcSecret("short") ?? "", /太短/);
  assert.match(checkIpcSecret("") ?? "", /没有配置/);
  assert.match(checkIpcSecret(undefined) ?? "", /没有配置/);
});
