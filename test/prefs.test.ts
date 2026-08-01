import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrefsStore } from "../src/core/prefs.js";
import { GlobalSettings, type SettingsPatch } from "../src/core/settings.js";
import { loadConfig, type Config } from "../src/config.js";

const U = "stdin:local:u1";
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

function make(globals?: SettingsPatch, rawPrefs?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "catman-prefs-"));
  tempDirs.push(root);
  const settings = new GlobalSettings({ path: join(root, "settings.json"), env: baseConfig() });
  if (globals) settings.set(globals);
  const path = join(root, "prefs.json");
  if (rawPrefs !== undefined) writeFileSync(path, JSON.stringify(rawPrefs), "utf8");
  const prefs = new PrefsStore({ path, defaults: () => settings.effective() });
  return { prefs, settings, path };
}

test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test("三层分层:没设过就跟全局默认,设过就用自己的", () => {
  const { prefs, settings } = make({ ackEnabled: false });
  assert.equal(prefs.effective(U).ackEnabled, false, "跟随全局默认");

  prefs.set(U, { ackEnabled: true });
  assert.equal(prefs.effective(U).ackEnabled, true, "自己的覆盖优先");

  // defaults 是函数不是快照:改全局后,未覆盖的项要立刻跟随。
  settings.set({ maxReplyChars: 500 });
  assert.equal(prefs.effective(U).maxReplyChars, 500);
});

test("null 清除覆盖,回到全局默认", () => {
  const { prefs, settings } = make({ model: "opus" });
  prefs.set(U, { model: "sonnet" });
  assert.equal(prefs.effective(U).model, "sonnet");
  prefs.set(U, { model: null });
  assert.deepEqual(prefs.get(U), {});
  assert.equal(prefs.effective(U).model, "opus");
});

test("覆盖全清后不在盘上留空对象", () => {
  const { prefs, path } = make();
  prefs.set(U, { ackEnabled: false });
  prefs.set(U, { ackEnabled: null });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {});
});

test("非法模型在写入时被拒,并列出可选项", () => {
  const { prefs } = make();
  assert.throws(() => prefs.set(U, { model: "gpt-4" }), /不支持的模型.*opus/s);
  assert.deepEqual(prefs.get(U), {}, "拒绝的写入不该落盘");
});

test("全局项不能从每用户接口改", () => {
  const { prefs } = make();
  assert.throws(
    () => prefs.set(U, { maxConcurrentTurns: 5 } as never),
    /不是可自助修改的配置项/,
  );
});

// --- 兜底原则:回落但不改盘 ---

test("白名单收窄后回落到全局默认,盘上的选择保留", () => {
  const { prefs, settings } = make({ model: "opus" });
  prefs.set(U, { model: "sonnet" });

  settings.set({ modelAllowlist: ["opus"] });
  assert.equal(prefs.effective(U).model, "opus", "失效的覆盖应当回落");
  assert.deepEqual(prefs.get(U), { model: "sonnet" }, "但不能改盘 —— 那会抹掉用户的意图");

  settings.set({ modelAllowlist: ["opus", "sonnet"] });
  assert.equal(prefs.effective(U).model, "sonnet", "加回来就自动恢复");
});

test("全局默认也失效时退到「不传 model」,不抛错", () => {
  const { prefs, settings } = make({ model: "opus" });
  prefs.set(U, { model: "sonnet" });
  settings.set({ modelAllowlist: ["haiku"] }); // 两级同时失效
  assert.equal(prefs.effective(U).model, undefined, "兜底链末端:交给 SDK 决定");
});

test("盘上是脏值时逐级回退,effective 永不抛", () => {
  const { prefs } = make({ maxReplyChars: 800 }, {
    [U]: { maxReplyChars: "很长", ackEnabled: null, model: 42, sessionTimeoutMs: 12 },
  });
  const e = prefs.effective(U);
  assert.equal(e.maxReplyChars, 800, "坏值退到全局默认");
  assert.equal(e.ackEnabled, true);
  assert.equal(e.model, undefined);
  assert.equal(e.sessionTimeoutMs, 60_000, "数字越界被夹到下限,而不是当坏值丢弃");
});

test("整个 prefs.json 损坏时所有人都退到全局默认", () => {
  const root = mkdtempSync(join(tmpdir(), "catman-prefs-bad-"));
  tempDirs.push(root);
  const settings = new GlobalSettings({ path: join(root, "settings.json"), env: baseConfig() });
  const path = join(root, "prefs.json");
  writeFileSync(path, "not json at all", "utf8");
  const prefs = new PrefsStore({ path, defaults: () => settings.effective() });
  assert.equal(prefs.effective(U).ackEnabled, true);
  assert.deepEqual(prefs.get(U), {});
});

test("clear 清掉某人的全部覆盖(管理员恢复通道)", () => {
  const { prefs } = make();
  prefs.set(U, { model: "sonnet", ackEnabled: false });
  prefs.clear(U);
  assert.deepEqual(prefs.get(U), {});
  assert.equal(prefs.effective(U).ackEnabled, true);
});

test("用户之间互不影响", () => {
  const { prefs } = make();
  prefs.set(U, { model: "sonnet" });
  prefs.set("stdin:local:u2", { model: "haiku" });
  assert.equal(prefs.effective(U).model, "sonnet");
  assert.equal(prefs.effective("stdin:local:u2").model, "haiku");
  assert.deepEqual(Object.keys(prefs.snapshot()).sort(), ["stdin:local:u1", "stdin:local:u2"]);
});
