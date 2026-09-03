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
  /**
   * 这个用户的推送令牌(长期有效,见 core/notify-tokens.ts)。
   *
   * **和 sessionToken 一起注入,但寿命完全不同** —— 它就是给脱钩的后台任务用的:
   * 回合结束时 sessionToken 作废,而后台任务往往那时候才跑到一半。
   */
  readonly notifyToken?: string;
  /**
   * 要挂进 PATH 最前面的目录(`catman-notify` 住在那儿)。
   *
   * 挂 PATH 而不是给绝对路径:助手写命令时会照着 skill 里的样子抄,
   * 而 skill 里写 `catman-notify run -- …` 比写一长串路径更不容易抄错。
   */
  readonly binDir?: string;
  /**
   * 这个用户的私有目录在**回合容器里**的路径(常量 `/private`)。
   *
   * 给了才注入 `CATMAN_USER_PRIVATE_DIR`。**没挂载就绝不能注入** ——
   * 变量在而目录不在,脚本会往一个不存在的地方写凭据,或者更糟:往共享区写
   * 却以为自己在私有区。见 core/user-private.ts。
   */
  readonly userPrivateDir?: string;
}

/**
 * 组装子进程环境。
 *
 * ⚠️ **三个变量必须剔除,而且 IPC secret 一条例外都没有**(管理员也拿不到)。
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
  // CATMAN_USER_PRIVATE_DIR 也要先摘掉,理由跟上面两个不同:它不是密钥,而是
  // **一个只对某一个回合成立的事实**。继承下来的那个值属于别人(或者属于一个
  // 压根没挂私有目录的场合),留着就成了"变量在而挂载不在" —— 脚本会拿它当私有区
  // 去写凭据。所以下面按 opts 显式给,不给就是不给。
  const {
    CATMAN_ADMIN_TOKEN,
    CATMAN_IPC_SECRET: _ipc,
    CATMAN_USER_PRIVATE_DIR: _priv,
    ...rest
  } = process.env;
  return {
    ...rest,
    ...(opts.binDir ? { PATH: prependPath(opts.binDir, rest.PATH) } : {}),
    CATMAN_API_BASE: opts.apiBase,
    CATMAN_SESSION_TOKEN: opts.sessionToken,
    ...(opts.notifyToken ? { CATMAN_NOTIFY_TOKEN: opts.notifyToken } : {}),
    ...(opts.userPrivateDir ? { CATMAN_USER_PRIVATE_DIR: opts.userPrivateDir } : {}),
    ...(opts.isAdmin ? { CATMAN_ADMIN_TOKEN } : {}),
  };
}

/** 已经在 PATH 里就不重复加 —— 每回合叠一次的话,长跑的进程 PATH 会越来越长。 */
function prependPath(dir: string, current: string | undefined): string {
  if (!current) return dir;
  return current.split(":").includes(dir) ? current : `${dir}:${current}`;
}
