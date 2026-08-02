import type { Channel } from "../channels/types.js";
import type { Agent, AgentProgressEvent } from "./agent.js";
import type { SessionManager, SessionRef } from "./session.js";
import type { UserRegistry } from "./users.js";
import type { PrefsStore } from "./prefs.js";
import type { GlobalSettings } from "./settings.js";
import type { TurnTokens } from "./turn-tokens.js";
import { allowAll, type AdmissionPolicy } from "./admission.js";
import type { Attachment } from "./attachments.js";
import { canonicalOf, commandHelpLines, parseCommand, type CommandDef } from "./commands.js";
import { SETTING_SCHEMA, USER_SETTING_KEYS } from "./settings.js";
import { ADMIN_SKILLS, USER_SKILLS } from "./skills.js";

/** 会话 id 的展示形式:开头 8 位足够在 HISTORY_LIMIT 条内无歧义,也好在手机上打。 */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * 超时提醒文案。指令写法从 COMMAND_TABLE 取,免得改了指令这句话变成假话。
 * 带上会话 id 是刻意的:用户如果直接发新话题(最常见的走向),旧会话就此归档,
 * 这条提醒是他知道"怎么切回去"的唯一机会。
 */
export function reminderText(sessionShortId: string): string {
  return (
    "这次对话已经安静了一会儿。再发消息我会默认开一段新对话来处理;" +
    `如果想接着刚才的话题聊,发 ${canonicalOf("continue")} 即可。` +
    `开了新对话之后,发「${canonicalOf("switchSession")} ${sessionShortId}」也能随时切回这段。`
  );
}

/** 收到消息后的即时回执文案。回复发出后,支持撤回的渠道会撤回这条回执。 */
export const ACK_TEXT = "收到,正在处理中…";

/** 进度消息里思考/工具参数摘要的截断长度。 */
const PROGRESS_MAX_CHARS = 200;

export interface GatewayOptions {
  channel: Channel;
  agent: Agent;
  sessions: SessionManager;
  /** 用户注册表;决定每个用户的工作目录。 */
  users: UserRegistry;
  /** 每用户配置层。回执/进度/模型/分段长度都从这里现算。 */
  prefs: PrefsStore;
  /** 全局配置层。并发上限、管理员判定从这里来。 */
  settings: GlobalSettings;
  /** 回合令牌铸造厂。 */
  turns: TurnTokens;
  /** 告诉 agent 从容器内怎么访问本进程的 HTTP 接口。 */
  apiBase: string;
  /** 提醒轮询间隔(ms)。 */
  reminderIntervalMs: number;
  /** 谁能使用本助手。默认全放行(仅适合 stdin 这类本地通道)。 */
  admission?: AdmissionPolicy;
  /**
   * 某段会话的 JSONL 记录是否还在磁盘上(index.ts 注入,指向 transcript 层)。
   * /切换会话 靠它在切换前确认目标活着:保留期清理与 dropSessionIds 同步出清,
   * 但清理周期之间、或记录被外部删除时,history 仍可能挂着死引用 ——
   * 切过去再让 resume 炸出一句原始报错,不如提前给句人话。不传则视为都活着。
   */
  sessionExists?: (userKey: string, sessionId: string) => boolean;
  /**
   * 时钟。目前只喂给进度节流 —— 它是纯计算,可以用假时钟驱动。
   *
   * 聚合窗口**刻意不用**这个:它的时刻是拿来和真实 `setTimeout` 对账的
   * (`deadline - now` 直接当延时用),换成假时钟会让两者跑在不同的时间轴上。
   */
  now?: () => number;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * 从一批消息里取一小段开头文字,记进会话历史当"主题"——
 * 会话列表里光有 id 认不出哪段是哪段,这一眼提示就是给人认的。
 */
function sessionHint(text: string, hasAttachments: boolean): string {
  const firstLine = text.trim().split("\n", 1)[0] ?? "";
  return truncate(firstLine, 24) || (hasAttachments ? "[图片]" : "");
}

/** 从工具入参里挑一个最能说明"在干什么"的字段做摘要。 */
function summarizeToolInput(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["description", "command", "file_path", "pattern", "prompt", "query", "url"]) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
}

/**
 * 把进度事件格式化成一条发给用户的短消息。
 * `skipped` 是本条之前被节流掉的事件数,标出来是为了让"卡在一件事上"与
 * "一直在快速推进"看起来不一样 —— 否则用户只看到间隔变长,分不清是哪种。
 */
export function formatProgress(ev: AgentProgressEvent, skipped = 0): string {
  const body =
    ev.kind === "thinking"
      ? `💭 ${truncate(ev.text.trim(), PROGRESS_MAX_CHARS)}`
      : (() => {
          const summary = truncate(summarizeToolInput(ev.input), PROGRESS_MAX_CHARS);
          return summary ? `🔧 ${ev.name}: ${summary}` : `🔧 ${ev.name}`;
        })();
  return skipped ? `${body}(+${skipped} 步)` : body;
}

/**
 * 进度推送的间隔阶梯:发出第 1 条前等 5 秒,之后依次 15、30、60 秒,用完停在 60 秒。
 *
 * 逐级拉长而不是固定频率,是因为用户对进度的需求随回合变长而下降:开头想知道
 * "接住了没",几分钟后只想知道"还活着"。而每条进度在 iLink 上都是一次 HTTP 往返,
 * 且要消耗同一个 `context_token` 的额度(见 ProgressThrottle 的说明)。
 */
export const PROGRESS_INTERVALS_MS = [5_000, 15_000, 30_000, 60_000];

/**
 * 一个 `context_token` 总共能发多少条。
 *
 * 真机实测:第 11 条起 `sendmessage` 返回 `ret=-2 prepare failed`,且**永不恢复** ——
 * 不是限流(限流会放行),是这个 token 作废。详见 README「一个 context_token 的发送预算」。
 * 这里取实测值本身、不偷偷留余量:余量在 RESERVED_SENDS 里显式列支,
 * 免得两处各自"稍微保守一点",最后谁也说不清实际还剩多少。
 */
const SEND_BUDGET = 10;

/**
 * 预留给非进度用途的条数,进度不许碰:
 *
 *   1 条**正文** —— 回复超过 `maxReplyChars` 会分段,后面几段仍可能超预算失败,
 *     但用户至少拿到开头,比彻底静默强得多。
 *   1 条**会话空闲提醒** —— 它和正文共用同一个 `context_token`:提醒的前提就是
 *     用户没再发消息,而 `replyCtx` 只在收到新消息时更新,所以那时用的还是这一份。
 *     预留不保证它一定发得出去(iLink 本就不支持主动推送),但进度把额度吃光的话,
 *     它**一定**发不出去。
 */
const RESERVED_SENDS = 2;

/**
 * 一个回合里最多推几条进度 = 预算 − 回执 1 条 − 预留 2 条。
 *
 * 光有间隔阶梯不够:阶梯只是把间隔拉长,总条数仍随回合时长无限增长 ——
 * 稳定在 60 秒一条之后,一个十分钟的回合照样能发十几条,又撞回预算,
 * 而那时被挤掉的正好是最不能丢的那几条。所以还要一个绝对上限。
 */
export const MAX_PROGRESS_PER_TURN = SEND_BUDGET - 1 - RESERVED_SENDS;

/** 额度用尽时附在最后一条进度后面的交代。 */
const PROGRESS_CAP_NOTICE = "(进度就报到这儿,接下来直接等答案)";

/**
 * 进度推送节流器。
 *
 * **为什么必须节流**:iLink 的一个 `context_token` 撑不住一个长回合里的几十条消息 ——
 * 真机实测第 11 条起 `sendmessage` 返回 `ret=-2 prepare failed` 且**永不恢复**,
 * 连最后的正式回复都发不出去,用户那边彻底静默。旧实现每个事件发一条,
 * 一个 83 秒的回合发了 23 条,其中 21 条是进度。
 *
 * **节流而不是聚合**:同一间隔内攒下的事件只发**最新那条**,旧的直接丢。
 * 进度是"现在在干什么"这个状态,不是需要完整送达的流水;到点补发一条几十秒前的
 * 工具调用没有意义,还要额外占一次发送额度。丢掉多少条记在 `skipped` 里交代。
 *
 * **纯事件驱动,不用定时器**:没有新事件就不推进。这一点与旧实现一致 ——
 * agent 卡在一次长工具调用里时两者都不会更新进度,所以没有退步;而不引入定时器
 * 就不存在"回合结束后定时器才触发、进度插到正式回复后面"这类乱序风险。
 */
export class ProgressThrottle {
  private nextAllowedAt: number;
  /** 已经放行几条 —— 决定用阶梯里的哪一档。 */
  private sent = 0;
  /** 上次放行之后被丢掉几条。 */
  private skipped = 0;

  constructor(
    startedAt: number,
    private readonly intervals: readonly number[] = PROGRESS_INTERVALS_MS,
    private readonly maxSends: number = MAX_PROGRESS_PER_TURN,
  ) {
    this.nextAllowedAt = startedAt + (intervals[0] ?? 0);
  }

  /**
   * 交一个事件进来。到点则返回该发的文本,没到点返回 undefined(该事件被丢弃)。
   * 时刻在**决定放行时**推进而不是发送完成后 —— 否则一次慢发送期间会漏过好几条。
   */
  offer(now: number, ev: AgentProgressEvent): string | undefined {
    // 额度用尽就彻底不发了,连计数都不必再攒 —— 后面没有任何一条会被放出去。
    if (this.sent >= this.maxSends) return undefined;
    if (now < this.nextAllowedAt) {
      this.skipped += 1;
      return undefined;
    }
    const text = formatProgress(ev, this.skipped);
    this.skipped = 0;
    this.sent += 1;
    // 第 n 条发完之后用第 n 档间隔;超出阶梯长度就一直用最后一档。
    this.nextAllowedAt = now + (this.intervals[Math.min(this.sent, this.intervals.length - 1)] ?? 0);
    // 最后一条要说清楚后面没了。否则用户看到的是进度突然断掉,与"卡死了"无从分辨 ——
    // 长回合下这段静默可能长达好几分钟,正是最容易让人以为出事的时候。
    return this.sent === this.maxSends ? `${text}\n${PROGRESS_CAP_NOTICE}` : text;
  }
}

/** 把毫秒说成人话。用于 /状态。 */
function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} 小时`;
  return `${(ms / 86_400_000).toFixed(1)} 天`;
}

/**
 * 使用指引。**由 COMMAND_TABLE 与 SETTING_SCHEMA 生成** ——
 * 加指令或加配置项时这里自动跟上,不会出现"文档说有、实际没有"。
 */
export function helpText(modelAllowlist: string[]): string {
  const cmds = commandHelpLines()
    .map((l) => `  ${l}`)
    .join("\n");
  const settings = USER_SETTING_KEYS.map((key) => {
    const def = SETTING_SCHEMA[key];
    return `  ${def.label} — ${def.hint({ modelAllowlist })}`;
  }).join("\n");
  return [
    "跟我说话就行,平常怎么聊都可以。",
    "",
    "下面这些是硬指令,不经过大脑、后台直接答,所以我卡住的时候它们照样管用。",
    "必须以 / 开头,而且整条消息只有指令本身:",
    cmds,
    "",
    "另外你可以直接跟我说「换成 sonnet」「别刷进度了」「超时改成一天」,",
    "我会去改你自己的设置。能改的有:",
    settings,
    "",
    `想接着聊被超时中断的话题,发 ${canonicalOf("continue")};`,
    `上下文太长把我卡住了,发 ${canonicalOf("newSession")} 重新开始;`,
    `想切回之前的某段对话,发 ${canonicalOf("switchSession")} 加上会话 id(只发指令则列出最近的对话)。`,
  ].join("\n");
}

/** 首次使用时推送的欢迎语。正文就是那份指引,不另写一份免得两处走样。 */
export function greetingText(modelAllowlist: string[]): string {
  return `你好,我是 catman。\n\n${helpText(modelAllowlist)}`;
}

/**
 * 简单信号量:限制同时进行的 agent 回合数。
 *
 * 需要它是因为多用户下所有人可能同时发消息:软路由 CPU 本就紧张,Claude 订阅
 * 也有速率限制 —— 全部并发起 query 的结果是一起变慢或一起触发限流。
 * 超限的回合排队等待,而不是被拒绝。
 *
 * 名额在**放行那一刻**就记账(而不是等唤醒后),否则唤醒前的那一小段里
 * 名额会被别人抢走,导致同时在跑的数量突破上限。
 */
class Semaphore {
  private active = 0;
  private limit: number;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
      // 被 pump 放行时名额已经记在我们头上了,这里不再自增。
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      // 防重复释放:同一个 release 被调两次会让计数虚低,进而突破上限。
      if (released) return;
      released = true;
      this.active -= 1;
      this.pump();
    };
  }

  /** 运行时调整上限。调高立刻放人;调低不打断在跑的,靠自然结束收敛。 */
  setLimit(limit: number): void {
    this.limit = limit;
    this.pump();
  }

  private pump(): void {
    while (this.active < this.limit && this.waiting.length) {
      const next = this.waiting.shift()!;
      this.active += 1;
      next();
    }
  }
}

/**
 * 聚合的兜底上限倍数:从**第一条**消息算起,最多等 `窗口 × 这个倍数`
 * (默认窗口 1.5 秒 → 60 秒)。
 *
 * 定得这么松是有意的:**能攒到一起本身就是好事**。用户一直在发,说明他还没说完,
 * 这时候切批去起一个回合是打断他 —— 攒完再一次性处理,既更符合他的意图,也更省。
 * 所以这不是"防止某人饿死自己"的公平性限制,那种情况下等待才是对的行为。
 *
 * 它存在的唯一理由是兜底:batch 会把文本与图片攒在内存里,总得有个不再增长的时刻。
 * 正常聊天永远碰不到 —— 要连续 40 次以不到一个窗口的间隔发消息才会触发。
 */
const AGGREGATION_MAX_MULTIPLIER = 40;

/**
 * 一批正在等待聚合的消息。
 *
 * 存在的理由:微信发「图 + 文字」**不是一条消息** —— 实测两条相隔约 120ms
 * (图片先到、文本后到,或反过来)。不攒一下的话会起两个回合,而且先到的那条
 * 必然缺另一半,于是助手先答一句"我没看到图"再答一遍,既费额度又显得莫名其妙。
 */
interface PendingBatch {
  texts: string[];
  attachments: Attachment[];
  continueRequested: boolean;
  /** 批里带着 /切换会话 时的目标 id 前缀;连发多条切换指令时后到的覆盖先到的。 */
  switchTo?: string;
  /** debounce 计时器:每来一条消息就重置。 */
  timer: NodeJS.Timeout;
  /** 第一条消息的到达时刻,用于算硬上限。 */
  firstAt: number;
  /** 本批处理完成时兑现;同一批的每个 dispatch 都拿到它。 */
  done: Promise<void>;
  settle: () => void;
}

/** prelude 的结果:被准入拒绝时为 null。 */
interface Prelude {
  cwd: string;
  /** 本次刚推过 greeting —— help 指令据此避免重复推送同样的内容。 */
  justGreeted: boolean;
}

/**
 * 网关:把渠道消息接到会话状态机与 Agent,串起完整回合。
 * 同一用户的消息串行处理,避免并发 resume 同一会话导致的竞态;
 * 不同用户之间并发,但受全局配置的并发上限限制。
 */
export class Gateway {
  private readonly channel: Channel;
  private readonly agent: Agent;
  private readonly sessions: SessionManager;
  private readonly users: UserRegistry;
  private readonly prefs: PrefsStore;
  private readonly settings: GlobalSettings;
  private readonly turns: TurnTokens;
  private readonly apiBase: string;
  private readonly admission: AdmissionPolicy;
  private readonly sessionExists: ((userKey: string, sessionId: string) => boolean) | undefined;
  private readonly now: () => number;
  private readonly reminderIntervalMs: number;
  private readonly semaphore: Semaphore;

  private reminderTimer?: NodeJS.Timeout;
  /** 每用户一条处理链,保证串行。 */
  private readonly queues = new Map<string, Promise<void>>();
  /** 每用户至多一批待聚合的消息。 */
  private readonly pending = new Map<string, PendingBatch>();

  constructor(opts: GatewayOptions) {
    this.channel = opts.channel;
    this.agent = opts.agent;
    this.sessions = opts.sessions;
    this.users = opts.users;
    this.prefs = opts.prefs;
    this.settings = opts.settings;
    this.turns = opts.turns;
    this.apiBase = opts.apiBase;
    this.admission = opts.admission ?? allowAll;
    this.sessionExists = opts.sessionExists;
    this.now = opts.now ?? Date.now;
    this.reminderIntervalMs = opts.reminderIntervalMs;
    this.semaphore = new Semaphore(this.settings.effective().maxConcurrentTurns);
    this.settings.onChange(() => {
      this.semaphore.setLimit(this.settings.effective().maxConcurrentTurns);
    });
  }

  async start(): Promise<void> {
    this.channel.onMessage((msg) => this.dispatch(msg.userKey, msg.text, msg.attachments ?? []));
    this.reminderTimer = setInterval(() => this.flushReminders(), this.reminderIntervalMs);
    // 允许进程在只剩此定时器时退出(容器里无所谓,测试友好)。
    this.reminderTimer.unref?.();
    await this.channel.start();
  }

  async stop(): Promise<void> {
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    // 攒着的消息立刻入队,不等窗口走完:消息已经从渠道收下了(长轮询游标也推进了),
    // 丢掉就是真丢。能不能跑完交给关闭流程,总好过在这里静默吞掉。
    for (const userKey of [...this.pending.keys()]) this.flush(userKey);
    await this.channel.stop();
  }

  /**
   * 消息入口分流。
   *
   * immediate 硬指令**不入队**,就地执行 —— 这是它们存在的理由:agent 卡死时
   * 队列里的消息永远轮不到,包括本该救命的那条。代价是它们与在飞回合并发,
   * 所以只做幂等的只读/打标记操作。
   */
  private dispatch(
    userKey: string,
    text: string,
    attachments: readonly Attachment[] = [],
  ): Promise<void> {
    // 带图的消息不当硬指令解析:硬指令要求整条消息只有指令本身,而「/状态 + 一张图」
    // 显然不是那个意思。让它照常走 LLM,免得图片被指令分支静默吞掉。
    const parsed = attachments.length ? undefined : parseCommand(text);
    // immediate 硬指令不进聚合窗口 —— 它们存在的全部理由就是"立刻",
    // 让救命的 /取消 先等 1.5 秒等于取消了这个理由。
    if (parsed?.cmd.immediate) return this.runCommand(userKey, parsed.cmd);

    // 到这里只可能是 /继续 或 /切换会话:它们贡献的是标记,不是给 LLM 的文本。
    // 单独发时由 handle 后台消化;与别的消息攒成一批时,标记随批生效。
    const promptText = parsed ? "" : text;
    const continueRequested = parsed?.cmd.name === "continue";
    const switchTo = parsed?.cmd.name === "switchSession" ? parsed.arg : undefined;
    const windowMs = this.settings.effective().messageAggregationMs;
    if (windowMs <= 0) {
      return this.enqueue(userKey, promptText, continueRequested, attachments, switchTo);
    }
    return this.collect(userKey, promptText, continueRequested, attachments, switchTo, windowMs);
  }

  /**
   * 把消息并进该用户待聚合的那一批,并把计时器往后推。
   *
   * debounce 而不是固定窗口:连发的几条要一起处理,固定窗口会把跨过窗口边界的
   * 那条切到下一批去。用户还在发就继续攒 —— 攒得越多越好,见
   * AGGREGATION_MAX_MULTIPLIER 那里对"为什么上限定得很松"的说明。
   */
  private collect(
    userKey: string,
    text: string,
    continueRequested: boolean,
    attachments: readonly Attachment[],
    switchTo: string | undefined,
    windowMs: number,
  ): Promise<void> {
    const now = Date.now();
    let batch = this.pending.get(userKey);
    if (!batch) {
      let settle!: () => void;
      const done = new Promise<void>((resolve) => (settle = resolve));
      batch = {
        texts: [],
        attachments: [],
        continueRequested: false,
        timer: undefined as unknown as NodeJS.Timeout,
        firstAt: now,
        done,
        settle,
      };
      this.pending.set(userKey, batch);
    }

    if (text) batch.texts.push(text);
    batch.attachments.push(...attachments);
    // 同批里只要有一条是 /继续,整批就按"接着上一段聊"处理。
    batch.continueRequested ||= continueRequested;
    if (switchTo !== undefined) batch.switchTo = switchTo;

    clearTimeout(batch.timer);
    const deadline = batch.firstAt + windowMs * AGGREGATION_MAX_MULTIPLIER;
    const wait = Math.max(0, Math.min(windowMs, deadline - now));
    batch.timer = setTimeout(() => this.flush(userKey), wait);
    batch.timer.unref?.();
    return batch.done;
  }

  /** 把攒好的一批交给串行队列。 */
  private flush(userKey: string): void {
    const batch = this.pending.get(userKey);
    if (!batch) return;
    this.pending.delete(userKey);
    clearTimeout(batch.timer);

    // 上限要在合并后重新收一次:渠道只保证单条消息不超,连发几条各带图仍可能超。
    const { maxImagesPerTurn } = this.settings.effective();
    const attachments = batch.attachments.slice(0, maxImagesPerTurn);
    if (attachments.length < batch.attachments.length) {
      console.info(
        `[gateway] ${userKey} 聚合后有 ${batch.attachments.length} 张图,` +
          `超出上限 ${maxImagesPerTurn},丢弃 ${batch.attachments.length - attachments.length} 张`,
      );
    }

    // handle 内部已把异常都收敛成给用户的回复,这里两路都只管兑现 promise。
    this.enqueue(
      userKey,
      batch.texts.join("\n"),
      batch.continueRequested,
      attachments,
      batch.switchTo,
    ).then(batch.settle, batch.settle);
  }

  /**
   * 丢掉该用户尚未入队的那一批,返回丢了多少条。
   * 供 /取消 使用:窗口期内的消息还没变成回合,"取消"理应也包括它们。
   */
  private dropPending(userKey: string): number {
    const batch = this.pending.get(userKey);
    if (!batch) return 0;
    this.pending.delete(userKey);
    clearTimeout(batch.timer);
    batch.settle();
    return batch.texts.length + batch.attachments.length;
  }

  /** 把某用户的处理追加到其串行链尾。 */
  private enqueue(
    userKey: string,
    text: string,
    continueRequested = false,
    attachments: readonly Attachment[] = [],
    switchTo?: string,
  ): Promise<void> {
    const prev = this.queues.get(userKey) ?? Promise.resolve();
    const next = prev
      .catch(() => {}) // 前一条失败不阻塞后续
      .then(() => this.handle(userKey, text, continueRequested, attachments, switchTo));
    this.queues.set(userKey, next);
    return next;
  }

  /**
   * 两条路径(硬指令 / 正常回合)共用的前置:准入 → 工作目录 → 首次指引。
   * 返回 null 表示准入拒绝,调用方应当直接返回。
   *
   * 硬指令也走准入 —— 否则未获准的人能用 /状态 探测系统。
   */
  private async prelude(userKey: string): Promise<Prelude | null> {
    const verdict = this.admission(userKey);
    if (!verdict.ok) {
      console.warn(`[gateway] 拒绝来信:${verdict.reason}`);
      if (verdict.reply) await this.trySend(userKey, verdict.reply, "准入拒绝说明");
      return null;
    }

    const cwd = this.users.ensureWorkspace(userKey);
    let justGreeted = false;
    if (this.users.needsGreeting(userKey)) {
      const allowlist = this.settings.effective().modelAllowlist;
      // 发送成功才标记 —— 失败留给下次重试,指引值得重试。
      if (await this.trySend(userKey, greetingText(allowlist), "首次使用指引")) {
        this.users.markGreeted(userKey);
        justGreeted = true;
      }
    }
    return { cwd, justGreeted };
  }

  /** 执行一条 immediate 硬指令。与在飞回合并发,只做幂等操作。 */
  private async runCommand(userKey: string, cmd: CommandDef): Promise<void> {
    const pre = await this.prelude(userKey);
    if (!pre) return;

    switch (cmd.name) {
      case "help":
        // 刚推过 greeting 的话内容一模一样,不重复刷屏。
        if (!pre.justGreeted) {
          await this.trySend(userKey, helpText(this.settings.effective().modelAllowlist), "帮助");
        }
        return;

      case "status":
        await this.trySend(userKey, this.statusText(userKey), "状态");
        return;

      case "newSession": {
        const prev = this.sessions.archiveCurrent(userKey);
        // 在飞回合结束时会 record() 把 sessionId 写回来,等于抵消了上面的归档。
        // 所以同时给它打标记,让它在自己的 finally 里再归档一次。
        const inFlight = this.turns.currentFor(userKey);
        if (inFlight) inFlight.resetSession = true;
        const lines = [
          inFlight
            ? "好,当前这一轮跑完就从新对话开始。"
            : "好,下次从新对话开始,之前的上下文不带了。",
        ];
        // 归档不等于删除 —— 教用户怎么切回来,这是他知道这件事的三个入口之一
        // (另两个:超时提醒、/切换会话 的确认语)。
        if (prev) {
          lines.push(
            `想回到刚才的对话,发「${canonicalOf("switchSession")} ${shortSessionId(prev.sessionId)}」。`,
          );
        } else if (inFlight) {
          // 在飞回合还没 record 过(它就是第一轮),id 要等它跑完才有。
          lines.push(`跑完的这段之后可以用 ${canonicalOf("switchSession")} 找回。`);
        }
        await this.trySend(userKey, lines.join("\n"), "新会话确认");
        return;
      }

      case "cancel": {
        // 还在聚合窗口里的消息也算"正在处理" —— 用户看不见队列,他要取消的是
        // 刚发出去的那几条,不管它们变没变成回合。
        const dropped = this.dropPending(userKey);
        const inFlight = this.turns.currentFor(userKey);
        if (!inFlight) {
          await this.trySend(
            userKey,
            dropped ? "好,刚发的还没开始处理,已经丢掉了。" : "现在没有正在跑的任务。",
            "取消确认",
          );
          return;
        }
        inFlight.abort.abort();
        // 不在这里回话:被中断的回合自己会走错误分支给用户一个交代。
        return;
      }

      default:
        return;
    }
  }

  /** /状态 的正文。纯后台生成,不花订阅额度 —— 配置错乱时唯一可靠的信息源。 */
  private statusText(userKey: string): string {
    const p = this.prefs.effective(userKey);
    const overrides = this.prefs.get(userKey);
    const current = this.sessions.currentOf(userKey);
    const idle = this.sessions.idleMsOf(userKey);
    const historyCount = this.sessions.historyOf(userKey).length;
    const own = (k: keyof typeof overrides) => (overrides[k] === undefined ? "" : "(你设的)");

    const lines = [
      "📋 当前状态",
      `模型:${p.model ?? "由 SDK 决定"}${own("model")}`,
      current === undefined || idle === undefined
        ? "会话:还没有进行中的对话,下一条消息开新的"
        : `会话:${shortSessionId(current.sessionId)},${humanDuration(idle)}前活动过,下一条消息${
            idle < p.sessionTimeoutMs ? "接着聊" : `开新对话(想续上就发 ${canonicalOf("continue")})`
          }`,
      ...(historyCount
        ? [`旧对话:${historyCount} 段(发 ${canonicalOf("switchSession")} 可列出并切换)`]
        : []),
      `回执:${p.ackEnabled ? "开" : "关"}${own("ackEnabled")}  ` +
        `进度:${p.progressEnabled ? "开" : "关"}${own("progressEnabled")}`,
      `分段:${p.maxReplyChars} 字${own("maxReplyChars")}  ` +
        `超时:${humanDuration(p.sessionTimeoutMs)}${own("sessionTimeoutMs")}`,
      `身份:${userKey}${this.settings.isAdmin(userKey) ? "(管理员)" : ""}`,
    ];
    return lines.join("\n");
  }

  /**
   * 消化这批消息里的 /切换会话。返回这批剩下的内容(若有)要不要继续起回合:
   * 切换成功/目标就是当前会话 → 继续,decide() 自然 resume 切到的会话;
   * 没找到/有歧义 → 不继续 —— 那些话是冲着目标会话说的,落在错的会话里
   * 既答非所问又白花额度,宁可让用户确认 id 后重发。
   */
  private async handleSwitch(
    userKey: string,
    idPrefix: string,
    hasPayload: boolean,
  ): Promise<boolean> {
    // 只发指令本身:列出最近的会话。这就是"会话 id 从哪里来"的兜底入口。
    if (!idPrefix) {
      await this.trySend(userKey, this.sessionListText(userKey), "会话列表");
      return hasPayload;
    }

    const sw = canonicalOf("switchSession");
    const res = this.sessions.switchTo(userKey, idPrefix, (ref) =>
      this.sessionExists ? this.sessionExists(userKey, ref.sessionId) : true,
    );
    switch (res.kind) {
      case "switched": {
        const topic = res.to.hint ? `(${res.to.hint})` : "";
        const lines = [`好,切到对话 ${shortSessionId(res.to.sessionId)}${topic},直接发消息就是接着它聊。`];
        if (res.from) {
          lines.push(`刚才的对话想切回来就发「${sw} ${shortSessionId(res.from.sessionId)}」。`);
        }
        await this.trySend(userKey, lines.join("\n"), "切换确认");
        return true;
      }
      case "already-current":
        await this.trySend(
          userKey,
          `现在就在对话 ${shortSessionId(res.current.sessionId)} 里,直接发消息即可。`,
          "切换确认",
        );
        return true;
      case "ambiguous": {
        const lines = [
          `id 以「${idPrefix}」开头的对话有 ${res.matches.length} 段,再多给几位:`,
          ...res.matches.map((m) => this.describeRef(m)),
        ];
        if (hasPayload) lines.push("这批消息先不处理,切换成功后再发一次。");
        await this.trySend(userKey, lines.join("\n"), "切换歧义说明");
        return false;
      }
      case "not-found": {
        const lines = [
          `没找到 id 以「${idPrefix}」开头的对话(可能已过保留期被清理)。`,
          this.sessionListText(userKey),
        ];
        if (hasPayload) lines.push("这批消息先不处理,切换成功后再发一次。");
        await this.trySend(userKey, lines.join("\n"), "切换失败说明");
        return false;
      }
      case "gone": {
        const ids = res.refs.map((r) => shortSessionId(r.sessionId)).join("、");
        const lines = [
          `对话 ${ids} 的记录已被自动清理(超过保留期),切不回去了,清单里也不再列它。`,
          this.sessionListText(userKey),
        ];
        if (hasPayload) lines.push("这批消息先不处理,换个目标后再发一次。");
        await this.trySend(userKey, lines.join("\n"), "切换失败说明");
        return false;
      }
    }
  }

  /** 最近会话清单。当前在最上面,之后按离开时间新→旧。 */
  private sessionListText(userKey: string): string {
    // 先把记录已不在磁盘上的条目出清 —— 列出一段切不过去的会话,等于把用户
    // 引向一次必然失败的切换。保留期清理会同步 dropSessionIds,这里兜的是
    // 清理周期之间、以及记录被外部删除的空档。
    if (this.sessionExists) {
      const dead = this.sessions
        .historyOf(userKey)
        .filter((h) => !this.sessionExists!(userKey, h.sessionId))
        .map((h) => h.sessionId);
      if (dead.length) this.sessions.dropSessionIds(dead);
    }
    const current = this.sessions.currentOf(userKey);
    const history = this.sessions.historyOf(userKey);
    if (!current && !history.length) {
      return "还没有任何对话记录,直接发消息就会开始新的一段。";
    }
    return [
      "🗂 最近的对话:",
      ...(current ? [`${this.describeRef(current)}(当前)`] : []),
      ...history.map((h) => this.describeRef(h)),
      `发「${canonicalOf("switchSession")} <会话id>」切换,id 给开头几位就行。`,
    ].join("\n");
  }

  /** 列表里的一行:短 id + 最近活动 + 主题提示。 */
  private describeRef(ref: SessionRef): string {
    const topic = ref.hint ? ` · ${ref.hint}` : "";
    return `${shortSessionId(ref.sessionId)} — ${humanDuration(this.now() - ref.lastActive)}前${topic}`;
  }

  private async handle(
    userKey: string,
    text: string,
    continueRequested: boolean,
    attachments: readonly Attachment[] = [],
    switchTo?: string,
  ): Promise<void> {
    const pre = await this.prelude(userKey);
    if (!pre) return;

    // /切换会话:先把切换消化掉,再决定这批剩下的内容要不要起回合。
    // 排在队列尾天然保证切换发生在在飞回合 record() 之后,不会被写回覆盖。
    if (switchTo !== undefined) {
      const proceed = await this.handleSwitch(userKey, switchTo, Boolean(text) || attachments.length > 0);
      if (!proceed) return;
    }

    // 纯 /继续(这批里没攒进任何要处理的内容):后台直接消化,不进 LLM。
    // 它的全部使命是刷新会话时钟 —— 之后的消息在 decide() 里自然命中
    // 「未超时 → resume」。排在队列尾天然保证刷新发生在在飞回合 record()
    // 之后,续上的必定是最新那个会话。
    if (continueRequested && !text && !attachments.length) {
      await this.trySend(
        userKey,
        this.sessions.touch(userKey)
          ? "好,接上刚才的对话了,直接发消息继续聊。"
          : "现在没有可继续的对话,直接发消息就会开新的。",
        "继续确认",
      );
      return;
    }

    const prefs = this.prefs.effective(userKey);
    const decision = this.sessions.decide(userKey, { continueRequested });
    // 回执在排队之前发:并发受限时用户可能要等一会儿,先让他知道消息收到了。
    const ackId = prefs.ackEnabled ? await this.trySendAck(userKey) : undefined;

    // 进度消息串行链:保证按事件产生顺序逐条发送,最终回复排在链尾之后。
    // 节流从**回合开始**起算,而不是从第一个事件 —— 用户等待的是前者。
    const throttle = new ProgressThrottle(this.now());
    let progress: Promise<void> = Promise.resolve();
    const onProgress = prefs.progressEnabled
      ? (ev: AgentProgressEvent) => {
          // 节流判定在事件到达时就做完,不放进串行链:链上排队的时长会把
          // "这个事件是什么时候发生的"整个搞乱,节流间隔也就不准了。
          const text = throttle.offer(this.now(), ev);
          if (text === undefined) return;
          progress = progress.then(async () => {
            await this.trySend(userKey, text, "进度");
          });
        }
      : undefined;

    const isAdmin = this.settings.isAdmin(userKey);
    const hint = sessionHint(text, attachments.length > 0);
    const turn = this.turns.mint(userKey);
    const release = await this.semaphore.acquire();
    try {
      const reply = await this.agent.run(text, {
        cwd: pre.cwd,
        resumeSessionId: decision.isNew ? undefined : decision.resumeSessionId,
        ...(prefs.model ? { model: prefs.model } : {}),
        env: this.childEnv(isAdmin, turn.token),
        skills: [...(isAdmin ? ADMIN_SKILLS : USER_SKILLS)],
        abortController: turn.ctx.abort,
        ...(onProgress ? { onProgress } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
      this.sessions.record(userKey, reply.sessionId, hint);
      await progress;
      await this.sendChunked(userKey, reply.text, prefs.maxReplyChars);
    } catch (err) {
      console.error(`[gateway] 处理 ${userKey} 消息失败:`, err);
      await progress;
      await this.trySend(
        userKey,
        turn.ctx.abort.signal.aborted
          ? "已中断这一轮。"
          : `处理出错了:${(err as Error).message}`,
        "错误说明",
      );
    } finally {
      // reset 一律在这里做:try 里无条件 record(),finally 必在其后执行,
      // 所以成功、抛错、被 /取消 三条路径的净效果都对,顺序也一目了然。
      // 反过来在别处直接归档会被随后的 record() 写回来。
      if (turn.ctx.resetSession) this.sessions.archiveCurrent(userKey);
      turn.revoke();
      release();
      if (ackId !== undefined && this.channel.recall) {
        await this.channel.recall(userKey, ackId).catch(() => {
          // 撤回失败(渠道限制/消息过期)不影响回合结果,回执留在会话里即可。
        });
      }
    }
  }

  /**
   * agent 子进程的环境变量。
   *
   * SDK 的 env 会**整体替换**子进程环境(不是合并),所以必须展开 process.env ——
   * 而 process.env 里带着 CATMAN_ADMIN_TOKEN。规则:一律剔除,只有 admin 回合
   * 显式加回。这是管理员令牌下放到子进程的唯一出口。
   */
  private childEnv(isAdmin: boolean, sessionToken: string): Record<string, string | undefined> {
    const { CATMAN_ADMIN_TOKEN, ...rest } = process.env;
    return {
      ...rest,
      CATMAN_API_BASE: this.apiBase,
      CATMAN_SESSION_TOKEN: sessionToken,
      ...(isAdmin ? { CATMAN_ADMIN_TOKEN } : {}),
    };
  }

  /**
   * 发送回执并返回消息 id(仅当渠道支持撤回且返回了 id)。
   * 回执纯属体验增强,发送失败静默忽略。
   */
  private async trySendAck(userKey: string): Promise<string | undefined> {
    try {
      const id = await this.channel.send(userKey, ACK_TEXT);
      return typeof id === "string" ? id : undefined;
    } catch (err) {
      // 同 trySend:静默降级,但不静默消失。回执是一个回合里**第一条**外发消息,
      // 它成不成功是判断后续失败原因的起点。
      console.warn(`[gateway] 给 ${userKey} 发回执失败:${String(err)}`);
      return undefined;
    }
  }

  /** 到点提醒:尝试主动推送;推送失败(如渠道不支持)则静默降级。 */
  private async flushReminders(): Promise<void> {
    for (const userKey of this.sessions.dueReminders()) {
      // dueReminders 只返回有当前会话的用户;这里再判一次纯属防御。
      const current = this.sessions.currentOf(userKey);
      if (!current) continue;
      const ok = await this.trySend(
        userKey,
        reminderText(shortSessionId(current.sessionId)),
        "超时提醒",
      );
      if (!ok) {
        // 渠道无法主动推送:降级为下次用户发消息时由会话规则处理,无需额外动作。
        console.info(`[gateway] 用户 ${userKey} 超时提醒推送失败,降级为下次消息提示`);
      }
    }
  }

  private async sendChunked(userKey: string, text: string, maxChars: number): Promise<void> {
    for (let i = 0; i < text.length; i += maxChars) {
      await this.channel.send(userKey, text.slice(i, i + maxChars));
    }
  }

  /**
   * 发一条不该影响回合结果的消息。
   *
   * 吞掉异常是刻意的(进度推送失败不该把整个回合搞挂),但**吞掉不等于不记** ——
   * 排查发送问题时,看不见的失败比失败本身更难办:日志里只剩最后一步正文报错,
   * 会让人以为前面都成功了。`what` 用来分辨是哪一类发送坏掉的。
   */
  private async trySend(userKey: string, text: string, what = "消息"): Promise<boolean> {
    try {
      await this.channel.send(userKey, text);
      return true;
    } catch (err) {
      console.warn(`[gateway] 给 ${userKey} 发${what}失败:${String(err)}`);
      return false;
    }
  }
}
