import { readJsonFile, writeJsonFileAtomic } from "../file-store.js";

/**
 * 中国大陆法定节假日与调休补班日历。
 *
 * ## 设计边界
 *
 * - **只存偏离「周一至周五上班、周末休息」的例外日**:一年只有约 35 天(不到 1 KB),
 *   纯函数查表,不引入任何第三方依赖,也不在核心进程里发网络请求。
 * - **外部更新 + 热重载**:新年度国务院放假通知由管理员的定时任务拉取后通过
 *   `PUT /api/admin/cron/calendar` 写入 `<dataDir>/cron/calendar.json`,并就地触发
 *   调度器重算排期。
 * - **跨年无数据时的平滑回退与告警**:某一年尚未入库时,判定自动退回普通周一至周五,
 *   任务不断档;同时 `hasYear(year)` 返回 `false`,由结果通知追加一句提醒让用户找
 *   管理员更新节假日配置。
 */

export const CALENDAR_IDS = ["cn-workday", "cn-restday"] as const;
export type CalendarId = (typeof CALENDAR_IDS)[number];

export function isCalendarId(v: unknown): v is CalendarId {
  return typeof v === "string" && (CALENDAR_IDS as readonly string[]).includes(v);
}

export const CALENDAR_LABELS: Record<CalendarId, string> = {
  "cn-workday": "法定工作日",
  "cn-restday": "法定休息日",
};

/** 单年的例外日期(格式均为 `"MM-DD"`,已排序去重)。 */
export interface YearCalendar {
  /** 法定放假日(含连休周末;即便落在周一至周五也休息)。 */
  readonly off: readonly string[];
  /** 调休补班日(即便落在周六、周日也上班)。 */
  readonly work: readonly string[];
}

export interface CalendarData {
  readonly updatedAt?: number;
  readonly years: Readonly<Record<string, YearCalendar>>;
}

/**
 * 代码内置基线(国务院办公厅 2025—2027 年节假日安排通知)。
 *
 * 盘上 `calendar.json` 存在某一年时整年覆盖内置同名年份。
 */
export const BUILTIN_CALENDAR_YEARS: Readonly<Record<string, YearCalendar>> = {
  "2025": {
    off: [
      "01-01",
      "01-28", "01-29", "01-30", "01-31", "02-01", "02-02", "02-03", "02-04",
      "04-04", "04-05", "04-06",
      "05-01", "05-02", "05-03", "05-04", "05-05",
      "05-31", "06-01", "06-02",
      "10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07", "10-08",
    ],
    work: ["01-26", "02-08", "04-27", "09-28", "10-11"],
  },
  "2026": {
    off: [
      "01-01", "01-02", "01-03",
      "02-15", "02-16", "02-17", "02-18", "02-19", "02-20", "02-21", "02-22", "02-23",
      "04-04", "04-05", "04-06",
      "05-01", "05-02", "05-03", "05-04", "05-05",
      "06-19", "06-20", "06-21",
      "09-25", "09-26", "09-27",
      "10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07",
    ],
    work: ["01-04", "02-14", "02-28", "05-09", "09-20", "10-10"],
  },
  "2027": {
    off: [
      "01-01", "01-02", "01-03",
      "02-05", "02-06", "02-07", "02-08", "02-09", "02-10", "02-11", "02-12", "02-13",
      "04-03", "04-04", "04-05",
      "05-01", "05-02", "05-03", "05-04", "05-05",
      "06-09",
      "09-15",
      "10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07",
    ],
    work: ["01-31", "02-14", "05-08", "09-26", "10-09"],
  },
};

export const DEFAULT_CALENDAR_DATA: CalendarData = {
  years: BUILTIN_CALENDAR_YEARS,
};

export interface CalendarDateLike {
  readonly y: number;
  readonly mo: number;
  readonly d: number;
  /** 0 = 周日 … 6 = 周六。 */
  readonly dow: number;
}

/** 这一年是否已经有法定节假日数据。 */
export function hasCalendarYear(year: number, data: CalendarData = DEFAULT_CALENDAR_DATA): boolean {
  return Object.prototype.hasOwnProperty.call(data.years, String(year));
}

/** 中国大陆法定工作日判定(纯函数)。未知年份自动回退为周一至周五。 */
export function isCnWorkday(w: CalendarDateLike, data: CalendarData = DEFAULT_CALENDAR_DATA): boolean {
  const yr = data.years[String(w.y)];
  if (yr) {
    const mmdd = `${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
    if (yr.off.includes(mmdd)) return false;
    if (yr.work.includes(mmdd)) return true;
  }
  return w.dow >= 1 && w.dow <= 5;
}

/** 某一天是否满足指定的 calendar 规则(无规则表示全年 365 天都放行)。 */
export function matchesCalendar(
  calendar: CalendarId | undefined,
  w: CalendarDateLike,
  data: CalendarData = DEFAULT_CALENDAR_DATA,
): boolean {
  if (!calendar) return true;
  const work = isCnWorkday(w, data);
  return calendar === "cn-workday" ? work : !work;
}

/**
 * 检查某个定时任务在当前及下次触发年份是否缺少节假日数据。
 * 返回缺失的年份列表(升序去重);不缺或未使用 calendar 时返回空数组。
 */
export function missingCalendarYears(
  calendar: CalendarId | undefined,
  yearsToCheck: readonly number[],
  data: CalendarData = DEFAULT_CALENDAR_DATA,
): number[] {
  if (!calendar) return [];
  const missing = new Set<number>();
  for (const y of yearsToCheck) {
    if (!hasCalendarYear(y, data)) missing.add(y);
  }
  return [...missing].sort((a, b) => a - b);
}

/** 跨年缺节假日数据时的提示文案。 */
export function formatMissingCalendarWarning(missingYears: readonly number[]): string | undefined {
  if (!missingYears.length) return undefined;
  const label = missingYears.join("、");
  return `⚠️ 缺少 ${label} 年法定节假日数据，当前暂按普通周一至周五排期，请联系管理员更新节假日配置。`;
}

// ── 校验与存储 ────────────────────────────────────────────────────

const YEAR_KEY_RE = /^(20\d{2}|2100)$/;
const MMDD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_DAYS_PER_LIST = 150;

function isValidCalendarDay(year: number, mmdd: string): boolean {
  if (!MMDD_RE.test(mmdd)) return false;
  const [moStr, dStr] = mmdd.split("-");
  const mo = Number(moStr);
  const d = Number(dStr);
  const dt = new Date(Date.UTC(year, mo - 1, d));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d;
}

function normalizeDayList(raw: unknown, year: number, field: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`years["${year}"].${field} 必须是 "MM-DD" 字符串数组`);
  }
  if (raw.length > MAX_DAYS_PER_LIST) {
    throw new Error(`years["${year}"].${field} 条目过多(${raw.length} 条,上限 ${MAX_DAYS_PER_LIST})`);
  }
  const set = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !isValidCalendarDay(year, item)) {
      throw new Error(`years["${year}"].${field} 里有非法公历日期 ${JSON.stringify(item)}(应为合法的 "MM-DD")`);
    }
    set.add(item);
  }
  return [...set].sort();
}

/** 严格校验 `PUT /api/admin/cron/calendar` 的请求体 `{ years: { "2028": { off, work } } }`。 */
export function validateCalendarUpdate(raw: unknown): Record<string, YearCalendar> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("请求体需要是一个 JSON 对象,形如 { \"years\": { \"2028\": { \"off\": [...], \"work\": [...] } } }");
  }
  const obj = raw as Record<string, unknown>;
  const extraTop = Object.keys(obj).filter((k) => k !== "years");
  if (extraTop.length) {
    throw new Error(`不认识的顶层字段 ${extraTop.map((k) => JSON.stringify(k)).join("、")};只接受 years`);
  }
  const yearsRaw = obj["years"];
  if (!yearsRaw || typeof yearsRaw !== "object" || Array.isArray(yearsRaw)) {
    throw new Error("years 必须是非空对象,键为四位年份(如 \"2028\")");
  }
  const entries = Object.entries(yearsRaw as Record<string, unknown>);
  if (!entries.length) {
    throw new Error("years 不能为空对象,至少给一个年份");
  }

  const out: Record<string, YearCalendar> = {};
  for (const [yearKey, val] of entries) {
    if (!YEAR_KEY_RE.test(yearKey)) {
      throw new Error(`年份键 ${JSON.stringify(yearKey)} 不合法(应为 2000-2100 的四位年份)`);
    }
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      throw new Error(`years["${yearKey}"] 必须是 { off: string[], work: string[] } 对象`);
    }
    const yObj = val as Record<string, unknown>;
    const extra = Object.keys(yObj).filter((k) => k !== "off" && k !== "work");
    if (extra.length) {
      throw new Error(`years["${yearKey}"] 里有不认识的字段 ${extra.map((k) => JSON.stringify(k)).join("、")};只接受 off 与 work`);
    }
    const yearNum = Number(yearKey);
    const off = normalizeDayList(yObj["off"], yearNum, "off");
    const work = normalizeDayList(yObj["work"], yearNum, "work");
    const offSet = new Set(off);
    const overlap = work.filter((d) => offSet.has(d));
    if (overlap.length) {
      throw new Error(`years["${yearKey}"] 中同一天既在 off 又在 work:${overlap.join("、")}`);
    }
    out[yearKey] = { off, work };
  }
  return out;
}

interface StoredCalendarFile {
  updatedAt?: unknown;
  years?: unknown;
}

/** 宽容解析磁盘上的 `calendar.json`;损坏的年份跳过并告警,绝不阻塞启动。 */
function parseStoredFile(raw: StoredCalendarFile): { updatedAt?: number; years: Record<string, YearCalendar> } {
  const years: Record<string, YearCalendar> = {};
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : undefined;
  if (raw.years && typeof raw.years === "object" && !Array.isArray(raw.years)) {
    for (const [k, v] of Object.entries(raw.years as Record<string, unknown>)) {
      try {
        const parsed = validateCalendarUpdate({ years: { [k]: v } });
        if (parsed[k]) years[k] = parsed[k]!;
      } catch (err) {
        console.warn(`[cron-calendar] 忽略盘上损坏的年份 ${k}: ${(err as Error).message}`);
      }
    }
  }
  return { ...(updatedAt !== undefined ? { updatedAt } : {}), years };
}

export interface CalendarStoreOptions {
  /** `<dataDir>/cron/calendar.json`。 */
  readonly path: string;
  /** 可注入内置基线(单测可传空表测跨年缺数据告警)。默认 `BUILTIN_CALENDAR_YEARS`。 */
  readonly builtinYears?: Readonly<Record<string, YearCalendar>>;
  readonly now?: () => number;
}

export interface CalendarYearSummary {
  readonly year: string;
  readonly source: "file" | "builtin";
  readonly offDays: number;
  readonly workDays: number;
  readonly off: readonly string[];
  readonly work: readonly string[];
}

export class CalendarStore {
  private readonly path: string;
  private readonly builtin: Readonly<Record<string, YearCalendar>>;
  private readonly now: () => number;
  private fileYears: Record<string, YearCalendar> = {};
  private updatedAt: number | undefined;
  private snapshot: CalendarData;

  constructor(opts: CalendarStoreOptions) {
    this.path = opts.path;
    this.builtin = opts.builtinYears ?? BUILTIN_CALENDAR_YEARS;
    this.now = opts.now ?? Date.now;
    this.snapshot = { years: this.builtin };
    this.reload();
  }

  /** 当前生效的日历快照(内置基线 + 盘上按年覆盖)。 */
  data(): CalendarData {
    return this.snapshot;
  }

  /** 从磁盘重新加载 `calendar.json`。 */
  reload(): CalendarData {
    const raw = readJsonFile<StoredCalendarFile>(this.path, {});
    const parsed = parseStoredFile(raw);
    this.fileYears = parsed.years;
    this.updatedAt = parsed.updatedAt;
    this.rebuild();
    return this.snapshot;
  }

  /** 校验并按年份增量合并写入磁盘,返回更新后的快照。 */
  update(raw: unknown): CalendarData {
    const incoming = validateCalendarUpdate(raw);
    this.fileYears = { ...this.fileYears, ...incoming };
    this.updatedAt = this.now();
    writeJsonFileAtomic(this.path, {
      updatedAt: this.updatedAt,
      years: this.fileYears,
    });
    this.rebuild();
    return this.snapshot;
  }

  /** 管理接口展示视图:列出所有年份及来源。 */
  describe(): { updatedAt?: number; years: CalendarYearSummary[] } {
    const allKeys = [...new Set([...Object.keys(this.builtin), ...Object.keys(this.fileYears)])].sort();
    const years: CalendarYearSummary[] = allKeys.map((year) => {
      const fromFile = Object.prototype.hasOwnProperty.call(this.fileYears, year);
      const entry = (fromFile ? this.fileYears[year] : this.builtin[year])!;
      return {
        year,
        source: fromFile ? "file" : "builtin",
        offDays: entry.off.length,
        workDays: entry.work.length,
        off: entry.off,
        work: entry.work,
      };
    });
    return {
      ...(this.updatedAt !== undefined ? { updatedAt: this.updatedAt } : {}),
      years,
    };
  }

  private rebuild(): void {
    this.snapshot = {
      ...(this.updatedAt !== undefined ? { updatedAt: this.updatedAt } : {}),
      years: { ...this.builtin, ...this.fileYears },
    };
  }
}
