import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCronDataDir } from "../src/core/cron-data.js";

const dirs: string[] = [];

test.after(() => {
  for (const d of dirs) {
    // 前面故意把父目录改成只读过,不还原就删不掉。
    try {
      chmodSync(d, 0o755);
    } catch {
      /* 已经没了或本来就可写 */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "catman-crondata-"));
  dirs.push(d);
  return d;
}

const mode = (p: string) => statSync(p).mode & 0o777;

test("主人格:目录建出来,而且权限真的是 0777", () => {
  const root = tmp();
  const target = join(root, "cron_data");
  ensureCronDataDir({ cronDataDir: target, persona: "primary" });
  assert.ok(statSync(target).isDirectory());
  // 只写 mkdirSync({mode:0o777}) 的话 umask(默认 022)会把它削成 0755,
  // 于是 script 类任务的容器写不进来 —— 这条用例盯的就是那次显式 chmod。
  assert.equal(mode(target), 0o777, `权限是 ${mode(target).toString(8)},被 umask 削掉了`);
});

test("目录已经在了也不报错,并且把被改歪的权限修回来", () => {
  const root = tmp();
  const target = join(root, "cron_data");
  mkdirSync(target);
  chmodSync(target, 0o700);
  ensureCronDataDir({ cronDataDir: target, persona: "primary" });
  assert.equal(mode(target), 0o777);
});

test("守护人格压根不建 —— 它的 /data 是只读的,建不出来是预期不是故障", () => {
  const root = tmp();
  const target = join(root, "cron_data");
  ensureCronDataDir({ cronDataDir: target, persona: "rescue" });
  assert.throws(() => statSync(target), /ENOENT/);
});

test("建不出来时不抛 —— 少个状态目录不该拖垮整个进程", () => {
  const root = tmp();
  chmodSync(root, 0o500); // 只读:里面建不了东西
  assert.doesNotThrow(() => {
    ensureCronDataDir({ cronDataDir: join(root, "cron_data"), persona: "primary" });
  });
});
