import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_ADMIN_USER_KEY } from "./identity.js";
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

/** 普通回合可见的 skill。 */
export const USER_SKILLS: readonly string[] = [USER_SKILL];
/** admin 回合可见的 skill。 */
export const ADMIN_SKILLS: readonly string[] = [USER_SKILL, ADMIN_SKILL];

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

/**
 * 把两个 skill 写到 CLAUDE_CONFIG_DIR/skills/ 下。启动时调用一次。
 * 内容由 SETTING_SCHEMA 生成,所以加配置项时这里自动跟上。
 */
export function writeSkills(configDir: string, ctx: SettingContext): void {
  const bodies: Array<[string, string]> = [
    [USER_SKILL, userSkillBody(ctx)],
    [ADMIN_SKILL, adminSkillBody(ctx)],
  ];
  for (const [name, body] of bodies) {
    const dir = join(configDir, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body, "utf8");
  }
}
