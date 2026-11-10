import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeNotifyBin, notifyBinBody } from "../src/core/notify-bin.js";

test("通知入口复用当前执行环境的任务客户端", () => {
  const body = notifyBinBody("http://control");
  assert.match(body, /task-cli\.js/);
  assert.doesNotMatch(body, /docker|nohup|setsid|CATMAN_HOST_DATA_DIR|\/data\/tmp/);
});
test("启动生成可执行入口，参数原样转交给任务客户端", () => {
  const root = mkdtempSync(join(tmpdir(), "catman-notify-"));
  try {
    const path = writeNotifyBin(root, "http://control");
    assert.ok(statSync(path).mode & 0o111);
    assert.match(readFileSync(path, "utf8"), /"\$@"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
