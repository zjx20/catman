import { spawn } from "node:child_process";
import { readJsonFile } from "./file-store.js";
import { DeployReports, type DeployReport } from "./deploy-report.js";
import { shortSha } from "./version.js";

/**
 * 部署控制面 —— catman 这一侧看到的那点点接口。
 *
 * ## 边界在哪
 *
 * catman **不知道 docker 存在**。它只会:读两份 deployer 写的 JSON(部署报告、
 * 已验证版本清单),以及在管理员发 `/回滚` 时执行一个**固化过的脚本**。
 * 所有真正的部署动作(排水、切链接、健康门、观察期、回滚)都在 deployer 里,
 * 那是人工钦定、不随自我进化改变的一层。
 *
 * 这条边界是"更新者不能是被更新者"在代码里的落点:catman 每周都在改自己,
 * 而它能对部署机制做的事仅限于"请求一次回滚",连怎么回滚都不由它决定。
 *
 * ## 两份 JSON 都是跨版本契约
 *
 * 写它们的 deployer 是钦定版本,读它们的 catman 每周都变 —— 字段只增不改,
 * 读取端一律防御式解析,读不懂就当没有(而不是抛错拖垮启动)。
 */

/** verified-history.json 的契约版本。 */
export const VERIFIED_HISTORY_SCHEMA = 1;

/** 一个通过了观察期的 release。回滚就是在这张单子上往回走。 */
export interface VerifiedRelease {
  readonly sha: string;
  /** 通过观察期的时刻(ISO 8601)。 */
  readonly verifiedAt: string;
}

/**
 * 防御式解析已验证版本清单。**顺序有意义**:新→旧,回滚沿着它往回走。
 * 任何一条坏掉只丢那一条,不丢整张单子 —— 单子空了等于没有回退目标,
 * 那是比"少一个候选"糟得多的状态。
 */
export function parseVerifiedHistory(v: unknown): VerifiedRelease[] {
  const list = (v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)["releases"]
    : undefined) as unknown;
  if (!Array.isArray(list)) return [];
  const out: VerifiedRelease[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const sha = rec["sha"];
    if (typeof sha !== "string" || !sha) continue;
    const verifiedAt = rec["verifiedAt"];
    out.push({ sha, verifiedAt: typeof verifiedAt === "string" ? verifiedAt : "" });
  }
  return out;
}

export interface DeployControl {
  /**
   * 请求一次回滚。返回给用户的一句话(已经排好版)。
   *
   * 只负责**发起**:deployer 起来之后 catman 自己会被停掉换版本,所以这里
   * 拿不到"回滚成功了没"—— 那个结论由下一次启动读报告播报。
   */
  requestRollback(requestedBy: string): Promise<string>;
  /** 待播报的报告(尚未标记已读)。 */
  pendingReport(): DeployReport | undefined;
  markReportAnnounced(id: string): void;
  /** 最近一次报告,不论播报过没有。供 `/升级状态`。 */
  lastReport(): DeployReport | undefined;
  /** 可回退的版本,新→旧。 */
  verifiedHistory(): readonly VerifiedRelease[];
}

export interface ScriptDeployControlOptions {
  /** bless 时固化的 deployer 脚本(如 /data/deploy/bin/deployer-run.sh)。 */
  runnerPath: string;
  /** deployer 写的部署报告(如 /data/deploy/report.json)。 */
  reportPath: string;
  /** 已播报标记,catman 自己写(必须在 catman 可写区)。 */
  seenPath: string;
  /** deployer 写的已验证版本清单(如 /data/releases/verified-history.json)。 */
  historyPath: string;
  /** 起子进程的方式。单测注入,免得真去 spawn。 */
  spawnRunner?: (runnerPath: string, args: readonly string[]) => Promise<void>;
}

/**
 * 走"固化脚本"的实现。
 *
 * `/回滚` 执行的是 **bless 时固化的那份脚本**,不是当前 release 里的那份 ——
 * 部署机制属 Tier 3,它的更新必须经人,否则一次自我进化就能顺手改掉自己的
 * 回滚逻辑,门禁形同虚设。
 *
 * 脚本用 detached + unref 起:它做的第一件事就是停掉 catman 自己,
 * 父进程被杀时子进程必须活下来,否则回滚会在半路自杀。
 */
export class ScriptDeployControl implements DeployControl {
  private readonly reports: DeployReports;

  constructor(private readonly opts: ScriptDeployControlOptions) {
    this.reports = new DeployReports(opts.reportPath, opts.seenPath);
  }

  async requestRollback(requestedBy: string): Promise<string> {
    const history = this.verifiedHistory();
    // 没有可回退的目标就别起 deployer:它只会失败一次然后写一份让人困惑的报告。
    if (history.length < 2) {
      return (
        "现在没有可回退的版本 —— 已验证的版本只有当前这一个。" +
        "(第一次部署之后才会有回退目标。)"
      );
    }
    const target = history[1]!;
    const spawnRunner = this.opts.spawnRunner ?? defaultSpawnRunner;
    await spawnRunner(this.opts.runnerPath, ["rollback", "--requested-by", requestedBy]);
    return (
      `已请求回滚到 ${shortSha(target.sha)}(${target.verifiedAt || "时间未知"})。\n` +
      "我这就要被停掉换版本了,这段时间会失联几分钟;换完之后你发条消息,我会把结果告诉你。"
    );
  }

  pendingReport(): DeployReport | undefined {
    return this.reports.pending();
  }

  markReportAnnounced(id: string): void {
    this.reports.markAnnounced(id);
  }

  lastReport(): DeployReport | undefined {
    return this.reports.latest();
  }

  verifiedHistory(): readonly VerifiedRelease[] {
    return parseVerifiedHistory(readJsonFile<unknown>(this.opts.historyPath, undefined));
  }
}

/**
 * 起脚本。**detached + unref + 忽略 stdio**:这个脚本会停掉 catman 自己,
 * 它必须在父进程死后继续跑完。等的只是"起没起来",不是"跑完没有"。
 */
async function defaultSpawnRunner(runnerPath: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(runnerPath, [...args], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
