import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_ONLY_SKILLS,
  ADMIN_SKILL,
  ADMIN_SKILLS,
  CRON_SKILL,
  EVOLVE_SKILL,
  GENERATED_SKILLS,
  RESCUE_SKILL,
  USER_SKILL,
  USER_SKILLS,
  evolveSkillBody,
  rescueSkillBody,
  skillsFor,
  skillsOnDisk,
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

// --- 主人格走黑名单:装进 skills/ 就生效 ---

/** 在临时 configDir 下造一个 skill 目录。不传 declaredName 就让 frontmatter 与目录名一致。 */
function plantSkill(configDir: string, dirName: string, declaredName = dirName): void {
  const dir = join(configDir, "skills", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${declaredName}\ndescription: 测试用\n---\n\n正文\n`,
    "utf8",
  );
}

function withConfigDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "catman-skills-disk-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("主人格:手写 skill 装进目录就进上下文,不用在代码里登记", () => {
  // 这条是这次改动的**本体**。旧版是白名单,于是三个手写 skill(mediacenter /
  // publish / container-work)在盘上躺了十几天一直是哑的 —— 而共享人设的正文
  // 还在点名让人去用它们。能往 skills/ 里写文件的只有管理员和 catman 自己,
  // 装进去这个动作本身就是认可。
  const got = skillsFor("primary", true, { onDisk: [...ADMIN_SKILLS, "catman-mediacenter"] });
  assert.ok(got.includes("catman-mediacenter"));
});

test("主人格:非管理员回合仍然减掉 catman-admin / catman-evolve", () => {
  // 黑名单换掉的是「存在性登记」,不是权限门。后者照旧 ——
  // description 常驻上下文,列出来等于告诉每个用户有这条路。
  const pool = [...ADMIN_SKILLS, "catman-mediacenter"];
  const got = skillsFor("primary", false, { onDisk: pool });
  for (const gated of ADMIN_ONLY_SKILLS) {
    assert.equal(got.includes(gated), false, `${gated} 不该给普通用户`);
  }
  // 挡的只是那两个,别的照给。
  assert.deepEqual(got, [USER_SKILL, CRON_SKILL, "catman-mediacenter"]);
});

test("主人格:disabledSkills 能临时关掉一个装好的 skill", () => {
  // SDK 没有按名字禁用单个 skill 的开关(只有 disableBundledSkills 那种整批的),
  // 所以这个开关必须由 catman 自己给 —— 否则"关掉它"只能靠把文件挪走。
  const pool = [...ADMIN_SKILLS, "catman-mediacenter"];
  const got = skillsFor("primary", true, { onDisk: pool, disabled: ["catman-mediacenter"] });
  assert.equal(got.includes("catman-mediacenter"), false);
  assert.ok(got.includes(EVOLVE_SKILL), "禁一个不该带走别的");
});

test("主人格:catman-rescue 就算躺在盘上也不给", () => {
  // 它教的是「怎么把版本退回去」,而主人格正是被退的那一方 ——
  // 何况退版本要先停容器,它就跑在那个容器里。
  const got = skillsFor("primary", true, { onDisk: [...ADMIN_SKILLS, RESCUE_SKILL] });
  assert.equal(got.includes(RESCUE_SKILL), false);
});

test("磁盘读不到时退回硬编码名单 —— 一次 readdir 失败不该让它连改配置都不会", () => {
  // 与 settings.ts 开头那条「任何配置状态下 agent 都必须能起来」同一个考虑。
  assert.deepEqual(skillsFor("primary", true, {}), [...ADMIN_SKILLS]);
  assert.deepEqual(skillsFor("primary", true, { onDisk: [] }), [...ADMIN_SKILLS]);
  assert.deepEqual(skillsFor("primary", false, { onDisk: [] }), [...USER_SKILLS]);
});

test("守护人格是白名单:磁盘现状与 disabledSkills 都动不了它", () => {
  // 它的价值就是没有惊喜 —— 跑钉住的稳定版本,被叫来时人正在等它诊断。
  // 尤其:一个手滑的禁用不该让救援手册在最需要它的时候消失,而解除禁用要走
  // 主人格那边的配置接口,那时主人格多半正不好使。
  const noisy = { onDisk: ["catman-mediacenter", EVOLVE_SKILL], disabled: [RESCUE_SKILL] };
  assert.deepEqual(skillsFor("rescue", true, noisy), [USER_SKILL, ADMIN_SKILL, RESCUE_SKILL]);
  assert.deepEqual(skillsFor("rescue", false, noisy), [USER_SKILL]);
});

// --- skillsOnDisk ---

test("skillsOnDisk 取 frontmatter 的 name,不是目录名", () => {
  // SDK 按 canonical name 匹配(类型注释:display names and aliases do not match)。
  // 目录名与 name 不一致时报目录名等于没列 —— 而且是安静地没列。
  withConfigDir((dir) => {
    plantSkill(dir, "my-dir", "actual-name");
    assert.deepEqual(skillsOnDisk(dir), ["actual-name"]);
  });
});

test("skillsOnDisk 跳过没有 SKILL.md 的目录与点开头的目录", () => {
  withConfigDir((dir) => {
    plantSkill(dir, "good");
    mkdirSync(join(dir, "skills", "not-a-skill"), { recursive: true });
    plantSkill(dir, ".trash");
    // synced/ 装的是一批 skill 而不是一个,没有顶层 SKILL.md。
    mkdirSync(join(dir, "skills", "synced", "inner"), { recursive: true });
    assert.deepEqual(skillsOnDisk(dir), ["good"]);
  });
});

test("skillsOnDisk 读不到目录返回空数组,而不是抛错", () => {
  // 抛错会把整个回合带走。空数组交给 skillsFor 退回兜底名单。
  withConfigDir((dir) => {
    assert.deepEqual(skillsOnDisk(join(dir, "根本不存在")), []);
  });
});

// --- writeSkills 的清理 ---

test("writeSkills 清掉这个人格不要的旧生成物 —— 否则黑名单会把它复活", () => {
  // 真实残留:守护人格的 skills/ 下躺着一份 Aug 10 的 catman-evolve,名单里没有它
  // 所以一直是哑的,但内容早就跟不上了。主人格改走黑名单之后,这种残留会自己
  // 冒出来,那时它不是多占几个 token,而是在主动教错。
  withConfigDir((dir) => {
    writeSkills(dir, { modelAllowlist: ["opus"] }, PATHS, "primary");
    assert.ok(existsSync(join(dir, "skills", EVOLVE_SKILL, "SKILL.md")));

    writeSkills(dir, { modelAllowlist: ["opus"] }, PATHS, "rescue");
    assert.equal(existsSync(join(dir, "skills", EVOLVE_SKILL)), false, "换人格后旧的要没了");
    assert.equal(existsSync(join(dir, "skills", CRON_SKILL)), false, "守护人格那边没有调度器");
    assert.ok(existsSync(join(dir, "skills", RESCUE_SKILL, "SKILL.md")));
  });
});

test("writeSkills 只清自己生成过的那几个名字,手写 skill 一个都不碰", () => {
  // 这是黑名单模型能成立的前提:清理若按"名单外一律删",第一次启动就会把
  // 管理员手写的 skill 全部抹掉。
  withConfigDir((dir) => {
    plantSkill(dir, "catman-mediacenter");
    plantSkill(dir, "catman-publish");
    writeSkills(dir, { modelAllowlist: ["opus"] }, PATHS, "primary");
    writeSkills(dir, { modelAllowlist: ["opus"] }, PATHS, "rescue");
    assert.ok(existsSync(join(dir, "skills", "catman-mediacenter", "SKILL.md")));
    assert.ok(existsSync(join(dir, "skills", "catman-publish", "SKILL.md")));
  });
});

test("GENERATED_SKILLS 覆盖两个人格生成的全部名字 —— 漏一个就是漏清一个", () => {
  withConfigDir((dir) => {
    for (const persona of ["primary", "rescue"] as const) {
      writeSkills(dir, { modelAllowlist: ["opus"] }, PATHS, persona);
    }
    // 清理只认 GENERATED_SKILLS;写出来却不在那份名单里的,换人格时会永远留下。
    const planted = GENERATED_SKILLS.filter((n) => existsSync(join(dir, "skills", n)));
    assert.deepEqual(planted.sort(), [ADMIN_SKILL, RESCUE_SKILL, USER_SKILL].sort());
  });
});

test("index.ts 把 CLAUDE_CONFIG_DIR 交给了网关与定时任务 —— 不传就静默退回白名单", () => {
  // skillsDir 是可选的(单测里的 Gateway 不需要它),于是漏传的表现是"功能安静地
  // 没生效":手写 skill 又变回哑的,而且没有任何报错。用源码文本钉住这两处装配。
  const index = readFileSync(
    join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "src"), "index.ts"),
    "utf8",
  );
  assert.match(index, /skillsDir: configDir/, "网关那处");
  assert.match(index, /skillsDir: deps\.skillsDir/, "定时任务那处");
});

test("catman-admin 正文讲清 skill 怎么开怎么关 —— 这是唯一的关闭开关", () => {
  // SDK 只有"整批关掉内置 skill"那种开关,没有按名字禁用单个的。管理员要是不知道
  // disabledSkills 存在,就只能去挪文件 —— 那是不可逆的手工操作。
  withConfigDir((dir) => {
    writeSkills(dir, { modelAllowlist: ["opus"] }, PATHS, "primary");
    const body = readFileSync(join(dir, "skills", ADMIN_SKILL, "SKILL.md"), "utf8");
    assert.match(body, /装进 .*skills\/<名字>/, "要说清装进目录就生效");
    assert.match(body, /disabledSkills/, "要给出关闭的办法");
    // 全局配置表由 SETTING_SCHEMA 生成,这一项漏进去就等于开关不存在。
    assert.match(body, /禁用的 skill/);
    assert.match(body, /守护人格.*白名单/s, "要说清它管不着守护人格");
  });
});
