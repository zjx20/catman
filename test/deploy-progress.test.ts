import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeployProgressLog,
  DEPLOY_PROGRESS_SCHEMA,
  formatDeployProgress,
  parseDeployProgress,
  readProgressLog,
  type DeployProgress,
} from "../src/core/deploy-progress.js";

const GOOD = {
  schema: DEPLOY_PROGRESS_SCHEMA,
  id: "run1-switched",
  stage: "switched",
  sha: "abc1234567890",
  at: "2026-08-10T14:20:00.000Z",
  detail: "接下来是 1800s 观察期。",
  ok: true,
  requestedBy: "wechat:acc:u1",
};

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "catman-progress-"));
  dirs.push(d);
  return d;
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("完整里程碑原样解析", () => {
  const p = parseDeployProgress(GOOD);
  assert.equal(p?.id, "run1-switched");
  assert.equal(p?.stage, "switched");
  assert.equal(p?.requestedBy, "wechat:acc:u1");
  assert.equal(p?.ok, true);
});

// 与部署报告同一条纪律:**读不懂的等于没有**。读取端一崩,整条播报链就没了,
// 而它恰恰是"部署到底怎么样了"的唯一出口。
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
    { ...GOOD, sha: "" },
    { ...GOOD, stage: "未来才有的阶段" },
    { ...GOOD, stage: 3 },
  ]) {
    assert.equal(parseDeployProgress(bad), undefined, JSON.stringify(bad));
  }
});

test("未来版本多出来的字段不影响解析 —— 字段只增不改,旧读者要能读新记录", () => {
  const p = parseDeployProgress({ ...GOOD, schema: 99, 未来字段: { a: 1 } });
  assert.equal(p?.id, "run1-switched");
  assert.equal(p?.schema, 99);
});

test("ok 缺失按成功读 —— 里程碑本就只在成功时写,false 是后加的例外", () => {
  const { ok: _drop, ...noOk } = GOOD;
  assert.equal(parseDeployProgress(noOk)?.ok, true);
  assert.equal(parseDeployProgress({ ...GOOD, ok: false })?.ok, false);
});

test("坏行只丢它自己 —— 一条写了一半的记录不该让前面几条一起消失", () => {
  const file = join(tmp(), "progress.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({ ...GOOD, id: "a" }),
      "{半条 JSON",
      "",
      JSON.stringify({ ...GOOD, id: "b", stage: "stable" }),
      // 写到一半就被杀掉的最后一行:没有换行符,而且 JSON 不完整。
      '{"id":"c","stage":"pu',
    ].join("\n"),
  );
  assert.deepEqual(
    readProgressLog(file).map((p) => p.id),
    ["a", "b"],
  );
});

test("文件不存在时读出空清单 —— 这台机器的 deployer 还不会写进度是常态", () => {
  assert.deepEqual(readProgressLog(join(tmp(), "没有这个文件.jsonl")), []);
});

test("三个阶段各说各的话,推失败与推成功不能长得一样", () => {
  const of = (over: Partial<DeployProgress>): string =>
    formatDeployProgress(parseDeployProgress({ ...GOOD, ...over })!);
  assert.match(of({ stage: "switched" }), /已切到/);
  assert.match(of({ stage: "stable" }), /观察期通过/);
  assert.match(of({ stage: "pushed" }), /已推送到远端/);
  assert.match(of({ stage: "pushed", ok: false }), /没能推上远端/);
});

test("播报记账:标记过的不再是待播,没标记的照旧待播", () => {
  const dir = tmp();
  const file = join(dir, "progress.jsonl");
  const seen = join(dir, "seen.json");
  const now = Date.parse(GOOD.at) + 1000;
  for (const id of ["a", "b"]) appendFileSync(file, `${JSON.stringify({ ...GOOD, id })}\n`);

  const log = new DeployProgressLog(file, seen);
  assert.deepEqual(
    log.pending(60_000, now).map((p) => p.id),
    ["a", "b"],
  );
  log.markAnnounced("a");
  assert.deepEqual(
    log.pending(60_000, now).map((p) => p.id),
    ["b"],
  );
  // 记账必须落盘:切换本身就会重启进程,只放内存的话"已切换"每次重启都再播一遍。
  assert.deepEqual(
    new DeployProgressLog(file, seen).pending(60_000, now).map((p) => p.id),
    ["b"],
  );
});

test("太老的里程碑不补播 —— 回退到旧版本时不该把几天前的进度当新消息", () => {
  const dir = tmp();
  const file = join(dir, "progress.jsonl");
  appendFileSync(file, `${JSON.stringify(GOOD)}\n`);
  appendFileSync(file, `${JSON.stringify({ ...GOOD, id: "无时间", at: "不是时间" })}\n`);

  const log = new DeployProgressLog(file, join(dir, "seen.json"));
  const now = Date.parse(GOOD.at) + 25 * 60 * 60 * 1000;
  assert.deepEqual(log.pending(24 * 60 * 60 * 1000, now), [], "超龄的与读不出时间的都不播");
});

test("记账文件坏掉时当作一条都没播过 —— 宁可重播,不可静默吞掉", () => {
  const dir = tmp();
  const file = join(dir, "progress.jsonl");
  const seen = join(dir, "seen.json");
  appendFileSync(file, `${JSON.stringify(GOOD)}\n`);
  writeFileSync(seen, "{不是 JSON");
  const now = Date.parse(GOOD.at) + 1000;
  assert.equal(new DeployProgressLog(file, seen).pending(60_000, now).length, 1);
});
