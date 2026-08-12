import { test } from "node:test";
import assert from "node:assert/strict";
import { InputChannel, ProgressFan, buildUserMessage, joinReplyTexts } from "../src/core/agent.js";
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

test("多段正文按序拼接 —— 追加输入落在 turn 边界上时会多出几段", () => {
  assert.equal(joinReplyTexts(["第一段", "第二段"], false), "第一段\n\n第二段");
});

test("失败回合的空正文不能说成「没有返回内容」", () => {
  // SDK 报错时 errors 可能是空数组、result 可能是空串。沿用成功路径的话术
  // 会把一次失败(该去查订阅/配置)伪装成一次无话可说(该换个问法再问)。
  assert.match(joinReplyTexts([], true), /回合失败/);
  assert.equal(joinReplyTexts([], false), "(助手没有返回内容)");
  assert.match(joinReplyTexts(["   "], true), /回合失败/, "只有空白也算没给详情");
});

// ── 内容块 → 进度事件 ────────────────────────────────────────────
// 助手中途说的话也推给用户(大多数时候它埋头调工具,偶尔开口那几句最能看出它在
// 怎么干活)。难点只有一个:**最终答复也是一个 text 块**,原样透出去用户会收到
// 两遍同一句话 —— 一遍当进度、一遍当正文。

test("中途说的话推出去,最后那句留给正文 —— 不能同一句话收两遍", () => {
  const fan = new ProgressFan();
  // 一条消息里:先说一句,再调工具。那句话后面有动静,所以它是"中途说的"。
  const first = fan.take([
    { type: "text", text: "先看看日志" },
    { type: "tool_use", name: "Bash", input: { command: "tail log" } },
  ]);
  assert.deepEqual(
    first.map((e) => e.kind),
    ["text", "tool"],
    "顺序要保住:先说的先出去",
  );

  // 最后一条消息只有一个 text —— 那就是答复,一个事件都不该出来。
  assert.deepEqual(fan.take([{ type: "text", text: "查完了,是磁盘满了" }]), []);
});

test("跨消息也算数:上一条消息末尾那句话,由下一条消息放它出去", () => {
  // 真实形态就是这样 —— 助手说一句、停下来调工具是两条 assistant 消息。
  const fan = new ProgressFan();
  assert.deepEqual(fan.take([{ type: "text", text: "我先查一下" }]), [], "还不知道它是不是答复");
  const next = fan.take([{ type: "tool_use", name: "Read", input: {} }]);
  assert.deepEqual(next[0], { kind: "text", text: "我先查一下" }, "下一条消息一来它就确定了");
  assert.equal(next[1]?.kind, "tool");
});

test("连着说两句:前一句放出去,后一句继续攒着", () => {
  const fan = new ProgressFan();
  fan.take([{ type: "text", text: "第一句" }]);
  const out = fan.take([{ type: "text", text: "第二句" }]);
  assert.deepEqual(out, [{ kind: "text", text: "第一句" }]);
});

test("空白的块一概不出事件 —— 空的 💭 / 💬 是纯噪音", () => {
  const fan = new ProgressFan();
  assert.deepEqual(fan.take([{ type: "text", text: "   " }, { type: "thinking", thinking: "" }]), []);
  // 攒着的那个也不该被空块顶出来。
  assert.deepEqual(fan.take([{ type: "tool_use", name: "Bash", input: {} }]), [
    { kind: "tool", name: "Bash", input: {} },
  ]);
});
