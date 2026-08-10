import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THRESHOLDS,
  decide,
  type ContainerState,
  type WatchdogObservation,
} from "../src/rescue/watchdog.js";

/**
 * 看门狗的决策表。
 *
 * 它是这套系统里最危险的自动动作(在没有人的情况下换掉线上版本),所以每条规则
 * 逐条钉死。判错的看门狗比没有看门狗糟:它会在系统健康时反复回退,
 * 把一次小抖动放大成"版本一直在变"。
 */

const NOW = 10_000_000;

const OK: ContainerState = { running: true, restarts: 0, since: NOW - 3_600_000 };
const CRASHING: ContainerState = { running: false, restarts: 5, since: NOW - 60_000 };

function obs(over: Partial<WatchdogObservation> = {}): WatchdogObservation {
  return {
    primary: OK,
    courier: OK,
    currentIsStable: true,
    remainingHistory: 2,
    demotedSteps: 0,
    ...over,
  };
}

test("一切正常时什么都不做", () => {
  assert.equal(decide(obs(), NOW).kind, "none");
});

test("**锁还活着就只观测** —— 双头决策互踩是评审确认的死法", () => {
  // deployer 部署期间会停容器、换链接、再起,那些在看门狗眼里与故障完全同形。
  const a = decide(obs({ primary: CRASHING, lockHeartbeatAt: NOW - 60_000 }), NOW);
  assert.equal(a.kind, "none");
  assert.match(a.why, /部署锁/);
});

test("锁的心跳停了超过阈值才算 deployer 死了", () => {
  const stale = NOW - DEFAULT_THRESHOLDS.lockStaleMs - 1;
  assert.equal(decide(obs({ primary: CRASHING, lockHeartbeatAt: stale }), NOW).kind, "demote");
});

test("锁的超时阈值必须**大于观察期上限** —— 否则会在部署成功的中途把版本拨回去", () => {
  // 观察期是 30 分钟(CATMAN_BAKE_SECONDS 默认 1800)。阈值小于它的话,
  // 一次完全正常的长观察期会被判成"deployer 死了"。
  assert.ok(
    DEFAULT_THRESHOLDS.lockStaleMs > 30 * 60_000,
    "阈值不能小于观察期上限,否则看门狗会打断成功的部署",
  );
});

test("信使崩了优先处理 —— 它死了两个人格一起聋", () => {
  const a = decide(obs({ courier: CRASHING, primary: CRASHING }), NOW);
  assert.equal(a.kind, "courier-fallback");
});

test("主人格 crash-loop 就往回退一级", () => {
  const a = decide(obs({ primary: CRASHING }), NOW);
  assert.equal(a.kind, "demote");
  assert.equal(a.kind === "demote" && a.step, 1);
});

test("**每一级只退一次**:退过之后再崩,退的是下一级", () => {
  // 对同一级反复重试在日志上看起来像"一直在恢复",实际是一直没恢复。
  const a = decide(obs({ primary: CRASHING, demotedSteps: 1, remainingHistory: 3 }), NOW);
  assert.equal(a.kind === "demote" && a.step, 2);
});

test("没有更旧的已验证版本时只报警,绝不乱动", () => {
  const a = decide(obs({ primary: CRASHING, remainingHistory: 1, demotedSteps: 1 }), NOW);
  assert.equal(a.kind, "alert");
  assert.match(a.why, /没有可退|环境问题/);
});

test("「干净地停着」单独成一条 —— 那是全灭里最安静的一种", () => {
  // deployer 死在 docker stop 与 start 之间时,容器是**正常退出**的:重启计数不涨、
  // 也没有 crash-loop,而没有人会再来拉起它。只看 crash-loop 的话它永远不会被发现。
  const stopped: ContainerState = {
    running: false,
    restarts: 0,
    since: NOW - DEFAULT_THRESHOLDS.cleanStoppedMs - 1,
  };
  const a = decide(obs({ primary: stopped }), NOW);
  assert.equal(a.kind, "demote");
  assert.match(a.why, /干净地停着/);
});

test("刚停下来还没到阈值时不动手 —— 正常重启也会短暂地停着", () => {
  const justStopped: ContainerState = { running: false, restarts: 0, since: NOW - 1000 };
  assert.equal(decide(obs({ primary: justStopped }), NOW).kind, "none");
});

test("决策不产出任何「动 stable」的动作 —— 指针单主", () => {
  // stable 只许 deployer 在观察期结束后前移。看门狗写它 = 把「回退目标」这个
  // 概念本身毁掉:下一次崩溃时它会把 current 拨到一个我们刚判定为坏的版本上。
  const cases: WatchdogObservation[] = [
    obs({ primary: CRASHING }),
    obs({ courier: CRASHING }),
    obs({ primary: CRASHING, demotedSteps: 5, remainingHistory: 1 }),
    obs({ primary: CRASHING, currentIsStable: false, demotedSteps: 1 }),
  ];
  for (const o of cases) {
    const a = decide(o, NOW);
    assert.ok(
      ["none", "alert", "demote", "courier-fallback"].includes(a.kind),
      `出现了预期之外的动作:${a.kind}`,
    );
    assert.equal(JSON.stringify(a).includes("stable"), false, "动作里不该出现 stable");
  }
});

test("每个动作都带 why —— 它会进日志与状态页,没有它就查不出为什么退版本", () => {
  for (const o of [obs(), obs({ primary: CRASHING }), obs({ courier: CRASHING })]) {
    assert.ok(decide(o, NOW).why.length > 0);
  }
});
