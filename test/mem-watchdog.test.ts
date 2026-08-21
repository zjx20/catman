import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KILL_CONTAINER_RATIO,
  KILL_PROC_RATIO,
  VERIFY_GRACE_MS,
  WARN_RATIO,
  decideMemAction,
  killNoticeText,
  parseAnonBytes,
  parseOomKills,
  warnText,
  type MemObservation,
} from "../src/core/mem-watchdog.js";

/**
 * 内存看门狗的决策表。
 *
 * 这组用例的分量在于:看门狗会在没有人的情况下杀掉用户正在跑的回合。误杀一次,
 * 人就再也不敢把长活交给它 —— 所以每一档、每一条升级路径都得钉死,而不是
 * "跑起来看着对"。
 */

const base: MemObservation = {
  anonBytes: 0,
  limitBytes: 700 * 1024 * 1024,
  kernelOomKills: 0,
  warned: false,
  procKilled: false,
  msSinceProcKill: 0,
};

/** 按占比造一个观测,免得每条用例都手算字节数。 */
const at = (ratio: number, over: Partial<MemObservation> = {}): MemObservation => ({
  ...base,
  ...over,
  anonBytes: Math.round(base.limitBytes * ratio),
});

test("没设上限时一律放行 —— 不能拿 0 去除", () => {
  // 挂载没生效、或者容器没加 --memory 时会走到这里。看门狗必须安静地不作为,
  // 而不是算出 Infinity 然后把每个回合都杀掉。
  const a = decideMemAction({ ...at(0.99), limitBytes: 0 });
  assert.equal(a.kind, "none");
});

test("低水位不做任何事", () => {
  assert.equal(decideMemAction(at(0.5)).kind, "none");
  assert.equal(decideMemAction(at(WARN_RATIO - 0.01)).kind, "none");
});

test("80% 喂警告,而且只喂一次", () => {
  const first = decideMemAction(at(WARN_RATIO));
  assert.equal(first.kind, "warn");
  // 喂第二遍只会占上下文,不会更有用 —— 而且会把真正的进展消息挤出去。
  assert.equal(decideMemAction(at(WARN_RATIO, { warned: true })).kind, "none");
});

test("90% 杀掉那条命令 —— 这是唯一能保住回合的一级", () => {
  const a = decideMemAction(at(KILL_PROC_RATIO));
  assert.equal(a.kind, "kill-process");
});

test("杀过进程之后,宽限期内先观望", () => {
  const a = decideMemAction(
    at(KILL_PROC_RATIO, { procKilled: true, msSinceProcKill: VERIFY_GRACE_MS - 1 }),
  );
  assert.equal(a.kind, "none");
});

test("杀了进程但内存没降下来 → 升级到有保证的那一级", () => {
  // 这条是整个设计的承重件:"发出动作"不等于"内存回来了"。被杀的可能是孙进程,
  // 也可能杀错了对象。没有这条复查升级,内存会一直卡在 92% 不上不下,
  // 而看门狗以为自己已经处理过了。
  const a = decideMemAction(
    at(KILL_PROC_RATIO, { procKilled: true, msSinceProcKill: VERIFY_GRACE_MS }),
  );
  assert.equal(a.kind, "kill-container");
  assert.equal(a.kind === "kill-container" && a.reason, "no-relief");
});

test("95% 直接杀容器", () => {
  const a = decideMemAction(at(KILL_CONTAINER_RATIO));
  assert.equal(a.kind, "kill-container");
  assert.equal(a.kind === "kill-container" && a.reason, "threshold");
});

test("内核抢先开火时,不抢救、直接收场", () => {
  // 分配够快的话,两次采样之间就能从 90% 冲过上限,内核的 cgroup OOM killer
  // 先动手。它杀掉的可能正好是大脑本身 —— 容器状态从此不可信,
  // 这时候试图"保住回合"是在一个已经烂掉的现场上做手术。
  const a = decideMemAction(at(0.5, { kernelOomKills: 1 }));
  assert.equal(a.kind, "kill-container");
  assert.equal(a.kind === "kill-container" && a.reason, "kernel-oom");
});

test("内核开火的优先级高于其它所有档", () => {
  const a = decideMemAction(at(0.99, { kernelOomKills: 2 }));
  assert.equal(a.kind === "kill-container" && a.reason, "kernel-oom");
});

test("parseAnonBytes 取的是 anon,不是 file", () => {
  // 盯错字段是这套东西最容易犯、也最没有症状的错:memory.current 里一半是
  // 可回收的 page cache,盯它会让每个读大文件的会话都被误杀。
  const stat = ["anon 123456", "file 999999999", "kernel 4096"].join("\n");
  assert.equal(parseAnonBytes(stat), 123456);
});

test("anon 字段缺失时返回 undefined,而不是 0", () => {
  // 返回 0 会让看门狗永远不开火,而且毫无症状 —— 那比误杀更难发现。
  assert.equal(parseAnonBytes("file 100\nkernel 200"), undefined);
  assert.equal(parseAnonBytes("anon 不是数字"), undefined);
});

test("parseOomKills 读得出内核开火次数,读不到按 0 算", () => {
  assert.equal(parseOomKills("low 0\nhigh 0\nmax 3\noom 1\noom_kill 2"), 2);
  assert.equal(parseOomKills("low 0\nhigh 0"), 0);
});

test("警告文案带上「正在跑哪一步」", () => {
  // 只说"内存紧张"的话,大脑不知道是哪一步惹的祸,只能瞎猜着改。
  const t = warnText(0.82, "700m", "Bash: grep -o 大文件");
  assert.match(t, /82%/);
  assert.match(t, /700m/);
  assert.match(t, /grep -o 大文件/);
});

test("击杀通知说清 137 的含义,并明确禁止原样重试", () => {
  // 光看到工具失败,大脑多半会当成命令写错了然后重试 —— 于是再死一次。
  const t = killNoticeText(0.91, "grep");
  assert.match(t, /137/);
  assert.match(t, /不要原样重试/);
});

test("击杀通知用「正在杀掉」而不是「已杀掉」", () => {
  // 先喂消息后动手,那一刀可能没杀成(进程刚好自己退了)。
  // 说过头就成了假消息,而大脑没法验证它。
  assert.match(killNoticeText(0.91, undefined), /正在杀掉/);
  assert.doesNotMatch(killNoticeText(0.91, undefined), /已杀掉/);
});
