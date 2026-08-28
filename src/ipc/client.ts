import { request } from "node:http";
import {
  IPC_SCHEMA,
  parsePull,
  parseSendResult,
  type ParsedPull,
  type SendKind,
  type SendResult,
} from "./protocol.js";
import { IPC_SECRET_HEADER } from "./server.js";

/**
 * 人格这一侧的 IPC 客户端。
 *
 * 走 unix socket 的 HTTP,零依赖(`node:http` 的 `request({socketPath})` 原生支持)。
 * `fetch` 不直接支持 socketPath,所以这里用底层的 http 模块 —— 不是复古,是没别的选择。
 *
 * **它对信使不可达是有容忍度的**:信使可能正在重启(pinned release 也会被人工换),
 * 而那时人格不该跟着崩。所有方法在网络层失败时抛错,由 bridge 决定退避重试。
 */

/**
 * 人格需要信使做的那几件事。
 *
 * bridge 依赖这个**接口**而不是 `IpcClient` 这个类:后者有私有成员,TypeScript 的
 * 结构化类型因此认不出任何假实现 —— 于是渠道层的时序用例就只能去起一个真 socket,
 * 而那会把"验时序"变成"验 IO"。
 */
/** 一次 IPC 往返的原始结果。状态码要一路带上来 —— 见 pull 里的说明。 */
interface HttpReply {
  readonly status: number;
  readonly body: unknown;
}

/** 从错误响应体里挖一句人话。挖不到就说不知道,别编。 */
function reasonOf(body: unknown): string {
  const r = body && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined;
  return typeof r === "string" && r ? r : "信使没有给出原因";
}

export interface CourierLink {
  pull(waitMs: number): Promise<ParsedPull | undefined>;
  ack(msgIds: readonly string[]): Promise<void>;
  nack(msgIds: readonly string[], reason: string): Promise<void>;
  send(userKey: string, text: string, kind: SendKind): Promise<SendResult>;
  /** 报一次「还在动」。可选:没有它的实现只是不亮输入气泡,别的照常。 */
  typing?(userKey: string): Promise<void>;
}

export interface IpcClientOptions {
  socketPath: string;
  /** 本人格的 secret。信使按它反查身份 —— 请求体里不带任何身份声明。 */
  secret: string;
  /** 单次请求的超时。长轮询要留足余量,否则每一轮都被自己掐断。 */
  timeoutMs?: number;
}

export class IpcClient implements CourierLink {
  constructor(private readonly opts: IpcClientOptions) {}

  /**
   * 长轮询拉取。`waitMs` 是**服务端**挂起的时长;客户端超时必须明显更长,
   * 否则每一轮都在服务端还挂着的时候被自己掐断 —— iLink 那边踩过一模一样的坑
   * (默认 15 秒超时撞上 30 秒长轮询,每次都被中断)。
   */
  async pull(waitMs: number): Promise<ParsedPull | undefined> {
    const r = await this.post("/pull", { schema: IPC_SCHEMA, waitMs }, waitMs + 10_000);
    // **状态码必须看**。401 的响应体是 `{ok:false,reason}` —— 它没有 messages 键,
    // 而 parsePull 对缺席的键一律按空数组处理,于是「认证失败」与「队列是空的」
    // 在人格这边**完全同形**:它会以最快速度反复重拉一个永远拒绝它的信使,
    // 而 health() 还照报 live。触发条件是纯配置漂移(两侧的 env 变量名不同名),
    // 所以这道判定不能省。
    if (r.status >= 400) throw new Error(`信使拒绝了拉取(${r.status}):${reasonOf(r.body)}`);
    return parsePull(r.body);
  }

  /** 确认这些消息已经落进本进程的队列。**此时信使才出队。** */
  async ack(msgIds: readonly string[]): Promise<void> {
    if (!msgIds.length) return;
    const r = await this.post("/ack", { schema: IPC_SCHEMA, msgIds });
    // ack 静默失败最坏:消息没出队,人格却以为处理完了 —— 下一轮再拿到同一批,
    // 而它们已经在 seen 里,于是被当成重复直接跳过。那等于**真丢**。
    if (r.status >= 400) throw new Error(`信使拒绝了 ack(${r.status}):${reasonOf(r.body)}`);
  }

  /** 读不懂这些消息。信使据此亮红灯 —— 契约漂移必须看得见。 */
  async nack(msgIds: readonly string[], reason: string): Promise<void> {
    if (!msgIds.length) return;
    await this.post("/nack", { schema: IPC_SCHEMA, msgIds, reason });
  }

  async send(userKey: string, text: string, kind: SendKind): Promise<SendResult> {
    // send 与上面几个不同:它的 4xx 响应体**本身就是**一份有意义的 SendResult
    // (ok:false + reason),所以这里看体不看码。
    const r = await this.post("/send", { schema: IPC_SCHEMA, userKey, kind, text });
    const parsed = parseSendResult(r.body);
    // 读不懂信使的回复时按"没发出去、也没有额度"处理:**宁可少发,不可超发**。
    return parsed ?? { schema: IPC_SCHEMA, ok: false, remainingProgress: 0, reason: "信使的回复读不懂" };
  }

  /**
   * 报一次「还在动」。**失败一律吞掉,而且不重试。**
   *
   * 老信使(pinned 比人格旧)没有这个端点,回的是 404 —— 那时正确的行为就是
   * 什么都不做:typing 是装饰,不值得为它打一行日志,更不值得让调用方看见异常。
   * 独立端点的全部价值就在这里:它坏掉的时候,正文那条路毫发无损。
   */
  async typing(userKey: string): Promise<void> {
    try {
      await this.post("/typing", { schema: IPC_SCHEMA, userKey }, 5_000);
    } catch {
      // 静默
    }
  }

  /** 代理 dashboard 的账号管理等控制面。 */
  async admin(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    return (await this.send_(method, `/admin${path}`, body, timeoutMs)).body;
  }

  private post(path: string, body: unknown, timeoutMs?: number): Promise<HttpReply> {
    return this.send_("POST", path, body, timeoutMs);
  }

  private send_(
    method: string,
    path: string,
    body: unknown,
    timeoutMs = this.opts.timeoutMs ?? 15_000,
  ): Promise<HttpReply> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    return new Promise((resolve, reject) => {
      // ⚠️ **墙钟兜底,与 socket 的 timeout 是两回事。**
      // `timeout` 是 socket 的**空闲**超时:对端在写了一半响应之后销毁 socket 时,
      // 定时器随 socket 一起消失,而 'end' 永远不来 —— 于是这个 promise 既不 resolve
      // 也不 reject,bridge 的 `await client.pull(...)` 就永久停在那一次 await 上,
      // 拉取循环再没有下一轮,只能人工重启人格。实测复现过(响应被截断时 20 秒仍未 settle)。
      // 信使是会被 SIGKILL 的(OOM、人工 bless 重启),所以这条路不是假想。
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        fn();
      };
      const deadline = setTimeout(() => {
        req.destroy();
        finish(() => reject(new Error(`IPC 无响应超时(${timeoutMs}ms) ${method} ${path}`)));
      }, timeoutMs + 1000);
      const req = request(
        {
          socketPath: this.opts.socketPath,
          path,
          method,
          headers: {
            "content-type": "application/json; charset=utf-8",
            [IPC_SECRET_HEADER]: this.opts.secret,
            ...(payload ? { "content-length": payload.length } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          const status = res.statusCode ?? 0;
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", (e) => finish(() => reject(e)));
          res.on("aborted", () =>
            finish(() => reject(new Error(`信使在写响应途中断开 ${method} ${path}`))),
          );
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            finish(() => {
              try {
                resolve({ status, body: text ? JSON.parse(text) : undefined });
              } catch {
                reject(new Error(`信使返回的不是 JSON(${status}):${text.slice(0, 200)}`));
              }
            });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`IPC 超时(${timeoutMs}ms) ${method} ${path}`)));
      req.on("error", (e) => finish(() => reject(e)));
      if (payload) req.write(payload);
      req.end();
    });
  }
}
