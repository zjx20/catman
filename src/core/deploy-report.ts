import { readJsonFile, writeJsonFileAtomic } from "./file-store.js";
import { shortSha } from "./version.js";

/**
 * 部署报告 —— deployer 写、catman 读的那份**跨版本契约**。
 *
 * ## 为什么它必须是契约,而不是随手一个 JSON
 *
 * 写它的 deployer 是**人工钦定**的版本(改它属 Tier 3),读它的 catman 每周都在
 * 自我进化 —— 两者可以差几十个版本。所以:字段**只增不改**,`schema` 变更等于
 * 破坏性变更、要连同 deployer 一起更新;读取端**防御式解析**,读不懂就当没有报告
 * (而不是抛错拖垮启动)。golden 测试钉着这份形状。
 *
 * ## 它回答什么
 *
 * "我让它改的东西上线了吗" —— 用户发出「发布」之后,那个回合就结束了(提交部署后
 * 立即收尾,否则会与排水互锁)。真正的结果要等几十分钟后才出来,而那时**没有任何
 * 在飞回合可以说话**。报告是这个空档的唯一出口:catman 起来后读它,在用户下一条
 * 消息时把结果告诉他。
 *
 * 失败的报告尤其重要:回滚意味着用户看到的仍是旧版本,他必须知道"你要的那个改动
 * 没上去,原因是这个",否则他会以为改动生效了而行为没变。
 */

/** 契约版本。字段只增不改;真要改语义就升它,并同步更新 deployer。 */
export const DEPLOY_REPORT_SCHEMA = 1;

export type DeployOutcome =
  /** 切换成功并通过观察期,stable 已前移。 */
  | "deployed"
  /** 切换后判定失败,已自动回滚到上一个已验证版本。 */
  | "rolled-back"
  /** 切换**之前**中止(制备/自检没过),现役版本一根汗毛没动。 */
  | "aborted";

export interface DeployReport {
  readonly schema: number;
  /** 本次部署的唯一标识,用于"这条播报过没有"的去重。 */
  readonly id: string;
  readonly outcome: DeployOutcome;
  /** 目标版本的 sha。中止时可能是待部署的那个。 */
  readonly sha: string;
  /** 回滚后实际在跑的 sha(仅 rolled-back 时有意义)。 */
  readonly revertedTo?: string;
  /** 结束时刻(ISO 8601)。 */
  readonly finishedAt: string;
  /** 给人看的一句话:成功时是改动摘要,失败时是原因 + 日志摘要。 */
  readonly detail: string;
  /** 谁发起的(userKey)。播报优先发给他 —— 他才是在等结果的那个人。 */
  readonly requestedBy?: string;
  /** 切换时有几段后台回合被中断。0 或缺失表示没有。 */
  readonly interruptedBackgroundTurns?: number;
}

/**
 * 防御式解析。任何形状不对都返回 undefined —— 读不懂的报告等于没有报告。
 *
 * 这与 settings.ts 的 `parse()` 同一纪律:读取端坏值不抛,让调用方退到可用状态。
 * 一个能让 catman 起不来的报告文件,会把"部署失败"升级成"永久下线"。
 */
export function parseDeployReport(v: unknown): DeployReport | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const id = r["id"];
  const outcome = r["outcome"];
  const sha = r["sha"];
  if (typeof id !== "string" || !id) return undefined;
  if (outcome !== "deployed" && outcome !== "rolled-back" && outcome !== "aborted") return undefined;
  if (typeof sha !== "string" || !sha) return undefined;

  const schema = typeof r["schema"] === "number" ? r["schema"] : DEPLOY_REPORT_SCHEMA;
  const str = (k: string): string | undefined => {
    const x = r[k];
    return typeof x === "string" && x ? x : undefined;
  };
  const n = r["interruptedBackgroundTurns"];
  return {
    schema,
    id,
    outcome,
    sha,
    ...(str("revertedTo") ? { revertedTo: str("revertedTo")! } : {}),
    finishedAt: str("finishedAt") ?? "",
    detail: str("detail") ?? "",
    ...(str("requestedBy") ? { requestedBy: str("requestedBy")! } : {}),
    ...(typeof n === "number" && Number.isFinite(n) && n > 0
      ? { interruptedBackgroundTurns: Math.floor(n) }
      : {}),
  };
}

/** 播报给用户的那段话。三种结局说三句不同的话 —— 用户该做的事完全不同。 */
export function formatDeployReport(r: DeployReport): string {
  const head =
    r.outcome === "deployed"
      ? `✅ 升级完成,现在跑的是 ${shortSha(r.sha)}。`
      : r.outcome === "rolled-back"
        ? `↩️ 升级失败,已自动回滚${r.revertedTo ? `到 ${shortSha(r.revertedTo)}` : ""} —— ` +
          `你要的那个改动**没有**上线,现在跑的还是旧版本。`
        : `⛔ 这次部署在切换前就中止了(${shortSha(r.sha)}),线上版本一直没动过。`;
  const lines = [head];
  if (r.detail) lines.push(r.detail);
  if (r.interruptedBackgroundTurns) {
    // 后台回合是用户主动切走、说过"你接着跑"的。它们被切换杀掉了,
    // 不说的话那几段就是无声无息地消失 —— 那是最糟的失败模式。
    lines.push(`另外:切换时有 ${r.interruptedBackgroundTurns} 段后台对话被中断,没能把结果发给你。`);
  }
  return lines.join("\n");
}

/**
 * 报告的读取与"播报过没有"的记账。
 *
 * 已播报标记**必须落盘**:只放内存的话,进程一重启就会把同一条结果再播一遍 ——
 * 而 crash-loop 的场景下,那正是它会反复发生的时候。
 */
export class DeployReports {
  constructor(
    private readonly reportPath: string,
    private readonly seenPath: string,
  ) {}

  /** 最近一次部署报告;文件不存在或读不懂都返回 undefined。 */
  latest(): DeployReport | undefined {
    return parseDeployReport(readJsonFile<unknown>(this.reportPath, undefined));
  }

  /** 这条报告播报过没有。 */
  private announcedId(): string | undefined {
    const seen = readJsonFile<{ announcedId?: unknown }>(this.seenPath, {});
    return typeof seen.announcedId === "string" ? seen.announcedId : undefined;
  }

  /**
   * 取一条待播报的报告。**只看不取** —— 标记已读要等真发出去之后调 markAnnounced,
   * 否则发送失败(iLink 的老毛病)就等于把这条结果永久吞掉了。
   */
  pending(): DeployReport | undefined {
    const r = this.latest();
    if (!r) return undefined;
    return this.announcedId() === r.id ? undefined : r;
  }

  markAnnounced(id: string): void {
    writeJsonFileAtomic(this.seenPath, { announcedId: id });
  }
}
