import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOKEN_ALERT_DAYS,
  TokenAlerter,
  parseCredentialsExpiry,
  readTokenExpiry,
  shouldAnnounce,
  tokenStatus,
  tokenStatusLine,
} from "../src/core/token-alert.js";

/**
 * OAuth token 到期告警。
 *
 * token 过期是「失败域诚实条款」点名的三大死法之一,而且两个人格共用同一份 ——
 * 过期那一刻整个系统一起静默死掉。告警是唯一防线,所以这里逐条钉:
 * 到期时刻拿不到就诚实说未知(绝不编)、每个阈值只播一次、换 token 自动重来。
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

// --- 解析 ---

test("凭据文件形状对就取出 expiresAt", () => {
  assert.equal(parseCredentialsExpiry({ claudeAiOauth: { expiresAt: 123 } }), 123);
});

test("形状不对一律 undefined —— 读不到就是不知道,绝不编", () => {
  // 与 version.ts 同一条纪律:编一个假倒计时比没有倒计时糟得多(人会信它)。
  for (const bad of [undefined, null, "", 42, {}, { claudeAiOauth: null }, { claudeAiOauth: {} },
    { claudeAiOauth: { expiresAt: "soon" } }, { claudeAiOauth: { expiresAt: Number.NaN } },
    { claudeAiOauth: { expiresAt: 0 } }]) {
    assert.equal(parseCredentialsExpiry(bad), undefined, JSON.stringify(bad));
  }
});

test("过去的时间戳照样返回 —— 「已过期」本身就是最要紧的那条信息", () => {
  assert.equal(parseCredentialsExpiry({ claudeAiOauth: { expiresAt: 1 } }), 1);
});

test("readTokenExpiry:文件不存在 / 不是 JSON 都安静地返回 undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-token-"));
  try {
    assert.equal(readTokenExpiry(dir), undefined, "没有文件");
    writeFileSync(join(dir, ".credentials.json"), "not json", "utf8");
    assert.equal(readTokenExpiry(dir), undefined, "坏 JSON");
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { expiresAt: 99 } }),
      "utf8",
    );
    assert.equal(readTokenExpiry(dir), 99);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 分档 ---

test("四档状态:unknown / ok / warn / expired", () => {
  assert.equal(tokenStatus(undefined, NOW).kind, "unknown");
  assert.equal(tokenStatus(NOW + 30 * DAY, NOW).kind, "ok");
  const w = tokenStatus(NOW + 5 * DAY, NOW);
  assert.deepEqual(w, { kind: "warn", daysLeft: 5, threshold: 7 });
  assert.equal(tokenStatus(NOW - 1, NOW).kind, "expired");
});

test("阈值取**当前所处的最严那档**,天数向上取整", () => {
  // 剩 0.5 天算 1 天:告警宁早勿晚,而"还剩 0 天"读起来像已经过期。
  const s = tokenStatus(NOW + DAY / 2, NOW);
  assert.deepEqual(s, { kind: "warn", daysLeft: 1, threshold: 1 });
  // 恰好 14 天在 14 档;15 天不告。
  assert.equal(tokenStatus(NOW + 14 * DAY, NOW).kind, "warn");
  assert.equal(tokenStatus(NOW + 15 * DAY, NOW).kind, "ok");
});

test("unknown 那行要说清「真正的探测靠回合报错」—— 别让人以为一切安好", () => {
  assert.match(tokenStatusLine({ kind: "unknown" }), /回合报错/);
  assert.match(tokenStatusLine({ kind: "expired" }), /setup-token/);
});

// --- 播报去重 ---

test("每个阈值只播一次,只降不升", () => {
  const warn7 = tokenStatus(NOW + 5 * DAY, NOW);
  assert.equal(shouldAnnounce(warn7, undefined), 7, "第一次要播");
  assert.equal(shouldAnnounce(warn7, 7), undefined, "同档不重播");
  assert.equal(shouldAnnounce(warn7, 3), undefined, "播过更严的档就不回头");
  const warn3 = tokenStatus(NOW + 2 * DAY, NOW);
  assert.equal(shouldAnnounce(warn3, 7), 3, "跨进更严的档要再播");
  assert.equal(shouldAnnounce({ kind: "expired" }, 1), 0, "过期是最后一档");
  assert.equal(shouldAnnounce({ kind: "ok", daysLeft: 30 }, undefined), undefined);
  assert.equal(shouldAnnounce({ kind: "unknown" }, undefined), undefined, "未知绝不告警");
});

test("阈值阶梯本身:从宽到严,最后一档是 1 天", () => {
  // 换阶梯前想清楚:最后一档决定了人最少有多少反应时间 —— 换发要人在宿主跑命令。
  const sorted = [...TOKEN_ALERT_DAYS].sort((a, b) => b - a);
  assert.deepEqual([...TOKEN_ALERT_DAYS], sorted, "要从宽到严");
  assert.equal(TOKEN_ALERT_DAYS[TOKEN_ALERT_DAYS.length - 1], 1);
});

// --- TokenAlerter(记账落盘)---

function makeAlerter(dir: string, expiry: () => number | undefined, now: () => number): TokenAlerter {
  return new TokenAlerter({ expiry, seenPath: join(dir, "seen.json"), now });
}

test("pending → 发送成功 markAnnounced → 不再 pending;进程重启也不重播", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-alerter-"));
  try {
    let t = NOW;
    const exp = NOW + 5 * DAY;
    const a = makeAlerter(dir, () => exp, () => t);
    const first = a.pending();
    assert.ok(first && first.includes("天"), `该有一条告警:${first}`);
    a.markAnnounced();
    assert.equal(a.pending(), undefined, "播过就不重播");
    // "重启":新实例、同一个记账文件。
    assert.equal(makeAlerter(dir, () => exp, () => t).pending(), undefined, "落盘后重启不重播");
    // 时间推进到更严的档,要再播。
    t = NOW + 3 * DAY; // 剩 2 天 → 3 天档
    assert.ok(a.pending(), "跨档要再播");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("换了 token(expiresAt 变了)记账作废,新倒计时从头告", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-alerter2-"));
  try {
    let exp = NOW + 5 * DAY;
    const a = makeAlerter(dir, () => exp, () => NOW);
    a.markAnnounced();
    assert.equal(a.pending(), undefined);
    // 人跑了 setup-token,新 token 又只剩 6 天(比如测试环境)—— 要重新告。
    exp = NOW + 6 * DAY;
    assert.ok(a.pending(), "新 token 的告警不能被旧账压住");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("拿不到到期时刻时 pending 永远是 undefined —— env 长效 token 的常态", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-alerter3-"));
  try {
    const a = makeAlerter(dir, () => undefined, () => NOW);
    assert.equal(a.pending(), undefined);
    a.markAnnounced(); // 不该炸,也不该写出误导性的账
    assert.equal(a.pending(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
