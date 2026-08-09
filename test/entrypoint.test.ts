import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `docker/entrypoint.sh` 的分流。
 *
 * 它只有三条路径,但每一条错了都表现为「容器起来了、什么也没干」——
 * 而整条自进化流水线全靠一次性容器干活(制备、自检、部署,以及宿主没有 bash 时的
 * init/bless),它们都是 `docker run <镜像> <命令>` 的形式。所以这里直接把脚本跑起来验。
 *
 * 不需要 docker:入口脚本是纯 /bin/sh,把 CATMAN_RELEASE_LINK 指到临时目录就能验全部三条。
 */

const ENTRY = fileURLToPath(new URL("../docker/entrypoint.sh", import.meta.url));

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "catman-entry-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 跑入口脚本,返回合并后的输出。`timeoutSec` 用于引导模式那条会一直转的路径。 */
function run(link: string, args: string[], timeoutSec = 0): string {
  const cmd = timeoutSec
    ? ["timeout", `${timeoutSec}`, "sh", ENTRY, ...args]
    : ["sh", ENTRY, ...args];
  try {
    return execFileSync(cmd[0]!, cmd.slice(1), {
      encoding: "utf8",
      env: { ...process.env, CATMAN_RELEASE_LINK: link, CATMAN_BOOTSTRAP_RETRY_SECONDS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // timeout 杀掉进程算预期(引导模式本来就不会自己退出),取已产出的输出。
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

/** 造一个能被入口脚本认出来的 release 目录。 */
function makeRelease(dir: string, name = "rel1"): string {
  const rel = join(dir, name);
  mkdirSync(join(rel, "dist", "src"), { recursive: true });
  writeFileSync(join(rel, "dist", "src", "index.js"), `console.log("APP-STARTED ${name}");\n`);
  return rel;
}

test("给了显式命令就跑命令 —— 整条流水线的一次性容器全靠这条", () => {
  // 这是最容易漏的一条:ENTRYPOINT 一旦不认显式命令,`docker run <镜像> bash prepare.sh`
  // 里的命令会变成 node 的 argv,容器"起来了"但什么也没干。
  withDir((dir) => {
    const rel = makeRelease(dir);
    symlinkSync(rel, join(dir, "current"));
    const out = run(join(dir, "current"), ["echo", "COMMAND-RAN"]);
    assert.match(out, /COMMAND-RAN/);
    assert.doesNotMatch(out, /APP-STARTED/, "有显式命令时绝不能顺带把 catman 也起起来");
  });
});

test("给了显式命令时,连 release 链接都不去解析", () => {
  // 首次初始化就是这个状态:release 还不存在,而 init/bless 正要在容器里跑。
  // 若这时仍去解析链接,就会掉进引导模式的死循环 —— 初始化永远完不成。
  withDir((dir) => {
    const out = run(join(dir, "根本不存在"), ["echo", "COMMAND-RAN"]);
    assert.match(out, /COMMAND-RAN/);
    assert.doesNotMatch(out, /还没有可运行的 release/, "不该退到引导模式");
  });
});

test("没给命令时按 release 链接起应用", () => {
  withDir((dir) => {
    const rel = makeRelease(dir, "rel2");
    symlinkSync(rel, join(dir, "current"));
    const out = run(join(dir, "current"), []);
    assert.match(out, /\[entrypoint\] release=/);
    assert.match(out, /APP-STARTED rel2/);
  });
});

test("没给命令且链接解析不到时进引导模式:慢速重试,不 crash-loop", () => {
  // 全新机器上数据卷是空的。直接 exec 会让容器以最快速度反复重启刷屏,
  // 而真正该做的事(跑一次 init)没有任何提示。
  withDir((dir) => {
    const out = run(join(dir, "current"), [], 3);
    assert.match(out, /还没有可运行的 release/);
    assert.match(out, /init\.sh/, "指引里要写清下一步做什么");
  });
});

test("悬空链接与链接不存在是同一个结果 —— 都是「没有可跑的代码」", () => {
  withDir((dir) => {
    symlinkSync(join(dir, "已经被删掉的目录"), join(dir, "current"));
    const out = run(join(dir, "current"), [], 3);
    assert.match(out, /还没有可运行的 release/);
  });
});
