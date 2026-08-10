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
 * (守护人格的 workspace 在 `/data/rescue/workspace`,人手写的那份共享人设在主
 * `/data/workspace`,而主 /data 对它是只读挂载)。于是它对"我是谁"的全部线索,
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

/** 拼一段给 SDK `systemPrompt.append` 的人格简介。两个人格都有 —— 见文件头。 */
export function personaBriefing(persona: Persona): string {
  return persona === "rescue" ? RESCUE_BRIEFING : PRIMARY_BRIEFING;
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
- 主 \`/data\` 对你是**只读**挂载。读部署报告、release 指针、信使队列来做诊断可以;
  改主人格的任何状态不行 —— 写不进去,而尝试本身会让人以为你已经动过手了。
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
 * 每用户的 CLAUDE.md 首行是 `@../CLAUDE.md`,共享那份缺席时这个 import 悬空 ——
 * 主人格那边不会发生(人手写过),而守护人格的 workspace 是代码新建的,
 * 一直是空的。写一份占位让 import 有着落,顺便给人一个改人格风格的地方。
 *
 * **不覆盖已有文件**:它是人手维护的东西,启动时覆盖等于每次重启抹掉一次人设。
 * 与 skill 那种"每次启动幂等覆盖"刻意相反 —— skill 的真相源是代码,这个不是。
 */
export function initialSharedClaudeMd(persona: Persona): string {
  if (persona === "rescue") {
    return `# 守护人格的共享人设

你是 catman 的守护人格。身份与硬性约束由系统提示词给出(改这个文件盖不掉它们),
这里只写风格偏好。

- 说话直接:先说结论(出了什么事 / 要不要退版本),再给证据。
- 人来找你的时候多半正着急,别铺垫。
`;
  }
  return `# 共享人设

所有用户都会继承这份(每人自己的 CLAUDE.md 首行 \`@../CLAUDE.md\` 引入它)。
在这里写助手的说话方式、口味、通用约定。
`;
}
