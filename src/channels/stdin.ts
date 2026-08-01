import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Channel, MessageHandler } from "./types.js";
import { makeUserKey, parseUserKey } from "../core/identity.js";
import {
  describeReject,
  toImageAttachment,
  type Attachment,
  type AttachmentLimits,
} from "../core/attachments.js";

/**
 * 本地测试通道:从 stdin 读取每一行作为用户消息,回复打印到 stdout。
 *
 * 支持 `/user <名字>` 切换身份,默认 "local"。多用户隔离(各自的会话与工作目录)
 * 因此可以完全脱离微信在本地验证 —— 否则唯一的验证路径就是真机扫码。
 *
 * 图片同理:`/img <路径> [附言]` 走的是与微信图片**完全相同**的下游链路
 * (同一个 Attachment、同一个网关、同一个 Agent 组装),差别只在字节从哪来。
 * 没有它,多模态就只能靠真机扫码验证。
 */

const CHANNEL = "stdin";
const ACCOUNT = "local";
const DEFAULT_USER = "local";

export class StdinChannel implements Channel {
  // 与 makeUserKey 的第一段共用同一个常量 —— 两处写岔会导致回复路由不回来。
  readonly name = CHANNEL;
  private handler?: MessageHandler;
  private rl?: ReturnType<typeof createInterface>;
  private currentUser = DEFAULT_USER;

  /** 与微信渠道同源的上限(见 core/attachments.ts),按函数取以便运行时改配置即时生效。 */
  constructor(private readonly limits: () => AttachmentLimits) {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async send(userKey: string, text: string): Promise<void> {
    const who = parseUserKey(userKey)?.userId ?? userKey;
    process.stdout.write(`\n[${who}] ${text}\n> `);
  }

  async start(): Promise<void> {
    this.rl = createInterface({ input: process.stdin });
    process.stdout.write(`(当前身份 ${this.currentUser};用 "/user <名字>" 切换)\n> `);
    this.rl.on("line", (line) => {
      const text = line.trim();
      if (!text) {
        process.stdout.write("> ");
        return;
      }
      const switched = text.match(/^\/user\s+(\S+)$/);
      if (switched?.[1]) {
        this.currentUser = switched[1];
        process.stdout.write(`(已切换到 ${this.currentUser})\n> `);
        return;
      }
      const img = text.match(/^\/img\s+(\S+)(?:\s+([\s\S]*))?$/);
      if (img?.[1]) {
        void this.sendImage(img[1], img[2]?.trim() ?? "");
        return;
      }
      void this.handler?.({
        userKey: makeUserKey(CHANNEL, ACCOUNT, this.currentUser),
        text,
      });
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }

  /** 读本地图片文件当作附件发出去。校验用的是与微信那条路一模一样的函数。 */
  private async sendImage(path: string, caption: string): Promise<void> {
    let attachment: Attachment;
    try {
      const result = toImageAttachment(await readFile(path), this.limits());
      if (!result.ok) {
        process.stdout.write(`\n(${describeReject(result.reject)})\n> `);
        return;
      }
      attachment = result.attachment;
    } catch (err) {
      process.stdout.write(`\n(读不到 ${path}: ${(err as Error).message})\n> `);
      return;
    }
    process.stdout.write(
      `(已附上 ${path},${attachment.mediaType},${attachment.bytes} 字节)\n`,
    );
    await this.handler?.({
      userKey: makeUserKey(CHANNEL, ACCOUNT, this.currentUser),
      text: caption,
      attachments: [attachment],
    });
  }
}
