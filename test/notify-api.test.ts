import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotifyTokens } from "../src/core/notify-tokens.js";
import {
  handleNotifyApi,
  isNotifyApiPath,
  NotifyRateLimiter,
  paginateNotify,
  type NotifyApiDeps,
} from "../src/dashboard/api-notify.js";

const dirs: string[] = [];
const ME = "wechat:a:u1";
const OTHER = "wechat:a:u2";
const T0 = Date.parse("2026-08-14T10:00:00+08:00");

test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Setup {
  deps: NotifyApiDeps;
  mine: string;
  theirs: string;
  sent: Array<{ userKey: string; text: string }>;
  now: number;
  post: (body: unknown, token?: string) => Promise<{ status: number; body: any }>;
}

function setup(limiter = new NotifyRateLimiter()): Setup {
  const dir = mkdtempSync(join(tmpdir(), "catman-notifyapi-"));
  dirs.push(dir);
  const tokens = new NotifyTokens(join(dir, "notify-tokens.json"));
  const sent: Array<{ userKey: string; text: string }> = [];
  const s: Setup = {
    mine: tokens.for(ME),
    theirs: tokens.for(OTHER),
    sent,
    now: T0,
    deps: {
      tokens,
      limiter,
      push: async (userKey, text) => {
        sent.push({ userKey, text });
      },
      now: () => s.now,
    },
    post: async (body, token) =>
      (await handleNotifyApi("POST", "/api/me/notify", token, body, s.deps)) as {
        status: number;
        body: any;
      },
  };
  return s;
}

test("认领的路径只有 /api/me/notify —— 别把 /api/me 整个前缀吃掉", () => {
  assert.equal(isNotifyApiPath("/api/me/notify"), true);
  assert.equal(isNotifyApiPath("/api/me"), false);
  assert.equal(isNotifyApiPath("/api/me/cron"), false);
  assert.equal(isNotifyApiPath("/api/me/notify/token"), false);
});

test("推给的是令牌解析出来的那个人,调用方说了不算", async () => {
  const s = setup();
  // 请求体里连"推给谁"这个字段都没有 —— 没有可以填错的参数。
  const r = await s.post({ text: "跑完了" }, s.theirs);
  assert.equal(r.status, 200);
  assert.deepEqual(s.sent, [{ userKey: OTHER, text: "跑完了" }]);
});

test("没令牌 / 错令牌都是 401,一条也发不出去", async () => {
  const s = setup();
  assert.equal((await s.post({ text: "喂" })).status, 401);
  assert.equal((await s.post({ text: "喂" }, "瞎编的")).status, 401);
  assert.equal(s.sent.length, 0);
});

test("空 text 是 400 —— 一条空消息比不发更让人困惑", async () => {
  const s = setup();
  assert.equal((await s.post({ text: "   " }, s.mine)).status, 400);
  assert.equal((await s.post({}, s.mine)).status, 400);
  assert.equal((await s.post(null, s.mine)).status, 400);
  assert.equal(s.sent.length, 0);
});

test("只收 POST", async () => {
  const s = setup();
  const r = await handleNotifyApi("GET", "/api/me/notify", s.mine, {}, s.deps);
  assert.equal(r.status, 405);
});

test("正文不长就一条,不加页码 —— 绝大多数推送是一句话", () => {
  const pages = paginateNotify("跑完了");
  assert.deepEqual(pages, ["跑完了"]);
});

test("超一页就分页,每页都装得下,且顺序发出去", async () => {
  const s = setup();
  // 2500 字符:一页装不下,两页绰绰有余。
  const r = await s.post({ text: "长".repeat(2500) }, s.mine);
  assert.equal(r.status, 200);
  assert.equal(r.body.pages, 2);
  assert.equal(s.sent.length, 2);
  for (const m of s.sent) assert.ok(m.text.length <= 2000, `这一页 ${m.text.length} 字符,超了`);
  assert.ok(s.sent[0]!.text.endsWith("(第 1/2 页)"));
  assert.ok(s.sent[1]!.text.endsWith("(第 2/2 页)"));
  // 没有截断标记 —— 三页以内不该丢东西。
  for (const m of s.sent) assert.ok(!m.text.includes("太长,后面截掉了"));
});

test("超过三页才截断,标记留在最后一页 —— 那句话外部在依赖", async () => {
  const s = setup();
  const r = await s.post({ text: "长".repeat(20000) }, s.mine);
  assert.equal(r.status, 200);
  assert.equal(r.body.pages, 3);
  assert.equal(s.sent.length, 3);
  for (const m of s.sent) assert.ok(m.text.length <= 2000, `这一页 ${m.text.length} 字符,超了`);
  assert.ok(!s.sent[0]!.text.includes("太长,后面截掉了"));
  assert.ok(s.sent[2]!.text.includes("(太长,后面截掉了)"));
});

test("按换行切页,不把一行劈成两半", () => {
  // 每行 100 字符,共 40 行:切点应当落在换行处。
  const line = "x".repeat(99);
  const pages = paginateNotify(Array.from({ length: 40 }, () => line).join("\n"));
  assert.ok(pages.length >= 2);
  for (const p of pages) {
    const body = p.replace(/\n\n\(第 \d+\/\d+ 页\)$/, "");
    for (const l of body.split("\n")) {
      assert.ok(l === "" || l.length === 99, `切出了半行(${l.length} 字符)`);
    }
  }
});

test("分页按页数计费,不是按调用次数 —— 否则分页就成了绕过限流的口子", async () => {
  const s = setup(new NotifyRateLimiter(4, 60_000));
  // 这一条要发 3 页,吃掉 3 格。
  assert.equal((await s.post({ text: "长".repeat(20000) }, s.mine)).status, 200);
  assert.equal(s.sent.length, 3);
  // 还剩 1 格:一页的过得去。
  assert.equal((await s.post({ text: "短" }, s.mine)).status, 200);
  assert.equal((await s.post({ text: "再来" }, s.mine)).status, 429);
});

test("额度不够发完整篇就整条拒收,不做半截投递", async () => {
  const s = setup(new NotifyRateLimiter(2, 60_000));
  const r = await s.post({ text: "长".repeat(20000) }, s.mine);
  assert.equal(r.status, 429);
  assert.ok(String(r.body.error).includes("3 条"));
  // 一页都不该漏出去 —— 收到前两页、第三页永远不来比全不来更难查。
  assert.equal(s.sent.length, 0);
});

test("限流:超额之后挡住,且 429 正文里带上被丢掉的那条", async () => {
  const s = setup(new NotifyRateLimiter(3, 60_000));
  for (let i = 0; i < 3; i++) {
    assert.equal((await s.post({ text: `第 ${i}` }, s.mine)).status, 200);
  }
  const r = await s.post({ text: "第 3" }, s.mine);
  assert.equal(r.status, 429);
  assert.ok(String(r.body.dropped).includes("第 3"));
  assert.equal(s.sent.length, 3);
});

test("限流是每人一份 —— 一个人刷屏不该把别人也堵住", async () => {
  const s = setup(new NotifyRateLimiter(1, 60_000));
  assert.equal((await s.post({ text: "我的" }, s.mine)).status, 200);
  assert.equal((await s.post({ text: "又是我" }, s.mine)).status, 429);
  assert.equal((await s.post({ text: "别人的" }, s.theirs)).status, 200);
});

test("窗口滑过去之后重新放行,而且被挡的那几条不会把窗口续下去", async () => {
  const s = setup(new NotifyRateLimiter(1, 60_000));
  assert.equal((await s.post({ text: "一" }, s.mine)).status, 200);
  // 被挡的这几条如果也记账,窗口就会被自己不断续期,永远出不来。
  s.now = T0 + 30_000;
  assert.equal((await s.post({ text: "二" }, s.mine)).status, 429);
  s.now = T0 + 61_000;
  assert.equal((await s.post({ text: "三" }, s.mine)).status, 200);
});
