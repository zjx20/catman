import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMIN_SKILL,
  ADMIN_SKILLS,
  CRON_SKILL,
  EVOLVE_SKILL,
  RESCUE_SKILL,
  USER_SKILL,
  USER_SKILLS,
  evolveSkillBody,
  rescueSkillBody,
  skillsFor,
  writeSkills,
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
  deployDir: "/data/deploy",
  courierDir: "/data/courier",
};

test("自进化 skill 只对管理员回合可见", () => {
  // 改自己的代码并推上线是全局影响的事,与 /发布 /回滚 的 adminOnly 是同一个决定。
  // 更要紧的是 description 常驻上下文:列进普通名单等于告诉每个用户有这条路。
  assert.equal(USER_SKILLS.includes(EVOLVE_SKILL), false);
  assert.equal(ADMIN_SKILLS.includes(EVOLVE_SKILL), true);
  // 顺带钉住另几个的分配没被改乱。定时任务是每人自己的(接口按回合令牌定身份),
  // 所以它在普通名单里 —— 与改自己的设置同一个模型。
  assert.deepEqual([...USER_SKILLS], [USER_SKILL, CRON_SKILL]);
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

test("自进化 skill 明说 bless 要管理员开口 —— 固化的是判卷子的门本身", () => {
  const body = evolveSkillBody(PATHS);
  assert.match(body, /默认不自己 bless/);
  // 授权之后代跑也有两条不能松,少哪条都会把「批准了哪棵树」和「固化了哪棵树」拆开。
  assert.match(body, /releases\/current/, "要说清固化源必须是批准过的那棵树");
  assert.match(body, /CATMAN_PIN/, "要说清 pinned 得显式传,别让它默认跟着 stable 走");
});

test("自进化 skill 正文不带某台机器专属的路径 —— 它随仓库走", () => {
  // 真机上有个包好的 bless 壳(/opt/services/catman/bless.sh),写进正文很顺手,
  // 但那是一台机器上的私有文件:换个部署它不存在,而正文照样在教人去跑它。
  // 同理适用于任何 /opt/ 下的宿主路径 —— 要说"怎么跑"就把命令本身写全。
  const body = evolveSkillBody(PATHS);
  const hits = body.split("\n").filter((l) => l.includes("/opt/"));
  assert.deepEqual(hits, [], "宿主专属路径要么写全命令,要么指向 README,不能直接留路径");
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
    deployDir: "/srv/deploy",
    courierDir: "/srv/courier",
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

// --- 按人格分派 ---

test("守护人格拿 catman-rescue,拿不到 catman-evolve", () => {
  // 不是两者都给:它跑钉住的稳定版本,改了代码也上不了线,而人正在等它诊断。
  // skill 的 description 常驻上下文 —— 摆一份"怎么改自己的代码"在那儿,
  // 就是在邀请它去做一件注定白费的事。
  const rescueAdmin = skillsFor("rescue", true);
  assert.ok(rescueAdmin.includes(RESCUE_SKILL));
  assert.equal(rescueAdmin.includes(EVOLVE_SKILL), false);

  const primaryAdmin = skillsFor("primary", true);
  assert.ok(primaryAdmin.includes(EVOLVE_SKILL));
  assert.equal(primaryAdmin.includes(RESCUE_SKILL), false);
});

test("非管理员回合:主人格给设置与定时任务,守护人格只给设置", () => {
  assert.deepEqual(skillsFor("primary", false), [USER_SKILL, CRON_SKILL]);
  // 守护人格里没有调度器,连接口都不存在 —— 摆一份说明只会让它去调一个必然 404 的东西。
  assert.deepEqual(skillsFor("rescue", false), [USER_SKILL]);
  assert.equal(skillsFor("rescue", true).includes(CRON_SKILL), false);
});

test("skillsFor 列出的每个 skill,writeSkills 都真的写了文件", () => {
  // 列一个磁盘上没有的 skill,SDK 那边只是安静地少一份说明 ——
  // 而它恰好是最需要的那份(守护人格的诊断手册)。两处分支必须对齐。
  for (const persona of ["primary", "rescue"] as const) {
    const dir = mkdtempSync(join(tmpdir(), `catman-skills-${persona}-`));
    try {
      writeSkills(dir, { modelAllowlist: ["opus"] }, PATHS, persona);
      for (const name of skillsFor(persona, true)) {
        assert.ok(
          existsSync(join(dir, "skills", name, "SKILL.md")),
          `${persona} 的 ${name} 没被写出来`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("救援 skill 教的是诊断与退版本,不是改代码", () => {
  const body = rescueSkillBody(PATHS);
  assert.match(body, /你不改代码/);
  assert.match(body, /demote/, "退版本走固化的 deployer");
  assert.match(body, /绝不自己动.*符号链接/s, "换指针要先停容器,而它就跑在容器里");
  // stable 是"回退目标"这个概念本身,机械判据不该改写它。
  assert.match(body, /绝不动 `stable`|绝不动 stable/);
});

test("救援 skill 不教 /发布,那是主人格那边的事", () => {
  // 部署确认口令由管理员在主人格那边亲手打。守护人格代劳等于把这把锁拆了,
  // 而它恰好是判断"要不要换版本"的那一方。
  const body = rescueSkillBody(PATHS);
  assert.equal(body.includes(canonicalOf("publish")), false);
});

test("救援 skill 的路径全部来自参数", () => {
  const body = rescueSkillBody({
    srcDir: "/srv/code",
    deployBinDir: "/srv/deploy/bin",
    releasesDir: "/srv/rel",
    deployDir: "/srv/deploy",
    courierDir: "/srv/courier",
  });
  assert.ok(body.includes("/srv/deploy/report.json"), "部署报告");
  assert.ok(body.includes("/srv/rel/current"), "指针");
  assert.ok(body.includes("/srv/courier/inbox"), "信使队列");
  assert.equal(body.includes("/data/"), false, "不该有写死的默认路径漏出来");
});

test("救援 skill 正文里也没有令牌字面量", () => {
  const body = rescueSkillBody(PATHS);
  for (const forbidden of ["sk-", "CLAUDE_CODE_OAUTH_TOKEN", "id_ed25519"]) {
    assert.equal(body.includes(forbidden), false, `正文里不该出现 ${forbidden}`);
  }
});
