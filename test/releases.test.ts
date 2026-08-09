import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listPreparedReleases,
  pointerSha,
  resolveShaPrefix,
  MIN_SHA_PREFIX,
} from "../src/core/releases.js";

/**
 * `/发布 <前6位>` 落到具体 sha 上的那一段。
 *
 * **故意用真实文件系统而不是注入的假 IO**:要守的是"符号链接不算 release",
 * 而假 IO 只会返回我自己编的 dirent —— 那样测的是我对 readdir 的想象,不是
 * readdir 的行为(它到底跟不跟随链接,正是这里唯一值得验的事)。
 *
 * 三道闸有意重叠,所以用例验的是**行为**,不是"哪一道挡住了它"。实测过:
 * 名字恰好像 sha 的链接,单独拆掉 `isDirectory()` 或单独拆掉「VERSION 的 sha 要等于
 * 目录名」,另一道都还拦得住 —— 这正是冗余该有的样子,别把它写成某一道的单测。
 * 真正被单独钉住的是命名规则(指针、`<sha>.tmp`)与 VERSION↔目录名(内容对不上)。
 */

const A = "a".repeat(40);
const B = `bbbbbb${"0".repeat(34)}`;
const C = `bbbbbc${"0".repeat(34)}`;

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "catman-releases-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 造一个"制备完成"的 release:目录 + VERSION + MANIFEST。 */
function makeRelease(
  dir: string,
  sha: string,
  extra: { preparedAt?: string; branch?: string; versionSha?: string } = {},
): void {
  const d = join(dir, sha);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "VERSION"),
    JSON.stringify({
      sha: extra.versionSha ?? sha,
      preparedAt: extra.preparedAt ?? "2026-08-08T00:00:00Z",
      ...(extra.branch ? { branch: extra.branch } : {}),
    }),
  );
  writeFileSync(join(d, "MANIFEST"), "deadbeef  VERSION\n");
}

test("枚举:认得出制备好的 release,带上分支与时间", () => {
  withDir((dir) => {
    makeRelease(dir, A, { branch: "evolve/x", preparedAt: "2026-08-08T01:00:00Z" });
    const list = listPreparedReleases(dir);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], {
      sha: A,
      preparedAt: "2026-08-08T01:00:00Z",
      branch: "evolve/x",
    });
  });
});

test("枚举:指针不是 release —— 符号链接一律跳过", () => {
  withDir((dir) => {
    makeRelease(dir, A);
    for (const name of ["current", "stable", "pinned"]) {
      symlinkSync(A, join(dir, name));
    }
    const list = listPreparedReleases(dir);
    assert.deepEqual(
      list.map((r) => r.sha),
      [A],
      "三个指针都指着同一个 release,枚举结果必须只有一条",
    );
  });
});

test("枚举:名字恰好像 sha 的符号链接也不算 —— 否则同一个 release 会以两个 sha 出现", () => {
  withDir((dir) => {
    makeRelease(dir, A);
    // 名字是 40 位 hex,命名规则拦不住它。拦住它的有两道且各自都够:readdir 不跟随
    // 链接(isDirectory 为假),以及链接解析过去读到的是 A 的 VERSION、与链接名对不上。
    symlinkSync(A, join(dir, B));
    assert.deepEqual(
      listPreparedReleases(dir).map((r) => r.sha),
      [A],
    );
  });
});

test("枚举:名字不像 sha 的不算 —— 制备中途的 <sha>.tmp 最典型", () => {
  withDir((dir) => {
    makeRelease(dir, A);
    // 半成品:名字带 .tmp,内容却可能是齐的(制备最后一步才 rename)。
    const tmp = join(dir, `${A}.tmp`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "VERSION"), JSON.stringify({ sha: A, preparedAt: "t" }));
    writeFileSync(join(tmp, "MANIFEST"), "x\n");
    mkdirSync(join(dir, "npm-cache"), { recursive: true });

    assert.deepEqual(
      listPreparedReleases(dir).map((r) => r.sha),
      [A],
    );
  });
});

test("枚举:缺 MANIFEST 或缺 VERSION 的不是候选 —— 它连 deployer 那关都过不了", () => {
  withDir((dir) => {
    const noManifest = join(dir, B);
    mkdirSync(noManifest, { recursive: true });
    writeFileSync(join(noManifest, "VERSION"), JSON.stringify({ sha: B, preparedAt: "t" }));

    const noVersion = join(dir, C);
    mkdirSync(noVersion, { recursive: true });
    writeFileSync(join(noVersion, "MANIFEST"), "x\n");

    assert.deepEqual(listPreparedReleases(dir), []);
  });
});

test("枚举:VERSION 里的 sha 与目录名对不上就不列 —— 列了等于给人一个必然失败的选项", () => {
  withDir((dir) => {
    makeRelease(dir, A, { versionSha: B });
    assert.deepEqual(listPreparedReleases(dir), []);
  });
});

test("枚举:新的排前面,读不出时间的排最后", () => {
  withDir((dir) => {
    makeRelease(dir, A, { preparedAt: "2026-08-01T00:00:00Z" });
    makeRelease(dir, B, { preparedAt: "2026-08-09T00:00:00Z" });
    makeRelease(dir, C, { preparedAt: "" });
    assert.deepEqual(
      listPreparedReleases(dir).map((r) => r.sha),
      [B, A, C],
    );
  });
});

test("枚举:目录不存在时返回空,不抛 —— 本地开发没有 release 目录是常态", () => {
  assert.deepEqual(listPreparedReleases("/definitely/not/here"), []);
});

test("指针:读得出 sha;不是链接、断链、名字不像 sha 时一律 undefined", () => {
  withDir((dir) => {
    makeRelease(dir, A);
    symlinkSync(A, join(dir, "current"));
    symlinkSync("nope", join(dir, "stable"));
    mkdirSync(join(dir, "pinned"), { recursive: true });

    assert.equal(pointerSha(dir, "current"), A);
    assert.equal(pointerSha(dir, "stable"), undefined, "指向的名字不像 sha");
    assert.equal(pointerSha(dir, "pinned"), undefined, "是真目录不是链接");
    assert.equal(pointerSha(dir, "missing"), undefined);
  });
});

test("前缀:唯一命中", () => {
  assert.deepEqual(resolveShaPrefix([A, B], A.slice(0, 7)), { kind: "ok", sha: A });
});

test("前缀:大小写不敏感 —— 手机上很容易带出大写", () => {
  assert.deepEqual(resolveShaPrefix([B], B.slice(0, 8).toUpperCase()), { kind: "ok", sha: B });
});

test("前缀:短于下限一律拒绝,哪怕它其实只匹配一个", () => {
  const short = A.slice(0, MIN_SHA_PREFIX - 1);
  assert.deepEqual(resolveShaPrefix([A], short), { kind: "tooShort" });
});

test("前缀:命中多个要说歧义,不能挑一个", () => {
  // B 与 C 前 5 位相同、第 6 位才分叉 —— 正好卡在下限上。
  const r = resolveShaPrefix([B, C], "bbbbb0");
  assert.equal(r.kind, "none", "第 6 位已经分叉,'bbbbb0' 谁也不匹配");
  const amb = resolveShaPrefix([B, C], "bbbbb");
  assert.equal(amb.kind, "tooShort", "5 位先被下限挡住");
  const both = resolveShaPrefix([B, C, `bbbbbb${"1".repeat(34)}`], "bbbbbb");
  assert.equal(both.kind, "ambiguous");
  assert.equal(both.kind === "ambiguous" && both.matches.length, 2);
});

test("前缀:一个都不匹配", () => {
  assert.deepEqual(resolveShaPrefix([A], "ffffff"), { kind: "none" });
});
