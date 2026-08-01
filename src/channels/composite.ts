import { parseUserKey } from "../core/identity.js";
import type { AdmissionPolicy, AdmissionResult } from "../core/admission.js";
import type { Channel, MessageHandler } from "./types.js";

/**
 * 多渠道复合。按 userKey 的第一段(channel)把 send/recall 路由到对应渠道,
 * start/stop 扇出,onMessage 转发。
 *
 * 有了它,网关仍然只认识"一个 Channel",一行都不用改就能同时跑微信和
 * dashboard 聊天 —— 会话核心不该知道有几个渠道。
 */

export class CompositeChannel implements Channel {
  readonly name: string;
  private readonly byName: Map<string, Channel>;

  constructor(channels: Channel[]) {
    if (!channels.length) throw new Error("CompositeChannel 至少需要一个渠道");
    this.byName = new Map();
    for (const c of channels) {
      if (this.byName.has(c.name)) throw new Error(`渠道名重复: ${c.name}`);
      this.byName.set(c.name, c);
    }
    this.name = channels.map((c) => c.name).join("+");
    // recall 是可选能力:只要有任一子渠道支持,就对外声明支持,再按 userKey 分派。
    if (channels.some((c) => c.recall)) {
      this.recall = async (userKey, messageId) => {
        const target = this.route(userKey);
        if (!target.recall) return;
        await target.recall(userKey, messageId);
      };
    }
  }

  recall?: (userKey: string, messageId: string) => Promise<void>;

  onMessage(handler: MessageHandler): void {
    for (const c of this.byName.values()) c.onMessage(handler);
  }

  async send(userKey: string, text: string): Promise<string | void> {
    return this.route(userKey).send(userKey, text);
  }

  async start(): Promise<void> {
    for (const c of this.byName.values()) await c.start();
  }

  async stop(): Promise<void> {
    for (const c of this.byName.values()) await c.stop();
  }

  private route(userKey: string): Channel {
    const parts = parseUserKey(userKey);
    const target = parts ? this.byName.get(parts.channel) : undefined;
    if (!target) {
      // 把已注册的名字一并抛出来:这类错误几乎总是「渠道名与 userKey 第一段写岔了」,
      // 光说"没有能处理 X 的渠道"看不出差在哪,真机上排查要绕很久。
      const known = [...this.byName.keys()].join(", ") || "(无)";
      throw new Error(
        `没有能处理 ${userKey} 的渠道:需要名为 ${parts?.channel ?? "?"} 的渠道,已注册的是 ${known}`,
      );
    }
    return target;
  }
}

/**
 * 按渠道名分派准入策略。
 *
 * 和 CompositeChannel 配套使用:「谁能用」与「消息从哪来」是同一个决定,
 * 复合渠道也必须复合准入,否则新渠道很容易漏配、结果全放行。
 * 未登记的渠道一律拒绝(而不是放行)—— 漏配应当表现为不工作,不是没防护。
 */
export function compositeAdmission(byChannel: Record<string, AdmissionPolicy>): AdmissionPolicy {
  return (userKey: string): AdmissionResult => {
    const parts = parseUserKey(userKey);
    if (!parts) return { ok: false, reason: `非法 userKey: ${userKey}` };
    const policy = byChannel[parts.channel];
    if (!policy) return { ok: false, reason: `渠道 ${parts.channel} 没有配置准入策略` };
    return policy(userKey);
  };
}
