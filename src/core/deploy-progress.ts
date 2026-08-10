import { readFileSync } from "node:fs";
import { readJsonFile, writeJsonFileAtomic } from "./file-store.js";
import { shortSha } from "./version.js";

/**
 * 部署里程碑 —— deployer 一路写、catman 一路播的那份**跨版本契约**。
 *
 * ## 为什么光有部署报告不够
 *
 * `report.json` 只有一条,而且写在**最后**:自检 → 切换 → 30 分钟观察期 → 转稳定
 * → 推远端,整条链走完才有它。用户发完 `/发布` 之后要盯着一段三十多分钟的黑箱,
 * 期间他唯一能观测到的事实是"catman 失联了几分钟又回来了" —— 而那既可能是切换成功,
 * 也可能是切换失败正在回滚。真机上的表现就是一句"无论等多久都等不到结果"。
 *
 * 所以把过程中的三个**已经发生、不会再撤销**的事实各写一条:切换成功、转稳定、
 * 推远端。它们与报告是同一族契约(deployer 写、catman 读、字段只增不改、读取端
 * 防御式解析),只是多了一条:**追加而不覆盖**。覆盖式的单文件在这里不成立 ——
 * 三条里程碑之间隔着几十分钟,catman 每 15 秒才去看一眼,覆盖会让中间那条消失。
 *
 * ## 为什么是 JSONL
 *
 * 追加一行是 shell 里唯一**不需要先读后写**的写法(`>>`),于是不存在"deployer 写到
 * 一半 catman 读到半份"这种窗口:读者按行解析,半行读不懂就当没有,下一轮再来。
 * 换成一个 JSON 数组的话,每次追加都要读-改-写,而那正是 report.json 用原子 rename
 * 才躲开的那件事。
 *
 * ## 与报告的分工
 *
 * 里程碑说"这一步过了",报告说"整件事的结局是什么"。失败**不写里程碑**——
 * 回滚的结局属于报告(它要说清"你要的改动没上线"),里程碑只记那些已经站住的进展。
 */

/** 契约版本。字段只增不改;真要改语义就升它,并同步 bless 一份新 deployer。 */
export const DEPLOY_PROGRESS_SCHEMA = 1;

/**
 * 三个里程碑。**顺序即发生顺序**,catman 按文件里的先后播,不重排。
 *
 * - `switched`:新版本已经起来并通过健康门,现在跑的就是它(但还在观察期里)。
 * - `stable`:观察期通过,stable 指针前移 —— 从这一刻起它才是"回滚回得去"的版本。
 * - `pushed`:这个提交推到了远端。失败也写(`ok=false`),因为"本地上线了但远端没有"
 *   是个下次开工会踩到的事实:再从远端拉一次会把它拉丢。
 */
export const DEPLOY_STAGES = ["switched", "stable", "pushed"] as const;
export type DeployStage = (typeof DEPLOY_STAGES)[number];

export interface DeployProgress {
  readonly schema: number;
  /** 这一条的唯一标识(`<部署id>-<stage>`),用于"这条播过没有"的去重。 */
  readonly id: string;
  readonly stage: DeployStage;
  readonly sha: string;
  /** 发生时刻(ISO 8601)。 */
  readonly at: string;
  /** 给人看的一句话。 */
  readonly detail: string;
  /** 这一步成没成。缺失按 `true` 读 —— 里程碑本就只在成功时写,`false` 是后加的例外。 */
  readonly ok: boolean;
  /** 谁发起的(userKey)。播报优先发给他 —— 他才是在等的那个人。 */
  readonly requestedBy?: string;
}

/** 防御式解析。与 parseDeployReport 同一纪律:读不懂的当没有,绝不抛。 */
export function parseDeployProgress(v: unknown): DeployProgress | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const id = r["id"];
  const stage = r["stage"];
  const sha = r["sha"];
  if (typeof id !== "string" || !id) return undefined;
  if (typeof stage !== "string" || !(DEPLOY_STAGES as readonly string[]).includes(stage)) {
    // 认不出的阶段一律丢弃**而不是报错**:未来的 deployer 可能多写几种,
    // 旧 catman 遇到时应当"不播这条",而不是把整份进度判成读不懂。
    return undefined;
  }
  if (typeof sha !== "string" || !sha) return undefined;

  const str = (k: string): string | undefined => {
    const x = r[k];
    return typeof x === "string" && x ? x : undefined;
  };
  return {
    schema: typeof r["schema"] === "number" ? r["schema"] : DEPLOY_PROGRESS_SCHEMA,
    id,
    stage: stage as DeployStage,
    sha,
    at: str("at") ?? "",
    detail: str("detail") ?? "",
    ok: r["ok"] === false ? false : true,
    ...(str("requestedBy") ? { requestedBy: str("requestedBy")! } : {}),
  };
}

/**
 * 读整份 JSONL。**坏行只丢它自己** —— 一条写了一半的记录不该让前面几条一起消失。
 * 文件不存在是常态(这台机器的 deployer 还没写过进度),返回空。
 */
export function readProgressLog(path: string): DeployProgress[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: DeployProgress[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      continue;
    }
    const p = parseDeployProgress(parsed);
    if (p) out.push(p);
  }
  return out;
}

/** 播报给用户的那句话。三个阶段说三句不同的话 —— 它们对用户的意义完全不同。 */
export function formatDeployProgress(p: DeployProgress): string {
  const head =
    p.stage === "switched"
      ? `🔄 已切到 ${shortSha(p.sha)},进程起来了。接下来是观察期,期间崩了会自动退回。`
      : p.stage === "stable"
        ? `✅ 观察期通过,${shortSha(p.sha)} 已转为稳定版(从现在起它才是回滚回得去的那个)。`
        : p.ok
          ? `📤 ${shortSha(p.sha)} 已推送到远端。`
          : `⚠️ ${shortSha(p.sha)} 没能推上远端 —— 版本照常在跑,但远端还没有这个提交。`;
  return p.detail ? `${head}\n${p.detail}` : head;
}

/** 已播报名单里最多留几条。够覆盖最近几次部署,又不会让这份文件无限长。 */
const KEEP_ANNOUNCED = 64;

/**
 * 里程碑的读取与"播报过没有"的记账。
 *
 * 与部署报告同一条纪律:**已播报标记必须落盘**(只放内存的话,切换本身就会重启进程,
 * 于是"已切换"那条每次重启都再播一遍),而且**发送成功才标记** —— 先标记等于把这条
 * 进展永久吞掉。
 *
 * 记账文件写在 catman 自己的可写区,不在 `/data/deploy`(那是 deployer 的目录,
 * catman 只读)。
 */
export class DeployProgressLog {
  constructor(
    private readonly logPath: string,
    private readonly seenPath: string,
  ) {}

  /** 全部里程碑,旧→新(就是文件里的顺序)。 */
  all(): DeployProgress[] {
    return readProgressLog(this.logPath);
  }

  private announced(): string[] {
    const seen = readJsonFile<{ announced?: unknown }>(this.seenPath, {});
    const list = seen.announced;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  }

  /**
   * 还没播过的里程碑,旧→新。
   *
   * `maxAgeMs` 之外的一律当已经过期:一份躺了几天的进度文件在重装/回退之后仍然存在,
   * 补播它只会让用户以为刚刚又部署了一次。解析不出时间的按"太老"处理 —— 宁可不播。
   */
  pending(maxAgeMs: number, now: number = Date.now()): DeployProgress[] {
    const seen = new Set(this.announced());
    return this.all().filter((p) => {
      if (seen.has(p.id)) return false;
      const at = Date.parse(p.at);
      return Number.isFinite(at) && now - at <= maxAgeMs;
    });
  }

  markAnnounced(id: string): void {
    const list = this.announced().filter((x) => x !== id);
    list.push(id);
    writeJsonFileAtomic(this.seenPath, {
      schema: DEPLOY_PROGRESS_SCHEMA,
      announced: list.slice(-KEEP_ANNOUNCED),
    });
  }
}
