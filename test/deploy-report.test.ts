import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeployReports,
  DEPLOY_REPORT_SCHEMA,
  formatDeployReport,
  parseDeployReport,
  type DeployReport,
} from "../src/core/deploy-report.js";
import { parseVerifiedHistory, ScriptDeployControl } from "../src/core/deploy.js";

const GOOD = {
  schema: DEPLOY_REPORT_SCHEMA,
  id: "d-1",
  outcome: "deployed",
  sha: "abc1234567",
  finishedAt: "2026-08-08T10:00:00Z",
  detail: "把回执文案改短了",
  requestedBy: "wechat:acc:u1",
};

test("完整报告原样解析", () => {
  const r = parseDeployReport(GOOD);
  assert.equal(r?.id, "d-1");
  assert.equal(r?.outcome, "deployed");
  assert.equal(r?.sha, "abc1234567");
  assert.equal(r?.requestedBy, "wechat:acc:u1");
});

// 下面几条守的是同一条纪律:**读不懂的报告等于没有报告**。
// 一个能让 catman 起不来的报告文件,会把"部署失败"升级成"永久下线"。
test("坏形状一律返回 undefined,绝不抛", () => {
  for (const bad of [
    undefined,
    null,
    "字符串",
    42,
    [],
    {},
    { ...GOOD, id: "" },
    { ...GOOD, id: 7 },
    { ...GOOD, outcome: "unknown-outcome" },
    { ...GOOD, sha: "" },
    { ...GOOD, sha: null },
  ]) {
    assert.equal(parseDeployReport(bad), undefined, JSON.stringify(bad));
  }
});

test("未来版本多出来的字段不影响解析 —— 字段只增不改,旧读者要能读新报告", () => {
  const r = parseDeployReport({ ...GOOD, schema: 99, 未来字段: { a: 1 } });
  assert.equal(r?.id, "d-1");
  assert.equal(r?.schema, 99);
});

test("可选字段坏了只丢那个字段,不丢整份报告", () => {
  const r = parseDeployReport({ ...GOOD, finishedAt: 12, requestedBy: 0, interruptedBackgroundTurns: -3 });
  assert.equal(r?.id, "d-1");
  assert.equal(r?.finishedAt, "");
  assert.equal(r?.requestedBy, undefined);
  assert.equal(r?.interruptedBackgroundTurns, undefined);
});

test("回滚的播报必须说清「你要的改动没上线」——用户会照着相反的前提行动", () => {
  const text = formatDeployReport({
    schema: 1,
    id: "d-2",
    outcome: "rolled-back",
    sha: "newsha1234",
    revertedTo: "oldsha5678",
    finishedAt: "t",
    detail: "健康门超时,容器反复重启",
  });
  assert.match(text, /没有.*上线|没.*上线/);
  assert.match(text, /oldsha5/, "要说清现在跑的是哪个版本");
  assert.match(text, /健康门超时/, "失败原因是排查的起点,必须带上");
});

test("中止的播报要说清线上没动过 —— 与回滚是两种处境", () => {
  const text = formatDeployReport({
    schema: 1,
    id: "d-3",
    outcome: "aborted",
    sha: "abc",
    finishedAt: "t",
    detail: "测试没过",
  });
  assert.match(text, /没动过|一直没动/);
});

test("被中断的后台回合必须点名 —— 静默吞掉是最糟的失败模式", () => {
  const text = formatDeployReport({
    schema: 1,
    id: "d-4",
    outcome: "deployed",
    sha: "abc",
    finishedAt: "t",
    detail: "",
    interruptedBackgroundTurns: 2,
  });
  assert.match(text, /2 段后台对话被中断/);
});

test("已播报标记落盘 —— 不落盘的话 crash-loop 会把同一条结果反复播", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-report-"));
  try {
    const reportPath = join(dir, "report.json");
    const seenPath = join(dir, "seen.json");
    writeFileSync(reportPath, JSON.stringify(GOOD));

    const first = new DeployReports(reportPath, seenPath);
    assert.equal(first.pending()?.id, "d-1");
    first.markAnnounced("d-1");
    assert.equal(first.pending(), undefined);

    // 换一个实例 = 模拟进程重启:标记必须还在。
    const afterRestart = new DeployReports(reportPath, seenPath);
    assert.equal(afterRestart.pending(), undefined);
    assert.equal(afterRestart.latest()?.id, "d-1", "latest 不受已读标记影响,/升级状态 还要看它");

    // 新的一次部署 = 新 id,又该播了。
    writeFileSync(reportPath, JSON.stringify({ ...GOOD, id: "d-2" }));
    assert.equal(afterRestart.pending()?.id, "d-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("报告文件不存在时一切照常(没有部署过就是这个状态)", () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-report-"));
  try {
    const reports = new DeployReports(join(dir, "nope.json"), join(dir, "seen.json"));
    assert.equal(reports.latest(), undefined);
    assert.equal(reports.pending(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("已验证版本清单:顺序保持新→旧,坏条目只丢自己", () => {
  const list = parseVerifiedHistory({
    schema: 1,
    releases: [
      { sha: "new1", verifiedAt: "t3" },
      { sha: "", verifiedAt: "t2" },
      "不是对象",
      { sha: "old1" },
    ],
  });
  assert.deepEqual(list, [
    { sha: "new1", verifiedAt: "t3" },
    { sha: "old1", verifiedAt: "" },
  ]);
});

test("清单形状不对返回空数组,不抛", () => {
  for (const bad of [undefined, null, 42, [], { releases: "nope" }, {}]) {
    assert.deepEqual(parseVerifiedHistory(bad), []);
  }
});

test("只有一个已验证版本时拒绝回滚,而不是起一个注定失败的 deployer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-deploy-"));
  try {
    const historyPath = join(dir, "verified-history.json");
    writeFileSync(historyPath, JSON.stringify({ schema: 1, releases: [{ sha: "only1", verifiedAt: "t" }] }));
    let spawned = 0;
    const ctl = new ScriptDeployControl({
      runnerPath: join(dir, "run.sh"),
      reportPath: join(dir, "report.json"),
      seenPath: join(dir, "seen.json"),
      historyPath,
      spawnRunner: async () => {
        spawned += 1;
      },
    });
    const msg = await ctl.requestRollback("wechat:a:u");
    assert.match(msg, /没有可回退的版本/);
    assert.equal(spawned, 0, "没有目标就不该起 deployer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回滚目标是清单里的第二个(当前是第一个),并把发起人传给 deployer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catman-deploy-"));
  try {
    const historyPath = join(dir, "verified-history.json");
    writeFileSync(
      historyPath,
      JSON.stringify({
        schema: 1,
        releases: [
          { sha: "current999", verifiedAt: "t2" },
          { sha: "previous111", verifiedAt: "t1" },
        ],
      }),
    );
    let gotArgs: readonly string[] = [];
    const ctl = new ScriptDeployControl({
      runnerPath: join(dir, "run.sh"),
      reportPath: join(dir, "report.json"),
      seenPath: join(dir, "seen.json"),
      historyPath,
      spawnRunner: async (_p, args) => {
        gotArgs = args;
      },
    });
    const msg = await ctl.requestRollback("wechat:a:u");
    assert.match(msg, /previo/, "要告诉用户会退到哪个版本");
    assert.deepEqual(gotArgs, ["rollback", "--requested-by", "wechat:a:u"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("报告是契约:golden 形状 —— 改字段名/删字段会在这里失败", () => {
  const r: DeployReport = parseDeployReport({
    ...GOOD,
    revertedTo: "old",
    interruptedBackgroundTurns: 2,
  })!;
  assert.deepEqual(Object.keys(r).sort(), [
    "detail",
    "finishedAt",
    "id",
    "interruptedBackgroundTurns",
    "outcome",
    "requestedBy",
    "revertedTo",
    "schema",
    "sha",
  ]);
});
