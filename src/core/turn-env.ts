/**
 * agent 子进程的环境变量。
 *
 * **一处定义,两个调用方**:用户回合(gateway)与定时 agent 任务(cron)。抄两份
 * 的下场是它们慢慢走样,而走样的方向恰好是"某一份忘了剔除某个变量" —— 那种错
 * 没有任何症状,直到有人发现助手手里有它本不该有的凭据。
 */

export interface TurnEnvOptions {
  /** 本机 HTTP 接口地址。 */
  readonly apiBase: string;
  /** 本回合(或本次任务)的一次性令牌。 */
  readonly sessionToken: string;
  /** 管理员回合才把 admin token 加回去。 */
  readonly isAdmin: boolean;
}

/**
 * 组装子进程环境。
 *
 * ⚠️ **两个变量必须剔除,而且 IPC secret 一条例外都没有**(管理员也拿不到)。
 *
 * 拿到 IPC secret 就等于拿到信使的整个控制面:同容器、同 uid,一句
 * `curl --unix-socket /data/ipc/courier.sock` 就能 ① 冒充任何 userKey 发消息,
 * 顺带烧光**别人**那条来信的 10 条预算(第 11 条起 ret=-2 永不恢复 = 把那个人
 * 打成永久静默);② 拉走并 ack 掉别人的消息(一个人格一个 inbox,全体用户共用),
 * spool 里的图片字节也读得到;③ 走 /admin/* 删账号、解绑、改名 —— 而人格侧
 * 刻意一行 accounts.ts 都不留,正是为了不出现第二个写者,这条路会把那道墙整个绕过去。
 *
 * 管理员令牌还有"admin 回合加回"这一档,IPC secret 没有:回合不需要它,一次都不需要。
 */
export function buildTurnEnv(opts: TurnEnvOptions): Record<string, string | undefined> {
  const { CATMAN_ADMIN_TOKEN, CATMAN_IPC_SECRET: _ipc, ...rest } = process.env;
  return {
    ...rest,
    CATMAN_API_BASE: opts.apiBase,
    CATMAN_SESSION_TOKEN: opts.sessionToken,
    ...(opts.isAdmin ? { CATMAN_ADMIN_TOKEN } : {}),
  };
}
