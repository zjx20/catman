import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncSrcRepoToRelease } from "../src/core/src-repo-sync.js";

/**
 * 部署之后把源码仓库的主线拨到线上版本。
 *
 * 这件事从前**根本没发生**:deployer 推远端走的是 refspec、又写不了源码仓库
 * (它是 10002,仓库属 10001),所以本地 main 长期停在上上个版本 —— 而人每次都会
 * 收到一句"分支 main 已指向这个提交",说的是远端。下次开分支的基线于是天生陈旧。
 *
 * 这里验的是那些**不能动**的情形:动错了就是丢提交或者搞乱工作区,而这个功能本身
 * 只是"省事",没有任何理由为它冒险。
 */

// **必须 await 再清理。** 不 await 的话 finally 在 fn 刚返回 Promise 时就把目录删了,
// 而异步的主体这才开始跑 —— 于是每个用例都在一个已经不存在的目录上操作。
async function withRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "catman-srcsync-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 造一个仓库:main 上两个提交(A、B),返回各自的 sha 与操作句柄。 */
function repoWithAB(dir: string) {
  const repo = join(dir, "src-repo");
  mkdirSync(repo, { recursive: true });
  const git = (args: string) =>
    execFileSync("bash", ["-c", `cd "${repo}" && git ${args}`], { encoding: "utf8" }).trim();
  git("init -q -b main");
  git("config user.email t@t");
  git("config user.name t");
  writeFileSync(join(repo, "f"), "A\n");
  git("add -A && git commit -qm A");
  const a = git("rev-parse HEAD");
  writeFileSync(join(repo, "f"), "B\n");
  git("commit -qam B");
  const b = git("rev-parse HEAD");
  // 把 main 退回 A —— 模拟"线上已经是 B,而源码仓库还停在 A"。
  git(`update-ref refs/heads/main ${a}`);
  git(`checkout -q -b evolve/x ${b}`);
  return { repo, a, b, git };
}

test("同步:main 落后于线上版本 —— 快进上去", async () => {
  await withRepo(async (dir) => {
    const { repo, b, git } = repoWithAB(dir);
    const r = await syncSrcRepoToRelease({ srcDir: repo, sha: b });
    assert.equal(r.moved, true);
    assert.equal(git("rev-parse refs/heads/main"), b);
    assert.match(r.detail, /快进到线上版本/);
  });
});

test("同步:main 已经就是线上版本 —— 什么都不做,也不吭声", async () => {
  await withRepo(async (dir) => {
    const { repo, b, git } = repoWithAB(dir);
    git(`update-ref refs/heads/main ${b}`);
    const r = await syncSrcRepoToRelease({ srcDir: repo, sha: b });
    assert.equal(r.moved, false);
    assert.equal(r.detail, "", "无事可做时不该往日志里灌噪音");
  });
});

test("同步:main 上有线上没有的提交(分叉)—— 绝不动它", async () => {
  await withRepo(async (dir) => {
    const { repo, a, b, git } = repoWithAB(dir);
    // main 从 A 长出自己的提交,与线上的 B 分叉。
    git(`checkout -q main`);
    writeFileSync(join(repo, "g"), "本地还没上线的东西\n");
    git("add -A && git commit -qm '本地提交'");
    const local = git("rev-parse refs/heads/main");
    git("checkout -q evolve/x");

    const r = await syncSrcRepoToRelease({ srcDir: repo, sha: b });
    assert.equal(r.moved, false);
    assert.equal(git("rev-parse refs/heads/main"), local, "快进不了就必须原样留着 —— 动了就是丢提交");
    assert.match(r.detail, /有不在线上版本里的提交/);
    void a;
  });
});

test("同步:正检出在 main 且工作区脏 —— 不动(只拨 ref 会让工作区凭空多出改动)", async () => {
  await withRepo(async (dir) => {
    const { repo, a, b, git } = repoWithAB(dir);
    git("checkout -q main");
    writeFileSync(join(repo, "f"), "改了一半\n");
    const r = await syncSrcRepoToRelease({ srcDir: repo, sha: b });
    assert.equal(r.moved, false);
    assert.equal(git("rev-parse refs/heads/main"), a);
    assert.match(r.detail, /工作区不干净/);
  });
});

test("同步:正检出在 main 且干净 —— 工作区跟着一起走", async () => {
  await withRepo(async (dir) => {
    const { repo, b, git } = repoWithAB(dir);
    git("checkout -q main");
    const r = await syncSrcRepoToRelease({ srcDir: repo, sha: b });
    assert.equal(r.moved, true);
    assert.equal(git("rev-parse HEAD"), b, "HEAD 要跟上,不能只动 ref 把工作区甩在后面");
    assert.equal(git("status --porcelain"), "", "拨完工作区必须还是干净的");
  });
});

test("同步:顺手删掉内容已全在线上版本里的 evolve/* 分支", async () => {
  await withRepo(async (dir) => {
    const { repo, a, b, git } = repoWithAB(dir);
    // evolve/done 的内容全在 B 里(它就是 B);evolve/x 是当前检出的;
    // evolve/live 上有还没上线的提交。
    git(`branch evolve/done ${b}`);
    git(`checkout -q -b evolve/live ${b}`);
    writeFileSync(join(repo, "h"), "还没上线\n");
    git("add -A && git commit -qm '还没上线'");
    git("checkout -q evolve/x");

    const r = await syncSrcRepoToRelease({ srcDir: repo, sha: b });
    assert.deepEqual(r.dropped, ["evolve/done"]);
    const left = git("for-each-ref --format='%(refname:short)' refs/heads/evolve");
    assert.match(left, /evolve\/x/, "当前检出的分支不能删 —— 那会让工作区落到 detached HEAD");
    assert.match(left, /evolve\/live/, "上面还有没上线的提交,删了就是丢东西");
    void a;
  });
});

test("同步:线上 sha 不在这个仓库里 —— 不动,并说一句", async () => {
  await withRepo(async (dir) => {
    const { repo, a, git } = repoWithAB(dir);
    const r = await syncSrcRepoToRelease({
      srcDir: repo,
      sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });
    assert.equal(r.moved, false);
    assert.equal(git("rev-parse refs/heads/main"), a);
    assert.match(r.detail, /不在源码仓库里/);
  });
});

test("同步:目录不是 git 仓库 —— 静默返回,绝不让启动出声", async () => {
  await withRepo(async (dir) => {
    const plain = join(dir, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    const r = await syncSrcRepoToRelease({ srcDir: plain, sha: "a".repeat(40) });
    assert.deepEqual(r, { moved: false, detail: "", dropped: [] });
  });
});
