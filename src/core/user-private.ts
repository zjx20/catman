import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { userDirName } from "./identity.js";
import type { Config } from "../config.js";

/**
 * 每用户私有目录 —— 放那个人的凭据、令牌这类**别人不该看见**的东西。
 *
 * ## 它补的是哪个洞
 *
 * catman 一直是多用户的,但文件从来没按用户分过:会话容器把整个 `/data`
 * **读写**挂进去(见 `sessionMounts`),于是任何人的回合都读得到别人的 workspace、
 * 别人的 cron 任务、别人的一切。`workspace/<dirName>/` 只是个 cwd 约定,
 * 不是隔离 —— 隔壁那个人的 agent 一句 `cat` 就过去了。
 *
 * 直接的导火索是要往盘上存第三方服务的 OAuth 凭据(agent.qq.com 的邮箱)。
 * 那种东西放共享区就等于所有用户共用一个邮箱身份,而且**不报错**。
 *
 * ## 为什么单开一棵树,而不是放进 `/data/userdata`
 *
 * 放 `/data` 里的话,会话容器那条"整挂 `/data`"仍然会把所有人的私有目录一起带进去,
 * 要靠**再挂一个空目录把它遮住**才能藏起来。那条路走得通(挂载按目标路径深度排序,
 * 深的盖住浅的,救援人格的只读挂载就是这么写的),但它**坏的方向不对**:
 * 哪天谁改动挂载时漏了那条遮罩,结果是所有人的凭据一次性全部暴露,而且悄无声息。
 *
 * 单开一棵 `/mnt/usb/catman_userdata`,"看不见"就变成结构性的 —— 它压根不在
 * 被整挂的那棵树里。漏挂的后果反过来:私有目录访问不到,功能立刻不工作,
 * 一眼就能发现。**安全机制要往「坏了就用不了」的方向坏,不能往「坏了就全开」的方向坏。**
 *
 * ## 为什么 catman 自己也要挂这棵树
 *
 * 乍看不必:`-v` 是**宿主 dockerd** 解析的,catman 主进程看不看得到那个路径,
 * 跟"能不能把它挂进会话容器"毫无关系。挂载这一层确实不需要。
 *
 * 卡点在**目录得先存在,而且属 uid 10001**。2026-09-03 实测:
 *
 *   - 挂载源在宿主上不存在时,dockerd 会替你建 —— 建出来是 **root:root 0755**。
 *   - **父目录属 10001 也没用**,子目录照样是 root:root(试过,不继承)。
 *   - 会话容器是 `--user 10001:10001`,于是 `touch /private/x` → Permission denied。
 *
 * 所以必须有人以写得动的身份**预先**把那个子目录建出来。让 catman 挂一次
 * `/userdata` 是最省的做法:一行 compose,之后每回合零成本。
 *
 * 另一条路是每回合通过 docker.sock 起一个 root 容器去 mkdir + chown ——
 * 不用改 compose,但每回合多起一个容器(会话容器已经是每回合一个了),
 * 而且 catman 从此看不见这棵树,将来的清理/迁移/备份都无从下手
 * (对照 `listWorkspaceDirs`:清理的真相源必须是看得见的那一份)。
 *
 * ## 这仍然是护栏,不是安全边界
 *
 * 与 CLAUDE.md 里那句一致:两个人格都挂着 docker.sock,起一个 root 容器挂宿主路径
 * 就什么都读得到。这里挡的是"随手一读"和"写错路径串了用户",挡不住铁了心的。
 * 隔离靠的是**挂载不可见**,不是文件权限 —— 所有会话容器都是同一个 uid(10001),
 * 权限位在这里只是万一挂载漏了时的第二层。
 *
 * ## 没配置就降级,不报错
 *
 * `hostUserDataDir` 缺席(compose 还没加那条挂载)时,这里返回 undefined,
 * 调用方就当没有这个机制 —— 不挂、不注入、不建目录。代码因此可以先上线,
 * 等 compose 那半边生效后自动启用。**唯一不能做的是"假装成功"**:
 * 那会让凭据落到一个所有人都看得见的地方,而调用方以为它是私有的。
 */

/**
 * 私有目录在容器里的固定挂载点。
 *
 * 固定成一个常量而不是按用户拼路径,是为了让**里面的脚本不需要知道自己是谁** ——
 * 它只认 `CATMAN_USER_PRIVATE_DIR`,换个用户跑起来是同一份代码同一个路径。
 *
 * 挂在根下而不是 `/data/private`:`/data` 是整挂进来的,挂在它下面就又变成
 * "靠挂载覆盖顺序取胜",正是上面那段刻意要避开的。
 */
export const PRIVATE_MOUNT = "/private";

/** 一个用户的私有目录在三种视角下的路径。 */
export interface UserPrivatePaths {
  /** **宿主**上的绝对路径。`docker -v` 的左边永远是这个视角。 */
  readonly host: string;
  /** catman 自己进程里的路径 —— 建目录、清理时用。 */
  readonly local: string;
  /** 回合容器里的路径,注入成 `CATMAN_USER_PRIVATE_DIR`。 */
  readonly at: string;
}

/**
 * 推导某个用户的私有目录路径。**不建目录**,纯计算。
 *
 * 返回 undefined 的两种情况都表示"这台机器上没有这个机制":
 * 没配 `hostUserDataDir`,或者跑在守护人格里(它的 `/data` 是只读的,
 * 也不该在自己那份沙箱里凭空长出别人的私有目录 —— 与 `ensureCronDataDir` 同一条理由)。
 */
export function userPrivatePaths(
  config: Pick<Config, "userDataDir" | "hostUserDataDir" | "persona">,
  userKey: string,
): UserPrivatePaths | undefined {
  if (config.persona === "rescue") return undefined;
  if (!config.hostUserDataDir) return undefined;
  const dirName = userDirName(userKey);
  return {
    host: join(config.hostUserDataDir, dirName),
    local: join(config.userDataDir, dirName),
    at: PRIVATE_MOUNT,
  };
}

/**
 * 确保某个用户的私有目录存在且写得动,返回它的三视角路径。
 *
 * 幂等,每回合调一次。建不出来时**返回 undefined 而不是抛** —— 一个存不了凭据的
 * 回合仍然该照常干别的活,而调用方拿到 undefined 就知道"这次没有私有目录",
 * 不会把它当成有。
 *
 * ⚠️ `mkdirSync` 的 mode 会被 umask 削掉(默认 022 → 755),所以必须显式
 * `chmodSync` 一次。0700 是刻意的:同 uid 之间它挡不住谁,但它挡住了**别的 uid** ——
 * 也就是那些以自己镜像默认用户运行的 `script` 类定时任务容器。代价是那类任务
 * 读不了私有目录(它们本来也不该读别人的),要用得显式放宽。
 */
export function ensureUserPrivateDir(
  config: Pick<Config, "userDataDir" | "hostUserDataDir" | "persona">,
  userKey: string,
): UserPrivatePaths | undefined {
  const paths = userPrivatePaths(config, userKey);
  if (!paths) return undefined;
  try {
    mkdirSync(paths.local, { recursive: true });
    chmodSync(paths.local, 0o700);
    return paths;
  } catch (err) {
    console.warn(`[private] 建不出私有目录 ${paths.local},本回合按「没有私有目录」处理:`, err);
    return undefined;
  }
}
