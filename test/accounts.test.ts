import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountStore,
  defaultAccountName,
  normalizeAccountName,
  type Account,
} from "../src/core/accounts.js";

const tempDirs: string[] = [];

function make() {
  const root = mkdtempSync(join(tmpdir(), "catman-accounts-"));
  tempDirs.push(root);
  const path = join(root, "accounts.json");
  const store = new AccountStore(path, () => 1000);
  return { store, path };
}

function account(over: Partial<Account> = {}): Account {
  return {
    accountId: "a1",
    channel: "wechat",
    botToken: "secret",
    baseUrl: "https://x",
    botId: "b1",
    displayName: defaultAccountName("a1"),
    createdAt: 1000,
    ...over,
  };
}

test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test("备注名去空白、超长截断", () => {
  assert.equal(normalizeAccountName("  老王的微信  ", "a1"), "老王的微信");
  const long = "名".repeat(100);
  const got = normalizeAccountName(long, "a1");
  assert.equal(got.length, 65, "64 字 + 省略号");
  assert.ok(got.endsWith("…"));
});

test("备注名留空回落到默认名 —— 账号总有 accountId 兜底,不必像展示名那样报错", () => {
  assert.equal(normalizeAccountName("", "a1"), defaultAccountName("a1"));
  assert.equal(normalizeAccountName("   ", "a1"), defaultAccountName("a1"));
});

test("rename 改名并落盘", () => {
  const { store, path } = make();
  store.add(account());
  assert.equal(store.rename("a1", "老王的微信"), true);
  assert.equal(store.get("a1")?.displayName, "老王的微信");
  // 重开 = 进程重启,名字要还在。
  assert.equal(new AccountStore(path).get("a1")?.displayName, "老王的微信");
});

test("rename 传空串恢复默认名", () => {
  const { store } = make();
  store.add(account({ displayName: "老王的微信" }));
  store.rename("a1", "");
  assert.equal(store.get("a1")?.displayName, defaultAccountName("a1"));
});

test("rename 不存在的账号返回 false", () => {
  const { store } = make();
  assert.equal(store.rename("nope", "x"), false);
});

test("改名不影响绑定与凭据", () => {
  const { store } = make();
  store.add(account({ boundUserId: "u@im.wechat" }));
  store.rename("a1", "换个名字");
  const a = store.get("a1")!;
  assert.equal(a.boundUserId, "u@im.wechat");
  assert.equal(a.botToken, "secret");
});

test("公开视图带备注名但不带 botToken", () => {
  const { store } = make();
  store.add(account({ displayName: "老王的微信" }));
  const pub = store.listPublic()[0]!;
  assert.equal(pub.displayName, "老王的微信");
  assert.ok(!("botToken" in pub));
});
