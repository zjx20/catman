import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTIFY_BIN_NAME, notifyBinBody, writeNotifyBin } from "../src/core/notify-bin.js";

/**
 * `catman-notify` 的端到端测试:真的起一个 HTTP 服务、真的跑一遍脚本。
 *
 * 断言脚本正文里有没有某个字符串是**没有意义**的 —— 这个脚本的失败方式全都是
 * "语法看着对、跑起来什么都不发生"(少一个 `< /dev/null`、curl 被代理劫走、
 * JSON 转义没做)。只有真跑一遍才拦得住。
 */

const dirs: string[] = [];
const servers: Server[] = [];
const TOKEN = "test-notify-token";

test.after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Rig {
  bin: string;
  dataDir: string;
  got: Array<{ token: string | undefined; text: unknown }>;
  env: NodeJS.ProcessEnv;
}

async function rig(): Promise<Rig> {
  const dataDir = mkdtempSync(join(tmpdir(), "catman-notifybin-"));
  dirs.push(dataDir);
  const got: Rig["got"] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const raw = req.headers["x-catman-notify"];
      got.push({
        token: Array.isArray(raw) ? raw[0] : raw,
        text: (JSON.parse(body) as { text: unknown }).text,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const bin = writeNotifyBin(join(dataDir, "bin"), `http://127.0.0.1:${port}`);
  return {
    bin,
    dataDir,
    got,
    env: {
      ...process.env,
      CATMAN_DATA_DIR: dataDir,
      CATMAN_NOTIFY_TOKEN: TOKEN,
      // 故意把 API_BASE 从环境里拿掉:烘进脚本的那个默认值也得是对的。
      CATMAN_API_BASE: "",
      // 这台机器上代理是常态,而 curl 会默认走它 —— 脚本里的 --noproxy '*'
      // 就是为这件事存在的,所以测试里必须把代理摆上去。
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
    },
  };
}

/**
 * 跑一次脚本。
 *
 * ⚠️ **必须是异步的。** 用 `execFileSync` 的话,收消息的那个 HTTP 服务就住在被它
 * 阻塞住的这个进程里 —— curl 发得出去、却要等到自己 `-m` 超时才回来,而那看起来
 * 完全像是脚本本身有毛病。这个坑值得留一行字。
 */
function run(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { env, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    // 参数错、没令牌这几个用例里,脚本可能在我们写 stdin 之前就退了 —— 那时候
    // 写进去是 EPIPE。不接这个错的话它会变成未捕获异常,而且**只是偶尔**发生。
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

/** 等到收够 n 条,或者超时。 */
async function waitFor(got: Rig["got"], n: number, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (got.length < n && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(got.length >= n, `等了 ${ms}ms 只收到 ${got.length} 条,期望 ${n} 条`);
}

test("写出来的是一个可执行文件", async () => {
  const r = await rig();
  assert.ok(r.bin.endsWith(NOTIFY_BIN_NAME));
  assert.equal(statSync(r.bin).mode & 0o111, 0o111);
});

test("send:文本原样送达,带着推送令牌,而且不被代理劫走", async () => {
  const r = await rig();
  const res = await run(r.bin, ["send", "备份好了"], r.env);
  assert.equal(res.code, 0, res.stderr);
  await waitFor(r.got, 1);
  assert.equal(r.got[0]!.text, "备份好了");
  assert.equal(r.got[0]!.token, TOKEN);
});

test("send:引号、换行、反斜杠都得原样过去(任务输出里全是这些)", async () => {
  const r = await rig();
  const nasty = 'a"b\\c\n第二行\t制表 {"json":true}';
  await run(r.bin, ["send"], r.env, nasty);
  await waitFor(r.got, 1);
  assert.equal(r.got[0]!.text, nasty);
});

test("run:命令成功时推一条带 ✅ 和日志尾巴的消息", async () => {
  const r = await rig();
  const res = await run(r.bin, ["run", "-n", "小活儿", "--", "bash", "-c", "echo 干完了"], r.env);
  // 立刻返回,不等命令跑完 —— 这是它与"直接跑"的全部区别。
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /已经脱钩跑起来了/);
  assert.match(res.stdout, /日志:/);
  await waitFor(r.got, 1);
  const text = String(r.got[0]!.text);
  assert.match(text, /✅ 「小活儿」跑完了/);
  assert.match(text, /干完了/);
  assert.match(text, /日志:/);
});

test("run:失败时带 ❌ 与退出码 —— 静悄悄的失败是最坏的一种", async () => {
  const r = await rig();
  await run(r.bin, ["run", "-n", "会挂的", "--", "bash", "-c", "echo 出错了 >&2; exit 3"], r.env);
  await waitFor(r.got, 1);
  const text = String(r.got[0]!.text);
  assert.match(text, /❌ 「会挂的」失败了/);
  assert.match(text, /退出码 3/);
  // stderr 也要进日志:失败原因几乎总在那边。
  assert.match(text, /出错了/);
});

test("run:日志落在 $CATMAN_DATA_DIR/tmp,不是 /tmp(别的容器挂不到 /tmp)", async () => {
  const r = await rig();
  const res = await run(r.bin, ["run", "-n", "看路径", "--", "true"], r.env);
  const log = /日志:(\S+)/.exec(res.stdout)?.[1];
  assert.ok(log, "run 必须把日志路径打出来 —— 下一回合要靠它读细节");
  assert.ok(log!.startsWith(join(r.dataDir, "tmp")), `日志跑到了 ${log}`);
  // 中文名字要还认得出来(按字节 tr 会把它拆成一串下划线)。
  assert.match(log!, /看路径/);
});

test("没有推送令牌时明确报错,而不是安静地什么都不发", async () => {
  const r = await rig();
  const res = await run(r.bin, ["send", "喂"], { ...r.env, CATMAN_NOTIFY_TOKEN: "" });
  assert.equal(res.code, 2);
  assert.match(res.stderr, /CATMAN_NOTIFY_TOKEN/);
});

test("run 的命令前必须有 --,写漏了要报错而不是把参数当命令", async () => {
  const r = await rig();
  const res = await run(r.bin, ["run", "echo", "hi"], r.env);
  assert.equal(res.code, 2);
});

test("正文里烘进去的默认 apiBase 就是传进来的那个", () => {
  assert.match(notifyBinBody("http://example:1234"), /http:\/\/example:1234/);
});
