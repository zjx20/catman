import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Channel, ChannelHealth, MessageHandler } from "./types.js";
import { WECHAT_CHANNEL } from "./ilink-protocol.js";
import type { Attachment } from "../core/attachments.js";
import type { CourierLink } from "../ipc/client.js";
import type { AttachmentRef, InboundEnvelope, SendKind } from "../ipc/protocol.js";

/**
 * 人格这一侧的微信渠道 —— 真正的连接在信使里,这里只是一根管子。
 *
 * ## 为什么 name 仍然是 "wechat"
 *
 * `Channel.name` **必须等于该渠道产出的 userKey 第一段**(真机踩过:两处写岔的话
 * 准入、入队、agent 全都正常,只有最后 send 那一步抛「没有能处理 X 的渠道」,
 * 额度已经花掉而用户那边彻底没反应)。userKey 由信使拼、以 `wechat:` 开头,
 * 所以这里也必须是 `WECHAT_CHANNEL` —— 两处引用同一个常量,使写岔不可能发生。
 *
 * ## 三条不能改的时序
 *
 * ① **控制帧先于消息应用。** `detach` 说的是"这个用户已经不归你了",先应用它,
 *    后面那批消息才不会落进一个刚被切走的会话。
 * ② **同步逐条投递。** 微信的「图 + 文字」是两条相隔约 120ms 的消息,顺序即语义。
 *    并发投递会让它们颠倒着进聚合窗口。信使侧"下载完成才入队"与这里的"逐条 await"
 *    是同一个保证在新边界上的两半,各有单测。
 * ③ **落进批之后才 ack。** handler 返回意味着消息已经进了聚合批/队列,那之后信使
 *    才能出队。提前 ack 的话,进程在聚合窗口那 1.5 秒里被杀 = 消息真丢,
 *    而信使按"拉取间隔"判活恰好判不出这种死法。
 */

/** 记住最近见过多少个 msgId 用于去重。够覆盖一次崩溃重放的整批,又不占内存。 */
const SEEN_LIMIT = 500;

/** 拉取失败后的退避。信使可能正在被人工 bless 重启,人格不该跟着崩。 */
const BACKOFF_MS = 3000;

/** 服务端挂起时长。客户端超时由 IpcClient 自己加余量 —— 别在这里各算一份。 */
const PULL_WAIT_MS = 25_000;

export interface BridgeOptions {
  client: CourierLink;
  /** 附件 spool 目录(信使写、人格只读)。 */
  spoolDir: string;
  /**
   * 收到 detach 控制帧。接到网关的"把这个用户的在飞回合转后台"上。
   *
   * 不做成 `Channel` 接口的一部分:那是这条链路独有的东西,塞进接口会让每个渠道
   * 都要面对一个跟自己无关的概念。
   */
  onDetach?: (userKey: string) => void;
}

export class BridgeChannel implements Channel {
  readonly name = WECHAT_CHANNEL;

  private handler?: MessageHandler;
  private running = false;
  private loop?: Promise<void>;
  /** 见过的 msgId(有界)。at-least-once 投递下靠它把重复变成无害。 */
  private readonly seen = new Set<string>();
  /** 最近一次成功拉取的时刻。`live` 靠它 —— 连不上信使时渠道其实是聋的。 */
  private lastOk = 0;

  constructor(private readonly opts: BridgeOptions) {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loop = this.pullLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
  }

  async send(userKey: string, text: string, kind: SendKind = "body"): Promise<void> {
    const r = await this.opts.client.send(userKey, text, kind);
    if (!r.ok) throw new Error(r.reason ?? "信使拒绝了这条消息");
  }

  /**
   * 健康自述。`live` 要求**最近确实拉取成功过** —— 与 iLink 渠道那条同源:
   * "已启动"不等于"收得到消息",而部署的健康门正是靠这份自述判断新版本真的在服务。
   */
  health(): readonly ChannelHealth[] {
    const live = this.running && Date.now() - this.lastOk < PULL_WAIT_MS * 2;
    return [{ name: this.name, started: this.running, live }];
  }

  // --- 内部 ---

  private async pullLoop(): Promise<void> {
    while (this.running) {
      try {
        const pulled = await this.opts.client.pull(PULL_WAIT_MS);
        this.lastOk = Date.now();
        if (!pulled) {
          // 整个响应读不懂 —— 这是契约漂移最粗暴的形态。退避,别打爆信使。
          console.error("[bridge] 信使的拉取响应整体读不懂,退避重试");
          await this.sleep(BACKOFF_MS);
          continue;
        }

        // ① 控制帧先应用(见文件头时序 ①)。
        for (const c of pulled.controls) {
          if (c.type === "detach") this.opts.onDetach?.(c.userKey);
        }

        // ② 读不懂的单条要 **NACK 亮红灯**,不能静默丢 —— 否则契约漂移的表现是
        //    "消息神秘消失",那是最难查的一种。
        if (pulled.badMsgIds.length || pulled.unparsable) {
          console.error(
            `[bridge] ${pulled.badMsgIds.length} 条读不懂(另有 ${pulled.unparsable} 条连 id 都认不出)`,
          );
          await this.opts.client
            .nack(pulled.badMsgIds, "人格解析不了这个信封")
            .catch((e) => console.warn(`[bridge] NACK 失败:${String(e)}`));
        }

        // ③ 同步逐条投递,落批之后才 ack(时序 ② ③)。
        const done: string[] = [];
        for (const m of pulled.messages) {
          try {
            await this.deliver(m);
            done.push(m.msgId);
          } catch (err) {
            // 单条投递失败不拖累后面的:它留在信使队列里,下一轮再来。
            console.error(`[bridge] 投递 ${m.msgId} 失败,留给下一轮:${String(err)}`);
            break;
          }
        }
        if (done.length) await this.opts.client.ack(done);
        if (!pulled.messages.length && !pulled.controls.length) continue;
      } catch (err) {
        if (!this.running) break;
        // 信使不可达是**可以容忍**的:它跑 pinned release,人工 bless 时会重启。
        console.warn(`[bridge] 拉取失败,${BACKOFF_MS}ms 后重试:${String(err)}`);
        await this.sleep(BACKOFF_MS);
      }
    }
  }

  private async deliver(m: InboundEnvelope): Promise<void> {
    if (this.seen.has(m.msgId)) {
      // 重复投递是 at-least-once 的正常代价(信使崩在"已入队、游标未落盘"之间时
      // 整批会重放)。**认出来直接跳过**,否则用户会看到同一句话被回答两次。
      return;
    }
    const attachments = this.loadAttachments(m.attachmentRefs);
    await this.handler?.({
      userKey: m.userKey,
      msgId: m.msgId,
      text: m.text,
      ...(attachments.length ? { attachments } : {}),
    });
    this.remember(m.msgId);
  }

  /**
   * 按引用把附件字节读回来。
   *
   * **单张读不到只跳过它自己**,文字与其余图片照常投递 —— 与渠道侧那条纪律一致:
   * 整条消息因为一张图挂掉,在用户那边就是"发了没反应"。
   */
  private loadAttachments(refs: readonly AttachmentRef[]): Attachment[] {
    const out: Attachment[] = [];
    for (const ref of refs) {
      try {
        const bytes = readFileSync(join(this.opts.spoolDir, ref.id));
        out.push({
          kind: "image",
          mediaType: ref.mediaType,
          data: bytes.toString("base64"),
          bytes: bytes.length,
        });
      } catch (err) {
        console.warn(`[bridge] 读不到附件 ${ref.id},跳过这一张:${String(err)}`);
      }
    }
    return out;
  }

  private remember(msgId: string): void {
    this.seen.add(msgId);
    if (this.seen.size > SEEN_LIMIT) {
      // Set 保持插入顺序,删最早的那个。
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
