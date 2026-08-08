import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { classifyFailure, runSelfCheck } from "../src/core/selfcheck.js";

/**
 * 分类错了的代价是不对称的:把环境问题误判成 `code` 会白白废掉一个完好的版本,
 * 把代码问题误判成 `network` 会让 deployer 空转重试三十分钟。所以逐类钉死。
 */
test("限流类归 ratelimit", () => {
  for (const s of [
    "Rate limit exceeded, please retry",
    "API Error: 429 too many requests",
    "Error 529: Overloaded",
    "quota exceeded for this org",
  ]) {
    assert.equal(classifyFailure(s), "ratelimit", s);
  }
});

test("凭据/额度类归 auth(重试无用,要人去换发)", () => {
  for (const s of [
    "Credit balance is too low",
    "401 Unauthorized",
    "authentication_error: invalid x-api-key",
    "OAuth token has expired",
  ]) {
    assert.equal(classifyFailure(s), "auth", s);
  }
});

test("网络类归 network", () => {
  for (const s of [
    "getaddrinfo ENOTFOUND api.anthropic.com",
    "connect ECONNREFUSED 127.0.0.1:8080",
    "fetch failed",
    "tunneling socket could not be established",
    "socket hang up",
  ]) {
    assert.equal(classifyFailure(s), "network", s);
  }
});

test("其余一律归 code —— 兜底方向是「怀疑这份代码」,而不是替它开脱", () => {
  for (const s of [
    "TypeError: x is not a function",
    "Cannot find module 'node:foo'",
    "",
  ]) {
    assert.equal(classifyFailure(s), "code", s);
  }
});

test("限流优先于网络:限流信息里常带 timeout 字样,先匹配限流才不会被误判成可重试的网络抖动", () => {
  assert.equal(classifyFailure("rate limit reached, request timed out"), "ratelimit");
});

test("自检通过时给出 ok 结论,且不碰调用方给的数据目录", async () => {
  const realDataDir = process.env["CATMAN_DATA_DIR"];
  const realConfigDir = process.env["CLAUDE_CONFIG_DIR"];
  // 故意指一个不存在的路径:自检要是真按它去建目录,这条断言就会失败。
  const forbidden = "/tmp/catman-selfcheck-must-not-touch-this";
  process.env["CATMAN_DATA_DIR"] = forbidden;
  try {
    const result = await runSelfCheck({
      runProbe: async () => ({ text: "ok", isError: false }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.category, "ok");
    assert.equal(
      existsSync(forbidden),
      false,
      "自检必须自己开临时目录 —— 一个会往生产数据里写东西的自检比没有自检更糟",
    );
  } finally {
    if (realDataDir === undefined) delete process.env["CATMAN_DATA_DIR"];
    else process.env["CATMAN_DATA_DIR"] = realDataDir;
    if (realConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = realConfigDir;
  }
});

test("探测返回 isError 时按错误原文分类,而不是一律判死", async () => {
  const result = await runSelfCheck({
    runProbe: async () => ({ text: "API Error: 429 rate limit", isError: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.category, "ratelimit");
  // 原文照留:它是去查订阅/配置的唯一线索。
  assert.match(result.detail, /429/);
});

test("探测抛错也走分类", async () => {
  const result = await runSelfCheck({
    runProbe: async () => {
      throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.category, "network");
});

test("超时归 network —— 等不到应答与连不上,对 deployer 是同一个处置", async () => {
  const result = await runSelfCheck({
    timeoutMs: 30,
    runProbe: (_agent, _cwd, _model, abort) =>
      new Promise((_resolve, reject) => {
        abort.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.category, "network");
  assert.match(result.detail, /超时/);
});
