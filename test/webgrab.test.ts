import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../skills/webgrab/webgrab.mjs", import.meta.url));
async function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "catman-webgrab-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env,
      HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "",
      CNB_BROWSER_URL: "http://127.0.0.1:1", CNB_BROWSER_TOKEN: "local-test-only", ...env,
    } });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; }); child.stderr.on("data", d => { stderr += d; });
    child.on("error", reject); child.on("exit", code => resolve({ code, stdout, stderr }));
  });
  return { cwd, run };
}

test("webgrab：输出父目录缺失时在联网前失败，成功文件保存在 cwd", async t => {
  const f = await fixture(t);
  const bad = await f.run(["plain", "http://127.0.0.1:1", "--out", "missing/article.md"]);
  assert.notEqual(bad.code, 0); assert.match(bad.stderr, /输出路径不可写/); assert.doesNotMatch(bad.stderr, /→/);
  writeFileSync(join(f.cwd, "source.txt"), "local content\n");
  const good = await f.run(["plain", `file://${join(f.cwd, "source.txt")}`, "--out", "article.md"]);
  assert.equal(good.code, 0, good.stderr); assert.equal(readFileSync(join(f.cwd, "article.md"), "utf8"), "local content\n");
});

test("webgrab：curl 的实际失败不能被 HTTP 0 或成功提示掩盖", async t => {
  const f = await fixture(t);
  const result = await f.run(["plain", `file://${join(f.cwd, "absent.txt")}`, "--out", "article.md"]);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /curl 失败/); assert.doesNotMatch(result.stderr, /→/);
});

test("webgrab：jina 不吞掉 curl 写入失败的退出码", async t => {
  const f = await fixture(t); const bin = join(f.cwd, "bin"); mkdirSync(bin);
  // A deterministic transport failure; no request leaves this process.
  writeFileSync(join(bin, "curl"), '#!/bin/sh\ncat >/dev/null\nprintf "write failed" >&2\nexit 23\n', { mode: 0o755 });
  const result = await f.run(["jina", "https://example.com", "--out", "article.md"], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.code, 23); assert.match(result.stderr, /write failed/); assert.doesNotMatch(result.stderr, /→/);
});

test("webgrab：CNB 动作使用秒，补齐不重试的导航参数，HTTP 错误正确返回", async t => {
  const f = await fixture(t); const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/gw/status") { res.writeHead(401); res.end('{"error":"invalid token"}'); return; }
    let raw = ""; for await (const c of req) raw += c;
    bodies.push(JSON.parse(raw)); res.setHeader("content-type", "application/json"); res.end('{"success":true,"data":{"ok":true}}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const env = { CNB_BROWSER_URL: `http://127.0.0.1:${address.port}` };
  const bad = await f.run(["cnb", "do", '{"action":"goto","url":"https://example.com","timeout":30000}'], env);
  assert.notEqual(bad.code, 0); assert.match(bad.stderr, /使用秒/); assert.equal(bodies.length, 0);
  const good = await f.run(["cnb", "do", '{"action":"run_script","steps":[{"action":"goto","url":"https://example.com"}]}'], env);
  assert.equal(good.code, 0, good.stderr);
  const steps = bodies[0]!.steps as Record<string, unknown>[];
  assert.equal(steps[0]!.timeout, 30); assert.equal(steps[0]!.retry_count, 0); assert.equal(steps[0]!.wait_until, "domcontentloaded");
  const status = await f.run(["cnb", "status"], env);
  assert.notEqual(status.code, 0); assert.match(status.stderr, /401/);
});

test("webgrab：503 冷启动重试共享同一个总超时", { timeout: 5000 }, async t => {
  const f = await fixture(t); const paths: string[] = [];
  const server = createServer((req, res) => { paths.push(req.url!); res.writeHead(503); res.end('{"error":"WORKSPACE_STARTING"}'); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const started = Date.now();
  const result = await f.run(["cnb", "do", '{"action":"get_page_info"}', "--timeout", "0.2"], { CNB_BROWSER_URL: `http://127.0.0.1:${address.port}` });
  assert.equal(result.code, 28, result.stderr); assert.match(result.stderr, /总超时/); assert.ok(Date.now() - started < 2000);
  assert.ok(paths.includes("/gw/start?wait=120"));
});

test("webgrab：help 成功，未知选项和非法超时在请求前拒绝", async t => {
  const f = await fixture(t);
  assert.equal((await f.run(["--help"])).code, 0);
  for (const args of [["--timeout", "0"], ["--nav-timeout", "30000"], ["--out"], ["--unknown"]]) {
    const result = await f.run(["plain", "http://127.0.0.1:1", ...args]);
    assert.notEqual(result.code, 0); assert.doesNotMatch(result.stderr, /curl 失败/);
  }
});
