import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readJsonFile, writeJsonFileAtomic } from "../file-store.js";
import type { CronJob, CronRun, RunStatus } from "./types.js";

/**
 * 定时任务与执行记录的落盘。
 *
 * 布局(全在 `<dataDir>/cron/` 下):
 *   jobs.json                任务表(一份,原子写)
 *   runs/<jobId>/<runId>.json  一次执行的元数据
 *   runs/<jobId>/<runId>.log   那次执行的输出(有上限,超了掐头留尾)
 *   work/<jobId>/              任务自己的工作目录,挂进容器的 /work
 *
 * ## 认不出来的任务:隔离,不删
 *
 * 部署随时会回滚,于是**旧版本必然会读到新版本写的任务表**(比如 P2 加的 agent
 * 任务被 P1 读到)。那时候把认不出的条目丢掉,就等于一次回滚永久吃掉用户的任务 ——
 * 而这类损坏是静默的:他只会发现"我那个任务不见了"。
 *
 * 所以认不出的条目原样留在内存里,保存时一起写回去,只是不参与调度并记一行日志。
 * 代价是一个 id 冲突的可能(可忽略:id 是随机的),换来的是回滚安全。
 */

/** 单次输出保留的字节上限。掐头留尾 —— 排查要的正是最前面和最后面。 */
const MAX_LOG_BYTES = 256 * 1024;
const HEAD_BYTES = 64 * 1024;
/** 执行记录的年龄上限。按次数保留是主闸,这条是防"一个每月任务留 20 次 = 20 个月"。 */
export const DEFAULT_RUN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

interface JobsFile {
  jobs?: unknown[];
}

export interface CronStoreOptions {
  /** `<dataDir>/cron`。 */
  readonly dir: string;
  /**
   * 同一个目录在**宿主**上的路径(`<hostDataDir>/cron`)。缺席 = 这台机器没配,
   * 脚本任务跑不了。
   *
   * 由装配处一次性给出,而不是让调度器拿"容器内路径去掉 /data 前缀"现算 ——
   * 那种算法在 `dir` 不在 `/data` 底下时会静默返回错的路径,而它的症状是
   * "任务跑了但工作目录是空的",且只在真机上才看得见。
   */
  readonly hostDir?: string;
  readonly now?: () => number;
}

export class CronStore {
  private readonly dir: string;
  private readonly hostDir: string | undefined;
  private readonly jobsPath: string;
  private readonly now: () => number;
  private jobs: CronJob[] = [];
  /** 本版本认不出的条目,原样写回(见文件头)。 */
  private foreign: unknown[] = [];

  constructor(opts: CronStoreOptions) {
    this.dir = opts.dir;
    this.hostDir = opts.hostDir;
    this.jobsPath = join(opts.dir, "jobs.json");
    this.now = opts.now ?? Date.now;
    this.load();
  }

  private load(): void {
    const raw = readJsonFile<JobsFile>(this.jobsPath, {});
    const list = Array.isArray(raw.jobs) ? raw.jobs : [];
    for (const item of list) {
      const job = parseJob(item);
      if (job) this.jobs.push(job);
      else {
        this.foreign.push(item);
        console.warn("[cron] 任务表里有本版本认不出的条目,已隔离(不调度、不删除)");
      }
    }
  }

  private save(): void {
    writeJsonFileAtomic(this.jobsPath, { jobs: [...this.jobs, ...this.foreign] });
  }

  // ── 任务 ────────────────────────────────────────────────────────

  all(): CronJob[] {
    return [...this.jobs];
  }

  ofUser(userKey: string): CronJob[] {
    return this.jobs.filter((j) => j.userKey === userKey);
  }

  get(id: string): CronJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  put(job: CronJob): CronJob {
    const i = this.jobs.findIndex((j) => j.id === job.id);
    if (i >= 0) this.jobs[i] = job;
    else this.jobs.push(job);
    this.save();
    return job;
  }

  /** 局部更新。任务不存在返回 undefined —— 调用方据此回 404。 */
  patch(id: string, patch: Partial<CronJob>): CronJob | undefined {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i < 0) return undefined;
    const next = { ...this.jobs[i]!, ...patch, updatedAt: this.now() };
    this.jobs[i] = next;
    this.save();
    return next;
  }

  remove(id: string): boolean {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i < 0) return false;
    this.jobs.splice(i, 1);
    this.save();
    // 记录跟着任务一起走。留着的话它们再也没有入口,只是在磁盘上慢慢堆着。
    rmSync(this.runsDir(id), { recursive: true, force: true });
    rmSync(this.workDir(id), { recursive: true, force: true });
    return true;
  }

  /** 新任务 id。短、可读、不会与文件名规则打架。 */
  newJobId(): string {
    for (;;) {
      const id = `j_${randomBytes(4).toString("hex")}`;
      if (!this.get(id)) return id;
    }
  }

  // ── 目录 ────────────────────────────────────────────────────────

  /** 任务的工作目录(容器里的 /work)。建出来并**归自己所有** —— 容器以同一个 uid 跑。 */
  workDir(jobId: string): string {
    return join(this.dir, "work", jobId);
  }

  ensureWorkDir(jobId: string): string {
    const p = this.workDir(jobId);
    mkdirSync(p, { recursive: true });
    return p;
  }

  /**
   * 工作目录在**宿主**上的路径,给 `docker -v` 用。没配宿主路径时返回 undefined。
   *
   * docker 的 `-v` 只认宿主视角:传容器内的路径进去,dockerd 会在宿主上静默建一个
   * 空目录然后挂上 —— 任务照跑,但读写的是个谁也找不到的地方,宿主上还留着垃圾。
   */
  hostWorkDir(jobId: string): string | undefined {
    return this.hostDir ? join(this.hostDir, "work", jobId) : undefined;
  }

  private runsDir(jobId: string): string {
    return join(this.dir, "runs", jobId);
  }

  // ── 执行记录 ────────────────────────────────────────────────────

  newRunId(at: number): string {
    const d = new Date(at);
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    const stamp =
      `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
      `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
    // 时间戳保证按文件名排序 = 按时间排序;随机后缀防同一秒内的两次(手动试跑)。
    return `${stamp}-${randomBytes(2).toString("hex")}`;
  }

  saveRun(run: CronRun): void {
    const dir = this.runsDir(run.jobId);
    mkdirSync(dir, { recursive: true });
    writeJsonFileAtomic(join(dir, `${run.id}.json`), run);
  }

  getRun(jobId: string, runId: string): CronRun | undefined {
    if (!isRunId(runId)) return undefined;
    const p = join(this.runsDir(jobId), `${runId}.json`);
    const raw = readJsonFile<Record<string, unknown> | undefined>(p, undefined);
    return raw && typeof raw["id"] === "string" ? (raw as unknown as CronRun) : undefined;
  }

  /** 最近的若干条,新的在前。 */
  listRuns(jobId: string, limit = 20): CronRun[] {
    const out: CronRun[] = [];
    for (const id of this.runIds(jobId).slice(0, limit)) {
      const run = this.getRun(jobId, id);
      if (run) out.push(run);
    }
    return out;
  }

  /** 全部还没有结局的执行 —— 重启后靠它把在飞的容器认领回来。 */
  activeRuns(): CronRun[] {
    const out: CronRun[] = [];
    for (const job of this.jobs) {
      // 只翻最近几条:一次执行不可能在几十条记录之前还"在跑"。
      for (const run of this.listRuns(job.id, 5)) {
        if (run.status === "running") out.push(run);
      }
    }
    return out;
  }

  /** 倒序的 runId(新的在前)。 */
  private runIds(jobId: string): string[] {
    const dir = this.runsDir(jobId);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .sort()
        .reverse();
    } catch (err) {
      console.warn(`[cron] 读执行记录目录失败 ${dir}: ${String(err)}`);
      return [];
    }
  }

  writeLog(jobId: string, runId: string, text: string): number {
    const dir = this.runsDir(jobId);
    mkdirSync(dir, { recursive: true });
    const body = capLog(text);
    const buf = Buffer.from(body, "utf8");
    writeFileSync(join(dir, `${runId}.log`), buf);
    return buf.byteLength;
  }

  /** 读输出。`tailBytes` 只要末尾一段 —— 通知文案要的是最后几行。 */
  readLog(jobId: string, runId: string, tailBytes?: number): string {
    if (!isRunId(runId)) return "";
    const p = join(this.runsDir(jobId), `${runId}.log`);
    try {
      const buf = readFileSync(p);
      if (tailBytes === undefined || buf.byteLength <= tailBytes) return buf.toString("utf8");
      return buf.subarray(buf.byteLength - tailBytes).toString("utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[cron] 读输出失败 ${p}: ${String(err)}`);
      }
      return "";
    }
  }

  /**
   * 按**次数**为主、年龄为辅修剪执行记录。
   *
   * 次数在前是因为它是用户能直接理解的那个量("我要看最近 20 次");年龄只是
   * 防住"每月一次的任务留 20 条 = 存两年"这种长尾。两条各自独立生效。
   */
  pruneRuns(jobId: string, keep: number, maxAgeMs = DEFAULT_RUN_MAX_AGE_MS): number {
    const ids = this.runIds(jobId);
    const dir = this.runsDir(jobId);
    const deadline = this.now() - maxAgeMs;
    let removed = 0;
    ids.forEach((id, index) => {
      let doomed = index >= keep;
      if (!doomed) {
        // 年龄看文件的 mtime 而不是解析 runId:文件时间是文件系统的事实,
        // 而 runId 的格式是我们自己的约定 —— 将来改格式时不该顺手改掉保留策略。
        try {
          doomed = statSync(join(dir, `${id}.json`)).mtimeMs < deadline;
        } catch {
          doomed = false;
        }
      }
      if (!doomed) return;
      for (const ext of [".json", ".log"]) {
        try {
          unlinkSync(join(dir, `${id}${ext}`));
        } catch {
          // .log 常常压根不存在(没输出的那些),不算错。
        }
      }
      removed += 1;
    });
    return removed;
  }
}

/** runId 只来自我们自己,但它会走进文件路径 —— 挡住 `..` 这类事故。 */
function isRunId(v: string): boolean {
  return /^\d{8}T\d{6}Z-[0-9a-f]{4}$/.test(v);
}

function capLog(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= MAX_LOG_BYTES) return text;
  const head = buf.subarray(0, HEAD_BYTES).toString("utf8");
  const tail = buf.subarray(buf.byteLength - (MAX_LOG_BYTES - HEAD_BYTES)).toString("utf8");
  const dropped = buf.byteLength - MAX_LOG_BYTES;
  return `${head}\n\n… 中间省略 ${dropped} 字节 …\n\n${tail}`;
}

const RUN_STATUSES: readonly RunStatus[] = [
  "running",
  "ok",
  "failed",
  "timeout",
  "skipped",
  "interrupted",
  "error",
];

export function isRunStatus(v: unknown): v is RunStatus {
  return typeof v === "string" && (RUN_STATUSES as readonly string[]).includes(v);
}

/**
 * 把盘上的一条记录认回成任务。认不出就返回 undefined(调用方隔离它)。
 *
 * 只验**结构**,不验业务规则 —— 业务规则(频率下限、挂载白名单)是写入时的闸门,
 * 而且它们会随配置变。读取时拿今天的规则去否决昨天存下的任务,只会让管理员
 * 收窄一次白名单就把存量任务全静默停掉。
 */
function parseJob(raw: unknown): CronJob | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const s = o["schedule"] as Record<string, unknown> | undefined;
  const t = o["task"] as Record<string, unknown> | undefined;
  if (typeof o["id"] !== "string" || typeof o["userKey"] !== "string") return undefined;
  if (typeof o["name"] !== "string" || !s || !t) return undefined;
  const okSchedule =
    (s["kind"] === "cron" && typeof s["expr"] === "string" && typeof s["tz"] === "string") ||
    (s["kind"] === "every" && typeof s["ms"] === "number") ||
    (s["kind"] === "once" && typeof s["at"] === "number");
  if (!okSchedule) return undefined;
  if (t["kind"] !== "script" || !Array.isArray(t["cmd"])) return undefined;
  return raw as CronJob;
}
