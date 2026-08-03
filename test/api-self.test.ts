import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSelfApi, isSelfApiPath, type SelfApiDeps } from "../src/dashboard/api-self.js";
import { GlobalSettings } from "../src/core/settings.js";
import { PrefsStore } from "../src/core/prefs.js";
import { TurnTokens } from "../src/core/turn-tokens.js";
import { SessionManager, InMemoryStore } from "../src/core/session.js";
import { UserRegistry } from "../src/core/users.js";
import { loadConfig, type Config } from "../src/config.js";

const A = "stdin:local:alice";
const B = "stdin:local:bob";
const tempDirs: string[] = [];

function baseConfig(): Config {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("CATMAN_")) delete process.env[k];
  }
  const cfg = loadConfig();
  process.env = saved;
  return cfg;
}

function make() {
  const root = mkdtempSync(join(tmpdir(), "catman-apiself-"));
  tempDirs.push(root);
  const settings = new GlobalSettings({ path: join(root, "settings.json"), env: baseConfig() });
  const prefs = new PrefsStore({
    path: join(root, "prefs.json"),
    defaults: () => settings.effective(),
  });
  const sessions = new SessionManager({ store: new InMemoryStore(), timeoutMs: 3600_000 });
  const users = new UserRegistry({
    path: join(root, "users.json"),
    workspaceRoot: join(root, "workspace"),
  });
  users.ensureWorkspace(A);
  users.ensureWorkspace(B);
  const turns = new TurnTokens();
  const deps: SelfApiDeps = {
    turns,
    prefs,
    users,
    sessions,
    settings,
    configDir: join(root, "claude"),
  };
  return { deps, turns, prefs, users, settings, sessions };
}

const call = (
  method: string,
  path: string,
  token: string | undefined,
  body: unknown,
  deps: SelfApiDeps,
) => handleSelfApi(method, path, token, body, deps);

test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test("认领的路径前缀", () => {
  assert.equal(isSelfApiPath("/api/me"), true);
  assert.equal(isSelfApiPath("/api/me/sessions"), true);
  assert.equal(isSelfApiPath("/api/mexico"), false);
  assert.equal(isSelfApiPath("/api/settings"), false);
});

test("无令牌 / 伪造令牌一律 401", () => {
  const { deps } = make();
  assert.equal(call("GET", "/api/me", undefined, undefined, deps).status, 401);
  assert.equal(call("GET", "/api/me", "伪造", undefined, deps).status, 401);
});

test("回合结束后令牌立即失效", () => {
  const { deps, turns } = make();
  const turn = turns.mint(A);
  assert.equal(call("GET", "/api/me", turn.token, undefined, deps).status, 200);
  turn.revoke();
  assert.equal(call("GET", "/api/me", turn.token, undefined, deps).status, 401);
});

test("GET 返回身份、会话、生效配置与 schema", () => {
  const { deps, turns, sessions } = make();
  sessions.record(A, "sess-A");
  const r = call("GET", "/api/me", turns.mint(A).token, undefined, deps);
  assert.equal(r.status, 200);
  const b = r.body as Record<string, Record<string, unknown>>;
  assert.equal(b["identity"]!["userKey"], A);
  assert.equal(b["identity"]!["isAdmin"], false);
  assert.equal(b["session"]!["sessionId"], "sess-A");
  assert.equal(b["session"]!["willResume"], true);
  assert.ok(Array.isArray(b["schema"]), "agent 靠 schema 知道能改什么,不必猜");
  assert.ok(Array.isArray(b["commands"]));
});

test("PATCH 改自己的配置,返回生效值", () => {
  const { deps, turns, prefs } = make();
  const r = call("PATCH", "/api/me", turns.mint(A).token, { model: "sonnet" }, deps);
  assert.equal(r.status, 200);
  assert.equal(prefs.effective(A).model, "sonnet");
});

test("越界数值返回夹住后的生效值,而不是回显入参", () => {
  const { deps, turns } = make();
  const r = call("PATCH", "/api/me", turns.mint(A).token, { maxReplyChars: 99999 }, deps);
  const b = r.body as { prefs: { effective: { maxReplyChars: number } } };
  assert.equal(b.prefs.effective.maxReplyChars, 5000, "agent 要照这个告诉用户");
});

test("非法模型 400 且不落盘,错误文案列出可选项", () => {
  const { deps, turns, prefs } = make();
  const r = call("PATCH", "/api/me", turns.mint(A).token, { model: "gpt-4" }, deps);
  assert.equal(r.status, 400);
  assert.match((r.body as { error: string }).error, /opus/);
  assert.deepEqual(prefs.get(A), {});
});

test("核心隔离:A 的令牌改不到 B —— 接口根本没有「改谁」这个参数", () => {
  const { deps, turns, prefs } = make();
  // 就算把别人的 userKey 塞进请求体,也只会被当成未知字段拒掉。
  const r = call(
    "PATCH",
    "/api/me",
    turns.mint(A).token,
    { userKey: B, model: "sonnet" },
    deps,
  );
  assert.equal(r.status, 400);
  assert.deepEqual(prefs.get(B), {});
  assert.deepEqual(prefs.get(A), {}, "整批拒绝,不能改一半");
});

test("PATCH 可以改展示名", () => {
  const { deps, turns, users } = make();
  const r = call("PATCH", "/api/me", turns.mint(A).token, { displayName: "爱丽丝" }, deps);
  assert.equal(r.status, 200);
  assert.equal(users.get(A)?.displayName, "爱丽丝");
});

test("session/reset 当场生效:本回合切到后台,当前会话归档", () => {
  const { deps, turns, sessions } = make();
  sessions.record(A, "sess-A");
  const turn = turns.mint(A);
  const r = call("POST", "/api/me/session/reset", turn.token, undefined, deps);
  assert.equal(r.status, 200);
  // 两步与用户发 /新会话 完全一样:回合转后台(它的产出将进 history 而不是
  // current),当前会话就地归档。不再需要"打标记等回合收尾"——
  // detached 的回合本就不会写回 current。
  assert.equal(turn.ctx.detached, true);
  assert.equal(sessions.currentOf(A), undefined, "当前会话应当已经归档");
  assert.deepEqual(sessions.historyOf(A).map((h) => h.sessionId), ["sess-A"]);
});

test("请求体不是对象时 400", () => {
  const { deps, turns } = make();
  assert.equal(call("PATCH", "/api/me", turns.mint(A).token, "字符串", deps).status, 400);
  assert.equal(call("PATCH", "/api/me", turns.mint(A).token, [1, 2], deps).status, 400);
});

test("未知子路径 404(而不是被当成 /api/me)", () => {
  const { deps, turns } = make();
  assert.equal(call("GET", "/api/me/nope", turns.mint(A).token, undefined, deps).status, 404);
  assert.equal(call("DELETE", "/api/me", turns.mint(A).token, undefined, deps).status, 404);
});

test("历史会话接口只看自己的 scope", () => {
  const { deps, turns } = make();
  const r = call("GET", "/api/me/sessions", turns.mint(A).token, undefined, deps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [], "还没有会话记录时是空数组,不报错");
});

test("PATCH 是整批的:一项非法则任何一项都不生效", () => {
  const { deps, turns, prefs, users } = make();
  const before = users.get(A)!.displayName;
  const r = call(
    "PATCH",
    "/api/me",
    turns.mint(A).token,
    { displayName: "新名字", model: "gpt-4" },
    deps,
  );
  assert.equal(r.status, 400);
  assert.deepEqual(prefs.get(A), {});
  assert.equal(users.get(A)?.displayName, before, "名字不能被改了一半");
});
