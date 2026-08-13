import { minGapMs, nextAt, parseCronExpr, type CronSchedule } from "./schedule.js";
import type { CronJob, CronMount, CronNotify, CronTask, OverlapPolicy } from "./types.js";

/**
 * 创建/修改定时任务时的**入口校验**。
 *
 * ## 为什么这层要写得这么厚
 *
 * 这个接口的调用方是 LLM(就是我自己)。它会把 `minutes` 写成 `minute`、把 cmd
 * 写成一个字符串、把 `0 8 * * *` 写成 `8 0 * * *`、把 timeout 的单位记错一个量级。
 * 这些错**没有一个会在写入时报错** —— 它们全都在半夜某个没人看着的时刻,以
 * "任务没跑""任务疯跑""容器把宿主吃满"的形式暴露出来。
 *
 * 所以这里的三条纪律:
 *
 * 1. **未知字段一律拒收。** 拼错的字段名如果被忽略,配置就会静默退回默认值 ——
 *    用户以为设了 `timeoutMinutes: 60`,实际跑的是 10 分钟。宁可报错。
 * 2. **字段名自带单位**(`minutes` / `timeoutMinutes`),盘上再换算成 ms。
 *    裸 number 是这类接口最容易出的一类错,而它没有任何症状。
 * 3. **能当场验证的就当场验证**:cron 表达式真解析一遍、真算出下次触发时刻、
 *    真算出相邻两次的最小间隔。存进去一个永远不触发或每分钟触发的任务,
 *    比拒收难查得多。
 *
 * 校验通过后返回的是**填满默认值的完整任务**,store 与 scheduler 从此不必再
 * 应付"这个字段可能没有"。
 */

export class CronInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronInputError";
  }
}

const fail = (msg: string): never => {
  throw new CronInputError(msg);
};

/** 一个任务最多几条挂载。 */
export const MAX_MOUNTS = 4;
/** 一个用户最多几个任务。 */
export const MAX_JOBS_PER_USER = 50;
export const MAX_NAME_CHARS = 64;
export const MAX_CMD_ITEMS = 64;
export const MAX_CMD_CHARS = 4000;
export const MAX_ENV_ITEMS = 32;
export const MIN_TIMEOUT_MINUTES = 1;
export const MAX_TIMEOUT_MINUTES = 120;
export const MIN_EVERY_MINUTES = 1;
export const MAX_EVERY_MINUTES = 60 * 24 * 30;
export const MIN_KEEP_RUNS = 1;
export const MAX_KEEP_RUNS = 200;
/** 默认镜像:catman 自己那个稳定基底,本机一定有,带 bash / node / curl。 */
export const DEFAULT_IMAGE = "catman-env:1";
export const DEFAULT_LIMITS = { memory: "512m", cpus: 0.5, pids: 128 } as const;
/** 找不到一年内的触发时刻就认为这个表达式是死的。 */
const NO_FIRE_HORIZON_MS = 400 * 24 * 60 * 60 * 1000;

export interface ValidateContext {
  /** 没写 tz 时用它。取容器的 TZ,通常是 Asia/Shanghai。 */
  readonly defaultTz: string;
  /** 两次触发之间的下限。软路由上把它设小是自找麻烦。 */
  readonly minIntervalMs: number;
  readonly defaultKeepRuns: number;
  /** 允许挂载的**宿主**路径前缀。空数组 = 一条挂载都不许加。 */
  readonly mountAllowlist: readonly string[];
  /**
   * /data 在宿主上的绝对路径。没有它就拼不出工作目录的 -v 参数,
   * 脚本任务在这台机器上根本跑不起来 —— 那就别让人建,而不是建完每次都失败。
   */
  readonly hostDataDir: string | undefined;
  readonly now: number;
}

// ── 基础取值 ──────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 未知字段一律拒收,并把认识的字段列出来 —— 拼错时这句话直接就是答案。 */
function noExtraKeys(v: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) {
    fail(`${where} 里有不认识的字段 ${extra.map((k) => JSON.stringify(k)).join("、")};可用的是:${allowed.join("、")}`);
  }
}

function reqString(v: unknown, where: string, max: number): string {
  if (typeof v !== "string") fail(`${where} 必须是字符串,给的是 ${typeName(v)}`);
  const s = (v as string).trim();
  if (!s) fail(`${where} 不能为空`);
  if (s.length > max) fail(`${where} 太长了(上限 ${max} 字符,给的是 ${s.length})`);
  // 控制字符进了容器命令行、推送文案或页面都是麻烦(换行还会把一条日志拆成两条),
  // 一律挡掉。命令里确实要换行的话,写成 bash -lc "…;…" 或者放进脚本文件。
  if (/[\u0000-\u001f\u007f]/.test(s)) fail(`${where} 里有控制字符(换行、制表符之类)`);
  return s;
}

function optInt(v: unknown, where: string, min: number, max: number, dflt: number): number {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(`${where} 必须是数字,给的是 ${typeName(v)}`);
  }
  const n = v as number;
  if (!Number.isInteger(n)) fail(`${where} 必须是整数,给的是 ${n}`);
  // **越界报错而不是夹取**:与 settings 那边的 clamp 刻意不同。那边改的是偏好,
  // 夹一下无非体验差点;这边越界多半是单位记错了(比如把分钟当成了毫秒填),
  // 夹成上限会让任务以一个用户完全没预期的节奏跑起来。
  if (n < min || n > max) fail(`${where} 应在 ${min}-${max} 之间,给的是 ${n}`);
  return n;
}

function optBool(v: unknown, where: string, dflt: boolean): boolean {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "boolean") fail(`${where} 只接受 true 或 false,给的是 ${typeName(v)}`);
  return v as boolean;
}

function optEnum<T extends string>(
  v: unknown,
  where: string,
  allowed: readonly T[],
  dflt: T,
): T {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    fail(`${where} 只能是 ${allowed.join(" / ")},给的是 ${JSON.stringify(v)}`);
  }
  return v as T;
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  return typeof v;
}

// ── 周期 ──────────────────────────────────────────────────────────

/** 一次性任务的时刻必须带时区(Z 或 ±HH:MM)—— 不带的话"3 点"是谁的 3 点说不清。 */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function validateSchedule(raw: unknown, ctx: ValidateContext): CronSchedule {
  if (!isObject(raw)) fail(`schedule 必须是对象,给的是 ${typeName(raw)}`);
  const o = raw as Record<string, unknown>;
  const kind = optEnum(o["kind"], "schedule.kind", ["cron", "every", "once"] as const, "cron");

  if (kind === "cron") {
    noExtraKeys(o, ["kind", "expr", "tz"], "schedule");
    const expr = reqString(o["expr"], "schedule.expr", 120);
    const tz = o["tz"] === undefined ? ctx.defaultTz : reqString(o["tz"], "schedule.tz", 64);
    // 真解析一遍。语法错在这里就报出去,而不是等到第一次 tick。
    parseCronExpr(expr);
    return { kind: "cron", expr, tz };
  }

  if (kind === "every") {
    noExtraKeys(o, ["kind", "minutes"], "schedule");
    if (o["minutes"] === undefined) fail("schedule.minutes 必填(单位是分钟)");
    const minutes = optInt(o["minutes"], "schedule.minutes", MIN_EVERY_MINUTES, MAX_EVERY_MINUTES, 0);
    return { kind: "every", ms: minutes * 60_000 };
  }

  noExtraKeys(o, ["kind", "at"], "schedule");
  const at = reqString(o["at"], "schedule.at", 40);
  if (!ISO_WITH_OFFSET.test(at)) {
    fail(`schedule.at 要带时区的 ISO 时刻,如 "2026-08-20T03:00:00+08:00";给的是 ${JSON.stringify(at)}`);
  }
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) fail(`schedule.at 解析不出时刻:${JSON.stringify(at)}`);
  if (ms <= ctx.now) fail(`schedule.at 是过去的时刻(${at}),一次性任务这样建完就永远不会跑`);
  return { kind: "once", at: ms };
}

/** 频率闸:算真实的相邻间隔,而不是看表达式长什么样。 */
function checkFrequency(schedule: CronSchedule, ctx: ValidateContext): number {
  const first = nextAt(schedule, ctx.now);
  if (first === undefined || first - ctx.now > NO_FIRE_HORIZON_MS) {
    fail(
      "按这个周期算不出一年内的下次触发 —— 多半是写了个不存在的日子(比如 2 月 30 日)。",
    );
  }
  const gap = minGapMs(schedule, ctx.now);
  if (gap < ctx.minIntervalMs) {
    const mins = (n: number) => Math.round(n / 60_000);
    fail(
      `这个周期最快 ${mins(gap)} 分钟就触发一次,低于当前下限 ${mins(ctx.minIntervalMs)} 分钟。` +
        "(这台机器是 2 核软路由,跑太密会把宿主拖垮;确实需要就让管理员调 cronMinIntervalMs。)",
    );
  }
  return first!;
}

// ── 任务体 ────────────────────────────────────────────────────────

const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateMounts(raw: unknown, ctx: ValidateContext): CronMount[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(`task.mounts 必须是数组,给的是 ${typeName(raw)}`);
  const arr = raw as unknown[];
  if (arr.length > MAX_MOUNTS) fail(`task.mounts 最多 ${MAX_MOUNTS} 条,给的是 ${arr.length} 条`);
  return arr.map((item, i) => {
    const where = `task.mounts[${i}]`;
    if (!isObject(item)) fail(`${where} 必须是对象,给的是 ${typeName(item)}`);
    const o = item as Record<string, unknown>;
    noExtraKeys(o, ["host", "at", "ro"], where);
    const host = reqString(o["host"], `${where}.host`, 300);
    const at = reqString(o["at"], `${where}.at`, 200);
    if (!host.startsWith("/") || host.includes("..")) {
      fail(`${where}.host 要宿主上的绝对路径且不能含 ..(给的是 ${JSON.stringify(host)})`);
    }
    if (!at.startsWith("/") || at.includes("..") || at === "/") {
      fail(`${where}.at 要容器内的绝对路径且不能是 / 或含 ..(给的是 ${JSON.stringify(at)})`);
    }
    if (at === "/work" || at.startsWith("/work/")) {
      fail(`${where}.at 不能占用 /work —— 那是任务自己的工作目录`);
    }
    if (!ctx.mountAllowlist.length) {
      fail(`这台机器不允许任务挂载宿主目录(mountAllowlist 是空的),${where} 去掉吧`);
    }
    if (!ctx.mountAllowlist.some((p) => underPrefix(host, p))) {
      fail(
        `${where}.host 不在允许的范围内。可挂载的是:${ctx.mountAllowlist.join("、")}` +
          "(要放宽得让管理员改 cronMountAllowlist)",
      );
    }
    // **默认只读**。可写要显式写 ro:false —— 一次挂错路径 + 一句 rm -rf 就是
    // 不可逆的,让它至少需要两个字段同时写对。
    return { host, at, ro: optBool(o["ro"], `${where}.ro`, true) };
  });
}

function validateScriptTask(o: Record<string, unknown>, ctx: ValidateContext): CronTask {
  noExtraKeys(o, ["kind", "image", "cmd", "env", "network", "mounts", "limits"], "task");
  if (!ctx.hostDataDir) {
    fail(
      "这台机器没配 CATMAN_HOST_DATA_DIR(/data 在宿主上的路径),脚本任务的工作目录挂不进容器,建了也跑不起来。",
    );
  }
  const image = o["image"] === undefined ? DEFAULT_IMAGE : reqString(o["image"], "task.image", 200);
  if (!IMAGE_RE.test(image)) fail(`task.image 不像个镜像名:${JSON.stringify(image)}`);

  const rawCmd = o["cmd"];
  if (!Array.isArray(rawCmd)) {
    // 这条错最常见:LLM 顺手写成一整行 shell。把正确写法直接给出来。
    fail(
      `task.cmd 必须是字符串数组(exec 形式,不过 shell)。要用 shell 就写:` +
        `["bash","-lc","你的命令"];给的是 ${typeName(rawCmd)}`,
    );
  }
  const cmdArr = rawCmd as unknown[];
  if (!cmdArr.length) fail("task.cmd 不能是空数组");
  if (cmdArr.length > MAX_CMD_ITEMS) fail(`task.cmd 最多 ${MAX_CMD_ITEMS} 项`);
  const cmd = cmdArr.map((v, i) => reqString(v, `task.cmd[${i}]`, MAX_CMD_CHARS));

  const env: Record<string, string> = {};
  const rawEnv = o["env"];
  if (rawEnv !== undefined && rawEnv !== null) {
    if (!isObject(rawEnv)) fail(`task.env 必须是对象,给的是 ${typeName(rawEnv)}`);
    const entries = Object.entries(rawEnv as Record<string, unknown>);
    if (entries.length > MAX_ENV_ITEMS) fail(`task.env 最多 ${MAX_ENV_ITEMS} 项`);
    for (const [k, v] of entries) {
      if (!ENV_KEY_RE.test(k)) fail(`task.env 的键 ${JSON.stringify(k)} 不是合法环境变量名`);
      env[k] = reqString(v, `task.env.${k}`, MAX_CMD_CHARS);
    }
  }

  const limits = validateLimits(o["limits"]);
  return {
    kind: "script",
    image,
    cmd,
    env,
    // 默认**断网**。要联网就显式说 —— 定时任务往外发请求是一类需要有人想过的事。
    network: optEnum(o["network"], "task.network", ["none", "mynet"] as const, "none"),
    mounts: validateMounts(o["mounts"], ctx),
    limits,
  };
}

function validateLimits(raw: unknown): CronJob["task"]["limits"] {
  if (raw === undefined || raw === null) return { ...DEFAULT_LIMITS };
  if (!isObject(raw)) fail(`task.limits 必须是对象,给的是 ${typeName(raw)}`);
  const o = raw as Record<string, unknown>;
  noExtraKeys(o, ["memory", "cpus", "pids"], "task.limits");
  let memory: string = DEFAULT_LIMITS.memory;
  if (o["memory"] !== undefined) {
    memory = reqString(o["memory"], "task.limits.memory", 16);
    if (!/^\d{1,5}[mg]$/.test(memory)) {
      fail(`task.limits.memory 要形如 "512m" 或 "2g",给的是 ${JSON.stringify(memory)}`);
    }
    const mb = memory.endsWith("g") ? Number(memory.slice(0, -1)) * 1024 : Number(memory.slice(0, -1));
    if (mb < 32 || mb > 4096) fail(`task.limits.memory 应在 32m-4096m 之间,给的是 ${memory}`);
  }
  let cpus: number = DEFAULT_LIMITS.cpus;
  if (o["cpus"] !== undefined) {
    if (typeof o["cpus"] !== "number" || !Number.isFinite(o["cpus"])) {
      fail(`task.limits.cpus 必须是数字,给的是 ${typeName(o["cpus"])}`);
    }
    cpus = Math.round((o["cpus"] as number) * 100) / 100;
    if (cpus < 0.1 || cpus > 2) fail(`task.limits.cpus 应在 0.1-2 之间,给的是 ${cpus}`);
  }
  const pids = optInt(o["pids"], "task.limits.pids", 16, 512, DEFAULT_LIMITS.pids);
  return { memory, cpus, pids };
}

function validateTask(raw: unknown, ctx: ValidateContext): CronTask {
  if (!isObject(raw)) fail(`task 必须是对象,给的是 ${typeName(raw)}`);
  const o = raw as Record<string, unknown>;
  const kind = optEnum(o["kind"], "task.kind", ["script"] as const, "script");
  if (kind !== "script") fail(`暂时只支持 task.kind = "script"`);
  return validateScriptTask(o, ctx);
}

function validateNotify(raw: unknown): CronNotify {
  if (raw === undefined || raw === null) return { start: false, end: true, onlyFailure: false };
  if (!isObject(raw)) fail(`notify 必须是对象,给的是 ${typeName(raw)}`);
  const o = raw as Record<string, unknown>;
  noExtraKeys(o, ["start", "end", "onlyFailure"], "notify");
  return {
    start: optBool(o["start"], "notify.start", false),
    end: optBool(o["end"], "notify.end", true),
    onlyFailure: optBool(o["onlyFailure"], "notify.onlyFailure", false),
  };
}

// ── 入口 ──────────────────────────────────────────────────────────

const JOB_KEYS = [
  "name",
  "enabled",
  "schedule",
  "task",
  "timeoutMinutes",
  "overlap",
  "notify",
  "keepRuns",
] as const;

export interface ValidatedJobInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly schedule: CronSchedule;
  readonly task: CronTask;
  readonly timeoutMs: number;
  readonly overlap: OverlapPolicy;
  readonly notify: CronNotify;
  readonly keepRuns: number;
  /** 顺手算出来的下次触发时刻 —— 校验时本来就要算一次,别让调用方再算一遍。 */
  readonly nextAt: number;
}

/**
 * 校验一份**完整**的任务定义。
 *
 * PATCH 也走这里:先把补丁合到现有任务上,再整体验一遍。这样"改一个字段"
 * 不可能绕过任何一条不变量 —— 局部校验早晚会漏,而这里只有一条路。
 */
export function validateJobInput(raw: unknown, ctx: ValidateContext): ValidatedJobInput {
  if (!isObject(raw)) throw new CronInputError(`任务定义必须是一个 JSON 对象,给的是 ${typeName(raw)}`);
  const o = raw as Record<string, unknown>;
  noExtraKeys(o, JOB_KEYS as unknown as string[], "任务定义");

  if (o["schedule"] === undefined) fail("schedule 必填");
  if (o["task"] === undefined) fail("task 必填");

  const name = reqString(o["name"], "name", MAX_NAME_CHARS);
  const schedule = validateSchedule(o["schedule"], ctx);
  const firstAt = checkFrequency(schedule, ctx);
  const task = validateTask(o["task"], ctx);
  const gap = minGapMs(schedule, ctx.now);
  // 默认超时**跟着周期走**:10 分钟,但不超过一个触发间隔。密集的任务(每 5 分钟)
  // 于是不必每次都显式写超时,而"超时比周期还长"这条不变量照样成立。
  const defaultTimeout = Number.isFinite(gap)
    ? Math.max(MIN_TIMEOUT_MINUTES, Math.min(10, Math.floor(gap / 60_000)))
    : 10;
  const timeoutMinutes = optInt(
    o["timeoutMinutes"],
    "timeoutMinutes",
    MIN_TIMEOUT_MINUTES,
    MAX_TIMEOUT_MINUTES,
    defaultTimeout,
  );
  const timeoutMs = timeoutMinutes * 60_000;

  // 超时比周期还长 = 每一轮都还没跑完下一轮就到点了。按 overlap 策略要么永远跳过、
  // 要么永远互杀,两种都不是用户想要的,当场说清楚。
  if (Number.isFinite(gap) && timeoutMs > gap) {
    fail(
      `timeoutMinutes(${timeoutMinutes} 分钟)比触发间隔(${Math.round(gap / 60_000)} 分钟)还长,` +
        "每一轮都会撞上下一轮。把超时调小,或者把周期放宽。",
    );
  }

  return {
    name,
    enabled: optBool(o["enabled"], "enabled", true),
    schedule,
    task,
    timeoutMs,
    overlap: optEnum(o["overlap"], "overlap", ["skip", "replace"] as const, "skip"),
    notify: validateNotify(o["notify"]),
    keepRuns: optInt(o["keepRuns"], "keepRuns", MIN_KEEP_RUNS, MAX_KEEP_RUNS, ctx.defaultKeepRuns),
    nextAt: firstAt,
  };
}

/**
 * 把 PATCH 的补丁合到现有任务上,产出一份可以整体校验的输入。
 *
 * 用现有任务反推出"输入形状"(ms → minutes 之类)再合并,而不是让补丁直接改
 * 盘上结构 —— 两种形状只在这一个函数里打照面,别处都只见得到其中一种。
 */
export function mergeJobPatch(job: CronJob, patch: unknown): unknown {
  if (!isObject(patch)) throw new CronInputError(`补丁必须是一个 JSON 对象,给的是 ${typeName(patch)}`);
  const current: Record<string, unknown> = {
    name: job.name,
    enabled: job.enabled,
    schedule: scheduleToInput(job.schedule),
    task: taskToInput(job.task),
    timeoutMinutes: Math.round(job.timeoutMs / 60_000),
    overlap: job.overlap,
    notify: { ...job.notify },
    keepRuns: job.keepRuns,
  };
  // 顶层浅合并:给了 schedule 就整个换掉,不做深合并 —— 深合并会让
  // "把 cron 改成 every"这种切换留下上一种形状的残字段,而那正是 noExtraKeys 要拦的。
  noExtraKeys(patch as Record<string, unknown>, JOB_KEYS as unknown as string[], "补丁");
  return { ...current, ...(patch as Record<string, unknown>) };
}

function scheduleToInput(s: CronSchedule): Record<string, unknown> {
  if (s.kind === "cron") return { kind: "cron", expr: s.expr, tz: s.tz };
  if (s.kind === "every") return { kind: "every", minutes: Math.round(s.ms / 60_000) };
  return { kind: "once", at: new Date(s.at).toISOString() };
}

function taskToInput(t: CronTask): Record<string, unknown> {
  return {
    kind: t.kind,
    image: t.image,
    cmd: [...t.cmd],
    env: { ...t.env },
    network: t.network,
    mounts: t.mounts.map((m) => ({ ...m })),
    limits: { ...t.limits },
  };
}

/** `/opt/services` 覆盖 `/opt/services/x`,但**不**覆盖 `/opt/services-evil`。 */
function underPrefix(path: string, prefix: string): boolean {
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === p || path.startsWith(`${p}/`);
}
