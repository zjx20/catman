import type { Accepted, Channel, IncomingMessage } from "../channels/types.js";
import type { Agent, AgentProgressEvent } from "./agent.js";
import type { Decision, SessionManager, SessionRef } from "./session.js";
import type { UserRegistry } from "./users.js";
import type { EffectiveUserPrefs, PrefsStore } from "./prefs.js";
import type { GlobalSettings } from "./settings.js";
import type { MintedTurn, TurnContext, TurnTokens } from "./turn-tokens.js";
import { allowAll, type AdmissionPolicy } from "./admission.js";
import { buildTurnEnv } from "./turn-env.js";
import { formatAt } from "./cron/schedule.js";
import type { CronJob, RunStatus } from "./cron/types.js";

/** 网关眼里的定时任务:只有"这个人有哪些任务"这一个问题。 */
export interface CronView {
  jobsOf(userKey: string): readonly CronJob[];
  readonly tz: string;
}

const JOB_STATUS_CN: Partial<Record<RunStatus, string>> = {
  ok: "成功",
  failed: "失败",
  timeout: "超时",
  skipped: "跳过",
  interrupted: "中断",
  error: "没起来",
  running: "还在跑",
};
import type { Attachment } from "./attachments.js";
import { describeProgress, summarizeToolInput } from "./agent-trace.js";
import {
  canonicalOf,
  commandHelpLines,
  parseCommand,
  type CommandDef,
  type ParsedCommand,
} from "./commands.js";
import { SETTING_SCHEMA, USER_SETTING_KEYS } from "./settings.js";
import { skillsFor } from "./skills.js";
import { readVersion, shortSha, versionLine, type VersionInfo } from "./version.js";
import type { DeployControl } from "./deploy.js";
import {
  abortNoticeText,
  circuitTripText,
  circuitTripped,
  priorAbortPrefix,
  readMemAbort,
  type MemAbortInfo,
} from "./mem-watchdog.js";
import { formatDeployReport } from "./deploy-report.js";
import { formatDeployProgress } from "./deploy-progress.js";
import type { SendKind } from "../ipc/protocol.js";
import type { Persona } from "../config.js";

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

/**
 * 追加输入被在飞回合接住时的回执。与 ACK_TEXT 分开说是因为处境不同:
 * 用户此刻看到的是一轮还没结束,他需要知道的是"这句补充赶上了没",
 * 而不是"收到了"。
 */
export const FEED_ACK_TEXT = "收到,一并交给正在处理的这一轮了。";

/**
 * SDK 以错误结束一个回合时,正文前面加的那句话。
 *
 * `AgentReply.isError` 为真时,`text` 装的是 SDK 的错误原文(鉴权失败、额度耗尽、
 * 达到轮数上限……)而不是模型的答复。不加标记的话它与一句正常回复长得一模一样 ——
 * 用户会把「Credit balance is too low」读成助手在跟他说话,而不是"这轮根本没跑成"。
 * 原文照发不翻译:它是去查订阅/配置的唯一线索。
 */
export const TURN_ERROR_PREFIX = "⚠️ 这一轮没能跑成,以下是 Claude 侧的报错原文:\n";

/** 进度消息里思考/工具参数摘要的截断长度。 */
const PROGRESS_MAX_CHARS = 200;

/**
 * 部署进展多久去看一眼。
 *
 * 这是个纯本地的动作(读两个小文件),15 秒的开销可以忽略;而它决定了用户在
 * "切换成功"那一刻要等多久才收到消息 —— 部署的整条链以分钟计,15 秒足够贴身。
 */
export const DEPLOY_NEWS_INTERVAL_MS = 15_000;

/**
 * 一条主动播报最多试几次、两次之间至少隔多久。
 *
 * ⚠️ **这个上限原来的理由已经不成立了,别照着它推理。** 从前它防的是"失败的尝试
 * 照样烧发送预算,15 秒一轮无限重试两分半就能把额度耗尽"。信使有了发件队列之后
 * (courier/outbox.ts),额度不够时那条播报是**排队**而不是失败 —— `trySend` 回 true,
 * 当场就标记已播,压根走不到重试这条路。
 *
 * 留着它是因为还有一种失败没被队列覆盖:**信使自己不可达**(IPC 断了、信封读不懂)。
 * 那种失败下 15 秒一轮无限重试只是对着一个死 socket 刷日志。所以上限还在,
 * 但它现在防的是刷屏,不是烧额度。
 *
 * 放弃的只是**主动**这条路:用户下次开口时仍然会补播,所以"放弃"从不等于"这条消息丢了"。
 */
const NEWS_MAX_ATTEMPTS = 3;
const NEWS_RETRY_MS = 60_000;

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
  /**
   * 推送令牌的发放处(core/notify-tokens.ts)。不配 = 回合里没有 `CATMAN_NOTIFY_TOKEN`,
   * `catman-notify` 会明说"这不像是 catman 的回合环境"而不是安静地推不出去。
   */
  notifyTokens?: { for(userKey: string): string };
  /** 挂进回合 PATH 的目录(`catman-notify` 住在那儿)。 */
  binDir?: string;
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
  /** 版本戳。不传则运行时自己读(单测注入,免得依赖磁盘上有没有 VERSION)。 */
  version?: VersionInfo;
  /**
   * 本进程是哪个人格。目前只决定 admin 回合能看到哪套 skill ——
   * 守护人格拿 `catman-rescue` 而不是 `catman-evolve`,理由见 skills.ts。
   * 不传按主人格,与 stdin / dashboard 这类本地场景一致。
   */
  persona?: Persona;
  /**
   * OAuth token 到期告警(core/token-alert.ts)。只发给管理员 —— 换发要人在宿主
   * 跑 setup-token,普通用户拿这条消息什么都做不了,只会吓一跳。
   * 不传 = 这台机器不做此项播报(stdin 调试就不必)。
   */
  tokenAlert?: { pending(): string | undefined; markAnnounced(): void };
  /**
   * 部署控制面。不传 = 这台机器没配自进化,两条部署指令会明说"没配",
   * 而不是假装成功 —— 本地开发与 stdin 调试就是这种情况。
   */
  deploy?: DeployControl;
  /**
   * 定时任务的只读视图,给 `/任务` 用。**只读** —— 网关不参与调度,
   * 它唯一要做的是在用户问起时答得出来(而且是在 immediate 路径上答)。
   */
  cron?: CronView;
  /**
   * 部署进展主动播报的轮询间隔(ms)。不传用 `DEPLOY_NEWS_INTERVAL_MS`。
   * 单测传一个大到不会自己触发的值,然后手工调 `flushDeployNews()`。
   */
  deployNewsIntervalMs?: number;
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

/**
 * 把进度事件格式化成一条发给用户的短消息。
 * `skipped` 是本条之前被节流掉的事件数,标出来是为了让"卡在一件事上"与
 * "一直在快速推进"看起来不一样 —— 否则用户只看到间隔变长,分不清是哪种。
 */
export function formatProgress(ev: AgentProgressEvent, skipped = 0): string {
  const body =
    ev.kind === "thinking"
      ? `💭 ${truncate(ev.text.trim(), PROGRESS_MAX_CHARS)}`
      : ev.kind === "text"
        ? `💬 ${truncate(ev.text.trim(), PROGRESS_MAX_CHARS)}`
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
 * **发送预算这件事整个不在核心里。**
 *
 * 演进的三步值得记着,因为每一步都是踩了坑才走的:
 * ① 网关自己记一份账(`SEND_BUDGET − 回执 − 预留`)。信使上线后预算的权威搬了过去,
 *    而旧的那份没删 —— 两份账各算各的(7 对 6),每个长回合都多发一条注定被拒的进度,
 *    而「进度就报到这儿」那句提示永远不触发。
 * ② 改成**每次现问渠道**(`Channel.progressBudget`)。单一权威有了,但核心仍然要懂
 *    "还剩几条"这个概念,而它压根不该懂 —— stdin / dashboard 上这个方法只能返回
 *    `undefined`,一个渠道无关的类型里挂着一个只有微信才有意义的问题。
 * ③ 现在:核心**只管把消息交出去**。发得出去渠道就发,发不出去渠道排队
 *    (`courier/outbox.ts`),额度到头时由**渠道**告诉用户"发 /nop 可以续上"。
 *    核心这边只剩下面这个间隔阶梯,而它管的是**观感**(多久说一次话),不是额度。
 */

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
 *
 * **它不再管总条数。** 阶梯管的是观感,额度是渠道那一侧的事:发不出去的进度由
 * 信使排队(而且只留最新一条),额度到头时也由信使去说那句"发 /nop 可以续上"。
 * 上面那段记着这条边界是怎么划出来的。
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
  ) {
    this.nextAllowedAt = startedAt + (intervals[0] ?? 0);
  }

  /**
   * 交一个事件进来。到点则返回该发的文本,没到点返回 undefined(该事件被丢弃)。
   * 时刻在**决定放行时**推进而不是发送完成后 —— 否则一次慢发送期间会漏过好几条。
   */
  offer(now: number, ev: AgentProgressEvent): string | undefined {
    if (now < this.nextAllowedAt) {
      this.skipped += 1;
      return undefined;
    }
    const text = formatProgress(ev, this.skipped);
    this.skipped = 0;
    this.sent += 1;
    // 第 n 条发完之后用第 n 档间隔;超出阶梯长度就一直用最后一档。
    this.nextAllowedAt = now + (this.intervals[Math.min(this.sent, this.intervals.length - 1)] ?? 0);
    return text;
  }

  /**
   * 追加输入(或 `/nop`)之后重新开闸 —— 阶梯从头开始。
   *
   * 用户刚开口,正是最想知道"接住了没"的时刻;不重置的话,被追加过的长回合后半段
   * 要等满 60 秒才有下一条,与卡死无从分辨。阶梯一并重来所以不会变成刷屏:
   * 下一条仍要等满第一档。
   *
   * 顺带一提,那一刻**额度也确实回来了**(新来信换新 `context_token`),
   * 但那是渠道那边的事,这里不需要知道。
   */
  reset(now: number): void {
    this.sent = 0;
    this.skipped = 0;
    this.nextAllowedAt = now + (this.intervals[0] ?? 0);
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
 *
 * ## 正文是 markdown,而且列表前后的空行不能省
 *
 * 这份文案的读者是聊天客户端的 markdown 渲染器。**列表块前面必须空一行** ——
 * 紧贴着上一段写的话,渲染器会把整个清单并进那一段,十几条指令连成一大坨,
 * 看不出哪里是一条的开头。这正是它以前的样子(缩进两格靠肉眼分行,渲染完全糊掉)。
 *
 * 同理,靠行尾断句、指望渲染器保留换行的写法一律不要:markdown 会把连续的行
 * 合成一段。要分行就分段,要并列就用列表。
 */
export function helpText(modelAllowlist: string[], isAdmin = false): string {
  const cmds = commandHelpLines(isAdmin)
    .map((l) => `- ${l}`)
    .join("\n");
  const settings = USER_SETTING_KEYS.map((key) => {
    const def = SETTING_SCHEMA[key];
    return `- **${def.label}** — ${def.hint({ modelAllowlist })}`;
  }).join("\n");
  return [
    "跟我说话就行,平常怎么聊都可以。",
    "",
    "**硬指令** —— 不经过大脑、后台直接答,所以我卡住的时候它们照样管用。" +
      "必须以 `/` 开头,而且整条消息只有指令本身:",
    "",
    cmds,
    "",
    "**你的设置** —— 直接跟我说「换成 sonnet」「别刷进度了」「超时改成一天」,我就去改:",
    "",
    settings,
    "",
    "**几种常见情况**:",
    "",
    `- 想接着聊被超时中断的话题 → \`${canonicalOf("continue")}\``,
    `- 上下文太长把我卡住了 → \`${canonicalOf("newSession")}\` 重新开始`,
    `- 想切回之前的某段对话 → \`${canonicalOf("switchSession")} <会话id>\`` +
      "(只发指令则列出最近的对话)",
  ].join("\n");
}

/** 首次使用时推送的欢迎语。正文就是那份指引,不另写一份免得两处走样。 */
export function greetingText(modelAllowlist: string[], isAdmin = false): string {
  return `你好,我是 catman。\n\n${helpText(modelAllowlist, isAdmin)}`;
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
 * 一个回合最多接住几次追加输入。
 *
 * 与 AGGREGATION_MAX_MULTIPLIER 同一个性质,连"定得很松"的理由都一样:
 * **想补多少补多少本身就是对的**。用户还在补话说明他还没说完,这时候拒绝追加、
 * 把消息打回队列,等于在他说话中间切断他 —— 而拖长的只是他自己这一轮,
 * 碍不着任何别人(图片另有 maxImagesPerTurn 管着内存,文本几乎没有成本)。
 *
 * 所以这个数**不是**给用户的配额,只是"回合总得有个不再增长的时刻"的兜底,
 * 防的是失控循环往里灌消息。正常聊天永远碰不到 —— 真碰到了,
 * 用尽之后的消息回落到队列等下一轮(不丢,只是要等),并且会记一行日志。
 */
export const MAX_FEEDS_PER_TURN = 100;

/**
 * 一批消息按到达顺序切成的段。
 *
 * **顺序是这个类型存在的全部理由**:硬指令把一批切开,指令**之前**的话投递给
 * 切换前的会话,**之后**的话投递给切换后的会话。压平成「一段文本 + 几个标记」
 * 就丢掉了这个信息,只能靠"整批不处理"之类的粗糙语义兜底。
 */
type Segment =
  | { kind: "input"; text: string; attachments: Attachment[] }
  | { kind: "command"; cmd: CommandDef; arg: string };

/**
 * 一批正在等待聚合的消息。
 *
 * 存在的理由:微信发「图 + 文字」**不是一条消息** —— 实测两条相隔约 120ms
 * (图片先到、文本后到,或反过来)。不攒一下的话会起两个回合,而且先到的那条
 * 必然缺另一半,于是助手先答一句"我没看到图"再答一遍,既费额度又显得莫名其妙。
 */
interface PendingBatch {
  /** 按到达顺序;连续的文本与图片并进同一个 input 段,指令另起一段。 */
  segments: Segment[];
  /** debounce 计时器:每来一条消息就重置。 */
  timer: NodeJS.Timeout;
  /** 第一条消息的到达时刻,用于算硬上限。 */
  firstAt: number;
  /** 本批处理完成时兑现;同一批的每个 dispatch 都拿到它。 */
  done: Promise<void>;
  settle: () => void;
}

/** 这批里一共攒了多少条文本与图片 —— /取消 用它交代丢掉了多少。 */
function batchSize(segments: readonly Segment[]): number {
  let n = 0;
  for (const s of segments) {
    if (s.kind === "command") n += 1;
    else n += (s.text ? 1 : 0) + s.attachments.length;
  }
  return n;
}

/** 这批攒到的图片总数,用于合并后重新收一次上限。 */
function batchImages(segments: readonly Segment[]): number {
  let n = 0;
  for (const s of segments) if (s.kind === "input") n += s.attachments.length;
  return n;
}

/**
 * 网关向 `/health` 交出的那份计数。字段只增不改 —— 部署的排水门读它,
 * 而读它的那份代码(deployer / 将来的看门狗)是人工钦定的、比正在跑的版本旧得多。
 */
export interface GatewayHealth {
  /** 在飞回合:前台是用户正等着的,后台是被切走仍在跑的。 */
  readonly inFlight: { foreground: number; background: number };
  /** 已受理、分拣链上还没走完的批数。 */
  readonly queued: number;
  /** 还在聚合窗口里攒着的批数。 */
  readonly aggregating: number;
  /** 最近一个跑完的回合(观测用,不参与判死)。 */
  readonly lastTurn?: { at: number; isError: boolean };
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
  /**
   * 上一回合被内存看门狗中止的用户 → 中止详情。
   *
   * **刻意不落盘**:落盘要动 state.json 的格式,而部署随时可能回滚 ——
   * 新代码必须能读旧数据、旧代码也得能读新代码写的。为一句前情提示付这个代价
   * 不划算。catman 重启后这条信息就没了,但 persona 里那段 137 预教仍然在,
   * 大脑不至于完全没线索。
   */
  private readonly lastMemAbort = new Map<string, MemAbortInfo>();
  /**
   * 同一会话**连续**被内存中止了几次。成功一次就清零 —— 断路器数的是连续,
   * 不是累计;累计的话跑久了迟早误跳,而那时用户什么错都没犯。
   */
  private readonly memAbortStreak = new Map<string, number>();
  private readonly admission: AdmissionPolicy;
  private readonly sessionExists: ((userKey: string, sessionId: string) => boolean) | undefined;
  private readonly now: () => number;
  private readonly reminderIntervalMs: number;
  private readonly deployNewsIntervalMs: number;
  private readonly semaphore: Semaphore;

  private reminderTimer?: NodeJS.Timeout;
  private deployNewsTimer?: NodeJS.Timeout;
  /**
   * 主动播报的串行链。定时器与用户开口这两条路径都会去播同一批消息 ——
   * 不串起来的话它们会同时读到"还没播过"然后各发一遍,用户收到两条一模一样的。
   */
  private newsChain: Promise<void> = Promise.resolve();
  /** 每条播报的主动重试记账(只在内存里:重启后重来一遍是对的,进程换了上下文也换了)。 */
  private readonly newsAttempts = new Map<string, { n: number; last: number }>();
  /** 每用户一条处理链,保证串行。 */
  private readonly queues = new Map<string, Promise<void>>();
  /** 每用户至多一批待聚合的消息。 */
  private readonly pending = new Map<string, PendingBatch>();
  /**
   * 已受理、分拣尚未走完的批数。
   *
   * 部署前的排水靠它:消息一旦离开聚合窗口进了分拣链,就不再是"待聚合",
   * 但也还没变成回合 —— 这段空档里切换容器,那批话就静默消失了。
   * 三个计数(aggregating / queued / inFlight)必须一起归零才算真排干。
   */
  private queued = 0;
  /**
   * 最近一个跑完的回合。**只作观测,不参与任何判死** —— 部署的健康门只看
   * 本地可判定的事实(进程起没起、渠道通不通),把大脑状态放进门里会让一次
   * 上游限流废掉一个完好的版本。真正的大脑探测在 SELFCHECK 里,由 deployer
   * 在切换**之前**亲自跑。
   */
  private lastTurn?: { at: number; isError: boolean };
  /**
   * 这份 release 的版本戳。启动时读一次就够 —— 它随部署的 release 走,
   * 一个进程的生命周期内不会变(变了说明有人在动现役目录,那是 §6 只读挂载要拦的事)。
   */
  private readonly version: VersionInfo | undefined;
  private readonly persona: Persona;
  private readonly tokenAlert: GatewayOptions["tokenAlert"];
  /**
   * 信使说过"这些人早就收过使用指引了"的那些 userKey。
   *
   * 判定权在信使:它是唯一见过某个 userKey **全部**历史的进程,而人格有好几个、
   * 各有各的 users.json。真机上的症状是首次 `/救援` 会收到守护人格那份一模一样的
   * 整份欢迎语 —— 白烧一条发送预算(一个 context_token 只够发约 10 条),
   * 而且看起来像"它把我当新人了"。
   *
   * 攒在这里而不是一路穿过 Segment/PendingBatch:标记是**单调**的(收过就永远收过),
   * 与消息内容无关,也就不必跟着某一段话走。消费点在 prelude —— 必须等
   * `ensureWorkspace()` 把用户注册进来之后才 mark 得动。
   */
  private readonly courierGreeted = new Set<string>();
  private readonly deploy: DeployControl | undefined;
  private readonly cron: CronView | undefined;
  private readonly notifyTokens: { for(userKey: string): string } | undefined;
  private readonly binDir: string | undefined;

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
    this.deployNewsIntervalMs = opts.deployNewsIntervalMs ?? DEPLOY_NEWS_INTERVAL_MS;
    this.version = opts.version ?? readVersion();
    this.persona = opts.persona ?? "primary";
    this.tokenAlert = opts.tokenAlert;
    this.deploy = opts.deploy;
    this.cron = opts.cron;
    this.notifyTokens = opts.notifyTokens;
    this.binDir = opts.binDir;
    this.semaphore = new Semaphore(this.settings.effective().maxConcurrentTurns);
    this.settings.onChange(() => {
      this.semaphore.setLimit(this.settings.effective().maxConcurrentTurns);
    });
  }

  async start(): Promise<void> {
    this.channel.onMessage((msg) => this.onIncoming(msg));
    this.reminderTimer = setInterval(() => this.flushReminders(), this.reminderIntervalMs);
    // 允许进程在只剩此定时器时退出(容器里无所谓,测试友好)。
    this.reminderTimer.unref?.();
    // 部署进展主动播报。**没有部署控制面就不起这个定时器** —— 守护人格与本地开发
    // 压根没有可播的东西,起一个空转的轮询只会让日志和心智负担变复杂。
    if (this.deploy) {
      this.deployNewsTimer = setInterval(() => {
        void this.flushDeployNews();
      }, this.deployNewsIntervalMs);
      this.deployNewsTimer.unref?.();
    }
    await this.channel.start();
    // 起来就先看一眼:上一次部署的结果正是在**这个进程启动之前**写下的,
    // 等一个轮询周期没有任何理由。**放在 channel.start() 之后** —— 渠道还没起来时
    // 发送要么抛要么石沉大海,而这一条恰恰是最不该丢的。
    if (this.deploy) void this.flushDeployNews();
  }

  async stop(): Promise<void> {
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    if (this.deployNewsTimer) clearInterval(this.deployNewsTimer);
    // 攒着的消息立刻入队,不等窗口走完:消息已经从渠道收下了(长轮询游标也推进了),
    // 丢掉就是真丢。能不能跑完交给关闭流程,总好过在这里静默吞掉。
    for (const userKey of [...this.pending.keys()]) this.flush(userKey);
    await this.channel.stop();
  }

  /**
   * 渠道消息的**唯一**入口。
   *
   * 独立成一个方法而不是写在 `start()` 的闭包里:接线不止"把字段拆开传给 dispatch"
   * 这一件事,而单测为了不起真实渠道,曾经自己抄了一份等价的接线 ——
   * 于是这里每加一件事,那份抄件就悄悄少一件,**测的是一条生产里不存在的路径**。
   * 收成一个方法之后两边共用同一份,想岔都岔不了。
   */
  onIncoming(msg: IncomingMessage): Accepted {
    // 渠道知道他早收过指引就记一笔。只**抑制**不触发:缺席表示这个渠道没有这项知识
    // (stdin / dashboard),那时退回人格自己的记录判断。见 courierGreeted 的说明。
    if (msg.greeted) this.courierGreeted.add(msg.userKey);
    const settled = this.dispatch(msg.userKey, msg.text, msg.attachments ?? []);
    // 交出去的 promise 绝不能 reject:等它的是渠道的延后 ack,那条路不该被
    // 一次回合失败拽进重试分支。回合内部的异常本来就已经收敛成给用户的回复了。
    return {
      settled: settled.catch((err) => {
        console.error(`[gateway] ${msg.userKey} 这批消息处理时意外抛错:`, err);
      }),
    };
  }

  /**
   * 消息入口分流。
   *
   * immediate 硬指令**不入队**,就地执行 —— 这是它们存在的理由:agent 卡死时
   * 队列里的消息永远轮不到,包括本该救命的那条。代价是它们与在飞回合并发,
   * 所以只做幂等的只读/打标记操作。
   *
   * ⚠️ **这条路径上的方法一个都不能是 `async`**(dispatch / collect / enqueue)。
   * "收下"必须在渠道调用 `onIncoming` 的那一瞬间就完成 —— 顺序靠的正是它:
   * 渠道按 FIFO 逐条调用,消息落进聚合批的先后就是到达的先后。中间只要插进
   * 一个 await,渠道就得排队等,而这里恰恰是曾经把中途插话与消息聚合一起
   * 废掉的地方(见 channels/types.ts 的 `Accepted`)。
   */
  private dispatch(
    userKey: string,
    text: string,
    attachments: readonly Attachment[] = [],
  ): Promise<void> {
    // 带图的消息不当硬指令解析:硬指令要求整条消息只有指令本身,而「/状态 + 一张图」
    // 显然不是那个意思。让它照常走 LLM,免得图片被指令分支静默吞掉。
    const parsed = attachments.length ? undefined : this.parseAllowed(userKey, text);
    // immediate 硬指令不进聚合窗口 —— 它们存在的全部理由就是"立刻",
    // 让救命的 /取消 先等 1.5 秒等于取消了这个理由。
    if (parsed?.cmd.immediate) return this.runCommand(userKey, parsed.cmd);

    // 到这里只可能是 /继续 /新会话 /切换会话:它们改会话状态,必须与消息投递
    // 保持先后,所以和普通文本一样进聚合窗口、再由分拣节点按到达顺序线性处理。
    const seg: Segment = parsed
      ? { kind: "command", cmd: parsed.cmd, arg: parsed.arg }
      : { kind: "input", text, attachments: [...attachments] };
    const windowMs = this.settings.effective().messageAggregationMs;
    if (windowMs <= 0) return this.enqueue(userKey, [seg]);
    return this.collect(userKey, seg, windowMs);
  }

  /**
   * 把这一段并进该用户待聚合的那一批,并把计时器往后推。
   *
   * debounce 而不是固定窗口:连发的几条要一起处理,固定窗口会把跨过窗口边界的
   * 那条切到下一批去。用户还在发就继续攒 —— 攒得越多越好,见
   * AGGREGATION_MAX_MULTIPLIER 那里对"为什么上限定得很松"的说明。
   *
   * 连续的文本与图片并进同一个 input 段(它们本就是一次表达被拆成的几条),
   * 指令则另起一段 —— 段边界就是"这批话该说给哪个会话听"的分界线。
   */
  private collect(userKey: string, seg: Segment, windowMs: number): Promise<void> {
    const now = Date.now();
    let batch = this.pending.get(userKey);
    if (!batch) {
      let settle!: () => void;
      const done = new Promise<void>((resolve) => (settle = resolve));
      batch = {
        segments: [],
        timer: undefined as unknown as NodeJS.Timeout,
        firstAt: now,
        done,
        settle,
      };
      this.pending.set(userKey, batch);
    }

    const tail = batch.segments[batch.segments.length - 1];
    if (seg.kind === "input" && tail?.kind === "input") {
      if (seg.text) tail.text = tail.text ? `${tail.text}\n${seg.text}` : seg.text;
      tail.attachments.push(...seg.attachments);
    } else {
      batch.segments.push(seg);
    }

    clearTimeout(batch.timer);
    const deadline = batch.firstAt + windowMs * AGGREGATION_MAX_MULTIPLIER;
    const wait = Math.max(0, Math.min(windowMs, deadline - now));
    // **这个定时器不 unref**,与超时提醒(reminderTimer)和心跳刻意不同。
    // 分界线是「它手里有没有欠用户的东西」:提醒与心跳只是定期看一眼,晚一轮无所谓,
    // 不该拦着进程退出;而这个定时器攥着**已经从渠道收下、长轮询游标也推进了**的消息 ——
    // unref 等于宣告「只剩这批消息没处理时可以直接退出」,那批消息就真丢了。
    // 症状也很隐蔽:生产进程总有 dashboard 与长轮询占着事件循环,永远看不出来;
    // 只有在没有别的句柄时(测试进程、以及未来任何精简的宿主)才会暴露。
    batch.timer = setTimeout(() => this.flush(userKey), wait);
    return batch.done;
  }

  /** 把攒好的一批交给分拣节点。 */
  private flush(userKey: string): void {
    const batch = this.pending.get(userKey);
    if (!batch) return;
    this.pending.delete(userKey);
    clearTimeout(batch.timer);

    // 图片上限要在合并后重新收一次:渠道只保证单条消息不超,连发几条各带图仍可能超。
    // 按整批算(而不是每段),因为闸门管的是这一轮的内存峰值与图片 token 开销。
    const { maxImagesPerTurn } = this.settings.effective();
    const total = batchImages(batch.segments);
    if (total > maxImagesPerTurn) {
      let room = maxImagesPerTurn;
      for (const s of batch.segments) {
        if (s.kind !== "input") continue;
        s.attachments = s.attachments.slice(0, room);
        room -= s.attachments.length;
      }
      console.info(
        `[gateway] ${userKey} 聚合后有 ${total} 张图,` +
          `超出上限 ${maxImagesPerTurn},丢弃 ${total - maxImagesPerTurn} 张`,
      );
    }

    // handleBatch 内部已把异常都收敛成给用户的回复,这里只管兑现 promise。
    this.enqueue(userKey, batch.segments).then(batch.settle, batch.settle);
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
    return batchSize(batch.segments);
  }

  /**
   * 把一批交给该用户的分拣链尾。
   *
   * **分拣链与"这批处理完了"是两件事,故意分开**:
   *   · 链上只等分拣本身(投递完就算),所以卡死的回合堵不住后面那批里的指令 ——
   *     这是整条流水线的立足点;
   *   · 返回给渠道的 promise 额外等这批起的回合跑完,"处理完了"才名副其实 ——
   *     stdin 靠它决定何时打下一个提示符,iLink 靠它顺序处理带图的消息。
   */
  private enqueue(userKey: string, segments: readonly Segment[]): Promise<void> {
    const prev = this.queues.get(userKey) ?? Promise.resolve();
    // 计数在**入链前**加、分拣走完才减:排水要的正是"还有没有话卡在这段空档里"。
    this.queued += 1;
    const sorted = prev
      .catch(() => {}) // 前一批失败不阻塞后续
      .then(() => this.handleBatch(userKey, segments))
      .finally(() => {
        this.queued -= 1;
      });
    this.queues.set(
      userKey,
      sorted.then(
        () => {},
        () => {},
      ),
    );
    return sorted.then(async (turns) => {
      await Promise.all(turns);
    });
  }

  /**
   * 分拣节点:按到达顺序线性处理一批消息。每用户串行(靠 `queues`)。
   *
   * **它不等回合跑完** —— 起了回合就往下走。这是整条流水线的关键:
   *   · 卡死的 agent 堵不住分拣,所以改会话状态的指令能安全地在这里线性执行,
   *     不必绕队列、也不必给在飞回合打标记等它自己收尾;
   *   · 指令**之前**的话投递给切换前的会话,**之后**的话投递给切换后的会话 ——
   *     顺序天然正确,不需要"整批不处理"这类粗糙语义。
   *
   * 指令执行失败时(比如要切的那段会话找不到)中止**剩下的**段:那些话是冲着
   * 它本该切到的会话说的,落在当前会话里既答非所问又白花额度。已经投递出去的
   * 段不受影响 —— 它们本来就属于前一个会话。
   *
   * 返回这批起的回合,交给 enqueue 去等 —— 它自己**不等**。
   */
  private async handleBatch(
    userKey: string,
    segments: readonly Segment[],
  ): Promise<Array<Promise<void>>> {
    const pre = await this.prelude(userKey);
    if (!pre) return [];

    const turns: Array<Promise<void>> = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (seg.kind !== "command") {
        const started = this.deliverInput(userKey, seg, pre.cwd);
        if (started) turns.push(started);
        continue;
      }
      // 后面还有没有话要说 —— 决定指令要不要单独回执(有的话回执纯属噪音),
      // 也决定指令失败时要不要交代"这些话先不处理"。
      const more = segments
        .slice(i + 1)
        .some((s) => s.kind === "input" && (s.text !== "" || s.attachments.length > 0));
      if (!(await this.runQueuedCommand(userKey, seg.cmd, seg.arg, more))) return turns;
    }
    return turns;
  }

  /**
   * 把一段输入交给用户**当前**的会话:在飞的前台回合接得住就追加进去
   * (模型下一次请求就看到),否则起一个新回合。
   *
   * **同步返回,不等回合**。起回合的动作里 `turns.mint()` 是同步完成的,
   * 所以紧接着的下一段立刻就能看到这个前台回合、走追加而不是又起一轮。
   * 真起了回合就把它的 promise 交出去,由 enqueue 汇总成"这批处理完了"。
   */
  private deliverInput(
    userKey: string,
    seg: Segment & { kind: "input" },
    cwd: string,
  ): Promise<void> | undefined {
    // 既没文字也没图片:起回合等于给模型递一条空 content(它会直接拒收),额度还照花。
    // 渠道通常已经挡了空消息,这里防的是"图在渠道那边解码失败被跳过"剩下的空壳。
    if (!seg.text && !seg.attachments.length) return undefined;

    const fg = this.turns.foregroundFor(userKey);
    if (!fg) return this.startTurn(userKey, seg.text, seg.attachments, cwd);
    if (fg.feed?.(seg.text, seg.attachments)) return undefined;
    // 追不进去(额度用尽、图被挤光、或那一轮正在收摊),但它还占着当前会话 ——
    // **绝不能就地另起一轮**:两个回合 resume 同一个 sessionId 会把上下文撕坏。
    // 等它结束再来一次(那时前台可能已经换人,所以重走一遍判断而不是直接起)。
    return fg.done.then(async () => {
      await this.deliverInput(userKey, seg, cwd);
    });
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
    // 信使说他早收过了就补记一笔。**必须在 ensureWorkspace 之后** ——
    // markGreeted 对还没注册的用户是空操作,而首次 `/救援` 恰好就是"这个人格
    // 第一次见到他"。补记而不只是跳过:信使不在场的路径(dashboard 聊天)
    // 从此也不会再推,一次同步永久生效。
    if (this.courierGreeted.delete(userKey)) this.users.markGreeted(userKey);
    // 部署的进展先说 —— 用户此刻多半正要问"改好了没",而且失败的那种情况下
    // 他接下来说的话是基于"改动已生效"这个错误前提的。
    //
    // 定时器平时已经主动播过了,这里是**兜底**:主动推送要用他上一条来信的
    // context_token,那份东西会耗尽也会失效;而他现在开口了,手上就有一份崭新的。
    await this.flushDeployNews(userKey);
    // token 快到期也在这时说 —— 只对管理员(换发要人在宿主跑 setup-token,普通用户
    // 拿这条什么都做不了)。发送成功才落账,与部署结果播报同一条纪律:
    // 先标记等于把这条告警永久吞掉,而它恰恰是"整个系统会一起静默死掉"的预告。
    if (this.tokenAlert && this.settings.isAdmin(userKey)) {
      const alert = this.tokenAlert.pending();
      if (alert && (await this.trySend(userKey, alert, "token 到期告警", "reminder"))) {
        this.tokenAlert.markAnnounced();
      }
    }
    let justGreeted = false;
    if (this.users.needsGreeting(userKey)) {
      const allowlist = this.settings.effective().modelAllowlist;
      // 发送成功才标记 —— 失败留给下次重试,指引值得重试。
      if (
        await this.trySend(
          userKey,
          greetingText(allowlist, this.settings.isAdmin(userKey)),
          "首次使用指引",
        )
      ) {
        this.users.markGreeted(userKey);
        justGreeted = true;
      }
    }
    return { cwd, justGreeted };
  }

  /**
   * 解析硬指令,并挡掉这个用户没资格用的那几条。
   *
   * **挡掉 = 当它不是指令**,于是照常走 LLM(未知的斜杠开头文本本来就是这个待遇)。
   * 这样非管理员既用不了、也看不出这些指令存在 —— 不必再写一句"你没权限",
   * 那句话本身就是在告诉他有这么个东西。
   *
   * 权限现查而不是缓存:管理员名单可以在 dashboard 上随时改,提权/降权都该立刻生效。
   */
  private parseAllowed(userKey: string, text: string): ParsedCommand | undefined {
    const parsed = parseCommand(text);
    if (!parsed) return undefined;
    // 信使执行的那几条(路由切换、应急绑定)正常情况下压根到不了这里 —— 信使在消息
    // 进人格之前就消化掉了。真到了,说明跑着的信使版本比人格老、还不认识这条指令;
    // 那时安静地退化成普通消息(照常走 LLM),比回一句"这条我不管"有用。
    if (parsed.cmd.where === "courier") return undefined;
    if (parsed.cmd.adminOnly && !this.settings.isAdmin(userKey)) return undefined;
    return parsed;
  }

  /** 执行一条 immediate 硬指令。与在飞回合并发,只做幂等操作。 */
  private async runCommand(userKey: string, cmd: CommandDef): Promise<void> {
    const pre = await this.prelude(userKey);
    if (!pre) return;

    switch (cmd.name) {
      case "help":
        // 刚推过 greeting 的话内容一模一样,不重复刷屏。
        if (!pre.justGreeted) {
          await this.trySend(
            userKey,
            helpText(this.settings.effective().modelAllowlist, this.settings.isAdmin(userKey)),
            "帮助",
          );
        }
        return;

      case "status":
        await this.trySend(userKey, this.statusText(userKey), "状态");
        return;

      case "upgradeStatus":
        await this.trySend(userKey, this.upgradeStatusText(), "升级状态");
        return;

      case "jobs":
        await this.trySend(userKey, this.jobsText(userKey), "定时任务");
        return;

      case "nop": {
        // 额度在这条消息**抵达渠道**的那一刻就续上了(新 context_token),网关这边
        // 只剩一件事:把节流器重新开闸。
        //
        // **一个字都不回。** 从前这里要"真发一条出去",理由是网关手里的余量靠发送
        // 响应带回来、不发就停在 0。那个理由已经不成立:预算的唯一权威搬去了信使
        // (`courier/reply-store.ts`),归零发生在 `remember()`,与我们发不发无关;
        // 积压排空也一样,`courier/core.ts` 的 `accept()` 每收一条来信就 `kick()` 一次。
        // 于是那句"好,额度续上了"变成纯粹的噪音 —— 而且是**从它刚买回来的 10 条里
        // 花掉一条**去说的噪音,恰好挤掉一条进度。
        //
        // 代价是没有回音:没有在飞回合、也没有积压时,发 `/nop` 什么都不会发生。
        // 那正是它的语义(指令表里就写着"什么也不做"),要确认活着用 `/状态`。
        this.turns.foregroundFor(userKey)?.resetProgress?.();
        return;
      }

      case "cancel": {
        // 还在聚合窗口里的消息也算"正在处理" —— 用户看不见队列,他要取消的是
        // 刚发出去的那几条,不管它们变没变成回合。
        const dropped = this.dropPending(userKey);
        // **只中断前台**:后台那些是用户主动切走、说了"你接着跑"的,
        // 一条 /取消 顺手把它们也灭掉是误伤。要停后台得先切回去再取消。
        const fg = this.turns.foregroundFor(userKey);
        if (!fg) {
          await this.trySend(
            userKey,
            dropped ? "好,刚发的还没开始处理,已经丢掉了。" : "现在没有正在跑的任务。",
            "取消确认",
          );
          return;
        }
        fg.abort.abort();
        // 不在这里回话:被中断的回合自己会走错误分支给用户一个交代。
        return;
      }

      default:
        return;
    }
  }

  /**
   * 执行一条走队列的硬指令(改会话状态的那几个)。返回是否继续处理这批剩下的段。
   *
   * 它们在分拣节点里执行,与消息投递保持先后 —— 这正是「指令之前的话落在原来
   * 那段会话、之后的话落在切过去那段」的实现。
   */
  private async runQueuedCommand(
    userKey: string,
    cmd: CommandDef,
    arg: string,
    moreInputAfter: boolean,
  ): Promise<boolean> {
    switch (cmd.name) {
      case "newSession": {
        // 切走当前会话:它的在飞回合**不停**,转后台跑完再把结果送来。
        const detached = this.detachForeground(userKey);
        const prev = this.sessions.archiveCurrent(userKey);
        const lines = [
          detached
            ? "好,新对话开始了。刚才那一轮我在后台接着跑,跑完把结果发你。"
            : "好,下次从新对话开始,之前的上下文不带了。",
        ];
        // 归档不等于删除 —— 教用户怎么切回来,这是他知道这件事的三个入口之一
        // (另两个:超时提醒、/切换会话 的确认语)。
        if (prev) {
          lines.push(
            `想回到刚才的对话,发「${canonicalOf("switchSession")} ${shortSessionId(prev.sessionId)}」。`,
          );
        } else if (detached) {
          // 那一轮还没 record 过(它就是第一轮),id 要等它跑完才有。
          lines.push(`跑完的这段之后可以用 ${canonicalOf("switchSession")} 找回。`);
        }
        await this.trySend(userKey, lines.join("\n"), "新会话确认");
        return true;
      }

      case "continue": {
        // 刷新会话时钟就够了:这批后面的话在 decide() 里自然命中「未超时 → resume」。
        // 顺序由分拣节点保证,不需要把"续上"这件事变成一个标记传下去。
        const ok = this.sessions.touch(userKey);
        // 后面还有话要说时不必回执 —— 它们马上就落进续上的那段会话,回执纯属噪音。
        if (!moreInputAfter) {
          await this.trySend(
            userKey,
            ok ? "好,接上刚才的对话了,直接发消息继续聊。" : "现在没有可继续的对话,直接发消息就会开新的。",
            "继续确认",
          );
        }
        return true;
      }

      case "switchSession":
        return this.handleSwitch(userKey, arg, moreInputAfter);

      case "publish":
        return this.handleDeployRequest(userKey, "发布", async (d) =>
          d.requestDeploy(arg, userKey),
        );

      case "rollback":
        return this.handleDeployRequest(userKey, "回滚", async (d) => d.requestRollback(userKey));

      default:
        return true;
    }
  }

  /**
   * `/发布` 与 `/回滚` 共用的外壳。两者的差别只在"请求什么",而周边三件事完全一样:
   * 没配部署机制要说人话、起不来 deployer 要立刻告诉人、这批后面的话照常投递。
   *
   * **起不来 deployer 必须当场说**:用户以为流程在跑,实际上什么都没发生 ——
   * 而他接下来的话全都建立在"版本已经在换了"这个错误前提上。
   */
  private async handleDeployRequest(
    userKey: string,
    label: string,
    request: (deploy: DeployControl) => Promise<string>,
  ): Promise<boolean> {
    const deploy = this.deploy;
    if (!deploy) {
      await this.trySend(userKey, `这台机器没有配自进化的部署机制,${label}要人工来。`, label);
      return true;
    }
    try {
      await this.trySend(userKey, await request(deploy), label);
    } catch (err) {
      console.error(`[gateway] ${userKey} 请求${label}失败:`, err);
      await this.trySend(
        userKey,
        `没能起动${label}流程:${(err as Error).message}\n版本没有任何变化,需要人上机处理。`,
        label,
      );
    }
    // 切换只在这批的这一点上发生;后面的话照常投递 —— 进程多半马上就被停了,
    // 但那属于部署本身的语义,不必在这里假装还能保证什么。
    return true;
  }

  /** `/升级状态` 的正文。纯读磁盘,不花额度 —— 升级出问题时唯一可靠的信息源。 */
  /**
   * `/任务` 的正文:这个用户自己的定时任务与下次触发时刻。
   *
   * 走 immediate 路径,所以**不进 LLM、不花额度**,而且助手卡死时照样答得出来 ——
   * "那个半夜的备份到底还在不在"不该排在一个卡住的回合后面。
   *
   * 只读自己的:与 `/api/me/cron` 同一个作用域,与 dashboard 那个全站视图不同。
   */
  private jobsText(userKey: string): string {
    if (!this.cron) return "这台机器没有定时任务功能。";
    const jobs = this.cron.jobsOf(userKey);
    if (!jobs.length) {
      return "你还没有定时任务。跟我说一句「每天早上八点看一眼磁盘」就能建一个。";
    }
    const lines = [`⏰ 你有 ${jobs.length} 个定时任务`];
    for (const j of jobs) {
      const when = j.enabled && j.nextAt !== undefined ? formatAt(j.nextAt, this.cron.tz) : "已停用";
      const last = j.lastStatus ? `,上次${JOB_STATUS_CN[j.lastStatus] ?? j.lastStatus}` : "";
      const streak = j.failStreak >= 2 ? `(已连续失败 ${j.failStreak} 次)` : "";
      lines.push(`· ${j.name} —— 下次 ${when}${last}${streak}`);
    }
    lines.push("要看某个任务跑出了什么,直接问我。");
    return lines.join("\n");
  }

  private upgradeStatusText(): string {
    const lines = ["🚀 升级状态", versionLine(this.version)];
    if (!this.deploy) {
      lines.push("这台机器没有配自进化的部署机制。");
      return lines.join("\n");
    }
    const last = this.deploy.lastReport();
    lines.push(last ? `上次部署:${formatDeployReport(last)}` : "上次部署:还没有部署记录。");

    // 待发布的候选。它是 `/发布` 那几位数字的唯一查法 —— 制备的汇报早被聊天顶上去了,
    // 而这条指令不进 LLM、不花额度,任何时候问都答得出。
    const waiting = this.deploy.publishable().filter((c) => !c.running);
    if (waiting.length) {
      lines.push(
        `待发布:${waiting
          .map((c) => `${shortSha(c.sha)}${c.branch ? `(${c.branch})` : ""}`)
          .join("、")} —— 发「${canonicalOf("publish")} <前6位>」上线。`,
      );
    }

    const history = this.deploy.verifiedHistory();
    if (!history.length) {
      lines.push("可回退版本:无(还没有版本通过过观察期)。");
    } else {
      lines.push(
        `可回退版本:${history.length} 个 —— ` +
          history.map((r) => `${shortSha(r.sha)}${r.verifiedAt ? `(${r.verifiedAt})` : ""}`).join("、"),
      );
      if (history.length >= 2) {
        lines.push(`发 ${canonicalOf("rollback")} 会退到 ${shortSha(history[1]!.sha)}。`);
      }
    }
    return lines.join("\n");
  }

  /**
   * 把部署的进展(里程碑 + 最终结果)告诉该收到的人。
   *
   * ## 为什么必须主动推
   *
   * 用户说完「发布」那个回合就结束了(提交部署后立即收尾,否则会与排水互锁),
   * 而整条链要走三十多分钟 —— 那期间没有任何在飞回合能说话。这里原先的做法是
   * "等他下次开口时捎给他",于是真机上的体验是:等多久都等不到,直到自己先开口。
   * 而"先开口"恰恰是他想避免的事:他就是在等结果。
   *
   * 主动推送**是能做的**:信使把每个用户的回复上下文落了盘(courier/reply-store.ts),
   * 会话空闲提醒早就靠它送达了。所以这里按同一条路走,只是多了预算上的克制。
   *
   * ## 三条纪律
   *
   * ① **发送成功才标记已播**:发送本就可能失败(预算耗尽/上下文失效),先标记
   *    等于把这条进展永久吞掉,而"升级失败已回滚"是最不能丢的一条。
   * ② **失败要收手**:见 NEWS_MAX_ATTEMPTS —— 重试烧的是同一份发送预算。
   * ③ **串行**:定时器与用户开口两条路径共用这一个方法,靠 newsChain 排队,
   *    否则两边会同时判定"还没播过"然后各发一遍。
   *
   * @param prefer 正在开口的那个用户。他手上有一份崭新的回复上下文,所以发给他的
   *   那几条**不受重试上限约束** —— 上限防的是对着一个发不出去的上下文空烧预算。
   */
  flushDeployNews(prefer?: string): Promise<void> {
    this.newsChain = this.newsChain
      .then(() => this.doFlushDeployNews(prefer))
      .catch((err) => {
        // 播报失败不该拖垮调用方(它可能是 prelude,后面还有正事要做)。
        console.warn(`[deploy] 播报部署进展时出错:${String(err)}`);
      });
    return this.newsChain;
  }

  private async doFlushDeployNews(prefer?: string): Promise<void> {
    const deploy = this.deploy;
    if (!deploy) return;

    // 里程碑按发生顺序播:先"切到新版本"再"转稳定",倒过来读是另一个故事。
    for (const p of deploy.pendingProgress()) {
      const to = this.newsRecipient(p.requestedBy);
      if (!to) {
        // 没有任何人收得到(没有发起人、管理员名单也是空的)。标记已播免得每 15 秒
        // 重算一次,内容照旧留在日志里 —— 它是这条路径上唯一不依赖配置的出口。
        console.warn(`[deploy] 没有可播报的对象,只记日志:${formatDeployProgress(p)}`);
        deploy.markProgressAnnounced(p.id);
        continue;
      }
      if (!this.mayPushNews(p.id, to === prefer)) continue;
      if (await this.trySend(to, formatDeployProgress(p), "部署进度", "announce")) {
        deploy.markProgressAnnounced(p.id);
        this.newsAttempts.delete(p.id);
      }
    }

    const report = deploy.pendingReport();
    if (!report) return;
    // 有发起人就只告诉他:别人没等这个结果,收到一句"升级完成"只会莫名其妙。
    // 没有发起人(比如看门狗自动回退)则告诉管理员 —— 那种情况更要有人知道。
    const to = this.newsRecipient(report.requestedBy);
    if (!to) {
      console.warn(`[deploy] 没有可播报的对象,只记日志:${formatDeployReport(report)}`);
      return;
    }
    if (!this.mayPushNews(report.id, to === prefer)) return;
    if (await this.trySend(to, formatDeployReport(report), "部署结果", "announce")) {
      deploy.markReportAnnounced(report.id);
      this.newsAttempts.delete(report.id);
    }
  }

  /**
   * 这条播报该发给谁。发起人优先(他才是在等的那个);没有发起人时发给第一位管理员 ——
   * 那种情况(看门狗自动降级)更要有人知道。一个都没有时返回 undefined,由调用方记日志。
   */
  private newsRecipient(requestedBy?: string): string | undefined {
    if (requestedBy) return requestedBy;
    return this.settings.effective().adminUserKeys[0];
  }

  /** 这条播报现在能不能再试一次。见 NEWS_MAX_ATTEMPTS 的说明。 */
  private mayPushNews(id: string, unlimited: boolean): boolean {
    if (unlimited) return true;
    const now = this.now();
    const a = this.newsAttempts.get(id);
    if (!a) {
      this.newsAttempts.set(id, { n: 1, last: now });
      return true;
    }
    if (a.n >= NEWS_MAX_ATTEMPTS || now - a.last < NEWS_RETRY_MS) return false;
    a.n += 1;
    a.last = now;
    return true;
  }

  /**
   * `/health` 里属于网关的那部分:排水计数与最近一个回合。
   *
   * **三个计数缺一不可**,它们是消息在网关里经过的三段:聚合窗口里攒着的
   * (`aggregating`)、已受理但分拣没走完的(`queued`)、已变成回合的(`inFlight`)。
   * 部署的排水要求三者同时归零 —— 只看在飞回合的话,窗口里和分拣链上的话会连人带
   * 消息一起被切换杀掉,用户那边就是"发了没反应"。
   */
  healthSnapshot(): GatewayHealth {
    return {
      inFlight: this.turns.counts(),
      queued: this.queued,
      aggregating: this.pending.size,
      ...(this.lastTurn ? { lastTurn: this.lastTurn } : {}),
    };
  }

  /**
   * 把当前前台回合切到后台:它继续跑完,只是进度不再推、产出进 history。
   * 返回是否真的有这么一个回合(用于组织确认语)。
   */
  private detachForeground(userKey: string): boolean {
    const fg = this.turns.foregroundFor(userKey);
    if (!fg) return false;
    fg.detached = true;
    return true;
  }

  /**
   * 外部(信使的 `detach` 控制帧)要求把这个用户的在飞回合转后台。
   *
   * 触发的是 `/救援` 与路由 TTL 回落:那个用户已经不归本人格了,他手里这一轮
   * 得跑完 —— 但**进度不再推**(他正在跟另一个人格说话)、正文带【后台对话】前缀、
   * 产出走 `archiveTurn` 而不是 `record`(顶掉他刚切过去的会话是最糟的)。
   * 这三件事全都由既有的 detached 语义承担,所以这里只是把那个开关暴露出来。
   *
   * 幂等:没有在飞回合时什么也不做 —— 控制帧可能重复送达(at-least-once)。
   */
  detachUser(userKey: string): void {
    if (this.detachForeground(userKey)) {
      console.info(`[gateway] ${userKey} 已被切到别的人格,他的在飞回合转后台`);
    }
  }

  /**
   * 「现在有没有在处理」的那一行。
   *
   * 这是用户侧唯一能回答"是卡住了还是根本没收到"的观测点:`/状态` 走 immediate
   * 分流、不进串行队列,所以回合卡死时它照样答得出。四种状态分开说,因为处置
   * 完全不同:排队(等的是别人的回合,/取消 自己这条没用)、跑着(等模型或工具)、
   * 正在中断、空闲(消息压根没被受理,该重发)。
   */
  private inFlightText(userKey: string): string {
    const ctx = this.turns.foregroundFor(userKey);
    if (!ctx) return "当前:空闲,没有正在处理的消息";

    const p = ctx.progress;
    const now = this.now();
    const waited = humanDuration(now - p.startedAt);
    if (p.running === undefined) {
      return `当前:排队中,已等 ${waited}(并发上限满了,前面还有别的回合)`;
    }
    if (ctx.abort.signal.aborted) return `当前:正在中断这一轮(已 ${waited})`;
    // 追加进去的消息在别处看不见(SDK 消息流里不露面),这里是用户确认
    // 「我刚补的那句赶上了没」的唯一出口。
    const fed = p.fed ? `,期间补充 ${p.fed} 条` : "";
    if (!p.steps) return `当前:处理中,已 ${waited}${fed},还在等模型的第一个动作`;
    return (
      `当前:处理中,已 ${waited}${fed} · 第 ${p.steps} 步` +
      `(${humanDuration(now - p.lastAt)}前)${p.last ? ` · ${p.last}` : ""}`
    );
  }

  /**
   * 后台还在跑的那几段。
   *
   * 被切走的回合不再推进度,所以除了这里,用户没有任何地方看得出"那一轮还活着" ——
   * 一段几分钟前切走的对话突然吐出结果,他得能提前知道那是什么。
   */
  private backgroundLines(userKey: string): string[] {
    const bg = this.turns.allFor(userKey).filter((t) => t.detached);
    if (!bg.length) return [];
    const now = this.now();
    return [
      `后台:${bg.length} 段对话还在跑(跑完把结果发你)`,
      ...bg.map((t) => {
        const p = t.progress;
        const step = p.steps ? ` · 第 ${p.steps} 步(${humanDuration(now - p.lastAt)}前)` : "";
        return `  · 已 ${humanDuration(now - p.startedAt)}${step}`;
      }),
    ];
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
      this.inFlightText(userKey),
      ...this.backgroundLines(userKey),
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
      // 版本放最后:日常没人关心,但"我刚让它改的东西上线没有"只有这一行答得出,
      // 而那时用户手上多半只有微信。
      versionLine(this.version),
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
        // 切走的那一轮**不停**:转后台跑完再把结果送来。detach 必须在 switchTo()
        // 成功之后 —— 切换失败时会话没变,那一轮仍然是前台的。
        const detached = this.detachForeground(userKey);
        const topic = res.to.hint ? `(${res.to.hint})` : "";
        const lines = [`好,切到对话 ${shortSessionId(res.to.sessionId)}${topic},直接发消息就是接着它聊。`];
        if (detached) lines.push("刚才那一轮我在后台接着跑,跑完把结果发你。");
        if (res.from) {
          lines.push(`刚才的对话想切回来就发「${sw} ${shortSessionId(res.from.sessionId)}」。`);
        }
        await this.trySend(userKey, lines.join("\n"), "切换确认");
        return true;
      }
      case "already-current":
        await this.trySend(
          userKey,
          res.revived
            ? // 它刚才已经超时了,switchTo 把时钟拨了回来。这一句必须与"无事发生"
              // 区分开:用户切的多半正是一段放凉了的对话,而"接回来了"是他要的确认。
              `对话 ${shortSessionId(res.current.sessionId)} 闲置太久已经断了,给你接回来了 —— 直接发消息接着聊。`
            : `现在就在对话 ${shortSessionId(res.current.sessionId)} 里,直接发消息即可。`,
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

  /**
   * 起一个回合。**同步完成 `turns.mint()` 再把余下的交给后台** ——
   * 分拣节点紧接着处理下一段时,必须立刻能看到这个前台回合,否则同一批里的
   * 两段话会各起一轮(而不是后一段追加进前一段的回合)。
   */
  private startTurn(
    userKey: string,
    text: string,
    attachments: readonly Attachment[],
    cwd: string,
  ): Promise<void> {
    const prefs = this.prefs.effective(userKey);
    const decision = this.sessions.decide(userKey);
    const turn = this.turns.mint(userKey);
    // 回合内部已把异常都收敛成给用户的回复,这里兜的是漏网的抛错 ——
    // 交出去的 promise 绝不能 reject,否则谁也不等它时就是 unhandled rejection。
    return this.runTurn(userKey, text, attachments, cwd, prefs, decision, turn).catch((err) => {
      console.error(`[gateway] ${userKey} 的回合意外抛错:`, err);
    });
  }

  private async runTurn(
    userKey: string,
    text: string,
    attachments: readonly Attachment[],
    cwd: string,
    prefs: EffectiveUserPrefs,
    decision: Decision,
    turn: MintedTurn,
  ): Promise<void> {
    // 本回合发出的所有回执(首条 + 每次追加输入各一条),收尾时一起撤回。
    const ackIds: string[] = [];
    // 追加输入的回执是异步发的(feed 必须同步返回),收尾前要等它们落地才拿得到 id。
    const ackWaits: Array<Promise<void>> = [];
    // 回执在排队之前发:并发受限时用户可能要等一会儿,先让他知道消息收到了。
    const ackId = prefs.ackEnabled ? await this.trySendAck(userKey, ACK_TEXT) : undefined;
    if (ackId !== undefined) ackIds.push(ackId);

    const isAdmin = this.settings.isAdmin(userKey);
    const hint = sessionHint(text, attachments.length > 0);
    // 回合一开始就拿得到的 sessionId。**存在的全部理由是抛错那条路** ——
    // 成功时用 reply.sessionId 就够了,而抛错时 reply 根本不存在。
    let observedSessionId: string | undefined;
    const pre = { cwd };

    // 进度消息串行链:保证按事件产生顺序逐条发送,最终回复排在链尾之后。
    // 节流从**回合开始**起算,而不是从第一个事件 —— 用户等待的是前者。
    // 只剩间隔阶梯:发多少条由渠道那边的额度说了算,核心不问,见类上面那段。
    const throttle = new ProgressThrottle(this.now(), PROGRESS_INTERVALS_MS);
    // `/nop` 走 immediate 路径、不经过追加输入,但用户刚开口正是最想看进度的时刻 ——
    // 挂出来让它也能开闸。挂在这里而不是 mint 时:节流器是这一轮的局部状态。
    turn.ctx.resetProgress = () => throttle.reset(this.now());
    let progress: Promise<void> = Promise.resolve();
    // **回调无条件挂上**,progressEnabled 只决定要不要推给用户。
    // 关掉进度推送的用户同样需要 /状态 答得出"现在在干什么" —— 把观测和
    // 推送绑在一起的话,一个纯粹的省流开关会顺手把可观测性也关掉。
    const onProgress = (ev: AgentProgressEvent) => {
      const snap = turn.ctx.progress;
      snap.steps += 1;
      snap.lastAt = this.now();
      snap.last = describeProgress(ev);
      // 切到后台之后不再推进度:用户已经在跟别的会话说话了,这时候插播
      // 另一段对话的工具调用只会让他分不清是谁在说话。快照照旧更新 ——
      // /状态 还要靠它交代后台那几段跑到哪了。
      if (!prefs.progressEnabled || turn.ctx.detached) return;
      // 节流判定在事件到达时就做完,不放进串行链:链上排队的时长会把
      // "这个事件是什么时候发生的"整个搞乱,节流间隔也就不准了。
      const text = throttle.offer(this.now(), ev);
      if (text === undefined) return;
      // 发不出去不是这里的事:渠道那边会排队,额度到头时也由它去说
      // "进度就报到这儿,发 /nop 可以续上"(courier/outbox.ts)。
      progress = progress.then(async () => {
        await this.trySend(userKey, text, "进度", "progress");
      });
    };

    // 追加输入的记账。图片**跨追加累计** —— maxImagesPerTurn 的理由是回合的
    // 内存峰值与图片 token 开销,那是按整个回合算的,不是按每条消息算的。
    let imagesUsed = attachments.length;
    let feeds = 0;

    const release = await this.semaphore.acquire();
    turn.ctx.progress.running = this.now();
    try {
      // 上一回合被内存中止过的话,把前情缀在这条消息前面。**取走即清** ——
      // 它只对紧接着的那一条有意义,留着会在几轮之后冒出来把人搞糊涂。
      const prior = this.lastMemAbort.get(userKey);
      if (prior) this.lastMemAbort.delete(userKey);
      const reply = await this.agent.run(prior ? priorAbortPrefix(prior) + text : text, {
        cwd: pre.cwd,
        resumeSessionId: decision.isNew ? undefined : decision.resumeSessionId,
        ...(prefs.model ? { model: prefs.model } : {}),
        env: this.childEnv(isAdmin, turn.token, userKey),
        skills: skillsFor(this.persona, isAdmin),
        abortController: turn.ctx.abort,
        // 看门狗动手时给用户带外发一条。不走 onProgress —— 用户可能把进度关了,
        // 而"系统对这个回合做了什么"是不该被那个开关埋掉的。
        onNotice: (text: string) => {
          void this.trySend(userKey, this.labelIfDetached(turn.ctx, undefined, text), "看门狗");
        },
        // 只是记在手边,**不在这里写盘** —— 回合还可能被切走(detached),
        // 那时该写 history 而不是 current,而那个判断要等 finally 才作数。
        onSessionId: (id) => {
          observedSessionId = id;
        },
        onProgress,
        logLabel: userKey,
        ...(attachments.length ? { attachments } : {}),
        // agent 跑起来了才挂 feed:排队中的回合还没有 turn 可折,那时候
        // 消息该照常排队。挂上之后 flush() 就会优先走追加而不是入队。
        onFeedReady: (feed) => {
          turn.ctx.feed = (feedText, feedAttachments) => {
            // 已经不是前台了就不再接追加:用户此刻的话是说给新会话听的。
            // foregroundFor() 本就过滤掉了 detached,这里是第二道防线。
            if (turn.ctx.detached) return false;
            if (feeds >= MAX_FEEDS_PER_TURN) {
              // 记一行:此后用户的消息重新变成"要等这一轮跑完",而他那边
              // 看到的又是熟悉的没反应 —— 不打日志的话这个转折点无迹可寻。
              console.info(
                `[gateway] ${userKey} 本回合追加已达上限 ${MAX_FEEDS_PER_TURN},这批另起一轮`,
              );
              return false;
            }
            const room = Math.max(0, this.settings.effective().maxImagesPerTurn - imagesUsed);
            const kept = feedAttachments.slice(0, room);
            // 图全被挤掉又没有文字:追加进去就是一条空 content,模型侧直接拒收。
            // 回落到队列反而是更好的结果 —— 新回合有一整份图片额度。
            if (!feedText && !kept.length) return false;
            // agent 侧已收摊(回合结束/出错)则原样退回,由调用方起新回合。
            if (!feed(feedText, kept)) return false;
            feeds += 1;
            imagesUsed += kept.length;
            turn.ctx.progress.fed = feeds;
            if (kept.length < feedAttachments.length) {
              console.info(
                `[gateway] ${userKey} 追加输入带 ${feedAttachments.length} 张图,` +
                  `本回合累计已达上限,丢弃 ${feedAttachments.length - kept.length} 张`,
              );
            }
            // 进度重新开闸 —— 追加带来了新的 context_token,发送预算跟着回来了。
            throttle.reset(this.now());
            if (prefs.ackEnabled) {
              ackWaits.push(
                this.trySendAck(userKey, FEED_ACK_TEXT).then((id) => {
                  if (id !== undefined) ackIds.push(id);
                }),
              );
            }
            return true;
          };
        },
      });
      // 产出记到哪,取决于这一轮还是不是前台:
      //   前台 → record() 写 current(常规路径);
      //   已被切走 → archiveTurn() 只更新 history —— 写 current 会把用户
      //     刚切过去的那段顶掉,而他正在跟它说话。
      this.lastTurn = { at: this.now(), isError: reply.isError };
      // 回合跑到这儿就是没被内存中止 —— 断路器的连续计数清零。
      // **不清零的话它只增不减**,跑久了迟早误跳,而那时用户什么错都没犯。
      this.memAbortStreak.delete(userKey);
      if (turn.ctx.detached) this.sessions.archiveTurn(userKey, reply.sessionId, hint);
      else this.sessions.record(userKey, reply.sessionId, hint);
      await progress;
      const body = reply.isError ? TURN_ERROR_PREFIX + reply.text : reply.text;
      await this.sendChunked(
        userKey,
        this.labelIfDetached(turn.ctx, reply.sessionId, body),
        prefs.maxReplyChars,
      );
    } catch (err) {
      // 用户主动中断不算"回合出错":把 /取消 记成失败会让观测数据长期偏红。
      if (!turn.ctx.abort.signal.aborted) this.lastTurn = { at: this.now(), isError: true };
      const memAbort = readMemAbort(turn.ctx.abort.signal.reason);
      if (memAbort) {
        this.lastMemAbort.set(userKey, memAbort);
        this.memAbortStreak.set(userKey, (this.memAbortStreak.get(userKey) ?? 0) + 1);
      }
      // **把这段会话记下来,哪怕这一轮是死的。**
      // 记录本身在盘上是完好的(实测:被 docker kill 的那次,15 条对话条目里每个
      // tool_use 都有配对的 tool_result,尾巴停在一个合法的 resume 点上)——
      // 缺的只是"谁记得它的 id"。不记的话用户下一句话会开一个全新会话,而我们
      // 刚刚才跟他说过「会话没丢,接着说就行」。
      //
      // 分岔与成功路径**必须一致**:被切走的回合写 history,否则会把用户刚切过去
      // 的那段顶掉,而他正在跟它说话。
      if (observedSessionId) {
        if (turn.ctx.detached) this.sessions.archiveTurn(userKey, observedSessionId, hint);
        else this.sessions.record(userKey, observedSessionId, hint);
      }
      console.error(`[gateway] 处理 ${userKey} 消息失败:`, err);
      await progress;
      // 错误说明与正文同样要标出处 —— 后台回合报错时用户多半正在跟另一段对话
      // 说话,一句没头没尾的「处理出错了」会被当成当前对话的答复(这正是
      // labelIfDetached 存在的理由)。回合是抛错告终的,没有 reply 可问 sessionId:
      // 出处优先用**实际观测到的** id:它从第一条 SDK 消息就有了。
      // (这里从前写着"新会话的则连 id 都还没有" —— 那句是错的,id 一直都在,
      // 只是没往外传。这个错误判断正是上面那个 bug 的来源。)
      // 观测不到才退回 decide() 给的那个(SDK resume 不 fork,id 稳定)。
      await this.trySend(
        userKey,
        this.labelIfDetached(
          turn.ctx,
          observedSessionId ?? (decision.isNew ? undefined : decision.resumeSessionId),
          turn.ctx.abort.signal.aborted
            // 分辨中止原因。光秃秃一句「已中断这一轮」在真机上被证明是不够的:
            // 用户按了 /取消、超时、崩了、内存看门狗动手 —— 四种措辞一模一样,
            // 而该做的事完全不同。内存那种尤其要紧,因为默认反应"再发一遍"
            // 恰恰是错的。每一种都补一句「会话没丢」,否则用户会重开会话,
            // 而那才是真的把上下文丢了。
            // 连续中止到达阈值就换一套话:单次那条说"换个问法再来",而这时候
            // 已经证明换问法没用,问题在任务本身。
            ? (memAbort && circuitTripped(this.memAbortStreak.get(userKey) ?? 0)
                ? circuitTripText(this.memAbortStreak.get(userKey) ?? 0, memAbort.limit)
                : abortNoticeText(memAbort))
            : `处理出错了:${(err as Error).message}`,
        ),
        "错误说明",
      );
    } finally {
      // 先摘掉 feed 再 revoke:此后到达的消息一律另起一轮。
      turn.ctx.feed = undefined;
      turn.revoke();
      release();
      if (this.channel.recall) {
        // 追加回执可能还在发。不等的话拿不到它的 id,那条回执就永远留在会话里了。
        await Promise.all(ackWaits);
        for (const id of ackIds) {
          await this.channel.recall(userKey, id).catch(() => {
            // 撤回失败(渠道限制/消息过期)不影响回合结果,回执留在会话里即可。
          });
        }
      }
    }
  }

  /**
   * 后台回合的正文要标明出处。
   *
   * 用户此刻多半正在跟另一段对话说话,一段没头没尾的回复会被当成当前对话的答复 ——
   * 尤其它可能是几分钟前那个问题的答案。带上会话 id 还顺带告诉他怎么切回去。
   *
   * `sessionId` 允许缺失:回合抛错告终时拿不到它(新会话尤其,id 要等 SDK 吐出
   * 结果才存在)。那种情况下"这是后台那段说的话"仍然要讲,只是切回的指令给不出 ——
   * 与其为了凑齐格式而不标出处,不如少给一句提示。
   */
  private labelIfDetached(ctx: TurnContext, sessionId: string | undefined, text: string): string {
    if (!ctx.detached) return text;
    if (sessionId === undefined) return `【后台对话的结果】\n${text}`;
    return (
      `【后台对话 ${shortSessionId(sessionId)} 的结果】\n${text}\n\n` +
      `(想接着这段聊,发「${canonicalOf("switchSession")} ${shortSessionId(sessionId)}」)`
    );
  }

  /**
   * agent 子进程的环境变量。
   *
   * SDK 的 env 会**整体替换**子进程环境(不是合并),所以必须展开 process.env ——
   * 而 process.env 里带着 CATMAN_ADMIN_TOKEN。规则:一律剔除,只有 admin 回合
   * 显式加回。这是管理员令牌下放到子进程的唯一出口。
   */
  /** 子进程环境。实现在 core/turn-env.ts —— 定时 agent 任务用的是同一份。 */
  private childEnv(
    isAdmin: boolean,
    sessionToken: string,
    userKey: string,
  ): Record<string, string | undefined> {
    const notifyToken = this.notifyTokens?.for(userKey);
    return buildTurnEnv({
      apiBase: this.apiBase,
      sessionToken,
      isAdmin,
      ...(notifyToken ? { notifyToken } : {}),
      ...(this.binDir ? { binDir: this.binDir } : {}),
    });
  }


  /**
   * 发送回执并返回消息 id(仅当渠道支持撤回且返回了 id)。
   * 回执纯属体验增强,发送失败静默忽略。
   */
  private async trySendAck(userKey: string, text: string): Promise<string | undefined> {
    try {
      const id = await this.channel.send(userKey, text, "ack");
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
        "reminder",
      );
      if (!ok) {
        // 渠道无法主动推送:降级为下次用户发消息时由会话规则处理,无需额外动作。
        console.info(`[gateway] 用户 ${userKey} 超时提醒推送失败,降级为下次消息提示`);
      }
    }
  }

  /**
   * 分段发正文。
   *
   * **一段失败就停下,不接着发后面的。** 少一截和中间缺一块是两种不同的坏:
   * 截断看得出来(话没说完),空洞看不出来(读起来像另一句话)。
   *
   * 走 `trySend` 而不是直接 `channel.send`:抛出去会被 runTurn 的 catch 接住,
   * 于是用户收到半截答案**外加**一句"处理出错了",而那一轮其实跑成功了。
   * 发不出去本身现在也基本不会发生 —— 信使那边有发件队列接着(courier/outbox.ts),
   * 走到这个失败分支说明的是 IPC 层面的问题(信使不可达),那时后面几段同样发不出去。
   */
  private async sendChunked(userKey: string, text: string, maxChars: number): Promise<void> {
    const total = Math.ceil(text.length / maxChars);
    for (let i = 0, n = 1; i < text.length; i += maxChars, n += 1) {
      const ok = await this.trySend(userKey, text.slice(i, i + maxChars), "正文");
      if (!ok) {
        console.error(`[gateway] ${userKey} 的正文发到第 ${n}/${total} 段停下 —— 后面几段不再发`);
        return;
      }
    }
  }

  /**
   * 发一条不该影响回合结果的消息。
   *
   * 吞掉异常是刻意的(进度推送失败不该把整个回合搞挂),但**吞掉不等于不记** ——
   * 排查发送问题时,看不见的失败比失败本身更难办:日志里只剩最后一步正文报错,
   * 会让人以为前面都成功了。`what` 用来分辨是哪一类发送坏掉的。
   */
  /**
   * 主动推一条消息给某个用户(定时任务的开跑/结果播报走这里)。
   *
   * 与网关自己那些播报共用同一条发送路径,于是也共用同一份纪律:发不出去不是
   * 这里的事 —— 信使有发件队列,它会在用户下次开口时补发。所以这个方法**不抛错**,
   * 调用方不必(也不应该)自己重试。
   *
   * `kind` 只能用信使已经认识的那几种:它跑的是钉住的旧版本,不认识的 kind 会让
   * 整个信封读不懂,那条消息就恰好在最需要它的时候消失。
   */
  async push(userKey: string, text: string, kind: SendKind): Promise<void> {
    await this.trySend(userKey, text, "定时任务播报", kind);
  }

  private async trySend(
    userKey: string,
    text: string,
    what = "消息",
    kind: SendKind = "body",
  ): Promise<boolean> {
    try {
      await this.channel.send(userKey, text, kind);
      return true;
    } catch (err) {
      console.warn(`[gateway] 给 ${userKey} 发${what}失败:${String(err)}`);
      return false;
    }
  }
}
