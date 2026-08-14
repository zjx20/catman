import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotifyTokens } from "../src/core/notify-tokens.js";

const dirs: string[] = [];

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "catman-notifytok-"));
  dirs.push(dir);
  return join(dir, "notify-tokens.json");
}

test("同一个用户反复取到的是同一枚令牌", () => {
  const t = new NotifyTokens(tmpPath());
  const a = t.for("wechat:a:u1");
  const b = t.for("wechat:a:u1");
  assert.equal(a, b);
  // 每回合换一枚的话,上一回合放出去的后台任务会在下一回合开始时哑掉。
});

test("令牌解析得出且只解析得出它自己那个 userKey", () => {
  const t = new NotifyTokens(tmpPath());
  const mine = t.for("wechat:a:u1");
  const other = t.for("wechat:a:u2");
  assert.equal(t.resolve(mine), "wechat:a:u1");
  assert.equal(t.resolve(other), "wechat:a:u2");
  assert.notEqual(mine, other);
  assert.equal(t.resolve("不存在的令牌"), undefined);
});

test("落盘:换一个实例(等于进程重启)之后令牌还认", () => {
  // 这是它与回合令牌最要紧的区别 —— 一个跑了六小时的任务,收尾时进程可能已经
  // 重启过。令牌活不过重启的话,修的就还是原来那个病。
  const path = tmpPath();
  const before = new NotifyTokens(path).for("wechat:a:u1");
  const after = new NotifyTokens(path);
  assert.equal(after.resolve(before), "wechat:a:u1");
  assert.equal(after.for("wechat:a:u1"), before);
});

test("令牌文件是 0600 —— 它是凭据", () => {
  const path = tmpPath();
  new NotifyTokens(path).for("wechat:a:u1");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("文件损坏时按空处理,而不是让进程起不来", () => {
  const path = tmpPath();
  writeFileSync(path, "{ 这不是 json");
  const t = new NotifyTokens(path);
  const fresh = t.for("wechat:a:u1");
  assert.equal(t.resolve(fresh), "wechat:a:u1");
});
