import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, type Account } from "../src/core/accounts.js";
import { accountAdmission, allowAll } from "../src/core/admission.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "catman-acct-"));
  const path = join(root, "accounts.json");
  const store = new AccountStore(path, () => 1000);
  return { root, path, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function account(over: Partial<Account> = {}): Account {
  return {
    accountId: "acct1",
    channel: "wechat",
    botToken: "secret-token",
    baseUrl: "https://x",
    botId: "b1",
    displayName: "测试账号",
    createdAt: 0,
    ...over,
  };
}

test("TOFU:首条消息的发送者成为主人", () => {
  const { store, cleanup } = setup();
  try {
    store.add(account());
    const admit = accountAdmission(store);
    assert.deepEqual(admit("wechat:acct1:alice@im.wechat"), { ok: true });
    assert.equal(store.get("acct1")?.boundUserId, "alice@im.wechat");
  } finally {
    cleanup();
  }
});

test("绑定后拒绝其他人,并记录被拒来信", () => {
  const { store, cleanup } = setup();
  try {
    store.add(account({ boundUserId: "alice@im.wechat" }));
    const admit = accountAdmission(store);

    assert.deepEqual(admit("wechat:acct1:alice@im.wechat"), { ok: true });

    const verdict = admit("wechat:acct1:mallory@im.wechat");
    assert.equal(verdict.ok, false);
    assert.ok(!verdict.ok && verdict.reply);
    // 主人没有被改写。
    assert.equal(store.get("acct1")?.boundUserId, "alice@im.wechat");
    assert.deepEqual(store.get("acct1")?.rejections, [
      { userId: "mallory@im.wechat", count: 1, lastAt: 1000 },
    ]);
  } finally {
    cleanup();
  }
});

test("重复被拒按 userId 累加而不是无限追加", () => {
  const { store, cleanup } = setup();
  try {
    store.add(account({ boundUserId: "alice@im.wechat" }));
    const admit = accountAdmission(store);
    for (let i = 0; i < 5; i++) admit("wechat:acct1:mallory@im.wechat");
    const rejections = store.get("acct1")?.rejections ?? [];
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0]!.count, 5);
  } finally {
    cleanup();
  }
});

test("被拒记录有上限,不会无限增长", () => {
  const { store, cleanup } = setup();
  try {
    store.add(account({ boundUserId: "alice@im.wechat" }));
    const admit = accountAdmission(store);
    for (let i = 0; i < 50; i++) admit(`wechat:acct1:bad-${i}@im.wechat`);
    assert.ok((store.get("acct1")?.rejections ?? []).length <= 10);
  } finally {
    cleanup();
  }
});

test("bind 不覆盖已有绑定(换人必须先 unbind)", () => {
  const { store, cleanup } = setup();
  try {
    store.add(account({ boundUserId: "alice@im.wechat" }));
    assert.equal(store.bind("acct1", "mallory@im.wechat"), false);
    assert.equal(store.get("acct1")?.boundUserId, "alice@im.wechat");
  } finally {
    cleanup();
  }
});

test("unbind 后重新 TOFU 到新用户", () => {
  const { store, cleanup } = setup();
  try {
    store.add(account({ boundUserId: "alice@im.wechat" }));
    assert.equal(store.unbind("acct1"), true);
    const admit = accountAdmission(store);
    assert.deepEqual(admit("wechat:acct1:bob@im.wechat"), { ok: true });
    assert.equal(store.get("acct1")?.boundUserId, "bob@im.wechat");
  } finally {
    cleanup();
  }
});

test("账号不存在或 userKey 非法时拒绝且不回话", () => {
  const { store, cleanup } = setup();
  try {
    const admit = accountAdmission(store);
    const gone = admit("wechat:no-such-acct:u");
    assert.equal(gone.ok, false);
    assert.ok(!gone.ok && !gone.reply, "账号不存在应静默丢弃");

    const bad = admit("裸userId");
    assert.equal(bad.ok, false);
  } finally {
    cleanup();
  }
});

test("移除账号后其来信被拒", () => {
  const { store, cleanup } = setup();
  try {
    store.add(account({ boundUserId: "alice@im.wechat" }));
    const admit = accountAdmission(store);
    assert.equal(admit("wechat:acct1:alice@im.wechat").ok, true);
    assert.equal(store.remove("acct1"), true);
    assert.equal(admit("wechat:acct1:alice@im.wechat").ok, false);
  } finally {
    cleanup();
  }
});

test("allowAll 放行任何 userKey(本地测试通道)", () => {
  assert.deepEqual(allowAll("stdin:local:local"), { ok: true });
});

test("凭据文件以 0600 落盘", () => {
  const { store, path, cleanup } = setup();
  try {
    store.add(account());
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test("listPublic 不含 botToken", () => {
  const { store, cleanup } = setup();
  try {
    store.add(account());
    const pub = store.listPublic();
    assert.equal(pub.length, 1);
    assert.ok(!("botToken" in pub[0]!));
    assert.ok(!JSON.stringify(pub).includes("secret-token"));
  } finally {
    cleanup();
  }
});

test("账号增删触发连接集合回调,绑定变更不触发", () => {
  const { store, cleanup } = setup();
  try {
    let fired = 0;
    store.onConnectionSetChanged(() => {
      fired += 1;
    });
    store.add(account());
    assert.equal(fired, 1);
    store.bind("acct1", "alice@im.wechat");
    store.unbind("acct1");
    store.recordRejection("acct1", "mallory@im.wechat");
    assert.equal(fired, 1, "绑定相关变更不改变连接集合,不应触发重建");
    store.remove("acct1");
    assert.equal(fired, 2);
  } finally {
    cleanup();
  }
});

test("账号数据跨实例持久化", () => {
  const { store, path, cleanup } = setup();
  try {
    store.add(account({ boundUserId: "alice@im.wechat" }));
    const reloaded = new AccountStore(path);
    assert.equal(reloaded.get("acct1")?.boundUserId, "alice@im.wechat");
    assert.equal(reloaded.get("acct1")?.botToken, "secret-token");
  } finally {
    cleanup();
  }
});
