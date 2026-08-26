import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUserMessage } from "../src/core/agent.js";
import { SessionManager } from "../src/core/session.js";
import { FileStore } from "../src/core/file-store.js";
import { releaseNote } from "../src/core/version.js";

const dirs: string[] = [];
const ME = "wechat:a:u1";
const OTHER = "wechat:a:u2";
const SHA_A = "1f23411ed3dff01001863066aeb465cd96d922ec";
const SHA_B = "ba5f7a194795a618c7b3a2972715bb5e0a3ddd4f";

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sessions(): SessionManager {
  const dir = mkdtempSync(join(tmpdir(), "catman-relaware-"));
  dirs.push(dir);
  return new SessionManager({
    store: new FileStore(join(dir, "state.json")),
    timeoutMs: 60_000,
  });
}

const textsOf = (m: ReturnType<typeof buildUserMessage>) =>
  (m.message.content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text!);

// ── 标记 ────────────────────────────────────────────────────────────

test("没见过就该说,说完就不再说 —— 绝大多数回合走的是后半句", () => {
  const s = sessions();
  assert.equal(s.hasSeenRelease(ME, SHA_A), false);
  assert.equal(s.markReleaseSeen(ME, SHA_A), undefined);
  assert.equal(s.hasSeenRelease(ME, SHA_A), true);
});

test("版本变了要重新说,而且拿得到旧值 —— 提示要能说清是刚升级还是一直如此", () => {
  const s = sessions();
  s.markReleaseSeen(ME, SHA_A);
  assert.equal(s.hasSeenRelease(ME, SHA_B), false);
  assert.equal(s.markReleaseSeen(ME, SHA_B), SHA_A);
});

test("标记是每人一份 —— 一个人被告知过不代表别人也知道", () => {
  const s = sessions();
  s.markReleaseSeen(ME, SHA_A);
  assert.equal(s.hasSeenRelease(OTHER, SHA_A), false);
});

test("标记落盘 —— 部署会重启进程,只放内存等于每次升级后人人多挨一条", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-relaware-"));
  dirs.push(dir);
  const path = join(dir, "state.json");
  new SessionManager({ store: new FileStore(path), timeoutMs: 60_000 }).markReleaseSeen(ME, SHA_A);
  const reborn = new SessionManager({ store: new FileStore(path), timeoutMs: 60_000 });
  assert.equal(reborn.hasSeenRelease(ME, SHA_A), true);
});

test("旧盘没有这个字段时当作没告知过,不炸也不迁移", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-relaware-"));
  dirs.push(dir);
  const path = join(dir, "state.json");
  // 老版本写出来的形状:没有 seenReleaseSha。
  const store = new FileStore(path);
  store.save({ [ME]: { reminded: false, history: [] } });
  const s = new SessionManager({ store: new FileStore(path), timeoutMs: 60_000 });
  assert.equal(s.hasSeenRelease(ME, SHA_A), false);
  assert.doesNotThrow(() => s.markReleaseSeen(ME, SHA_A));
});

// ── 措辞 ────────────────────────────────────────────────────────────

test("第一次只说当前版本;升级过则带上旧的", () => {
  const cur = { sha: SHA_B, preparedAt: "2026-08-26T03:57:45Z" };
  assert.match(releaseNote(cur, undefined), /ba5f7a1/);
  assert.doesNotMatch(releaseNote(cur, undefined), /上次/);
  const changed = releaseNote(cur, SHA_A);
  assert.match(changed, /ba5f7a1/);
  assert.match(changed, /1f23411/);
});

// ── 注入形态 ────────────────────────────────────────────────────────

test("不给 ambient 时消息一个字都不变 —— 这是绝大多数回合", () => {
  assert.deepEqual(textsOf(buildUserMessage("在吗", [])), ["在吗"]);
  assert.deepEqual(textsOf(buildUserMessage("在吗", [], "   ")), ["在吗"]);
});

test("ambient 是独立 block,不拼进用户那句话 —— 否则 /发布 abc1234 会被拼坏", () => {
  const m = buildUserMessage("/发布 abc1234", [], "你现在跑的是 release ba5f7a1。");
  const texts = textsOf(m);
  assert.equal(texts.length, 2);
  // 用户那句必须原样,一个字符都不许多。
  assert.equal(texts[0], "/发布 abc1234");
  assert.match(texts[1]!, /^<system-reminder>/);
  assert.match(texts[1]!, /ba5f7a1/);
});

test("ambient 排在最后 —— 图在最前那条规矩(指代要有对象)不能被挤掉", () => {
  const m = buildUserMessage(
    "这张图里是什么",
    [{ kind: "image", mediaType: "image/png", data: "AA", bytes: 1 }],
    "版本提示",
  );
  const blocks = m.message.content as Array<{ type: string; text?: string }>;
  assert.equal(blocks[0]!.type, "image");
  assert.equal(blocks[1]!.text, "这张图里是什么");
  assert.match(blocks[2]!.text!, /版本提示/);
});
