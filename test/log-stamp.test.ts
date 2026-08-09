import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStamp, installLogStamps, redirectConsoleToStderr } from "../src/core/log-stamp.js";

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

/**
 * console 改道。自检模式把 stdout 当**结果通道**(只有一行 JSON,deployer 解析它
 * 决定这份 release 上不上线),而 log/info/debug 在 Node 里默认就写 stdout ——
 * 漏一行进去,好版本会被判成"自检没过"。
 */

function collectingConsole(): { fake: Record<string, unknown>; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const fake: Record<string, unknown> = {
    log: (...a: unknown[]) => out.push(a.join(" ")),
    info: (...a: unknown[]) => out.push(a.join(" ")),
    debug: (...a: unknown[]) => out.push(a.join(" ")),
    warn: (...a: unknown[]) => err.push(a.join(" ")),
    error: (...a: unknown[]) => err.push(a.join(" ")),
  };
  return { fake, out, err };
}

test("redirectConsoleToStderr:走 stdout 的那几档全部改道,stdout 一个字都不剩", () => {
  const { fake, out, err } = collectingConsole();
  redirectConsoleToStderr(fake);
  for (const level of ["log", "info", "debug", "warn", "error"]) {
    (fake[level] as (...a: unknown[]) => void)(`来自 ${level}`);
  }
  assert.deepEqual(out, [], `stdout 必须是空的,实际:${JSON.stringify(out)}`);
  assert.equal(err.length, 5, "五档输出一条不少,只是都去了 stderr");
});

test("redirectConsoleToStderr:与时间戳共存,不叠出两个前缀", () => {
  // 两者在入口先后调用,顺序将来可能变 —— 无论谁先,时间戳都只该有一个:
  // 叠两层的日志既难读,也会让"按前缀切分"的排查脚本错位。
  for (const order of ["stamp-first", "redirect-first"] as const) {
    const { fake, out, err } = collectingConsole();
    if (order === "stamp-first") {
      installLogStamps(fake, () => new Date(2026, 7, 1, 9, 5, 3, 7));
      redirectConsoleToStderr(fake);
    } else {
      redirectConsoleToStderr(fake);
      installLogStamps(fake, () => new Date(2026, 7, 1, 9, 5, 3, 7));
    }
    (fake["info"] as (...a: unknown[]) => void)("一句话");
    assert.deepEqual(out, [], `${order}:stdout 必须是空的`);
    assert.deepEqual(err, ["08-01 09:05:03.007 一句话"], `${order}:前缀该正好一个`);
  }
});
