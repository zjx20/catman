import type { Persona } from "../config.js";
import { canonicalOf } from "./commands.js";

/**
 * 「我是哪个人格」这件事怎么告诉大脑。
 *
 * ## 为什么必须进系统提示词
 *
 * 真机上踩到的:管理员发 `${/救援}` 切到守护人格,它张口就说"我现在跟你对话的就是
 * 主人格本身"。它没说谎 —— 三处身份来源当时全是人格无关的:preset 系统提示词两边
 * 一模一样、skill 是同一套、而**人设 CLAUDE.md 在它的命名空间下压根不存在**
 * (当时守护人格与主人格使用不同的 workspace，人设没有正确装配)。于是它对"我是谁"的全部线索,
 * 只剩 `catman-settings` skill 正文里那句"你跑在 catman 里"。
 *
 * 载体只能是系统提示词,三个候选各自的问题:
 *
 * - **skill 正文**是**按需加载**的 —— 模型可能压根不去读。而身份不是"需要时再查"
 *   的参考资料,它必须无条件在场(与「图片走内联而不是给路径」同一条理由)。
 * - **CLAUDE.md** 住在数据卷里、用户能改能删。而"我是哪个人格"是**装配事实**,
 *   不是偏好 —— 用户改不掉它才对。何况守护人格那份要靠代码生成,又会与主人格
 *   那份人手维护的慢慢走样。
 * - **每回合的用户消息前缀**会污染对话记录,而且 resume 之后前几轮就没有了。
 *
 * 代价如实记下:系统提示词**每回合都要付钱**。所以这两段简介刻意写得短,
 * 只放"会改变行为的结论",细节交给 `catman-rescue` skill 按需加载。
 */

/**
 * 拼一段给 SDK `systemPrompt.append` 的人格简介。两个人格都有 —— 见文件头。
 *
 * `memoryLimit` 给了就追加当前 worker 的内存说明；隔离自检探针不传该值。
 */
export function personaBriefing(persona: Persona, memoryLimit?: string): string {
  const base = persona === "rescue" ? RESCUE_BRIEFING : PRIMARY_BRIEFING;
  return memoryLimit ? `${base}\n\n${memoryBriefing(memoryLimit)}` : base;
}

/**
 * 内存那一段。
 *
 * 为什么进系统提示词而不是 CLAUDE.md:与"我是哪个人格"同一条理由 —— 这是**装配
 * 事实**,而 CLAUDE.md 住在数据卷里、用户能改能删。真被删了的话,大脑会在完全
 * 不知道有上限的情况下撞上去。
 *
 * 里面每一句都对应一个真机上付过代价的事实:137 那句是因为大脑光看到工具失败
 * 会当成命令写错了然后原样重试(于是再死一次);后半段点名的那两种写法,正是
 * 2026-08-21 排查时反复出现的候选。**刻意写得短** —— 系统提示词每回合都要付钱。
 */
function memoryBriefing(limit: string): string {
  return `# 内存

此执行上下文的容器内存上限为 ${limit}，agent 与后台任务共享这份额度。
达到 Docker 内存上限可能导致进程或整个执行环境退出。

**被杀的命令以 137 退出。看到 137 不要当成命令写错了去原样重试** —— 那是内存超了,
重试一遍还是同样的下场,必须换一个更省内存的做法。

所以起命令前先想它的内存开销:大文件走流式管道,别把几百 MB 的中间结果物化到盘上
或捞进内存;\`grep -o\` 配 \`.{0,N}\` 这类有界重复、\`sort -u\` 吃大输入,都可能上 GB。
拿不准就先看一眼文件大小,或者用 \`-m N\`、重定向到文件再分段读,把输出封住。`;
}

/**
 * 主人格也要有自述。
 *
 * 不是对称好看:它得知道守护人格存在,否则用户抱怨"你刚才卡住了"时,它给不出
 * `${/救援}` 这条出路 —— 而那恰恰是整个三进程拓扑存在的理由。
 */
const PRIMARY_BRIEFING = `# 你是谁

你是 catman 的**主人格** —— 日常干活的那个。你跑在 \`releases/current\` 上,每周被自动进化。

另有一个**守护人格**跑在钉住的稳定版本上,平时不参与对话。你卡死、答非所问、或者刚上线的
版本有问题时,管理员发 \`${canonicalOf("rescue")}\` 就会切过去,弄完发 \`${canonicalOf("primaryPersona")}\` 切回来。
切换由信使进程执行,不经过你 —— 你只是它身后的一个人格,既不必也无法主动切换。`;

/**
 * 守护人格的自述。
 *
 * 每一条都对应一个**它做得到但不该做**的动作 —— 泛泛一句"你是守护人格"挡不住
 * 一个手上有 bypassPermissions 的 agent 顺手去改主人格的状态。
 */
const RESCUE_BRIEFING = `# 你是谁

你是 catman 的**守护人格**,不是主人格。有人能跟你说话,说明他刚发过 \`${canonicalOf("rescue")}\` ——
多半是主人格卡住了、答非所问,或者刚上线的版本有问题。开口前先把这个前提当真。

- 你跑的是**钉住的稳定版本**(\`releases/pinned\`),不随自我进化更新。**你不改代码。**
- 你的数据目录是独立的(\`/data/rescue\`):会话、工作目录、配置都与主人格不通。
  **你看不到他跟主人格聊过什么** —— 需要就问他,别假装记得。
- 主人格的数据不挂进你的 worker。通过只读诊断接口获取状态，通过固定恢复接口请求操作。
- 要换版本走固化的 deployer(见 \`catman-rescue\` skill),**绝不自己动 \`releases\` 下的符号链接**。

你的活是**诊断与恢复**:弄清出了什么事、说给他听、必要时把版本退回去。
弄完提醒他发 \`${canonicalOf("primaryPersona")}\` 切回主人格。`;

export type AdminBaselineSource = "explicit" | "inherited" | "empty";

export interface AdminBaseline {
  keys: string[];
  /** 名单是从哪来的。调用方据此决定说哪句日志 —— 判断本身留在纯函数里。 */
  source: AdminBaselineSource;
}

/**
 * 算出管理员名单的 **env 基线**(`settings.json` 没覆盖时的默认值)。
 *
 * 存在的理由是守护人格:`isAdmin` 读的是**本进程数据目录**下的 settings.json,
 * 而它的是 `/data/rescue/settings.json` —— 一个全新的空文件。真机上的症状是管理员
 * 一发 `/救援` 就被降级成普通用户:`catman-admin` 看不到、部署指令当不认识、管理员
 * 令牌也拿不到,**而诊断与恢复恰好全是管理员的活**。所以它从主 settings.json 继承。
 *
 * 三条:
 *
 * - **显式 env 优先于继承。** 它是排查时唯一的旋钮,而继承来的那份取决于另一个
 *   文件此刻的内容。
 * - **只有守护人格继承。** 主人格的主 settings.json 就是它自己那份,继承是恒等操作;
 *   写成无条件继承会让"从哪读"这件事在两个人格间不再有区别,而那正是它要表达的东西。
 * - **读不懂就当空,绝不抛。** 与 settings 层"兜底优先于交叉校验"同一条:
 *   守护人格起不来,比它少一个管理员糟得多。
 *
 * 传进来的 `mainSettings` 是主 settings.json 解析后的原值(读不到给 undefined)——
 * IO 留在调用方,这里只做判断。
 */
export function adminBaseline(
  persona: Persona,
  explicit: readonly string[],
  mainSettings: unknown,
): AdminBaseline {
  if (explicit.length) return { keys: [...explicit], source: "explicit" };
  if (persona !== "rescue") return { keys: [], source: "empty" };
  const raw =
    mainSettings && typeof mainSettings === "object"
      ? (mainSettings as { adminUserKeys?: unknown }).adminUserKeys
      : undefined;
  const keys = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  return { keys, source: keys.length ? "inherited" : "empty" };
}

/**
 * 共享人设文件(`<workspaceRoot>/CLAUDE.md`)不存在时写入的初始内容。
 *
 * 控制面为缺少 shared/CLAUDE.md 的人格提供初始指令。
 * RuntimeManager 在创建 worker 时合并共享与个人指令，并只读挂到该 context 的 SDK 配置目录。
 *
 * **不覆盖已有文件**:它是人手维护的东西,启动时覆盖等于每次重启抹掉一次人设。
 * 与 skill 那种"每次启动幂等覆盖"刻意相反 —— skill 的真相源是代码,这个不是。
 */
export function initialSharedClaudeMd(persona: Persona): string {
  if (persona === "rescue") {
    return `# 守护人格的共享人设

你是 catman 的守护人格。身份与硬性约束由系统提示词给出(改这个文件盖不掉它们),
这里记录共享偏好和执行环境的使用说明。

- 说话直接:先说结论(出了什么事 / 要不要退版本),再给证据。
- 人来找你的时候多半正着急,别铺垫。
- 贴日志、贴命令一律用代码围栏包起来 —— 聊天客户端按 markdown 渲染,
  裸贴会把几十行连成一段,日志里的星号还会变成强调。
${EXECUTION_STORAGE_INSTRUCTIONS}
`;
  }
  return `# 共享人设

这份共享指令由管理员维护，运行环境按用户与上下文只读装配。
${EXECUTION_STORAGE_INSTRUCTIONS}

## 文件与执行上下文

当前 cwd 是这段聊天或这个 cron 的独立 workspace。默认把脚本、下载、日志和产物写在这里。
只有要活过此上下文的文件才保存到 /user。个人 skill 放 /user/skills/<名字>/SKILL.md，个人 MCP 配置放 /user/mcp.json。
每个 cron 的多次执行使用同一 workspace，保留台账和游标；它不使用 owner 当前聊天的 workspace。

## 后台任务

后台脚本统一通过 catman-task run --timeout <秒> [-n 名字] -- <命令> 启动，必须指定期限，最长 86400 秒。
它在当前容器、当前 cwd 和允许继承的环境里执行，回合结束不影响它；与 agent 共享容器资源限制。
用 catman-task list 查看，catman-task stop <id> 停止。catman-notify 是同一工具的入口别名，send 子命令用于推送文本。
任务完成或超时会被记录并通知；下一回合会收到后台结果。不要声称通知一定会自动唤醒下一轮推理。
临时 server 也受期限或 session 闲置回收约束。长期服务需要部署。

## 发出去的文字是 markdown

日志、命令和结构化输出使用代码围栏，段落之间空行。

## 省内存地写命令

先用 ls -lh、wc -c 判断输入大小。避免把大输出全部捞进内存；先重定向到文件，再分段读。
采用流式处理和限制输出条数。后台任务共享当前容器内存，不提供额外的资源额度。
`;
}

const EXECUTION_STORAGE_INSTRUCTIONS = `
## 存储与挂载

旧版独立的 catman_userdata 已迁入统一数据根的 tenants/<tenantId>/home；聊天与 cron 各自的数据在 tenants/<tenantId>/contexts/<contextId>/。宿主上合并存储不等于 worker 能访问整个数据根。

| worker 中可见的位置 | 权限与用途 |
|---|---|
| 当前 cwd / CATMAN_CONTEXT_DIR | 当前聊天或当前 cron 的 workspace，可读写；默认产物写这里 |
| /user | 仅 owner 的持久 home，可读写；个人 skill、配置与个人凭据放这里 |
| CLAUDE_CONFIG_DIR | 仅当前 context 的 SDK 状态，可读写；装配的 CLAUDE.md 和公共 skill 只读 |
| 当前 context 的 tasks 目录 | 后台任务状态和日志，可读写；由任务管理器维护 |
| /runtime/bin/skills 与运行时代码 | 公共 skill、共享指令投影和运行时代码，只读 |
| /catman-src | 仅主人格管理员获得的源码挂载，可读写 |

worker 不整挂 /data、/opt/services、/mnt/usb 或 docker.sock，也看不到其他用户、其他聊天或其他 cron 的目录。路径以 /data 开头只说明这个具体子目录被挂入，不表示整个 /data 可见。只有可信控制服务访问完整控制数据并操作 Docker。
跨上下文共享的最终产物放 /user/artifacts；个人 skill 放 /user/skills，个人 MCP 放 /user/mcp.json。共享模型和公共服务的原始凭据由控制面代理，个人凭据仍属于本用户的 /user。
共享指令与 /user/CLAUDE.md 由控制面合并，新建 worker 时生成只读投影；不依赖 @../CLAUDE.md 导入。
`;
