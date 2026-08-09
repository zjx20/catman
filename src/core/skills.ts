import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalOf } from "./commands.js";
import { BUILTIN_ADMIN_USER_KEY } from "./identity.js";
import { MIN_SHA_PREFIX } from "./releases.js";
import { SETTING_SCHEMA, USER_SETTING_KEYS, type SettingContext, type SettingKey } from "./settings.js";

/**
 * 把「怎么调自己的配置接口」做成 skill 而不是塞进系统提示词。
 *
 * skill 的 description 常驻上下文、正文按需加载,常态下几乎不占 token ——
 * 而系统提示词是每回合每次都要付钱的。
 *
 * ## 两个刻意的约束
 *
 * 1. **每次启动幂等覆盖。** 文件落在数据卷里(CLAUDE_CONFIG_DIR/skills/),用户能改能删。
 *    覆盖写让它永远跟代码同步 —— 接口说明的真相源是 SETTING_SCHEMA,不是磁盘。
 *
 * 2. **正文里绝不能出现任何令牌。** Options.skills 是**上下文过滤而不是沙箱**
 *    (SDK 类型注释原文:"files remain on disk and are reachable via Read/Bash.
 *    Do not store secrets in skill files")。普通用户的 agent 看不到 catman-admin
 *    的列表项,但照样能 Read 到这个文件。所以只写 $CATMAN_ADMIN_TOKEN 这样的
 *    环境变量引用 —— 变量本身只注入 admin 回合的子进程。
 */

export const USER_SKILL = "catman-settings";
export const ADMIN_SKILL = "catman-admin";
export const EVOLVE_SKILL = "catman-evolve";

/** 普通回合可见的 skill。 */
export const USER_SKILLS: readonly string[] = [USER_SKILL];
/**
 * admin 回合可见的 skill。
 *
 * `catman-evolve` **只在这里**:改自己的代码并推上线是全局影响的事(一次部署把所有
 * 用户都换了版本),与 `/发布` `/回滚` 的 adminOnly 是同一个决定。普通用户的回合里
 * 连这份说明都不该出现 —— 它的 description 常驻上下文,列出来等于告诉每个人有这条路。
 */
export const ADMIN_SKILLS: readonly string[] = [USER_SKILL, ADMIN_SKILL, EVOLVE_SKILL];

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
- \`$CATMAN_ADMIN_TOKEN\` — 管理员令牌

**写操作必须用请求头** \`X-Catman-Token\`(不认 Cookie —— 那样会被外部页面
诱导触发)。

## 全局配置

\`\`\`bash
curl -s -H "X-Catman-Token: $CATMAN_ADMIN_TOKEN" "$CATMAN_API_BASE/api/settings"

curl -s -X PATCH -H "X-Catman-Token: $CATMAN_ADMIN_TOKEN" \\
     -H 'content-type: application/json' \\
     -d '{"modelAllowlist":["opus","sonnet"]}' "$CATMAN_API_BASE/api/settings"
\`\`\`

${settingRows(globalKeys, ctx)}

scope 为 user 的那几项(见 ${USER_SKILL})在这里设的是**全局默认值** ——
只影响没有自己设过的用户。

**改白名单不用管存量用户。** 系统有回退兜底:某人存的模型不在新列表里,
读取时会自动退到全局默认,再不行退到不指定模型。他的选择留在盘上,
你把那个模型加回来时会自动恢复。所以不要为了"安全"先去查谁在用什么。

## 别人的设置

\`\`\`bash
curl -s -H "X-Catman-Token: $CATMAN_ADMIN_TOKEN" "$CATMAN_API_BASE/api/users"

curl -s -X PATCH -H "X-Catman-Token: $CATMAN_ADMIN_TOKEN" \\
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
curl -s -H "X-Catman-Token: $CATMAN_ADMIN_TOKEN" "$CATMAN_API_BASE/api/accounts"
curl -s -X POST   -H "X-Catman-Token: $CATMAN_ADMIN_TOKEN" "$CATMAN_API_BASE/api/accounts/<id>/unbind"
curl -s -X DELETE -H "X-Catman-Token: $CATMAN_ADMIN_TOKEN" "$CATMAN_API_BASE/api/accounts/<id>"
\`\`\`

解绑会让该账号的下一条来信重新认主。删账号不会删他的会话记录和工作目录,
那些交给保留期清理。**这两个都不可逆,动手前先跟人确认。**

账号列表里带 \`expiredAt\` 的,是凭据已经失效(该账号收不到消息了),要在 dashboard 的
「账号」页点**重新扫码**。重新扫码换掉凭据但保留账号与它服务的用户 —— 那个人的会话、
工作目录、个人配置都接着用;千万**不要**改用"删掉再重新添加",那会让他变成一个新用户,
过去的一切都接不上。
`;
}

/** 自进化 skill 里那几个路径。由 config 传进来,免得正文写死后与部署布局脱节。 */
export interface EvolvePaths {
  /** 源码工作区(agent 在这上面开分支)。 */
  srcDir: string;
  /** bless 固化的部署脚本目录。制备脚本就在里面。 */
  deployBinDir: string;
  /** release 目录(只读)。`current` 指针告诉 agent 线上跑的是哪个 sha。 */
  releasesDir: string;
}

export function evolveSkillBody(paths: EvolvePaths): string {
  const prepare = `${paths.deployBinDir}/prepare.sh`;
  const publish = canonicalOf("publish");
  return `${frontmatter(
    EVOLVE_SKILL,
    "改 catman 自己的代码并把它部署上线:开分支、改、跑测试、制备 release、汇报给管理员确认。" +
      "管理员说想加个功能、改个行为、修个 bug(指 catman 本身,不是他的项目)时用它。",
  )}
# 改 catman 自己

你就是 catman。这份 skill 讲怎么改你自己的代码并把它推上线。

**流水线一共五步,你只做前三步:**
改代码 → 制备 release → 汇报 → **管理员发 \`${publish} <版本号前${MIN_SHA_PREFIX}位>\`** → deployer 切换。
最后两步不归你,理由见下面「不要自己起 deployer」。

## 开工前

\`\`\`bash
cd ${paths.srcDir}
git status --short                      # ① 工作区干净吗
git checkout main && git pull --ff-only # ② 把远端的改动拉下来
readlink ${paths.releasesDir}/current   # ③ 线上跑的是哪个 sha
git log --oneline "$(readlink ${paths.releasesDir}/current)"..main   # ④ 差了什么
\`\`\`

① 不干净说明上一件事没收尾,先问管理员,别在别人的半成品上继续改。

② **这条是主路径**:管理员多半在电脑上也改代码并推到 GitHub,那些改动就是这么到你手上的。
拉不动而且报 \`Permission denied (publickey)\` 的话,是缺了给你用的那把只读部署密钥
(见 README「部署密钥」),**告诉管理员,不要自己去找钥匙或改 ssh 配置**。

④ 有差异不一定是坏事 —— 可能就是刚拉下来、等着上线的东西。但**必须弄清它们是什么**:
另一种可能是上一次部署失败被回滚了,而那个提交还留在 \`main\` 上,直接往下改就会把
一个已经判定为坏的改动一起带上线。发 \`${canonicalOf("upgradeStatus")}\` 看上次部署的结果就知道是哪种。

## 改

\`\`\`bash
git checkout main && git checkout -b evolve/<短横线-描述>
# …改代码…
npm run typecheck && npm test     # 先在这里跑一遍,反馈快得多
git add <具体文件>                 # 不要 git add -A
git commit -F <写好提交信息的文件>  # 长的中文提交信息不要用 -m,反引号会被 shell 吃掉
\`\`\`

规矩与仓库里 \`CLAUDE.md\` 一致:conventional commits、中文正文、注释与文档在**同一个提交**里更新。
**一次只做一件事** —— 部署是串行的,两件事挤在一个 release 里,出问题时你分不清是哪一件。

## 制备

\`\`\`bash
${prepare} HEAD
\`\`\`

它起一个一次性容器,浅 clone → 装依赖 → typecheck + **全量测试** → 编译 → 版本戳 + 内容清单。
跑完会打一段**变更分级**,末行是新 release 的 sha。制备失败就是没上线,线上一根汗毛没动。

⚠️ **必须跑这个路径**,不要跑 \`releases/current/scripts/evolve/prepare.sh\`。
上面那份是 bless 固化的,不随你的改动变 —— 制备门(那句全量测试)就在这个脚本里,
跑仓库里那份等于让被考的人自己出卷子。

制备成功后把分支落回 main 并删掉它:

\`\`\`bash
git checkout main && git merge --ff-only evolve/<slug> && git branch -d evolve/<slug>
\`\`\`

这样 \`main\` 永远等于最后一次成功制备的版本,下次开工的基线天然正确。

## 汇报

给管理员四样东西,缺一不可:

1. **改了什么**,一两句人话(不是文件列表)。
2. **测试结果**:全量多少条、全绿没有。
3. **变更分级**:把 \`${prepare}\` 打出来的那段原样转述。
   有 Tier 3 就明说「这部分部署上不了线,你还要 ⋯⋯」;有 Tier 1★ 就单独点一句
   「这次动到了门禁本体」。
4. **确认怎么发**:「回一句 \`${publish} <sha 前 7 位>\` 我就提交部署」。

然后**结束回合**,别追问、别等。

## 不要自己起 deployer

\`${publish}\` 是硬指令,由管理员亲手打、由网关按字面解析 —— 这是整条流水线唯一一处
把「人批准了什么」和「机器部署了什么」机械绑在一起的地方。你去代劳(直接跑 deployer 脚本、
或者把 sha 转述错)就等于把这把锁拆了,而你恰好是被部署的那一方。

技术上你当然跑得动那个脚本。**这是纪律不是沙箱** —— 就像不能替人按下确认键一样。
管理员说「你直接发吧」时,正确的回答是把口令告诉他,不是替他发。

## 什么改动不能走这条路

- **改不了盘上现有数据格式的**:部署随时可能回滚,所以新代码必须能读旧数据,
  **旧代码也必须能读新代码写的**。做不到就只提案,让人来做。
- **Tier 3**:\`scripts/evolve/\`(要重新 bless)、\`docker/\`(要重建镜像)、
  compose 与 \`.env\`(要 recreate 容器)。这些改了也不会自动生效,汇报时必须说清欠什么。

## 出事了

管理员发 \`${canonicalOf("rollback")}\` 退回上一个已验证版本。部署失败会自动回滚,
结果写进部署报告,他下次开口时你会收到。**不要自己去修部署机制** —— 那是 Tier 3。
`;
}

/**
 * 把 skill 写到 CLAUDE_CONFIG_DIR/skills/ 下。启动时调用一次。
 * 内容由 SETTING_SCHEMA、COMMAND_TABLE 与配置里的路径生成,所以那几处一改这里自动跟上。
 */
export function writeSkills(configDir: string, ctx: SettingContext, paths: EvolvePaths): void {
  const bodies: Array<[string, string]> = [
    [USER_SKILL, userSkillBody(ctx)],
    [ADMIN_SKILL, adminSkillBody(ctx)],
    [EVOLVE_SKILL, evolveSkillBody(paths)],
  ];
  for (const [name, body] of bodies) {
    const dir = join(configDir, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body, "utf8");
  }
}
