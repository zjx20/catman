import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

test("通知客户端从管道读取正文并报告 HTTP 失败", async () => {
  const received: Array<{ token: string | string[] | undefined; text: string }> = [];
  let status = 202;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ token: req.headers["x-catman-runtime"], text: JSON.parse(Buffer.concat(chunks).toString()).text });
    res.writeHead(status); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== "string");
  const run = (input: string) => new Promise<{ code: number | null; error: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/core/execution/task-cli.ts", "send"], {
      env: { ...process.env, CATMAN_API_BASE: `http://127.0.0.1:${addr.port}`, CATMAN_RUNTIME_TOKEN: "test-runtime" }, stdio: ["pipe", "ignore", "pipe"],
    });
    let error = ""; child.stderr.on("data", chunk => { error += chunk; }); child.once("error", reject);
    child.once("close", code => resolve({ code, error })); child.stdin.end(input);
  });
  try {
    assert.equal((await run("日报第一行\n第二行\n")).code, 0);
    assert.deepEqual(received[0], { token: "test-runtime", text: "日报第一行\n第二行\n" });
    status = 503; const failed = await run("retry me"); assert.equal(failed.code, 1); assert.match(failed.error, /HTTP 503/);
    assert.equal((await run(" ")).code, 1); assert.equal(received.length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
