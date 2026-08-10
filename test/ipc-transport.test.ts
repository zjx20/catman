import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcClient } from "../src/ipc/client.js";
import { IpcServer, handleIpc, type CourierApi } from "../src/ipc/server.js";
import { IPC_SCHEMA, type PersonaId, type PullResponse, type SendResult } from "../src/ipc/protocol.js";

/**
 * IPC 的传输层。协议形状由 ipc-protocol.test.ts 钉,这里验的是**接线**:
 * 身份认得对不对、长轮询会不会拖住关闭、socket 残留会不会让下次起不来。
 *
 * 用真 unix socket 而不是打桩:这三件事全都只在真 socket 上才成立
 * (EADDRINUSE、connect 的写权限、close 等待长连接),打桩测的是我的想象。
 */

/** 可编排的假信使:记录调用,结果由用例摆好。 */
class FakeCourier implements CourierApi {
  pulls: PersonaId[] = [];
  acks: Array<{ persona: PersonaId; msgIds: readonly string[] }> = [];
  nacks: Array<{ persona: PersonaId; msgIds: readonly string[]; reason: string }> = [];
  sends: Array<{ persona: PersonaId; out: unknown }> = [];
  next: PullResponse = { schema: IPC_SCHEMA, controls: [], messages: [] };
  /** true 时 pull 一直挂着直到 signal 触发 —— 模拟真实的长轮询。 */
  hang = false;
  /** 进入 pull 那一刻 signal 是不是已经 aborted。**这是个陷阱的探针**,见用例。 */
  abortedOnEntry: boolean | undefined;

  async pull(persona: PersonaId, _waitMs: number, signal: AbortSignal): Promise<PullResponse> {
    this.pulls.push(persona);
    this.abortedOnEntry = signal.aborted;
    if (!this.hang) return this.next;
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { schema: IPC_SCHEMA, controls: [], messages: [] };
  }
  async ack(persona: PersonaId, msgIds: readonly string[]): Promise<void> {
    this.acks.push({ persona, msgIds });
  }
  async nack(persona: PersonaId, msgIds: readonly string[], reason: string): Promise<void> {
    this.nacks.push({ persona, msgIds, reason });
  }
  async send(persona: PersonaId, out: unknown): Promise<SendResult> {
    this.sends.push({ persona, out });
    return { schema: IPC_SCHEMA, ok: true, messageId: "s-1", remainingProgress: 4 };
  }
  async admin(
    persona: PersonaId,
    method: string,
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    return { status: 200, body: { persona, method, path, body } };
  }
}

const SECRETS = new Map<string, PersonaId>([
  ["s-primary", "primary"],
  ["s-rescue", "rescue"],
]);

async function withServer(
  fn: (client: IpcClient, api: FakeCourier, socketPath: string) => Promise<void>,
  secret = "s-primary",
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "catman-ipc-"));
  const socketPath = join(dir, "courier.sock");
  const api = new FakeCourier();
  const server = new IpcServer({ socketPath, api, secrets: SECRETS });
  server.start();
  // listen 是异步的,给它一轮事件循环。
  await new Promise((r) => setTimeout(r, 30));
  try {
    await fn(new IpcClient({ socketPath, secret }), api, socketPath);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("身份由 secret 推出 —— 人格不必也不能声明自己是谁", async () => {
  await withServer(async (client, api) => {
    await client.ack(["m-1"]);
    assert.deepEqual(api.acks, [{ persona: "primary", msgIds: ["m-1"] }]);
  });
  await withServer(
    async (client, api) => {
      await client.ack(["m-2"]);
      assert.deepEqual(api.acks, [{ persona: "rescue", msgIds: ["m-2"] }]);
    },
    "s-rescue",
  );
});

test("secret 不对时一律 401,而且信使一个动作都不做", async () => {
  await withServer(
    async (client, api) => {
      // ack 必须**抛**而不是静默成功:静默的话人格以为处理完了,下一轮再拿到同一批
      // 时它们已经在 seen 里、被当成重复跳过 —— 那等于真丢。
      await assert.rejects(() => client.ack(["m-1"]), /401|拒绝/);
      assert.deepEqual(api.acks, [], "越权的 ack 绝不能出队别人的消息");
      const r = await client.send("wechat:a:u", "喂", "body");
      assert.equal(r.ok, false);
      assert.equal(r.remainingProgress, 0, "认证失败时额度必须按 0 报,免得人格照着发");
    },
    "wrong-secret-value",
  );
});

test("send 的信封由信使解析 —— 读不懂要给可读的失败,不能静默", async () => {
  await withServer(async (client, api) => {
    // 绕过客户端直接投一个坏 kind,模拟版本漂移。
    const out = await handleIpc(
      {
        method: "POST",
        path: "/send",
        secret: "s-primary",
        body: { schema: 1, userKey: "wechat:a:u", kind: "未来类别", text: "x" },
      },
      api,
      SECRETS,
      new AbortController().signal,
    );
    assert.equal(out.status, 400);
    assert.equal((out.body as SendResult).ok, false);
    assert.match((out.body as SendResult).reason ?? "", /读不懂/);
    assert.deepEqual(api.sends, [], "读不懂就不该往下走");
  });
});

test("正常 send 把信封原样交给信使,并把剩余额度带回来", async () => {
  await withServer(async (client, api) => {
    const r = await client.send("wechat:a:u", "在跑了", "progress");
    assert.equal(r.ok, true);
    assert.equal(r.remainingProgress, 4);
    assert.deepEqual(api.sends[0]?.out, {
      schema: IPC_SCHEMA,
      userKey: "wechat:a:u",
      kind: "progress",
      text: "在跑了",
    });
  });
});

test("长轮询挂着时 stop() 也要能收摊 —— 否则进程卡在优雅关闭里出不去", async () => {
  // dashboard 的 SSE 踩过一模一样的坑(已实测复现):server.close() 会一直等长连接,
  // 不先中止在飞请求,close 的回调永远不触发。
  const dir = mkdtempSync(join(tmpdir(), "catman-ipc-"));
  const socketPath = join(dir, "courier.sock");
  const api = new FakeCourier();
  api.hang = true;
  const server = new IpcServer({ socketPath, api, secrets: SECRETS });
  server.start();
  await new Promise((r) => setTimeout(r, 30));
  const client = new IpcClient({ socketPath, secret: "s-primary" });
  const pulling = client.pull(25_000).catch(() => undefined); // 会一直挂着
  await new Promise((r) => setTimeout(r, 50));

  const started = Date.now();
  await server.stop();
  const elapsed = Date.now() - started;
  await pulling;
  rmSync(dir, { recursive: true, force: true });
  assert.ok(elapsed < 3000, `stop() 花了 ${elapsed}ms,说明没收掉在飞的长轮询`);
});

test("残留的 socket 文件不能让下次启动失败 —— 被 SIGKILL 时它一定残留", async () => {
  // 而那恰恰是重启最频繁的场景(OOM、crash-loop)。listen 到一个已存在的 socket
  // 路径会直接 EADDRINUSE,症状是信使起不来、两个人格全聋。
  const dir = mkdtempSync(join(tmpdir(), "catman-ipc-"));
  const socketPath = join(dir, "courier.sock");
  const api = new FakeCourier();

  const first = new IpcServer({ socketPath, api, secrets: SECRETS });
  first.start();
  await new Promise((r) => setTimeout(r, 30));
  // 不调 stop(),直接丢掉引用 —— 模拟进程被杀,socket 文件留在原地。
  assert.ok(existsSync(socketPath));

  const second = new IpcServer({ socketPath, api, secrets: SECRETS });
  second.start();
  await new Promise((r) => setTimeout(r, 30));
  const client = new IpcClient({ socketPath, secret: "s-primary" });
  await client.ack(["m-after-restart"]);
  assert.deepEqual(api.acks.at(-1), { persona: "primary", msgIds: ["m-after-restart"] });

  await second.stop();
  await first.stop().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("未知端点回 404,不静默成功", async () => {
  const out = await handleIpc(
    { method: "POST", path: "/未来端点", secret: "s-primary", body: {} },
    new FakeCourier(),
    SECRETS,
    new AbortController().signal,
  );
  assert.equal(out.status, 404);
});

test("/admin/* 透传给信使,并带上由 secret 推出的身份", async () => {
  await withServer(async (client) => {
    const r = (await client.admin("GET", "/accounts")) as Record<string, unknown>;
    assert.equal(r["persona"], "primary");
    assert.equal(r["path"], "/accounts");
  });
});

test("长轮询的 signal **进门时不能已经 aborted** —— 否则它退化成忙轮询", async () => {
  // 踩过的坑:中止挂在 `req` 上,而 IncomingMessage 的 `close` 在请求体**读完**的
  // 那一刻就触发(实测确认),早于 api.pull 被调用。于是每次拉取立即返回空,
  // bridge 以最高速度重拉,在软路由上把 CPU 打满 —— 而这件事**没有任何报错**,
  // 只表现为"机器很烫"。中止必须挂在 `res` 上。
  await withServer(async (client, api) => {
    await client.pull(0);
    assert.equal(api.abortedOnEntry, false, "signal 一进门就 aborted 了 —— 长轮询是假的");
  });
});
