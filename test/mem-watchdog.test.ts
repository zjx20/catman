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
  abortNoticeText,
  memAbortError,
  readMemAbort,
  priorAbortPrefix,
  userNoticeText,
  type MemObservation,
  incidentLine,
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

/**
 * 中止文案。真机演练时管理员看到的是光秃秃一句「已中断这一轮。」——
 * 分不清是自己按了取消、还是超时、还是内存看门狗动的手,而这几种该做的事完全不同。
 */
test("内存中止:说清死因、点名哪一步、并劝阻原样重发", () => {
  const t = abortNoticeText({
    reason: "threshold", step: "Bash: grep 大文件", pct: 97, limit: "700m",
  });
  assert.match(t, /内存/);
  assert.match(t, /grep 大文件/);          // 点名哪一步
  assert.match(t, /重发/);                  // 默认反应"再发一遍"恰恰是错的
  assert.match(t, /会话没丢/);              // 否则用户会重开会话,那才真丢上下文
});

test("用户主动取消:不该说得像出了故障", () => {
  const t = abortNoticeText(undefined);
  assert.match(t, /按你的要求/);
  assert.doesNotMatch(t, /内存/);
  assert.match(t, /会话没丢/);
});

test("内核抢先开火那种,措辞要跟阈值中止分得开", () => {
  const t = abortNoticeText({ reason: "kernel-oom", step: undefined, pct: 100, limit: "700m" });
  assert.match(t, /内核/);
  assert.match(t, /会话没丢/);
});

test("每一种中止都必须带「接下来怎么办」", () => {
  // 这条是管理员特意补的:不说这句,用户看到"已中断"会以为整段对话废了,
  // 于是重开一个会话 —— 而那才是真的把上下文丢了。
  for (const mem of [
    undefined,
    { reason: "threshold" as const, step: "X", pct: 96, limit: "700m" },
    { reason: "kernel-oom" as const, step: undefined, pct: 100, limit: "700m" },
    { reason: "no-relief" as const, step: "Y", pct: 93, limit: "700m" },
  ]) {
    assert.match(abortNoticeText(mem), /接着说/, `这一种没说清接下来怎么办`);
  }
});

test("中止凭据能被认出来,而普通错误认不出", () => {
  // 网关靠它分岔。认错的后果是把内存中止说成"你取消了",用户会直接重发再死一次。
  const info = { reason: "threshold" as const, step: "X", pct: 96, limit: "700m" };
  assert.deepEqual(readMemAbort(memAbortError(info)), info);
  assert.equal(readMemAbort(new Error("别的错")), undefined);
  assert.equal(readMemAbort(undefined), undefined);
  assert.equal(readMemAbort("字符串"), undefined);
});

test("给用户的提示跟喂给大脑的那条不是一回事", () => {
  // 大脑要的是"该怎么改",用户要的是"发生了什么、要不要管"。
  const u = userNoticeText("warn", 81);
  assert.match(u, /81%/);
  assert.match(u, /回合继续/);              // 让用户安心,不必插手
  assert.doesNotMatch(u, /流式管道/);        // 那是给大脑的操作建议,用户不关心
});

test("前情注入:说清上一回合怎么死的,并点名那个悬空的工具调用", () => {
  // 被硬杀之后 transcript 末尾留下一个有调用、没结果的 tool_use。resume 上去的
  // 大脑看到的是一个没有下文的调用 —— 而用户往往只回一句"继续"。
  // 没有这段前情,它大概率原样再撞一次。
  const p = priorAbortPrefix({ reason: "threshold", step: "Bash: grep 大文件", pct: 97, limit: "700m" });
  assert.match(p, /上一回合/);
  assert.match(p, /grep 大文件/);
  assert.match(p, /再死一次/);       // 话要说硬,不然"继续"两个字就把它带回坑里
  assert.ok(p.endsWith("\n\n"));     // 是前缀,后面要接用户原话
});

const INCIDENT = { reason: "threshold" as const, step: "Bash(grep …)", pct: 98, limit: "700m" };

test("incidentLine:一行制表符分隔,字段齐全", () => {
  const line = incidentLine("2026-08-21T10:00:00.000Z", "wechat:abc", INCIDENT, "docker");
  assert.equal(line.includes("\n"), false, "必须单行 —— 多行就没法 grep 了");
  assert.deepEqual(line.split("\t"), [
    "2026-08-21T10:00:00.000Z",
    "user=wechat:abc",
    "reason=threshold",
    "anon=98%",
    "limit=700m",
    "via=docker",
    "step=Bash(grep …)",
  ]);
});

test("incidentLine:step 缺失时留占位而不是空字段", () => {
  // 空字段会让列错位,而这份记录的全部用途就是几周后有人拿 awk 去读它。
  const line = incidentLine("t", "u", { ...INCIDENT, step: undefined }, "failed");
  assert.ok(line.endsWith("step=(未知)"));
});
