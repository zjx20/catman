import type { TurnTokens } from "../core/turn-tokens.js";
import type { CronStore } from "../core/cron/store.js";
import type { CronJob, CronRun } from "../core/cron/types.js";
import { describeSchedule, formatAt } from "../core/cron/schedule.js";
import {
  CronInputError,
  MAX_JOBS_PER_USER,
  mergeJobPatch,
  validateJobInput,
  type ValidateContext,
} from "../core/cron/validate.js";

/**
 * `/api/me/cron` —— agent 管理**自己这个用户**的定时任务。
 *
 * 鉴权与 `/api/me` 完全一样:回合令牌(`X-Catman-Session`),身份由令牌决定,
 * 没有"改谁"这个参数。任务按 userKey 归属,别人的任务在这里连存在都看不出来
 * (查不到一律 404,不回 403 —— 403 本身就是"确实有这么个 id"的回答)。
 *
 * 路由做成不碰 req/res 的函数,server.ts 只做 IO 适配 —— 与 api-self.ts 同一个拆法。
 */

export const CRON_API_PREFIX = "/api/me/cron";

export interface CronApiDeps {
  readonly turns: TurnTokens;
  readonly store: CronStore;
  /** 手动试跑 / 删任务前停在飞的那一轮。没有调度器(本地开发、守护人格)时缺席。 */
  readonly scheduler?: {
    runNow(jobId: string): Promise<CronRun | { error: string }>;
    cancelJob(jobId: string): Promise<void>;
  };
  /** 现读的校验上下文 —— 管理员改了下限/白名单,下一次创建就按新的来。 */
  readonly validateContext: () => ValidateContext;
  readonly tz: string;
  readonly now?: () => number;
}

export interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const err = (status: number, message: string): ApiResult => ({ status, body: { error: message } });

export function isCronApiPath(path: string): boolean {
  return path === CRON_API_PREFIX || path.startsWith(`${CRON_API_PREFIX}/`);
}

export async function handleCronApi(
  method: string,
  path: string,
  token: string | undefined,
  body: unknown,
  deps: CronApiDeps,
): Promise<ApiResult> {
  const ctx = token ? deps.turns.resolve(token) : undefined;
  if (!ctx) return err(401, "需要有效的 X-Catman-Session 请求头(回合令牌只在本回合内有效)");
  const userKey = ctx.userKey;
  const rest = path.slice(CRON_API_PREFIX.length).replace(/^\//, "");
  const parts = rest ? rest.split("/") : [];

  try {
    if (!parts.length) {
      if (method === "GET") return ok({ jobs: deps.store.ofUser(userKey).map((j) => viewJob(j, deps)) });
      if (method === "POST") return createJob(userKey, body, deps);
      return err(405, `${CRON_API_PREFIX} 只支持 GET(列出)与 POST(新建)`);
    }

    // 任务 id 一律先解析 + 查归属,后面的分支就不必各查一遍。
    const job = deps.store.get(parts[0]!);
    if (!job || job.userKey !== userKey) return err(404, "没有这个任务");

    if (parts.length === 1) {
      if (method === "GET") return ok(viewJob(job, deps));
      if (method === "PATCH") return patchJob(job, body, deps);
      if (method === "DELETE") {
        // **先停在飞的那一轮再删。** 反过来的话,记录随任务一起没了,而那个容器
        // 还在宿主上跑着 —— 从此没有任何东西认领得了它。
        await deps.scheduler?.cancelJob(job.id);
        deps.store.remove(job.id);
        return ok({ ok: true, removed: job.id, name: job.name });
      }
      return err(405, "任务本身支持 GET / PATCH / DELETE");
    }

    if (parts.length === 2 && parts[1] === "run" && method === "POST") {
      if (!deps.scheduler) return err(503, "这台机器没有调度器在跑,试跑不了");
      const r = await deps.scheduler.runNow(job.id);
      if ("error" in r) return err(409, r.error);
      return ok({
        ok: true,
        run: viewRun(r),
        note: "已经起跑了。跑完的结果去 runs 接口看 —— 这个调用不等它跑完,也不影响排期。",
      });
    }

    if (parts[1] === "runs" && method === "GET") {
      if (parts.length === 2) {
        const limit = 20;
        return ok({ runs: deps.store.listRuns(job.id, limit).map(viewRun) });
      }
      if (parts.length === 3) {
        const run = deps.store.getRun(job.id, parts[2]!);
        if (!run) return err(404, "没有这次执行记录(可能已经被保留策略清掉了)");
        return ok({ ...viewRun(run), log: deps.store.readLog(job.id, run.id) });
      }
    }

    return err(404, "没有这个接口");
  } catch (e) {
    if (e instanceof CronInputError) return err(400, e.message);
    console.error("[cron-api] 处理失败:", e);
    return err(500, `内部错误:${String(e)}`);
  }
}

function createJob(userKey: string, body: unknown, deps: CronApiDeps): ApiResult {
  const mine = deps.store.ofUser(userKey);
  if (mine.length >= MAX_JOBS_PER_USER) {
    return err(400, `你的定时任务已经有 ${mine.length} 个了(上限 ${MAX_JOBS_PER_USER}),先删几个`);
  }
  const input = validateJobInput(body, deps.validateContext());
  const now = deps.now?.() ?? Date.now();
  const job: CronJob = {
    id: deps.store.newJobId(),
    userKey,
    name: input.name,
    enabled: input.enabled,
    schedule: input.schedule,
    task: input.task,
    timeoutMs: input.timeoutMs,
    overlap: input.overlap,
    notify: input.notify,
    keepRuns: input.keepRuns,
    createdAt: now,
    updatedAt: now,
    ...(input.enabled ? { nextAt: input.nextAt } : {}),
    failStreak: 0,
  };
  deps.store.put(job);
  return { status: 201, body: viewJob(job, deps) };
}

function patchJob(job: CronJob, body: unknown, deps: CronApiDeps): ApiResult {
  // 补丁先合成一份完整定义,再整体过一遍校验 —— 局部校验总会漏掉组合出来的坏状态
  // (比如把周期改密之后,原来合法的 timeout 就比间隔还长了)。
  const merged = mergeJobPatch(job, body);
  const input = validateJobInput(merged, deps.validateContext());
  const next = deps.store.patch(job.id, {
    name: input.name,
    enabled: input.enabled,
    schedule: input.schedule,
    task: input.task,
    timeoutMs: input.timeoutMs,
    overlap: input.overlap,
    notify: input.notify,
    keepRuns: input.keepRuns,
    // 改了周期就重算下次触发;停用则清掉排期(重新启用时会重新算)。
    nextAt: input.enabled ? input.nextAt : undefined,
    // 手动改过的任务给一次重新开始的机会 —— 否则修好之后还差一次失败就被自动停用。
    failStreak: 0,
  });
  return ok(viewJob(next!, deps));
}

function viewJob(job: CronJob, deps: CronApiDeps): Record<string, unknown> {
  const tz = job.schedule.kind === "cron" ? job.schedule.tz : deps.tz;
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled,
    schedule: job.schedule,
    scheduleText: describeSchedule(job.schedule, tz),
    task: job.task,
    timeoutMinutes: Math.round(job.timeoutMs / 60_000),
    overlap: job.overlap,
    notify: job.notify,
    keepRuns: job.keepRuns,
    nextAt: job.nextAt,
    nextAtText: nextText(job, tz),
    lastRunAt: job.lastRunAt,
    lastRunAtText: job.lastRunAt ? formatAt(job.lastRunAt, tz) : undefined,
    lastStatus: job.lastStatus,
    failStreak: job.failStreak,
    createdAt: job.createdAt,
  };
}

/**
 * 「下次什么时候跑」的人话。一次性任务跑完之后同样是 enabled=false,但那是
 * **跑完了**而不是谁把它关了 —— 两种都说"已停用"会让人以为出了什么事。
 */
function nextText(job: CronJob, tz: string): string {
  if (job.enabled && job.nextAt !== undefined) return formatAt(job.nextAt, tz);
  if (job.schedule.kind === "once") return "跑完了,不再触发";
  return "已停用";
}

function viewRun(run: CronRun): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.endedAt ? run.endedAt - run.startedAt : undefined,
    exitCode: run.exitCode,
    note: run.note,
    logBytes: run.logBytes,
  };
}
