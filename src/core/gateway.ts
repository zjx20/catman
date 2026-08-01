import type { Channel } from "../channels/types.js";
import type { Agent, AgentProgressEvent } from "./agent.js";
import type { SessionManager } from "./session.js";
import type { UserRegistry } from "./users.js";
import type { PrefsStore } from "./prefs.js";
import type { GlobalSettings } from "./settings.js";
import type { TurnTokens } from "./turn-tokens.js";
import { allowAll, type AdmissionPolicy } from "./admission.js";
import type { Attachment } from "./attachments.js";
import { canonicalOf, commandHelpLines, parseCommand, type CommandDef } from "./commands.js";
import { SETTING_SCHEMA, USER_SETTING_KEYS } from "./settings.js";
import { ADMIN_SKILLS, USER_SKILLS } from "./skills.js";

/** 超时提醒文案。指令写法从 COMMAND_TABLE 取,免得改了指令这句话变成假话。 */
export const REMINDER_TEXT =
  "这次对话已经安静了一会儿。再发消息我会默认开一段新对话来处理;" +
  `如果想接着刚才的话题聊,发 ${canonicalOf("continue")} 即可。`;

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
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
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

/** 把进度事件格式化成一条发给用户的短消息。 */
export function formatProgress(ev: AgentProgressEvent): string {
  if (ev.kind === "thinking") {
    return `💭 ${truncate(ev.text.trim(), PROGRESS_MAX_CHARS)}`;
  }
  const summary = truncate(summarizeToolInput(ev.input), PROGRESS_MAX_CHARS);
  return summary ? `🔧 ${ev.name}: ${summary}` : `🔧 ${ev.name}`;
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
    `上下文太长把我卡住了,发 ${canonicalOf("newSession")} 重新开始。`,
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
    const cmd = attachments.length ? undefined : parseCommand(text);
    // immediate 硬指令不进聚合窗口 —— 它们存在的全部理由就是"立刻",
    // 让救命的 /取消 先等 1.5 秒等于取消了这个理由。
    if (cmd?.immediate) return this.runCommand(userKey, cmd);

    const promptText = cmd?.promptText ?? text;
    const continueRequested = cmd?.name === "continue";
    const windowMs = this.settings.effective().messageAggregationMs;
    if (windowMs <= 0) {
      return this.enqueue(userKey, promptText, continueRequested, attachments);
    }
    return this.collect(userKey, promptText, continueRequested, attachments, windowMs);
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
    this.enqueue(userKey, batch.texts.join("\n"), batch.continueRequested, attachments).then(
      batch.settle,
      batch.settle,
    );
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
  ): Promise<void> {
    const prev = this.queues.get(userKey) ?? Promise.resolve();
    const next = prev
      .catch(() => {}) // 前一条失败不阻塞后续
      .then(() => this.handle(userKey, text, continueRequested, attachments));
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
      if (verdict.reply) await this.trySend(userKey, verdict.reply);
      return null;
    }

    const cwd = this.users.ensureWorkspace(userKey);
    let justGreeted = false;
    if (this.users.needsGreeting(userKey)) {
      const allowlist = this.settings.effective().modelAllowlist;
      // 发送成功才标记 —— 失败留给下次重试,指引值得重试。
      if (await this.trySend(userKey, greetingText(allowlist))) {
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
          await this.trySend(userKey, helpText(this.settings.effective().modelAllowlist));
        }
        return;

      case "status":
        await this.trySend(userKey, this.statusText(userKey));
        return;

      case "newSession": {
        this.sessions.forget(userKey);
        // 在飞回合结束时会 record() 把新 sessionId 写回来,等于抵消了上面的 forget。
        // 所以同时给它打标记,让它在自己的 finally 里再 forget 一次。
        const inFlight = this.turns.currentFor(userKey);
        if (inFlight) inFlight.resetSession = true;
        await this.trySend(
          userKey,
          inFlight
            ? "好,当前这一轮跑完就从新对话开始。"
            : "好,下次从新对话开始,之前的上下文不带了。",
        );
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
    const idle = this.sessions.idleMsOf(userKey);
    const own = (k: keyof typeof overrides) => (overrides[k] === undefined ? "" : "(你设的)");

    const lines = [
      "📋 当前状态",
      `模型:${p.model ?? "由 SDK 决定"}${own("model")}`,
      idle === undefined
        ? "会话:还没有记录,下一条消息开新对话"
        : `会话:${humanDuration(idle)}前活动过,下一条消息${
            idle < p.sessionTimeoutMs ? "接着聊" : `开新对话(想续上就发 ${canonicalOf("continue")})`
          }`,
      `回执:${p.ackEnabled ? "开" : "关"}${own("ackEnabled")}  ` +
        `进度:${p.progressEnabled ? "开" : "关"}${own("progressEnabled")}`,
      `分段:${p.maxReplyChars} 字${own("maxReplyChars")}  ` +
        `超时:${humanDuration(p.sessionTimeoutMs)}${own("sessionTimeoutMs")}`,
      `身份:${userKey}${this.settings.isAdmin(userKey) ? "(管理员)" : ""}`,
    ];
    return lines.join("\n");
  }

  private async handle(
    userKey: string,
    text: string,
    continueRequested: boolean,
    attachments: readonly Attachment[] = [],
  ): Promise<void> {
    const pre = await this.prelude(userKey);
    if (!pre) return;

    const prefs = this.prefs.effective(userKey);
    const decision = this.sessions.decide(userKey, { continueRequested });
    // 回执在排队之前发:并发受限时用户可能要等一会儿,先让他知道消息收到了。
    const ackId = prefs.ackEnabled ? await this.trySendAck(userKey) : undefined;

    // 进度消息串行链:保证按事件产生顺序逐条发送,最终回复排在链尾之后。
    let progress: Promise<void> = Promise.resolve();
    const onProgress = prefs.progressEnabled
      ? (ev: AgentProgressEvent) => {
          progress = progress.then(async () => {
            await this.trySend(userKey, formatProgress(ev));
          });
        }
      : undefined;

    const isAdmin = this.settings.isAdmin(userKey);
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
      this.sessions.record(userKey, reply.sessionId);
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
      );
    } finally {
      // reset 一律在这里做:try 里无条件 record(),finally 必在其后执行,
      // 所以成功、抛错、被 /取消 三条路径的净效果都对,顺序也一目了然。
      // 反过来在别处直接 forget() 会被随后的 record() 写回来。
      if (turn.ctx.resetSession) this.sessions.forget(userKey);
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
    } catch {
      return undefined;
    }
  }

  /** 到点提醒:尝试主动推送;推送失败(如渠道不支持)则静默降级。 */
  private async flushReminders(): Promise<void> {
    for (const userKey of this.sessions.dueReminders()) {
      const ok = await this.trySend(userKey, REMINDER_TEXT);
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

  private async trySend(userKey: string, text: string): Promise<boolean> {
    try {
      await this.channel.send(userKey, text);
      return true;
    } catch {
      return false;
    }
  }
}
