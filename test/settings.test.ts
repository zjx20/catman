import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalSettings } from "../src/core/settings.js";
import { BUILTIN_ADMIN_USER_KEY } from "../src/core/identity.js";
import { loadConfig, type Config } from "../src/config.js";

const tempDirs: string[] = [];

/** 不受宿主环境变量影响的 env 基线。 */
function baseConfig(): Config {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("CATMAN_")) delete process.env[k];
  }
  const cfg = loadConfig();
  process.env = saved;
  return cfg;
}

function make(overrides?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "catman-settings-"));
  tempDirs.push(root);
  const path = join(root, "settings.json");
  if (overrides !== undefined) writeFileSync(path, JSON.stringify(overrides), "utf8");
  return { s: new GlobalSettings({ path, env: baseConfig() }), path, root };
}

test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test("默认值来自 env 基线,未覆盖时 overrides 为空", () => {
  const { s } = make();
  const e = s.effective();
  assert.deepEqual(e.modelAllowlist, ["opus", "sonnet", "haiku"]);
  assert.equal(e.maxConcurrentTurns, 2);
  assert.equal(e.model, undefined);
  assert.deepEqual(s.overrides(), {});
});

test("set 写覆盖,null 清覆盖后回到 env 基线", () => {
  const { s } = make();
  s.set({ maxConcurrentTurns: 5 });
  assert.equal(s.effective().maxConcurrentTurns, 5);
  assert.deepEqual(s.overrides(), { maxConcurrentTurns: 5 });

  s.set({ maxConcurrentTurns: null });
  assert.equal(s.effective().maxConcurrentTurns, 2);
  assert.deepEqual(s.overrides(), {});
});

test("越界的整数被夹住,而不是拒绝 —— 返回值即生效值", () => {
  const { s } = make();
  assert.equal(s.set({ maxConcurrentTurns: 999 }).maxConcurrentTurns, 16);
  assert.equal(s.set({ maxConcurrentTurns: 0 }).maxConcurrentTurns, 1);
});

test("非数字/错类型在写入时抛错,错误文案能直接念给用户", () => {
  const { s } = make();
  assert.throws(() => s.set({ maxConcurrentTurns: "很多" as never }), /数字/);
  assert.throws(() => s.set({ ackEnabled: "yes" as never }), /true 或 false/);
  assert.throws(() => s.set({ model: "gpt-4" }), /不支持的模型.*opus/s);
});

test("未知配置项被拒绝", () => {
  const { s } = make();
  assert.throws(() => s.set({ nope: 1 } as never), /未知配置项/);
});

test("同一次 PATCH 里既换白名单又换模型:按新白名单校验", () => {
  const { s } = make();
  // 若用旧白名单校验,这个本该成立的组合会被误判。
  const e = s.set({ modelAllowlist: ["fable"], model: "fable" });
  assert.equal(e.model, "fable");
  assert.deepEqual(e.modelAllowlist, ["fable"]);
});

test("兜底:整个 settings.json 损坏时全部回落 env,不抛错", () => {
  const root = mkdtempSync(join(tmpdir(), "catman-settings-bad-"));
  tempDirs.push(root);
  const path = join(root, "settings.json");
  writeFileSync(path, "{{{ 这不是 JSON", "utf8");
  const s = new GlobalSettings({ path, env: baseConfig() });
  const e = s.effective();
  assert.equal(e.maxConcurrentTurns, 2);
  assert.deepEqual(e.modelAllowlist, ["opus", "sonnet", "haiku"]);
});

test("兜底:盘上是坏值时逐级回退到 floor,effective 永不抛", () => {
  // 手改过文件、或旧版本写进去的脏值 —— 读取侧必须扛住。
  const { s } = make({
    maxConcurrentTurns: "八",
    modelAllowlist: [],
    ackEnabled: 1,
    retentionMs: null,
  });
  const e = s.effective();
  assert.equal(e.maxConcurrentTurns, 2, "坏值退到 env 基线");
  assert.deepEqual(e.modelAllowlist, ["opus", "sonnet", "haiku"], "空白名单无意义,当坏值处理");
  assert.equal(e.ackEnabled, true);
  assert.equal(e.retentionMs, 30 * 24 * 3600_000);
});

test("内置管理员永远是管理员,且无法被写进/移出名单", () => {
  const { s } = make();
  assert.equal(s.isAdmin(BUILTIN_ADMIN_USER_KEY), true);
  assert.equal(s.isAdmin("stdin:local:u1"), false);

  s.set({ adminUserKeys: ["stdin:local:u1"] });
  assert.equal(s.isAdmin("stdin:local:u1"), true);

  // 清空名单也影响不到内置管理员 —— 这是不可撤销的恢复通道。
  s.set({ adminUserKeys: null });
  assert.equal(s.isAdmin("stdin:local:u1"), false);
  assert.equal(s.isAdmin(BUILTIN_ADMIN_USER_KEY), true);

  // 也不接受把它写进列表(避免造成"能被移除"的错觉)。
  assert.throws(() => s.set({ adminUserKeys: [BUILTIN_ADMIN_USER_KEY] }), /userKey/);
});

test("adminUserKeys 拒绝非法 userKey", () => {
  const { s } = make();
  assert.throws(() => s.set({ adminUserKeys: ["裸用户名"] }), /userKey/);
});

test("onChange 在写入后触发,读取不触发", () => {
  const { s } = make();
  let n = 0;
  s.onChange(() => n++);
  s.effective();
  assert.equal(n, 0);
  s.set({ maxConcurrentTurns: 3 });
  assert.equal(n, 1);
});

test("回调抛错不影响写入本身", () => {
  const { s } = make();
  s.onChange(() => {
    throw new Error("boom");
  });
  assert.doesNotThrow(() => s.set({ maxConcurrentTurns: 4 }));
  assert.equal(s.effective().maxConcurrentTurns, 4);
});

test("覆盖持久化,重启后仍在", () => {
  const { s, path } = make();
  s.set({ model: "sonnet", maxConcurrentTurns: 7 });
  const again = new GlobalSettings({ path, env: baseConfig() });
  assert.equal(again.effective().model, "sonnet");
  assert.equal(again.effective().maxConcurrentTurns, 7);
});

test("图片上限:默认值来自 env 基线,可被全局覆盖", () => {
  const { s } = make();
  const base = s.effective();
  assert.equal(base.maxImageBytes, 3_500_000);
  assert.equal(base.maxImagesPerTurn, 4);

  s.set({ maxImageBytes: 1_000_000, maxImagesPerTurn: 2 });
  assert.equal(s.effective().maxImageBytes, 1_000_000);
  assert.equal(s.effective().maxImagesPerTurn, 2);
});

test("图片上限:越界 clamp 而不是拒绝", () => {
  // 整数项一律 clamp —— 返回值是生效后的值,agent 据此能如实告诉用户「已设为上限」。
  const { s } = make();
  assert.equal(s.set({ maxImagesPerTurn: 999 }).maxImagesPerTurn, 20);
  assert.equal(s.effective().maxImagesPerTurn, 20);
});

test("图片上限:坏值只让这一项回落,不波及别的项", () => {
  // 兜底优先于交叉校验:settings.json 被写坏也不能让 agent 起不来。
  const { s } = make({ maxImagesPerTurn: "不是数字", maxImageBytes: 2_000_000 });
  const eff = s.effective();
  assert.equal(eff.maxImagesPerTurn, 4, "坏值应回落到 env 基线");
  assert.equal(eff.maxImageBytes, 2_000_000, "同一份文件里的别的项不受影响");
});

test("apiBase 默认按容器名寻址,不是 127.0.0.1", () => {
  // 2026-08-21 会话容器化之后,127.0.0.1 对 agent 是错的 —— 每个回合跑在自己的
  // 容器里,127.0.0.1 指向那个容器自己。实测 HTTP 000 连不上,而 http://catman:8787
  // 是 401(正常鉴权响应)。受影响的不只 catman-notify,还有 catman-settings /
  // catman-admin / catman-cron 教着调的那些 API —— 它们会**静默失败**。
  const saved = { ...process.env };
  try {
    delete process.env.CATMAN_API_BASE;
    delete process.env.CATMAN_PERSONA;
    delete process.env.CATMAN_DASHBOARD_PORT;
    assert.equal(loadConfig().apiBase, "http://catman:8787");

    // 两个人格各自寻址自己的容器,别串台。
    process.env.CATMAN_PERSONA = "rescue";
    process.env.CATMAN_DASHBOARD_PORT = "8788";
    assert.equal(loadConfig().apiBase, "http://catman-rescue:8788");
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("容器名可以被环境覆盖 —— compose 改了名字得有地方改回来", () => {
  const saved = { ...process.env };
  try {
    delete process.env.CATMAN_API_BASE;
    process.env.CATMAN_CONTAINER_NAME = "别的名字";
    assert.match(loadConfig().apiBase, /^http:\/\/别的名字:/);
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
