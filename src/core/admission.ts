import type { AccountStore } from "./accounts.js";
import { parseUserKey } from "./identity.js";

/**
 * 准入控制。接入者拿到的是「容器内任意命令 + 宿主 docker.sock(等于宿主 root)
 * + 订阅额度」,所以在做任何工作之前先决定这条消息该不该处理。
 *
 * 策略以函数形式注入网关:微信走账号绑定(TOFU),stdin 本地测试通道直接放行。
 * 不在网关里按渠道名写 if,是为了让「谁能用」这件事只有一处定义。
 */

export type AdmissionResult =
  | { ok: true }
  | {
      ok: false;
      /** 回给对方的话。留空表示完全静默(不回任何内容)。 */
      reply?: string;
      /** 记进日志的原因。 */
      reason: string;
    };

export type AdmissionPolicy = (userKey: string) => AdmissionResult;

/** 本地测试通道等可信来源:一律放行。 */
export const allowAll: AdmissionPolicy = () => ({ ok: true });

/**
 * 基于账号绑定的准入:每个账号只服务一个对端(它的主人)。
 *
 * 绑定用 TOFU(trust on first use):账号建立后收到的第一条消息,其发送者被记为主人。
 * 之后其他人的来信一律拒绝。之所以能用 TOFU,是因为一次扫码得到的 bot 就是扫码那个
 * 微信号自己的 bot,别人发不进来;dashboard 会把「已绑定 <userId>」显示出来供核对,
 * 发现不对可以解绑重来。
 */
export function accountAdmission(accounts: AccountStore): AdmissionPolicy {
  return (userKey) => {
    const parts = parseUserKey(userKey);
    if (!parts) return { ok: false, reason: `非法 userKey: ${userKey}` };

    const account = accounts.get(parts.accountId);
    if (!account) {
      // 账号已被删除,但连接还在收尾/消息在途。静默丢弃。
      return { ok: false, reason: `账号 ${parts.accountId} 不存在` };
    }

    if (!account.boundUserId) {
      accounts.bind(parts.accountId, parts.userId);
      console.info(`[admission] 账号 ${parts.accountId} 绑定到 ${parts.userId}`);
      return { ok: true };
    }

    if (account.boundUserId === parts.userId) return { ok: true };

    accounts.recordRejection(parts.accountId, parts.userId);
    return {
      ok: false,
      reason: `账号 ${parts.accountId} 已绑定 ${account.boundUserId},拒绝 ${parts.userId}`,
      reply: "这个助手没有对你开放。",
    };
  };
}
