import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import {
  listSessionsAcross,
  readSession,
  searchAcross,
  type ProjectScope,
} from "../core/transcript.js";
import { listWorkspaceDirs, type UserRegistry } from "../core/users.js";
import type { AccountStore } from "../core/accounts.js";
import type { ILinkLogin } from "../channels/ilink-login.js";
import type { DashboardChannel } from "../channels/dashboard.js";
import { renderPage, type UserRow } from "./ui.js";
import { DashboardAuth, urlWithoutToken } from "./auth.js";
import { handleSelfApi, isSelfApiPath, SESSION_HEADER, type SelfApiDeps } from "./api-self.js";
import { handleAdminApi, isAdminApiPath, type AdminApiDeps } from "./api-admin.js";
import { buildHealth, isHealthPath, type HealthDeps } from "./health.js";

/**
 * dashboard。整站需要 token(见 auth.ts:会话记录本身就是敏感内容)。
 *
 * 只读(admin token,Cookie / ?token= / 请求头皆可):
 *   GET  /                          会话列表页(按用户分组)
 *   GET  /session/<id>              会话详情页
 *   GET  /users                     用户与权限页(提权在这里点)
 *   GET  /accounts                  账号管理页
 *   GET  /chat                      管理员聊天页
 *   GET  /api/sessions              会话列表(JSON)
 *   GET  /api/session/<id>          单会话消息(JSON)
 *   GET  /api/search?q=...          检索(JSON)
 *   GET  /api/chat/stream           聊天回复推送(SSE,支持 Last-Event-ID 补发)
 * 写(admin token,**只认 X-Catman-Token 请求头**):
 *   POST   /api/chat                        向管理员 agent 发消息
 *   GET/PATCH /api/settings                 全局配置
 *   GET    /api/users                       用户列表(含各自的 prefs)
 *   PATCH  /api/users/<userKey>             代改某人的 prefs / 展示名 / 管理员权限
 *   POST   /api/accounts/login/start        申请二维码(可带备注名;带 rebindAccountId
 *                                           则是重新扫码 —— 凭据换掉、账号与绑定不变)
 *   PATCH  /api/accounts/<id>               改账号备注名
 *   POST   /api/accounts/login/<loginId>    查询扫码状态;确认后建账号/替换凭据并拉起连接
 *   POST   /api/accounts/<id>/unbind        解除 TOFU 绑定
 *   DELETE /api/accounts/<id>               移除账号(不删会话数据)
 * 回合令牌(**X-Catman-Session**,与 admin token 不互通):
 *   GET/PATCH /api/me                       agent 读写自己这个用户的配置
 *   POST   /api/me/session/reset            本回合结束后开新会话
 *   GET    /api/me/sessions                 自己的历史会话
 * 无鉴权(只有标量与版本号,见 health.ts):
 *   GET    /health                          部署流水线的健康门/排水门/版本确证
 *
 * ⚠️ **`/api/me` 与 `/health` 必须在 admin 读闸门之前分发。** handle() 的第一件事
 * 是 allowsRead(),回合令牌与 deployer 都过不了那道闸 —— 放到后面会静默 401,
 * 且极难查。
 */

export interface DashboardOptions {
  /** CLAUDE_CONFIG_DIR。 */
  configDir: string;
  /** 各用户工作目录的父目录。 */
  workspaceRoot: string;
  port: number;
  adminToken: string;
  users: UserRegistry;
  accounts: AccountStore;
  login: ILinkLogin;
  /** 管理员聊天渠道。 */
  chat: DashboardChannel;
  selfApi: SelfApiDeps;
  adminApi: AdminApiDeps;
  /**
   * `/health` 的数据源。不传则不开这个端点 —— 单测里起 Dashboard 不必装配整个网关。
   */
  health?: HealthDeps;
}

export class Dashboard {
  private server?: Server;
  private readonly auth: DashboardAuth;
  /** 打开着的 SSE 响应。关闭时要先把它们收掉,见 stop()。 */
  private readonly streams = new Set<ServerResponse>();

  constructor(private readonly opts: DashboardOptions) {
    this.auth = new DashboardAuth(opts.adminToken);
  }

  start(): void {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.listen(this.opts.port, () => {
      console.info(`dashboard 监听 http://0.0.0.0:${this.opts.port}`);
    });
  }

  async stop(): Promise<void> {
    // SSE 是长连接,server.close() 会一直等它们结束 —— 不先收掉就永远不 resolve,
    // 进程卡在优雅关闭里出不去。
    for (const res of this.streams) res.end();
    this.streams.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  /**
   * 当前所有用户的 project 目录。真相源是 workspace 下的一级子目录 ——
   * 绝不 readdir(projects/),否则 CLAUDE_CONFIG_DIR 指向共享 ~/.claude 时
   * 会把无关的 Claude Code 历史也列出来。
   */
  private scopes(): ProjectScope[] {
    return listWorkspaceDirs(this.opts.workspaceRoot).map((w) => {
      const userKey = this.opts.users.userKeyOfDir(w.dirName);
      return { projectDir: w.projectDir, ...(userKey ? { userKey } : {}) };
    });
  }

  /**
   * 用户页的行数据。三处拼起来:users.json(身份/时间)、settings(是否管理员)、
   * prefs(生效模型)。与 `GET /api/users` 同源,只是裁到页面需要的字段。
   */
  private userRows(): UserRow[] {
    const { settings, prefs } = this.opts.adminApi;
    return Object.entries(this.opts.users.snapshot()).map(([userKey, rec]) => ({
      userKey,
      displayName: rec.displayName,
      channel: rec.channel,
      isAdmin: settings.isAdmin(userKey),
      model: prefs.effective(userKey).model,
      workspace: this.opts.users.workspaceDirOf(userKey),
      createdAt: rec.createdAt,
      lastSeenAt: rec.lastSeenAt,
    }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const isApi = path.startsWith("/api/");

    try {
      // ⚠️ /health 与 /api/me 一样,必须排在 admin 读闸门**之前**。
      // deployer 与看门狗拿不到 admin token(那是用户的凭据,不该下放给部署机制),
      // 放到闸门后面会静默 401 —— 表现为"每次部署都在健康门超时",极难查。
      // 不鉴权的代价已在 health.ts 里控住:这份 payload 只有标量与版本号。
      if (isHealthPath(path) && this.opts.health) {
        return json(res, buildHealth(this.opts.health));
      }

      // ⚠️ 回合令牌的接口必须排在 admin 读闸门**之前** —— 它过不了那道闸。
      if (isSelfApiPath(path)) {
        const raw = req.headers[SESSION_HEADER];
        const token = Array.isArray(raw) ? raw[0] : raw;
        const body = await readJsonBody(req);
        const r = handleSelfApi(req.method ?? "GET", path, token, body, this.opts.selfApi);
        res.writeHead(r.status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r.body, null, 2));
        return;
      }

      if (!this.auth.allowsRead(req, url)) {
        return isApi ? jsonError(res, 401, "未授权") : loginPage(res);
      }
      // ?token= 命中:换成 Cookie 并跳转,免得 token 留在地址栏和访问日志里。
      if (this.auth.shouldExchangeQueryToken(url) && !isApi) {
        res.writeHead(302, {
          location: urlWithoutToken(url),
          "set-cookie": this.auth.cookieHeader(),
        });
        res.end();
        return;
      }

      if (path.startsWith("/api/accounts")) {
        return await this.handleAccounts(req, res, path);
      }

      if (isAdminApiPath(path)) {
        // 读也要求请求头:这两个接口会暴露全部用户的配置,凭据强度按写操作对待。
        if (!this.auth.allowsWrite(req)) {
          return jsonError(res, 403, "需要 X-Catman-Token 请求头");
        }
        const body = await readJsonBody(req);
        const r = handleAdminApi(req.method ?? "GET", path, body, this.opts.adminApi);
        res.writeHead(r.status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(r.body, null, 2));
        return;
      }

      if (path === "/api/chat" && req.method === "POST") {
        // 发消息给管理员 agent 是最高权限的写操作 —— 只认请求头(见 auth.ts 的 CSRF 说明)。
        if (!this.auth.allowsWrite(req)) {
          return jsonError(res, 403, "写操作需要 X-Catman-Token 请求头");
        }
        const body = await readJsonBody(req);
        const text = isObject(body) && typeof body["text"] === "string" ? body["text"].trim() : "";
        if (!text) return jsonError(res, 400, "缺少 text");
        // 不 await 处理完成:一个回合可能跑很久,回复走 SSE 推。
        void this.opts.chat.receive(text);
        return json(res, { ok: true });
      }

      if (path === "/api/chat/stream") {
        return this.streamChat(req, res, url);
      }

      if (path === "/api/sessions") {
        return json(res, listSessionsAcross(this.opts.configDir, this.scopes()));
      }
      if (path.startsWith("/api/session/")) {
        const id = decodeURIComponent(path.slice("/api/session/".length));
        return json(res, this.readSessionAnywhere(id, url.searchParams.get("p")));
      }
      if (path === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        return json(res, searchAcross(this.opts.configDir, this.scopes(), q));
      }
      if (path.startsWith("/session/")) {
        const id = decodeURIComponent(path.slice("/session/".length));
        return html(
          res,
          renderPage("session", {
            sessionId: id,
            entries: this.readSessionAnywhere(id, url.searchParams.get("p")),
          }),
        );
      }
      if (path === "/chat") {
        return html(
          res,
          renderPage("chat", {
            history: this.opts.chat.history(),
            token: this.opts.adminToken,
            lastId: this.opts.chat.lastId(),
          }),
        );
      }
      if (path === "/users") {
        return html(res, renderPage("users", { users: this.userRows(), token: this.opts.adminToken }));
      }
      if (path === "/accounts") {
        return html(
          res,
          renderPage("accounts", {
            accounts: this.opts.accounts.listPublic(),
            token: this.opts.adminToken,
          }),
        );
      }
      if (path === "/") {
        return html(
          res,
          renderPage("list", {
            sessions: listSessionsAcross(this.opts.configDir, this.scopes()),
            users: this.opts.users.snapshot(),
          }),
        );
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (err) {
      console.error("[dashboard] 请求处理失败:", err);
      if (isApi) return jsonError(res, 500, (err as Error).message);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`error: ${(err as Error).message}`);
    }
  }

  /**
   * 按 sessionId 找会话。多用户下 sessionId 不再唯一定位到某个 project 目录,
   * 页面会带上 ?p= 作为提示 —— 但**只把它当过滤条件**,必须先在已知 scope 里
   * 命中才使用,绝不直接当路径拼接(否则就是一个目录穿越入口)。
   */
  private readSessionAnywhere(sessionId: string, hint: string | null) {
    const scopes = this.scopes();
    const ordered = hint ? scopes.filter((s) => s.projectDir === hint).concat(scopes) : scopes;
    for (const scope of ordered) {
      const entries = readSession(this.opts.configDir, scope.projectDir, sessionId);
      if (entries.length) return entries;
    }
    return [];
  }

  /**
   * 聊天回复的 SSE 推送。
   *
   * 补发起点有两个来源:**重连**时浏览器自带 Last-Event-ID;**首次连接**没有,
   * 由页面把首屏水位放进 ?after= —— 否则服务端会把页面刚渲染完的历史再推一遍。
   * 请求头优先:它是浏览器维护的、更准。心跳是为了穿过会掐死空闲连接的反向代理。
   */
  private streamChat(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const raw = req.headers["last-event-id"];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const lastId = Number(header ?? url.searchParams.get("after") ?? 0);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // 反向代理的缓冲会把 SSE 攒成一坨,失去实时性。
      "x-accel-buffering": "no",
    });
    this.streams.add(res);

    const unsubscribe = this.opts.chat.subscribe((ev) => {
      if (ev.type === "delete") {
        // 撤回帧**不写 id:** —— 浏览器会把 id: 记成 Last-Event-ID,
        // 那样重连的起点就被拉回到刚被删掉的那条上,已推过的消息会重来一遍。
        res.write(`event: delete\ndata: ${JSON.stringify({ id: ev.id })}\n\n`);
        return;
      }
      res.write(`id: ${ev.msg.id}\ndata: ${JSON.stringify(ev.msg)}\n\n`);
    }, Number.isFinite(lastId) ? lastId : 0);

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    heartbeat.unref?.();
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      this.streams.delete(res);
    };
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  private async handleAccounts(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<void> {
    // 账号相关全是写操作,一律要求请求头(防 CSRF,见 auth.ts)。
    if (!this.auth.allowsWrite(req)) {
      return jsonError(res, 403, "写操作需要 X-Catman-Token 请求头");
    }

    if (path === "/api/accounts/login/start" && req.method === "POST") {
      // 目标在扫码**之前**定:二维码之间没有任何区别,扫完再回头认是谁最容易配错。
      const body = await readJsonBody(req);
      const name = isObject(body) && typeof body["displayName"] === "string" ? body["displayName"] : "";
      const rebind =
        isObject(body) && typeof body["rebindAccountId"] === "string" ? body["rebindAccountId"] : "";
      // 先验一次账号存在:扫完才发现目标没了,那三分钟就白等了。
      // 真正的判定仍在 poll() 里(账号可能在扫码期间被删),这里只是提前失败。
      if (rebind && !this.opts.accounts.get(rebind)) {
        return jsonError(res, 404, "账号不存在");
      }
      const session = await this.opts.login.start(
        rebind ? { rebindAccountId: rebind } : { displayName: name },
      );
      return json(res, session);
    }

    const rename = path.match(/^\/api\/accounts\/([^/]+)$/);
    if (rename?.[1] && req.method === "PATCH") {
      const body = await readJsonBody(req);
      if (!isObject(body) || typeof body["displayName"] !== "string") {
        return jsonError(res, 400, "需要 { displayName: string }(空串恢复默认名)");
      }
      const ok = this.opts.accounts.rename(decodeURIComponent(rename[1]), body["displayName"]);
      return ok ? json(res, { ok }) : jsonError(res, 404, "账号不存在");
    }

    const loginPoll = path.match(/^\/api\/accounts\/login\/([^/]+)$/);
    if (loginPoll?.[1] && req.method === "POST") {
      const result = await this.opts.login.poll(decodeURIComponent(loginPoll[1]));
      return json(res, result);
    }

    const unbind = path.match(/^\/api\/accounts\/([^/]+)\/unbind$/);
    if (unbind?.[1] && req.method === "POST") {
      const ok = this.opts.accounts.unbind(decodeURIComponent(unbind[1]));
      return ok ? json(res, { ok }) : jsonError(res, 404, "账号不存在");
    }

    const remove = path.match(/^\/api\/accounts\/([^/]+)$/);
    if (remove?.[1] && req.method === "DELETE") {
      const ok = this.opts.accounts.remove(decodeURIComponent(remove[1]));
      return ok ? json(res, { ok }) : jsonError(res, 404, "账号不存在");
    }

    if (path === "/api/accounts" && req.method === "GET") {
      return json(res, this.opts.accounts.listPublic());
    }

    return jsonError(res, 404, "未知的账号接口");
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 请求体上限。这些接口只收小 JSON,设个上限免得被一个大 body 撑爆内存。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 读并解析 JSON 请求体。GET/无体/非 JSON 一律返回 undefined,由路由自己报错。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(buf);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function jsonError(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

/** 未授权时的落地页:一个填 token 的表单,提交后走 ?token= 换 Cookie。 */
function loginPage(res: ServerResponse): void {
  res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>catman</title>
<style>body{font:14px/1.6 system-ui,sans-serif;background:#f6f7f9;display:flex;
justify-content:center;padding-top:15vh}form{background:#fff;border:1px solid #e5e7eb;
border-radius:8px;padding:24px}input{padding:8px 10px;border:1px solid #d1d5db;border-radius:6px}
button{padding:8px 14px;border:0;background:#2563eb;color:#fff;border-radius:6px;cursor:pointer}
</style></head><body><form method="get" action="/">
<p><b>需要访问令牌</b></p>
<p class="meta">值来自 CATMAN_ADMIN_TOKEN;未设置时启动日志里会打印自动生成的令牌。</p>
<p><input name="token" type="password" placeholder="访问令牌" autofocus> <button>进入</button></p>
</form></body></html>`);
}
