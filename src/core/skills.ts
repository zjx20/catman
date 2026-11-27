import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { canonicalOf } from "./commands.js";
import { BUILTIN_ADMIN_USER_KEY } from "./identity.js";
import type { Persona } from "../config.js";
import { SETTING_SCHEMA, USER_SETTING_KEYS, type SettingContext, type SettingKey } from "./settings.js";
import { readScopedFile } from "./scoped-files.js";

/**
 * 把「怎么调自己的配置接口」做成 skill 而不是塞进系统提示词。
 *
 * skill 的 description 常驻上下文、正文按需加载,常态下几乎不占 token ——
 * 而系统提示词是每回合每次都要付钱的。
 *
 * ## 分层与挂载纪律
 *
 * 1. **按来源与权限分层存放，整目录只读挂载，不逐个复制文件：**
 *    - 代码动态生成的接口说明写到 `<dataDir>/execution/generated-skills/{user,admin}/`；
 *    - 仓库维护的内置工具 skill 直接位于 `<releaseDir>/skills/{user,admin}/`（随 release 原子切换）；
 *    - 管理员安装的全站共享自定义 skill 位于 `<dataDir>/shared/skills/{user,admin}/`（不再混入 `claude/skills`）。
 *    worker 创建时按角色身份整目录只读 bind-mount 允许的分组，并在投影目录以软链暴露为一平层 `skills/`。
 *
 * 2. **正文里绝不能出现任何令牌。** Options.skills 是**上下文过滤而不是沙箱**
 *    (SDK 类型注释原文:"files remain on disk and are reachable via Read/Bash.
 *    Do not store secrets in skill files")。除了在挂载层拒绝把 `admin` 分组挂入普通用户容器外,
 *    所有 skill 正文也只写 `$CATMAN_*` 环境变量引用。
 */

export const USER_SKILL = "catman-settings";
export const CRON_SKILL = "catman-cron";
export const ADMIN_SKILL = "catman-admin";
export const EVOLVE_SKILL = "catman-evolve";
export const OPS_SKILL = "catman-ops";
export const RESCUE_SKILL = "catman-rescue";
export const WEBGRAB_SKILL = "webgrab";

export type SkillTier = "user" | "admin";

/**
 * 由 `writeSkills` 动态生成并写入 `<dataDir>/execution/generated-skills/{user,admin}/` 的内置说明。
 */
export const GENERATED_SKILLS: readonly string[] = [
  USER_SKILL,
  CRON_SKILL,
  ADMIN_SKILL,
  EVOLVE_SKILL,
  RESCUE_SKILL,
];

/**
 * 系统内置 skill 全集（代码生成 + 仓库 `skills/{user,admin}/` 随版发布）。
 * 个人 `/user/skills/` 与全局 `shared/skills/` 均不可遮蔽这些名字。
 */
export const BUILTIN_SKILLS: readonly string[] = [
  ...GENERATED_SKILLS,
  OPS_SKILL,
  WEBGRAB_SKILL,
];

/**
 * 主人格里**只给管理员**的内置 skill。
 *
 * 除了挂载层物理隔离 `admin/` 分组目录外，保留名单做双重兜底（防止误放入 `user/` 分组）。
 */
export const ADMIN_ONLY_SKILLS: readonly string[] = [ADMIN_SKILL, EVOLVE_SKILL, OPS_SKILL];

/**
 * 主人格里**谁都不给**的:守护人格那份诊断手册。
 */
const PRIMARY_EXCLUDED: readonly string[] = [RESCUE_SKILL];

/** 磁盘读不到时,普通回合的兜底名单。 */
export const USER_SKILLS: readonly string[] = [USER_SKILL, CRON_SKILL];
/** 磁盘读不到时,admin 回合的兜底名单。 */
export const ADMIN_SKILLS: readonly string[] = [USER_SKILL, CRON_SKILL, ADMIN_SKILL, EVOLVE_SKILL, OPS_SKILL];
/**
 * 守护人格的 admin 回合可见的 skill。**这一支是白名单,不是兜底** —— 见 `skillsFor`。
 */
export const RESCUE_SKILLS: readonly string[] = [USER_SKILL, ADMIN_SKILL, RESCUE_SKILL];

const SAFE_SKILL_DIR = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function generatedSkillsDir(dataDir: string): string {
  return join(dataDir, "execution", "generated-skills");
}

export function sharedSkillsDir(dataDir: string): string {
  return join(dataDir, "shared", "skills");
}

function settingRows(keys: readonly SettingKey[], ctx: SettingContext): string {
  const rows = keys.map((key) => {
    const def = SETTING_SCHEMA[key];
    return `| \`${key}\` | ${def.label} | ${def.hint(ctx)} | ${def.desc} |`;
  });
  return ["| 字段 | 含义 | 取值 | 说明 |", "|---|---|---|---|", ...rows].join("\n");
}

function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

function userSkillBody(ctx: SettingContext): string {
  const globalKeys = (Object.keys(SETTING_SCHEMA) as SettingKey[]).filter(
    (k) => SETTING_SCHEMA[k].scope === "global",
  );
  return `${frontmatter(
    USER_SKILL,
    "读写当前对话用户自己的 catman 设置(模型、回执、进度推送、会话超时、展示名)," +
      "以及为他开一个新会话。用户说想换模型、别刷进度、改超时、重新开始时用它。",
  )}
# 管理当前用户的 catman 设置

你跑在 catman 里。本机有一个 HTTP 接口可以读写**发起这次对话的那个用户**的设置。

## 凭据

- \`$CATMAN_API_BASE\` — 接口地址
- \`$CATMAN_SESSION_TOKEN\` — 本回合有效的令牌,回合一结束就失效

请求头用 \`X-Catman-Session\`。这枚令牌**只能读写当前这个用户**,动不了别人的 ——
不要尝试。

## 读

\`\`\`bash
curl -s -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" "$CATMAN_API_BASE/api/me"
\`\`\`

返回 \`identity\`(含 userKey、展示名、是否管理员)、\`session\`(当前会话 id、
空闲时长、下条消息会不会接着聊)、\`prefs.effective\`(生效值)、\`prefs.overrides\`
(该用户显式设过的项)、\`schema\`(可改哪些、取值范围)、\`commands\`(硬指令清单)。

**拿不准字段名或取值范围时先 GET 看 \`schema\`,不要猜。**

## 改

\`\`\`bash
curl -s -X PATCH -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" \\
     -H 'content-type: application/json' \\
     -d '{"model":"sonnet"}' "$CATMAN_API_BASE/api/me"
\`\`\`

${settingRows(USER_SETTING_KEYS, ctx)}

另外可以改 \`displayName\`(dashboard 上的展示名)。

字段给 \`null\` 表示**清除这一项的覆盖**,回到全局默认。
返回体是改完后的生效值 —— 有些项会被夹到上下限,以返回值为准告诉用户。

## 开新会话

\`\`\`bash
curl -s -X POST -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" \\
     "$CATMAN_API_BASE/api/me/session/reset"
\`\`\`

**本回合结束后**才生效,下一条消息就是全新上下文。要如实这么告诉用户,
别说成"已经清空了"。

## 历史会话

\`\`\`bash
curl -s -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" "$CATMAN_API_BASE/api/me/sessions"
\`\`\`

## 规矩

- **用户没明确要求就不要改设置。** 他只是抱怨进度消息多,先问一句要不要关。
- 生效时机要说清楚:\`model\`、\`sessionTimeoutMs\` 下一轮生效;开新会话本回合结束后生效。
- 改不了的东西别硬试:${globalKeys.map((k) => `\`${k}\``).join("、")} 是全局配置,
  只有管理员能改。用户想改这些,告诉他找管理员。
- 接口返回 400 时,错误文案是写给人看的,直接转述给用户并列出可选值。
`;
}

function cronSkillBody(): string {
  return `${frontmatter(CRON_SKILL, "管理当前用户自己的定时任务。脚本与 agent 任务复用 owner 配置，每个 cron 有独立、持久的 workspace。")}
# 当前用户的定时任务

用 X-Catman-Session: $CATMAN_SESSION_TOKEN 调用 $CATMAN_API_BASE/api/me/cron。
GET 列出；POST 创建；PATCH /<id> 修改；DELETE /<id> 删除；POST /<id>/run 试跑；GET /<id>/runs 查结果。

脚本任务示例：
\`\`\`json
{"name":"每日检查","schedule":{"kind":"cron","expr":"0 8 * * *"},"task":{"kind":"script","cmd":["bash","-lc","./check.sh"]},"timeoutMinutes":10}
\`\`\`
agent 任务的 task 为 {"kind":"agent","prompt":"检查本目录的状态","session":"chain","maxTurns":10}。

法定工作日/休息日调度：\`schedule\` 为 \`{"kind":"cron","expr":"0 9 * * *","calendar":"cn-workday"}\`。
- 默认不填 \`calendar\` 表示全年 365 天都按 \`expr\` 触发。
- 设置 \`calendar\` 后，先按日历规则筛出符合条件的日子，再与 \`expr\` 取交集（AND）：
  - \`"cn-workday"\`：中国大陆所有法定工作日（周一至周五剔除法定节假日 + 周末调休补班日）。
  - \`"cn-restday"\`：中国大陆所有法定休息日（周末剔除调休补班日 + 法定节假日）。
- 注意：若希望周末调休补班日也触发，\`expr\` 的星期位应保持 \`*\`，不要写成 \`1-5\`（否则会与 \`cn-workday\` 取 AND 把周末补班筛掉）；若确实只要「是法定工作日的周一」等进一步过滤条件，再收窄日期/星期位。

每个任务有固定 workspace，多次执行共享其中的游标和台账。聊天、其他 cron 的 workspace 互相隔离。
同一用户的聊天和 cron 共用可读写的 /user。需要跨会话查看或修改的长期提示词、配置、脚本和保留输出，统一放在 /user/projects/<项目>；不要把聊天需要读取的配置仅放在 cron workspace，也不再使用顶层 /user/artifacts。
简单指令可直接写在 task.prompt；较长指引可让 task.prompt 引用项目内的文件。优先沿用项目现有布局；prompt.md、scripts/、outputs/ 只是建议，不强制目录名或层级。读取或修改前先检查实际配置路径，路径调整时同步更新任务和相关 skill 的引用，保持一份权威配置，不另建可能过期的缓存副本。
执行中的中间文件和任务私有状态留在 cron workspace；个人 skill 放 /user/skills。自己的项目配置不需要宿主运维授权。
不接受宿主挂载、镜像、网络或资源参数；执行环境由服务端按 owner 授权生成。
每次执行必须受 timeoutMinutes 限制；它启动的后台任务也必须用 catman-task run --timeout <秒> -- <命令> 登记。
长期运行的 server 属于部署。不要用后台进程代替部署。
`;
}

function adminSkillBody(ctx: SettingContext): string {
  const globalKeys = (Object.keys(SETTING_SCHEMA) as SettingKey[]).filter(
    (k) => SETTING_SCHEMA[k].scope === "global",
  );
  return `${frontmatter(
    ADMIN_SKILL,
    "以管理员身份读写 catman 的全局配置(可用模型列表、默认模型、并发上限、" +
      "保留期、管理员名单)、代改任意用户的设置、以及管理微信账号。",
  )}
# catman 管理员操作

本回合有管理员权限。除了 ${USER_SKILL} 里那套只管自己的接口,你还能动全局配置
和别人的设置。

## 凭据

- \`$CATMAN_API_BASE\` — 接口地址
- \`$CATMAN_SESSION_TOKEN\` — 管理员令牌

**写操作必须用请求头** \`X-Catman-Session\`(不认 Cookie —— 那样会被外部页面
诱导触发)。

## 全局配置

\`\`\`bash
curl -s -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" "$CATMAN_API_BASE/api/settings"

curl -s -X PATCH -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" \\
     -H 'content-type: application/json' \\
     -d '{"modelAllowlist":["opus","sonnet"]}' "$CATMAN_API_BASE/api/settings"
\`\`\`

${settingRows(globalKeys, ctx)}

scope 为 user 的那几项(见 ${USER_SKILL})在这里设的是**全局默认值** ——
只影响没有自己设过的用户。

**改白名单不用管存量用户。** 系统有回退兜底:某人存的模型不在新列表里,
读取时会自动退到全局默认,再不行退到不指定模型。他的选择留在盘上,
你把那个模型加回来时会自动恢复。所以不要为了"安全"先去查谁在用什么。

## skill 的分层安装与禁用

全站共享自定义 skill 按权限分层装进控制面数据目录的 \`shared/skills/user/<名字>/SKILL.md\`
（所有用户可见）或 \`shared/skills/admin/<名字>/SKILL.md\`（仅管理员可见），**不用改代码、不用发版**，
新建或 \`/回收\` 重建后的 worker 即按角色整目录只读挂载生效。仓库维护的内置 skill 位于
\`skills/user/<名字>/\` 与 \`skills/admin/<名字>/\`，随 release 发布自动切换；单用户自己的私人
skill 装在 \`/user/skills/<名字>/SKILL.md\`。

要临时关掉一个,用上面的 PATCH 改 \`disabledSkills\`:

\`\`\`bash
curl -s -X PATCH -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" \\
     -H 'content-type: application/json' \\
     -d '{"disabledSkills":["catman-mediacenter"]}' "$CATMAN_API_BASE/api/settings"
\`\`\`

给 \`[]\` 解除全部禁用。**SDK 没有按名字禁用单个 skill 的开关**(只有"整批关掉内置的"
那种),所以这一项是唯一的关闭方式 —— 把文件挪走当然也行,但那是不可逆的手工操作。

两点它管不着:

- 普通用户的回合本来就看不到 ${ADMIN_ONLY_SKILLS.map(name => `\`${name}\``).join("、")} 及 \`shared/skills/admin/\` 下的目录。那是权限门,
  与"这个能力现在开不开"是两回事。
- **守护人格走固定白名单,\`disabledSkills\` 对它无效。** 一个手滑的禁用不该让救援
  手册在最需要它的时候消失 —— 而解除禁用要走这个接口,那时主人格多半正不好使。

## 别人的设置

\`\`\`bash
curl -s -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" "$CATMAN_API_BASE/api/users"

curl -s -X PATCH -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" \\
     -H 'content-type: application/json' \\
     -d '{"model":null}' "$CATMAN_API_BASE/api/users/<userKey>"
\`\`\`

字段给 \`null\` 清除该项覆盖。\`{"clear":true}\` 清掉这个用户的全部覆盖。

## 管理员名单

\`adminUserKeys\` 是普通的全局配置项,用上面的 PATCH 改。被列入的用户在自己的
聊天里就能改全局配置。

内置的 \`${BUILTIN_ADMIN_USER_KEY}\`(dashboard 聊天)**不在这个列表里、也无法移除** ——
这是刻意留的恢复通道,免得列表被清空后谁都改不了配置。

⚠️ 给某人管理员权限,等于把管理员令牌和 dashboard 的全部写权限(含删账号)
交给他。这不是"稍微高一点"的权限,授予前先跟人确认清楚。

## 微信账号

\`\`\`bash
curl -s -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" "$CATMAN_API_BASE/api/accounts"
curl -s -X POST   -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" "$CATMAN_API_BASE/api/accounts/<id>/unbind"
curl -s -X DELETE -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" "$CATMAN_API_BASE/api/accounts/<id>"
\`\`\`

解绑会让该账号的下一条来信重新认主。删账号不会删他的会话记录和工作目录,
那些交给保留期清理。**这两个都不可逆,动手前先跟人确认。**

账号列表里带 \`expiredAt\` 的,是凭据已经失效(该账号收不到消息了),要在 dashboard 的
「账号」页点**重新扫码**。重新扫码换掉凭据但保留账号与它服务的用户 —— 那个人的会话、
工作目录、个人配置都接着用;千万**不要**改用"删掉再重新添加",那会让他变成一个新用户,
过去的一切都接不上。

## 法定节假日日历(供 cn-workday / cn-restday 定时任务使用)

\`\`\`bash
# 查看已加载的年份、天数与来源
curl -s -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" "$CATMAN_API_BASE/api/admin/cron/calendar"

# 按年写入/更新节假日与调休补班表(写入后自动 reload 重算所有已启用任务的排期)
curl -s -X PUT -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" \\
     -H 'content-type: application/json' \\
     -d '{"years":{"2028":{"off":["01-01","01-02","01-03"],"work":["01-29"]}}}' \\
     "$CATMAN_API_BASE/api/admin/cron/calendar"

# 手动重读磁盘 calendar.json 并重算排期
curl -s -X POST -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" "$CATMAN_API_BASE/api/admin/cron/reload"
\`\`\`
`;
}

/** skill 正文里那几个路径。由 config 传进来,免得正文写死后与部署布局脱节。 */
export interface SkillPaths {
  /** 源码工作区(agent 在这上面开分支)。 */
  srcDir: string;
  /** bless 固化的部署脚本目录。制备脚本与 deployer 入口都在里面。 */
  deployBinDir: string;
  /** release 目录(只读)。`current` 指针告诉 agent 线上跑的是哪个 sha。 */
  releasesDir: string;
  /** 部署控制面目录。守护人格从这里读上一次部署的结果。 */
  deployDir: string;
  /** 信使的状态目录。守护人格数它的收件队列判断"消息是不是堵在人格这一侧"。 */
  courierDir: string;
}

export function evolveSkillBody(_paths: SkillPaths): string {
  return `${frontmatter(EVOLVE_SKILL, "修改 catman 自己的代码、测试并请求制备；发布和回滚由管理员明确触发。")}
# Catman 自进化

管理员的源码工作区挂在 /catman-src。先检查 git status 和当前分支的上游；有代码修改时再开分支。
普通 worker 不挂载 /data/releases，源码目录的 node_modules 必须是源码自己的一份，不要把它软链到某个 release（那等于让 npm 写线上正在执行的字节）。
/catman-src 目前自带独立依赖，可以直接在源码目录跑 npm run typecheck 和单个测试文件；全量测试较慢，交给制备。
容器里 /tmp 是 noexec，测试要执行临时脚本时先把 TMPDIR 指到 workspace，否则脚本起不来，表现为莫名其妙的 curl 退出码。
npm ci 不要用管道接 tail 判断成败：管道的退出码是 tail 的，装了一半也会显示成功；要取 npm 自己的退出码。
仅拉取上游并制备时，快进合并后直接调用下方制备接口；固定执行器会在独立容器完成依赖、typecheck、全量测试和编译，不必先在 worker 重复跑一遍。
修改代码需要提前验证时，先跑 typecheck 与受影响的测试；提交后仍须经过正式制备。
Git 远端使用部署配置的 SSH 地址；发布后的推送由 deployer 使用可写密钥完成。普通 worker 看不到部署密钥，仓库里的 core.sshCommand 路径只在控制服务内有效。
需要拉取上游时，先按 ${OPS_SKILL} skill 申请并等待用户硬指令授权，清单必须包含 Docker socket。
获得授权后运行 catman-ops connect，执行系统清单中的“自进化源码拉取”命令：通过运维环境在控制服务内以源码 owner 身份 git fetch origin，使用既有只读 SSH 密钥。
这一步只更新远端引用；随后在 worker 的 /catman-src 检查变更，并用 git merge --ff-only '@{u}' 快进当前分支。
执行命令必须保留真实退出码；需要用 tail 裁剪输出时先设置 pipefail，不得用 tail 的退出码认定 fetch、合并或测试成功。
有未提交改动、没有上游或发生分叉时先报告现状，不自动丢弃修改、强制重置或推送。
不要把 origin 改成 HTTPS、把私钥复制进 worker，或反复尝试普通 Bash 的 git pull。
若部署启用了运维授权，制备也需要本会话已获含 Docker socket 的授权（它会运行仓库脚本）；上述拉取授权可以复用。
尚未授权时先按 ${OPS_SKILL} skill 申请并等待用户硬指令；遇到 403 不要尝试绕过授权。
源码提交就绪后，用下面的控制接口请求制备（固定制备脚本由控制面执行，不需要在运维目录中搜索或手动执行它）：

\`\`\`bash
curl --fail-with-body -s -X POST -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" -H 'content-type: application/json' -d '{"ref":"HEAD"}' "$CATMAN_API_BASE/api/execution/prepare"
\`\`\`

制备结果会记录并通知用户。汇报具体提交、修改和验证结果，等待管理员发 ${canonicalOf("publish")} <版本号>。
状态用 ${canonicalOf("upgradeStatus")}；回滚用 ${canonicalOf("rollback")}。
不要自己起 deployer。不要直接修改发布指针或自行 bless；固定执行器和迁移后的运行环境不在普通 worker 的文件系统中。
`;
}

export function rescueSkillBody(_paths: SkillPaths): string {
  return `${frontmatter(RESCUE_SKILL, "查看主人格与信使诊断，必要时请求固化恢复流程。")}
# 守护人格诊断

你是守护人格。先获取事实，再决定是否恢复。用当前管理员身份调用：
GET $CATMAN_API_BASE/api/execution/diagnostics，请求头 X-Catman-Session: $CATMAN_SESSION_TOKEN。

确认需要恢复时 POST $CATMAN_API_BASE/api/execution/recover，JSON 为 {"action":"restart-primary"} 或 {"action":"demote"}。
服务端只允许固定的恢复操作，通过固化 deployer 执行；不接受任意 Docker 命令或宿主路径。
恢复后报告原因和结果，提醒用户用 ${canonicalOf("primaryPersona")} 切回主人格。
`;
}

/**
 * 把动态生成的接口 skill 按权限分层写到 `<generatedRoot>/{user,admin}/<name>/SKILL.md`，
 * 并清理当前人格不该保留的旧生成物。
 *
 * 仓库内置的 `skills/user/webgrab` 与 `skills/admin/catman-ops` 直接从当前 release
 * 整目录只读挂载，不再复制到持久化数据目录。
 */
export function writeSkills(
  generatedRoot: string,
  ctx: SettingContext,
  paths: SkillPaths,
  persona: Persona = "primary",
): void {
  const specs: Array<{ tier: SkillTier; name: string; body: string }> =
    persona === "rescue"
      ? [
          { tier: "user", name: USER_SKILL, body: userSkillBody(ctx) },
          { tier: "admin", name: ADMIN_SKILL, body: adminSkillBody(ctx) },
          { tier: "admin", name: RESCUE_SKILL, body: rescueSkillBody(paths) },
        ]
      : [
          { tier: "user", name: USER_SKILL, body: userSkillBody(ctx) },
          { tier: "user", name: CRON_SKILL, body: cronSkillBody() },
          { tier: "admin", name: ADMIN_SKILL, body: adminSkillBody(ctx) },
          { tier: "admin", name: EVOLVE_SKILL, body: evolveSkillBody(paths) },
        ];

  mkdirSync(join(generatedRoot, "user"), { recursive: true });
  mkdirSync(join(generatedRoot, "admin"), { recursive: true });

  const wanted = new Map<string, SkillTier>();
  for (const spec of specs) {
    wanted.set(spec.name, spec.tier);
    const dir = join(generatedRoot, spec.tier, spec.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), spec.body, "utf8");
  }

  for (const tier of ["user", "admin"] as const) {
    for (const name of [...GENERATED_SKILLS, OPS_SKILL]) {
      if (wanted.get(name) === tier) continue;
      rmSync(join(generatedRoot, tier, name), { recursive: true, force: true });
    }
  }
}

export interface SkillDirEntry {
  readonly dirName: string;
  readonly canonicalName: string;
}

/**
 * 扫描单层 skill 目录 `<dir>/<entry>/SKILL.md`，返回目录名与声明的 canonical name。
 * 读不到目录或无合法条目时返回空数组，绝不抛错。
 */
export function scanSkillEntries(dir: string): SkillDirEntry[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillDirEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || !SAFE_SKILL_DIR.test(e.name)) continue;
    let text: string;
    try {
      text = readScopedFile(dir, join(dir, e.name, "SKILL.md"));
    } catch {
      continue;
    }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const declared = fm ? /^name:[ \t]*(\S+)/m.exec(fm[1] ?? "")?.[1] : undefined;
    out.push({ dirName: e.name, canonicalName: declared ?? e.name });
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

/**
 * 扫 `<parentDir>/skills/`（如 owner home `/user/skills/`），返回每个 skill 的声明名字。
 */
export function skillsOnDisk(parentDir: string): string[] {
  const names = new Set(scanSkillEntries(join(parentDir, "skills")).map((e) => e.canonicalName));
  return [...names].sort();
}

export interface SkillMountGroup {
  readonly id: string;
  readonly kind: "builtin" | "shared";
  readonly tier: SkillTier;
  readonly sourceDir: string;
  readonly containerDir: string;
  readonly entries: readonly SkillDirEntry[];
}

/**
 * 按当前人格与管理员身份解析需要整目录只读挂载的 skill 分组。
 *
 * - 非管理员绝不挂载任何 `admin` 分组目录（物理级隔离）；
 * - 守护人格只挂载固定白名单所在的 `gen-*` 分组，不继承 `release` 或 `shared` 磁盘现状；
 * - 顺序即同名优先级：`gen-*` > `release-*` > `shared-*`。
 */
export function resolveSkillGroups(input: {
  dataDir: string;
  releaseDir?: string;
  persona: Persona;
  isAdmin: boolean;
}): SkillMountGroup[] {
  const { dataDir, releaseDir, persona, isAdmin } = input;
  const genRoot = generatedSkillsDir(dataDir);
  if (persona === "rescue") {
    const allowed = new Set<string>(isAdmin ? RESCUE_SKILLS : [USER_SKILL]);
    const candidates: Array<Omit<SkillMountGroup, "entries">> = [
      { id: "gen-user", kind: "builtin", tier: "user", sourceDir: join(genRoot, "user"), containerDir: "/runtime/skills/gen-user" },
      ...(isAdmin
        ? [{ id: "gen-admin", kind: "builtin" as const, tier: "admin" as const, sourceDir: join(genRoot, "admin"), containerDir: "/runtime/skills/gen-admin" }]
        : []),
    ];
    return candidates
      .filter((c) => existsSync(c.sourceDir))
      .map((c) => ({ ...c, entries: scanSkillEntries(c.sourceDir).filter((e) => allowed.has(e.canonicalName)) }));
  }

  const sharedRoot = sharedSkillsDir(dataDir);
  const excluded = new Set<string>([
    ...PRIMARY_EXCLUDED,
    ...(isAdmin ? [] : ADMIN_ONLY_SKILLS),
  ]);
  const candidates: Array<Omit<SkillMountGroup, "entries">> = [
    { id: "gen-user", kind: "builtin", tier: "user", sourceDir: join(genRoot, "user"), containerDir: "/runtime/skills/gen-user" },
    ...(isAdmin
      ? [{ id: "gen-admin", kind: "builtin" as const, tier: "admin" as const, sourceDir: join(genRoot, "admin"), containerDir: "/runtime/skills/gen-admin" }]
      : []),
    ...(releaseDir
      ? [{ id: "release-user", kind: "builtin" as const, tier: "user" as const, sourceDir: join(releaseDir, "skills", "user"), containerDir: "/runtime/skills/release-user" }]
      : []),
    ...(isAdmin && releaseDir
      ? [{ id: "release-admin", kind: "builtin" as const, tier: "admin" as const, sourceDir: join(releaseDir, "skills", "admin"), containerDir: "/runtime/skills/release-admin" }]
      : []),
    { id: "shared-user", kind: "shared", tier: "user", sourceDir: join(sharedRoot, "user"), containerDir: "/runtime/skills/shared-user" },
    ...(isAdmin
      ? [{ id: "shared-admin", kind: "shared" as const, tier: "admin" as const, sourceDir: join(sharedRoot, "admin"), containerDir: "/runtime/skills/shared-admin" }]
      : []),
  ];

  return candidates
    .filter((c) => existsSync(c.sourceDir))
    .map((c) => ({
      ...c,
      entries: scanSkillEntries(c.sourceDir).filter((e) => !excluded.has(e.canonicalName)),
    }));
}

/**
 * 汇总当前数据目录与 release 下对该身份可见的全部公共/内置 skill 名单（供 `skillsFor` 过滤 `disabled`）。
 */
export function discoverAvailableSkills(input: {
  dataDir: string;
  releaseDir?: string;
  isAdmin: boolean;
}): string[] {
  const names = new Set<string>();
  for (const group of resolveSkillGroups({ ...input, persona: "primary" })) {
    for (const entry of group.entries) names.add(entry.canonicalName);
  }
  return [...names].sort();
}

function moveDirSync(source: string, target: string): void {
  mkdirSync(join(target, ".."), { recursive: true });
  try {
    renameSync(source, target);
  } catch {
    cpSync(source, target, { recursive: true, dereference: false });
    rmSync(source, { recursive: true, force: true });
  }
}

/**
 * 启动期一次性平滑整理历史 skill 目录：
 * 1. 确保 `<dataDir>/shared/skills/{user,admin}` 存在；
 * 2. 若有人按旧习惯直接放在 `shared/skills/<name>/SKILL.md`，自动归入 `user/`（或 `admin/`）；
 * 3. 若存量 `<dataDir>/claude/skills/` 仍在：
 *    - 清掉旧 `writeSkills` 生成的内置项；
 *    - 将仓库已自带的同名旧副本（如 `webgrab`）移入 `claude/.migrated-repo-skills/` 归档备查，避免遮蔽 release；
 *    - 将管理员安装的自定义公共 skill 迁入 `shared/skills/{user,admin}/`；
 *    - 迁空后移除空的 `claude/skills` 目录，让 `claude/` 仅服务于 Claude OAuth 凭据。
 */
export function migrateLegacySkills(dataDir: string, releaseDir?: string): void {
  const sharedRoot = sharedSkillsDir(dataDir);
  mkdirSync(join(sharedRoot, "user"), { recursive: true });
  mkdirSync(join(sharedRoot, "admin"), { recursive: true });

  // 归一顶层直接放置的 shared/skills/<name>
  for (const entry of readdirSync(sharedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "user" || entry.name === "admin") continue;
    const src = join(sharedRoot, entry.name);
    if (!existsSync(join(src, "SKILL.md"))) continue;
    const tier: SkillTier = (ADMIN_ONLY_SKILLS as readonly string[]).includes(entry.name) ? "admin" : "user";
    const dst = join(sharedRoot, tier, entry.name);
    if (!existsSync(dst)) moveDirSync(src, dst);
  }

  const legacyRoot = join(dataDir, "claude", "skills");
  if (!existsSync(legacyRoot)) return;

  const repoNames = new Set<string>([OPS_SKILL, WEBGRAB_SKILL]);
  if (releaseDir) {
    for (const tier of ["user", "admin"] as const) {
      for (const e of scanSkillEntries(join(releaseDir, "skills", tier))) {
        repoNames.add(e.dirName);
        repoNames.add(e.canonicalName);
      }
    }
  }
  const generatedNames = new Set<string>([...GENERATED_SKILLS, OPS_SKILL]);

  for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const src = join(legacyRoot, entry.name);
    if (generatedNames.has(entry.name)) {
      rmSync(src, { recursive: true, force: true });
      continue;
    }
    if (repoNames.has(entry.name)) {
      const archiveDst = join(dataDir, "claude", ".migrated-repo-skills", entry.name);
      rmSync(archiveDst, { recursive: true, force: true });
      moveDirSync(src, archiveDst);
      continue;
    }
    if (!existsSync(join(src, "SKILL.md"))) continue;
    const tier: SkillTier = (ADMIN_ONLY_SKILLS as readonly string[]).includes(entry.name) ? "admin" : "user";
    const dst = join(sharedRoot, tier, entry.name);
    if (!existsSync(dst)) {
      moveDirSync(src, dst);
    } else {
      const archiveDst = join(dataDir, "claude", ".migrated-repo-skills", entry.name);
      rmSync(archiveDst, { recursive: true, force: true });
      moveDirSync(src, archiveDst);
    }
  }

  try {
    if (readdirSync(legacyRoot).length === 0) rmdirSync(legacyRoot);
  } catch {
    // 非空或已移除时保持原状即可
  }
}

/** `skillsFor` 的两个可选输入。都不给就退回硬编码名单。 */
export interface SkillFilter {
  /** 磁盘上装了哪些。空 = 读不到,走兜底。 */
  readonly onDisk?: readonly string[];
  /** 管理员在 `disabledSkills` 里显式关掉的。 */
  readonly disabled?: readonly string[];
}

/**
 * 这一回合该让哪些 skill 进上下文。
 *
 * - **主人格（黑名单）**：磁盘可见池减去 `PRIMARY_EXCLUDED`、非管理员禁项与 `disabledSkills`；`onDisk` 为空退回兜底名单。
 * - **守护人格（白名单）**：固定返回 `RESCUE_SKILLS`（普通用户只给 `USER_SKILL`），不受磁盘与 `disabledSkills` 影响。
 */
export function skillsFor(persona: Persona, isAdmin: boolean, filter: SkillFilter = {}): string[] {
  if (persona === "rescue") return isAdmin ? [...RESCUE_SKILLS] : [USER_SKILL];

  const pool = filter.onDisk?.length ? filter.onDisk : isAdmin ? ADMIN_SKILLS : USER_SKILLS;
  const denied = new Set<string>([
    ...PRIMARY_EXCLUDED,
    ...(isAdmin ? [] : ADMIN_ONLY_SKILLS),
    ...(filter.disabled ?? []),
  ]);
  return pool.filter((name) => !denied.has(name));
}
