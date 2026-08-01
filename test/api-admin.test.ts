import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAdminApi, isAdminApiPath, type AdminApiDeps } from "../src/dashboard/api-admin.js";
import { GlobalSettings } from "../src/core/settings.js";
import { PrefsStore } from "../src/core/prefs.js";
import { UserRegistry } from "../src/core/users.js";
import { BUILTIN_ADMIN_USER_KEY } from "../src/core/identity.js";
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
  const root = mkdtempSync(join(tmpdir(), "catman-apiadmin-"));
  tempDirs.push(root);
  const settings = new GlobalSettings({ path: join(root, "settings.json"), env: baseConfig() });
  const prefs = new PrefsStore({
    path: join(root, "prefs.json"),
    defaults: () => settings.effective(),
  });
  const users = new UserRegistry({
    path: join(root, "users.json"),
    workspaceRoot: join(root, "workspace"),
  });
  users.ensureWorkspace(A);
  users.ensureWorkspace(B);
  const deps: AdminApiDeps = { settings, prefs, users };
  return { deps, settings, prefs, users };
}

const call = (method: string, path: string, body: unknown, deps: AdminApiDeps) =>
  handleAdminApi(method, path, body, deps);

test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test("认领的路径前缀", () => {
  assert.equal(isAdminApiPath("/api/settings"), true);
  assert.equal(isAdminApiPath("/api/users"), true);
  assert.equal(isAdminApiPath("/api/users/stdin:local:alice"), true);
  assert.equal(isAdminApiPath("/api/me"), false);
  assert.equal(isAdminApiPath("/api/accounts"), false);
});

test("GET /api/settings 返回生效值、覆盖项与 schema", () => {
  const { deps } = make();
  const r = call("GET", "/api/settings", undefined, deps);
  assert.equal(r.status, 200);
  const b = r.body as Record<string, unknown>;
  assert.deepEqual(b["overrides"], {});
  assert.ok(Array.isArray(b["schema"]));
});

test("PATCH 改全局默认:未覆盖的用户跟着变,设过的人不受影响", () => {
  const { deps, prefs } = make();
  prefs.set(A, { model: "sonnet" });
  const r = call("PATCH", "/api/settings", { model: "opus" }, deps);
  assert.equal(r.status, 200);
  assert.equal(prefs.effective(B).model, "opus", "没设过的人跟随全局默认");
  assert.equal(prefs.effective(A).model, "sonnet", "设过的人保持自己的选择");
});

test("改白名单不必管存量用户 —— 读取侧自动回退", () => {
  const { deps, prefs } = make();
  call("PATCH", "/api/settings", { model: "opus" }, deps);
  prefs.set(A, { model: "sonnet" });

  // 这一步不做任何交叉校验,也不该失败。
  const r = call("PATCH", "/api/settings", { modelAllowlist: ["opus"] }, deps);
  assert.equal(r.status, 200);
  assert.equal(prefs.effective(A).model, "opus");
  assert.deepEqual(prefs.get(A), { model: "sonnet" }, "盘上保留,加回来会恢复");
});

test("非法值 400,错误文案可直接转述", () => {
  const { deps } = make();
  const r = call("PATCH", "/api/settings", { maxConcurrentTurns: "五个" }, deps);
  assert.equal(r.status, 400);
  assert.match((r.body as { error: string }).error, /数字/);
});

test("GET /api/users 带出每个人的生效配置与管理员标记", () => {
  const { deps, settings } = make();
  settings.set({ adminUserKeys: [A] });
  const r = call("GET", "/api/users", undefined, deps);
  assert.equal(r.status, 200);
  const rows = r.body as Array<Record<string, unknown>>;
  const alice = rows.find((x) => x["userKey"] === A)!;
  assert.equal(alice["isAdmin"], true);
  assert.ok(alice["prefs"]);
});

test("代改他人配置(管理员的恢复通道)", () => {
  const { deps, prefs } = make();
  prefs.set(A, { model: "sonnet", ackEnabled: false });
  const r = call("PATCH", `/api/users/${encodeURIComponent(A)}`, { model: null }, deps);
  assert.equal(r.status, 200);
  assert.deepEqual(prefs.get(A), { ackEnabled: false }, "只清掉指定的那一项");
});

test("clear:true 清掉某人的全部覆盖", () => {
  const { deps, prefs } = make();
  prefs.set(A, { model: "sonnet", ackEnabled: false });
  const r = call("PATCH", `/api/users/${encodeURIComponent(A)}`, { clear: true }, deps);
  assert.equal(r.status, 200);
  assert.deepEqual(prefs.get(A), {});
});

test("代改不存在的用户 404", () => {
  const { deps } = make();
  assert.equal(call("PATCH", "/api/users/stdin:local:nobody", { model: null }, deps).status, 404);
});

test("全局项不能从 /api/users 改(提示去正确的地方)", () => {
  const { deps } = make();
  const r = call("PATCH", `/api/users/${encodeURIComponent(A)}`, { maxConcurrentTurns: 4 }, deps);
  assert.equal(r.status, 400);
  assert.match((r.body as { error: string }).error, /\/api\/settings/);
});

test("管理员名单可增可删,但内置管理员不可写入", () => {
  const { deps, settings } = make();
  call("PATCH", "/api/settings", { adminUserKeys: [A] }, deps);
  assert.equal(settings.isAdmin(A), true);

  call("PATCH", "/api/settings", { adminUserKeys: [] }, deps);
  assert.equal(settings.isAdmin(A), false);
  assert.equal(settings.isAdmin(BUILTIN_ADMIN_USER_KEY), true, "恢复通道不可撤销");

  const r = call("PATCH", "/api/settings", { adminUserKeys: [BUILTIN_ADMIN_USER_KEY] }, deps);
  assert.equal(r.status, 400);
});

test("未知方法/路径 404", () => {
  const { deps } = make();
  assert.equal(call("DELETE", "/api/settings", undefined, deps).status, 404);
  assert.equal(call("POST", "/api/users", undefined, deps).status, 404);
});

// --- 提权 ---

test("PATCH admin:true 把人加进管理员名单,false 拿掉", () => {
  const { deps, settings } = make();
  const r = call("PATCH", `/api/users/${A}`, { admin: true }, deps);
  assert.equal(r.status, 200);
  assert.equal((r.body as { isAdmin: boolean }).isAdmin, true);
  assert.deepEqual(settings.effective().adminUserKeys, [A]);

  call("PATCH", `/api/users/${A}`, { admin: false }, deps);
  assert.deepEqual(settings.effective().adminUserKeys, []);
});

test("提权由服务端照当前名单增删 —— 不要求调用方提交整份,免得互相覆盖", () => {
  const { deps, settings } = make();
  // 两个"客户端"各自只表达自己的意图,没人读过对方写的名单。
  call("PATCH", `/api/users/${A}`, { admin: true }, deps);
  call("PATCH", `/api/users/${B}`, { admin: true }, deps);
  assert.deepEqual(settings.effective().adminUserKeys.sort(), [A, B].sort());
});

test("重复提权是幂等的,名单里不会出现两份", () => {
  const { deps, settings } = make();
  call("PATCH", `/api/users/${A}`, { admin: true }, deps);
  call("PATCH", `/api/users/${A}`, { admin: true }, deps);
  assert.deepEqual(settings.effective().adminUserKeys, [A]);
});

test("内置管理员不可撤销 —— 那是配置改坏后的恢复通道", () => {
  const { deps, settings, users } = make();
  users.ensureWorkspace(BUILTIN_ADMIN_USER_KEY);
  const r = call("PATCH", `/api/users/${BUILTIN_ADMIN_USER_KEY}`, { admin: false }, deps);
  assert.equal(r.status, 400);
  assert.match((r.body as { error: string }).error, /不可撤销/);
  assert.equal(settings.isAdmin(BUILTIN_ADMIN_USER_KEY), true);
});

test("给内置管理员 admin:true 是空操作,不会把它写进名单", () => {
  const { deps, settings, users } = make();
  users.ensureWorkspace(BUILTIN_ADMIN_USER_KEY);
  const r = call("PATCH", `/api/users/${BUILTIN_ADMIN_USER_KEY}`, { admin: true }, deps);
  assert.equal(r.status, 200);
  // schema 的 validate 本就拒收它 —— 走到那一步会 400,所以这里必须提前短路。
  assert.deepEqual(settings.effective().adminUserKeys, []);
});

test("admin 不是布尔值就整批拒绝,权限和配置都不动", () => {
  const { deps, settings, prefs } = make();
  const r = call("PATCH", `/api/users/${A}`, { admin: "yes", model: "sonnet" }, deps);
  assert.equal(r.status, 400);
  assert.deepEqual(settings.effective().adminUserKeys, []);
  assert.deepEqual(prefs.get(A), {}, "整批拒绝,不能改一半");
});

test("提权与改配置可以同一批完成", () => {
  const { deps, settings, prefs } = make();
  const r = call("PATCH", `/api/users/${A}`, { admin: true, model: "sonnet" }, deps);
  assert.equal(r.status, 200);
  assert.equal(settings.isAdmin(A), true);
  assert.equal(prefs.effective(A).model, "sonnet");
});
