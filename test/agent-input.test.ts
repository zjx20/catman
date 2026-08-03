import { test } from "node:test";
import assert from "node:assert/strict";
import { InputChannel, buildUserMessage } from "../src/core/agent.js";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * 回合输入通道的单测。
 *
 * 它承载的是"用户中途补一句话"这件事:回合跑起来之后通道仍然开着,追加进来的
 * 消息会被 SDK 折进正在跑的那个 turn。这里只测通道本身的语义,不碰真实 SDK。
 */

function msg(text: string): SDKUserMessage {
  return buildUserMessage(text, []);
}

/** 从一条 SDK 用户消息里取回文本,用于断言顺序。 */
function textOf(m: SDKUserMessage): string {
  const content = m.message.content;
  assert.ok(Array.isArray(content));
  const block = content.find((b) => b.type === "text");
  assert.ok(block && block.type === "text");
  return block.text;
}

/** 收完整个通道。只在通道已经 close(或即将 close)时用,否则会挂住。 */
async function drain(ch: InputChannel): Promise<string[]> {
  const out: string[] = [];
  for await (const m of ch) out.push(textOf(m));
  return out;
}

test("按 push 的顺序交出消息", async () => {
  const ch = new InputChannel();
  ch.push(msg("第一条"));
  ch.push(msg("第二条"));
  ch.close();
  assert.deepEqual(await drain(ch), ["第一条", "第二条"]);
});

test("close 之后仍然交出已经 push 的消息 —— 追加输入不会被收尾吞掉", async () => {
  // 这是"回合收尾时无脑 close 是安全的"那条结论的本地依据:真实竞态里,
  // 一条追加输入可能恰好挤在 result 与 close 之间(管道延迟造成的窄窗口),
  // 它必须照样被交出去,否则用户那句话就静默消失了。
  const ch = new InputChannel();
  ch.push(msg("首条"));
  ch.push(msg("挤在收尾边缘的那条"));
  ch.close();
  assert.deepEqual(await drain(ch), ["首条", "挤在收尾边缘的那条"]);
});

test("队列空了就挂起,push 唤醒 —— 回合跑起来之后通道仍然开着", async () => {
  const ch = new InputChannel();
  ch.push(msg("首条"));
  const it = ch[Symbol.asyncIterator]();
  assert.equal(textOf((await it.next()).value as SDKUserMessage), "首条");

  // 没有新消息:迭代器必须停在这里等,而不是结束。传 string 或用一个
  // yield 完就返回的 iterable 时,SDK 收到的是"输入到此为止",追加无从谈起。
  const pending = it.next();
  let settled = false;
  void pending.then(() => (settled = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, "没有新消息时不该结束迭代");

  ch.push(msg("回合中途补的一句"));
  assert.equal(textOf((await pending).value as SDKUserMessage), "回合中途补的一句");

  ch.close();
  assert.equal((await it.next()).done, true, "close 之后迭代应当正常结束");
});

test("close 幂等 —— 正常收尾与 finally 兜底都会调它", async () => {
  const ch = new InputChannel();
  ch.push(msg("唯一一条"));
  ch.close();
  ch.close();
  assert.deepEqual(await drain(ch), ["唯一一条"]);
});
