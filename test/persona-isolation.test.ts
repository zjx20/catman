import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **人格进程不能持有 AccountStore。**
 *
 * `accounts.json` 只能有一个写者(信使)。人格里只要还留着一个实例,它就握着一份
 * 可能过时的内存快照 —— 而那个类的每次写都是**整份覆写**。症状是"扫了码过一会儿
 * 又掉了"或者"改的备注名自己变回去了",**而且没有任何报错**。评审把这条列为 fatal。
 *
 * 靠自觉守不住:`AccountStore` 就在同一个仓库里,import 一下太容易了,而后果要等到
 * 真机上两个进程同时写的时候才显形。所以这里从入口开始走一遍**真实的模块图**,
 * 断言它到不了 accounts.ts。
 *
 * `import type` 不算:类型在编译后一个字节都不留,与"持有实例"无关
 * (dashboard 就用它来标注代理接口的返回类型)。
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** 从一个入口出发,收集它经由**值导入**能到达的全部本仓库模块。 */
function valueImportGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of valueImportsOf(text)) {
      if (!spec.startsWith(".")) continue; // 只看本仓库
      // 源码里写的是编译后的 .js 后缀(NodeNext),对应的源文件是 .ts。
      stack.push(join(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return seen;
}

/**
 * 抽出**值导入**的路径。`import type {...}` 与 `import {type A}` 都不算 ——
 * 前者整条是类型导入,后者在这里保守处理:只要该语句还带别的具名导入就算值导入。
 */
function valueImportsOf(text: string): string[] {
  const out: string[] = [];
  const re = /import\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) continue; // import type { ... } from
    const clause = m[2] ?? "";
    // `import { type A, type B } from` 也是纯类型导入。
    const names = clause.replace(/^[^{]*\{|\}[^}]*$/g, "").split(",").map((s) => s.trim());
    const hasValue =
      !clause.includes("{") || names.some((n) => n && !n.startsWith("type "));
    if (hasValue && m[3]) out.push(m[3]);
  }
  return out;
}

test("人格入口(src/index.ts)的模块图到不了 core/accounts.ts", () => {
  const graph = valueImportGraph(join(SRC, "index.ts"));
  const accounts = join(SRC, "core", "accounts.ts");
  assert.equal(
    graph.has(accounts),
    false,
    "人格进程里出现了 AccountStore 的值导入 —— 它会用陈旧快照整份覆写信使刚写的 accounts.json",
  );
});

test("人格入口也到不了 iLink 连接与扫码 —— 那些整个搬去了信使", () => {
  const graph = valueImportGraph(join(SRC, "index.ts"));
  for (const gone of ["channels/wechat-ilink.ts", "channels/ilink-connection.ts", "channels/ilink-login.ts"]) {
    assert.equal(graph.has(join(SRC, gone)), false, `${gone} 不该还在人格的模块图里`);
  }
});

test("信使入口反过来**必须**到得了 accounts.ts —— 它才是那个唯一的写者", () => {
  // 这一条是上面两条的对照:少了它,把 accounts.ts 整个删掉也能让上面全绿。
  const graph = valueImportGraph(join(SRC, "courier", "main.ts"));
  assert.equal(graph.has(join(SRC, "core", "accounts.ts")), true);
  assert.equal(graph.has(join(SRC, "channels", "wechat-ilink.ts")), true);
});

test("解析器自身:import type 不算值导入,混合导入算", () => {
  // 这个判断是上面三条的地基,判错了它们就都在测空气。
  assert.deepEqual(valueImportsOf(`import type { A } from "./a.js";`), []);
  assert.deepEqual(valueImportsOf(`import { type A, type B } from "./a.js";`), []);
  assert.deepEqual(valueImportsOf(`import { type A, b } from "./a.js";`), ["./a.js"]);
  assert.deepEqual(valueImportsOf(`import { A } from "./a.js";`), ["./a.js"]);
  assert.deepEqual(valueImportsOf(`import X from "./a.js";`), ["./a.js"]);
});
