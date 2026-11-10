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
  /** 角色由服务端验证；此字段不用于下发原始管理员令牌。 */
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

/** Build turn metadata from explicit values. Never inherit control-plane secrets. */
export function buildTurnEnv(opts: TurnEnvOptions): Record<string, string | undefined> {
  const basePath = process.env.PATH;
  return {
    ...(basePath ? { PATH: opts.binDir ? prependPath(opts.binDir, basePath) : basePath } : {}),
    CATMAN_API_BASE: opts.apiBase,
    CATMAN_SESSION_TOKEN: opts.sessionToken,
    ...(opts.notifyToken ? { CATMAN_NOTIFY_TOKEN: opts.notifyToken } : {}),
    ...(opts.userPrivateDir ? { CATMAN_USER_PRIVATE_DIR: opts.userPrivateDir } : {}),
  };
}

/** 已经在 PATH 里就不重复加 —— 每回合叠一次的话,长跑的进程 PATH 会越来越长。 */
function prependPath(dir: string, current: string | undefined): string {
  if (!current) return dir;
  return current.split(":").includes(dir) ? current : `${dir}:${current}`;
}
