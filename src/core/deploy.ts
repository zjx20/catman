import { spawn } from "node:child_process";
import { readJsonFile } from "./file-store.js";
import { DeployReports, type DeployReport } from "./deploy-report.js";
import { DeployProgressLog, type DeployProgress } from "./deploy-progress.js";
import {
  listPreparedReleases,
  resolveShaPrefix,
  MIN_SHA_PREFIX,
  type PreparedRelease,
} from "./releases.js";
import { shortSha } from "./version.js";
import { canonicalOf } from "./commands.js";

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

/**
 * 超过这个岁数的里程碑不再补播。
 *
 * 进度文件是追加的,所以里面永远躺着上几次部署的记录。回退到一个还没播过这些
 * 里程碑的旧版本时,它会把几天前的"已切到 xxx"当新消息播出来 —— 用户那边看起来
 * 就是"我什么都没干,它说它部署了"。一天足够覆盖任何一次正常部署(30 分钟观察期
 * 加上人不在场的那几小时),又短到不会翻旧账。
 */
const PROGRESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
   * 请求把某个已制备的 release 部署上线。`request` 是人在 `/发布` 后面打的那一整串:
   * `<版本号前几位> [观察期秒数]`。返回给用户的一句话(已经排好版)—— 包括各种拒绝的情形。
   *
   * 与 requestRollback 一样只负责**发起**:结论由下一次启动读报告播报。
   */
  requestDeploy(request: string, requestedBy: string): Promise<string>;
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
  /**
   * 待播报的里程碑(切换成功 / 转稳定 / 推远端),旧→新。
   *
   * 与报告分开:报告是结局、只有一条且写在最后,里程碑是过程中那几个已经站住的事实。
   * 用户要的是"别让我对着三十分钟的黑箱等",光有结局给不了这个。
   */
  pendingProgress(): readonly DeployProgress[];
  markProgressAnnounced(id: string): void;
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
  /**
   * deployer 追加的里程碑(如 /data/deploy/progress.jsonl)与它的已播报标记。
   *
   * **两个都可选**:里程碑由 deployer 写,而 deployer 属 Tier 3 —— 这台机器上固化的
   * 那份可能还不会写它。缺席时就是"没有里程碑可播",报告照旧,不影响任何既有行为。
   */
  progressPath?: string | undefined;
  progressSeenPath?: string | undefined;
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
  /**
   * 起子进程的方式。单测注入,免得真去 spawn。
   *
   * `env` 是**追加**到当前环境上的几个变量(目前只有观察期)。走 env 而不是命令行参数
   * 是因为 `deployer-run.sh` 属 Tier 3:它早就认 `CATMAN_BAKE_SECONDS` 并转发给容器,
   * 而加一个新的命令行开关要重新 bless 才生效。
   */
  spawnRunner?: (
    runnerPath: string,
    args: readonly string[],
    env?: Record<string, string>,
  ) => Promise<void>;
}

/**
 * 默认观察期。**与 `scripts/evolve/deployer.sh` 里那个默认值是同一个数**,
 * 但这里不依赖它:每次都把值显式传过去(见 `requestDeploy`),
 * 于是"告诉用户要等多久"与"deployer 实际等多久"永远是同一个数,不会各说各的。
 */
export const DEFAULT_BAKE_SECONDS = 1800;

/**
 * 观察期能给多短、多长。
 *
 * 下限不是 0:观察期是**自动回滚的那张网** —— 新版本起来之后当场崩掉,靠的就是这段
 * 时间内的健康检查把它退回去。短到几秒钟等于把网撤了。30 秒足够让一个起不来的
 * 进程暴露(它多半在第一次装配就死),同时又不至于让人等。
 *
 * 上限纯粹是防手滑:打错一个零就是十小时不转稳定,而 `stable` 不动就意味着
 * 下一次 bless 没有目标。
 */
const MIN_BAKE_SECONDS = 30;
const MAX_BAKE_SECONDS = 3600;

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
  private readonly progress: DeployProgressLog | undefined;

  constructor(private readonly opts: ScriptDeployControlOptions) {
    this.reports = new DeployReports(opts.reportPath, opts.seenPath);
    this.progress =
      opts.progressPath && opts.progressSeenPath
        ? new DeployProgressLog(opts.progressPath, opts.progressSeenPath)
        : undefined;
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
  async requestDeploy(request: string, requestedBy: string): Promise<string> {
    const parsed = parseDeployRequest(request);
    if ("error" in parsed) return parsed.error;
    const { shaPrefix, bakeSeconds } = parsed;
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
    // **值总是显式传过去**,哪怕就是默认值 —— 这样下面那句"要等多久"说的
    // 必定是 deployer 实际会等的时间,不依赖脚本里那个默认值跟这里保持一致。
    const bake = bakeSeconds ?? DEFAULT_BAKE_SECONDS;
    await spawnRunner(
      this.opts.runnerPath,
      ["deploy", target.sha, "--requested-by", requestedBy],
      { CATMAN_BAKE_SECONDS: String(bake) },
    );
    return (
      `已提交部署 ${shortSha(target.sha)}${target.branch ? `(${target.branch})` : ""}。\n` +
      `接下来是自检 → 切换 → ${humanSeconds(bake)}观察期 → 转稳定 → 推远端,` +
      "期间我会被停掉换版本、失联几分钟。\n" +
      "任何一步没过都会自动退回原来的版本。**每过一关我都主动发消息告诉你**,不用一直等着问。" +
      (bakeSeconds !== undefined && bakeSeconds < DEFAULT_BAKE_SECONDS
        ? `\n(观察期缩短到 ${humanSeconds(bake)}:过了这段时间之后再崩就不会自动退回了,得你自己发 ${canonicalOf("rollback")}。)`
        : "")
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
      "我这就要被停掉换版本了,这段时间会失联几分钟;换完之后我主动把结果发给你。"
    );
  }

  pendingReport(): DeployReport | undefined {
    return this.reports.pending();
  }

  markReportAnnounced(id: string): void {
    this.reports.markAnnounced(id);
  }

  pendingProgress(): readonly DeployProgress[] {
    return this.progress?.pending(PROGRESS_MAX_AGE_MS) ?? [];
  }

  markProgressAnnounced(id: string): void {
    this.progress?.markAnnounced(id);
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
/**
 * 拆 `/发布` 后面那串:`<版本号前几位> [观察期秒数]`。
 *
 * **口令那一半一个字都不加工**(照旧原样交给 `resolveShaPrefix`)—— 它是整条流水线里
 * 那把"人批准了什么 = 机器部署了什么"的机械锁。这里只是在它后面允许再跟一个数字。
 *
 * 拒绝的情形各说各的话,因为处置不同:第二段不是数字多半是把 sha 打断了,
 * 而超出范围是明确知道自己在干什么但填错了量级。
 */
function parseDeployRequest(
  raw: string,
): { shaPrefix: string; bakeSeconds?: number } | { error: string } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const shaPrefix = parts[0] ?? "";
  if (parts.length <= 1) return { shaPrefix };
  if (parts.length > 2) {
    return { error: `${canonicalOf("publish")} 最多跟两段:版本号,以及可选的观察期秒数。` };
  }
  const raw2 = parts[1]!;
  const n = Number(raw2);
  if (!Number.isInteger(n)) {
    return {
      error:
        `观察期要给一个整数秒数,「${raw2}」不是。` +
        `想用默认的 ${humanSeconds(DEFAULT_BAKE_SECONDS)}就只发版本号。`,
    };
  }
  if (n < MIN_BAKE_SECONDS || n > MAX_BAKE_SECONDS) {
    return {
      error:
        `观察期要在 ${MIN_BAKE_SECONDS}–${MAX_BAKE_SECONDS} 秒之间,给的是 ${n}。` +
        `太短等于把自动回滚那张网撤了(新版本当场崩掉就没人退回它),太长则是 stable 迟迟不动。`,
    };
  }
  return { shaPrefix, bakeSeconds: n };
}

/** 把秒说成人话。观察期在文案里出现好几处,统一在这儿排版。 */
function humanSeconds(s: number): string {
  if (s < 120) return `${s} 秒`;
  const min = s / 60;
  return `${Number.isInteger(min) ? min : min.toFixed(1)} 分钟`;
}

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
  env?: Record<string, string>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(runnerPath, [...args], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      // 追加而不是替换:脚本要用到 PATH、以及固化时写进 env 的宿主路径。
      env: { ...process.env, ...(env ?? {}) },
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
