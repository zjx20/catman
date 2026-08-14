import { randomBytes } from "node:crypto";
import { readJsonFile, writeJsonFileAtomic } from "./file-store.js";

/**
 * 推送令牌 —— 每人一枚、长期有效、**只能做一件事**:给自己推一条消息。
 *
 * ## 为什么不能复用回合令牌
 *
 * 回合令牌(`turn-tokens.ts`)回合一结束就作废,这是它的价值所在。但脱钩的后台
 * 任务恰恰活得比回合久 —— 它跑完时那枚令牌早没了,于是"跑完通知你"这句话
 * 永远兑现不了(整个 catman 里唯一一个"承诺了却做不到"的地方)。
 *
 * 所以另开一枚:**寿命与回合无关**,落盘,进程重启也还在。
 *
 * ## 为什么敢让它长期有效
 *
 * 因为它的能力上限就是"给它自己那个 userKey 推一条文本"。
 * 而 agent 在回合里本来就能给这个用户说话 —— 拿到它不构成任何提权,
 * 唯一的新增能力是**在回合之外**说话,而那正是我们要的东西。
 *
 * 它与 IPC secret 的差别是决定性的,值得写下来免得后人"顺手统一一下":
 * IPC secret 能冒充任意 userKey、能读别人的收件箱、能走 /admin/* 删账号;
 * 这枚令牌解析出来只有一个 userKey,而且只有一条出路。
 *
 * ## 一人一枚,不轮换
 *
 * 不做 TTL 也不做轮换,是因为过期恰好会在**最不该失效的时刻**失效:一个跑了
 * 六小时的任务终于跑完,拿着一枚半路过期的令牌去推,结果 401 —— 我们修的正是
 * 这个病,不能自己再造一个。真要作废就删 `notify-tokens.json` 里那一行,
 * 下次回合会重铸一枚(代价是在飞的旧任务推不出来,所以这是人工动作,不是定时任务)。
 */

/** 盘上格式:userKey → token。刻意扁平 —— 将来要加字段,值换成对象即可,老代码读到字符串照常工作。 */
type NotifyTokenFile = Record<string, string>;

export class NotifyTokens {
  private readonly byUser = new Map<string, string>();
  private readonly byToken = new Map<string, string>();

  constructor(private readonly path: string) {
    const raw = readJsonFile<NotifyTokenFile>(path, {});
    for (const [userKey, token] of Object.entries(raw)) {
      if (typeof token !== "string" || !token) continue;
      this.byUser.set(userKey, token);
      this.byToken.set(token, userKey);
    }
  }

  /**
   * 取这个用户的令牌,没有就铸一枚并落盘。
   *
   * 幂等:同一个 userKey 反复调拿到的是同一枚 —— 每个回合都换一枚的话,
   * 上一个回合放出去的后台任务就在下一个回合开始时哑掉了。
   */
  for(userKey: string): string {
    const have = this.byUser.get(userKey);
    if (have) return have;
    const token = randomBytes(32).toString("hex");
    this.byUser.set(userKey, token);
    this.byToken.set(token, userKey);
    this.persist();
    return token;
  }

  /** 令牌 → userKey。无效令牌返回 undefined。 */
  resolve(token: string): string | undefined {
    return this.byToken.get(token);
  }

  private persist(): void {
    const out: NotifyTokenFile = {};
    for (const [userKey, token] of this.byUser) out[userKey] = token;
    // 0600:它是凭据。与 accounts.json 同一条规矩(见 file-store 里 mode 的说明)。
    writeJsonFileAtomic(this.path, out, 0o600);
  }
}
