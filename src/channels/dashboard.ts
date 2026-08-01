import { BUILTIN_ADMIN_USER_KEY } from "../core/identity.js";
import { readJsonFile, writeJsonFileAtomic } from "../core/file-store.js";
import type { Channel, MessageHandler } from "./types.js";

/**
 * dashboard 聊天渠道。只有一个固定用户 —— 内置管理员。
 *
 * 与 iLink 的两个关键差别:
 *
 * **无订阅者时 send() 不能抛错**。浏览器刷新一下、网络抖一下,SSE 连接就断了;
 * 那时候抛错会把回复直接丢掉。所以消息一律先进缓冲(带自增 id),再推给当前订阅者;
 * 订阅时按 Last-Event-ID 补发缺口。
 *
 * **聊天记录落盘**。微信客户端自己存着聊天记录,网页没有 —— 缓冲只在内存里的话,
 * 重启后页面一片空白,而助手那边的会话仍在(未超时就会 resume),等于页面说
 * "没聊过"、助手说"我记得"。所以缓冲同时写进 chatLogPath。
 * 注意这份记录与会话上下文是**两件事**:`/新会话` 只让助手忘掉上下文,记录照旧 ——
 * 网页上把这个区别摆出来,是它比微信窗口能多做的事。
 *
 * 缓冲仍然是有界的(BUFFER_MAX 条),只保证"翻得到最近的对话";完整历史在会话
 * JSONL 里,dashboard 的会话页可以看。
 */

/** 缓冲保留的消息条数。够翻最近的对话,不做长期存储。 */
const BUFFER_MAX = 200;

export interface ChatMessage {
  id: number;
  /** bot = 助手发出的;user = 管理员自己发的(回显,便于刷新后看到上下文)。 */
  role: "bot" | "user";
  text: string;
  at: number;
}

/**
 * 推给订阅者的事件。删除来自 recall() —— 网关回合结束时会撤回"收到"回执,
 * 页面得跟着把那条抹掉,否则落盘后每一轮都永久留一条。
 */
export type ChatEvent = { type: "message"; msg: ChatMessage } | { type: "delete"; id: number };

export type ChatSubscriber = (ev: ChatEvent) => void;

/** 落盘格式。seq 单独存:最后一条被撤回后,id 也不能倒退回去重用。 */
interface ChatLog {
  seq: number;
  messages: ChatMessage[];
}

export interface DashboardChannelOptions {
  /** 聊天记录文件。不给则退化为纯内存(测试用)。 */
  path?: string;
  now?: () => number;
}

export class DashboardChannel implements Channel {
  readonly name = "dashboard";
  /** 本渠道唯一的用户:内置管理员。 */
  readonly userKey = BUILTIN_ADMIN_USER_KEY;

  private handler?: MessageHandler;
  private readonly buffer: ChatMessage[];
  private readonly subscribers = new Set<ChatSubscriber>();
  private seq: number;
  private readonly path: string | undefined;
  private readonly now: () => number;

  constructor(opts: DashboardChannelOptions = {}) {
    this.path = opts.path;
    this.now = opts.now ?? Date.now;
    const log = this.path
      ? readJsonFile<Partial<ChatLog>>(this.path, {})
      : ({} as Partial<ChatLog>);
    // 防御式解析:文件是人可改的,坏条目丢掉即可,不为历史格式留分支。
    this.buffer = Array.isArray(log.messages) ? log.messages.filter(isChatMessage) : [];
    // seq 取盘上的值与现存最大 id 的较大者:文件被手改过也不会发出重复 id。
    this.seq = Math.max(numberOr(log.seq, 0), ...this.buffer.map((m) => m.id), 0);
  }

  onMessage(h: MessageHandler): void {
    this.handler = h;
  }

  async send(userKey: string, text: string): Promise<string> {
    this.assertOwn(userKey);
    // 返回 id 让网关能撤回回执 —— 见 recall()。
    return String(this.push("bot", text).id);
  }

  /**
   * 撤回一条本渠道发过的消息。网关在回合结束时用它抹掉"收到"回执。
   * 不实现的话,落盘之后每一轮都会在记录里永久留下一条回执。
   */
  async recall(userKey: string, messageId: string): Promise<void> {
    this.assertOwn(userKey);
    const id = Number(messageId);
    const i = this.buffer.findIndex((m) => m.id === id);
    if (i < 0) return; // 已被环形挤出或已撤回:无事可做
    this.buffer.splice(i, 1);
    this.persist();
    this.emit({ type: "delete", id });
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.subscribers.clear();
  }

  /** 管理员在网页上发来一条消息。回显进缓冲,再交给网关。 */
  async receive(text: string): Promise<void> {
    this.push("user", text);
    await this.handler?.({ userKey: this.userKey, text });
  }

  /**
   * 订阅推送。afterId 来自 SSE 的 Last-Event-ID(重连)或页面的 ?after=(首连):
   * 先补发缺口再接实时,既不漏消息,也不会把首屏已经渲染过的历史再推一遍。
   * 返回退订函数。
   */
  subscribe(sub: ChatSubscriber, afterId = 0): () => void {
    for (const m of this.buffer) {
      if (m.id > afterId) sub({ type: "message", msg: m });
    }
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  /** 当前缓冲快照(首屏渲染用)。 */
  history(): ChatMessage[] {
    return [...this.buffer];
  }

  /**
   * 首屏水位:已发出过的最大 id。页面据此订阅。
   * 用 seq 而不是缓冲末条的 id —— 末条恰好被撤回时,水位不该跟着退回去。
   */
  lastId(): number {
    return this.seq;
  }

  private push(role: ChatMessage["role"], text: string): ChatMessage {
    const msg: ChatMessage = { id: ++this.seq, role, text, at: this.now() };
    this.buffer.push(msg);
    if (this.buffer.length > BUFFER_MAX) this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
    this.persist();
    this.emit({ type: "message", msg });
    return msg;
  }

  private emit(ev: ChatEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub(ev);
      } catch (err) {
        console.error("[dashboard-chat] 推送订阅者失败:", err);
      }
    }
  }

  /**
   * 每次变更都整份原子写回,不做节流合并。一条消息一次几 KB 的 write+rename,
   * 而消息量的上限就是助手说话的速度;换来的是没有定时器、也就没有
   * "关闭时忘了 flush"这一整类坑。
   */
  private persist(): void {
    if (!this.path) return;
    try {
      const log: ChatLog = { seq: this.seq, messages: this.buffer };
      writeJsonFileAtomic(this.path, log);
    } catch (err) {
      // 落盘失败不能影响聊天本身:内存里的缓冲仍然完整,页面照常工作。
      console.error("[dashboard-chat] 写入聊天记录失败:", err);
    }
  }

  private assertOwn(userKey: string): void {
    if (userKey !== this.userKey) {
      throw new Error(`dashboard 渠道只服务 ${this.userKey},收到 ${userKey}`);
    }
  }
}

function isChatMessage(v: unknown): v is ChatMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m["id"] === "number" &&
    Number.isFinite(m["id"]) &&
    (m["role"] === "bot" || m["role"] === "user") &&
    typeof m["text"] === "string" &&
    typeof m["at"] === "number"
  );
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
