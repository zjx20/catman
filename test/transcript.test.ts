import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listSessions,
  readSession,
  search,
  cleanupOldSessions,
  listSessionsAcross,
  searchAcross,
  cleanupOldSessionsAcross,
} from "../src/core/transcript.js";

/** 造一个 CLAUDE_CONFIG_DIR/projects/<proj>/<id>.jsonl 结构。 */
const PROJ = "-data-workspace";

function fixture(): { configDir: string; writeSession: (id: string, lines: unknown[]) => string } {
  const configDir = mkdtempSync(join(tmpdir(), "catman-tc-"));
  const proj = join(configDir, "projects", PROJ);
  mkdirSync(proj, { recursive: true });
  return {
    configDir,
    writeSession(id, lines) {
      const path = join(proj, `${id}.jsonl`);
      writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return path;
    },
  };
}

test("listSessions 返回会话并抽取首条用户预览", () => {
  const { configDir, writeSession } = fixture();
  writeSession("s1", [
    { type: "user", message: { role: "user", content: "帮我看下内存占用" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } },
  ]);
  const sessions = listSessions(configDir, PROJ);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.sessionId, "s1");
  assert.match(sessions[0]!.preview, /内存占用/);
});

test("readSession 解析 string 与 block 数组两种 content", () => {
  const { configDir, writeSession } = fixture();
  writeSession("s1", [
    { type: "user", message: { role: "user", content: "你好" } },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "你好呀" }] },
    },
    { type: "result", subtype: "success", result: "完成了", is_error: false },
  ]);
  const entries = readSession(configDir, PROJ, "s1");
  assert.equal(entries[0]!.role, "user");
  assert.equal(entries[0]!.text, "你好");
  assert.equal(entries[1]!.role, "assistant");
  assert.equal(entries[1]!.text, "你好呀");
  assert.equal(entries[2]!.role, "result");
  assert.equal(entries[2]!.text, "完成了");
});

test("readSession 保留 tool_use/tool_result,结果块配回工具名", () => {
  const { configDir, writeSession } = fixture();
  writeSession("s1", [
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "我看一下" },
          { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "df -h", description: "看磁盘" } },
        ],
      },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "/dev/sda1  20G  8G" }] },
    },
  ]);
  const entries = readSession(configDir, PROJ, "s1");
  assert.equal(entries.length, 2);

  // 助手这条:文本仍是文本,工具调用另存一块
  assert.equal(entries[0]!.text, "我看一下");
  const use = entries[0]!.blocks!;
  assert.equal(use.length, 1);
  assert.equal(use[0]!.kind, "tool_use");
  assert.equal(use[0]!.label, "Bash");
  assert.equal(use[0]!.summary, "df -h", "摘要取 command 而不是整个 JSON");
  assert.match(use[0]!.detail, /"description": "看磁盘"/, "展开能看到完整入参");

  // 工具结果这条:文本为空,但不再是空盒子
  assert.equal(entries[1]!.text, "");
  const res = entries[1]!.blocks!;
  assert.equal(res[0]!.kind, "tool_result");
  assert.equal(res[0]!.label, "Bash 结果", "tool_use_id 配回了工具名");
  assert.match(res[0]!.detail, /dev\/sda1/);
  assert.equal(res[0]!.isError, undefined);
});

test("失败的工具结果带 isError,拿不到工具名时退回泛称", () => {
  const { configDir, writeSession } = fixture();
  writeSession("s1", [
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "无主的id", content: "boom", is_error: true }] },
    },
  ]);
  const b = readSession(configDir, PROJ, "s1")[0]!.blocks![0]!;
  assert.equal(b.isError, true);
  assert.equal(b.label, "工具 结果");
});

test("thinking 块被保留成折叠块", () => {
  const { configDir, writeSession } = fixture();
  writeSession("s1", [
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "先看日志\n再决定", signature: "x" }] } },
  ]);
  const entries = readSession(configDir, PROJ, "s1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.blocks![0]!.kind, "thinking");
  assert.equal(entries[0]!.blocks![0]!.summary, "先看日志 再决定", "摘要压成一行");
  assert.equal(entries[0]!.blocks![0]!.detail, "先看日志\n再决定");
});

test("既无文本也无块的行被丢弃(元信息行不渲染成空盒子)", () => {
  const { configDir, writeSession } = fixture();
  writeSession("s1", [
    { type: "queue-operation", op: "enqueue" },
    { type: "assistant", message: { content: [] } },
    { type: "user", message: { content: "真的有话" } },
  ]);
  const entries = readSession(configDir, PROJ, "s1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.text, "真的有话");
});

test("超长工具输出被截断且说明还剩多少", () => {
  const { configDir, writeSession } = fixture();
  writeSession("s1", [
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(100_050) }] },
    },
  ]);
  const b = readSession(configDir, PROJ, "s1")[0]!.blocks![0]!;
  assert.match(b.detail, /还有 50 字符未显示/);
  assert.ok(b.detail.length < 100_100);
});

test("脏行被跳过而非崩溃", () => {
  const { configDir } = fixture();
  const proj = join(configDir, "projects", "-data-workspace");
  writeFileSync(
    join(proj, "s1.jsonl"),
    ['not json at all', JSON.stringify({ type: "user", message: { content: "有效" } }), ""].join("\n"),
  );
  const entries = readSession(configDir, PROJ, "s1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.text, "有效");
});

test("search 命中文本并返回片段", () => {
  const { configDir, writeSession } = fixture();
  writeSession("s1", [{ type: "user", message: { content: "重启一下 dnsmasq 服务" } }]);
  writeSession("s2", [{ type: "user", message: { content: "查看磁盘空间" } }]);
  const hits = search(configDir, PROJ, "dnsmasq");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.sessionId, "s1");
  assert.match(hits[0]!.snippet, /dnsmasq/);
});

test("cleanupOldSessions 按 mtime 删除超期文件", () => {
  const { configDir, writeSession } = fixture();
  const oldPath = writeSession("old", [{ type: "user", message: { content: "旧" } }]);
  writeSession("new", [{ type: "user", message: { content: "新" } }]);
  // 把 old 的 mtime 设到 40 天前
  const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
  utimesSync(oldPath, new Date(fortyDaysAgo), new Date(fortyDaysAgo));

  const deleted = cleanupOldSessions(configDir, PROJ, 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(deleted, ["old"]);
  assert.equal(existsSync(oldPath), false);
  assert.equal(listSessions(configDir, PROJ).length, 1);
});

test("空目录 / 不存在的 configDir 不报错", () => {
  assert.deepEqual(listSessions(join(tmpdir(), "catman-nope-xyz"), PROJ), []);
});

test("清理只作用于本 project 目录,绝不碰其它项目(安全约束)", () => {
  const { configDir } = fixture();
  // 另一个项目目录,放一个 40 天前的旧会话 —— 不属于 catman,必须保留
  const other = join(configDir, "projects", "-Users-x-real-project");
  mkdirSync(other, { recursive: true });
  const otherOld = join(other, "important.jsonl");
  writeFileSync(otherOld, JSON.stringify({ type: "user", message: { content: "别删我" } }) + "\n");
  const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
  utimesSync(otherOld, new Date(fortyDaysAgo), new Date(fortyDaysAgo));

  // 对 catman 自己的 PROJ 跑清理
  const deleted = cleanupOldSessions(configDir, PROJ, 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(deleted, []); // catman 自己没有过期会话
  assert.equal(existsSync(otherOld), true); // 别的项目的旧会话原封不动
});

// --- 多用户:跨 project 目录聚合 ---

const DAY = 24 * 60 * 60 * 1000;

/** 造多个用户各自的 project 目录。 */
function multiFixture() {
  const configDir = mkdtempSync(join(tmpdir(), "catman-tc-multi-"));
  return {
    configDir,
    writeSession(projectDir: string, id: string, content: string, mtimeMs?: number): string {
      const dir = join(configDir, "projects", projectDir);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${id}.jsonl`);
      writeFileSync(path, JSON.stringify({ type: "user", message: { content } }) + "\n");
      if (mtimeMs !== undefined) utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
      return path;
    },
  };
}

const SCOPES = [
  { projectDir: "-data-workspace-alice-1111", userKey: "wechat:a:alice" },
  { projectDir: "-data-workspace-bob-2222", userKey: "wechat:b:bob" },
];

test("listSessionsAcross 汇总多个用户的会话并标注归属", () => {
  const { configDir, writeSession } = multiFixture();
  writeSession(SCOPES[0]!.projectDir, "s-alice", "alice 的会话");
  writeSession(SCOPES[1]!.projectDir, "s-bob", "bob 的会话");

  const all = listSessionsAcross(configDir, SCOPES);
  assert.equal(all.length, 2);
  assert.equal(all.find((s) => s.sessionId === "s-alice")?.userKey, "wechat:a:alice");
  assert.equal(all.find((s) => s.sessionId === "s-bob")?.userKey, "wechat:b:bob");
});

test("searchAcross 跨用户检索并遵守 maxHits", () => {
  const { configDir, writeSession } = multiFixture();
  writeSession(SCOPES[0]!.projectDir, "s1", "重启 dnsmasq");
  writeSession(SCOPES[1]!.projectDir, "s2", "也要重启 dnsmasq");

  assert.equal(searchAcross(configDir, SCOPES, "dnsmasq").length, 2);
  assert.equal(searchAcross(configDir, SCOPES, "dnsmasq", 1).length, 1);
  assert.equal(searchAcross(configDir, SCOPES, "不存在的词").length, 0);
});

test("cleanupOldSessionsAcross 清理各用户的过期会话", () => {
  const { configDir, writeSession } = multiFixture();
  const old1 = writeSession(SCOPES[0]!.projectDir, "old1", "旧", Date.now() - 40 * DAY);
  const old2 = writeSession(SCOPES[1]!.projectDir, "old2", "旧", Date.now() - 40 * DAY);
  const fresh = writeSession(SCOPES[1]!.projectDir, "fresh", "新");

  const deleted = cleanupOldSessionsAcross(configDir, SCOPES, 30 * DAY);
  assert.deepEqual(deleted.sort(), ["old1", "old2"]);
  assert.equal(existsSync(old1), false);
  assert.equal(existsSync(old2), false);
  assert.equal(existsSync(fresh), true);
});

test("跨目录清理仍绝不触碰 scope 之外的 project(多用户版安全约束)", () => {
  const { configDir, writeSession } = multiFixture();
  writeSession(SCOPES[0]!.projectDir, "old1", "旧", Date.now() - 40 * DAY);
  // 同一个 projects/ 下另一个与 catman 无关的项目,同样是 40 天前的旧会话。
  // scope 由 workspace 目录精确算出,不含它 —— 必须原封不动。
  const outsider = writeSession("-Users-x-real-project", "important", "别删我", Date.now() - 40 * DAY);

  const deleted = cleanupOldSessionsAcross(configDir, SCOPES, 30 * DAY);
  assert.deepEqual(deleted, ["old1"]);
  assert.equal(existsSync(outsider), true);
});

test("跨目录函数在 scope 为空时返回空,不做任何全局扫描", () => {
  const { configDir, writeSession } = multiFixture();
  const outsider = writeSession("-Users-x-real-project", "important", "别删我", Date.now() - 40 * DAY);

  assert.deepEqual(listSessionsAcross(configDir, []), []);
  assert.deepEqual(searchAcross(configDir, [], "别删我"), []);
  assert.deepEqual(cleanupOldSessionsAcross(configDir, [], 30 * DAY), []);
  assert.equal(existsSync(outsider), true);
});
