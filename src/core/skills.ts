import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { canonicalOf } from "./commands.js";
import { BUILTIN_ADMIN_USER_KEY } from "./identity.js";
import { MIN_SHA_PREFIX } from "./releases.js";
import type { Persona } from "../config.js";
import { SETTING_SCHEMA, USER_SETTING_KEYS, type SettingContext, type SettingKey } from "./settings.js";
import { readScopedFile } from "./scoped-files.js";
import { findAppRoot } from "./version.js";

/**
 * 把「怎么调自己的配置接口」做成 skill 而不是塞进系统提示词。
 *
 * skill 的 description 常驻上下文、正文按需加载,常态下几乎不占 token ——
 * 而系统提示词是每回合每次都要付钱的。
 *
 * ## 两个刻意的约束
 *
 * 1. **每次启动幂等覆盖。** 文件落在数据卷里(CLAUDE_CONFIG_DIR/skills/),用户能改能删。
 *    接口说明从 SETTING_SCHEMA 等代码生成；运维手册从当前 release 的
 *    skills/catman-ops/SKILL.md 安装。数据目录中的副本不是维护入口。
 *
 * 2. **正文里绝不能出现任何令牌。** Options.skills 是**上下文过滤而不是沙箱**
 *    (SDK 类型注释原文:"files remain on disk and are reachable via Read/Bash.
 *    Do not store secrets in skill files")。普通用户的 agent 看不到 catman-admin
 *    的列表项,但照样能 Read 到这个文件。所以只写 $CATMAN_ADMIN_TOKEN 这样的
 *    环境变量引用 —— 变量本身只注入 admin 回合的子进程。
 */

export const USER_SKILL = "catman-settings";
export const CRON_SKILL = "catman-cron";
export const ADMIN_SKILL = "catman-admin";
export const EVOLVE_SKILL = "catman-evolve";
export const OPS_SKILL = "catman-ops";
export const RESCUE_SKILL = "catman-rescue";

/**
 * 由 `writeSkills` 生成的那几个。
 *
 * 这份名单划的是**「归 writeSkills 管」的边界**:它按人格生成其中一部分,也只清理
 * 其中一部分 —— 手写丢进 `skills/` 的那些一个都不碰。主人格走黑名单(见 `skillsFor`),
 * 手写 skill 装进去就生效,这条边界是那个模型能成立的前提。
 */
export const GENERATED_SKILLS: readonly string[] = [
  USER_SKILL,
  CRON_SKILL,
  ADMIN_SKILL,
  EVOLVE_SKILL,
  OPS_SKILL,
  RESCUE_SKILL,
];

/**
 * 主人格里**只给管理员**的。
 *
 * `catman-evolve`:改自己的代码并推上线是全局影响的事(一次部署把所有用户都换了
 * 版本),与 `/发布` `/回滚` 的 adminOnly 是同一个决定。普通用户的回合里连这份说明
 * 都不该出现 —— description 常驻上下文,列出来等于告诉每个人有这条路。
 */
export const ADMIN_ONLY_SKILLS: readonly string[] = [ADMIN_SKILL, EVOLVE_SKILL, OPS_SKILL];

/**
 * 主人格里**谁都不给**的:守护人格那份诊断手册。
 *
 * 它教的是「怎么把版本退回去」,而主人格正是被退的那一方 —— 何况退版本要先停容器,
 * 它就跑在那个容器里。正常情况下这个文件也不在主人格的 `skills/` 下(`writeSkills`
 * 只给守护人格生成它),这里挡的是有人手工拷了一份过来。
 */
const PRIMARY_EXCLUDED: readonly string[] = [RESCUE_SKILL];

/**
 * 磁盘读不到时,普通回合的兜底名单。
 *
 * `catman-cron` 在这里而不是 admin 那边:定时任务是**每人自己的**,接口按回合
 * 令牌定身份,一个用户既看不见也动不了别人的任务 —— 与改自己的设置同一个模型。
 */
export const USER_SKILLS: readonly string[] = [USER_SKILL, CRON_SKILL];
/** 磁盘读不到时,admin 回合的兜底名单。 */
export const ADMIN_SKILLS: readonly string[] = [USER_SKILL, CRON_SKILL, ADMIN_SKILL, EVOLVE_SKILL, OPS_SKILL];
/**
 * 守护人格的 admin 回合可见的 skill。**这一支是白名单,不是兜底** —— 见 `skillsFor`。
 *
 * 与主人格的区别有两处:`catman-evolve` 换成 `catman-rescue`(它跑的是钉住的稳定
 * 版本,改了代码也上不了线,而人正在等它诊断);以及**没有 `catman-cron`** ——
 * 调度器只在主人格里跑,守护人格那边连接口都不存在,摆一份说明只会让它去调
 * 一个必然 404 的东西。
 */
export const RESCUE_SKILLS: readonly string[] = [USER_SKILL, ADMIN_SKILL, RESCUE_SKILL];

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

每个任务有固定 workspace，多次执行共享其中的游标和台账。聊天、其他 cron 的 workspace 互相隔离。
个人文件和 skill 在 /user。跨上下文保留的产物才保存到 /user。
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

## skill 的启用与禁用

装进 \`$CLAUDE_CONFIG_DIR/skills/<名字>/SKILL.md\` 就生效,**不用改代码、不用发版**,
下一回合就能用。能往那个目录写文件的只有管理员和 catman 自己 —— 装进去这个动作
本身就是认可,所以没有第二道登记。

要临时关掉一个,用上面的 PATCH 改 \`disabledSkills\`:

\`\`\`bash
curl -s -X PATCH -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" \\
     -H 'content-type: application/json' \\
     -d '{"disabledSkills":["catman-mediacenter"]}' "$CATMAN_API_BASE/api/settings"
\`\`\`

给 \`[]\` 解除全部禁用。**SDK 没有按名字禁用单个 skill 的开关**(只有"整批关掉内置的"
那种),所以这一项是唯一的关闭方式 —— 把文件挪走当然也行,但那是不可逆的手工操作。

两点它管不着:

- 普通用户的回合本来就看不到 ${ADMIN_ONLY_SKILLS.map(name => `\`${name}\``).join("、")}。那是权限门,
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
普通 worker 不挂载 /data/releases，源码中的 node_modules 软链可能指向不可见的 release，不能据此在源码目录直接跑 npm，也不要改写这个软链或往源码目录安装依赖。
仅拉取上游并制备时，快进合并后直接调用下方制备接口；固定执行器会在独立容器完成依赖、typecheck、全量测试和编译，不必先在 worker 重复跑一遍。
修改代码需要提前验证时，在 workspace 复制源码、独立安装依赖并运行 npm run typecheck 与 npm test；提交后仍须经过正式制备。
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

export function opsSkillBody(): string {
  // 从模块所属 release 读取，不能依赖控制服务启动时的 cwd 或可写源码工作区。
  const root = findAppRoot();
  if (!root) throw new Error("无法定位内置运维 skill 所属的 release");
  return readFileSync(join(root, "skills", OPS_SKILL, "SKILL.md"), "utf8");
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
 * 把 skill 写到 CLAUDE_CONFIG_DIR/skills/ 下,并清掉这个人格不该有的旧生成物。
 * 启动时调用一次。
 * 内容由 SETTING_SCHEMA、COMMAND_TABLE 与配置里的路径生成,所以那几处一改这里自动跟上。
 *
 * **按人格生成不同的一套。** 守护人格拿到的是 `catman-rescue` 而不是 `catman-evolve`:
 * 它跑钉住的稳定版本,改了代码也上不了线;而 skill 的 description 常驻上下文,
 * 摆一份"怎么改自己的代码"在那儿,就是在邀请它去做一件注定白费的事 ——
 * 而人正在等它诊断。
 */
export function writeSkills(
  configDir: string,
  ctx: SettingContext,
  paths: SkillPaths,
  persona: Persona = "primary",
): void {
  const bodies: Array<[string, string]> =
    persona === "rescue"
      ? [
          [USER_SKILL, userSkillBody(ctx)],
          [ADMIN_SKILL, adminSkillBody(ctx)],
          [RESCUE_SKILL, rescueSkillBody(paths)],
        ]
      : [
          [USER_SKILL, userSkillBody(ctx)],
          [CRON_SKILL, cronSkillBody()],
          [ADMIN_SKILL, adminSkillBody(ctx)],
          [EVOLVE_SKILL, evolveSkillBody(paths)],
          [OPS_SKILL, opsSkillBody()],
        ];
  const wanted = new Set(bodies.map(([name]) => name));
  for (const [name, body] of bodies) {
    const dir = join(configDir, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body, "utf8");
  }

  // 清掉**这个人格不要、而且确实是我自己生成过**的那些目录。
  //
  // 以前只写不删,于是换人格分支时旧文件会留在盘上:守护人格那边就躺着一份
  // Aug 10 的 catman-evolve —— 名单里没有它,所以一直是哑的,但内容早就跟不上了
  // (连 /发布 要几位 sha 都写错)。主人格改走黑名单之后,这种残留会**自己复活**,
  // 那时它不只是多占几个 token,而是在主动教错。
  //
  // 只认 GENERATED_SKILLS 里的名字:手写丢进来的一个都不碰,那正是黑名单模型的前提。
  for (const name of GENERATED_SKILLS) {
    if (wanted.has(name)) continue;
    rmSync(join(configDir, "skills", name), { recursive: true, force: true });
  }
}

/**
 * 扫 `configDir/skills/`,返回每个 skill 的**声明名字**。
 *
 * 名字取 frontmatter 里的 `name:`,取不到才退回目录名 —— SDK 按 canonical name 匹配
 * (类型注释原文:"matching the exact canonical name ... Display names and aliases do
 * not match"),目录名与 `name` 不一致时列目录名等于没列,而且是**安静地**没列。
 *
 * 读不到目录就返回空数组,由 `skillsFor` 退回硬编码名单。
 */
export function skillsOnDisk(configDir: string): string[] {
  const root = join(configDir, "skills");
  const names = new Set<string>();
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    // 点开头的是 `.trash` 这类内部目录,不是 skill。`synced/` 装的是一批 skill
    // 而不是一个,它没有顶层 SKILL.md,下面那道 try 会把它挡掉。
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    let text: string;
    try {
      text = readScopedFile(root, join(root, e.name, "SKILL.md"));
    } catch {
      continue;
    }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const declared = fm ? /^name:[ \t]*(\S+)/m.exec(fm[1] ?? "")?.[1] : undefined;
    names.add(declared ?? e.name);
  }
  return [...names].sort();
}

/** `skillsFor` 的两个可选输入。都不给就退回硬编码名单(即改这版之前的行为)。 */
export interface SkillFilter {
  /** 磁盘上装了哪些(见 `skillsOnDisk`)。空 = 读不到,走兜底。 */
  readonly onDisk?: readonly string[];
  /** 管理员在 `disabledSkills` 里显式关掉的。 */
  readonly disabled?: readonly string[];
}

/**
 * 这一回合该让哪些 skill 进上下文。
 *
 * ## 主人格:黑名单
 *
 * 默认**磁盘上装了什么就给什么**,只减三类:不属于这个人格的、非管理员回合里
 * 该挡的、以及管理员显式禁用的。
 *
 * 之所以不再要一份代码里的白名单:能往 `skills/` 里写文件的只有管理员和 catman
 * 自己,**装进去这个动作本身就是认可**。再要一次登记就只是摩擦 —— 登记表在代码里,
 * 改它得发一次版,而漏登记的表现是那份说明*安静地不存在*。真实的代价:三个手写
 * skill 就这么哑了十几天,期间共享人设的正文还在点名让人去用它们。
 *
 * `onDisk` 为空(目录读不到、或一个 SKILL.md 都没有)时退回硬编码名单。这条兜底
 * 是必须的,与 settings.ts 开头那条「任何配置状态下 agent 都必须能起来」同一个考虑:
 * 否则一次 readdir 失败就能让它连「怎么改自己的配置」都不知道。
 *
 * ## 守护人格:仍然是白名单
 *
 * 不跟着改,因为它的价值就是**没有惊喜**:跑钉住的稳定版本,被叫来时人正在等它诊断。
 * 白名单让它显式声明自己要什么,而不是继承磁盘现状 —— 那个目录里躺着什么它不该关心。
 *
 * `disabled` 同样不作用于这一支:一个手滑的禁用不该让救援手册在最需要它的时候消失,
 * 而解除禁用要走主人格那边的配置接口 —— 那时人找守护人格,多半正是因为主人格不好使。
 */
export function skillsFor(persona: Persona, isAdmin: boolean, filter: SkillFilter = {}): string[] {
  // 守护人格那边没有调度器,所以两条分支都要把 catman-cron 摘掉 ——
  // 普通用户这一支同样要摘,否则它会去调一个必然 404 的接口。
  if (persona === "rescue") return isAdmin ? [...RESCUE_SKILLS] : [USER_SKILL];

  const pool = filter.onDisk?.length ? filter.onDisk : isAdmin ? ADMIN_SKILLS : USER_SKILLS;
  const denied = new Set<string>([
    ...PRIMARY_EXCLUDED,
    ...(isAdmin ? [] : ADMIN_ONLY_SKILLS),
    ...(filter.disabled ?? []),
  ]);
  return pool.filter((name) => !denied.has(name));
}
