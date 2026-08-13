import type { CronStore } from "../core/cron/store.js";
import type { CronRun } from "../core/cron/types.js";
import type { ApiResult } from "./api-self.js";

/**
 * `/api/admin/cron/...` —— dashboard 页面上那几个按钮(启停、试跑、看输出)。
 *
 * 与 `/api/me/cron` 是**两套鉴权、两种作用域**,刻意不合并:
 *
 * - `/api/me/cron` 用回合令牌,身份由令牌决定,谁也看不见别人的任务。给 agent 用。
 * - 这一套用 dashboard 的 admin 令牌(**只认请求头**,见 auth.ts 的 CSRF 说明),
 *   管得到**所有人**的任务。给坐在 dashboard 前面的管理员用。
 *
 * 合并的话就得在同一个处理函数里判"这次是哪种身份",而那种判断写错一次就是
 * 越权 —— 分开之后,越权在类型上就不成立:这个文件根本拿不到回合令牌。
 *
 * 这里**只做那三件页面上有按钮的事**。改任务体、改周期一律走 agent 那条路
 * (那边有完整的入口校验);管理员想改,跟助手说一句就行。
 */

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const err = (status: number, message: string): ApiResult => ({ status, body: { error: message } });

export interface CronAdminApiDeps {
  readonly store: CronStore;
  readonly scheduler?: {
    runNow(jobId: string): Promise<CronRun | { error: string }>;
  };
}

export const CRON_ADMIN_PREFIX = "/api/admin/cron";

export function isCronAdminApiPath(path: string): boolean {
  return path === CRON_ADMIN_PREFIX || path.startsWith(`${CRON_ADMIN_PREFIX}/`);
}

export async function handleCronAdminApi(
  method: string,
  path: string,
  body: unknown,
  deps: CronAdminApiDeps,
): Promise<ApiResult> {
  const rest = path.slice(CRON_ADMIN_PREFIX.length).replace(/^\//, "");
  const parts = rest ? rest.split("/") : [];

  if (!parts.length) {
    if (method === "GET") {
      return ok({ jobs: deps.store.all() });
    }
    return err(405, `${CRON_ADMIN_PREFIX} 只支持 GET`);
  }

  const job = deps.store.get(parts[0]!);
  if (!job) return err(404, "没有这个任务");

  // 启停:页面上那个开关。**只认 enabled 这一个字段** —— 别的改动都该走
  // /api/me/cron,那边才有完整的入口校验(周期、频率下限、挂载白名单…)。
  if (parts.length === 1 && method === "PATCH") {
    if (typeof body !== "object" || body === null) return err(400, "请求体需要是一个 JSON 对象");
    const raw = (body as Record<string, unknown>)["enabled"];
    if (typeof raw !== "boolean") return err(400, "只能改 enabled(true / false)");
    // 停用时把排期一起清掉,启用时留空 —— 调度器 start/tick 会重新算出来。
    // 这里不算是因为算它要读频率下限等一堆上下文,而那些只在校验层有。
    const next = deps.store.patch(job.id, raw ? { enabled: true } : { enabled: false, nextAt: undefined });
    return ok({ ok: true, id: job.id, enabled: next?.enabled });
  }

  if (parts.length === 2 && parts[1] === "run" && method === "POST") {
    if (!deps.scheduler) return err(503, "这台机器没有调度器在跑,试跑不了");
    const r = await deps.scheduler.runNow(job.id);
    if ("error" in r) return err(409, r.error);
    return ok({ ok: true, run: r.id });
  }

  // 输出按需拉:一次执行可能有几百 KB,全塞进页面会把列表拖垮。
  if (parts.length === 3 && parts[1] === "runs" && method === "GET") {
    const run = deps.store.getRun(job.id, parts[2]!);
    if (!run) return err(404, "没有这次执行记录(可能已经被保留策略清掉了)");
    return ok({ ...run, log: deps.store.readLog(job.id, run.id) });
  }

  return err(404, "没有这个接口");
}
