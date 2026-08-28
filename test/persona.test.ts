import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  adminBaseline,
  initialSharedClaudeMd,
  personaBriefing,
} from "../src/core/persona.js";
import { canonicalOf } from "../src/core/commands.js";

/**
 * 「守护人格知不知道自己是守护人格」。
 *
 * 真机上它不知道:管理员发 `/救援` 切过去,它张口就说"我现在跟你对话的就是主人格
 * 本身"。三处身份来源当时全是人格无关的 —— preset 系统提示词一模一样、skill 是同一套、
 * 而人设 CLAUDE.md 在它的命名空间下压根不存在。这组用例钉住修复的每一半。
 */

test("两个人格的自述必须不同 —— 这是整条修复的根", () => {
  // 拆掉 persona.ts 里那个三元就红。看起来平凡,但它替换掉的正是"两边完全一样"。
  assert.notEqual(personaBriefing("rescue"), personaBriefing("primary"));
});

test("守护人格的自述说清它不是主人格", () => {
  const b = personaBriefing("rescue");
  assert.match(b, /守护人格/);
  assert.match(b, /不是主人格/);
});

test("守护人格的自述逐条挡住它做得到但不该做的事", () => {
  // 泛泛一句"你是守护人格"挡不住一个手上有 bypassPermissions 的 agent。
  // 每一条都对应一个具体动作,少一条就是一条真实的越界路径。
  const b = personaBriefing("rescue");
  assert.match(b, /不改代码/, "改了也上不了线,而人正在等它诊断");
  assert.match(b, /只读/, "主 /data 是只读挂载,尝试写只会误导人");
  assert.match(b, /符号链接/, "换指针要先停容器,而它就跑在容器里");
  assert.match(b, /看不到/, "会话不通 —— 不说清它会假装记得跟主人格聊过什么");
});

test("主人格的自述里有守护人格这条出路", () => {
  // 不是对称好看:用户抱怨"你刚才卡住了"时,主人格得给得出 /救援。
  const b = personaBriefing("primary");
  assert.match(b, /主人格/);
  assert.ok(b.includes(canonicalOf("rescue")));
});

test("两份自述里的指令写法都从 COMMAND_TABLE 取", () => {
  // 手写字面量的话,指令改名之后人格会教出一条不存在的指令 ——
  // 而用户照着发,信使不认识,那句话就当普通消息进了 LLM。
  for (const p of ["primary", "rescue"] as const) {
    const b = personaBriefing(p);
    assert.ok(
      b.includes(canonicalOf("rescue")) || b.includes(canonicalOf("primaryPersona")),
      `${p} 的自述里至少要出现一条人格切换指令`,
    );
  }
  assert.ok(personaBriefing("rescue").includes(canonicalOf("primaryPersona")), "要提醒切回去");
});

test("自述短 —— 它每回合都要付钱", () => {
  // 细节交给按需加载的 catman-rescue skill。这个上限没有魔力,
  // 它拦的是"顺手往系统提示词里再塞一段"这种渐变。
  for (const p of ["primary", "rescue"] as const) {
    assert.ok(personaBriefing(p).length < 1200, `${p} 的自述超过 1200 字符了`);
  }
});

test("自述真的接到了 SDK 的 systemPrompt 上", () => {
  // 结构性断言。agent.ts 直接 import SDK 的 query,注入不进去 ——
  // 而"注释里写的不变量不等于代码里有"是这个仓库反复踩到的坑(IPC secret 的
  // childEnv 剔除、守护人格状态页的启动顺序,都是先有注释后有实现)。
  // 与其让这条只活在注释里,不如让删掉 append 这一行的人当场变红。
  const src = readFileSync(
    fileURLToPath(new URL("../src/core/agent.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    src,
    /systemPrompt:\s*\{[^}]*preset:\s*"claude_code"[^}]*append:\s*personaBriefing\(/s,
    "systemPrompt 里必须带 append: personaBriefing(...)",
  );
});

test("共享人设占位分人格,且守护人格那份说清身份归系统提示词管", () => {
  // 它只是让每用户 CLAUDE.md 首行的 `@../CLAUDE.md` 不悬空。人能改它,
  // 所以不能让人误以为在这里改一句就能把身份改掉。
  const r = initialSharedClaudeMd("rescue");
  assert.match(r, /守护人格/);
  assert.match(r, /系统提示词/);
  assert.notEqual(r, initialSharedClaudeMd("primary"));
});

// --- 管理员名单的 env 基线 ---

test("守护人格从主 settings.json 继承管理员名单", () => {
  // 不继承的话,管理员一发 /救援 就变成普通用户:catman-rescue 看不到、
  // 部署指令当不认识 —— 而诊断与恢复恰好全是管理员的活。
  const r = adminBaseline("rescue", [], { adminUserKeys: ["wechat:a:bob"] });
  assert.deepEqual(r.keys, ["wechat:a:bob"]);
  assert.equal(r.source, "inherited");
});

test("显式 env 赢过继承 —— 它是排查时唯一的旋钮", () => {
  const r = adminBaseline("rescue", ["wechat:a:me"], { adminUserKeys: ["wechat:a:bob"] });
  assert.deepEqual(r.keys, ["wechat:a:me"]);
  assert.equal(r.source, "explicit");
});

test("主人格不继承 —— 那是恒等操作,写成无条件会抹掉两个人格的区别", () => {
  const r = adminBaseline("primary", [], { adminUserKeys: ["wechat:a:bob"] });
  assert.deepEqual(r.keys, []);
});

test("主 settings.json 读不懂就当空,绝不抛", () => {
  // 守护人格起不来,比它少一个管理员糟得多 —— 与 settings 层
  // "兜底优先于交叉校验"是同一条。
  for (const bad of [undefined, null, "", 42, [], { adminUserKeys: "not-an-array" }]) {
    const r = adminBaseline("rescue", [], bad);
    assert.deepEqual(r.keys, [], `${JSON.stringify(bad)} 应该当空`);
    assert.equal(r.source, "empty");
  }
  // 数组里混进非字符串也只丢那一个。
  assert.deepEqual(adminBaseline("rescue", [], { adminUserKeys: ["a:b:c", 7, null] }).keys, [
    "a:b:c",
  ]);
});

test("共享 CLAUDE.md:主人格那份带省内存指引", () => {
  const s = initialSharedClaudeMd("primary");
  assert.match(s, /## 省内存地写命令/);
  // 具体上限不在这里写死 —— 它由系统提示词按实际装配给出。这份是人手可改的文件,
  // 在这里写"700m"会在改了 compose 之后变成一句假话,而没人会想起来同步它。
  assert.doesNotMatch(s, /700m/);
});

/**
 * 这条约定要**跟着代码走到新部署上**,而不是只留在这台机器的 CLAUDE.md 里。
 * 聊天客户端按 markdown 渲染,裸贴日志会糊成一坨 —— 本机 2026-08-28 踩过一次
 * (长任务通知),换台机器部署的人不该再踩一遍。
 */
test("共享 CLAUDE.md:两个人格都交代「发出去的文字是 markdown」", () => {
  assert.match(initialSharedClaudeMd("primary"), /markdown/);
  assert.match(initialSharedClaudeMd("primary"), /围栏/);
  // 守护人格的活儿就是贴日志报状态,更需要这条。
  assert.match(initialSharedClaudeMd("rescue"), /代码围栏/);
});

test("共享 CLAUDE.md:守护人格那份不带 —— 它不干重活,那份刻意只写风格", () => {
  assert.doesNotMatch(initialSharedClaudeMd("rescue"), /省内存/);
});
