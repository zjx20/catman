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

/** P2 会加 agent 任务;留成联合类型,让新增分支时编译器逼着补全每一处分支。 */
export type CronTask = ScriptTask;

export interface CronNotify {
  /** 开跑时推一条。默认关 —— 主动推送花的是发送预算,长任务才值。 */
  readonly start: boolean;
  /** 跑完推一条(含下次触发时刻)。 */
  readonly end: boolean;
  /** 只在失败时推。成功就闭嘴,巡检类任务该用它。 */
  readonly onlyFailure: boolean;
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
