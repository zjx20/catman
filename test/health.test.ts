import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHealth,
  isDrained,
  isHealthPath,
  HEALTH_SCHEMA,
  type HealthDeps,
} from "../src/dashboard/health.js";
import type { GatewayHealth } from "../src/core/gateway.js";

function deps(over: Partial<HealthDeps> = {}): HealthDeps {
  const gw: GatewayHealth = { inFlight: { foreground: 0, background: 0 }, queued: 0, aggregating: 0 };
  return {
    version: { sha: "abc123", preparedAt: "2026-08-08T10:00:00Z" },
    bootOk: () => true,
    channels: () => [{ name: "wechat", started: true, live: true }],
    gateway: () => gw,
    startedAt: 1000,
    now: () => 5000,
    ...over,
  };
}

test("路由只认 /health", () => {
  assert.equal(isHealthPath("/health"), true);
  assert.equal(isHealthPath("/health/"), false);
  assert.equal(isHealthPath("/api/health"), false);
});

test("payload 的形状 —— 这就是那份跨版本契约", () => {
  const h = buildHealth(deps());
  // 字段只增不改:读它的 deployer 与守护人格跑的是人工钦定的旧代码。
  // 这条断言故意写成全等,少一个字段、改一个名字都会在这里失败。
  assert.deepEqual(h, {
    schema: HEALTH_SCHEMA,
    version: { sha: "abc123", preparedAt: "2026-08-08T10:00:00Z" },
    bootOk: true,
    channels: [{ name: "wechat", started: true, live: true }],
    inFlight: { foreground: 0, background: 0 },
    queued: 0,
    aggregating: 0,
    lastTurn: null,
    uptimeMs: 4000,
  });
});

test("没有版本戳时 version 是 null,不编一个", () => {
  const h = buildHealth(deps({ version: undefined }));
  assert.equal(h.version, null);
});

test("uptimeMs 不会为负(时钟回拨也不出怪值)", () => {
  const h = buildHealth(deps({ startedAt: 9999, now: () => 1000 }));
  assert.equal(h.uptimeMs, 0);
});

test("lastTurn 原样透出,供观测", () => {
  const gw: GatewayHealth = {
    inFlight: { foreground: 1, background: 2 },
    queued: 3,
    aggregating: 4,
    lastTurn: { at: 123, isError: true },
  };
  const h = buildHealth(deps({ gateway: () => gw }));
  assert.deepEqual(h.lastTurn, { at: 123, isError: true });
  assert.deepEqual(h.inFlight, { foreground: 1, background: 2 });
  assert.equal(h.queued, 3);
  assert.equal(h.aggregating, 4);
});

test("排水:三个计数同时为零才算排干", () => {
  const base = buildHealth(deps());
  assert.equal(isDrained(base), true);

  for (const gw of [
    { inFlight: { foreground: 1, background: 0 }, queued: 0, aggregating: 0 },
    { inFlight: { foreground: 0, background: 0 }, queued: 1, aggregating: 0 },
    { inFlight: { foreground: 0, background: 0 }, queued: 0, aggregating: 1 },
  ] satisfies GatewayHealth[]) {
    assert.equal(isDrained(buildHealth(deps({ gateway: () => gw }))), false);
  }
});

test("后台回合不挡排水 —— 它们是用户说过「你接着跑」的长任务,等它们等于永远切不了", () => {
  const gw: GatewayHealth = {
    inFlight: { foreground: 0, background: 3 },
    queued: 0,
    aggregating: 0,
  };
  assert.equal(isDrained(buildHealth(deps({ gateway: () => gw }))), true);
});

test("渠道自述原样透出;不实现 health() 的渠道不出现而不是被当成健康", () => {
  const h = buildHealth(
    deps({
      channels: () => [
        { name: "wechat", started: true, live: false },
        { name: "dashboard", started: true, live: true },
      ],
    }),
  );
  assert.deepEqual(h.channels, [
    { name: "wechat", started: true, live: false },
    { name: "dashboard", started: true, live: true },
  ]);
});
