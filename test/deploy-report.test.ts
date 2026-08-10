import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeployReports,
  DEPLOY_REPORT_SCHEMA,
  formatDeployReport,
  parseDeployReport,
  type DeployReport,
} from "../src/core/deploy-report.js";
import {
  parseVerifiedHistory,
  ScriptDeployControl,
  defaultSpawnRunner,
} from "../src/core/deploy.js";

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
      releasesDir: join(dir, "releases"),
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
      releasesDir: join(dir, "releases"),
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

// ── /发布:确认口令落到具体 sha 上 ────────────────────────────────
// 四种拒绝各说各的话不是排版讲究:处置完全不同(重打 / 先制备 / 多打几位 / 根本不用动)。
// 含糊一句"发布失败"会让人反复重试同一串,而每一次都在等一个不会来的结果。

const SHA_A = "a".repeat(40);
const SHA_B = `bbbbbb${"0".repeat(34)}`;
const SHA_B2 = `bbbbbb${"1".repeat(34)}`;

function makePrepared(releasesDir: string, sha: string, branch?: string): void {
  const d = join(releasesDir, sha);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "VERSION"),
    JSON.stringify({ sha, preparedAt: "2026-08-09T00:00:00Z", ...(branch ? { branch } : {}) }),
  );
  writeFileSync(join(d, "MANIFEST"), "x  VERSION\n");
}

/**
 * 起一个带 release 目录的控制面。runningSha 决定"哪个是正在跑的那份"。
 *
 * **必须 await 回调**:不 await 的话临时目录会在异步工作跑完之前就被删掉,
 * 而回调里的断言失败会变成未处理的 rejection —— 用例不是变红,是挂住。
 */
async function withControl(
  fn: (
    ctl: ScriptDeployControl,
    spawned: () => readonly string[][],
    releasesDir: string,
  ) => Promise<void>,
  runningSha?: string,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "catman-publish-"));
  try {
    const releasesDir = join(dir, "releases");
    mkdirSync(releasesDir, { recursive: true });
    const calls: string[][] = [];
    const ctl = new ScriptDeployControl({
      runnerPath: join(dir, "run.sh"),
      reportPath: join(dir, "report.json"),
      seenPath: join(dir, "seen.json"),
      releasesDir,
      historyPath: join(releasesDir, "verified-history.json"),
      ...(runningSha ? { runningSha } : {}),
      spawnRunner: async (_p, args) => {
        calls.push([...args]);
      },
    });
    await fn(ctl, () => calls, releasesDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("/发布:命中唯一候选就起 deployer,并把发起人传下去", async () => {
  await withControl(async (ctl, spawned, releasesDir) => {
    makePrepared(releasesDir, SHA_A, "evolve/copy");
    const msg = await ctl.requestDeploy(SHA_A.slice(0, 7), "wechat:a:u");
    assert.match(msg, /已提交部署/);
    assert.match(msg, /evolve\/copy/, "要说清发的是哪次改动");
    assert.deepEqual(spawned(), [["deploy", SHA_A, "--requested-by", "wechat:a:u"]]);
  });
});

test("/发布:前缀太短一律拒绝 —— 哪怕它其实只匹配一个", async () => {
  await withControl(async (ctl, spawned, releasesDir) => {
    makePrepared(releasesDir, SHA_A);
    const msg = await ctl.requestDeploy("aaa", "wechat:a:u");
    assert.match(msg, /至少/);
    assert.deepEqual(spawned(), [], "拒绝就不该起 deployer");
  });
});

test("/发布:没有这个版本时列出有哪些,人多半只是记错了几位", async () => {
  await withControl(async (ctl, spawned, releasesDir) => {
    makePrepared(releasesDir, SHA_A);
    const msg = await ctl.requestDeploy("ffffff", "wechat:a:u");
    assert.match(msg, /没有以/);
    assert.match(msg, /aaaaaaa/, "要把候选摆出来");
    assert.deepEqual(spawned(), []);
  });
});

test("/发布:一个候选都没有时明说要先制备,而不是干说找不到", async () => {
  await withControl(async (ctl, spawned) => {
    const msg = await ctl.requestDeploy("abcdef", "wechat:a:u");
    assert.match(msg, /先制备/);
    assert.deepEqual(spawned(), []);
  });
});

test("/发布:前缀有歧义时要求多打几位,绝不替人挑一个", async () => {
  await withControl(async (ctl, spawned, releasesDir) => {
    makePrepared(releasesDir, SHA_B);
    makePrepared(releasesDir, SHA_B2);
    const msg = await ctl.requestDeploy("bbbbbb", "wechat:a:u");
    assert.match(msg, /多打几位/);
    assert.deepEqual(spawned(), []);
  });
});

test("/发布:目标就是正在跑的那份时不动 —— 否则是 30 分钟观察期的空转", async () => {
  await withControl(async (ctl, spawned, releasesDir) => {
    makePrepared(releasesDir, SHA_A);
    const msg = await ctl.requestDeploy(SHA_A.slice(0, 7), "wechat:a:u");
    assert.match(msg, /就是我现在跑的/);
    assert.deepEqual(spawned(), []);
  }, SHA_A);
});

test("/发布:判「已经是当前版本」看的是版本戳,不是 current 指针", async () => {
  // 指针与运行中的进程对不上时(有人换了链接却没重启、或 crash-loop 卡在旧代码上),
  // 重新部署一次**恰恰是修复手段**。按指针拒绝会把这条修复路径堵死。
  await withControl(async (ctl, spawned, releasesDir) => {
    makePrepared(releasesDir, SHA_A);
    symlinkSync(SHA_A, join(releasesDir, "current")); // 指针已经指过去了
    const msg = await ctl.requestDeploy(SHA_A.slice(0, 7), "wechat:a:u");
    assert.match(msg, /已提交部署/, "跑的还是别的版本,这次部署必须放行");
    assert.deepEqual(spawned(), [["deploy", SHA_A, "--requested-by", "wechat:a:u"]]);
  }, SHA_B); // 进程实际跑的是另一份
});

/**
 * 起 deployer 这一下。
 *
 * 这几条钉的是一个真机上花了两小时才查出来的故障:`/发布` 回了"已提交部署",
 * 而 deployer 在第一道检查上就 exit 1 —— 错误全丢进 `stdio: "ignore"`,
 * 容器没起、报告没变、日志一片安静,看上去就是"发布了,然后什么都没发生"。
 * "spawn 成功"从来不等于"起来了"。
 */
function withScript(body: string, fn: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "catman-spawn-"));
  const path = join(dir, "runner.sh");
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return fn(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("起 deployer:脚本当场 exit 1 必须抛出去,而不是当成起来了", async () => {
  await withScript('echo "部署机制还没固化" >&2\nexit 1', async (path) => {
    await assert.rejects(
      () => defaultSpawnRunner(path, ["deploy", "abc1234"]),
      /退出码 1/,
      "非零退出被当成了成功 —— 用户会收到一句假的「已提交部署」",
    );
  });
});

test("起 deployer:失败时把 stderr 带上,否则人只知道「没起来」查不出为什么", async () => {
  await withScript('echo "宿主路径在容器内解不开" >&2\nexit 1', async (path) => {
    await assert.rejects(() => defaultSpawnRunner(path, []), /宿主路径在容器内解不开/);
  });
});

test("起 deployer:一句话都没有的失败也要说清是「没有任何输出」", async () => {
  // 空错误信息比错误信息本身更误导 —— 人会以为是自己没看见。
  await withScript("exit 3", async (path) => {
    await assert.rejects(() => defaultSpawnRunner(path, []), /退出码 3.*没有任何输出/s);
  });
});

test("起 deployer:正常起来了就放手,不等它跑完", async () => {
  // deployer 的第一件事是停掉 catman 自己,等它跑完等的是自己的死。
  // 真实脚本 `exec docker run -d` 会秒回 0,这里同构。
  await withScript("exit 0", async (path) => {
    await defaultSpawnRunner(path, ["deploy", "abc1234"]);
  });
});

test("起 deployer:脚本一直跑着也不能卡住调用方", async () => {
  // 窗口内没死就认为它越过了那些当场失败的检查。卡住的后果是整个网关停在这里。
  await withScript("sleep 30", async (path) => {
    await defaultSpawnRunner(path, []);
  });
});

test("起 deployer:脚本根本不存在时抛 spawn 错误", async () => {
  await assert.rejects(() => defaultSpawnRunner("/nonexistent/deployer-run.sh", []));
});
