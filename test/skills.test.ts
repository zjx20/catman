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
  OPS_SKILL,
  RESCUE_SKILL,
  USER_SKILL,
  USER_SKILLS,
  WEBGRAB_SKILL,
  discoverAvailableSkills,
  evolveSkillBody,
  generatedSkillsDir,
  migrateLegacySkills,
  rescueSkillBody,
  resolveSkillGroups,
  sharedSkillsDir,
  skillsFor,
  skillsOnDisk,
  writeSkills,
} from "../src/core/skills.js";
import { COMMAND_TABLE, canonicalOf } from "../src/core/commands.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PATHS = {
  srcDir: "/data/src/catman",
  deployBinDir: "/data/deploy/bin",
  releasesDir: "/data/releases",
  deployDir: "/data/deploy",
  courierDir: "/data/courier",
};

test("自进化 skill 只对管理员回合可见", () => {
  assert.equal(USER_SKILLS.includes(EVOLVE_SKILL), false);
  assert.equal(ADMIN_SKILLS.includes(EVOLVE_SKILL), true);
  assert.deepEqual([...USER_SKILLS], [USER_SKILL, CRON_SKILL]);
  assert.equal(ADMIN_SKILLS.includes(ADMIN_SKILL), true);
});

test("仓库分层内置 skill：webgrab 对主人格全体可见，catman-ops 仅进入主人格管理员列表，救援人格均不挂载", () => {
  withTempDir((dataDir) => {
    writeSkills(generatedSkillsDir(dataDir), { modelAllowlist: ["opus"] }, PATHS, "primary");
    const adminPool = discoverAvailableSkills({ dataDir, releaseDir: REPO_ROOT, isAdmin: true });
    const userPool = discoverAvailableSkills({ dataDir, releaseDir: REPO_ROOT, isAdmin: false });

    assert.ok(skillsFor("primary", true, { onDisk: adminPool }).includes(OPS_SKILL));
    assert.ok(skillsFor("primary", true, { onDisk: adminPool }).includes(WEBGRAB_SKILL));
    assert.ok(!skillsFor("primary", false, { onDisk: userPool }).includes(OPS_SKILL));
    assert.ok(skillsFor("primary", false, { onDisk: userPool }).includes(WEBGRAB_SKILL));

    const userGroups = resolveSkillGroups({ dataDir, releaseDir: REPO_ROOT, persona: "primary", isAdmin: false });
    assert.ok(userGroups.every((g) => g.tier === "user"), "非管理员绝不纳入任何 admin 分组目录");

    writeSkills(generatedSkillsDir(dataDir), { modelAllowlist: ["opus"] }, PATHS, "rescue");
    const rescueGroups = resolveSkillGroups({ dataDir, releaseDir: REPO_ROOT, persona: "rescue", isAdmin: true });
    assert.ok(rescueGroups.every((g) => g.id.startsWith("gen-")), "守护人格只挂 generated-skills 白名单分组");
    assert.ok(!skillsFor("rescue", true, { onDisk: adminPool }).includes(OPS_SKILL));
  });
});

test("自进化 skill 的指令写法从 COMMAND_TABLE 取,不手写字面量", () => {
  const body = evolveSkillBody(PATHS);
  assert.ok(body.includes(canonicalOf("publish")));
  assert.ok(body.includes(canonicalOf("rollback")));
  assert.ok(body.includes(canonicalOf("upgradeStatus")));
});

test("自进化 skill 通过受控接口请求制备", () => {
  const body = evolveSkillBody(PATHS);
  assert.match(body, /api\/execution\/prepare/);
  assert.match(body, /X-Catman-Session/);
  assert.doesNotMatch(body, /docker run|CATMAN_ADMIN_TOKEN/);
});

test("自进化 skill 明说不要自己起 deployer —— 确认权在人", () => {
  const body = evolveSkillBody(PATHS);
  assert.match(body, /不要自己起 deployer|绝不.*deployer/);
});

test("自进化 skill 不教 worker 改写部署指针或自行 bless", () => {
  const body = evolveSkillBody(PATHS);
  assert.match(body, /不要直接修改发布指针或自行 bless/);
});

test("自进化 skill 正文不带某台机器专属的路径 —— 它随仓库走", () => {
  const body = evolveSkillBody(PATHS);
  const hits = body.split("\n").filter((l) => l.includes("/opt/"));
  assert.deepEqual(hits, [], "宿主专属路径要么写全命令,要么指向 README,不能直接留路径");
});

test("skill 正文里绝不出现令牌字面量,只写环境变量引用", () => {
  const body = evolveSkillBody(PATHS);
  for (const forbidden of ["sk-", "CLAUDE_CODE_OAUTH_TOKEN", "id_ed25519"]) {
    assert.equal(body.includes(forbidden), false, `正文里不该出现 ${forbidden}`);
  }
});

test("自进化 skill 使用固定的 worker 内源码路径，与宿主路径无关", () => {
  const body = evolveSkillBody({ ...PATHS, srcDir: "/host-secret/code", deployBinDir: "/host-secret/deploy" });
  assert.match(body, /\/catman-src/);
  assert.doesNotMatch(body, /host-secret/);
});

test("帮助文案里的 /发布 与 skill 说的是同一条指令", () => {
  const publish = COMMAND_TABLE.find((c) => c.name === "publish");
  assert.ok(publish);
  assert.ok(evolveSkillBody(PATHS).includes(publish.canonical));
});

// --- 按人格分派 ---

test("守护人格拿 catman-rescue,拿不到 catman-evolve", () => {
  const rescueAdmin = skillsFor("rescue", true);
  assert.ok(rescueAdmin.includes(RESCUE_SKILL));
  assert.equal(rescueAdmin.includes(EVOLVE_SKILL), false);

  const primaryAdmin = skillsFor("primary", true);
  assert.ok(primaryAdmin.includes(EVOLVE_SKILL));
  assert.equal(primaryAdmin.includes(RESCUE_SKILL), false);
});

test("非管理员回合:主人格给设置与定时任务,守护人格只给设置", () => {
  assert.deepEqual(skillsFor("primary", false), [USER_SKILL, CRON_SKILL]);
  assert.deepEqual(skillsFor("rescue", false), [USER_SKILL]);
  assert.equal(skillsFor("rescue", true).includes(CRON_SKILL), false);
});

test("skillsFor 列出的每个默认 skill，在 generated-skills + 仓库 release/skills 下都能找到实体文件", () => {
  for (const persona of ["primary", "rescue"] as const) {
    withTempDir((dataDir) => {
      const genRoot = generatedSkillsDir(dataDir);
      writeSkills(genRoot, { modelAllowlist: ["opus"] }, PATHS, persona);
      const groups = resolveSkillGroups({ dataDir, releaseDir: REPO_ROOT, persona, isAdmin: true });
      const available = new Set(groups.flatMap((g) => g.entries.map((e) => e.canonicalName)));
      for (const name of skillsFor(persona, true)) {
        assert.ok(available.has(name), `${persona} 的 ${name} 在挂载分组中找不到 SKILL.md`);
      }
    });
  }
});

test("救援 skill 使用固定诊断和恢复接口", () => {
  const body = rescueSkillBody(PATHS);
  assert.match(body, /api\/execution\/diagnostics/);
  assert.match(body, /api\/execution\/recover/);
  assert.match(body, /demote/);
  assert.doesNotMatch(body, /docker restart|docker logs/);
});

test("救援 skill 不教 /发布,那是主人格那边的事", () => {
  const body = rescueSkillBody(PATHS);
  assert.equal(body.includes(canonicalOf("publish")), false);
});

test("救援 skill 不要求 worker 访问宿主数据路径", () => {
  const body = rescueSkillBody({ ...PATHS, deployDir: "/host-secret/deploy", courierDir: "/host-secret/courier" });
  assert.doesNotMatch(body, /host-secret/);
});

test("救援 skill 正文里也没有令牌字面量", () => {
  const body = rescueSkillBody(PATHS);
  for (const forbidden of ["sk-", "CLAUDE_CODE_OAUTH_TOKEN", "id_ed25519"]) {
    assert.equal(body.includes(forbidden), false, `正文里不该出现 ${forbidden}`);
  }
});

// --- 主人格走黑名单:装进 shared/skills/{user,admin}/ 就生效 ---

function plantSkill(parentDir: string, dirName: string, declaredName = dirName): void {
  const dir = join(parentDir, "skills", dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${declaredName}\ndescription: 测试用\n---\n\n正文\n`,
    "utf8",
  );
}

function plantTierSkill(root: string, tier: "user" | "admin", dirName: string, declaredName = dirName): void {
  const dir = join(root, tier, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${declaredName}\ndescription: 测试用\n---\n\n正文\n`,
    "utf8",
  );
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "catman-skills-disk-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("主人格:自定义共享 skill 按 user/admin 分层装入 shared/skills 即按身份生效", () => {
  withTempDir((dataDir) => {
    writeSkills(generatedSkillsDir(dataDir), { modelAllowlist: ["opus"] }, PATHS, "primary");
    plantTierSkill(sharedSkillsDir(dataDir), "user", "catman-mediacenter");
    plantTierSkill(sharedSkillsDir(dataDir), "admin", "ops-audit");

    const userDisk = discoverAvailableSkills({ dataDir, releaseDir: REPO_ROOT, isAdmin: false });
    const adminDisk = discoverAvailableSkills({ dataDir, releaseDir: REPO_ROOT, isAdmin: true });

    assert.ok(skillsFor("primary", false, { onDisk: userDisk }).includes("catman-mediacenter"));
    assert.equal(skillsFor("primary", false, { onDisk: userDisk }).includes("ops-audit"), false);
    assert.ok(skillsFor("primary", true, { onDisk: adminDisk }).includes("catman-mediacenter"));
    assert.ok(skillsFor("primary", true, { onDisk: adminDisk }).includes("ops-audit"));
  });
});

test("主人格:非管理员回合仍然减掉管理员专用 skill", () => {
  const pool = [...ADMIN_SKILLS, "catman-mediacenter"];
  const got = skillsFor("primary", false, { onDisk: pool });
  for (const gated of ADMIN_ONLY_SKILLS) {
    assert.equal(got.includes(gated), false, `${gated} 不该给普通用户`);
  }
  assert.deepEqual(got, [USER_SKILL, CRON_SKILL, "catman-mediacenter"]);
});

test("主人格:disabledSkills 能临时关掉一个装好的 skill", () => {
  const pool = [...ADMIN_SKILLS, "catman-mediacenter"];
  const got = skillsFor("primary", true, { onDisk: pool, disabled: ["catman-mediacenter"] });
  assert.equal(got.includes("catman-mediacenter"), false);
  assert.ok(got.includes(EVOLVE_SKILL), "禁一个不该带走别的");
});

test("主人格:catman-rescue 就算躺在盘上也不给", () => {
  const got = skillsFor("primary", true, { onDisk: [...ADMIN_SKILLS, RESCUE_SKILL] });
  assert.equal(got.includes(RESCUE_SKILL), false);
});

test("磁盘读不到时退回硬编码名单 —— 一次 readdir 失败不该让它连改配置都不会", () => {
  assert.deepEqual(skillsFor("primary", true, {}), [...ADMIN_SKILLS]);
  assert.deepEqual(skillsFor("primary", true, { onDisk: [] }), [...ADMIN_SKILLS]);
  assert.deepEqual(skillsFor("primary", false, { onDisk: [] }), [...USER_SKILLS]);
});

test("守护人格是白名单:磁盘现状与 disabledSkills 都动不了它", () => {
  const noisy = { onDisk: ["catman-mediacenter", EVOLVE_SKILL], disabled: [RESCUE_SKILL] };
  assert.deepEqual(skillsFor("rescue", true, noisy), [USER_SKILL, ADMIN_SKILL, RESCUE_SKILL]);
  assert.deepEqual(skillsFor("rescue", false, noisy), [USER_SKILL]);
});

// --- skillsOnDisk ---

test("skillsOnDisk 取 frontmatter 的 name,不是目录名", () => {
  withTempDir((dir) => {
    plantSkill(dir, "my-dir", "actual-name");
    assert.deepEqual(skillsOnDisk(dir), ["actual-name"]);
  });
});

test("skillsOnDisk 跳过没有 SKILL.md 的目录与点开头的目录", () => {
  withTempDir((dir) => {
    plantSkill(dir, "good");
    mkdirSync(join(dir, "skills", "not-a-skill"), { recursive: true });
    plantSkill(dir, ".trash");
    mkdirSync(join(dir, "skills", "synced", "inner"), { recursive: true });
    assert.deepEqual(skillsOnDisk(dir), ["good"]);
  });
});

test("skillsOnDisk 读不到目录返回空数组,而不是抛错", () => {
  withTempDir((dir) => {
    assert.deepEqual(skillsOnDisk(join(dir, "根本不存在")), []);
  });
});

// --- writeSkills 的分层写入与清理 ---

test("writeSkills 按 user/admin 分层写入，切换人格时清掉旧生成物", () => {
  withTempDir((genRoot) => {
    writeSkills(genRoot, { modelAllowlist: ["opus"] }, PATHS, "primary");
    assert.ok(existsSync(join(genRoot, "user", USER_SKILL, "SKILL.md")));
    assert.ok(existsSync(join(genRoot, "user", CRON_SKILL, "SKILL.md")));
    assert.ok(existsSync(join(genRoot, "admin", ADMIN_SKILL, "SKILL.md")));
    assert.ok(existsSync(join(genRoot, "admin", EVOLVE_SKILL, "SKILL.md")));

    writeSkills(genRoot, { modelAllowlist: ["opus"] }, PATHS, "rescue");
    assert.equal(existsSync(join(genRoot, "admin", EVOLVE_SKILL)), false, "换人格后旧的要没了");
    assert.equal(existsSync(join(genRoot, "user", CRON_SKILL)), false, "守护人格那边没有调度器");
    assert.ok(existsSync(join(genRoot, "admin", RESCUE_SKILL, "SKILL.md")));
  });
});

test("GENERATED_SKILLS 覆盖两个人格生成的全部名字 —— 漏一个就是漏清一个", () => {
  withTempDir((genRoot) => {
    for (const persona of ["primary", "rescue"] as const) {
      writeSkills(genRoot, { modelAllowlist: ["opus"] }, PATHS, persona);
    }
    const planted = GENERATED_SKILLS.filter(
      (n) => existsSync(join(genRoot, "user", n)) || existsSync(join(genRoot, "admin", n)),
    );
    assert.deepEqual(planted.sort(), [ADMIN_SKILL, RESCUE_SKILL, USER_SKILL].sort());
  });
});

// --- 历史 claude/skills 平滑迁移 ---

test("migrateLegacySkills 将存量自定义 skill 迁入 shared/skills/user，归档仓库同名旧副本并清空 claude/skills", () => {
  withTempDir((dataDir) => {
    // 模拟升级前的历史 <dataDir>/claude/skills/ 混放状态 + OAuth 凭据
    mkdirSync(join(dataDir, "claude"), { recursive: true });
    writeFileSync(join(dataDir, "claude", ".credentials.json"), '{"oauth":true}');
    plantSkill(join(dataDir, "claude"), USER_SKILL);
    plantSkill(join(dataDir, "claude"), OPS_SKILL);
    plantSkill(join(dataDir, "claude"), WEBGRAB_SKILL);
    writeFileSync(join(dataDir, "claude", "skills", WEBGRAB_SKILL, "webgrab.mjs"), "stale-31kb");
    plantSkill(join(dataDir, "claude"), "agentmail");
    plantSkill(join(dataDir, "claude"), "wechat-article");

    // 同时验证顶层直接丢入 shared/skills/<name> 也会自动归一到 user/
    mkdirSync(join(sharedSkillsDir(dataDir), "flat-custom"), { recursive: true });
    writeFileSync(join(sharedSkillsDir(dataDir), "flat-custom", "SKILL.md"), "---\nname: flat-custom\ndescription: x\n---\n");

    migrateLegacySkills(dataDir, REPO_ROOT);

    assert.ok(existsSync(join(dataDir, "claude", ".credentials.json")), "Claude 凭据原样保留");
    assert.equal(existsSync(join(dataDir, "claude", "skills")), false, "迁空后移除历史 claude/skills");
    assert.ok(existsSync(join(sharedSkillsDir(dataDir), "user", "agentmail", "SKILL.md")));
    assert.ok(existsSync(join(sharedSkillsDir(dataDir), "user", "wechat-article", "SKILL.md")));
    assert.ok(existsSync(join(sharedSkillsDir(dataDir), "user", "flat-custom", "SKILL.md")));
    assert.equal(existsSync(join(sharedSkillsDir(dataDir), "user", WEBGRAB_SKILL)), false, "仓库同名旧副本不进入 shared/skills 遮蔽新版");
    assert.equal(
      readFileSync(join(dataDir, "claude", ".migrated-repo-skills", WEBGRAB_SKILL, "webgrab.mjs"), "utf8"),
      "stale-31kb",
      "旧副本归档备查不丢文件",
    );
  });
});

test("index.ts 把分层 skillSources 交给了网关与定时任务 —— 不传就静默退回兜底名单", () => {
  const index = readFileSync(join(REPO_ROOT, "src", "index.ts"), "utf8");
  assert.match(index, /skillSources,\s*\n\s*\/\/ token 到期告警/m, "网关那处");
  assert.match(index, /skillSources:\s*deps\.skillSources/, "定时任务那处");
});

test("catman-admin 正文讲清 shared/skills 分层安装与 disabledSkills 关闭办法", () => {
  withTempDir((genRoot) => {
    writeSkills(genRoot, { modelAllowlist: ["opus"] }, PATHS, "primary");
    const body = readFileSync(join(genRoot, "admin", ADMIN_SKILL, "SKILL.md"), "utf8");
    assert.match(body, /shared\/skills\/user\/<名字>/, "要说清装进 shared/skills/user 就生效");
    assert.match(body, /shared\/skills\/admin\/<名字>/, "要说清管理员专属目录");
    assert.match(body, /disabledSkills/, "要给出关闭的办法");
    assert.match(body, /禁用的 skill/);
    assert.match(body, /守护人格.*白名单/s, "要说清它管不着守护人格");
  });
});
