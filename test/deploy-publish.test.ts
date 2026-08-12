import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BAKE_SECONDS, ScriptDeployControl } from "../src/core/deploy.js";

/**
 * `/发布 <sha> [观察期秒数]` 的解析与透传。
 *
 * 观察期走 env(`CATMAN_BAKE_SECONDS`)而不是命令行开关:`deployer-run.sh` 属 Tier 3,
 * 它早就认这个变量并转发给容器,而加一个新开关要重新 bless 才生效。
 */

const A = "a".repeat(40);
const B = "b".repeat(40);

interface Spawned {
  args: readonly string[];
  env?: Record<string, string>;
}

function withControl(
  fn: (ctl: ScriptDeployControl, spawned: Spawned[]) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "catman-pub-"));
  const releases = join(dir, "releases");
  for (const sha of [A, B]) {
    const d = join(releases, sha);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "VERSION"), JSON.stringify({ sha, preparedAt: "2026-08-12T00:00:00Z" }));
    writeFileSync(join(d, "MANIFEST"), "deadbeef  VERSION\n");
  }
  const spawned: Spawned[] = [];
  const ctl = new ScriptDeployControl({
    runnerPath: join(dir, "deployer-run.sh"),
    reportPath: join(dir, "report.json"),
    seenPath: join(dir, "seen.json"),
    releasesDir: releases,
    historyPath: join(dir, "history.json"),
    spawnRunner: async (_path, args, env) => {
      spawned.push({ args, ...(env ? { env } : {}) });
    },
  });
  return fn(ctl, spawned).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("/发布 不带观察期:照旧,而且默认值也显式传给 deployer", async () => {
  await withControl(async (ctl, spawned) => {
    const said = await ctl.requestDeploy("aaaaaaa", "admin");
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0]!.args, ["deploy", A, "--requested-by", "admin"]);
    // 显式传值而不是靠脚本里的默认值:否则"告诉用户等多久"与"实际等多久"是两个数,
    // 迟早对不上,而对不上的那次没人看得出来。
    assert.equal(spawned[0]!.env?.["CATMAN_BAKE_SECONDS"], String(DEFAULT_BAKE_SECONDS));
    assert.ok(said.includes("30 分钟观察期"), said);
  });
});

test("/发布 带观察期:透传给 deployer,并说清缩短的代价", async () => {
  await withControl(async (ctl, spawned) => {
    const said = await ctl.requestDeploy("aaaaaaa 60", "admin");
    assert.deepEqual(spawned[0]!.args, ["deploy", A, "--requested-by", "admin"], "口令那一半不动");
    assert.equal(spawned[0]!.env?.["CATMAN_BAKE_SECONDS"], "60");
    assert.ok(said.includes("60 秒观察期"), said);
    // 缩短观察期 = 把自动回滚那张网提前撤掉,这件事必须说出来。
    assert.ok(said.includes("自动退回"), `缩短时要交代代价:${said}`);
  });
});

test("/发布 的观察期不是数字:说清楚,而且不去猜他想发哪个版本", async () => {
  await withControl(async (ctl, spawned) => {
    const said = await ctl.requestDeploy("aaaaaaa 一分钟", "admin");
    assert.equal(spawned.length, 0, "看不懂就一步都别走");
    assert.ok(said.includes("整数秒数"), said);
  });
});

test("/发布 的观察期超出范围:两头都拦,并说明为什么有这两头", async () => {
  await withControl(async (ctl, spawned) => {
    const tooShort = await ctl.requestDeploy("aaaaaaa 5", "admin");
    assert.ok(tooShort.includes("30"), tooShort);
    assert.ok(tooShort.includes("自动回滚"), `要说清短了会失去什么:${tooShort}`);

    const tooLong = await ctl.requestDeploy("aaaaaaa 36000", "admin");
    assert.ok(tooLong.includes("3600"), tooLong);
    assert.equal(spawned.length, 0, "两种都不该起 deployer");
  });
});

test("/发布 跟了三段:拒绝 —— 多打的那段可能是把版本号敲断了", async () => {
  await withControl(async (ctl, spawned) => {
    const said = await ctl.requestDeploy("aaaaaaa 60 又一段", "admin");
    assert.equal(spawned.length, 0);
    assert.ok(said.includes("最多跟两段"), said);
  });
});

test("加了参数之后,版本号那一半的判断一个字都没变", async () => {
  await withControl(async (ctl, spawned) => {
    assert.ok((await ctl.requestDeploy("aa", "admin")).includes("至少"), "太短");
    assert.ok((await ctl.requestDeploy("ccccccc", "admin")).includes("没有以"), "没有这个");
    assert.ok((await ctl.requestDeploy("aa 60", "admin")).includes("至少"), "带参数时同样");
    assert.equal(spawned.length, 0, "以上都不该起 deployer");
  });
});
