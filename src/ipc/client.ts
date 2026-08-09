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

export interface IpcClientOptions {
  socketPath: string;
  /** 本人格的 secret。信使按它反查身份 —— 请求体里不带任何身份声明。 */
  secret: string;
  /** 单次请求的超时。长轮询要留足余量,否则每一轮都被自己掐断。 */
  timeoutMs?: number;
}

export class IpcClient {
  constructor(private readonly opts: IpcClientOptions) {}

  /**
   * 长轮询拉取。`waitMs` 是**服务端**挂起的时长;客户端超时必须明显更长,
   * 否则每一轮都在服务端还挂着的时候被自己掐断 —— iLink 那边踩过一模一样的坑
   * (默认 15 秒超时撞上 30 秒长轮询,每次都被中断)。
   */
  async pull(waitMs: number): Promise<ParsedPull | undefined> {
    const body = await this.post("/pull", { schema: IPC_SCHEMA, waitMs }, waitMs + 10_000);
    return parsePull(body);
  }

  /** 确认这些消息已经落进本进程的队列。**此时信使才出队。** */
  async ack(msgIds: readonly string[]): Promise<void> {
    if (!msgIds.length) return;
    await this.post("/ack", { schema: IPC_SCHEMA, msgIds });
  }

  /** 读不懂这些消息。信使据此亮红灯 —— 契约漂移必须看得见。 */
  async nack(msgIds: readonly string[], reason: string): Promise<void> {
    if (!msgIds.length) return;
    await this.post("/nack", { schema: IPC_SCHEMA, msgIds, reason });
  }

  async send(userKey: string, kind: SendKind, text: string): Promise<SendResult> {
    const body = await this.post("/send", { schema: IPC_SCHEMA, userKey, kind, text });
    const parsed = parseSendResult(body);
    // 读不懂信使的回复时按"没发出去、也没有额度"处理:**宁可少发,不可超发**。
    return parsed ?? { schema: IPC_SCHEMA, ok: false, remainingProgress: 0, reason: "信使的回复读不懂" };
  }

  /** 代理 dashboard 的账号管理等控制面。 */
  async admin(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<unknown> {
    return await this.send_(method, `/admin${path}`, body, timeoutMs);
  }

  private post(path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    return this.send_("POST", path, body, timeoutMs);
  }

  private send_(
    method: string,
    path: string,
    body: unknown,
    timeoutMs = this.opts.timeoutMs ?? 15_000,
  ): Promise<unknown> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    return new Promise((resolve, reject) => {
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
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            // 状态码不参与判定:信使用 body 里的 ok/reason 说话,而 4xx 的 body
            // 同样有意义(比如 send 的 ok=false + reason)。只有解析不了才算失败。
            try {
              resolve(text ? JSON.parse(text) : undefined);
            } catch {
              reject(new Error(`信使返回的不是 JSON(${res.statusCode}):${text.slice(0, 200)}`));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`IPC 超时(${timeoutMs}ms) ${method} ${path}`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}
