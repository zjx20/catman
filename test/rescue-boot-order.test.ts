import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 守护人格的**启动顺序**。
 *
 * 「失败域诚实条款」:磁盘满 / 内存尽 / token 过期这三样同样会废掉救援大脑 ——
 * 而那正是最需要看门狗与状态页的时候。所以机械层必须在装配**之前**起来,
 * 并且装配失败时它不能跟着一起死。
 *
 * 这条只能按**源码顺序**验:真跑一遍要造出"磁盘满"。用文本位置验很粗糙,
 * 但它钉住的正是那个会被顺手改掉的东西 —— 有人往 main() 上半部分加一行写盘,
 * 或者把 rescue 那段挪回后面,这条就红。
 *
 * 它替代不了真机演练;演练第 ⑤ 项才是真的验它。
 */

const INDEX = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), "..", "src"), "index.ts"),
  "utf8",
);

test("机械层在任何写盘动作之前起来 —— 否则「大脑起不来时它还在」只是一句注释", () => {
  const rescueStart = INDEX.indexOf("rescueRef.start()");
  assert.ok(rescueStart > 0, "找不到机械层的启动点");
  for (const later of ["mkdirSync(config.workspaceDir", "writeSkills(", "dashboard.start()"]) {
    const at = INDEX.indexOf(later);
    assert.ok(at > 0, `找不到 ${later}`);
    assert.ok(
      rescueStart < at,
      `机械层必须排在 ${later} 之前 —— 它是为"那些动作失败了"准备的`,
    );
  }
});

test("机械层自带 try/catch —— 它起不来不该拖垮别的", () => {
  const seg = INDEX.slice(INDEX.indexOf("if (config.persona === \"rescue\")"), INDEX.indexOf("// 让 Agent SDK"));
  assert.ok(seg.includes("try {") && seg.includes("catch"), "机械层没有自己的 try/catch");
});

test("装配失败时守护人格**不退出** —— 退出等于把最后一道防线一起关掉", () => {
  const tail = INDEX.slice(INDEX.indexOf("main().catch("));
  assert.match(tail, /CATMAN_PERSONA.*rescue/s, "没有对守护人格分流");
  const branch = tail.slice(tail.indexOf("rescue"));
  const returnAt = branch.indexOf("return;");
  const exitAt = branch.indexOf("process.exit(1)");
  assert.ok(returnAt > 0 && returnAt < exitAt, "守护人格分支必须 return 而不是 exit");
});

test("守护人格**不生成**令牌 —— 两份令牌意味着出事时人要先想是哪一份", () => {
  const fn = INDEX.slice(INDEX.indexOf("function rescueToken("), INDEX.indexOf("function resolveAdminToken("));
  assert.equal(fn.includes("writeFileSync"), false, "rescueToken 里不该有写盘");
  assert.ok(fn.includes("mainDataDir"), "该去读主 /data 那一份");
});
