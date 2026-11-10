import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { opsRemoteCommand } from "../src/core/execution/ops-cli.js";

test("运维远端 argv 跨 shell 保留空参数、引号、换行与元字符，不执行参数中的命令", () => {
  const args = ["", "space here", "单引号'和双引号\"", "line1\nline2", "$(exit 91)", "`exit 92`", "; exit 93", "a && exit 94", "*", "$HOME", "\\", "--flag"];
  const command = opsRemoteCommand([process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...args]);
  const output = execFileSync("bash", ["-c", command], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), args);
  assert.throws(() => opsRemoteCommand([]));
  assert.throws(() => opsRemoteCommand(["echo", "bad\0argument"]));
});
