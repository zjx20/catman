import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  makeUserKey,
  parseUserKey,
  userDirName,
  newAccountId,
  USER_DIR_NAME_MAX,
  SDK_PROJECT_PATH_LIMIT,
} from "../src/core/identity.js";

test("userKey 往返", () => {
  const key = makeUserKey("wechat", "a1b2c3d4", "o9cq80yCc7@im.wechat");
  assert.equal(key, "wechat:a1b2c3d4:o9cq80yCc7@im.wechat");
  assert.deepEqual(parseUserKey(key), {
    channel: "wechat",
    accountId: "a1b2c3d4",
    userId: "o9cq80yCc7@im.wechat",
  });
});

test("userId 含冒号也能无歧义往返(只 split 前两个冒号)", () => {
  const userId = "weird:id:with:colons";
  const key = makeUserKey("wechat", "acct", userId);
  assert.equal(parseUserKey(key)?.userId, userId);
});

test("userId 含中文/特殊字符能往返", () => {
  for (const userId of ["张三", "a b\tc", "u@im.wechat", "-_.~!*'()"]) {
    const key = makeUserKey("stdin", "local", userId);
    assert.equal(parseUserKey(key)?.userId, userId, `userId=${userId}`);
  }
});

test("channel/accountId 含冒号直接抛错(会破坏解析)", () => {
  assert.throws(() => makeUserKey("we:chat", "acct", "u"));
  assert.throws(() => makeUserKey("wechat", "ac:ct", "u"));
});

test("空段抛错", () => {
  assert.throws(() => makeUserKey("", "acct", "u"));
  assert.throws(() => makeUserKey("wechat", "", "u"));
  assert.throws(() => makeUserKey("wechat", "acct", ""));
});

test("非法 userKey 解析返回 null(旧格式裸 userId 等)", () => {
  for (const bad of ["", "local", "a:b", "a:b:", ":b:c", "a::c"]) {
    assert.equal(parseUserKey(bad), null, `应判为非法: ${JSON.stringify(bad)}`);
  }
});

test("userDirName 是单射:归一化后相同的 userKey 仍得到不同目录名", () => {
  // 这两个 key 的可读部分归一化后完全一致,只能靠哈希后缀区分。
  // 一旦撞名,两个用户就共用一个 cwd —— 文件与会话隔离直接失效。
  const a = userDirName("wechat:acct:x/y");
  const b = userDirName("wechat:acct:x-y");
  assert.notEqual(a, b);
});

test("userDirName 对大量相近 key 无碰撞", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const name = userDirName(`wechat:acct:user-${i}@im.wechat`);
    assert.ok(!seen.has(name), `目录名碰撞: ${name}`);
    seen.add(name);
  }
});

test("userDirName 稳定:同一 key 反复计算结果不变", () => {
  const key = "wechat:acct:u@im.wechat";
  assert.equal(userDirName(key), userDirName(key));
});

test("userDirName 长度受限,且工作目录全路径远短于 SDK 阈值", () => {
  // 超过阈值后 SDK 会改用「截断 + djb2 哈希」编码 project 目录,
  // 与 transcript.ts 的 encodeProjectDir 分叉 —— 会话就此读不到也删不掉。
  const worst = userDirName(`wechat:${"a".repeat(200)}:${"b".repeat(500)}`);
  assert.ok(worst.length <= USER_DIR_NAME_MAX, `实际长度 ${worst.length}`);
  const fullPath = join("/data/workspace", worst);
  assert.ok(fullPath.length < SDK_PROJECT_PATH_LIMIT, `实际路径长度 ${fullPath.length}`);
});

test("userDirName 只产出文件系统安全的字符", () => {
  const name = userDirName("wechat:acct:../../etc/passwd");
  assert.match(name, /^[a-zA-Z0-9-]+$/);
  assert.ok(!name.includes(".."));
});

test("newAccountId 是 8 位十六进制且不含冒号", () => {
  const id = newAccountId();
  assert.match(id, /^[0-9a-f]{8}$/);
});
