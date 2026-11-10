import type { IncomingMessage, ServerResponse } from "node:http";
import { EnvHttpProxyAgent, request } from "undici";
import { writeJsonFileAtomic } from "../file-store.js";
import type { RuntimeManager, RuntimeRecord } from "./runtime.js";
import { readExecutionState } from "./contexts.js";

export interface SharedEndpoint { url: string; headers?: Record<string, string>; adminOnly?: boolean; methods?: string[] }
export interface SharedTools { mcp: Record<string, SharedEndpoint>; services: Record<string, SharedEndpoint> }
const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** Secrets stay in the control plane. A worker gets permission to invoke a named service. */
export class CapabilityBroker {
  private tools: SharedTools;
  private readonly sessions = new Map<string, string>();
  private readonly dispatcher = new EnvHttpProxyAgent({ noProxy: ["localhost", "127.0.0.1", process.env.NO_PROXY ?? process.env.no_proxy ?? ""].join(",") });
  constructor(private readonly path: string, private readonly runtimes: RuntimeManager, private readonly isAdmin: (userKey: string) => boolean) {
    this.tools = readExecutionState<SharedTools>(path, { mcp: {}, services: {} });
    this.validate(this.tools);
  }
  configure(value: SharedTools): void { this.validate(value); writeJsonFileAtomic(this.path, value, 0o600); this.tools = structuredClone(value); }
  async close(): Promise<void> { await this.dispatcher.close(); }
  describe() {
    const redact = (map: Record<string, SharedEndpoint>) => Object.fromEntries(Object.entries(map).map(([name, endpoint]) => [name, {
      url: endpoint.url, adminOnly: endpoint.adminOnly ?? false, methods: endpoint.methods,
      headerNames: Object.keys(endpoint.headers ?? {}),
    }]));
    return { mcp: redact(this.tools.mcp), services: redact(this.tools.services) };
  }
  mcpServers(r: RuntimeRecord, apiBase: string) {
    return Object.fromEntries(Object.entries(this.tools.mcp).filter(([, e]) => !e.adminOnly || this.isAdmin(r.userKey)).map(([name]) => [name, {
      type: "http" as const, url: `${apiBase}/api/runtime/mcp/${name}`, headers: { "X-Catman-Runtime": r.token },
    }]));
  }
  private validate(value: SharedTools): void {
    if (!value || typeof value !== "object" || !value.mcp || !value.services) throw new Error("公共能力配置必须包含 mcp 和 services");
    for (const map of [value.mcp, value.services]) {
      for (const [name, e] of Object.entries(map)) {
        if (!NAME.test(name) || !e || typeof e.url !== "string") throw new Error("公共能力名称或 URL 无效");
        const url = new URL(e.url);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error("公共能力必须使用 HTTP(S) URL，凭据放 headers，URL 不含查询参数");
        if (e.headers && Object.entries(e.headers).some(([k, v]) => !/^[a-zA-Z0-9-]+$/.test(k) || typeof v !== "string" || /[\r\n]/.test(v))) throw new Error("公共能力 headers 无效");
        if (e.methods && (!Array.isArray(e.methods) || e.methods.some(m => !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(m)))) throw new Error("methods 无效");
      }
    }
  }
  async proxy(req: IncomingMessage, res: ServerResponse, r: RuntimeRecord, path: string): Promise<void> {
    const rest = path.slice("/api/runtime/".length).split("/");
    const kind = rest.shift();
    let target: URL; let credentialHeaders: Record<string, string> = {}; let sessionKey: string | undefined;
    if (kind === "model") {
      const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
      const suffix = rest.join("/");
      if (!/^v1\/(messages|models)(\/count_tokens)?$/.test(suffix)) throw new Error("模型接口未授权");
      target = new URL(`${base}/${suffix}`);
      if (process.env.ANTHROPIC_API_KEY) credentialHeaders["x-api-key"] = process.env.ANTHROPIC_API_KEY;
      else {
        const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
        if (!token) throw new Error("控制面未配置模型凭据");
        credentialHeaders.authorization = `Bearer ${token}`;
      }
    } else {
      const name = rest.shift() ?? "";
      const endpoint = kind === "mcp" ? this.tools.mcp[name] : kind === "services" ? this.tools.services[name] : undefined;
      if (!endpoint || (endpoint.adminOnly && !this.isAdmin(r.userKey))) throw new Error("公共能力未授权");
      if (endpoint.methods && !endpoint.methods.includes(req.method ?? "GET")) throw new Error("此方法未授权");
      // Paths cannot change the pinned upstream origin or escape its configured base path.
      const suffix = rest.join("/");
      if (suffix.includes("..") || /%2e|%2f|%5c|\\/i.test(suffix)) throw new Error("公共能力路径无效");
      target = new URL(endpoint.url.replace(/\/$/, "") + (suffix ? `/${suffix}` : ""));
      credentialHeaders = endpoint.headers ?? {};
      if (kind === "mcp") sessionKey = `${r.container}:${name}`;
    }
    const incomingUrl = new URL(req.url!, "http://localhost");
    for (const [key, value] of incomingUrl.searchParams) target.searchParams.append(key, value);
    const headers: Record<string, string | string[]> = {};
    const allowed = new Set(["content-type", "accept", "user-agent", "x-app", "anthropic-version", "anthropic-beta", "mcp-protocol-version", "last-event-id"]);
    for (const [key, value] of Object.entries(req.headers)) if (allowed.has(key) && value) headers[key] = value;
    Object.assign(headers, credentialHeaders);
    if (kind === "model" && process.env.CLAUDE_CODE_OAUTH_TOKEN && !String(headers["anthropic-beta"] ?? "").includes("oauth-2025-04-20")) {
      headers["anthropic-beta"] = [headers["anthropic-beta"], "oauth-2025-04-20"].filter(Boolean).join(",");
    }
    if (sessionKey && this.sessions.has(sessionKey)) headers["mcp-session-id"] = this.sessions.get(sessionKey)!;
    const abort = new AbortController();
    req.once("aborted", () => abort.abort()); res.once("close", () => { if (!res.writableEnded) abort.abort(); });
    const response = await request(target, { dispatcher: this.dispatcher, method: req.method as "GET", headers,
      body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : req, signal: abort.signal,
      headersTimeout: 120_000, bodyTimeout: 120_000 });
    if (sessionKey && response.statusCode === 404) this.sessions.delete(sessionKey);
    if (sessionKey && typeof response.headers["mcp-session-id"] === "string") this.sessions.set(sessionKey, response.headers["mcp-session-id"]);
    const responseHeaders = Object.fromEntries(Object.entries(response.headers).filter(([k]) => !["set-cookie", "connection", "transfer-encoding", "mcp-session-id"].includes(k)));
    res.writeHead(response.statusCode, responseHeaders);
    await new Promise<void>((resolve, reject) => { response.body.once("error", reject); response.body.once("end", resolve); response.body.pipe(res); });
  }
}
