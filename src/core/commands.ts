/**
 * 硬指令:不经过 LLM、由后台直接响应的一组命令。
 *
 * ## 两类指令
 *
 * **immediate** 的要绝对即时:`/取消` 这种救命的等不了聚合窗口那 1.5 秒,
 * 也不该排在前一批消息的处理(含发 greeting 那样的网络 IO)后面。所以它们在
 * onMessage 里就地执行,绕过聚合与队列。代价是与分拣节点、与在飞回合都并发,
 * 因此**只允许做幂等的只读/中断操作**。
 *
 * **改会话状态的**(`/新会话` `/继续` `/切换会话`)一律走队列,在分拣节点里
 * 与消息投递保持先后 —— 一批消息按到达顺序线性处理,指令之前的话落在原来那段
 * 会话,之后的话落在切过去那段。就地执行会与投递并发,那句话就落到谁也说不清的
 * 地方。走队列**不再意味着"卡在回合后面"**:分拣节点投递完就返回、不等回合跑完,
 * 所以卡死的 agent 堵不住它。
 *
 * ## 形式:只认斜杠,无例外
 *
 * 规则只有一条 —— 以 `/` 开头且整串精确匹配的才是指令。裸词一律不是,
 * 所以「帮助我写个脚本」「继续帮我改」这类正常说话永远走 LLM,不存在被截胡的疑虑。
 * 代价是发现性全靠 greeting:它必须把这张表写全,那是唯一的入口。
 *
 * 唯一的口子是 takesArg 指令:「/切换会话 abc123」按「首个空白前的 token 精确
 * 匹配指令、其余是参数」解析。口子只对声明了 takesArg 的指令开 ——
 * 「/帮助 一下」依旧不是指令,截胡的疑虑没有回来。
 *
 * COMMAND_TABLE 是单一真相源,帮助文案从它生成。
 */

export type CommandName =
  | "help"
  | "status"
  | "newSession"
  | "cancel"
  | "continue"
  | "switchSession"
  | "publish"
  | "rollback"
  | "upgradeStatus"
  | "rescue"
  | "primaryPersona"
  | "bind";

/**
 * 谁执行这条指令。
 *
 * `courier` 的那几条(路由切换、应急绑定)由**信使**在消息进人格之前就地消化 ——
 * 它们的语义住在信使的路由表与准入里,而不是人格的会话状态里。
 *
 * 仍然登记在这张表里,是因为**帮助文案必须列全**:这张表是指令的单一真相源,
 * 而发现性全靠 greeting 与 `/帮助`。分成两张表的结果一定是"信使加了条指令,
 * 用户永远不知道它存在"。
 *
 * 人格侧收到 `where === "courier"` 的指令一律**当它不是指令**(照常走 LLM)——
 * 正常情况下它压根到不了人格;真到了,说明跑着的信使版本比人格老、还不认识它,
 * 这时候安静地退化成普通消息,比回一句"这条我不管"有用。
 */
export type CommandWhere = "persona" | "courier";

export interface CommandDef {
  readonly name: CommandName;
  /** 规范形式,帮助文案里展示的就是它。 */
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly desc: string;
  /** true 表示绕过串行队列就地执行(见文件头)。 */
  readonly immediate: boolean;
  /** 可带一个参数(见文件头「唯一的口子」)。 */
  readonly takesArg?: boolean;
  /** 参数在帮助文案里的占位名,如「会话id」。 */
  readonly argHint?: string;
  /**
   * 只有管理员能用,且**只对管理员显示**。
   *
   * 这个字段不是装饰:部署类指令的影响是**全局**的 —— 一次回滚会把所有用户
   * 都换到另一个版本。而 catman 是多用户的(朋友扫码即可接入),没有这道闸的话,
   * 任何人打一句带斜杠的话就能触发,这正是"失误"本身,必须机械拦截而不是靠
   * 文案劝阻。非管理员发这些指令按"未知指令"处理(见 gateway),不透露它们存在。
   */
  readonly adminOnly?: boolean;
  /** 谁执行(见 CommandWhere)。缺省是人格。 */
  readonly where?: CommandWhere;
  /**
   * 不列进帮助文案。
   *
   * 与 `adminOnly` 是两件事:那个是**权限**,这个是**相关性**。目前只有 `/绑定` ——
   * 它只在"还没绑定"时有意义,而能看到 `/帮助` 的人全都已经绑定过了,
   * 对它的全部受众来说那是一行死文案。发现性由安装时给出的那份带外口令承担。
   */
  readonly hidden?: boolean;
}

export const COMMAND_TABLE: readonly CommandDef[] = [
  {
    name: "help",
    canonical: "/帮助",
    aliases: ["/help", "/幫助"],
    desc: "看这份使用指引",
    immediate: true,
  },
  {
    name: "status",
    canonical: "/状态",
    aliases: ["/status", "/狀態"],
    desc: "看当前模型、会话空闲时长、各项生效配置(不花额度)",
    immediate: true,
  },
  {
    name: "newSession",
    canonical: "/新会话",
    aliases: ["/new", "/clear", "/新會話"],
    desc: "丢掉当前上下文重新开始。上下文太长把我卡住时用这个",
    // 与 /继续 /切换会话 同属"改会话状态"的一类,一律走队列在分拣节点里
    // 线性执行。走队列不再意味着"卡在回合后面"—— 分拣节点投递完就返回,
    // 不等回合跑完,所以卡死的 agent 堵不住它,救命能力没有损失。
    // 反过来,就地执行会与分拣节点并发:它正把话投递给当前会话,
    // 这边把会话换掉了,那句话就落到了谁也说不清的地方。
    immediate: false,
  },
  {
    name: "cancel",
    canonical: "/取消",
    aliases: ["/cancel", "/stop"],
    desc: "中断正在进行的这一轮",
    immediate: true,
  },
  {
    name: "continue",
    canonical: "/继续",
    aliases: ["/continue", "/繼續"],
    desc: "续上刚才的对话,之后直接发消息就是接着聊(不花额度)",
    // 非 immediate,但同样不进 LLM(由网关在分拣节点里直接消化)。
    // 走队列的理由:它改会话时钟,与投递必须保持先后 —— 分拣节点按到达顺序
    // 线性处理一批,「/继续 + 问题」里的问题因此必定落在被它续上的那段会话里。
    immediate: false,
  },
  {
    name: "switchSession",
    canonical: "/切换会话",
    aliases: ["/switch", "/切換會話"],
    desc: "切回指定的旧对话,会话 id 给开头几位即可;只发指令本身则列出最近的对话(不花额度)",
    // 与 /继续 同理走队列:分拣节点按到达顺序线性处理,所以「/切换会话 xxx + 问题」
    // 里的问题必定落在切过去的那段会话里,而指令之前的话仍落在原来那段。
    immediate: false,
    takesArg: true,
    argHint: "会话id",
  },
  {
    name: "upgradeStatus",
    canonical: "/升级状态",
    aliases: ["/version", "/升級狀態"],
    desc: "看当前版本、上次升级的结果、可回退的版本(不花额度)",
    // 纯读磁盘上的报告与版本戳,幂等 —— 符合 immediate 的约束。
    // 而它恰恰是升级出问题时最该立刻答得出的那条:回合可能正卡着。
    immediate: true,
    adminOnly: true,
  },
  {
    name: "publish",
    canonical: "/发布",
    aliases: ["/publish", "/發布"],
    desc: "把制备好的版本部署上线,参数是版本号前 6 位(制备完我会报给你)",
    // **确认口令必须是硬指令,不能交给 LLM 转述。**
    // 它是自进化流水线里那把"人批准了什么 = 机器部署了什么"的机械锁:sha 由人亲手打进来、
    // 由网关按字面解析。让 agent 代为识别「发布 abc123」再去起 deployer 的话,这把锁就
    // 挂在一个会看错字、会自作主张、而且**正是被部署的那一方**的环节上 —— 那等于没有锁。
    //
    // 走队列而不是 immediate:它会重启进程,与 immediate 的「只做幂等只读/中断」正相反。
    immediate: false,
    takesArg: true,
    argHint: "版本号前6位",
    adminOnly: true,
  },
  {
    name: "rollback",
    canonical: "/回滚",
    aliases: ["/rollback", "/回退"],
    desc: "把版本退回上一个已验证的 release(升级后发现不对劲时用)",
    // 走队列而不是 immediate:它会重启进程,与"只做幂等只读/中断操作"的
    // immediate 约束正相反。走队列也不意味着排在回合后面 —— 分拣节点不等回合。
    immediate: false,
    adminOnly: true,
  },

  // ── 下面三条由**信使**执行(见 CommandWhere) ──────────────────────
  {
    name: "rescue",
    canonical: "/救援",
    aliases: ["/rescue"],
    desc: "把自己切到守护人格 —— 主人格卡死或答非所问时用它",
    // 信使就地消化,不进任何人格的队列:主人格卡死时它照样管用,那正是它存在的理由。
    immediate: true,
    adminOnly: true,
    where: "courier",
  },
  {
    name: "primaryPersona",
    canonical: "/主人格",
    aliases: ["/primary"],
    desc: "从守护人格切回主人格",
    immediate: true,
    adminOnly: true,
    where: "courier",
  },
  {
    name: "bind",
    canonical: "/绑定",
    aliases: ["/bind"],
    desc: "用安装时给的应急口令强制完成账号绑定(准入出问题时的逃生阀)",
    // **刻意不是 adminOnly**:它要救的恰恰是"主人被准入挡在门外、因而不可能被认作
    // 管理员"这种处境。安全前提是口令本身(带外给出、0600 落盘)。
    immediate: true,
    takesArg: true,
    argHint: "口令",
    where: "courier",
    hidden: true,
  },
];

const BY_TOKEN = new Map<string, CommandDef>();
for (const cmd of COMMAND_TABLE) {
  for (const token of [cmd.canonical, ...cmd.aliases]) {
    BY_TOKEN.set(token.toLowerCase(), cmd);
  }
}

/** parseCommand 的结果:指令 + 参数(无参指令与不带参数时为空串)。 */
export interface ParsedCommand {
  readonly cmd: CommandDef;
  readonly arg: string;
}

/**
 * 识别硬指令。必须以 `/` 开头且整串精确匹配 —— 「/帮助 一下」不算,
 * 「帮助」也不算。takesArg 指令另有带参形式:首个空白前的 token 精确匹配,
 * 其余是参数(见文件头「唯一的口子」)。
 */
export function parseCommand(text: string): ParsedCommand | undefined {
  const t = text.trim();
  if (!t.startsWith("/")) return undefined;
  const exact = BY_TOKEN.get(t.toLowerCase());
  if (exact) return { cmd: exact, arg: "" };

  const sp = t.search(/\s/);
  if (sp < 0) return undefined;
  const cmd = BY_TOKEN.get(t.slice(0, sp).toLowerCase());
  if (!cmd?.takesArg) return undefined;
  return { cmd, arg: t.slice(sp + 1).trim() };
}

/**
 * 帮助文案里的指令清单,每行形如 `/帮助（/help）— 看这份使用指引`。
 *
 * `isAdmin` 决定要不要列出 adminOnly 的那几条。默认不列 —— 漏传的后果应当是
 * "少显示几条"而不是"把管理员指令告诉所有人"。
 */
export function commandHelpLines(isAdmin = false): string[] {
  return COMMAND_TABLE.filter((c) => !c.hidden && (isAdmin || !c.adminOnly)).map((c) => {
    const arg = c.takesArg && c.argHint ? ` <${c.argHint}>` : "";
    const alt = c.aliases.length ? `(${c.aliases.join(" ")})` : "";
    return `${c.canonical}${arg}${alt} — ${c.desc}`;
  });
}

/** 供 reminderText 等文案引用规范形式,避免手写字符串跟表脱节。 */
export function canonicalOf(name: CommandName): string {
  const cmd = COMMAND_TABLE.find((c) => c.name === name);
  if (!cmd) throw new Error(`未知指令 ${name}`);
  return cmd.canonical;
}
