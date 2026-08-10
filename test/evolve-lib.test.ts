import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
  readlinkSync,
  chmodSync,
  statSync,
} from "node:fs";
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
  // 每个用例一份独立的 git 配置,并且**清掉继承来的 GIT_CONFIG_GLOBAL** ——
  // 制备时 prepare 会导出它,而 `npm test` 就跑在那之后:测试必须验的是这份 lib.sh
  // 的行为,不是它碰巧继承到什么。
  const prelude =
    `set -euo pipefail; ` +
    `export CATMAN_RELEASES_DIR="${releasesDir}"; ` +
    `export CATMAN_GIT_CONFIG="${releasesDir}/gitconfig"; ` +
    `unset GIT_CONFIG_GLOBAL; `;
  return execFileSync("bash", ["-c", `${prelude} . "${LIB}"; ${script}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "catman-evolve-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 一份**不带任何 catman 环境痕迹**的 env。
 *
 * 测试跑在制备容器里,而那个容器的 shell 是 `. /data/deploy/bin/lib.sh` 起来的 ——
 * `load_blessed_env` 于是把**真机的** `/data/deploy/env`(宿主路径、镜像名、
 * docker 属组)整个 export 进了环境,`npm test` 一路继承下来。而 `load_blessed_env`
 * 的语义是"已有值不覆盖",所以用例摆好的那份固化 env 永远赢不了真机那份 ——
 * 症状是用例在开发机上全绿、在制备容器里报「部署机制还没固化」并打出真机的路径。
 *
 * 结论不是"少 export 一点",而是**这类用例必须自带干净环境**:它验的是脚本对
 * 给定输入的行为,不是它碰巧继承到什么。将来往固化 env 里加字段时这条同样管用。
 */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("CATMAN_")) continue;
    if (k === "DOCKER_GID" || k === "GIT_CONFIG_GLOBAL" || k === "GIT_SSH_COMMAND") continue;
    env[k] = v;
  }
  return { ...env, ...extra };
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

test("git 属主放行:必须扛得住 git 对子进程的环境清洗", () => {
  // `git clone <本地路径>` 会 fork `git-upload-pack` 去读源仓库,而 git 在 fork 前
  // 把 GIT_CONFIG_COUNT 这一族显式 unset 掉(trace 里看得见:
  //   run_command: unset GIT_CONFIG_COUNT GIT_DIR; git-upload-pack '…/.git')。
  // 所以放行**不能**靠那族环境变量 —— 子进程一个都收不到,自己 fatal,父进程只剩
  // 一句 "Could not read from remote repository",症状离原因十万八千里。
  // 这里直接模拟那次清洗:把 GIT_CONFIG_COUNT / GIT_CONFIG_PARAMETERS 抹掉再跑。
  withDir((dir) => {
    const repo = makeSrcRepo(dir);
    const script =
      `export GIT_TEST_ASSUME_DIFFERENT_OWNER=1; git_trust_repo "${repo}"; ` +
      `env -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS git -C "${repo}" rev-parse HEAD >/dev/null ` +
      `&& echo SURVIVED-CLEANSING`;
    assert.equal(inLib(dir, script), "SURVIVED-CLEANSING");
  });
});

test("git 属主放行:调两次不能把 git 弄坏(制备导出后 npm test 会再调一次)", () => {
  // 第二次调用时 GIT_CONFIG_GLOBAL 已经指向我们自己那份配置。若照旧把它 include
  // 进自己,就是循环 include —— git 会以 "exceeded maximum include depth" 拒掉
  // **该进程里的每一条 git 命令**,不是某一条失败,是全废。
  // 真机上这条路径确实走到了:prepare 调一次并导出,`npm test` 继承,测试里再调。
  withDir((dir) => {
    const repo = makeSrcRepo(dir);
    const script =
      `git_trust_repo "${repo}"; git_trust_repo "${repo}"; ` +
      `git -C "${repo}" rev-parse HEAD >/dev/null && echo STILL-WORKS`;
    assert.equal(inLib(dir, script), "STILL-WORKS");
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

/**
 * GC。这是整套脚本里最危险的一个函数 —— 它是唯一会 `rm -rf` 的地方,而它删错的
 * 东西恰恰是出事时要回退的目标。真机上发生过一次:三个指针被当成 release 目录,
 * 顺着链接把 current 与全部回滚目标的内容一起掏空了。
 */

/** release 目录一律以 40 位十六进制命名(prepare 用的是 `git rev-parse` 的输出)。 */
const SHA = (c: string) => c.repeat(40);

test("GC:指针不是 release —— 绝不能顺着 current/stable/pinned 把目标掏空", () => {
  // 带尾斜杠的 glob 会把**指向目录的符号链接**一并列出来,而它们的名字当然不在
  // 保留集里;`rm -rf current/` 于是跟着链接进去删内容,链接本身完好无损 ——
  // 日志上只有一句"GC 清理 release current",而 current 与回滚目标同时变成空目录。
  withDir((dir) => {
    const [a, b] = [SHA("a"), SHA("b")];
    makeRelease(dir, a);
    makeRelease(dir, b);
    inLib(dir, `history_push ${a}`);
    inLib(dir, `pointer_set current ${a}; pointer_set stable ${a}; pointer_set pinned ${b}`);
    inLib(dir, `release_gc`);

    assert.ok(existsSync(join(dir, a, "VERSION")), "current/stable 指着的 release 被掏空了");
    assert.ok(existsSync(join(dir, b, "VERSION")), "pinned 指着的 release 被掏空了");
    assert.equal(inLib(dir, `pointer_sha current`), a, "指针本身也得还在");
    assert.equal(inLib(dir, `pointer_sha pinned`), b);
  });
});

test("GC:清单与指针都不认的才删", () => {
  withDir((dir) => {
    const [a, c] = [SHA("a"), SHA("c")];
    makeRelease(dir, a);
    makeRelease(dir, c);
    inLib(dir, `history_push ${a}; pointer_set current ${a}; release_gc`);
    assert.ok(existsSync(join(dir, a)), "清单里的要留");
    assert.ok(!existsSync(join(dir, c)), "谁都不认的该删,否则磁盘会被历史版本吃光");
  });
});

test("GC:名字不像 release 的一概不碰 —— 宁可漏删,不可错删", () => {
  // 第二道闸。制备中途留下的 `<sha>.tmp`、人手工放进来的东西,都不该被 GC 处置:
  // 漏删只是占点磁盘(人看得见),错删的却是出事时唯一能回退的东西。
  withDir((dir) => {
    const a = SHA("a");
    makeRelease(dir, a);
    makeRelease(dir, `${a.slice(0, 39)}.tmp`);
    mkdirSync(join(dir, "某个手工放进来的目录"), { recursive: true });
    inLib(dir, `history_push ${a}; pointer_set current ${a}; release_gc`);
    assert.ok(existsSync(join(dir, `${a.slice(0, 39)}.tmp`)), "制备中途的 .tmp 不该被动");
    assert.ok(existsSync(join(dir, "某个手工放进来的目录")), "不认识的目录不该被动");
  });
});

/**
 * 制备残骸的清理。GC 明确不碰 `<sha>.tmp`(上一个用例),所以清它的责任全在
 * `rm_release_tmp` 身上 —— 而它清不掉的后果不是占磁盘,是**下一次制备跑不起来**:
 * prepare 的第一行就是删这个目录,删不掉就 `set -e` 当场退出。
 */
function makeStaleTmp(dir: string, releaseSha: string, work: string): string {
  // 照着真机复现:release 里一棵 node_modules,`cp -al` 出 .tmp(于是文件逐个共享
  // inode),再把 .tmp 的目录压成 555 —— 制备被杀掉时盘上就是这个样子。
  const pkg = join(dir, releaseSha, "node_modules", "some-pkg");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "index.js"), "module.exports = 1;\n");
  chmodSync(join(pkg, "index.js"), 0o444);
  execFileSync("cp", ["-al", join(dir, releaseSha, "node_modules"), join(work, "node_modules")]);
  for (const d of ["node_modules/some-pkg", "node_modules", "."]) {
    chmodSync(join(work, d), 0o555);
  }
  return join(pkg, "index.js");
}

test("清残骸:cp -al 留下的只读目录也要删得掉 —— 否则下一次制备第一行就死", () => {
  withDir((dir) => {
    const a = SHA("a");
    const work = join(dir, `${SHA("b")}.tmp`);
    mkdirSync(work, { recursive: true });
    makeStaleTmp(dir, a, work);

    // 先确认这个场景真的复现了:不 chmod 直接删是删不动的。
    // root 除外 —— 它无视权限位,复现不出来。制备容器里跑的是 10002,不走这个分支。
    if (process.getuid?.() !== 0) {
      assert.throws(() => rmSync(work, { recursive: true }), "场景没复现,这个用例就没在验东西");
    }

    inLib(dir, `rm_release_tmp "${work}"`);
    assert.ok(!existsSync(work), "残骸没清掉,下一次同 sha 的制备会一直失败");
  });
});

test("清残骸:只 chmod 目录 —— 文件与已验证 release 共享 inode,改它就是改到 stable 上", () => {
  withDir((dir) => {
    const a = SHA("a");
    const work = join(dir, `${SHA("b")}.tmp`);
    mkdirSync(work, { recursive: true });
    const shared = makeStaleTmp(dir, a, work);

    inLib(dir, `rm_release_tmp "${work}"`);

    // 这一条钉的是 `find -type d`。改成 `chmod -R u+w` 的话这里会变成 0o644 ——
    // 一个 444 的文件在已验证 release 里被写成可写,而没有任何日志会提到它。
    assert.equal(statSync(shared).mode & 0o777, 0o444, "chmod 穿透硬链接改到 release 上了");
    assert.equal(readFileSync(shared, "utf8"), "module.exports = 1;\n", "release 的字节被动过");
  });
});

test("清残骸:没有残骸时是空操作 —— 它在 set -e 下每次制备都要跑一遍", () => {
  withDir((dir) => {
    // 绝大多数制备都走这条路(上一次好好地跑完了,盘上没有 .tmp)。这里返回非零的话
    // **每一次**制备都在第一行就退出 —— 比清不掉残骸严重得多。
    assert.equal(inLib(dir, `rm_release_tmp "${join(dir, "不存在.tmp")}"; echo 活着`), "活着");
    assert.equal(inLib(dir, `rm_release_tmp ""; echo 活着`), "活着", "路径为空也不该炸");
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

// ── 固化环境的兜底 ───────────────────────────────────────────────
// prepare.sh 能被 agent 直接跑起来全靠它:agent 的进程环境里没有宿主路径,
// 而 prepare 要拿它去 docker run -v。读不到就是一句 `必须给出…`,而那句话
// 不会告诉他值该从哪来。

/** 造一份"固化目录":bin/lib.sh + env,与 bless 的产出同形。 */
function blessInto(dir: string, env: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "lib.sh"), readFileSync(LIB, "utf8"));
  writeFileSync(join(dir, "env"), env);
  return join(bin, "lib.sh");
}

/** source 固化副本(而不是源码树里那份),回显一个变量。 */
function inBlessedLib(libPath: string, script: string, extraEnv: Record<string, string> = {}): string {
  return execFileSync("bash", ["-c", `set -euo pipefail; . "${libPath}"; ${script}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // 必须走 cleanEnv:这组用例验的正是"固化 env 的值有没有落进来",而环境里可能
    // 已经有真机那份的同名变量 —— 那样验的就成了继承,不是加载。
    env: cleanEnv(extraEnv),
  }).trim();
}

test("固化环境:lib.sh 自己把隔壁的 env 读进来 —— 调用点不必记得 export", () => {
  withDir((dir) => {
    const lib = blessInto(dir, "CATMAN_HOST_DATA_DIR=/srv/catman/data\nCATMAN_IMAGE=catman-env:9\n");
    assert.equal(inBlessedLib(lib, `echo "$CATMAN_HOST_DATA_DIR"`), "/srv/catman/data");
    assert.equal(inBlessedLib(lib, `echo "$CATMAN_IMAGE"`), "catman-env:9");
  });
});

test("固化环境:已经有值的绝不覆盖 —— 命令行上的显式覆盖是排查时唯一的旋钮", () => {
  withDir((dir) => {
    const lib = blessInto(dir, "CATMAN_IMAGE=catman-env:9\n");
    assert.equal(
      inBlessedLib(lib, `echo "$CATMAN_IMAGE"`, { CATMAN_IMAGE: "catman-env:test" }),
      "catman-env:test",
      "被静态文件盖掉的话,人会以为自己的覆盖没生效而去怀疑别处",
    );
  });
});

test("固化环境:注释、空行、不像环境变量名的行一律跳过,后面的好行照样生效", () => {
  withDir((dir) => {
    // 这份文件是机器生成的,但读它的代码要扛得住有人手改出一行奇怪的东西 ——
    // 这里是 export,一行畸形不能把整份配置带塌(那会让部署以"路径没给"告终)。
    const lib = blessInto(
      dir,
      "# 由 bless 生成\n\nFOO-BAR=x\nrm -rf /=nope\nCATMAN_IMAGE=ok\n",
    );
    assert.equal(inBlessedLib(lib, `echo "$CATMAN_IMAGE"`), "ok", "畸形行之后的好行必须还在");
    assert.equal(
      inBlessedLib(lib, `env | grep -c '^FOO' || true`),
      "0",
      "键名不合法的一行不该被 export 出去",
    );
  });
});

test("固化环境:env 不存在时静默跳过 —— 源码树里跑就是这种情况", () => {
  withDir((dir) => {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "lib.sh"), readFileSync(LIB, "utf8"));
    assert.equal(inBlessedLib(join(bin, "lib.sh"), `echo "${"$"}{CATMAN_IMAGE:-默认}"`), "catman-env:1");
  });
});

// ── 部署密钥 ─────────────────────────────────────────────────────

test("部署密钥:两个槽位一读一写 —— 一把钥匙只能服务一个 uid,那是 ssh 的硬约束", () => {
  // 曾经把密钥整个归 10002,结果 agent 一行 `git pull` 都跑不了 —— 而那条恰恰是主路径
  // (人在开发机上改完 push 到 GitHub,路由器上的 catman 得拉得下来才谈得上制备)。
  withDir((dir) => {
    const ssh = join(dir, "ssh");
    mkdirSync(join(ssh, "fetch"), { recursive: true });
    writeFileSync(join(ssh, "id_ed25519"), "push\n");
    writeFileSync(join(ssh, "fetch", "id_ed25519"), "fetch\n");
    const env = `export CATMAN_SSH_DIR="${ssh}"; `;
    assert.equal(inLib(dir, `${env} push_key_path`), join(ssh, "id_ed25519"));
    assert.equal(inLib(dir, `${env} fetch_key_path`), join(ssh, "fetch", "id_ed25519"));
  });
});

test("部署密钥:只放一把且归 10001 时,它就是 fetch key —— pull 通、push 跳过", () => {
  // 「我只做了一个 deploy key 并给了助手」是最省事的配法,必须能跑。少了这条兜底,
  // 那种配置下 agent 会拿到一把自己读不了的钥匙,报错停在 ssh 的属主检查上。
  withDir((dir) => {
    const ssh = join(dir, "ssh");
    mkdirSync(ssh, { recursive: true });
    const key = join(ssh, "id_ed25519");
    writeFileSync(key, "only\n");
    const env = `export CATMAN_SSH_DIR="${ssh}"; `;
    // 属主不是 10001(测试进程跑在别的 uid 下)→ 不该被当成 fetch key。
    assert.equal(inLib(dir, `${env} fetch_key_path`), "");
    // 把属主判定桩掉,验的是"归 10001 就认"这条规则本身。
    const stub = `stat() { echo 10001; }; export -f stat 2>/dev/null || true; `;
    assert.equal(inLib(dir, `${stub}${env} fetch_key_path`), key);
  });
});

test("部署密钥:显式 CATMAN_GIT_FETCH_KEY 优先于约定路径", () => {
  withDir((dir) => {
    const ssh = join(dir, "ssh");
    mkdirSync(join(ssh, "fetch"), { recursive: true });
    writeFileSync(join(ssh, "fetch", "id_ed25519"), "x\n");
    const custom = join(dir, "custom_key");
    writeFileSync(custom, "y\n");
    assert.equal(
      inLib(dir, `export CATMAN_SSH_DIR="${ssh}" CATMAN_GIT_FETCH_KEY="${custom}"; fetch_key_path`),
      custom,
    );
  });
});

test("部署密钥:一把都没有时两个槽位都返回空,绝不返回一个不存在的路径", () => {
  // 返回不存在的路径会让调用方以为"有钥匙",于是 ssh 报一句 No such identity file,
  // 而那句话看起来像配置错了,不像"压根没配"。
  withDir((dir) => {
    const env = `export CATMAN_SSH_DIR="${join(dir, "ssh")}"; `;
    assert.equal(inLib(dir, `${env} push_key_path`), "");
    assert.equal(inLib(dir, `${env} fetch_key_path`), "");
  });
});

test("部署密钥:ssh_command_for 带上 IdentitiesOnly 与同目录的 known_hosts", () => {
  withDir((dir) => {
    const out = inLib(dir, `ssh_command_for "${dir}/ssh/id_ed25519"`);
    assert.match(out, new RegExp(`-i ${dir}/ssh/id_ed25519`));
    assert.match(out, new RegExp(`UserKnownHostsFile=${dir}/ssh/known_hosts`));
    assert.match(out, /IdentitiesOnly=yes/);
  });
});

test("部署密钥:调用方已经给了 GIT_SSH_COMMAND 就不动它", () => {
  withDir((dir) => {
    const ssh = join(dir, "ssh");
    mkdirSync(ssh, { recursive: true });
    writeFileSync(join(ssh, "id_ed25519"), "fake\n");
    const out = inLib(
      dir,
      `export CATMAN_SSH_DIR="${ssh}" GIT_SSH_COMMAND="ssh -i /custom/key"; git_ssh_env; echo "$GIT_SSH_COMMAND"`,
    );
    assert.equal(out, "ssh -i /custom/key");
  });
});

// ── 变更分级 ─────────────────────────────────────────────────────
// 这张分类表**必须住在固化侧**:它要是住在被自我进化改写的那棵树里,agent 只要
// 顺手改一行 case 就能把 Tier 3 报成 Tier 1 —— 而人正是靠这份报告决定还欠什么。

test("分级:部署机制、镜像、compose 一律 Tier 3 —— 它们改了也不会自动生效", () => {
  withDir((dir) => {
    for (const f of [
      "scripts/evolve/deployer.sh",
      "scripts/evolve/lib.sh",
      "docker/Dockerfile",
      "docker/entrypoint.sh",
      "docker-compose.yml",
      ".env",
      ".env.example",
    ]) {
      assert.equal(inLib(dir, `tier_of "${f}"`), "3", f);
    }
  });
});

test("分级:依赖变更是 Tier 2 —— 自动上线,但制备会真跑 npm ci", () => {
  withDir((dir) => {
    assert.equal(inLib(dir, `tier_of package.json`), "2");
    assert.equal(inLib(dir, `tier_of package-lock.json`), "2");
  });
});

test("分级:门禁本体是 Tier 1★ —— 改坏它的后果是「门失效」,而那看起来跟一切正常一样", () => {
  withDir((dir) => {
    for (const f of [
      "src/dashboard/health.ts",
      "src/core/selfcheck.ts",
      "src/core/commands.ts",
      "src/core/deploy.ts",
      "src/core/releases.ts",
      "test/health.test.ts",
      "test/evolve-lib.test.ts",
    ]) {
      assert.equal(inLib(dir, `tier_of "${f}"`), "1star", f);
    }
  });
});

test("分级:gateway.ts 故意不是 1★ —— 它每周都在改,列进来点名就没意义了", () => {
  withDir((dir) => {
    // 守住排水语义的是 health 那份 golden 测试(它在表上),不是这个文件。
    assert.equal(inLib(dir, `tier_of src/core/gateway.ts`), "1");
    assert.equal(inLib(dir, `tier_of src/core/session.ts`), "1");
    assert.equal(inLib(dir, `tier_of README.md`), "1");
  });
});

test("分级报告:按级分组打到 stderr,并说清 Tier 3 还欠什么", () => {
  withDir((dir) => {
    const repo = join(dir, "src-repo");
    mkdirSync(join(repo, "scripts", "evolve"), { recursive: true });
    mkdirSync(join(repo, "src", "core"), { recursive: true });
    const git = (args: string) =>
      execFileSync("bash", ["-c", `cd "${repo}" && git ${args}`], { encoding: "utf8" });
    git("init -q");
    git("config user.email t@t");
    git("config user.name t");
    writeFileSync(join(repo, "README.md"), "a\n");
    git("add -A && git commit -qm base");
    const base = git("rev-parse HEAD").trim();
    writeFileSync(join(repo, "scripts", "evolve", "deployer.sh"), "x\n");
    writeFileSync(join(repo, "src", "core", "commands.ts"), "x\n");
    writeFileSync(join(repo, "src", "core", "gateway.ts"), "x\n");
    git("add -A && git commit -qm change");
    const head = git("rev-parse HEAD").trim();

    // stderr 才是报告的去处 —— stdout 是结果通道,prepare 的调用方在捕获末行的 sha。
    const out = execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail; export CATMAN_RELEASES_DIR="${dir}"; export CATMAN_SRC_DIR="${repo}"; ` +
          `export CATMAN_GIT_CONFIG="${dir}/gitconfig"; unset GIT_CONFIG_GLOBAL; ` +
          `. "${LIB}"; tier_report "${base}" "${head}" 2>&1 >/dev/null`,
      ],
      { encoding: "utf8" },
    );
    assert.match(out, /Tier 3/);
    assert.match(out, /scripts\/evolve\/deployer\.sh/);
    assert.match(out, /重新跑 bless/, "必须说清 Tier 3 还欠一步人工动作");
    assert.match(out, /Tier 1★/);
    assert.match(out, /src\/core\/commands\.ts/);
    assert.match(out, /Tier 1 ——/);
    assert.match(out, /src\/core\/gateway\.ts/);
  });
});

test("分级报告:算不出差异时只说一句就跳过,绝不让制备失败", () => {
  withDir((dir) => {
    const repo = join(dir, "empty-repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("bash", ["-c", `cd "${repo}" && git init -q`]);
    const out = execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail; export CATMAN_RELEASES_DIR="${dir}"; export CATMAN_SRC_DIR="${repo}"; ` +
          `export CATMAN_GIT_CONFIG="${dir}/gitconfig"; unset GIT_CONFIG_GLOBAL; ` +
          `. "${LIB}"; tier_report deadbeef cafebabe 2>&1 >/dev/null; echo "存活"`,
      ],
      { encoding: "utf8" },
    );
    assert.match(out, /算不出/);
    assert.match(out, /存活/, "分级失败不该让整个制备挂掉");
  });
});

// ── 固化链路(bless → deployer-run)────────────────────────────────
// `/回滚` 走的就是这条路。它是逃生门,组装错了不会有任何提示 —— 真机上的症状是
// "起了容器却什么都没干"。所以拿一个假 docker 把参数原样接下来验。

const EVOLVE_DIR = fileURLToPath(new URL("../scripts/evolve", import.meta.url));


/** 在临时目录里跑一次 bless,返回固化目录。 */
function blessTo(dataDir: string): string {
  execFileSync("bash", [join(EVOLVE_DIR, "bless.sh")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanEnv({
      CATMAN_DATA_DIR: dataDir,
      CATMAN_HOST_DATA_DIR: dataDir,
      DOCKER_GID: "999",
    }),
  });
  return join(dataDir, "deploy");
}

/** 造一个只回显参数的假 docker,返回它所在的 bin 目录。 */
function fakeDocker(dir: string): string {
  const bin = join(dir, "fakebin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), '#!/bin/sh\necho "$*"\n');
  execFileSync("chmod", ["+x", join(bin, "docker")]);
  return bin;
}

test("bless 固化四个脚本 —— prepare.sh 与 deployer.sh 一起,制备门才不会被自我进化改掉", () => {
  withDir((dir) => {
    mkdirSync(join(dir, "data"), { recursive: true });
    const deployDir = blessTo(join(dir, "data"));
    const names = execFileSync("ls", [join(deployDir, "bin")], { encoding: "utf8" }).split("\n");
    for (const want of ["lib.sh", "deployer.sh", "deployer-run.sh", "prepare.sh"]) {
      assert.ok(names.includes(want), `${want} 必须被固化`);
    }
  });
});

test("固化链路:deployer-run 组装出的 docker 参数 —— 属组、镜像、跑的是固化那份 deployer", () => {
  withDir((dir) => {
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const deployDir = blessTo(dataDir);
    const out = execFileSync("bash", [join(deployDir, "bin", "deployer-run.sh"), "rollback"], {
      encoding: "utf8",
      env: cleanEnv({ PATH: `${fakeDocker(dir)}:${process.env["PATH"]}` }),
    });
    assert.match(out, /--user 10002:10002/);
    assert.match(out, /--group-add 999/, "漏了属组的症状是一句 permission denied,而那正是最需要它的时刻");
    assert.match(out, /\/data\/deploy\/bin\/deployer\.sh rollback/, "跑的必须是固化副本");
    assert.match(out, new RegExp(`-v ${dataDir}:/data`), "宿主绝对路径来自固化 env");
  });
});

test("固化链路:命令行上显式给的 CATMAN_IMAGE 赢过固化 env", () => {
  withDir((dir) => {
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    const deployDir = blessTo(dataDir);
    const out = execFileSync("bash", [join(deployDir, "bin", "deployer-run.sh"), "status"], {
      encoding: "utf8",
      env: cleanEnv({
        PATH: `${fakeDocker(dir)}:${process.env["PATH"]}`,
        CATMAN_IMAGE: "catman-env:test",
      }),
    });
    assert.match(out, /catman-env:test/);
  });
});

test("bless 不能原地覆写 —— 正在读那个文件的 deployer 必须继续读到旧内容", () => {
  // 观察期长达 30 分钟,人往往正是在等它的时候顺手跑一次 bless。bash 是**边读边执行**的:
  // `cp` 保留目标 inode、原地改写字节,那个正在执行的 bash 会从文件中间读到新内容,
  // 于是执行一段前言不搭后语的代码 —— 而它手里攥着「切换到一半的版本」。
  // `install` 先 unlink 再新建,老 inode 活到那个进程读完。
  //
  // **验的是语义,不是 inode 号。** 上一版比对 bless 前后的 inode 号,而 inode 号是会被
  // **回收**的:unlink 之后紧接着在同一个目录建文件,文件系统很可能把刚释放的号再分配
  // 回来 —— 那条用例在开发容器里碰巧没撞上,在真机上直接假红。这里改成开一个 fd 指着
  // 旧文件,bless 之后从那个 fd 读:`install` 下读到旧内容,`cp` 下读到新内容。
  withDir((dir) => {
    const dataDir = join(dir, "data");
    const bin = join(dataDir, "deploy", "bin");
    mkdirSync(bin, { recursive: true });
    const target = join(bin, "deployer.sh");
    writeFileSync(target, "旧内容\n");

    // fd 3 在 bless 之前打开,bless 之后再读 —— 正是"正在跑的脚本"的处境。
    const held = execFileSync(
      "bash",
      [
        "-c",
        `exec 3< "${target}"; bash "${join(EVOLVE_DIR, "bless.sh")}" >/dev/null 2>&1; cat <&3`,
      ],
      {
        encoding: "utf8",
        env: cleanEnv({
          CATMAN_DATA_DIR: dataDir,
          CATMAN_HOST_DATA_DIR: dataDir,
          DOCKER_GID: "999",
        }),
      },
    );
    assert.equal(held.trim(), "旧内容", "已打开的 fd 必须还看得到旧字节");
    assert.match(readFileSync(target, "utf8"), /deployer/, "而新读者拿到的是新版本");
  });
});

// ── 看门狗降级 ────────────────────────────────────────────────────

test("降级目标:第 N 级 = 清单里第 N 个「不是 current 且校验得过」的 release", () => {
  withDir((dir) => {
    for (const sha of ["aaa111", "bbb222", "ccc333"]) makeRelease(dir, sha);
    inLib(dir, `pointer_set current aaa111`);
    inLib(dir, `history_push ccc333; history_push bbb222; history_push aaa111`);
    // 清单(新→旧)= aaa111, bbb222, ccc333;current 是 aaa111,所以跳过它。
    assert.equal(inLib(dir, `pick_demote_target 1`), "bbb222");
    assert.equal(inLib(dir, `pick_demote_target 2`), "ccc333");
  });
});

test("降级目标:校验不过的跳过但**不占级数**", () => {
  // 占了级数的话,"第 2 级"会指向一个比预期更旧的版本 —— 而看门狗每级只退一次,
  // 那一格就被永久跳过去了。
  withDir((dir) => {
    for (const sha of ["aaa111", "bbb222", "ccc333"]) makeRelease(dir, sha);
    writeFileSync(join(dir, "bbb222", "dist", "src", "index.js"), "// 被改过\n");
    inLib(dir, `pointer_set current aaa111`);
    inLib(dir, `history_push ccc333; history_push bbb222; history_push aaa111`);
    assert.equal(inLib(dir, `pick_demote_target 1`), "ccc333", "坏的那个不该占掉第 1 级");
  });
});

test("降级目标:没有那么多级时返回空,由调用方报警而不是乱选", () => {
  withDir((dir) => {
    makeRelease(dir, "aaa111");
    inLib(dir, `pointer_set current aaa111`);
    inLib(dir, `history_push aaa111`);
    assert.equal(inLib(dir, `pick_demote_target 1 || true`), "");
  });
});

/**
 * 从 deployer.sh 里切出一个函数体。
 *
 * 边界靠"下一个顶格的 `do_xxx() {`"而不是某个写死的函数名 —— 后者会在中间插入
 * 一个新模式时静默地把两个函数并成一段,于是"这个函数里没有 pointer_set stable"
 * 这类断言就变成了在另一个函数上求值,照样全绿。
 */
function deployerFn(name: string): string {
  const body = readFileSync(join(EVOLVE_DIR, "deployer.sh"), "utf8");
  const start = body.indexOf(`${name}() {`);
  assert.ok(start > 0, `deployer.sh 里没有 ${name}`);
  const rest = body.slice(start + name.length);
  const next = rest.search(/\ndo_[a-z_]+\(\) \{/);
  return next < 0 ? rest : rest.slice(0, next);
}

test("**demote 绝不写 stable** —— 指针单主,它只许 deployer 在观察期后前移", () => {
  // 看门狗的判据(容器重启了几次)远弱于观察期。让它写 stable,等于允许一次误判
  // 永久改写「回退目标」这个概念本身 —— 下一次真出事时,它会把 current 拨到
  // 那个被误判抬上去的版本上。
  const fn = deployerFn("do_demote");
  assert.equal(fn.includes("pointer_set stable"), false, "do_demote 里出现了 pointer_set stable");
  // 反面对照:rollback 是**人**的判断,它该写 stable —— 少了这条,把两处都删掉也全绿。
  assert.ok(deployerFn("do_rollback").includes("pointer_set stable"), "rollback 反而必须写 stable");
});

test("**courier-fallback 只动 pinned** —— current / stable / pinned-prev 一个都不碰", () => {
  // 它是整套脚本里唯一会自动改写**稳定面**的动作。多碰一个指针的后果:
  //   - 动 current  → 把主人格一起换掉,而信使崩了不是它的错,无谓扩大故障面;
  //   - 动 stable   → 一次机械误判永久改写「回退目标」这个概念本身(与 demote 同罪);
  //   - 动 pinned-prev → 把"我们是从哪儿退过来的"这条唯一记录抹掉。
  const fn = deployerFn("do_courier_fallback");
  for (const p of ["current", "stable", "pinned-prev"]) {
    assert.equal(
      fn.includes(`pointer_set ${p}`),
      false,
      `do_courier_fallback 里出现了 pointer_set ${p}`,
    );
  }
  // 正面:它必须确实换 pinned,否则上面几条断言在一个空函数上也全绿。
  assert.ok(fn.includes("pointer_set pinned "), "它得真的换 pinned");
  // 重启的必须是**信使**。写成默认的 $CATMAN_CONTAINER 就变成"换了信使的代码、
  // 重启了主人格" —— 两边都没救到,而日志上看起来一切照做了。
  assert.ok(fn.includes("$CATMAN_COURIER_CONTAINER"), "要重启的是信使容器");
  assert.equal(
    /container_(stop|start|restarts)\s*$|container_(stop|start)\n/.test(fn),
    false,
    "不能用不带容器名的默认形式",
  );
});

test("courier-fallback 换指针之前先验目标的内容清单", () => {
  // 退到一个字节已经损坏的 release 上,结果是两份都起不来,而人还以为退过了。
  const fn = deployerFn("do_courier_fallback");
  const verify = fn.indexOf("release_verify");
  const set = fn.indexOf("pointer_set pinned ");
  assert.ok(verify > 0, "缺少 release_verify");
  assert.ok(verify < set, "校验必须排在换指针之前");
});

test("gc 模式只清理,不碰任何指针、不写部署报告", () => {
  // report.json 是"上一次部署的结果",catman 靠它向用户播报 —— 清理覆写它,
  // 会把一条(可能是失败的)部署结果永久顶掉。
  const fn = deployerFn("do_gc");
  assert.ok(fn.includes("release_gc"), "得真的清理");
  assert.equal(fn.includes("pointer_set"), false, "GC 不该动指针");
  assert.equal(/\breport /.test(fn), false, "GC 不该写部署报告");
  assert.ok(fn.includes("lock_acquire"), "要抢部署锁 —— 与部署互斥");
});

test("drill 的结果写 ignition.json,绝不写 report.json", () => {
  // 两份文件、两个消费者:report.json 归部署播报,ignition.json 归状态页。
  const fn = deployerFn("do_drill");
  assert.ok(fn.includes("ignition.json"));
  assert.equal(/\breport /.test(fn.replace(/ignition_report/g, "IR")), false,
    "drill 里不该调部署报告的 report()");
});

test("drill 覆盖冷启动那天的每个关节:字节 → 自检 → 健康 → 回滚机构", () => {
  // 少一项就是一类"断电那天才发现"的故障。顺序也有意义:按依赖排,
  // 前面挂了后面的结论没有意义。
  const fn = deployerFn("do_drill");
  const order = ["release_verify", "smoke ", "health_ok", "history_shas", "pointer_set drill-scratch"];
  let at = -1;
  for (const step of order) {
    const i = fn.indexOf(step);
    assert.ok(i > at, `${step} 缺失或顺序不对`);
    at = i;
  }
});

test("drill 的 dry-run flip 用完就拆,而且开头先清残留 —— 可从任意断点重跑", () => {
  const fn = deployerFn("do_drill");
  // 清残留在 pointer_set 之前(上次 drill 可能死在中间)。
  const cleanup = fn.indexOf('rm -f "$RELEASES_DIR/drill-scratch"');
  const set = fn.indexOf("pointer_set drill-scratch");
  assert.ok(cleanup > 0 && cleanup < set, "开头要清残留");
  // 成功路径的收尾也要拆掉临时指针。
  assert.ok(fn.lastIndexOf('rm -f "$RELEASES_DIR/drill-scratch"') > set, "用完要拆");
});

test("drill 每一种失败都写清 failed 是哪个检查 —— 状态页红灯要能指路", () => {
  const fn = deployerFn("do_drill");
  for (const check of ["pinned", "verify", "smoke", "health", "history", "flip"]) {
    assert.ok(
      fn.includes(`ignition_report false ${check}`),
      `失败分类里缺 ${check}`,
    );
  }
});

/**
 * 造一个**跑得动稳定面**的 release:两个角色的入口文件都在。
 *
 * 光 `mkdir` 出一个空目录是不够的 —— bless 钦定之前会查入口文件,而那正是真机上
 * 出过事的地方(见下面那条用例)。
 */
function makeRunnableRelease(releasesDir: string, sha: string): void {
  const d = join(releasesDir, sha, "dist", "src");
  mkdirSync(join(d, "courier"), { recursive: true });
  writeFileSync(join(d, "index.js"), "", "utf8");
  writeFileSync(join(d, "courier", "main.js"), "", "utf8");
}

test("bless 钦定 pinned,并把旧的存进 pinned-prev —— 钦定错了才有退路", () => {
  // 钦定错误恰恰只会在"信使起不来"时才发现,而那时两个人格已经一起聋了。
  withDir((dir) => {
    const dataDir = join(dir, "data");
    const rel = join(dataDir, "releases");
    mkdirSync(rel, { recursive: true });
    for (const sha of ["old1", "new2"]) makeRunnableRelease(rel, sha);
    symlinkSync("old1", join(rel, "pinned"));
    symlinkSync("new2", join(rel, "stable"));

    execFileSync("bash", [join(EVOLVE_DIR, "bless.sh")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv({ CATMAN_DATA_DIR: dataDir, CATMAN_HOST_DATA_DIR: dataDir, DOCKER_GID: "999" }),
    });
    assert.equal(readlinkSync(join(rel, "pinned")), "new2");
    assert.equal(readlinkSync(join(rel, "pinned-prev")), "old1", "旧的必须留一份");
  });
});

test("**目标跑不动稳定面就拒绝钦定**,而且一个指针都不动", () => {
  // 真机上发生过:bless 默认取 stable,而手工迁移过的机器上 stable 还停在旧拓扑
  // (迁移时是人工切的 current,deployer 没参与,stable 从没被推进过)。
  // 那个 release 目录完好、内容齐全,只是没有 dist/src/courier/main.js ——
  // 于是信使进引导模式转一辈子,而守护人格更糟:它的入口在旧 release 里**存在**,
  // 安安静静地跑起了旧代码。只查"目录存在"抓不到这两种。
  withDir((dir) => {
    const dataDir = join(dir, "data");
    const rel = join(dataDir, "releases");
    mkdirSync(rel, { recursive: true });
    makeRunnableRelease(rel, "good1");
    // 旧拓扑的 release:只有主人格的入口。
    mkdirSync(join(rel, "old2", "dist", "src"), { recursive: true });
    writeFileSync(join(rel, "old2", "dist", "src", "index.js"), "", "utf8");
    symlinkSync("good1", join(rel, "pinned"));
    symlinkSync("old2", join(rel, "stable"));

    let out = "";
    let failed = false;
    try {
      execFileSync("bash", [join(EVOLVE_DIR, "bless.sh")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanEnv({ CATMAN_DATA_DIR: dataDir, CATMAN_HOST_DATA_DIR: dataDir, DOCKER_GID: "999" }),
      });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    assert.ok(failed, "拒绝钦定必须以非零退出 —— 报成功会让人以为稳定面已经换过了");
    assert.match(out, /拒绝把 pinned 指向/);
    assert.match(out, /courier\/main\.js/, "要说清缺的是哪个文件");
    assert.equal(readlinkSync(join(rel, "pinned")), "good1", "pinned 必须原封不动");
    assert.equal(
      existsSync(join(rel, "pinned-prev")),
      false,
      "连 pinned-prev 都不该写 —— 拒绝就是什么都没发生",
    );
  });
});

test("bless 的入口清单必须覆盖 entrypoint 认识的每一个角色", () => {
  // 两份清单分处 bash 与 sh、无法共享,所以让它们在这里对账:加了新角色而漏改
  // bless,后果是 pinned 可以被指到一个跑不动那个角色的 release 上 ——
  // 而这类错误的发现时机是"重启那个容器的时候",往往已经是出事之后。
  const entry = readFileSync(join(EVOLVE_DIR, "..", "..", "docker", "entrypoint.sh"), "utf8");
  const bless = readFileSync(join(EVOLVE_DIR, "bless.sh"), "utf8");
  const entries = [...entry.matchAll(/ENTRY="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(entries.length >= 2, "没从 entrypoint.sh 里解析出入口文件,正则该更新了");
  for (const e of new Set(entries)) {
    assert.ok(bless.includes(e), `bless.sh 的钦定前检查里缺 ${e}`);
  }
});

test("stable 还没立起来时 bless 不乱指 pinned,只报警", () => {
  // 指到空气的话信使会进引导模式转一辈子,而人以为它起来了。
  withDir((dir) => {
    const dataDir = join(dir, "data");
    mkdirSync(join(dataDir, "releases"), { recursive: true });
    const out = execFileSync("bash", [join(EVOLVE_DIR, "bless.sh")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv({ CATMAN_DATA_DIR: dataDir, CATMAN_HOST_DATA_DIR: dataDir, DOCKER_GID: "999" }),
    });
    assert.match(out, /没能钦定 pinned/);
    assert.equal(existsSync(join(dataDir, "releases", "pinned")), false);
  });
});
