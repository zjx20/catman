import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPrepareReport, readPrepareTail } from "../src/core/prepare-report.js";

const SHA = "029e6bd384848987bfb1d98676b065ee5e5f3c99";
const LOG = "/data/execution/builds/123.log";

test("制备成功摘要保留真实测试结果和门禁修改，常规文件折叠并给出可复制发布指令", () => {
  const report = formatPrepareReport("完成", `# tests 1191\n# pass 1191\n# fail 0\nrelease ${SHA} 就位\nTier 1★ —— 触碰了门禁本体:\n  src/core/selfcheck.ts\n  test/selfcheck.test.ts\nTier 1 —— 常规改动:\n${Array.from({ length: 60 }, (_, i) => `  src/normal-${i}.ts\n`).join("")}[time] 确认发布\n${SHA}\n`, LOG);
  assert.match(report, /1191\/1191/);
  assert.match(report, /Tier 1★[^\n]*门禁[^\n]*selfcheck\.ts/);
  assert.match(report, /常规改动（60 个文件）/);
  assert.ok(!report.includes("normal-59"));
  assert.match(report, /\n\n```text\n\/发布 029e6bd\n```\n\n/);
  assert.ok(report.includes(LOG));
  assert.ok(report.length < 800);
});

test("制备报告不能吞掉 Tier 3 人工步骤，也不能为缓存复用虚构测试次数", () => {
  const text = formatPrepareReport("完成", `Tier 3 —— 流水线上不了线:\n  scripts/evolve/deployer.sh\n  docker/Dockerfile\n  → scripts/evolve/ 改了要重新跑 bless\nTier 2 —— 依赖变更:\n  package-lock.json\n${SHA}\n`, LOG);
  assert.match(text, /Tier 3[^\n]*人工[^\n]*deployer\.sh/);
  assert.match(text, /重新 bless/);
  assert.match(text, /重建镜像/);
  assert.match(text, /package-lock\.json/);
  assert.ok(!text.includes("测试"));
});

test("失败不建议发布；无候选 SHA 时引导查询，日志中的 Markdown 不能冲出诊断块", () => {
  const failure = formatPrepareReport("失败（1）", `error\n\`\`\`\n${SHA}\n`, LOG);
  assert.ok(!failure.includes("/发布"));
  assert.match(failure, /\n\n````text\nerror\n```/);
  assert.ok(!formatPrepareReport("完成", "unexpected output", LOG).includes("/发布"));
  assert.match(formatPrepareReport("完成", "unexpected output", LOG), /\/升级状态/);
});

test("读取超大制备日志只取有界末尾，丢弃首行片段并关闭文件", () => {
  const root = mkdtempSync(join(tmpdir(), "catman-prepare-report-"));
  try {
    const path = join(root, "build.log");
    writeFileSync(path, `${"中".repeat(100_000)}\nlast diagnostic\n${SHA}\n`);
    const tail = readPrepareTail(path, 100);
    assert.equal(tail, `last diagnostic\n${SHA}\n`);
    assert.ok(Buffer.byteLength(tail) <= 100);
    writeFileSync(path, "short log\n");
    assert.equal(readPrepareTail(path), readFileSync(path, "utf8"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
