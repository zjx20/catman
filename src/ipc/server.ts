import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  IPC_SCHEMA,
  parseAck,
  parseOutbound,
  resolvePersona,
  type PersonaId,
  type PullResponse,
  type SendResult,
} from "./protocol.js";

/**
 * 信使这一侧的 IPC 端点。
 *
 * **薄得刻意**:这里只做 IO 适配(读 socket、认身份、解 JSON、写响应),真正的逻辑在
 * `handleIpc` 这个纯函数与信使的各个模块里 —— 与 dashboard 的 `server.ts` /
 * `api-*.ts` 是同一个分工,好处一样:测试不必起真实 server。
 */

/** 认证请求头。名字是契约的一部分,改它等于换协议。 */
export const IPC_SECRET_HEADER = "x-catman-ipc-secret";

/** 信使要实现的那点能力。IPC 层只认这个接口,不认识 inbox / 连接 / 路由表。 */
export interface CourierApi {
  /**
   * 长轮询拉取。`signal` 在服务器关闭或客户端断开时触发 —— 不接它的话,
   * 一个 30 秒的等待会把优雅关闭拖成 30 秒(dashboard 的 SSE 踩过同样的坑)。
   */
  pull(persona: PersonaId, waitMs: number, signal: AbortSignal): Promise<PullResponse>;
  /** 人格确认这些消息已经落进它的队列。**此时才出队。** */
  ack(persona: PersonaId, msgIds: readonly string[]): Promise<void>;
  /** 人格读不懂这些消息。计入投递失败并亮红灯 —— 契约漂移必须是红灯,不能是静默。 */
  nack(persona: PersonaId, msgIds: readonly string[], reason: string): Promise<void>;
  send(persona: PersonaId, out: unknown): Promise<SendResult>;
  /** 账号管理等控制面,供人格 dashboard 代理。 */
  admin(persona: PersonaId, method: string, path: string, body: unknown): Promise<AdminResponse>;
}

export interface AdminResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface IpcRequest {
  readonly method: string;
  readonly path: string;
  readonly secret: string | undefined;
  readonly body: unknown;
}

export interface IpcResponse {
  readonly status: number;
  readonly body: unknown;
}

/** 拉取的默认等待时长。够长以免空转刷屏,够短以免关闭被拖住。 */
export const DEFAULT_PULL_WAIT_MS = 25_000;

/**
 * 路由 + 鉴权。**纯函数**(除了调用注入的 api),所以"伪造身份""越权 ack"这类
 * 用例能直接跑,不必起 server。
 *
 * 身份**只从 secret 推**:请求体里若带 persona 字段,一个字都不看。于是
 * 「伪造 /send 冒充守护人格」与「伪造 ack 吞掉别人的消息」两条路同时被封死 ——
 * ack 只能出队**自己拉走的**那些,因为出队是按解析出来的 persona 做的。
 */
export async function handleIpc(
  req: IpcRequest,
  api: CourierApi,
  secrets: ReadonlyMap<string, PersonaId>,
  signal: AbortSignal,
): Promise<IpcResponse> {
  const persona = resolvePersona(req.secret, secrets);
  if (!persona) {
    // 不区分"没给"与"给错了":两者对调用方是同一件事,而分开说等于告诉对方
    // 他猜的那个 secret 存不存在。
    return { status: 401, body: { ok: false, reason: "IPC 身份认证失败" } };
  }

  const body = req.body;
  switch (`${req.method} ${req.path}`) {
    case "POST /pull": {
      const waitMs = readWaitMs(body);
      const pulled = await api.pull(persona, waitMs, signal);
      return { status: 200, body: pulled };
    }
    case "POST /ack": {
      const ack = parseAck(body);
      if (!ack) return { status: 400, body: { ok: false, reason: "ack 信封读不懂" } };
      await api.ack(persona, ack.msgIds);
      return { status: 200, body: { schema: IPC_SCHEMA, ok: true } };
    }
    case "POST /nack": {
      const ack = parseAck(body);
      if (!ack) return { status: 400, body: { ok: false, reason: "nack 信封读不懂" } };
      await api.nack(persona, ack.msgIds, ack.reason ?? "");
      return { status: 200, body: { schema: IPC_SCHEMA, ok: true } };
    }
    case "POST /send": {
      // 解析放在信使侧:人格发来的信封读不懂时,**要给出可读的失败**而不是静默 ——
      // 人格会把 ok=false 当成"这条没发出去"并记进日志,那正是我们要的。
      const out = parseOutbound(body);
      if (!out) {
        return {
          status: 400,
          body: {
            schema: IPC_SCHEMA,
            ok: false,
            remainingProgress: 0,
            reason: "出站信封读不懂(kind 或 userKey 不对)",
          } satisfies SendResult,
        };
      }
      return { status: 200, body: await api.send(persona, out) };
    }
    default:
      break;
  }

  if (req.path.startsWith("/admin/")) {
    const r = await api.admin(persona, req.method, req.path.slice("/admin".length), body);
    return { status: r.status, body: r.body };
  }
  return { status: 404, body: { ok: false, reason: `未知端点 ${req.method} ${req.path}` } };
}

function readWaitMs(body: unknown): number {
  const v = body && typeof body === "object" ? (body as Record<string, unknown>)["waitMs"] : undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_PULL_WAIT_MS;
  // 夹在合理区间:0 会让人格空转打爆 CPU,过大会把优雅关闭拖住。
  return Math.min(Math.max(0, Math.floor(v)), 60_000);
}

/** 中止之后留给在飞响应写完的时间。够短以免拖住关闭,够长以免把正常结果掐断。 */
const GRACE_MS = 50;

/** 请求体上限。IPC 只传文本与引用,**附件字节不走这里**,所以可以定得很小。 */
const MAX_BODY_BYTES = 1_000_000;

export interface IpcServerOptions {
  /** unix socket 路径。 */
  socketPath: string;
  api: CourierApi;
  /** secret → 人格。由 compose env 注入。 */
  secrets: ReadonlyMap<string, PersonaId>;
}

export class IpcServer {
  private server?: Server;
  /** 在飞的长轮询,stop() 时一起中止。 */
  private readonly inFlight = new Set<AbortController>();

  constructor(private readonly opts: IpcServerOptions) {}

  start(): void {
    // 残留的 socket 文件会让 listen 直接 EADDRINUSE,而进程上一次是被 SIGKILL
    // 掉的时候它一定残留 —— 那正是重启最频繁的场景。无条件清掉再监听。
    mkdirSync(dirname(this.opts.socketPath), { recursive: true });
    rmSync(this.opts.socketPath, { force: true });

    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.listen(this.opts.socketPath, () => {
      // 0660:同 uid 的人格连得上,别人连不上。unix socket 的 connect() 需要写权限,
      // 所以这里不能给 0440 —— 那样人格会以 EACCES 连不上,而症状是"起来了但一条
      // 消息都收不到"。
      try {
        chmodSync(this.opts.socketPath, 0o660);
      } catch {
        // 某些文件系统上 chmod socket 会失败,不值得为此拒绝启动。
      }
      console.info(`[courier] IPC 监听 ${this.opts.socketPath}`);
    });
  }

  async stop(): Promise<void> {
    // ① 先中止在飞的长轮询:它们最长会挂 25 秒,不收掉的话 close() 的回调永远不触发,
    //    进程卡在优雅关闭里出不去 —— dashboard 的 SSE 是同一个坑,已实测复现过。
    for (const c of this.inFlight) c.abort();
    this.inFlight.clear();
    // ② 给被中止的那些一小段时间把响应写完 —— 人格那边拿到一个正常的空结果,
    //    比拿到一个被掐断的连接干净(后者会让它打一行"拉取失败"然后退避)。
    await new Promise((r) => setTimeout(r, GRACE_MS));
    const server = this.server;
    if (server) {
      // ③ **必须显式关连接**。客户端用的是 keep-alive 的 agent,响应写完之后 socket
      //    仍然活着;`close()` 只是不再接新连接,于是它会一直等到 keep-alive 超时
      //    (默认 5 秒)才回调 —— 实测这一步让 stop() 从毫秒变成 4 秒。
      //    对**信使**来说这是致命的:它跑 pinned release、要被人工 bless 重启,
      //    每次都白等几秒还算小事,真正的问题是这类"等待"会随连接数线性增长。
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rmSync(this.opts.socketPath, { force: true });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const abort = new AbortController();
    this.inFlight.add(abort);
    // ⚠️ **必须挂在 `res` 上,不能挂 `req`。**
    // `IncomingMessage` 的 `close` 在请求体**读完**的那一刻就触发(实测:读完 body
    // 之后立即为已触发),而我们下面要先 `await readJsonBody(req)` —— 于是 signal
    // 一进 `api.pull` 就已经 aborted,长轮询当场返回空,bridge 以最高速度重拉,
    // 在软路由上把 CPU 打满。而这件事**没有任何报错**,只表现为"机器很烫"。
    // `ServerResponse` 的 `close` 才是"对端走了或响应写完了",正是我们要的。
    res.on("close", () => abort.abort());
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const body = await readJsonBody(req);
      const secretHeader = req.headers[IPC_SECRET_HEADER];
      const out = await handleIpc(
        {
          method: req.method ?? "GET",
          path: url.pathname,
          secret: typeof secretHeader === "string" ? secretHeader : undefined,
          body,
        },
        this.opts.api,
        this.opts.secrets,
        abort.signal,
      );
      if (res.writableEnded) return;
      res.writeHead(out.status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out.body));
    } catch (err) {
      console.error("[courier] IPC 处理失败:", err);
      if (!res.writableEnded) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, reason: String(err) }));
      }
    } finally {
      this.inFlight.delete(abort);
    }
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("IPC 请求体过大");
    chunks.push(buf);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}
