import { test } from "node:test";
import assert from "node:assert/strict";
import { codeBlock, inlineCode, splitMarkdown } from "../src/core/markdown.js";

test("日志中的代码围栏不能提前关闭外层日志块，路径中的反引号保持字面含义", () => {
  const log = "before\n```bash\nrm -rf example\n```\nafter";
  assert.equal(codeBlock(log), `\`\`\`\`text\n${log}\n\`\`\`\``);
  assert.equal(inlineCode("path`with`marks"), "``path`with`marks``");
  assert.equal(inlineCode("`boundary`"), "`` `boundary` ``");
});

test("长回复在段落处拆分，完整的发布命令块随同一条消息发送", () => {
  const command = codeBlock("/发布 029e6bd");
  const text = `${"说明".repeat(40)}\n\n${command}\n\n下一段。`;
  const chunks = splitMarkdown(text, 100);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.some(chunk => chunk.includes(command)));
  assert.ok(chunks.every(chunk => chunk.length <= 100));
});

test("超长日志拆成独立闭合的 Markdown，延续语言标记并保留每行内容", () => {
  for (const marker of ["```", "~~~~"]) {
    const lines = Array.from({ length: 30 }, (_, i) => `log line ${String(i).padStart(2, "0")}\n`);
    const chunks = splitMarkdown(`${marker}text\n${lines.join("")}${marker}`, 100);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.startsWith(`${marker}text\n`));
      assert.ok(chunk.endsWith(marker));
      assert.ok(chunk.length <= 100);
    }
    assert.equal(chunks.map(s => s.slice(`${marker}text\n`.length, -marker.length)).join(""), lines.join(""));
  }
});

test("代码块内较短的围栏和三反引号不会切坏四反引号代码块", () => {
  const block = codeBlock("```bash\necho example\n```\nend");
  const text = `intro\n\n${block}\n\n${"尾声".repeat(60)}`;
  const chunks = splitMarkdown(text, 80);
  assert.ok(chunks.some(s => s.includes(block)));
  assert.equal(chunks.join(""), text);
});

test("长代码块的短续段不会把相邻两对围栏粘在同一行，空代码块不会丢失", () => {
  const chunks = splitMarkdown(codeBlock(`${"a".repeat(50)}\n${"b".repeat(50)}\nshort`), 100);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.split("```text").length === 2));
  assert.ok(chunks.every(chunk => chunk.endsWith("```")));
  const empty = "```very-long-language\n```";
  assert.deepEqual(splitMarkdown(empty, 10), [empty]);
});

test("普通文字分段不丢字，emoji 不拆成孤立代理字符，未闭合围栏补齐", () => {
  const plain = "abc🙂".repeat(20);
  const chunks = splitMarkdown(plain, 9);
  assert.equal(chunks.join(""), plain);
  assert.ok(chunks.every(s => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(s)));
  assert.deepEqual(splitMarkdown("```sh\necho hello", 100), ["```sh\necho hello\n```"]);
  assert.deepEqual(splitMarkdown("", 100), []);
  assert.throws(() => splitMarkdown("hello", 0));
});
