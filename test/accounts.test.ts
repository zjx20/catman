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

// --- 重新扫码 ---

const newCred = { botToken: "fresh", baseUrl: "https://y", botId: "b2" };

test("重新扫码换凭据,但 accountId / 备注名 / 绑定关系原样保留 —— 用户的会话与目录靠它续上", () => {
  const { store, path } = make();
  store.add(account({ displayName: "老王的微信", boundUserId: "u@im.wechat" }));
  assert.equal(store.replaceCredentials("a1", newCred), true);

  const a = store.get("a1")!;
  assert.equal(a.botToken, "fresh");
  assert.equal(a.baseUrl, "https://y");
  assert.equal(a.botId, "b2");
  assert.equal(a.accountId, "a1", "换了 accountId 就等于换了 userKey,那位用户会变成新人");
  assert.equal(a.displayName, "老王的微信");
  assert.equal(a.boundUserId, "u@im.wechat");
  // 重启后凭据要还是新的。
  assert.equal(new AccountStore(path).get("a1")?.botToken, "fresh");
});

test("重新扫码要重建连接 —— 集合没变,但那条连接握着作废的 token", () => {
  const { store } = make();
  store.add(account());
  let fired = 0;
  store.onConnectionSetChanged(() => (fired += 1));
  store.replaceCredentials("a1", newCred);
  assert.equal(fired, 1);
});

test("重新扫码清掉失效标记", () => {
  const { store } = make();
  store.add(account());
  store.markExpired("a1");
  assert.equal(store.get("a1")?.expiredAt, 1000);
  store.replaceCredentials("a1", newCred);
  assert.equal(store.get("a1")?.expiredAt, undefined);
});

test("失效时刻只记第一次 —— 之后的重连报错不该把它刷成「刚刚」", () => {
  const root = mkdtempSync(join(tmpdir(), "catman-accounts-"));
  tempDirs.push(root);
  let clock = 1000;
  const store = new AccountStore(join(root, "accounts.json"), () => clock);
  store.add(account());
  store.markExpired("a1");
  clock = 9999;
  store.markExpired("a1");
  assert.equal(store.get("a1")?.expiredAt, 1000);
});

test("重新扫码后换了对端标识:第一条来信被归并到原主人,userKey 因此不变", () => {
  const { store } = make();
  store.add(account({ boundUserId: "old@im.wechat" }));
  store.replaceCredentials("a1", newCred);

  // 认领与命中必须在**同一条**来信上完成,否则第一条消息会开出一个空白用户。
  assert.equal(store.canonicalUserId("a1", "new@im.wechat"), "old@im.wechat");
  // 之后每条都照旧归并。
  assert.equal(store.canonicalUserId("a1", "new@im.wechat"), "old@im.wechat");
  assert.equal(store.get("a1")?.pendingRebind, undefined, "认领只发生一次");
});

test("重新扫码后标识没变:什么都不发生,别名表保持为空", () => {
  const { store } = make();
  store.add(account({ boundUserId: "u@im.wechat" }));
  store.replaceCredentials("a1", newCred);
  assert.equal(store.canonicalUserId("a1", "u@im.wechat"), "u@im.wechat");
  assert.equal(store.get("a1")?.userIdAliases, undefined);
  assert.equal(store.get("a1")?.pendingRebind, undefined);
});

test("认领只在重新扫码之后开一次窗:平时的来信一律原样返回", () => {
  const { store } = make();
  store.add(account({ boundUserId: "u@im.wechat" }));
  assert.equal(store.canonicalUserId("a1", "someone@im.wechat"), "someone@im.wechat");
  assert.equal(store.get("a1")?.userIdAliases, undefined);
});

test("未绑定的账号重新扫码不置待认领 —— 它下一条来信本来就走 TOFU", () => {
  const { store } = make();
  store.add(account());
  store.replaceCredentials("a1", newCred);
  assert.equal(store.get("a1")?.pendingRebind, undefined);
  assert.equal(store.canonicalUserId("a1", "whoever@im.wechat"), "whoever@im.wechat");
});

test("别名跨重启有效 —— 否则重启后那位用户又变回新人", () => {
  const { store, path } = make();
  store.add(account({ boundUserId: "old@im.wechat" }));
  store.replaceCredentials("a1", newCred);
  store.canonicalUserId("a1", "new@im.wechat");
  assert.equal(new AccountStore(path).canonicalUserId("a1", "new@im.wechat"), "old@im.wechat");
});

test("unbind 清空别名与待认领 —— 它的语义是换人,旧主人的别名不该继续生效", () => {
  const { store } = make();
  store.add(account({ boundUserId: "old@im.wechat" }));
  store.replaceCredentials("a1", newCred);
  store.canonicalUserId("a1", "new@im.wechat");

  store.unbind("a1");
  assert.equal(store.canonicalUserId("a1", "new@im.wechat"), "new@im.wechat");
  assert.equal(store.get("a1")?.userIdAliases, undefined);
});

test("不存在的账号:替换凭据返回 false,归一化原样返回", () => {
  const { store } = make();
  assert.equal(store.replaceCredentials("nope", newCred), false);
  assert.equal(store.canonicalUserId("nope", "u@im.wechat"), "u@im.wechat");
});
