import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_SKILL,
  ADMIN_SKILLS,
  EVOLVE_SKILL,
  USER_SKILL,
  USER_SKILLS,
  evolveSkillBody,
} from "../src/core/skills.js";
import { COMMAND_TABLE, canonicalOf } from "../src/core/commands.js";

/**
 * skill 是**上下文过滤而不是沙箱**(SDK 类型注释原文:文件仍在磁盘上、Read/Bash
 * 够得着)。所以这里守两件事:名单分得对,以及正文里没有任何令牌字面量。
 */

const PATHS = {
  srcDir: "/data/src/catman",
  deployBinDir: "/data/deploy/bin",
  releasesDir: "/data/releases",
};

test("自进化 skill 只对管理员回合可见", () => {
  // 改自己的代码并推上线是全局影响的事,与 /发布 /回滚 的 adminOnly 是同一个决定。
  // 更要紧的是 description 常驻上下文:列进普通名单等于告诉每个用户有这条路。
  assert.equal(USER_SKILLS.includes(EVOLVE_SKILL), false);
  assert.equal(ADMIN_SKILLS.includes(EVOLVE_SKILL), true);
  // 顺带钉住另两个的分配没被改乱。
  assert.deepEqual([...USER_SKILLS], [USER_SKILL]);
  assert.equal(ADMIN_SKILLS.includes(ADMIN_SKILL), true);
});

test("自进化 skill 的指令写法从 COMMAND_TABLE 取,不手写字面量", () => {
  // 指令改名时正文要自动跟上 —— 手写的话改名之后 skill 会教出一条不存在的指令,
  // 而 agent 会照着教的去发,用户那边就是"它自言自语了一句斜杠"。
  const body = evolveSkillBody(PATHS);
  assert.ok(body.includes(canonicalOf("publish")));
  assert.ok(body.includes(canonicalOf("rollback")));
  assert.ok(body.includes(canonicalOf("upgradeStatus")));
});

test("自进化 skill 教的制备路径是固化副本,不是 release 里那份", () => {
  // 制备门(全量测试)就在 prepare.sh 里。教 agent 跑 release 里那份 = 让被考的人
  // 自己出卷子:一次把 npm test 改没了的进化会让此后每次制备都不再跑测试。
  const body = evolveSkillBody(PATHS);
  assert.ok(body.includes("/data/deploy/bin/prepare.sh"), "要教固化路径");
  // release 内那条路径只该以「不要跑它」的形式出现,绝不能是一条可照抄的绝对路径。
  assert.equal(body.includes("/data/releases/current/scripts/evolve/prepare.sh"), false);
});

test("自进化 skill 明说不要自己起 deployer —— 确认权在人", () => {
  const body = evolveSkillBody(PATHS);
  assert.match(body, /不要自己起 deployer|绝不.*deployer/);
});

test("skill 正文里绝不出现令牌字面量,只写环境变量引用", () => {
  // Options.skills 不是沙箱:普通用户的 agent 看不到 catman-admin 的列表项,
  // 却照样能 Read 到那个文件。所以令牌只能以 $CATMAN_* 的形式出现。
  const body = evolveSkillBody(PATHS);
  for (const forbidden of ["sk-", "CLAUDE_CODE_OAUTH_TOKEN", "id_ed25519"]) {
    assert.equal(body.includes(forbidden), false, `正文里不该出现 ${forbidden}`);
  }
});

test("路径全部来自参数 —— 换了 CATMAN_DEPLOY_DIR 之后 skill 不会教错地方", () => {
  const body = evolveSkillBody({
    srcDir: "/srv/code",
    deployBinDir: "/srv/deploy/bin",
    releasesDir: "/srv/rel",
  });
  assert.ok(body.includes("/srv/code"));
  assert.ok(body.includes("/srv/deploy/bin/prepare.sh"));
  assert.ok(body.includes("/srv/rel/current"));
  assert.equal(body.includes("/data/"), false, "不该有写死的默认路径漏出来");
});

test("帮助文案里的 /发布 与 skill 说的是同一条指令", () => {
  const publish = COMMAND_TABLE.find((c) => c.name === "publish");
  assert.ok(publish);
  assert.ok(evolveSkillBody(PATHS).includes(publish.canonical));
});
