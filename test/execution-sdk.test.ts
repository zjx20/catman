import { test } from "node:test";
import assert from "node:assert/strict";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { SdkSession } from "../src/core/execution/sdk-session.js";
import { buildUserMessage } from "../src/core/agent.js";

class Queue<T> implements AsyncIterable<T> {
  private items: T[] = []; private wake?: () => void; private ended = false;
  push(item: T) { this.items.push(item); this.wake?.(); }
  close() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() { while (!this.ended) { if (!this.items.length) await new Promise<void>(resolve => { this.wake = resolve; }); while (this.items.length) yield this.items.shift()!; } }
}
const message = (v: unknown) => v as SDKMessage;
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
function harness() {
  const events = new Queue<SDKMessage>(); const inputs: SDKUserMessage[] = []; const background: SDKMessage[] = []; let stopped = 0;
  const session = new SdkSession(input => {
    void (async () => { for await (const m of input) inputs.push(m); })();
    return events as unknown as Query;
  }, { onBackground: m => { background.push(m); }, onClose: () => {}, stopAgent: async () => { stopped++; }, idleMs: 25 });
  const result = (ids: string[], text = "done") => events.push(message({ type: "result", subtype: "success", is_error: false, result: text, session_id: "sdk-session", user_message_uuids: ids }));
  return { session, events, inputs, background, result, stopped: () => stopped };
}
test("result 交付回复但不关闭带 SDK 后台任务的 CLI，新消息复用同一连接", async () => {
  const h = harness();
  try {
    const a = buildUserMessage("first", []); const pending = h.session.run({ message: a, onMessage: () => {} });
    await pause();
    h.events.push(message({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "server", description: "preview" }], session_id: "sdk-session" }));
    h.result([a.uuid!]); assert.equal((await pending).text, "done");
    await pause(60); assert.equal(h.session.alive, true);
    const b = buildUserMessage("next", []); const next = h.session.run({ message: b, onMessage: () => {} });
    await pause(); h.result([b.uuid!], "next-result"); assert.equal((await next).text, "next-result"); assert.equal(h.inputs.length, 2);
    h.events.push(message({ type: "system", subtype: "background_tasks_changed", tasks: [], session_id: "sdk-session" }));
    await pause(60); assert.equal(h.session.alive, false); assert.equal(h.stopped(), 1);
  } finally { h.session.close(); }
});
test("按输入 UUID 关联结果，SDK 后台完成不能冒充正在等待的用户回复", async () => {
  const h = harness();
  try {
    const a = buildUserMessage("user", []); let settled = false;
    const pending = h.session.run({ message: a, onMessage: () => {} }).then(r => { settled = true; return r; });
    await pause(); h.result([], "background result"); await pause(); assert.equal(settled, false);
    assert.equal(h.background.length, 1); h.result([a.uuid!], "user result"); assert.equal((await pending).text, "user result");
  } finally { h.session.close(); }
});
test("多条追加可以合并为一个 result，不以输入数量猜测结果数量", async () => {
  const h = harness();
  try {
    const a = buildUserMessage("one", []), b = buildUserMessage("two", []);
    const pending = h.session.run({ message: a, onMessage: () => {} });
    assert.equal(h.session.feed(b), true); await pause(); h.result([a.uuid!, b.uuid!]); assert.equal((await pending).text, "done");
  } finally { h.session.close(); }
});
test("取消会终止当前 CLI 并兑现等待者，不中止管理器中的独立任务", async () => {
  const h = harness();
  try {
    const abort = new AbortController();
    const pending = h.session.run({ message: buildUserMessage("work", []), onMessage: () => {}, signal: abort.signal });
    abort.abort(new Error("cancel")); await assert.rejects(pending, /cancel/); assert.equal(h.session.alive, false); assert.ok(h.stopped() >= 1);
  } finally { h.session.close(); }
});
