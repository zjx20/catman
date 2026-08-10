import { readJsonFile, writeJsonFileAtomic } from "../core/file-store.js";
import { parseCommand, type CommandDef } from "../core/commands.js";
import type { Attachment } from "../core/attachments.js";
import {
  IPC_SCHEMA,
  parseOutbound,
  type AttachmentRef,
  type ControlEnvelope,
  type PersonaId,
  type PullResponse,
  type SendKind,
  type SendResult,
} from "../ipc/protocol.js";
import type { AdminResponse, CourierApi } from "../ipc/server.js";
import { Inbox, inboundOf } from "./inbox.js";
import { Spool } from "./spool.js";
import type { ReplyStore } from "./reply-store.js";
import {
  RoutingTable,
  routeExpiredText,
  switchedToPrimaryText,
  switchedToRescueText,
} from "./routing.js";
import { fallbackText } from "./fallback.js";
import type { SettingsView } from "./settings-view.js";

/**
 * 信使的核心:把一条来信送到对的人格,把人格的回复送回微信。
 *
 * 它是 IPC 层眼里的 `CourierApi`,也是渠道眼里的消息处理器。刻意不认识 iLink ——
 * 渠道那一侧由 `wechat-ilink.ts` 负责,这里只收「userKey + 文本 + 附件」。
 *
 * ## 三条它必须守住的性质
 *
 * ① **单条消息是一个故障域。** 任何一步失败都只影响这一条:记录、告警、继续。
 *    连接层已经守了一道(见 pollLoop),这里是第二道 —— 入队失败同样不能掀翻循环。
 * ② **人格不可达时要有人说话。** 目标人格超过阈值没来拉取,信使自己回一句
 *    路由感知的兜底,并且**消息仍留在队列里**等它起来。
 * ③ **greeting 只推一次,判定权在这里。** 信使是唯一见过某个 userKey 全部历史的
 *    进程;放在人格里的话,用户第一次 `/救援` 会收到守护人格的整份欢迎语。
 */

/** 人格多久没来拉取就算"不可达"。比一次正常长轮询明显长。 */
const UNREACHABLE_AFTER_MS = 90_000;

/** 同一个用户两次兜底之间至少隔这么久 —— 兜底也吃预算,不能每条消息回一次。 */
const FALLBACK_COOLDOWN_MS = 5 * 60_000;

/** 一次拉取最多返回几条。够一个聚合批用,又不至于让人格一口吃下太多。 */
const PULL_BATCH = 20;

export interface CourierSend {
  (userKey: string, text: string, kind: SendKind): Promise<void>;
}

export interface CourierCoreOptions {
  inboxes: ReadonlyMap<PersonaId, Inbox>;
  routing: RoutingTable;
  replies: ReplyStore;
  spool: Spool;
  settings: SettingsView;
  /** 真正把字节发出去(渠道)。 */
  send: CourierSend;
  /** 见过谁的记录(greeting 判定)。 */
  greetedPath: string;
  /** 应急绑定口令。空 = 没配,`/绑定` 一律拒绝。 */
  bindPassphrase?: string;
  /** 收到有效 `/绑定` 时强制完成绑定。返回给用户的一句话。 */
  onForceBind?: (userKey: string) => string;
  /** 守护人格状态页地址,兜底文案里给出。 */
  rescueStatusUrl?: string;
  now?: () => number;
  /** admin API 的实现(账号管理)。由入口注入。 */
  admin?: (method: string, path: string, body: unknown) => Promise<AdminResponse>;
}

export class CourierCore implements CourierApi {
  private readonly now: () => number;
  /** 每人格上次来拉取的时刻。判"不可达"用它。 */
  private readonly lastPull = new Map<PersonaId, number>();
  /** 等着被拉走的控制帧。 */
  private readonly controls = new Map<PersonaId, ControlEnvelope[]>();
  /** 长轮询的等待者:有新消息时立刻唤醒,不必等满 waitMs。 */
  private readonly waiters = new Map<PersonaId, Array<() => void>>();
  /** 已经打过招呼的 userKey。落盘 —— 重启后重发欢迎语是白吃预算。 */
  private greeted: Set<string>;
  /** 上次给谁发过兜底,防刷屏。 */
  private readonly lastFallback = new Map<string, number>();
  /** 每人格投递失败(NACK)的累计条数。非零 = 契约漂移的红灯。 */
  private readonly nacked = new Map<PersonaId, number>();

  constructor(private readonly opts: CourierCoreOptions) {
    this.now = opts.now ?? (() => Date.now());
    // **"还没拉取过"不等于"不可达"。** 初值给 0 的话,信使刚起来时的第一条消息
    // 必定触发一句"主人格没有响应"—— 而主人格可能正常得很,只是还没来得及拉第一次
    // (它要先起 dashboard、装配、连 socket)。用启动时刻打底之后,判据变成
    // "信使已经活了超过阈值,而这个人格一次都没来过",那才是真的不可达。
    const startedAt = this.now();
    for (const persona of opts.inboxes.keys()) this.lastPull.set(persona, startedAt);
    const raw = readJsonFile<{ greeted?: unknown }>(opts.greetedPath, {});
    this.greeted = new Set(
      Array.isArray(raw.greeted) ? raw.greeted.filter((x): x is string => typeof x === "string") : [],
    );
  }

  // ── 入站:渠道 → 信使 ────────────────────────────────────────────

  /**
   * 一条来信。**绝不抛** —— 调用方是长轮询循环,抛出去就等于让一条消息停掉整个渠道。
   */
  async accept(msg: {
    msgId: string;
    userKey: string;
    text: string;
    attachments?: readonly Attachment[];
  }): Promise<void> {
    try {
      // ① 信使自己消化的指令。**在路由与投递之前** —— `/救援` 的全部意义就是
      //    主人格卡死时它照样管用,进了队列就没这个性质了。
      const handled = await this.tryCourierCommand(msg.userKey, msg.text);
      if (handled) return;

      const persona = this.opts.routing.personaFor(msg.userKey);
      this.opts.routing.touch(msg.userKey);

      // ② 附件落盘,队列里只留引用。
      const refs: AttachmentRef[] = [];
      for (const a of msg.attachments ?? []) {
        refs.push(
          this.opts.spool.put(Buffer.from(a.data, "base64"), a.mediaType, () =>
            Math.random().toString(36).slice(2, 10),
          ),
        );
      }

      const box = this.opts.inboxes.get(persona);
      if (!box) {
        console.error(`[courier] 没有 ${persona} 的收件队列,消息丢弃:${msg.userKey}`);
        return;
      }
      box.push(
        inboundOf({
          msgId: msg.msgId,
          userKey: msg.userKey,
          text: msg.text,
          attachmentRefs: refs,
          greeted: this.greeted.has(msg.userKey),
          ts: this.now(),
        }),
      );
      this.markGreeted(msg.userKey);
      this.wake(persona);

      // ③ 目标人格不可达就自己说句话。消息**仍留在队列里**等它起来。
      await this.maybeFallback(persona, msg.userKey);
    } catch (err) {
      console.error(`[courier] 处理来信失败(已跳过这一条):${msg.userKey} ${String(err)}`);
    }
  }

  /**
   * 信使侧的硬指令。返回 true 表示已消化,不再投给任何人格。
   *
   * 权限现查(读 settings.json):管理员名单在 dashboard 上随时可改,提权/降权都该
   * 立刻生效。挡掉的处理与人格侧一致 —— **当它不是指令**,照常往下走投给人格,
   * 于是非管理员既用不了也看不出它存在。
   */
  private async tryCourierCommand(userKey: string, text: string): Promise<boolean> {
    const parsed = parseCommand(text);
    if (!parsed || parsed.cmd.where !== "courier") return false;
    const cmd: CommandDef = parsed.cmd;
    if (cmd.adminOnly && !this.opts.settings.isAdmin(userKey)) return false;

    switch (cmd.name) {
      case "rescue":
        return await this.switchPersona(userKey, "rescue");
      case "primaryPersona":
        return await this.switchPersona(userKey, "primary");
      case "bind": {
        const pass = this.opts.bindPassphrase;
        if (!pass) {
          await this.reply(userKey, "这台机器没有配应急绑定口令。", "fallback");
          return true;
        }
        // 口令不对时**不说"口令错了"**:那等于把这条指令的存在告诉了任何人。
        // 与 adminOnly 的处理同一取向 —— 当它不是指令,照常走下去。
        if (parsed.arg !== pass) return false;
        const said = this.opts.onForceBind?.(userKey) ?? "已完成绑定。";
        await this.reply(userKey, said, "fallback");
        return true;
      }
      default:
        return false;
    }
  }

  private async switchPersona(userKey: string, to: PersonaId): Promise<boolean> {
    const { changed, previous } = this.opts.routing.switchTo(userKey, to);
    if (changed) {
      // detach 发给**被切走的**那一个:它手里可能有这个用户的在飞回合,
      // 要转后台跑完并带上出处前缀。评审专门点过"标出处的是被切走的那个"。
      this.pushControl(previous, { schema: IPC_SCHEMA, type: "detach", userKey });
    }
    await this.reply(userKey, to === "rescue" ? switchedToRescueText() : switchedToPrimaryText(), "fallback");
    return true;
  }

  /** 把超时的路由拨回默认,并**告知**用户 —— 悄悄拨回去比忘了切回还糟。 */
  async sweepRoutes(): Promise<void> {
    for (const e of this.opts.routing.sweepExpired()) {
      this.pushControl(e.from, { schema: IPC_SCHEMA, type: "detach", userKey: e.userKey });
      await this.reply(e.userKey, routeExpiredText(e.from), "fallback");
    }
  }

  // ── CourierApi:人格 → 信使 ──────────────────────────────────────

  async pull(persona: PersonaId, waitMs: number, signal: AbortSignal): Promise<PullResponse> {
    this.lastPull.set(persona, this.now());
    const box = this.opts.inboxes.get(persona);
    const ctrls = this.controls.get(persona) ?? [];
    const ready = (): boolean => (box?.depth() ?? 0) > 0 || ctrls.length > 0;

    if (!ready() && waitMs > 0) await this.waitFor(persona, waitMs, signal);

    // 控制帧**取走即清**:它们不像消息那样需要 ack —— 一次 detach 没送到的代价是
    // 一个在飞回合没转后台,而重发一次 detach 的代价是把一个正常回合误转后台。
    const taken = ctrls.splice(0, ctrls.length);
    this.lastPull.set(persona, this.now());
    return {
      schema: IPC_SCHEMA,
      controls: taken,
      messages: [...(box?.peek(PULL_BATCH) ?? [])],
    };
  }

  async ack(persona: PersonaId, msgIds: readonly string[]): Promise<void> {
    const box = this.opts.inboxes.get(persona);
    if (!box) return;
    // 附件要在**出队之后**才删:提早删的话人格重启后拿着引用读到 ENOENT,
    // 而消息还在队列里未 ack,于是它永远重试一条永远读不到图的消息。
    const going = box.peek(Number.MAX_SAFE_INTEGER).filter((m) => msgIds.includes(m.msgId));
    box.ack(msgIds);
    this.opts.spool.drop(going.flatMap((m) => m.attachmentRefs.map((r) => r.id)));
  }

  async nack(persona: PersonaId, msgIds: readonly string[], reason: string): Promise<void> {
    // **亮红灯,不静默。** 契约漂移(人格读不懂信使的信封)的表现必须是这一行日志,
    // 而不是"消息神秘消失"——后者是最难查的一种失败。
    this.nacked.set(persona, (this.nacked.get(persona) ?? 0) + msgIds.length);
    console.error(
      `[courier] ${persona} 读不懂 ${msgIds.length} 条消息(累计 ${this.nacked.get(persona)}):` +
        `${reason} — 多半是 IPC 契约漂移,检查两边的版本`,
    );
    // 出队:留着它只会让人格每次拉取都再读不懂一次,把队列钉死在这一条上。
    await this.ack(persona, msgIds);
  }

  async send(persona: PersonaId, out: unknown): Promise<SendResult> {
    const env = parseOutbound(out);
    if (!env) {
      return { schema: IPC_SCHEMA, ok: false, remainingProgress: 0, reason: "出站信封读不懂" };
    }
    // **路由校验**:已经切到别的人格的用户,旧人格发来的正文不该再送出去 ——
    // 那会让用户在跟守护人格说话的中途收到主人格的答复,而且白吃一条预算。
    // 例外是 detach 之后的后台回合结果,它带着出处前缀、是用户主动要的,所以放行 body。
    const routed = this.opts.routing.personaFor(env.userKey);
    if (routed !== persona && env.kind === "progress") {
      return {
        schema: IPC_SCHEMA,
        ok: false,
        remainingProgress: 0,
        reason: "这个用户已经切到别的人格了",
      };
    }
    try {
      await this.opts.send(env.userKey, env.text, env.kind);
      return {
        schema: IPC_SCHEMA,
        ok: true,
        remainingProgress: this.opts.replies.remainingProgress(env.userKey),
      };
    } catch (err) {
      return {
        schema: IPC_SCHEMA,
        ok: false,
        remainingProgress: this.opts.replies.remainingProgress(env.userKey),
        reason: String(err),
      };
    }
  }

  async admin(_persona: PersonaId, method: string, path: string, body: unknown): Promise<AdminResponse> {
    if (!this.opts.admin) return { status: 501, body: { ok: false, reason: "信使没有配 admin API" } };
    return await this.opts.admin(method, path, body);
  }

  // ── 观测 ────────────────────────────────────────────────────────

  /** 每人格的队列深度。**排水的第二个真相源**(第一个是人格的 /health)。 */
  depths(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [p, box] of this.opts.inboxes) out[p] = box.depth();
    return out;
  }

  /** 丢弃与读不懂的累计条数。非零就该在状态页显眼。 */
  losses(): Record<string, { dropped: number; nacked: number }> {
    const out: Record<string, { dropped: number; nacked: number }> = {};
    for (const [p, box] of this.opts.inboxes) {
      out[p] = { dropped: box.droppedCount(), nacked: this.nacked.get(p) ?? 0 };
    }
    return out;
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private pushControl(persona: PersonaId, ctrl: ControlEnvelope): void {
    const list = this.controls.get(persona) ?? [];
    list.push(ctrl);
    this.controls.set(persona, list);
    this.wake(persona);
  }

  /** 发一条信使自己的话。失败只记日志 —— 它是解释,不该反过来把流程搞挂。 */
  private async reply(userKey: string, text: string, kind: SendKind): Promise<void> {
    try {
      await this.opts.send(userKey, text, kind);
    } catch (err) {
      console.warn(`[courier] 给 ${userKey} 发信失败:${String(err)}`);
    }
  }

  private async maybeFallback(persona: PersonaId, userKey: string): Promise<void> {
    const last = this.lastPull.get(persona) ?? 0;
    if (this.now() - last < UNREACHABLE_AFTER_MS) return;
    const lastSaid = this.lastFallback.get(userKey) ?? 0;
    if (this.now() - lastSaid < FALLBACK_COOLDOWN_MS) return;
    this.lastFallback.set(userKey, this.now());
    await this.reply(
      userKey,
      fallbackText({
        persona,
        isAdmin: this.opts.settings.isAdmin(userKey),
        ...(this.opts.rescueStatusUrl ? { rescueStatusUrl: this.opts.rescueStatusUrl } : {}),
      }),
      "fallback",
    );
  }

  private markGreeted(userKey: string): void {
    if (this.greeted.has(userKey)) return;
    this.greeted.add(userKey);
    writeJsonFileAtomic(this.opts.greetedPath, { greeted: [...this.greeted] });
  }

  private wake(persona: PersonaId): void {
    const list = this.waiters.get(persona);
    if (!list?.length) return;
    this.waiters.set(persona, []);
    for (const w of list) w();
  }

  /**
   * 等到有东西可拿、或者超时、或者被中止。
   *
   * 定时器**不 unref**:它欠着一个在飞的 HTTP 响应。unref 掉的话"只剩这个请求没做完"
   * 时进程会直接退出,而人格那边看到的是连接被掐断 —— 与聚合窗口那条不变量同理。
   */
  private waitFor(persona: PersonaId, waitMs: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      const list = this.waiters.get(persona) ?? [];
      list.push(finish);
      this.waiters.set(persona, list);
      if (signal.aborted) finish();
      else signal.addEventListener("abort", finish, { once: true });
    });
  }
}
