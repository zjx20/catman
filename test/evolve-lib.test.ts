import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * scripts/evolve/lib.sh 里那几个**操作回滚目标**的函数。
 *
 * 它们是"任何部署状态都能回到能跑的版本"这条原则的落点:指针指错、清单顺序颠倒、
 * GC 把回退目标删掉 —— 每一个都会在真正需要回滚的那一刻才暴露,而那时人多半不在
 * 电脑前。所以这里不靠肉眼审脚本,直接把它们跑起来验。
 *
 * 需要 docker 的部分(排水、切换、观察期)不在这里 —— 那些是真机验收项。
 */

const LIB = fileURLToPath(new URL("../scripts/evolve/lib.sh", import.meta.url));

/** 在一个临时 RELEASES_DIR 里 source lib.sh 并执行一段脚本,返回 stdout。 */
function inLib(releasesDir: string, script: string): string {
  return execFileSync(
    "bash",
    ["-c", `set -euo pipefail; export CATMAN_RELEASES_DIR="${releasesDir}"; . "${LIB}"; ${script}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "catman-evolve-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 造一个通过 release_verify 的 release。 */
function makeRelease(releasesDir: string, sha: string): void {
  const dir = join(releasesDir, sha);
  mkdirSync(join(dir, "dist", "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "dist", "src", "index.js"), `// ${sha}\n`);
  writeFileSync(join(dir, "VERSION"), JSON.stringify({ sha, preparedAt: "2026-08-08T00:00:00Z" }));
  execFileSync("bash", [
    "-c",
    `cd "${dir}" && find dist VERSION -type f -print0 | sort -z | xargs -0 sha256sum > MANIFEST`,
  ]);
}

test("指针:pointer_set 换指向,pointer_sha 读得回来", () => {
  withDir((dir) => {
    makeRelease(dir, "aaa111");
    makeRelease(dir, "bbb222");
    inLib(dir, `pointer_set current aaa111`);
    assert.equal(inLib(dir, `pointer_sha current`), "aaa111");
    inLib(dir, `pointer_set current bbb222`);
    assert.equal(inLib(dir, `pointer_sha current`), "bbb222");
  });
});

test("指针:目标不存在时拒绝设置 —— 宁可不动,也不能把 current 指向空气", () => {
  withDir((dir) => {
    makeRelease(dir, "aaa111");
    inLib(dir, `pointer_set current aaa111`);
    assert.throws(() => inLib(dir, `pointer_set current 不存在的sha`));
    assert.equal(inLib(dir, `pointer_sha current`), "aaa111", "失败后原指向不变");
  });
});

test("指针:换链接可从任意断点重跑 —— 残留的 .tmp 不能让下一次部署卡住", () => {
  // deployer 可能在 ln 与 mv 之间被杀(软路由 OOM 是常态)。那时容器已经停了,
  // 若下一次因为 EEXIST 失败就没人拉起它 —— 这是"永久下线"的一条现实路径。
  withDir((dir) => {
    makeRelease(dir, "aaa111");
    symlinkSync("aaa111", join(dir, "current.tmp")); // 模拟上次死在半路
    inLib(dir, `pointer_set current aaa111`);
    assert.equal(inLib(dir, `pointer_sha current`), "aaa111");
  });
});

test("已验证清单:新的置顶,顺序即回滚顺序", () => {
  withDir((dir) => {
    inLib(dir, `history_push old1; history_push mid2; history_push new3`);
    assert.deepEqual(inLib(dir, `history_shas`).split("\n"), ["new3", "mid2", "old1"]);
  });
});

test("已验证清单:同一个 sha 重复部署不会占两格", () => {
  withDir((dir) => {
    inLib(dir, `history_push a; history_push b; history_push a`);
    assert.deepEqual(inLib(dir, `history_shas`).split("\n"), ["a", "b"]);
  });
});

test("已验证清单:超出保留数的被挤掉,保留的是最新几个", () => {
  withDir((dir) => {
    inLib(dir, `export CATMAN_KEEP_VERIFIED=3; history_push a; history_push b; history_push c; history_push d`);
    assert.deepEqual(inLib(dir, `history_shas`).split("\n"), ["d", "c", "b"]);
  });
});

test("已验证清单:文件损坏时读出空清单而不是崩 —— 崩了连回滚都做不了", () => {
  withDir((dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "verified-history.json"), "{这不是 json");
    assert.equal(inLib(dir, `history_shas || true`), "");
    // 而且还能继续往里写(坏文件不该让部署机制永久瘫痪)。
    inLib(dir, `history_push fresh1`);
    assert.equal(inLib(dir, `history_shas`), "fresh1");
  });
});

test("release 校验:完整的通过", () => {
  withDir((dir) => {
    makeRelease(dir, "good111");
    assert.equal(inLib(dir, `release_verify good111 && echo OK`), "OK");
  });
});

test("release 校验:dist 被改过就拒绝 —— git 对 dist 全盲,清单是唯一的门", () => {
  withDir((dir) => {
    makeRelease(dir, "patched1");
    // 模拟"热补丁":直接改 dist 里的字节。git status 对此一无所知(dist 在 .gitignore 里),
    // 所以如果没有内容清单,一个被手工改过的 release 会被当成"已验证"记进回滚目标。
    writeFileSync(join(dir, "patched1", "dist", "src", "index.js"), "// 偷偷改过\n");
    assert.equal(inLib(dir, `release_verify patched1 && echo OK || echo REJECT`), "REJECT");
  });
});

test("release 校验:失败时 stdout 必须一个字都不出 —— 否则回滚会切到一个垃圾路径", () => {
  // pick_rollback_target 在命令替换里调 release_verify,再把选中的 sha 打到 stdout。
  // 校验失败时若有任何东西漏到 stdout(`sha256sum -c` 默认就把不匹配的文件名打在
  // 那里),它就会混进被捕获的 sha,`revert_to` 拿到的是一个不存在的目录 ——
  // 回滚这个最后防线自己失效,而且是静默的。
  withDir((dir) => {
    makeRelease(dir, "tamper1");
    writeFileSync(join(dir, "tamper1", "dist", "src", "index.js"), "// 偷偷改过\n");
    const out = inLib(dir, `release_verify tamper1 2>/dev/null || true`);
    assert.equal(out, "", `校验失败时 stdout 该是空的,实际是:${out}`);
  });
});

test("release 校验:VERSION 里的 sha 与目录名不一致就拒绝", () => {
  withDir((dir) => {
    makeRelease(dir, "dir111");
    writeFileSync(
      join(dir, "dir111", "VERSION"),
      JSON.stringify({ sha: "别的sha", preparedAt: "t" }),
    );
    execFileSync("bash", [
      "-c",
      `cd "${join(dir, "dir111")}" && find dist VERSION -type f -print0 | sort -z | xargs -0 sha256sum > MANIFEST`,
    ]);
    assert.equal(inLib(dir, `release_verify dir111 && echo OK || echo REJECT`), "REJECT");
  });
});

test("release 校验:缺关键文件一律拒绝", () => {
  for (const missing of ["VERSION", "MANIFEST", "dist/src/index.js", "node_modules"]) {
    withDir((dir) => {
      makeRelease(dir, "part111");
      rmSync(join(dir, "part111", missing), { recursive: true, force: true });
      assert.equal(
        inLib(dir, `release_verify part111 && echo OK || echo REJECT`),
        "REJECT",
        `缺 ${missing} 时该拒绝`,
      );
    });
  }
});

/**
 * git 的属主检查。制备时 deployer(10002)要读 agent(10001)的仓库,属主不同
 * git 就拒绝打开 —— 而开发机上两者是同一个人,这条路径**永远碰不到**,
 * 只会在真机第一次制备时炸。用 git 自带的测试开关把它搬到这里。
 */
function makeSrcRepo(dir: string): string {
  const repo = join(dir, "srcrepo");
  execFileSync("bash", [
    "-c",
    `set -e; git init -q "${repo}"; cd "${repo}"; ` +
      `git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init`,
  ]);
  return repo;
}

test("git 属主放行:没放行时 rev-parse 与 clone 都过不去(这就是真机上的症状)", () => {
  withDir((dir) => {
    const repo = makeSrcRepo(dir);
    const script =
      `export GIT_TEST_ASSUME_DIFFERENT_OWNER=1; ` +
      `git -C "${repo}" rev-parse HEAD >/dev/null 2>&1 && echo REV-OK || echo REV-FAIL; ` +
      `git clone -q --no-checkout "${repo}" "${join(dir, "a")}" >/dev/null 2>&1 && echo CLONE-OK || echo CLONE-FAIL`;
    assert.deepEqual(inLib(dir, script).split("\n"), ["REV-FAIL", "CLONE-FAIL"]);
  });
});

test("git 属主放行:git_trust_repo 之后 rev-parse 与 clone 都能过", () => {
  // clone 认的是仓库下面的 `.git`,rev-parse 认的是仓库目录本身 —— 少放行一条,
  // 就会一路正常到 clone 那步再炸。这个测试的全部价值就在于同时钉住这两条。
  withDir((dir) => {
    const repo = makeSrcRepo(dir);
    const script =
      `export GIT_TEST_ASSUME_DIFFERENT_OWNER=1; git_trust_repo "${repo}"; ` +
      `git -C "${repo}" rev-parse HEAD >/dev/null && echo REV-OK; ` +
      `git clone -q --no-checkout "${repo}" "${join(dir, "b")}" && echo CLONE-OK`;
    assert.deepEqual(inLib(dir, script).split("\n"), ["REV-OK", "CLONE-OK"]);
  });
});

test("git 属主放行:一次可以放行多个仓库(init 要同时碰源仓库与目标仓库)", () => {
  withDir((dir) => {
    const a = makeSrcRepo(dir);
    execFileSync("bash", ["-c", `git clone -q "${a}" "${join(dir, "second")}"`]);
    const b = join(dir, "second");
    const script =
      `export GIT_TEST_ASSUME_DIFFERENT_OWNER=1; git_trust_repo "${a}" "${b}"; ` +
      `git -C "${a}" rev-parse HEAD >/dev/null && echo A-OK; ` +
      `git -C "${b}" rev-parse HEAD >/dev/null && echo B-OK`;
    assert.deepEqual(inLib(dir, script).split("\n"), ["A-OK", "B-OK"]);
  });
});

test("JSON:写入是原子的且能读回来,含特殊字符也不破坏结构", () => {
  withDir((dir) => {
    const file = join(dir, "x.json");
    const payload = JSON.stringify({ detail: '含"引号"、换行\n与反斜杠\\', n: 42 });
    inLib(dir, `json_write "${file}" '${payload.replace(/'/g, "'\\''")}'`);
    const back = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(back.n, 42);
    assert.match(back.detail, /引号/);
    assert.equal(inLib(dir, `json_get "${file}" 'd.n'`), "42");
  });
});

test("JSON:读坏文件返回空串而不是崩", () => {
  withDir((dir) => {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{坏的");
    assert.equal(inLib(dir, `json_get "${file}" 'd.anything'`), "");
    assert.equal(inLib(dir, `json_get "${join(dir, "nope.json")}" 'd.x'`), "");
  });
});

test("锁:被占着时拒绝第二次获取", () => {
  withDir((dir) => {
    assert.throws(() => inLib(dir, `lock_acquire first; lock_acquire second`));
  });
});

test("锁:心跳过期后可以接管 —— 否则一次 OOM 就把部署能力永久锁死", () => {
  withDir((dir) => {
    mkdirSync(dir, { recursive: true });
    // 一把 1 小时前的锁(> 45 分钟的判死阈值)。
    const stale = Math.floor(Date.now() / 1000) - 3600;
    writeFileSync(join(dir, ".deploy-lock"), JSON.stringify({ owner: "dead", heartbeat: stale }));
    assert.equal(inLib(dir, `lock_acquire newone && echo OK`), "OK");
  });
});

test("锁:读不懂的锁文件按已死处理 —— 一把读不懂的锁若能永久挡住部署,连回滚都做不了", () => {
  withDir((dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".deploy-lock"), "{损坏");
    assert.equal(inLib(dir, `lock_acquire newone && echo OK`), "OK");
  });
});

test("锁:释放后可以再次获取", () => {
  withDir((dir) => {
    assert.equal(inLib(dir, `lock_acquire a; lock_release; lock_acquire b && echo OK`), "OK");
  });
});
