import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  describeReject,
  sniffImageMediaType,
  toImageAttachment,
  SUPPORTED_IMAGE_TYPES,
  type AttachmentLimits,
} from "../src/core/attachments.js";
import { buildUserMessage } from "../src/core/agent.js";
import type { Attachment } from "../src/core/attachments.js";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { parseCdnAesKey, buildCdnDownloadUrl, fetchCdnMedia } from "../src/channels/ilink-protocol.js";

/** 各格式的 magic number 前缀,后面补足够长度即可。 */
const MAGIC: Record<string, number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "image/gif": [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  "image/webp": [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
};

function sample(type: string, extra = 32): Buffer {
  return Buffer.concat([Buffer.from(MAGIC[type]!), Buffer.alloc(extra, 7)]);
}

/** 测试用的上限。业务默认值在 SETTING_SCHEMA 里,这里只要一个稳定的已知值。 */
const LIMITS: AttachmentLimits = { maxImageBytes: 3_500_000, maxImagesPerTurn: 4 };

/** 组装后的 content block 数组。带附件的回合永远走数组分支,不会是裸字符串。 */
type Blocks = Exclude<SDKUserMessage["message"]["content"], string>;

function blocksOf(prompt: string, attachments: readonly Attachment[]): Blocks {
  const content = buildUserMessage(prompt, attachments).message.content;
  assert.ok(Array.isArray(content), "带附件时 content 应该是 block 数组");
  return content;
}

/** 断言某个 block 是图片并取出它的 source,顺带守护结构。 */
function imageSourceOf(block: Blocks[number]): { media_type: string; data: string } {
  assert.equal(block.type, "image");
  const source = (block as { source: { type: string; media_type: string; data: string } }).source;
  assert.equal(source.type, "base64");
  return source;
}

// --- 格式嗅探 ---

test("四种受支持格式都能从字节认出来", () => {
  for (const type of SUPPORTED_IMAGE_TYPES) {
    assert.equal(sniffImageMediaType(sample(type)), type, `${type} 没认出来`);
  }
});

test("认不出的格式返回 undefined,而不是猜一个", () => {
  // BMP:是图片,但模型侧不收 —— 猜成 png 会让请求在模型侧报错。
  assert.equal(sniffImageMediaType(Buffer.from([0x42, 0x4d, 1, 2, 3, 4, 5, 6, 7, 8])), undefined);
  assert.equal(sniffImageMediaType(Buffer.from("这不是图片", "utf8")), undefined);
  assert.equal(sniffImageMediaType(Buffer.alloc(0)), undefined);
});

test("嗅探不越界:长度不足的字节不会误判也不会抛错", () => {
  // RIFF 头对但没到 12 字节 —— 只查前 4 字节的实现会误判成 webp。
  assert.equal(sniffImageMediaType(Buffer.from([0x52, 0x49, 0x46, 0x46])), undefined);
  assert.equal(sniffImageMediaType(Buffer.from([0x89, 0x50])), undefined);
});

test("RIFF 但不是 WEBP 的容器不算图片", () => {
  // RIFF 也用于 wav/avi,只看 RIFF 会把音频当图片发给模型。
  const wav = Buffer.concat([
    Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]),
    Buffer.from("WAVE", "ascii"),
  ]);
  assert.equal(sniffImageMediaType(wav), undefined);
});

// --- 附件构造与校验 ---

test("合格图片转成附件,base64 可原样还原", () => {
  const bytes = sample("image/png");
  const result = toImageAttachment(bytes, LIMITS);
  assert.ok(result.ok);
  assert.equal(result.attachment.mediaType, "image/png");
  assert.equal(result.attachment.bytes, bytes.length);
  assert.deepEqual(Buffer.from(result.attachment.data, "base64"), bytes);
});

test("超大图片被拒,理由里带上实际大小", () => {
  const huge = Buffer.concat([sample("image/jpeg"), Buffer.alloc(LIMITS.maxImageBytes)]);
  const result = toImageAttachment(huge, LIMITS);
  assert.ok(!result.ok);
  assert.equal(result.reject.reason, "too-large");
  assert.match(describeReject(result.reject), /MB/);
});

test("大小检查在格式检查之前:超大的垃圾数据不会先被当成格式问题", () => {
  // 顺序反了的话,用户拿到的提示是"格式不认识",与真实原因不符。
  const result = toImageAttachment(Buffer.alloc(LIMITS.maxImageBytes + 1), LIMITS);
  assert.ok(!result.ok);
  assert.equal(result.reject.reason, "too-large");
});

test("拒绝理由都能说成人话", () => {
  assert.ok(describeReject({ reason: "unsupported-format" }).length > 0);
  const msg = describeReject({ reason: "too-large", bytes: 9_000_000, limit: LIMITS.maxImageBytes });
  assert.ok(msg.includes("9.0MB"), msg);
});

// --- Agent 侧的消息组装 ---

test("图片排在文字前面 —— 提问通常在指代图片", () => {
  const att = toImageAttachment(sample("image/png"), LIMITS);
  assert.ok(att.ok);
  const content = blocksOf("这是什么?", [att.attachment]);
  assert.equal(content[0]?.type, "image");
  assert.equal(content[1]?.type, "text");
});

test("只发图不发字时不产生空 text block(模型侧会拒绝空块)", () => {
  const att = toImageAttachment(sample("image/gif"), LIMITS);
  assert.ok(att.ok);
  for (const blank of ["", "   ", "\n\t "]) {
    const content = blocksOf(blank, [att.attachment]);
    assert.equal(content.length, 1, `"${blank}" 不该产生第二个 block`);
    assert.equal(content[0]?.type, "image");
  }
});

test("组装出的 image block 结构与 SDK 的 base64 source 一致", () => {
  const att = toImageAttachment(sample("image/webp"), LIMITS);
  assert.ok(att.ok);
  const content = blocksOf("看图", [att.attachment]);
  assert.deepEqual(content[0], {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/webp",
      data: att.attachment.data,
    },
  });
});

test("多张图按给定顺序内联", () => {
  const a = toImageAttachment(sample("image/png", 8), LIMITS);
  const b = toImageAttachment(sample("image/jpeg", 16), LIMITS);
  assert.ok(a.ok && b.ok);
  const content = blocksOf("对比这两张", [a.attachment, b.attachment]);
  assert.equal(content.length, 3);
  assert.equal(imageSourceOf(content[0]!).media_type, "image/png");
  assert.equal(imageSourceOf(content[1]!).media_type, "image/jpeg");
  assert.equal(content[2]?.type, "text");
});

// --- iLink CDN:key 解析与下载解密 ---

test("CDN aes_key 两种野外编码都认", () => {
  const raw = randomBytes(16);
  // 图片:base64(16 字节原文)
  assert.deepEqual(parseCdnAesKey(raw.toString("base64")), raw);
  // 文件/语音/视频:base64(32 位 hex 字符串)
  const hexForm = Buffer.from(raw.toString("hex"), "ascii").toString("base64");
  assert.deepEqual(parseCdnAesKey(hexForm), raw);
});

test("长度不对的 aes_key 直接抛错,不拿去解密", () => {
  // 让它走到 createDecipheriv 才炸的话,错误信息完全看不出是 key 的问题。
  assert.throws(() => parseCdnAesKey(randomBytes(20).toString("base64")), /aes_key/);
});

test("下载地址在没有 full_url 时才自己拼,参数经过转义", () => {
  const url = buildCdnDownloadUrl("a b&c=d", "https://cdn.example/c2c");
  assert.equal(url, "https://cdn.example/c2c/download?encrypted_query_param=a%20b%26c%3Dd");
});

test("加密媒体下载后能还原出明文(与真实 AES-128-ECB 往返)", async (t) => {
  const key = randomBytes(16);
  const plaintext = sample("image/png", 100);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  t.mock.method(globalThis, "fetch", async () =>
    new Response(encrypted, { status: 200 }),
  );

  const got = await fetchCdnMedia(
    { full_url: "https://cdn.example/x", aes_key: key.toString("base64") },
    {},
  );
  assert.deepEqual(got, plaintext);
  // 解出来的东西必须还能被识别成图片,否则解密"成功"也没意义。
  assert.equal(sniffImageMediaType(got), "image/png");
});

test("没有 aes_key 时按未加密处理,而不是报错丢图", async (t) => {
  const plaintext = sample("image/jpeg", 64);
  t.mock.method(globalThis, "fetch", async () => new Response(plaintext, { status: 200 }));
  const got = await fetchCdnMedia({ full_url: "https://cdn.example/x" }, {});
  assert.deepEqual(got, plaintext);
});

test("full_url 优先于自己拼的地址", async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    urls.push(String(input));
    return new Response(sample("image/png"), { status: 200 });
  });
  await fetchCdnMedia({ full_url: "https://direct.example/img", encrypt_query_param: "q" }, {});
  assert.equal(urls[0], "https://direct.example/img");
});

test("既无 full_url 也无 encrypt_query_param 时明确报错", async () => {
  await assert.rejects(() => fetchCdnMedia({}, {}), /无法下载/);
});

test("CDN 返回非 2xx 时抛错,不把错误页当图片字节", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 403 }));
  await assert.rejects(
    () => fetchCdnMedia({ full_url: "https://cdn.example/x" }, {}),
    /403/,
  );
});

// --- 上限可配置 ---

test("上限来自注入而非常量:调小之后同一张图就被拒", () => {
  // 这是配置项存在的意义 —— 软路由和 x86 主机的内存余量差得远。
  const bytes = sample("image/png", 500);
  assert.ok(toImageAttachment(bytes, LIMITS).ok);

  const tight: AttachmentLimits = { maxImageBytes: 100, maxImagesPerTurn: 4 };
  const result = toImageAttachment(bytes, tight);
  assert.ok(!result.ok);
  assert.equal(result.reject.reason, "too-large");
});

test("拒收提示里的上限跟着配置走,不是写死的数字", () => {
  const tight: AttachmentLimits = { maxImageBytes: 1_000_000, maxImagesPerTurn: 4 };
  const result = toImageAttachment(Buffer.alloc(2_000_000), tight);
  assert.ok(!result.ok);
  // 提示说 1.0MB 而不是 schema 默认的 3.5MB,否则用户按提示压缩了还是发不进来。
  assert.ok(describeReject(result.reject).includes("1.0MB"), describeReject(result.reject));
});
