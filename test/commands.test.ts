import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_TABLE,
  canonicalOf,
  commandHelpLines,
  parseCommand,
} from "../src/core/commands.js";

test("规范形式与别名都能识别", () => {
  assert.equal(parseCommand("/帮助")?.name, "help");
  assert.equal(parseCommand("/help")?.name, "help");
  assert.equal(parseCommand("/HELP")?.name, "help", "大小写不敏感");
  assert.equal(parseCommand("  /状态  ")?.name, "status", "前后空白无所谓");
  assert.equal(parseCommand("/new")?.name, "newSession");
  assert.equal(parseCommand("/cancel")?.name, "cancel");
  assert.equal(parseCommand("/继续")?.name, "continue");
});

test("裸词一律不是指令 —— 形式统一,无例外", () => {
  // 这条守护的是「规则只有一条:以 / 开头」。别为了方便悄悄加回裸词别名:
  // 一旦有例外,用户就得开始猜哪句话会被后台截胡。
  for (const word of ["帮助", "help", "幫助", "继续", "繼續", "新会话", "取消", "状态", "clear"]) {
    assert.equal(parseCommand(word), undefined, `${word} 不该被当成指令`);
  }
});

test("必须整串匹配,正常说话不会被吞掉", () => {
  for (const text of ["/帮助 一下", "帮助我写个脚本", "继续帮我改", "先/取消再说", "//help"]) {
    assert.equal(parseCommand(text), undefined, `${text} 不该被当成指令`);
  }
});

test("只有 /继续 走队列,其余都绕过队列就地执行", () => {
  // immediate 是硬指令的存在理由(agent 卡死时队列里的消息轮不到),
  // 而 /继续 要驱动 LLM,必须走正常回合。
  for (const cmd of COMMAND_TABLE) {
    assert.equal(cmd.immediate, cmd.name !== "continue", `${cmd.canonical} 的 immediate 不对`);
  }
});

test("/继续 交给 LLM 的是「继续」而不是字面量斜杠形式", () => {
  const cmd = parseCommand("/继续")!;
  assert.equal(cmd.promptText, "继续");
});

test("immediate 指令不设 promptText(它们根本不进 LLM)", () => {
  for (const cmd of COMMAND_TABLE) {
    if (cmd.immediate) assert.equal(cmd.promptText, undefined, cmd.canonical);
  }
});

test("每个指令的规范形式与别名都以 / 开头且互不冲突", () => {
  const seen = new Set<string>();
  for (const cmd of COMMAND_TABLE) {
    for (const token of [cmd.canonical, ...cmd.aliases]) {
      assert.ok(token.startsWith("/"), `${token} 必须以 / 开头`);
      const lower = token.toLowerCase();
      assert.equal(seen.has(lower), false, `${token} 与别的指令冲突`);
      seen.add(lower);
    }
  }
});

test("帮助文案覆盖全部指令 —— 它是唯一的发现入口", () => {
  const lines = commandHelpLines().join("\n");
  for (const cmd of COMMAND_TABLE) {
    assert.ok(lines.includes(cmd.canonical), `帮助里缺了 ${cmd.canonical}`);
    assert.ok(lines.includes(cmd.desc), `帮助里缺了 ${cmd.canonical} 的说明`);
  }
});

test("canonicalOf 让文案引用规范形式,不必手写字符串", () => {
  assert.equal(canonicalOf("continue"), "/继续");
  assert.equal(canonicalOf("newSession"), "/新会话");
  assert.throws(() => canonicalOf("nope" as never), /未知指令/);
});
