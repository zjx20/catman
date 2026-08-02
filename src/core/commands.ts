/**
 * 硬指令:不经过 LLM、由后台直接响应的一组命令。
 *
 * ## 为什么要有它
 *
 * 上下文撑爆导致 agent 卡死时,用户发的每条消息都排在那个卡死的回合后面 ——
 * 包括本该救命的那条。所以 immediate 指令**绕过每用户串行队列**,在 onMessage
 * 里就地执行。这是它们存在的全部理由。
 *
 * 代价:它们与在飞回合并发。因此 immediate 指令**只允许做幂等的只读/打标记操作**,
 * 不能做需要与回合互斥的事。
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
  | "switchSession";

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
    immediate: true,
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
    // 非 immediate,但同样不进 LLM(由网关在队列里直接消化)。
    // 走队列的理由:它要刷新会话时钟,排在在飞回合的 record() 之后才保证
    // 续上的是最新那个会话;也只有进聚合窗口,「/继续 + 问题」连发才能合成
    // 同一个回合。它不救命,不需要绕队列。
    immediate: false,
  },
  {
    name: "switchSession",
    canonical: "/切换会话",
    aliases: ["/switch", "/切換會話"],
    desc: "切回指定的旧对话,会话 id 给开头几位即可;只发指令本身则列出最近的对话(不花额度)",
    // 与 /继续 同理走队列:切换必须排在在飞回合的 record() 之后,否则会被
    // 那个回合结束时写回的 sessionId 覆盖;进聚合窗口还让「/切换会话 xxx + 问题」
    // 连发合成同一个回合,问题直接落在切过去的会话里。它不救命,不需要绕队列。
    immediate: false,
    takesArg: true,
    argHint: "会话id",
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

/** 帮助文案里的指令清单,每行形如 `/帮助（/help）— 看这份使用指引`。 */
export function commandHelpLines(): string[] {
  return COMMAND_TABLE.map((c) => {
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
