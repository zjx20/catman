import { readJsonFile, writeJsonFileAtomic } from "../file-store.js";
import { wallClockIn } from "./schedule.js";
import type { RunStatus } from "./types.js";

/**
 * 攒着的结果通知,以及「什么时候能说话」这件事。
 *
 * ## 为什么要攒
 *
 * 主动推送花的是用户**上一条来信**带来的发送预算(一份 10 条,见 README
 * 「一个 context_token 的发送预算」)。半夜跑的任务,通知当场根本发不出去 ——
 * 它们只会挤在信使的发件队列里,等他第二天早上一开口,十几条一起砸过来。
 *
 * 所以静默时段做的不是「丢掉」,而是**攒起来合并**:出窗口时一个任务只说一条,
 * 说清楚这期间跑了几次、成了几次、最后一次什么样。同一件事的体面版本。
 *
 * ## 为什么落盘
 *
 * 自我进化每周都在部署,而部署很可能就发生在攒着的那几个小时里。只放内存的话,
 * 一次重启就把一整夜的结果吞掉了 —— 而那正是用户第二天要看的东西。
 */

export interface PendingNotice {
  readonly jobId: string;
  readonly jobName: string;
  readonly status: RunStatus;
  readonly at: number;
  /** 原样的那条文案。只攒到一条时直接用它,不做二次加工。 */
  readonly text: string;
}

type NoticeFile = Record<string, PendingNotice[]>;

/** 一个用户最多攒多少条。超了丢最旧的 —— 摘要里会说清楚丢了几条。 */
const MAX_PENDING_PER_USER = 200;

export class NoticeSpool {
  private readonly path: string;
  private byUser: NoticeFile;

  constructor(path: string) {
    this.path = path;
    this.byUser = readJsonFile<NoticeFile>(path, {});
  }

  add(userKey: string, notice: PendingNotice): void {
    const list = this.byUser[userKey] ?? [];
    list.push(notice);
    if (list.length > MAX_PENDING_PER_USER) list.splice(0, list.length - MAX_PENDING_PER_USER);
    this.byUser[userKey] = list;
    this.save();
  }

  /** 攒着的用户名单。调度器每次 tick 拿它去看谁该说话了。 */
  users(): string[] {
    return Object.keys(this.byUser).filter((k) => (this.byUser[k] ?? []).length > 0);
  }

  peek(userKey: string): readonly PendingNotice[] {
    return this.byUser[userKey] ?? [];
  }

  /** 取走并清空。**发送成功与否由调用方负责** —— 发不出去的由信使排队,不必回滚。 */
  take(userKey: string): PendingNotice[] {
    const list = this.byUser[userKey] ?? [];
    delete this.byUser[userKey];
    this.save();
    return list;
  }

  private save(): void {
    writeJsonFileAtomic(this.path, this.byUser);
  }
}

/**
 * 现在是不是在静默窗口里。
 *
 * `spec` 形如 `"23:00-08:00"`,**允许跨零点**(那正是它最常见的样子)。
 * 起止相同的情况在校验层就拒了,这里不必再纠结它的含义。
 */
export function inQuietHours(spec: string | undefined, at: number, tz: string): boolean {
  if (!spec) return false;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(spec);
  if (!m) return false;
  const w = wallClockIn(tz, at);
  const cur = w.h * 60 + w.mi;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  // 起点在终点之前 = 同一天里的一段;否则是跨零点的那种(23:00-08:00)。
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

const STATUS_CN: Partial<Record<RunStatus, string>> = {
  ok: "成功",
  failed: "失败",
  timeout: "超时",
  interrupted: "中断",
  error: "没起来",
};

/**
 * 把攒着的通知合并成要发的几条。
 *
 * 一个任务只攒到一条就原样发(那条本来就写得很全);攒到多条才折成摘要 ——
 * 逐条补发十几条几小时前的结果,除了刷屏没有别的作用,而且每一条都在花预算。
 */
export function mergeNotices(pending: readonly PendingNotice[]): string[] {
  const byJob = new Map<string, PendingNotice[]>();
  for (const n of pending) {
    const list = byJob.get(n.jobId) ?? [];
    list.push(n);
    byJob.set(n.jobId, list);
  }
  const out: string[] = [];
  for (const list of byJob.values()) {
    if (list.length === 1) {
      out.push(list[0]!.text);
      continue;
    }
    const okCount = list.filter((n) => n.status === "ok").length;
    const bad = list.length - okCount;
    const last = list[list.length - 1]!;
    const parts = [`⏰ 「${last.jobName}」静默时段里跑了 ${list.length} 次:${okCount} 次成功`];
    if (bad) {
      // 失败的分类型列出来:「3 次失败」与「1 次超时 2 次没起来」是两种排查方向。
      const kinds = new Map<string, number>();
      for (const n of list) {
        if (n.status === "ok") continue;
        const k = STATUS_CN[n.status] ?? n.status;
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
      }
      parts[0] += `、${[...kinds].map(([k, v]) => `${v} 次${k}`).join("、")}`;
    }
    out.push(`${parts[0]}。\n最后一次是这样:\n${last.text}`);
  }
  return out;
}
