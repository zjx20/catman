import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStamp, installLogStamps } from "../src/core/log-stamp.js";

/**
 * 日志时间戳。它存在的唯一理由是**对账** —— 一条发送失败要能和前后的日志
 * 对上时刻,才看得出中间过了多久。所以这里守两条:格式稳定、不重复安装。
 */

test("formatStamp:MM-DD HH:mm:ss.SSS,各段都补零", () => {
  // 本地时间(跟随 TZ),所以用本地构造函数造这个时刻,避免测试随时区飘。
  const d = new Date(2026, 7, 1, 9, 5, 3, 7); // 8 月 1 日 09:05:03.007
  assert.equal(formatStamp(d), "08-01 09:05:03.007");
});

test("installLogStamps:给各级输出加前缀,且重复安装不会叠出两个", () => {
  const lines: unknown[][] = [];
  const fake: Record<string, unknown> = {
    log: (...a: unknown[]) => lines.push(a),
    info: (...a: unknown[]) => lines.push(a),
    warn: (...a: unknown[]) => lines.push(a),
    error: (...a: unknown[]) => lines.push(a),
    debug: (...a: unknown[]) => lines.push(a),
  };
  const at = new Date(2026, 7, 1, 9, 5, 3, 7);

  installLogStamps(fake, () => at);
  // 第二次安装必须是空操作:叠一层就会打出两个时间戳,而它是在入口调用的,
  // 将来多一条调用路径(测试、脚本)就会踩到。
  installLogStamps(fake, () => at);

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    (fake[level] as (...a: unknown[]) => void)(`来自 ${level}`);
  }

  assert.equal(lines.length, 5);
  for (const args of lines) {
    assert.equal(args[0], "08-01 09:05:03.007", `前缀不对:${JSON.stringify(args)}`);
    assert.equal(args.length, 2, `不该多出一层前缀:${JSON.stringify(args)}`);
  }
});

test("installLogStamps:非函数成员不动,原样保留", () => {
  const fake: Record<string, unknown> = { log: () => {}, notAFunction: 42 };
  installLogStamps(fake, () => new Date(2026, 0, 1));
  assert.equal(fake.notAFunction, 42);
});
