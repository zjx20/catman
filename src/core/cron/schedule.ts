/**
 * 定时任务的**时间**这一半:表达式解析、下次触发时刻、人话描述。
 *
 * 整个文件是纯函数,不碰磁盘、不读 `Date.now()`(时刻一律由调用方传进来)。
 * 这不是洁癖 —— 定时器最难查的一类错(月末、跨年、DST、"每分钟一次"没拦住)
 * 全在这里,而只有纯函数才测得动它们。
 *
 * ## 为什么自己写 cron 解析
 *
 * 现成的库当然有。但这台机器是 2 核软路由,每加一个依赖,制备时的 `npm ci`
 * 就多一分失败与耗时;而我们要的只是 5 字段标准语法的一个子集,连同下面的
 * 时区换算一共不到两百行,还全都在测试里钉着。
 *
 * ## 时区
 *
 * 用 `Intl.DateTimeFormat` 拿某个时刻在目标时区的墙上时间,再用"猜一次 + 用
 * 偏移修正"的老办法把墙上时间换回时刻。**不引入时区库**,理由同上。
 * 存进任务表的 `nextAt` 永远是绝对毫秒,只在展示时才套时区 —— 这样管理员改了
 * 容器 TZ 也不会让已经排好的时刻集体漂移。
 */

/** 5 字段 cron。tz 为 IANA 时区名。 */
export interface CronExprSchedule {
  readonly kind: "cron";
  readonly expr: string;
  readonly tz: string;
}

/** 固定间隔。从上次触发起算,首次从创建时刻起算。 */
export interface EverySchedule {
  readonly kind: "every";
  readonly ms: number;
}

/** 一次性。触发后任务自动停用(不删 —— 记录还要给人看)。 */
export interface OnceSchedule {
  readonly kind: "once";
  readonly at: number;
}

export type CronSchedule = CronExprSchedule | EverySchedule | OnceSchedule;

/** 解析后的 5 个字段。`all` 表示这一位是 `*`(dom/dow 的组合规则要用它)。 */
interface Field {
  readonly set: ReadonlySet<number>;
  readonly all: boolean;
}

export interface ParsedCronExpr {
  readonly minute: Field;
  readonly hour: Field;
  readonly dom: Field;
  readonly month: Field;
  readonly dow: Field;
}

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 找不到下次触发之前最多走多少步。够 2 年多的按天推进,外加 DST 空洞里的分钟级推进。 */
const MAX_STEPS = 2000;

function parseNumber(token: string, name: string, names?: Record<string, number>): number {
  const lower = token.toLowerCase();
  if (names && lower in names) return names[lower]!;
  if (!/^\d{1,4}$/.test(token)) {
    throw new Error(`${name} 里看不懂的取值 ${JSON.stringify(token)}`);
  }
  return Number(token);
}

/**
 * 解析一个字段。支持 `*`、`a`、`a-b`、步长写法(星号斜杠 n、区间斜杠 n),
 * 以及用逗号连接的若干段。
 * (步长这里刻意写成中文:字面量里那两个字符连在一起会把这段注释提前收掉。)
 *
 * 越界一律**报错而不是夹取** —— 这里是写入路径,`0 25 * * *` 多半是把小时写错了,
 * 悄悄改成 23 点会让任务在一个谁也没想到的时刻跑起来。
 */
function parseField(
  raw: string,
  min: number,
  max: number,
  name: string,
  names?: Record<string, number>,
): Field {
  const set = new Set<number>();
  let all = false;
  for (const part of raw.split(",")) {
    if (!part) throw new Error(`${name} 有空的分段(逗号旁边少了东西)`);
    const [rangePart, stepPart, ...rest] = part.split("/");
    if (rest.length) throw new Error(`${name} 的 ${JSON.stringify(part)} 里有多个 /`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d{1,4}$/.test(stepPart) || Number(stepPart) < 1) {
        throw new Error(`${name} 的步长 ${JSON.stringify(stepPart)} 必须是正整数`);
      }
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
      if (step === 1) all = true;
    } else if (rangePart!.includes("-")) {
      const [a, b, ...more] = rangePart!.split("-");
      if (more.length || !a || !b) throw new Error(`${name} 的区间 ${JSON.stringify(part)} 写坏了`);
      lo = parseNumber(a, name, names);
      hi = parseNumber(b, name, names);
    } else {
      lo = parseNumber(rangePart!, name, names);
      hi = lo;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`${name} 的 ${JSON.stringify(part)} 超出范围(应在 ${min}-${max} 之间)`);
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  if (!set.size) throw new Error(`${name} 没有任何可用取值`);
  return { set, all };
}

/** 解析 5 字段 cron。坏值抛错,错误文案能直接念给用户听。 */
export function parseCronExpr(expr: string): ParsedCronExpr {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron 表达式要 5 个字段(分 时 日 月 周),给的是 ${fields.length} 个:${JSON.stringify(expr)}`,
    );
  }
  const [mi, h, dom, mo, dow] = fields as [string, string, string, string, string];
  const dowField = parseField(dow, 0, 7, "星期位", DOW_NAMES);
  // 7 与 0 都表示周日,归一到 0 —— 否则 `0 0 * * 7` 永远匹配不上。
  const dowSet = new Set<number>();
  for (const v of dowField.set) dowSet.add(v === 7 ? 0 : v);
  return {
    minute: parseField(mi, 0, 59, "分钟位"),
    hour: parseField(h, 0, 23, "小时位"),
    dom: parseField(dom, 1, 31, "日期位"),
    month: parseField(mo, 1, 12, "月份位", MONTH_NAMES),
    dow: { set: dowSet, all: dowField.all },
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    // 非法时区名在这里抛 RangeError。换成人话再扔出去 —— 这条会一路走到
    // 创建任务的 400 响应里。
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new Error(`不认识的时区 ${JSON.stringify(tz)}(要 IANA 名,如 Asia/Shanghai)`);
    }
    formatters.set(tz, f);
  }
  return f;
}

export interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** 0=周日。由年月日现算,不从 Intl 取 —— 少一个要对付的本地化字符串。 */
  dow: number;
}

/** 某个时刻在目标时区的墙上时间。 */
export function wallClockIn(tz: string, at: number): WallClock {
  const parts = formatterFor(tz).formatToParts(new Date(at));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  return { y, mo, d, h: get("hour"), mi: get("minute"), s: get("second"), dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
}

/**
 * 目标时区里的墙上时间 → 绝对时刻。
 *
 * 先按"这个墙上时间就是 UTC"猜一个时刻,拿它算出该时区当时的偏移,再修正。
 * 跨 DST 切换时两个偏移不一样,于是要**两个候选都验一遍**:
 *
 * - 都对得上(秋季回拨,同一个墙上时间出现两次):取**靠前**的那次,确定性优先。
 * - 都对不上(春季空洞,这个墙上时间根本不存在):取**靠后**的那个,也就是切换
 *   发生的那一刻 —— 相当于"2:30 不存在,那就在跳过去之后立刻跑"。这是大多数
 *   cron 实现的做法,而且比"这一天干脆不跑"好:定时任务少跑一次是没有症状的,
 *   等到被发现时已经过去很久了。
 *
 * (中国没有 DST,所以这段在真机上永远走不到。写对它是因为写错的代价是死循环 ——
 * 见 nextAt 里那句"保证前进"。)
 */
function instantOf(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  const t1 = naive - offsetAt(tz, naive);
  const t2 = naive - offsetAt(tz, t1);
  const fits = (t: number): boolean => {
    const w = wallClockIn(tz, t);
    return w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi;
  };
  const ok1 = fits(t1);
  const ok2 = fits(t2);
  if (ok1 && ok2) return Math.min(t1, t2);
  if (ok1) return t1;
  if (ok2) return t2;
  return Math.max(t1, t2);
}

function offsetAt(tz: string, at: number): number {
  const w = wallClockIn(tz, at);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - at;
}

function matchesDate(p: ParsedCronExpr, w: WallClock): boolean {
  if (!p.month.set.has(w.mo)) return false;
  const domOk = p.dom.set.has(w.d);
  const dowOk = p.dow.set.has(w.dow);
  // 标准 cron 的老规矩:日期位和星期位**都**收窄时取并集(`0 0 1 * mon` =
  // 每月 1 号**和**每个周一),只有一位收窄时取那一位。
  if (!p.dom.all && !p.dow.all) return domOk || dowOk;
  return domOk && dowOk;
}

/** 这一天里 >= (h,mi) 的最早匹配时刻;当天没有则返回 undefined。 */
function nextHourMinute(
  p: ParsedCronExpr,
  h: number,
  mi: number,
): { h: number; mi: number } | undefined {
  const hours = [...p.hour.set].sort((a, b) => a - b);
  const minutes = [...p.minute.set].sort((a, b) => a - b);
  for (const hh of hours) {
    if (hh < h) continue;
    for (const mm of minutes) {
      if (hh === h && mm < mi) continue;
      return { h: hh, mi: mm };
    }
  }
  return undefined;
}

function startOfNextDay(tz: string, w: WallClock): number {
  const d = new Date(Date.UTC(w.y, w.mo - 1, w.d));
  d.setUTCDate(d.getUTCDate() + 1);
  return instantOf(tz, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0);
}

/**
 * 严格晚于 `from` 的下一次触发时刻。
 *
 * 返回 undefined 表示**永远不会再触发**:一次性任务已经过期,或者表达式指的是
 * 一个不存在的日子(经典的 `0 0 30 2 *` —— 2 月 30 日)。创建任务时会拿这个
 * undefined 当拒收理由,免得存进去一个永远不动的任务、用户等到天荒地老。
 */
export function nextAt(schedule: CronSchedule, from: number): number | undefined {
  if (schedule.kind === "once") return schedule.at > from ? schedule.at : undefined;
  if (schedule.kind === "every") return from + schedule.ms;

  const p = parseCronExpr(schedule.expr);
  const tz = schedule.tz;
  // 从下一整分钟起找:cron 的粒度就是分钟,而"严格晚于"要防的是同一分钟里
  // 反复触发(tick 每 30 秒跑一次,不这样会一分钟内点两次火)。
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  for (let step = 0; step < MAX_STEPS; step++) {
    const w = wallClockIn(tz, t);
    if (!matchesDate(p, w)) {
      t = startOfNextDay(tz, w);
      continue;
    }
    const hm = nextHourMinute(p, w.h, w.mi);
    if (!hm) {
      t = startOfNextDay(tz, w);
      continue;
    }
    const cand = instantOf(tz, w.y, w.mo, w.d, hm.h, hm.mi);
    if (cand > from) return cand;
    // 还没走到 from 之后(只可能出现在 DST 回拨那一小时里):往前挪一分钟再找。
    // **保证前进**是这里唯一要紧的事 —— 直接用 cand+1min 的话,回拨时 cand 会
    // 一直算回同一个更早的时刻,循环就原地打转直到耗尽步数,而症状是
    // "这个任务的下次触发变成了 undefined",然后它被当成死表达式停用。
    t = Math.max(cand, t) + 60_000;
  }
  return undefined;
}

/**
 * 接下来几次触发之间**最小**的间隔。创建任务时用它拦"太频繁"。
 *
 * 光看表达式判断不了频率:`0,30 * * * *` 是半小时一次,`0,1 * * * *` 却是
 * 一分钟一次,两者形状一模一样。所以真去算几次,看相邻两次差多少。
 * 只有一次(或一次都没有)的返回 Infinity —— 那种任务谈不上频繁。
 */
export function minGapMs(schedule: CronSchedule, from: number, samples = 6): number {
  let prev = nextAt(schedule, from);
  if (prev === undefined) return Infinity;
  let min = Infinity;
  for (let i = 1; i < samples; i++) {
    const next = nextAt(schedule, prev);
    if (next === undefined) break;
    min = Math.min(min, next - prev);
    prev = next;
  }
  return min;
}

/** 「08-14 08:00 周四」。通知与页面共用,免得两处各写一种格式。 */
export function formatAt(at: number, tz: string): string {
  const w = wallClockIn(tz, at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)} ${WEEKDAY_CN[w.dow]}`;
}

/** 周期本身的人话描述(不含下次触发时刻 —— 那个由调用方现算)。 */
export function describeSchedule(schedule: CronSchedule, tz: string): string {
  if (schedule.kind === "once") return `一次性,${formatAt(schedule.at, tz)}`;
  if (schedule.kind === "every") {
    const m = schedule.ms / 60_000;
    if (m < 60) return `每 ${m} 分钟`;
    if (m % (60 * 24) === 0) return `每 ${m / (60 * 24)} 天`;
    if (m % 60 === 0) return `每 ${m / 60} 小时`;
    return `每 ${Math.round(m)} 分钟`;
  }
  return `cron ${schedule.expr}(${schedule.tz})`;
}
