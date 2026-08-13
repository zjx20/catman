import { formatAt } from "./schedule.js";
import type { CronJob, CronRun } from "./types.js";

/**
 * 通知文案。**纯函数** —— 发不发、发给谁是 scheduler 的事,这里只负责说什么。
 *
 * ## 为什么通知这件事要克制
 *
 * 主动推送花的是用户**上一条来信**带来的发送预算(一份 10 条,见 README
 * 「一个 context_token 的发送预算」)。半夜跑的任务,通知多半当场发不出去,
 * 而是进信使的发件队列,等他下次开口才补发。所以:
 *
 * - 默认**只在跑完时说一条**。开跑那条要显式打开 —— 它只对"要跑很久、想知道
 *   开始了没"的任务有意义,而那种任务本来就少。
 * - 开跑用 `reminder`(队列策略是"只留最新"),跑完用 `announce`(一条不丢)。
 *   离线期间攒下的开跑消息会自动塌缩成一条,而结果一条都不会少。
 * - **不新增 SendKind**。信使跑的是钉住的旧版本,它不认识的 kind 会让整个信封
 *   读不懂 —— 那条消息就恰好在最需要它的时候消失了。
 *
 * 每条结果都带**下次触发时刻**:用户看到消息的时间可能比实际执行晚很多,
 * 没有这一行他无从判断自己看到的是不是最新的那次。
 */

/** 通知里最多带多少字的输出。够看清结论,又不至于一条消息刷满屏幕。 */
const TAIL_CHARS = 500;

export function formatDuration(ms: number): string {
  if (ms < 1000) return "不到 1 秒";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} 分 ${rest} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

const TRIGGER_CN: Record<CronRun["trigger"], string> = {
  schedule: "",
  manual: "(手动试跑)",
  catchup: "(补跑上一档错过的)",
};

export function renderStart(job: CronJob, run: CronRun): string {
  return `⏰ 「${job.name}」开始跑了${TRIGGER_CN[run.trigger]}`;
}

/** 结果通知。`nextText` 由调用方算好 —— 它要读全局配置,不属于纯函数这一侧。 */
export function renderEnd(job: CronJob, run: CronRun, tail: string, nextText: string): string {
  const dur = run.endedAt ? formatDuration(run.endedAt - run.startedAt) : "";
  const head = ((): string => {
    switch (run.status) {
      case "ok":
        return `✅ 「${job.name}」跑完了,${dur}`;
      case "failed":
        return `❌ 「${job.name}」失败了(退出码 ${run.exitCode ?? "?"},${dur})`;
      case "timeout":
        return `⏱ 「${job.name}」超时被中止(${dur})`;
      case "interrupted":
        return `⚠️ 「${job.name}」没跑完 —— 容器不见了(多半是我自己被重启了)`;
      case "skipped":
        return `⏭ 「${job.name}」这一轮跳过了`;
      case "error":
        return `❌ 「${job.name}」压根没起来`;
      default:
        return `「${job.name}」${run.status}`;
    }
  })();

  const lines = [head + TRIGGER_CN[run.trigger]];
  const body = trimTail(tail);
  if (body) lines.push(body);
  else if (run.status === "ok") lines.push("(没有输出)");
  if (run.note) lines.push(run.note);
  lines.push(nextText);
  return lines.join("\n");
}

/** 连续失败到阈值、任务被自动停用时那一条。 */
export function renderAutoDisabled(job: CronJob, streak: number): string {
  return (
    `🛑 「${job.name}」已连续失败 ${streak} 次,我把它停用了 —— 免得它一直空转。\n` +
    "修好之后跟我说一声,我把它打开。"
  );
}

/**
 * 「下次:…」那一行。
 *
 * 一次性任务要单独说清楚:它跑完之后同样是 enabled=false,但那是**跑完了**,
 * 不是谁把它关了。两种情况都说"已停用"的话,用户会以为出了什么事。
 */
export function renderNextLine(
  at: number | undefined,
  tz: string,
  enabled: boolean,
  oneShot = false,
): string {
  if (oneShot && at === undefined) return "下次:不再触发(一次性任务,这就是最后一次)";
  if (!enabled) return "下次:已停用";
  if (at === undefined) return "下次:不再触发";
  return `下次:${formatAt(at, tz)}`;
}

function trimTail(tail: string): string {
  const s = tail.replace(/\s+$/, "");
  if (!s) return "";
  if (s.length <= TAIL_CHARS) return s;
  return `…\n${s.slice(s.length - TAIL_CHARS)}`;
}
