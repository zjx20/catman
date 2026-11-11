import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInstructions, verifyInstructionRequest } from "../src/core/execution/instruction-check.js";
import { personaBriefing } from "../src/core/persona.js";

test("实际请求检查拒绝缺层、串租户、错误人格和伪造在 metadata/tools 中的标记", () => {
  const fixture = { expected: { shared: "shared-probe", personal: "personal-probe", workspace: "workspace-probe" }, forbidden: { otherPersonal: "foreign-probe", control: "control-probe" } };
  const valid = { system: [{ type: "text", text: personaBriefing("primary") }], messages: [{ role: "user", content: Object.values(fixture.expected).join(" ") }] };
  verifyInstructionRequest(valid, fixture, "primary");
  for (const [layer, marker] of Object.entries(fixture.expected)) {
    const body = JSON.parse(JSON.stringify(valid).replace(marker, ""));
    body.metadata = { marker }; body.tools = [{ description: marker }];
    assert.throws(() => verifyInstructionRequest(body, fixture, "primary"), new RegExp(`指令未加载：${layer}`));
  }
  for (const [layer, marker] of Object.entries(fixture.forbidden)) {
    const body = structuredClone(valid); body.messages.push({ role: "user", content: marker });
    assert.throws(() => verifyInstructionRequest(body, fixture, "primary"), new RegExp(`指令越界加载：${layer}`));
  }
  assert.throws(() => verifyInstructionRequest(valid, fixture, "rescue"), /人格身份未加载/);
  assert.throws(() => verifyInstructionRequest({ messages: [...valid.messages, { role: "user", content: personaBriefing("primary") }] }, fixture, "primary"), /人格身份未加载/);
  assert.throws(() => verifyInstructionRequest(undefined, fixture, "primary"), /未捕获/);
});

for (const persona of ["primary", "rescue"] as const) {
  test(`真实 CLI 指令加载：${persona} 聊天/cron 三层指令与 owner/workspace 隔离`, { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "catman-instructions-"));
    try { await checkInstructions(root, persona, 15_000); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("真实 CLI 指令自检有硬超时，失败后退出而非等待本地端点", { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "catman-instructions-"));
  try { await assert.rejects(checkInstructions(root, "primary", 1), /指令自检超时/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
