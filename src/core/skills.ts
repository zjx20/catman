import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalOf } from "./commands.js";
import { BUILTIN_ADMIN_USER_KEY } from "./identity.js";
import { MIN_SHA_PREFIX } from "./releases.js";
import type { Persona } from "../config.js";
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
export const CRON_SKILL = "catman-cron";
export const ADMIN_SKILL = "catman-admin";
export const EVOLVE_SKILL = "catman-evolve";
export const RESCUE_SKILL = "catman-rescue";

/**
 * 普通回合可见的 skill。
 *
 * `catman-cron` 在这里而不是 admin 那边:定时任务是**每人自己的**,接口按回合
 * 令牌定身份,一个用户既看不见也动不了别人的任务 —— 与改自己的设置同一个模型。
 */
export const USER_SKILLS: readonly string[] = [USER_SKILL, CRON_SKILL];
/**
 * admin 回合可见的 skill。
 *
 * `catman-evolve` **只在这里**:改自己的代码并推上线是全局影响的事(一次部署把所有
 * 用户都换了版本),与 `/发布` `/回滚` 的 adminOnly 是同一个决定。普通用户的回合里
 * 连这份说明都不该出现 —— 它的 description 常驻上下文,列出来等于告诉每个人有这条路。
 */
export const ADMIN_SKILLS: readonly string[] = [USER_SKILL, CRON_SKILL, ADMIN_SKILL, EVOLVE_SKILL];
/**
 * 守护人格的 admin 回合可见的 skill。
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
  return `${frontmatter(
    CRON_SKILL,
    "管理当前用户的定时任务:按 cron / 固定间隔 / 指定时刻,在隔离的 docker 容器里跑一条命令," +
      "跑完把结果推给他。用户说「每天几点帮我…」「定时」「自动跑」「以后每隔多久…」时用它。",
  )}
# 定时任务

用户说"每天早上八点看一眼磁盘""每周日备份一次"这类话时,用这套接口给他建一个定时任务。
任务是**每个用户自己的**,凭据与 \`catman-settings\` 同一枚回合令牌,动不了别人的。

- \`$CATMAN_API_BASE\` — 接口地址,请求头 \`X-Catman-Session: $CATMAN_SESSION_TOKEN\`
- 根路径 \`/api/me/cron\`

## 两种任务,先想清楚要哪一种

| | \`script\` | \`agent\` |
|---|---|---|
| 干什么 | 在一次性 docker 容器里跑一条命令 | 到点让**你**(助手)去做一件要判断的事 |
| 什么时候用 | 备份、清理、拉个接口、看磁盘 | "有异常才告诉我"、"变化了才报"、整理归纳 |
| 花什么 | CPU | **订阅额度**(所以闸门更严:最快 15 分钟一次) |
| 最快多久一次 | 5 分钟(全局下限) | 15 分钟 |

**能用 script 就别用 agent。** 「每天备份一下」不需要判断,写成命令又快又便宜;
「看看今天有什么异常」才值得叫醒大脑。

## 建一个

\`\`\`bash
curl -s -X POST -H "X-Catman-Session: $CATMAN_SESSION_TOKEN" \\
  -H 'content-type: application/json' "$CATMAN_API_BASE/api/me/cron" -d '{
    "name": "每天早八看一眼磁盘",
    "schedule": { "kind": "cron", "expr": "0 8 * * *" },
    "task": { "cmd": ["bash","-lc","df -h /"] }
  }'
\`\`\`

返回 201 与完整任务(含 \`nextAtText\` —— **把它念给用户听**,那是他最关心的一句)。

### schedule 三选一

| 写法 | 含义 |
|---|---|
| \`{"kind":"cron","expr":"0 8 * * *","tz":"Asia/Shanghai"}\` | 5 字段 cron:分 时 日 月 周。\`tz\` 不给就用本机时区 |
| \`{"kind":"every","minutes":30}\` | 每 30 分钟。**单位是分钟**,字段名就写着 |
| \`{"kind":"once","at":"2026-08-20T03:00:00+08:00"}\` | 只跑一次。时刻**必须带时区**,跑完自动停用 |

cron 支持 \`*\`、\`1-5\`、\`*/15\`、\`1,3,5\`、以及 \`mon\`/\`jan\` 这类英文缩写。
星期位 0 和 7 都是周日。日期位与星期位**都**收窄时取并集(标准 cron 的老规矩)。

### task 字段

| 字段 | 默认 | 说明 |
|---|---|---|
| \`cmd\` | 必填 | **字符串数组**,exec 形式不过 shell。要 shell 就 \`["bash","-lc","…"]\` |
| \`image\` | \`catman-env:1\` | 本机一定有,带 bash / node / curl |
| \`network\` | \`"none"\` | **默认断网**。要联网写 \`"mynet"\` |
| \`mounts\` | \`[]\` | \`[{"host":"/opt/services/x","at":"/x","ro":true}]\`,host 是**宿主**路径,默认只读 |
| \`env\` | \`{}\` | 环境变量。**别往里放密钥** —— 它明文存在任务表里 |
| \`limits\` | 512m / 0.5 核 / 128 pid | 宿主是 2 核软路由,调大前先想清楚 |

任务自己的工作目录挂在容器里的 \`/work\`(可写、跨次保留),写中间结果放那儿。
容器里的时区跟 catman 一致,\`date\` 打出来的就是本地时间。

### agent 任务的 task 字段

\`\`\`json
{ "kind": "agent", "prompt": "看一眼 /opt/services 下各服务的日志,有异常才说", "session": "chain" }
\`\`\`

| 字段 | 默认 | 说明 |
|---|---|---|
| \`prompt\` | 必填 | 交给你自己的那句话。可以换行 |
| \`session\` | \`"fresh"\` | \`fresh\` 每次干净起步;\`chain\` 续这个任务上一次的上下文(「变化了才报」要用它) |
| \`model\` | 跟用户当前偏好 | 只能填白名单里的 |
| \`maxTurns\` | 20 | 本次最多几轮。**没人盯着的回合必须有上限** |

跑 agent 任务时你有完整的工具和 skill(包括这一份),工作目录就是那个用户的
workspace。但**没有进度推送**:用户没在等它,只有最终结果会按 notify 策略推。
它也**不碰用户正在聊的那段上下文** —— 那是独立会话。

### 其余字段

\`enabled\`(默认 true)、\`timeoutMinutes\`(默认 10,但不会超过一个触发间隔 —— 密集的任务会自动缩)、\`overlap\`(\`skip\` / \`replace\`,默认 skip)、
\`keepRuns\`(保留多少条执行记录,默认 20)、
\`notify\`(\`{"start":false,"end":true,"onlyFailure":false,"quiet":"23:00-08:00"}\`)。

**通知要克制**:主动推送花的是他上一条来信的发送预算,半夜跑的任务多半要等他
下次开口才收得到。默认只在跑完时推一条(带下次触发时刻)。巡检类任务建议
\`onlyFailure: true\` —— 成功就闭嘴。

\`quiet\` 是**静默时段**(可跨零点):窗口里只记录不推送,出窗口时把攒下的合并成
一条摘要(「静默时段里跑了 3 次:2 次成功、1 次失败」+ 最后一次的正文)。
夜里会跑的任务都该设一个 —— 不设的话那些通知也不会当场送达,只是会在他第二天
一开口时十几条一起砸过来。

## 其余接口

\`\`\`bash
S="X-Catman-Session: $CATMAN_SESSION_TOKEN"
curl -s -H "$S" "$CATMAN_API_BASE/api/me/cron"                 # 列出(含下次触发)
curl -s -H "$S" "$CATMAN_API_BASE/api/me/cron/<id>"            # 单个
curl -s -X PATCH -H "$S" -H 'content-type: application/json' \\
     -d '{"enabled":false}' "$CATMAN_API_BASE/api/me/cron/<id>"  # 改(整体重校验)
curl -s -X DELETE -H "$S" "$CATMAN_API_BASE/api/me/cron/<id>"  # 删(记录一起删)
curl -s -X POST -H "$S" "$CATMAN_API_BASE/api/me/cron/<id>/run" # 立即试跑,不动排期
curl -s -H "$S" "$CATMAN_API_BASE/api/me/cron/<id>/runs"       # 最近的执行记录
curl -s -H "$S" "$CATMAN_API_BASE/api/me/cron/<id>/runs/<runId>" # 某次的完整输出
\`\`\`

## 规矩

- **建完必须试跑一次**(\`/run\`,不影响排期),等几秒再看 \`runs\` ——
  "我给你建好了"和"它真的能跑"是两件事,而用户要到明天早上才发现区别。
- 校验很严:未知字段直接 400。**错误文案是写给人看的,原样转述给用户**,
  别自己猜着改参数重试。常见的三种错都在文案里写清了怎么改。
- 频率有下限:脚本 5 分钟、agent 15 分钟。用户要更密的,告诉他这是软路由与订阅
  额度的保护;脚本那道管理员可以调 \`cronMinIntervalMs\`,agent 那道写死在代码里。
- 连续失败 3 次的任务会被**自动停用**并通知。用户说"那个任务怎么不跑了",
  先看 \`enabled\` 和 \`runs\`。
- 一次执行的容器是 detached 的:catman 自己重启(比如部署)**不会**打断它,
  回来之后接着收结果。别拿"我要重启了"当理由劝用户改任务。

## 不定时的长任务:\`catman-notify\`

**定时任务解决"到点跑",长任务解决"跑完说一声"** —— 后者用不着建任务。
一条命令要跑好几分钟(制备、构建、批量转码),这样起:

\`\`\`bash
catman-notify run -n 制备 -- /data/deploy/bin/prepare.sh HEAD
\`\`\`

它立刻返回日志路径,跑完把**成败 + 耗时 + 日志尾巴**推给用户。所以你可以说
"跑完通知你"了 —— 在这之前那句话是兑现不了的,因为脱钩的进程没有任何人替它说话。
只想推一句话就 \`catman-notify send "备份好了"\`(也收 stdin)。

⚠️ **不要再手写 \`setsid nohup … &\`。** 裸跑确实活得过会话,但它跑完只会安静地
留下一个日志文件,用户永远等不到那条消息。

### 两个载体怎么选

| | \`catman-notify run\` | cron 一次性任务(\`{"kind":"once"}\`) |
|---|---|---|
| 现场 | **本容器内**的脱钩进程 | 宿主上的独立容器 |
| 起步 | 立刻 | 等下一次 tick(≤30 秒) |
| catman 被重新部署 | **跟着死,通知发不出来** | 照跑不误 |
| docker.sock / 完整挂载 | 有(就是本容器) | 受限(默认断网、只读挂载、无 socket) |

要用本容器的现场(制备自己就要起容器)、或者只是几分钟的事 → 用 \`catman-notify run\`。
要跑很久、横跨一次自我进化也不能丢 → 用一次性任务。

⚠️ 日志**不要写 \`/tmp\`**:那是容器内路径,别的容器挂不到(docker 的 \`-v\` 用的是
宿主路径)。\`catman-notify\` 默认写 \`$CATMAN_DATA_DIR/tmp/\`,自己写脚本时也照这个来。

推送有限流(20 条/小时):它花的是用户上一条来信的发送预算,超了会被信使那边
判成静默。撞到 429 说明有循环在刷,先去看是谁在发,别加重试。
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

export function evolveSkillBody(paths: SkillPaths): string {
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

### 让它跑完:脱离会话

制备要跑好几分钟(全量测试就占一多半)。你的回合结束时会话会被拆掉,**挂在回合上的
后台命令跟着一起死** —— 表现为日志停在某条测试中间,既没有失败也没有 sha。所以要让它
脱离会话跑:

\`\`\`bash
catman-notify run -n 制备 -- ${prepare} HEAD
\`\`\`

它立刻返回并告诉你日志路径,**制备跑完时把结果(成败 + 耗时 + 日志尾巴)推给管理员** ——
所以这一回合你不必守着它,也不该说"跑完通知你"以外的含糊话。下一回合第一件事仍然是
去读那个日志:通知说的是"完了没有",而变更分级与 sha 要你自己从日志里读出来。

⚠️ 不要再手写 \`setsid nohup … &\`。裸跑确实活得过会话,但**没有任何人替它说话** ——
那正是"跑完通知你"这句话一直兑现不了的原因。

### 满屏 \`Permission denied\` 是残骸,不是你

被杀掉的运行会留下 \`<releases>/<sha>.tmp\`,而它删不掉:lockfile 没变时那棵
node_modules 是 \`cp -al\` 复用来的,555 的目录权限一起复制了过来,连建它的人自己
都写不进去。制备的第一步正是删这个目录,于是新的制备在第一行就 \`set -e\` 退出,
满屏 \`rm: cannot remove ...: Permission denied\`。

\`prepare.sh\` 现在自己清(\`lib.sh\` 的 \`rm_release_tmp\`)。**还是看到这个报错的话,
说明固化的那份脚本比仓库里的旧** —— 那是 Tier 3,要人重新跑一次 bless;在那之前
先请管理员清一次,不要自己去改固化目录里的脚本。

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

export function rescueSkillBody(paths: SkillPaths): string {
  const primary = canonicalOf("primaryPersona");
  return `${frontmatter(
    RESCUE_SKILL,
    "诊断 catman 主人格的故障并在必要时把版本退回去:看部署报告、指针、容器状态、信使队列。" +
      "有人切到守护人格找你时用它 —— 那说明主人格多半正卡着或刚上线的版本有问题。",
  )}
# 诊断与恢复

你是守护人格。这份 skill 讲怎么查清主人格出了什么事,以及怎么把版本退回去。

**你不改代码。** 你跑的是钉住的稳定版本,改了也不会上线;而且真出事时,人要的是
"先恢复",不是"再来一次可能同样坏的改动"。改动留给主人格恢复之后再说。

## 先看这四样

\`\`\`bash
cat ${paths.deployDir}/report.json            # ① 上一次部署的结果(成功?自动回滚了?)
readlink ${paths.releasesDir}/current          # ② 线上跑的是哪个 sha
readlink ${paths.releasesDir}/stable           # ③ 上一个熬过观察期的 sha
docker inspect -f '{{.State.Status}} {{.RestartCount}}' catman   # ④ 主人格容器在不在
\`\`\`

**② 与 ③ 不一样 = 正处在观察期里**,那段时间的任何崩溃都会自然落回 stable,别急着动手。
④ 的 \`RestartCount\` 在涨 = crash-loop,原因去 \`docker logs --tail 200 catman\` 里找。

主 \`/data\` 对你是**只读**挂载,上面这些都读得到;想改就会 EACCES,那是刻意的。

## 主人格还活着但答非所问

先别退版本。让人给一句具体的复现(他刚说了什么、你猜他期待什么、实际收到什么),
再去 \`docker logs\` 里找那一轮。**没有证据就退版本是最糟的处置** ——
它把一个可能只是提示词问题的事故,变成一次真实的版本变更。

## 消息卡在信使里

\`\`\`bash
wc -l ${paths.courierDir}/inbox/primary.jsonl   # 队列有多长
\`\`\`

队列在涨而主人格没在处理,说明它拉不动了(卡死或已经死了)。这是**该退版本**的信号之一。

## 退版本

\`\`\`bash
${paths.deployBinDir}/deployer-run.sh demote --step 1 --why "<一句话说清为什么>"
\`\`\`

它起一个**一次性 deployer 容器**去换指针。三条纪律:

1. **绝不自己动 \`${paths.releasesDir}\` 下的符号链接。** 「更新者不能是被更新者」——
   换指针要先停容器,而你就跑在容器里。何况那个目录对你只读,你也写不动。
2. **demote 只拨 \`current\`,绝不动 \`stable\`。** 它是机械判据,远弱于观察期;
   让它改写"回退目标"这个概念本身,等于允许一次误判永久生效。
3. **一次退一级,退完观察。** \`--step 2\` 是在第一级没救回来之后才用的。

真要连 \`stable\` 一起拨(人已经判定那个版本坏了),那是 \`${canonicalOf("rollback")}\`,
由**管理员在主人格那边**发 —— 不是你代劳。

## 重启主人格

\`\`\`bash
docker restart catman
\`\`\`

**只在有理由相信是进程状态坏了(卡死、内存尽)时用。** 崩溃循环里重启没有意义,
只是把同一个错误再跑一遍,而且会让 \`RestartCount\` 这个判据变浑。

## 收尾

弄完告诉他两件事:**出了什么事**、**现在跑的是哪个版本**。然后提醒他发
\`${primary}\` 切回主人格 —— 忘了也不要紧,闲置一段时间会自动切回,但他会一直在跟你说话。
`;
}

/**
 * 把 skill 写到 CLAUDE_CONFIG_DIR/skills/ 下。启动时调用一次。
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
        ];
  for (const [name, body] of bodies) {
    const dir = join(configDir, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body, "utf8");
  }
}

/**
 * 这一回合该让哪些 skill 进上下文。
 *
 * 与 `writeSkills` 必须给出**一致**的人格分支 —— 列一个磁盘上没有的 skill,
 * SDK 那边只是安静地少一份说明,而它恰好是最需要的那份。有单测钉住两者对齐。
 */
export function skillsFor(persona: Persona, isAdmin: boolean): string[] {
  // 守护人格那边没有调度器,所以两条分支都要把 catman-cron 摘掉 ——
  // 普通用户这一支同样要摘,否则它会去调一个必然 404 的接口。
  if (persona === "rescue") return isAdmin ? [...RESCUE_SKILLS] : [USER_SKILL];
  return isAdmin ? [...ADMIN_SKILLS] : [...USER_SKILLS];
}
