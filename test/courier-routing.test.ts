import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PERSONA,
  RoutingTable,
  routeExpiredText,
  switchedToPrimaryText,
  switchedToRescueText,
} from "../src/courier/routing.js";
import { fallbackText } from "../src/courier/fallback.js";
import { COMMAND_TABLE, canonicalOf, commandHelpLines, parseCommand } from "../src/core/commands.js";

const U = "wechat:acc1:u1";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "catman-routing-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 路由表 ────────────────────────────────────────────────────────

test("路由:默认归主人格,切过去再切回来", () => {
  withDir((dir) => {
    const t = new RoutingTable({ path: join(dir, "routes.json") });
    assert.equal(t.personaFor(U), DEFAULT_PERSONA);

    const to = t.switchTo(U, "rescue");
    assert.deepEqual(to, { changed: true, previous: "primary" });
    assert.equal(t.personaFor(U), "rescue");

    const back = t.switchTo(U, "primary");
    assert.deepEqual(back, { changed: true, previous: "rescue" });
    assert.equal(t.personaFor(U), "primary");
  });
});

test("路由:switchTo 要报出切换**前**归谁 —— detach 该发给被切走的那一个", () => {
  // 评审专门点过:需要标出处的是被切走的那个人格,不是切过去的那个。
  withDir((dir) => {
    const t = new RoutingTable({ path: join(dir, "routes.json") });
    t.switchTo(U, "rescue");
    assert.equal(t.switchTo(U, "primary").previous, "rescue");
  });
});

test("路由:切到已经在的那个不算变更,但仍刷新时钟", () => {
  let now = 1000;
  withDir((dir) => {
    const t = new RoutingTable({ path: join(dir, "routes.json"), ttlMs: 500, now: () => now });
    t.switchTo(U, "rescue");
    now = 1400;
    const again = t.switchTo(U, "rescue");
    assert.equal(again.changed, false);
    now = 1800; // 距首次切换 800 > ttl,但距刚才那次刷新只有 400
    assert.deepEqual(t.sweepExpired(), [], "用户刚刚明确表达过「我还要待在这儿」");
  });
});

test("路由:非默认路由闲置到点自动回落,并报出是从哪儿回来的", () => {
  // 「忘了切回」是最现实的失败模式:人切过去排查完就去忙别的,而主人格从此再也
  // 收不到他的消息 —— 在他那边表现为"catman 变傻了",他根本想不到是路由的问题。
  let now = 1000;
  withDir((dir) => {
    const t = new RoutingTable({ path: join(dir, "routes.json"), ttlMs: 500, now: () => now });
    t.switchTo(U, "rescue");
    now = 1400;
    assert.deepEqual(t.sweepExpired(), [], "还没到点");
    now = 1600;
    assert.deepEqual(t.sweepExpired(), [{ userKey: U, from: "rescue" }]);
    assert.equal(t.personaFor(U), "primary");
    assert.deepEqual(t.sweepExpired(), [], "回落只报一次");
  });
});

test("路由:回到默认之后不再有超时 —— 那是常态,不该被反复扫", () => {
  let now = 1000;
  withDir((dir) => {
    const t = new RoutingTable({ path: join(dir, "routes.json"), ttlMs: 500, now: () => now });
    t.switchTo(U, "rescue");
    t.switchTo(U, "primary");
    now = 10_000_000;
    assert.deepEqual(t.sweepExpired(), []);
  });
});

test("路由:跨重启存活 —— 丢了就是「切到救援之后重启又回到那个卡死的主人格」", () => {
  // 而那恰好发生在最需要救援的时候。
  withDir((dir) => {
    const path = join(dir, "routes.json");
    new RoutingTable({ path }).switchTo(U, "rescue");
    assert.equal(new RoutingTable({ path }).personaFor(U), "rescue");
  });
});

test("路由:盘上读不懂的条目丢掉 = 回到默认,那是安全的一侧", () => {
  withDir((dir) => {
    const path = join(dir, "routes.json");
    writeFileSync(path, JSON.stringify({ [U]: { persona: "未来人格" }, x: "不是对象" }));
    const t = new RoutingTable({ path });
    assert.equal(t.personaFor(U), "primary");
    assert.deepEqual(t.snapshot(), []);
  });
});

test("路由:touch 刷新 TTL,对默认路由是空操作", () => {
  let now = 1000;
  withDir((dir) => {
    const t = new RoutingTable({ path: join(dir, "routes.json"), ttlMs: 500, now: () => now });
    t.switchTo(U, "rescue");
    now = 1400;
    t.touch(U);
    now = 1800;
    assert.deepEqual(t.sweepExpired(), [], "有活动就不该被扫掉");
    t.touch("从来没切过的人"); // 不该抛
  });
});

// ── 文案 ──────────────────────────────────────────────────────────

test("文案:切换与回落都从 COMMAND_TABLE 取指令写法,不手写字面量", () => {
  // 指令改名时文案要自动跟上 —— 手写的话改名之后会教出一条不存在的指令。
  assert.ok(switchedToRescueText().includes(canonicalOf("primaryPersona")));
  assert.ok(routeExpiredText("rescue").includes(canonicalOf("rescue")));
  assert.ok(switchedToPrimaryText().length > 0);
});

test("文案:自动回落必须说清「现在是谁在跟你说话」", () => {
  // 悄悄拨回去的话,他下一句话落到主人格那儿,而他以为还在跟守护人格说话 ——
  // 那比忘了切回还糟。
  const t = routeExpiredText("rescue");
  assert.match(t, /主人格/);
});

// ── 兜底文案(路由感知) ──────────────────────────────────────────

test("兜底:路由在主人格时,告诉管理员可以召唤守护人格", () => {
  const t = fallbackText({ persona: "primary", isAdmin: true });
  assert.match(t, /没有响应/);
  assert.ok(t.includes(canonicalOf("rescue")));
});

test("兜底:普通用户不该看到一条他用不了的建议", () => {
  // /救援 是 adminOnly,对普通用户提它等于给一个按了没用的按钮。
  const t = fallbackText({ persona: "primary", isAdmin: false });
  assert.equal(t.includes(canonicalOf("rescue")), false);
  assert.match(t, /收着了/, "但要让他知道消息没丢");
});

test("兜底:已经在守护人格了,就绝不再劝他切到守护人格", () => {
  // 评审专门点过这一条:他照做,什么也没发生,而他会认为是自己操作错了。
  const t = fallbackText({ persona: "rescue", isAdmin: true });
  assert.equal(t.includes(canonicalOf("rescue")), false);
  assert.match(t, /两边都没起来|也没有响应/);
});

test("兜底:知道状态页地址就给出来 —— 那时它才是真出口", () => {
  const t = fallbackText({ persona: "rescue", isAdmin: true, rescueStatusUrl: "http://x:8788" });
  assert.match(t, /http:\/\/x:8788/);
});

// ── 指令表的单一真相源 ────────────────────────────────────────────

test("信使侧的三条指令登记在同一张表里 —— 分两张表的结果是用户永远不知道它们存在", () => {
  for (const name of ["rescue", "primaryPersona", "bind"]) {
    const cmd = COMMAND_TABLE.find((c) => c.name === name);
    assert.equal(cmd?.where, "courier", `${name} 该由信使执行`);
  }
  // 而人格侧的一条都不该被标成 courier。
  for (const name of ["help", "status", "cancel", "publish", "rollback"]) {
    const cmd = COMMAND_TABLE.find((c) => c.name === name);
    assert.notEqual(cmd?.where, "courier", `${name} 是人格执行的`);
  }
});

test("/绑定 刻意不是 adminOnly —— 它要救的正是「被准入挡在门外」的人", () => {
  // 那种处境下他不可能被认作管理员。安全前提是口令本身(带外给出、0600 落盘)。
  assert.notEqual(COMMAND_TABLE.find((c) => c.name === "bind")?.adminOnly, true);
  assert.equal(COMMAND_TABLE.find((c) => c.name === "bind")?.takesArg, true);
  assert.equal(parseCommand("/绑定 abc123")?.arg, "abc123");
});

test("帮助文案会列出信使侧的指令 —— 发现性全靠它", () => {
  const admin = commandHelpLines(true).join("\n");
  assert.ok(admin.includes(canonicalOf("rescue")));
  assert.ok(admin.includes(canonicalOf("primaryPersona")));
  // /绑定 反过来:它只在"还没绑定"时有意义,而能看到帮助的人全都已经绑定过了 ——
  // 对它的全部受众来说那是一行死文案。发现性由安装时给出的带外口令承担。
  assert.equal(admin.includes(canonicalOf("bind")), false, "管理员也不该看到它");
  assert.equal(commandHelpLines().join("\n").includes(canonicalOf("bind")), false);
});
