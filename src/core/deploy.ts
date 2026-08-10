import { spawn } from "node:child_process";
import { readJsonFile } from "./file-store.js";
import { DeployReports, type DeployReport } from "./deploy-report.js";
import {
  listPreparedReleases,
  resolveShaPrefix,
  MIN_SHA_PREFIX,
  type PreparedRelease,
} from "./releases.js";
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
   * 请求把某个已制备的 release 部署上线。`shaPrefix` 是人在 `/发布` 后面打的那几位。
   * 返回给用户的一句话(已经排好版)—— 包括各种拒绝的情形。
   *
   * 与 requestRollback 一样只负责**发起**:结论由下一次启动读报告播报。
   */
  requestDeploy(shaPrefix: string, requestedBy: string): Promise<string>;
  /**
   * 请求一次回滚。返回给用户的一句话(已经排好版)。
   *
   * 只负责**发起**:deployer 起来之后 catman 自己会被停掉换版本,所以这里
   * 拿不到"回滚成功了没"—— 那个结论由下一次启动读报告播报。
   */
  requestRollback(requestedBy: string): Promise<string>;
  /** 已制备、可以拿去发布的 release,新→旧。供 `/升级状态` 与 `/发布` 的报错列候选。 */
  publishable(): readonly PublishCandidate[];
  /** 待播报的报告(尚未标记已读)。 */
  pendingReport(): DeployReport | undefined;
  markReportAnnounced(id: string): void;
  /** 最近一次报告,不论播报过没有。供 `/升级状态`。 */
  lastReport(): DeployReport | undefined;
  /** 可回退的版本,新→旧。 */
  verifiedHistory(): readonly VerifiedRelease[];
}

/** 一个可以拿去 `/发布` 的候选。 */
export interface PublishCandidate extends PreparedRelease {
  /** 就是本进程正在跑的那份代码 —— 再发一次是 30 分钟的空转。 */
  readonly running: boolean;
}

export interface ScriptDeployControlOptions {
  /** bless 时固化的 deployer 脚本(如 /data/deploy/bin/deployer-run.sh)。 */
  runnerPath: string;
  /** deployer 写的部署报告(如 /data/deploy/report.json)。 */
  reportPath: string;
  /** 已播报标记,catman 自己写(必须在 catman 可写区)。 */
  seenPath: string;
  /** release 目录(只读)。`/发布` 的候选就是从这里枚举的。 */
  releasesDir: string;
  /** deployer 写的已验证版本清单(如 /data/releases/verified-history.json)。 */
  historyPath: string;
  /**
   * 本进程正在跑的那份代码的 sha(版本戳,读不到时 undefined)。
   *
   * 判"这已经是当前版本了"用它而不是 `current` 指针:指针与运行中的进程对不上时
   * (有人换了链接却没重启、或 crash-loop 卡在旧代码上),重新部署一次**恰恰是修复手段**,
   * 按指针拒绝会把这条修复路径堵死。
   */
  runningSha?: string | undefined;
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

  publishable(): readonly PublishCandidate[] {
    const running = this.opts.runningSha;
    return listPreparedReleases(this.opts.releasesDir).map((r) => ({
      ...r,
      running: !!running && r.sha === running,
    }));
  }

  /**
   * `/发布 <前6位>`。四种拒绝各说各的话 —— 处置完全不同:太短要重打、没有要先制备、
   * 歧义要写长一点、已经是当前版本则根本不用动。含糊一句"发布失败"会让人反复重试。
   */
  async requestDeploy(shaPrefix: string, requestedBy: string): Promise<string> {
    const candidates = this.publishable();
    const found = resolveShaPrefix(
      candidates.map((c) => c.sha),
      shaPrefix,
    );

    switch (found.kind) {
      case "tooShort":
        return `版本号至少要给 ${MIN_SHA_PREFIX} 位,照抄制备时报的那串就行。${listCandidates(candidates)}`;
      case "none":
        return `没有以「${shaPrefix.trim()}」开头的 release。${listCandidates(candidates)}`;
      case "ambiguous":
        return (
          `有 ${found.matches.length} 个 release 都以「${shaPrefix.trim()}」开头:` +
          `${found.matches.map(shortSha).join("、")}。多打几位再来一次。`
        );
      case "ok":
        break;
    }

    const target = candidates.find((c) => c.sha === found.sha)!;
    if (target.running) {
      return `${shortSha(target.sha)} 就是我现在跑的这份代码,不用再发一次。`;
    }

    const spawnRunner = this.opts.spawnRunner ?? defaultSpawnRunner;
    await spawnRunner(this.opts.runnerPath, [
      "deploy",
      target.sha,
      "--requested-by",
      requestedBy,
    ]);
    return (
      `已提交部署 ${shortSha(target.sha)}${target.branch ? `(${target.branch})` : ""}。\n` +
      "接下来是自检 → 切换 → 30 分钟观察期,期间我会被停掉换版本、失联几分钟。\n" +
      "任何一步没过都会自动退回原来的版本。换完之后你发条消息,我把结果告诉你。"
    );
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
 * 拒绝的话后面跟一句候选清单 —— 人多半是记错了那几位,直接给他看有哪些
 * 比让他去翻聊天记录快得多。一个都没有时如实说,并指出下一步是制备。
 */
function listCandidates(candidates: readonly PublishCandidate[]): string {
  const usable = candidates.filter((c) => !c.running);
  if (!usable.length) return "现在没有已制备、待发布的版本 —— 要先制备一次。";
  return `\n待发布的有:${usable.map((c) => `${shortSha(c.sha)}${c.branch ? `(${c.branch})` : ""}`).join("、")}`;
}

/**
 * spawn 之后再多等这么久,只为看它会不会当场死掉。
 *
 * 正常路径是脚本 `exec docker run -d`,一秒上下就返回 0,所以这个窗口几乎从不走满。
 */
const SPAWN_GRACE_MS = 3_000;

/**
 * 起脚本。**detached + unref**:这个脚本会停掉 catman 自己,
 * 它必须在父进程死后继续跑完。等的只是"起没起来",不是"跑完没有"。
 *
 * ⚠️ **"spawn 成功"不等于"起来了"。** 这里曾经只等 `spawn` 事件、并且把 stdio 全部
 * 丢进 `ignore`,于是脚本在头几行 exit 1 的那一类失败**彻底不可见**:catman 已经
 * 回过一句"已提交部署",而错误既没进日志也没进报告 —— 用户看到的是"发布了,然后
 * 什么都没发生"。真机上撞过:固化 env 里的宿主路径在容器内是条断了的软链,
 * `deployer-run.sh` 的第一道检查当场失败,连着两次 `/发布` 都石沉大海。
 *
 * 所以窗口内非零退出要带着 stderr 抛出去 —— 网关那边本来就有"起不来就当场告诉人"
 * 的分支(见 `handleDeployRequest`),缺的只是让它拿到这个错。
 */
export async function defaultSpawnRunner(
  runnerPath: string,
  args: readonly string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(runnerPath, [...args], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      // 只留够说明问题的量。这条路径上的输出是给人看的一两句话,不是日志流。
      if (stderr.length < 4_000) stderr += chunk.toString();
    });

    let timer: ReturnType<typeof setTimeout>;

    // 放手:不再等这个孩子,但**绝不 destroy 它的 stderr** —— 管道断了之后它下一次
    // 写日志就会吃到 EPIPE,而那个进程正是要去换版本的那个。上面的 data 回调一直在
    // 排水(只是不再往字符串里堆),所以缓冲区也不会堵。
    const letGo = (): void => {
      clearTimeout(timer);
      child.unref();
    };
    // 窗口一到就放手:脚本还活着说明它已经越过了那些当场就会失败的检查,
    // 而它接下来要做的第一件事就是停掉 catman —— 再等下去毫无意义。
    timer = setTimeout(() => {
      letGo();
      resolve();
    }, SPAWN_GRACE_MS);
    timer.unref?.();

    child.once("error", (err) => {
      letGo();
      reject(err);
    });
    // 听 `close` 而不是 `exit`:`exit` 在进程死掉那一刻就来,stderr 可能还有没读完的
    // 字节 —— 而那几行恰恰是要给人看的原因。`close` 等所有 stdio 都收完才来。
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        letGo();
        resolve();
        return;
      }
      // 末几行才是原因,前面多半是无关的噪音。
      const tail = stderr.trim().split("\n").slice(-3).join(" / ");
      const how = signal ? `被信号 ${signal} 杀掉` : `退出码 ${code}`;
      child.stderr?.destroy();
      child.unref();
      reject(new Error(`${runnerPath} ${how}${tail ? `:${tail}` : "(没有任何输出)"}`));
    });
  });
}
