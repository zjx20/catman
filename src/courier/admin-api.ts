import type { AccountStore } from "../core/accounts.js";
import type { ILinkLogin } from "../channels/ilink-login.js";
import type { AdminResponse } from "../ipc/server.js";
import type { RoutingTable } from "./routing.js";
import type { ReplyStore } from "./reply-store.js";

/**
 * 信使的控制面,供人格的 dashboard **代理**。
 *
 * ## 为什么必须代理而不是让人格直接读写
 *
 * `accounts.json` 只能有一个写者。人格进程里只要还留着一个 `AccountStore` 实例,
 * 它就握着一份可能已经过时的内存快照,而任何一次写都是**整份覆写** ——
 * 表现是"扫了码过一会儿又掉了"或者"改的备注名自己变回去了",且没有任何报错。
 * 评审把这条列为 fatal。所以人格侧一行 accounts 代码都不留,全部走这里。
 *
 * ## 超时
 *
 * 扫码是长轮询(`get_qrcode_status` 无人扫码时阻塞约 30 秒,见 ilink-login),
 * 所以代理端的超时必须**明显大于**它 —— 常量在 `PROXY_TIMEOUT_MS`,人格侧引用同一个,
 * 免得两边各定一个然后在真机上表现为"每次扫码都超时"。
 */

/** 人格代理这些接口时该用的超时。扫码长轮询 60s + 余量。 */
export const PROXY_TIMEOUT_MS = 90_000;

export interface CourierAdminDeps {
  accounts: AccountStore;
  login: ILinkLogin;
  routing: RoutingTable;
  replies: ReplyStore;
}

/**
 * 路由 + 分发。返回的是 `(method, path, body)` 形式的处理器,
 * 由 `ipc/server.ts` 在剥掉 `/admin` 前缀之后调用。
 */
export function courierAdmin(
  deps: CourierAdminDeps,
): (method: string, path: string, body: unknown) => Promise<AdminResponse> {
  return async (method, path, body) => {
    const seg = path.split("/").filter(Boolean);
    const b = (body ?? {}) as Record<string, unknown>;
    const str = (k: string): string => (typeof b[k] === "string" ? (b[k] as string) : "");

    // GET /accounts —— 列表。**只出 PublicAccount**:botToken 不该跨进程传,
    // 人格拿到也没用,而多一份复制就多一处泄漏面。
    if (method === "GET" && seg[0] === "accounts" && seg.length === 1) {
      return ok({ accounts: deps.accounts.listPublic() });
    }

    if (method === "POST" && seg[0] === "accounts" && seg.length === 3) {
      const id = seg[1]!;
      switch (seg[2]) {
        case "unbind":
          return deps.accounts.unbind(id)
            ? ok({ ok: true })
            : notFound(id);
        case "rename":
          return deps.accounts.rename(id, str("displayName"))
            ? ok({ ok: true })
            : notFound(id);
        default:
          break;
      }
    }

    if (method === "DELETE" && seg[0] === "accounts" && seg.length === 2) {
      const id = seg[1]!;
      if (!deps.accounts.remove(id)) return notFound(id);
      // 账号没了,它的回复上下文也该没:留着的话换人之后会拿旧 token 往新用户发信。
      for (const r of deps.routing.snapshot()) {
        if (r.userKey.split(":")[1] === id) deps.replies.forget(r.userKey);
      }
      return ok({ ok: true });
    }

    // 扫码:start 拿二维码,poll 长轮询等结果。两者都在信使里跑 ——
    // 它是 AccountStore 的唯一写者,而扫码成功那一刻正是要写它。
    if (method === "POST" && seg[0] === "login" && seg[1] === "start") {
      // 备注名在**扫码之前**定(见 ILinkLogin 的说明):多账号时二维码之间没有任何
      // 区别,扫完再回头认"刚才那个是谁"最容易配错人。重新扫码则给 rebindAccountId。
      const rebind = str("rebindAccountId");
      return ok(
        await deps.login.start({
          displayName: str("displayName"),
          ...(rebind ? { rebindAccountId: rebind } : {}),
        }),
      );
    }
    if (method === "POST" && seg[0] === "login" && seg[1] === "poll") {
      return ok(await deps.login.poll(str("loginId")));
    }

    // GET /routes —— 谁被切到了哪个人格。状态页与 `/状态` 都要看它。
    if (method === "GET" && seg[0] === "routes") {
      return ok({ routes: deps.routing.snapshot() });
    }

    return { status: 404, body: { ok: false, reason: `未知 admin 端点 ${method} ${path}` } };
  };
}

function ok(body: unknown): AdminResponse {
  return { status: 200, body };
}

function notFound(id: string): AdminResponse {
  return { status: 404, body: { ok: false, reason: `账号 ${id} 不存在` } };
}
