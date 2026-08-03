import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_TABLE,
  canonicalOf,
  commandHelpLines,
  parseCommand,
} from "../src/core/commands.js";

test("规范形式与别名都能识别", () => {
  assert.equal(parseCommand("/帮助")?.cmd.name, "help");
  assert.equal(parseCommand("/help")?.cmd.name, "help");
  assert.equal(parseCommand("/HELP")?.cmd.name, "help", "大小写不敏感");
  assert.equal(parseCommand("  /状态  ")?.cmd.name, "status", "前后空白无所谓");
  assert.equal(parseCommand("/new")?.cmd.name, "newSession");
  assert.equal(parseCommand("/cancel")?.cmd.name, "cancel");
  assert.equal(parseCommand("/继续")?.cmd.name, "continue");
});

test("带参指令:/切换会话 的三种形态", () => {
  // 不带参数 = 列出最近会话;带参数 = 切换。参数原样透传,由会话层解释。
  const bare = parseCommand("/切换会话");
  assert.equal(bare?.cmd.name, "switchSession");
  assert.equal(bare?.arg, "");

  const withArg = parseCommand("/切换会话 abcd1234");
  assert.equal(withArg?.cmd.name, "switchSession");
  assert.equal(withArg?.arg, "abcd1234");

  const alias = parseCommand("  /SWITCH   AbCd  ");
  assert.equal(alias?.cmd.name, "switchSession", "别名也支持带参形式");
  assert.equal(alias?.arg, "AbCd", "参数不动大小写,前后空白剔除");
});

test("带参形式只对 takesArg 指令开口:/帮助 一下 仍然不是指令", () => {
  for (const text of ["/帮助 一下", "/继续 聊", "/cancel now", "/新会话 开一个"]) {
    assert.equal(parseCommand(text), undefined, `${text} 不该被当成指令`);
  }
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

test("改会话状态的指令一律走队列,只读/中断的才 immediate", () => {
  // 分界线是"会不会改会话状态"。改状态的必须在分拣节点里与消息投递保持先后 ——
  // 就地执行会与投递并发,那句话就落到谁也说不清的会话里。走队列不再意味着
  // "卡在回合后面":分拣节点投递完就返回,不等回合(gateway.test 守着这半句)。
  const queued: string[] = ["continue", "switchSession", "newSession"];
  for (const cmd of COMMAND_TABLE) {
    assert.equal(cmd.immediate, !queued.includes(cmd.name), `${cmd.canonical} 的 immediate 不对`);
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
