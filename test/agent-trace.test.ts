import { test } from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  describeProgress,
  describeSdkMessage,
  formatHeartbeat,
  formatResetAt,
  shortMs,
  shortNum,
  summarizeToolInput,
} from "../src/core/agent-trace.js";

/**
 * SDK 的消息联合类型很大,这里只造被格式化用到的那几个字段。
 * 断言的是"怎么压成一行",不是 SDK 的类型完整性。
 */
const msg = (o: unknown): SDKMessage => o as SDKMessage;

const BASE64 = "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(3000);

test("核心约束:图片 base64 不会进日志", () => {
  // 这是唯一会把 SDK 原始内容写进日志的地方。一张 3MB 的图既刷屏,
  // 也把用户内容留在了本不该有它的地方。
  const line = describeSdkMessage(
    msg({
      type: "assistant",
      message: {
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: BASE64 } }],
      },
    }),
  );
  assert.ok(line);
  assert.ok(!line.text.includes("iVBORw0KGgo"), "不能出现 base64 内容");
  assert.match(line.text, /image\(3\.0k base64字符\)/);
});

test("核心约束:工具结果只出长度与成败,不出全文", () => {
  const line = describeSdkMessage(
    msg({
      type: "user",
      message: {
        content: [
          { type: "tool_result", content: [{ type: "text", text: "绝密内容".repeat(100) }] },
          { type: "tool_result", content: "炸了", is_error: true },
        ],
      },
    }),
  );
  assert.ok(line);
  assert.ok(!line.text.includes("绝密内容"), "不能出现工具输出正文");
  assert.equal(line.text, "user result(400字) result(2字 出错)");
  assert.equal(line.level, "trace");
});

test("思考与文本只出字数,工具出名字与入参摘要", () => {
  const line = describeSdkMessage(
    msg({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "想了很多".repeat(10) },
          { type: "text", text: "答案是 42" },
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 12_345, output_tokens: 678 },
      },
    }),
  );
  assert.ok(line);
  assert.ok(!line.text.includes("想了很多"), "思考正文不进日志");
  assert.equal(
    line.text,
    "assistant thinking(40字) text(6字) tool:Bash(npm test) stop=tool_use [in=12.3k out=678]",
  );
});

test("超长工具入参在 block 摘要里被截断", () => {
  const line = describeSdkMessage(
    msg({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "x".repeat(500) } }] },
    }),
  );
  assert.ok(line);
  assert.ok(line.text.length < 140, `一行要能扫得过来,实际 ${line.text.length} 字`);
  assert.ok(line.text.endsWith("…)"));
});

test("「为什么没反应」的几种真因都是 always 级,不需要开关", () => {
  // 这几条的共同点:事后翻日志才想起要查,那时再开开关重启已经晚了。
  const retry = describeSdkMessage(
    msg({
      type: "system",
      subtype: "api_retry",
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 4000,
      error_status: 529,
    }),
  );
  assert.equal(retry?.level, "always");
  assert.match(retry!.text, /API 重试 第2\/5次 4000ms 后重试 status=529/);

  const limited = describeSdkMessage(
    msg({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: 100 },
    }),
  );
  assert.equal(limited?.level, "always");
  assert.match(limited!.text, /限流 status=rejected 类型=five_hour 已用 100%/);

  const compact = describeSdkMessage(
    msg({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 42_000, duration_ms: 31_000 },
    }),
  );
  assert.equal(compact?.level, "always");
  assert.match(compact!.text, /上下文压缩\(auto\) 150\.0k→42\.0k tokens 耗时 31\.0s/);

  const init = describeSdkMessage(
    msg({
      type: "system",
      subtype: "init",
      model: "claude-sonnet-4-5",
      permissionMode: "bypassPermissions",
      tools: ["Bash", "Read"],
      skills: ["catman"],
      cwd: "/data/workspace/u",
    }),
  );
  assert.equal(init?.level, "always", "三件套是否生效只能靠核对这一行");
  assert.match(init!.text, /mode=bypassPermissions/);
});

test("限流未触发时降级为 trace —— 正常回合每轮都可能来一条", () => {
  const line = describeSdkMessage(
    msg({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }),
  );
  assert.equal(line?.level, "trace");
});

test("assistant 自带 error 时升为 always", () => {
  const line = describeSdkMessage(
    msg({ type: "assistant", message: { content: [] }, error: { message: "overloaded" } }),
  );
  assert.equal(line?.level, "always");
  assert.match(line!.text, /assistant 出错.*overloaded/);
});

test("result 不在这里出行 —— 回合结束行由 Agent.run 打,免得重复", () => {
  assert.equal(describeSdkMessage(msg({ type: "result", subtype: "success" })), undefined);
});

test("未知消息类型退化成 type/subtype,不会丢也不会崩", () => {
  const line = describeSdkMessage(msg({ type: "system", subtype: "未来才有的东西" }));
  assert.deepEqual(line, { level: "trace", text: "system/未来才有的东西" });
  assert.deepEqual(describeSdkMessage(msg({ type: "background_tasks_changed" })), {
    level: "trace",
    text: "background_tasks_changed",
  });
});

test("纯计数类的流式增量不出行", () => {
  // 真机上一次模型往返来了 3 条 thinking_tokens,而它说不出任何"在干什么"。
  // 留着只会把有用的行挤出屏幕。
  assert.equal(describeSdkMessage(msg({ type: "thinking_tokens", tokens: 128 })), undefined);
});

test("formatResetAt 秒与毫秒两种编码都认", () => {
  // SDK 只声明 number。按秒解读一个毫秒时间戳会打出五万年后,反过来是 1970 年 ——
  // 都是"一眼假但没人细看"的那种错。
  const at = Date.UTC(2026, 7, 2, 3, 4, 5);
  assert.equal(formatResetAt(at / 1000), formatResetAt(at));
  assert.equal(formatResetAt(undefined), "");
  assert.equal(formatResetAt(0), "");
});

test("describeProgress:用户看到的步骤与日志里的是同一句", () => {
  assert.equal(
    describeProgress({ kind: "tool", name: "Read", input: { file_path: "/etc/hosts" } }),
    "🔧 Read: /etc/hosts",
  );
  assert.equal(describeProgress({ kind: "tool", name: "Foo", input: {} }), "🔧 Foo: {}");
  assert.equal(describeProgress({ kind: "thinking", text: "在想" }), "💭 在想");
  assert.ok(describeProgress({ kind: "thinking", text: "x".repeat(500) }).endsWith("…"));
});

test("summarizeToolInput 挑代表性字段,挑不出就退到 JSON", () => {
  assert.equal(summarizeToolInput({ description: "跑测试", command: "npm test" }), "跑测试");
  assert.equal(summarizeToolInput({ command: "npm test" }), "npm test");
  assert.equal(summarizeToolInput({ n: 1 }), '{"n":1}');
  assert.equal(summarizeToolInput(undefined), "");
  // 循环引用不该把整个回合搞挂 —— 它只是一行日志。
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.equal(summarizeToolInput(cyclic), "");
});

test("心跳行同时给出「等了多久」与「多久没动静」", () => {
  // 前者一直涨而后者不涨 = 卡在某一步;两者同步涨 = 正常推进。这是心跳的全部意义。
  assert.equal(
    formatHeartbeat(125_000, 90_000, 7, "🔧 Bash: npm test"),
    "进行中 已 125.0s · 第 7 步(90.0s 前) · 🔧 Bash: npm test",
  );
  assert.equal(formatHeartbeat(3000, 3000, 0), "进行中 已 3.0s · 第 0 步(3.0s 前)");
});

test("数字与时长缩写", () => {
  assert.equal(shortNum(0), "0");
  assert.equal(shortNum(999), "999");
  assert.equal(shortNum(1500), "1.5k");
  assert.equal(shortNum(2_500_000), "2.5M");
  assert.equal(shortMs(999), "999ms");
  assert.equal(shortMs(1500), "1.5s");
});
