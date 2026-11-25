import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeSchedule,
  formatAt,
  minGapMs,
  nextAt,
  parseCronExpr,
  wallClockIn,
} from "../src/core/cron/schedule.js";

const SH = "Asia/Shanghai";
const at = (iso: string): number => Date.parse(iso);

test("cron:每天 8 点,从当天零点看是当天 8 点", () => {
  const t = nextAt({ kind: "cron", expr: "0 8 * * *", tz: SH }, at("2026-08-13T00:00:00+08:00"));
  assert.equal(new Date(t!).toISOString(), "2026-08-13T00:00:00.000Z"); // = 08:00+08:00
});

test("cron:严格晚于 from —— 正好卡在触发时刻上时给的是下一档", () => {
  const spec = { kind: "cron", expr: "0 8 * * *", tz: SH } as const;
  const t = nextAt(spec, at("2026-08-13T08:00:00+08:00"));
  assert.equal(t, at("2026-08-14T08:00:00+08:00"));
  // 同一分钟内的任意时刻也不该再触发一次(tick 每 30 秒一跑,这条防的是重复点火)。
  assert.equal(nextAt(spec, at("2026-08-13T08:00:30+08:00")), at("2026-08-14T08:00:00+08:00"));
});

test("cron:步长、列表、区间", () => {
  const spec = { kind: "cron", expr: "*/15 * * * *", tz: SH } as const;
  const t1 = nextAt(spec, at("2026-08-13T08:01:00+08:00"))!;
  assert.equal(t1, at("2026-08-13T08:15:00+08:00"));
  assert.equal(nextAt(spec, t1), at("2026-08-13T08:30:00+08:00"));
  assert.equal(minGapMs(spec, at("2026-08-13T08:01:00+08:00")), 15 * 60_000);

  const workday = { kind: "cron", expr: "30 9 * * 1-5", tz: SH } as const;
  // 2026-08-15 是周六 → 下一次是周一 8/17
  assert.equal(nextAt(workday, at("2026-08-15T00:00:00+08:00")), at("2026-08-17T09:30:00+08:00"));
});

test("cron:星期名与 0/7 都是周日", () => {
  const a = nextAt({ kind: "cron", expr: "0 9 * * sun", tz: SH }, at("2026-08-13T00:00:00+08:00"));
  const b = nextAt({ kind: "cron", expr: "0 9 * * 7", tz: SH }, at("2026-08-13T00:00:00+08:00"));
  const c = nextAt({ kind: "cron", expr: "0 9 * * 0", tz: SH }, at("2026-08-13T00:00:00+08:00"));
  assert.equal(a, at("2026-08-16T09:00:00+08:00"));
  assert.equal(b, a);
  assert.equal(c, a);
});

test("cron:日期位与星期位都收窄时取并集(标准 cron 的老规矩)", () => {
  const spec = { kind: "cron", expr: "0 0 1 * mon", tz: SH } as const;
  // 2026-08-13 是周四 → 先到周一 8/17,而不是等到 9 月 1 号
  assert.equal(nextAt(spec, at("2026-08-13T00:00:00+08:00")), at("2026-08-17T00:00:00+08:00"));
  // 只收窄日期位时就只按日期走
  assert.equal(
    nextAt({ kind: "cron", expr: "0 0 1 * *", tz: SH }, at("2026-08-13T00:00:00+08:00")),
    at("2026-09-01T00:00:00+08:00"),
  );
});

test("cron:跨月、跨年、闰日", () => {
  assert.equal(
    nextAt({ kind: "cron", expr: "0 0 1 1 *", tz: SH }, at("2026-08-13T00:00:00+08:00")),
    at("2027-01-01T00:00:00+08:00"),
  );
  assert.equal(
    nextAt({ kind: "cron", expr: "0 12 29 2 *", tz: SH }, at("2026-08-13T00:00:00+08:00")),
    at("2028-02-29T12:00:00+08:00"),
  );
  assert.equal(
    nextAt({ kind: "cron", expr: "0 0 31 * *", tz: SH }, at("2026-04-01T00:00:00+08:00")),
    at("2026-05-31T00:00:00+08:00"),
  );
});

test("cron:永远不会触发的表达式返回 undefined,而不是死循环", () => {
  assert.equal(nextAt({ kind: "cron", expr: "0 0 30 2 *", tz: SH }, at("2026-08-13T00:00:00+08:00")), undefined);
});

test("cron:时区是任务自己的,不是进程的", () => {
  // 上海凌晨 4 点 = UTC 前一天 20 点:两边的"下一个 8 点"都还没到,差的正好是时差。
  const from = at("2026-08-12T20:00:00Z");
  const sh = nextAt({ kind: "cron", expr: "0 8 * * *", tz: SH }, from)!;
  const utc = nextAt({ kind: "cron", expr: "0 8 * * *", tz: "UTC" }, from)!;
  assert.equal(sh, at("2026-08-13T08:00:00+08:00"));
  assert.equal(utc - sh, 8 * 3600_000);
});

test("DST:春季不存在的那一分钟,跳过去之后立刻跑,而不是当天不跑", () => {
  // 纽约 2026-03-08 凌晨 2:00 不存在(直接跳到 3:00)。
  const t = nextAt(
    { kind: "cron", expr: "0 2 * * *", tz: "America/New_York" },
    at("2026-03-08T00:30:00-05:00"),
  );
  assert.ok(t !== undefined, "不能算不出来 —— 算不出来会被当成死表达式停用");
  const w = wallClockIn("America/New_York", t!);
  assert.equal(w.d, 8);
  assert.equal(w.h, 3, "空洞里的 2:00 应当落在切换之后的 3:00");
});

test("DST:秋季重复的那一小时不会让下次触发倒退", () => {
  // 纽约 2026-11-01 的 1:00 出现两次。
  const spec = { kind: "cron", expr: "30 1 * * *", tz: "America/New_York" } as const;
  const first = nextAt(spec, at("2026-11-01T00:00:00-04:00"))!;
  const second = nextAt(spec, first)!;
  assert.ok(second > first, "第二次必须严格晚于第一次");
  assert.equal(wallClockIn("America/New_York", second).d, 2);
});

test("every / once", () => {
  assert.equal(nextAt({ kind: "every", ms: 1800_000 }, 1000), 1801_000);
  assert.equal(minGapMs({ kind: "every", ms: 1800_000 }, 0), 1800_000);
  assert.equal(nextAt({ kind: "once", at: 5000 }, 1000), 5000);
  assert.equal(nextAt({ kind: "once", at: 5000 }, 5000), undefined, "过了就不再触发");
  assert.equal(minGapMs({ kind: "once", at: 5000 }, 1000), Infinity);
});

test("minGapMs 看的是真实间隔,不是表达式长什么样", () => {
  const from = at("2026-08-13T00:00:00+08:00");
  // 形状一样,频率差 30 倍 —— 创建时的频率闸就靠这个区分。
  assert.equal(minGapMs({ kind: "cron", expr: "0,30 * * * *", tz: SH }, from), 30 * 60_000);
  assert.equal(minGapMs({ kind: "cron", expr: "0,1 * * * *", tz: SH }, from), 60_000);
});

test("表达式语法错都带人话", () => {
  const bad: Array<[string, RegExp]> = [
    ["0 8 * *", /5 个字段/],
    ["0 25 * * *", /超出范围/],
    ["0 8 * * 8", /超出范围/],
    ["a 8 * * *", /看不懂/],
    ["0 8 * * *  extra", /5 个字段/],
    ["*/0 8 * * *", /步长/],
    ["0 8 1- * *", /写坏了|看不懂/],
  ];
  for (const [expr, re] of bad) {
    assert.throws(() => parseCronExpr(expr), re, `应当拒绝:${expr}`);
  }
});

test("展示用文案", () => {
  assert.equal(formatAt(at("2026-08-13T08:05:00+08:00"), SH), "08-13 08:05 周四");
  assert.equal(describeSchedule({ kind: "every", ms: 30 * 60_000 }, SH), "每 30 分钟");
  assert.equal(describeSchedule({ kind: "every", ms: 2 * 3600_000 }, SH), "每 2 小时");
  assert.equal(describeSchedule({ kind: "every", ms: 24 * 3600_000 }, SH), "每 1 天");
  assert.match(describeSchedule({ kind: "cron", expr: "0 8 * * *", tz: SH }, SH), /0 8 \* \* \*/);
  assert.equal(
    describeSchedule({ kind: "cron", expr: "0 9 * * *", tz: SH, calendar: "cn-workday" }, SH),
    "cron 0 9 * * *(Asia/Shanghai · 法定工作日)",
  );
  assert.equal(
    describeSchedule({ kind: "cron", expr: "0 10 * * *", tz: SH, calendar: "cn-restday" }, SH),
    "cron 0 10 * * *(Asia/Shanghai · 法定休息日)",
  );
});

test("calendar:cn-workday 跳过法定节假日,并在周末调休补班日触发", () => {
  const workday = { kind: "cron", expr: "0 9 * * *", tz: SH, calendar: "cn-workday" } as const;
  // 2026-09-18 周五 10:00 之后:9月19日是普通周六(不跑),9月20日是周日调休补班(跑!)
  assert.equal(
    nextAt(workday, at("2026-09-18T10:00:00+08:00")),
    at("2026-09-20T09:00:00+08:00"),
  );
  // 2026-09-30 周三 10:00 之后:10月1日~7日国庆连休 7 天 → 下一个工作日是 10月8日周四
  assert.equal(
    nextAt(workday, at("2026-09-30T10:00:00+08:00")),
    at("2026-10-08T09:00:00+08:00"),
  );
  // 2026-10-09 周五 10:00 之后:10月10日周六调休补班 → 10月10日 09:00 触发
  assert.equal(
    nextAt(workday, at("2026-10-09T10:00:00+08:00")),
    at("2026-10-10T09:00:00+08:00"),
  );
});

test("calendar:cn-restday 与 cn-workday 严格互补,且与 cron 表达式取交集(AND)", () => {
  const restday = { kind: "cron", expr: "0 10 * * *", tz: SH, calendar: "cn-restday" } as const;
  // 2026-09-18 周五 → 9月19日周六休息(触发),9月20日周日补班(不触发!)
  const first = nextAt(restday, at("2026-09-18T12:00:00+08:00"))!;
  assert.equal(first, at("2026-09-19T10:00:00+08:00"));
  // 9月19日之后跳过 9月20日补班和周一~周四,落在 9月25日周五(中秋节放假第一天)
  assert.equal(nextAt(restday, first), at("2026-09-25T10:00:00+08:00"));

  // AND 过滤:是法定工作日的周一(`0 9 * * 1` + `cn-workday`)
  // 2026-04-06 是周一,但恰逢清明节放假 → 跳过 4/6,落到下一个周一 4/13
  const workMonday = { kind: "cron", expr: "0 9 * * 1", tz: SH, calendar: "cn-workday" } as const;
  assert.equal(
    nextAt(workMonday, at("2026-04-01T00:00:00+08:00")),
    at("2026-04-13T09:00:00+08:00"),
  );
});

test("calendar:未知年份平滑回退到普通周一至周五", () => {
  const workday = { kind: "cron", expr: "0 9 * * *", tz: SH, calendar: "cn-workday" } as const;
  // 2035 年不在内置表里:2035-01-05 是周五,10:00 之后下一个是周一 2035-01-08
  assert.equal(
    nextAt(workday, at("2035-01-05T10:00:00+08:00")),
    at("2035-01-08T09:00:00+08:00"),
  );
});
