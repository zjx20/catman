import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVersion, shortSha, versionLine, VERSION_FILE } from "../src/core/version.js";

function withTempVersion(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "catman-version-"));
  const path = join(dir, VERSION_FILE);
  writeFileSync(path, content);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("读得出完整的版本戳", () => {
  withTempVersion(
    JSON.stringify({ sha: "abc123def456", preparedAt: "2026-08-08T10:00:00Z", branch: "evolve/x" }),
    (path) => {
      const v = readVersion(path);
      assert.equal(v?.sha, "abc123def456");
      assert.equal(v?.preparedAt, "2026-08-08T10:00:00Z");
      assert.equal(v?.branch, "evolve/x");
    },
  );
});

test("branch 缺失不影响读取", () => {
  withTempVersion(JSON.stringify({ sha: "abc", preparedAt: "t" }), (path) => {
    assert.equal(readVersion(path)?.sha, "abc");
    assert.equal(readVersion(path)?.branch, undefined);
  });
});

// 下面几条守的是同一条纪律:**宁可没有版本信息,也不能编一个**。
// 健康门拿 /health 回报的 sha 与待部署的 sha 比对,编造的值会让它放行一次
// 实际没切成功的部署 —— 那正是这道门存在的理由。
test("文件不存在返回 undefined,不抛", () => {
  assert.equal(readVersion(join(tmpdir(), "catman-no-such-version-file")), undefined);
});

test("坏 JSON 返回 undefined,不抛", () => {
  withTempVersion("{不是 json", (path) => {
    assert.equal(readVersion(path), undefined);
  });
});

test("缺 sha 或 sha 为空一律返回 undefined", () => {
  withTempVersion(JSON.stringify({ preparedAt: "t" }), (path) => {
    assert.equal(readVersion(path), undefined);
  });
  withTempVersion(JSON.stringify({ sha: "", preparedAt: "t" }), (path) => {
    assert.equal(readVersion(path), undefined);
  });
  withTempVersion(JSON.stringify({ sha: 123 }), (path) => {
    assert.equal(readVersion(path), undefined);
  });
  withTempVersion(JSON.stringify(["不是对象"]), (path) => {
    assert.equal(readVersion(path), undefined);
  });
});

test("preparedAt 坏值降级成空串,但 sha 还在 —— 部分坏不该丢掉能用的部分", () => {
  withTempVersion(JSON.stringify({ sha: "abc", preparedAt: 42 }), (path) => {
    const v = readVersion(path);
    assert.equal(v?.sha, "abc");
    assert.equal(v?.preparedAt, "");
  });
});

test("shortSha 取前 7 位", () => {
  assert.equal(shortSha("0123456789abcdef"), "0123456");
});

test("versionLine 在没有版本戳时说清是开发模式,不假装有版本", () => {
  const line = versionLine(undefined);
  assert.match(line, /开发模式/);
  assert.doesNotMatch(line, /[0-9a-f]{7}/);
});

test("versionLine 带上短 sha 与分支", () => {
  const line = versionLine({ sha: "0123456789", preparedAt: "2026-08-08T10:00:00Z", branch: "main" });
  assert.match(line, /0123456/);
  assert.match(line, /main/);
  assert.match(line, /2026-08-08/);
});
