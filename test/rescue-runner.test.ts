import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RescueRunner } from "../src/rescue/runner.js";
import type { ContainerState } from "../src/rescue/watchdog.js";

/**
 * 看门狗执行层(RescueRunner.tick)的接线。决策已经在 watchdog.test 里逐条钉死,
 * 这里验的是执行侧那些"决策看不见"的东西:动作真的走到 deployer、门闩只放一次、
 * 点火按报告排程 —— 这些都是 runner 自己的状态,拆掉任何一个决策照旧全绿。
 */

const OK: ContainerState = { running: true, restarts: 0, since: 0 };

function makeRunner(opts: {
  dir: string;
  diskFree?: () => number | undefined;
  now?: () => number;
}): { runner: RescueRunner; calls: string[][] } {
  const calls: string[][] = [];
  const releases = join(opts.dir, "releases");
  mkdirSync(releases, { recursive: true });
  mkdirSync(join(opts.dir, "deploy"), { recursive: true });
  // current 指针:tick 开头要读它来判断"人插手过没"。
  mkdirSync(join(releases, "a".repeat(40)), { recursive: true });
  symlinkSync("a".repeat(40), join(releases, "current"));
  const runner = new RescueRunner({
    dataDir: opts.dir,
    releasesDir: releases,
    deployDir: join(opts.dir, "deploy"),
    courierDir: join(opts.dir, "courier"),
    primaryContainer: "catman",
    courierContainer: "catman-courier",
    statusPort: 0,
    token: "t",
    now: opts.now ?? (() => 1_700_000_000_000),
    runDeployer: (args) => calls.push([...args]),
    inspect: () => OK,
    ...(opts.diskFree ? { diskFree: opts.diskFree } : {}),
  });
  return { runner, calls };
}

test("磁盘红线触发一次 deployer gc,清完还红不再清", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-runner-"));
  try {
    const { runner, calls } = makeRunner({ dir, diskFree: () => 500 });
    runner.tick();
    assert.deepEqual(calls.filter((c) => c[0] === "gc").length, 1, "该清一次");
    runner.tick();
    assert.deepEqual(
      calls.filter((c) => c[0] === "gc").length,
      1,
      "清过仍红只报警,不反复清 —— 清无可清时反复清是空转",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("从没点过火就踢一次 drill,且冷却期内不重踢", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-runner2-"));
  try {
    let t = 1_700_000_000_000;
    const { runner, calls } = makeRunner({ dir, diskFree: () => 50_000, now: () => t });
    runner.tick();
    assert.equal(calls.filter((c) => c[0] === "drill").length, 1, "第一轮该点火");
    t += 30_000; // 下一个 tick
    runner.tick();
    assert.equal(
      calls.filter((c) => c[0] === "drill").length,
      1,
      "drill 还在跑(报告未出),不该再起一串容器",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("点火报告新鲜时不点;满一周后再点", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-runner3-"));
  try {
    let t = 1_700_000_000_000;
    const { runner, calls } = makeRunner({ dir, diskFree: () => 50_000, now: () => t });
    // 摆一份 6 天前的点火报告。
    writeFileSync(
      join(dir, "deploy", "ignition.json"),
      JSON.stringify({ schema: 1, ranAt: new Date(t - 6 * 24 * 3600_000).toISOString(), ok: true, detail: "" }),
      "utf8",
    );
    runner.tick();
    assert.equal(calls.filter((c) => c[0] === "drill").length, 0, "报告才 6 天,不该点");
    t += 2 * 24 * 3600_000; // 又过 2 天,报告 8 天了
    runner.tick();
    assert.equal(calls.filter((c) => c[0] === "drill").length, 1, "满一周该点了");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
