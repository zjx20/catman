import type { CronSchedule } from "./schedule.js";

/**
 * 定时任务的数据形状。**这份类型就是盘上格式** —— 改它等于改数据格式,
 * 而部署随时可能回滚,所以只能加可选字段,不能改已有字段的含义(见 README
 * 「数据格式与升级」)。旧版本读到不认识的字段会原样忽略,这是允许的;
 * 反过来新版本读旧数据时,缺的字段必须有兜底。
 */

/** 容器挂载。`host` 是**宿主**上的绝对路径 —— docker 的 -v 从来只认宿主视角。 */
export interface CronMount {
  readonly host: string;
  readonly at: string;
  readonly ro: boolean;
}

export interface CronLimits {
  /** docker `--memory`,如 "512m"。 */
  readonly memory: string;
  /** docker `--cpus`。软路由只有 2 核,这个值直接决定它会不会把宿主拖垮。 */
  readonly cpus: number;
  /** docker `--pids-limit`。fork 炸弹的唯一一道闸。 */
  readonly pids: number;
}

/** 脚本任务:在一次性容器里跑一条命令。 */
export interface ScriptTask {
  readonly kind: "script";
  readonly image: string;
  /** exec 形式,不过 shell。要 shell 就自己写 ["bash","-lc","…"]。 */
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly network: "none" | "mynet";
  readonly mounts: readonly CronMount[];
  readonly limits: CronLimits;
}

/**
 * agent 任务:到点让大脑去做一件需要判断的事(「看看有没有异常」「变化了才报」)。
 *
 * 与用户对话**完全隔开**:它有自己的会话,不碰用户正在聊的那一段上下文。
 * 这不是洁癖 —— 共用的话,半夜一次巡检会把用户第二天早上「接着昨天说」的那段
 * 上下文顶掉,而他完全不知道发生了什么。
 */
export interface AgentTask {
  readonly kind: "agent";
  /** 交给它的话。就是你会在微信里说的那一句。 */
  readonly prompt: string;
  /**
   * fresh = 每次干净起步;chain = 续这个任务自己上一次的上下文。
   * chain 适合「变化了才报」这类要记得上次什么样的巡检。
   */
  readonly session: "fresh" | "chain";
  /** 不给则用这个用户当前的模型偏好。 */
  readonly model?: string;
  /** 本次最多几轮。这是花钱的闸门 —— 没有人盯着的回合不能没有上限。 */
  readonly maxTurns: number;
}

/** 联合类型:新增一种任务时,编译器会逼着把每一处分支都补全。 */
export type CronTask = ScriptTask | AgentTask;

export interface CronNotify {
  /** 开跑时推一条。默认关 —— 主动推送花的是发送预算,长任务才值。 */
  readonly start: boolean;
  /** 跑完推一条(含下次触发时刻)。 */
  readonly end: boolean;
  /** 只在失败时推。成功就闭嘴,巡检类任务该用它。 */
  readonly onlyFailure: boolean;
  /**
   * 静默时段,形如 `"23:00-08:00"`(可跨零点)。窗口内**只记录不推送**,
   * 出窗口时把攒下的合并成一条摘要。
   *
   * 存在的理由是发送预算:主动推送花的是用户上一条来信那份额度(一份 10 条),
   * 而半夜跑的任务本来就发不出去 —— 它们只会挤在信使的发件队列里,
   * 第二天早上他一开口全砸过来。攒起来合并成一条,是同一件事的体面版本。
   */
  readonly quiet?: string;
}

export type OverlapPolicy = "skip" | "replace";

export interface CronJob {
  readonly id: string;
  /** 归属用户。任务是**每人**的,接口按回合令牌定身份,没有"改谁"这个参数。 */
  readonly userKey: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly schedule: CronSchedule;
  readonly task: CronTask;
  readonly timeoutMs: number;
  readonly overlap: OverlapPolicy;
  readonly notify: CronNotify;
  /** 这个任务保留多少条执行记录。 */
  readonly keepRuns: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * 下次触发的绝对时刻。**存绝对毫秒而不是"还有多久"**:进程随时会被部署换掉,
   * 相对量在重启后就没有意义了。
   */
  readonly nextAt?: number;
  readonly lastRunAt?: number;
  readonly lastStatus?: RunStatus;
  /** 连续失败次数。到阈值自动停用 —— 半夜空转的任务不该一直烧资源。 */
  readonly failStreak: number;
  /**
   * agent 任务(session=chain)上一次的会话 id,下一次接着它跑。
   *
   * 存在任务表里而不是内存里:进程随时会被部署换掉,而「记得上次什么样」正是
   * chain 模式唯一的卖点 —— 丢了它,巡检任务会在每次部署之后重新大惊小怪一遍。
   */
  readonly agentSessionId?: string;
}

/**
 * 一次执行的结局。
 *
 * `skipped` 也是一条记录而不是什么都不写:上一轮还没跑完导致这一轮没跑,是排查
 * "为什么昨天没结果"时最需要看到的那条线索,静默跳过等于把它藏起来。
 */
export type RunStatus =
  | "running"
  | "ok"
  | "failed"
  | "timeout"
  | "skipped"
  | "interrupted"
  | "error";

export type RunTrigger = "schedule" | "manual" | "catchup";

export interface CronRun {
  readonly id: string;
  readonly jobId: string;
  readonly userKey: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly status: RunStatus;
  readonly trigger: RunTrigger;
  readonly exitCode?: number;
  /** 脚本任务的容器名。重启后靠它把在飞的那次认领回来。 */
  readonly container?: string;
  /** 人话补充:跳过的理由、超时的秒数、启动失败的原因。 */
  readonly note?: string;
  /** 输出日志的字节数(0 表示没输出;文件可能已被保留策略删掉)。 */
  readonly logBytes?: number;
}

/** 一次执行是不是还没有结局。 */
export function isRunActive(run: CronRun): boolean {
  return run.status === "running";
}
