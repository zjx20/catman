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
 * COMMAND_TABLE 是单一真相源,帮助文案从它生成。
 */

export type CommandName = "help" | "status" | "newSession" | "cancel" | "continue";

export interface CommandDef {
  readonly name: CommandName;
  /** 规范形式,帮助文案里展示的就是它。 */
  readonly canonical: string;
  readonly aliases: readonly string[];
  readonly desc: string;
  /** true 表示绕过串行队列就地执行(见文件头)。 */
  readonly immediate: boolean;
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
    // 唯一非 immediate 的指令,但同样不进 LLM(由网关在队列里直接消化)。
    // 走队列的理由:它要刷新会话时钟,排在在飞回合的 record() 之后才保证
    // 续上的是最新那个会话;也只有进聚合窗口,「/继续 + 问题」连发才能合成
    // 同一个回合。它不救命,不需要绕队列。
    immediate: false,
  },
];

const BY_TOKEN = new Map<string, CommandDef>();
for (const cmd of COMMAND_TABLE) {
  for (const token of [cmd.canonical, ...cmd.aliases]) {
    BY_TOKEN.set(token.toLowerCase(), cmd);
  }
}

/**
 * 识别硬指令。必须以 `/` 开头且整串精确匹配 —— 「/帮助 一下」不算,
 * 「帮助」也不算。
 */
export function parseCommand(text: string): CommandDef | undefined {
  const t = text.trim().toLowerCase();
  if (!t.startsWith("/")) return undefined;
  return BY_TOKEN.get(t);
}

/** 帮助文案里的指令清单,每行形如 `/帮助（/help）— 看这份使用指引`。 */
export function commandHelpLines(): string[] {
  return COMMAND_TABLE.map((c) => {
    const alt = c.aliases.length ? `(${c.aliases.join(" ")})` : "";
    return `${c.canonical}${alt} — ${c.desc}`;
  });
}

/** 供 REMINDER_TEXT 等文案引用规范形式,避免手写字符串跟表脱节。 */
export function canonicalOf(name: CommandName): string {
  const cmd = COMMAND_TABLE.find((c) => c.name === name);
  if (!cmd) throw new Error(`未知指令 ${name}`);
  return cmd.canonical;
}
