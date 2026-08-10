import type { PublicAccount } from "../core/accounts.js";
import type { LoginPollResult, LoginSession, LoginTarget } from "../channels/ilink-login.js";
import type { IpcClient } from "../ipc/client.js";
import { PROXY_TIMEOUT_MS } from "../courier/admin-api.js";
import type { AccountsGateway } from "./server.js";

/**
 * 账号控制面的 IPC 代理:dashboard 说什么,信使做什么。
 *
 * ## 为什么一条都不能留在人格里
 *
 * `accounts.json` 只能有一个写者。人格进程里只要还留着一个 `AccountStore` 实例,
 * 它就握着一份可能过时的内存快照 —— 而那个类的每次写都是**整份覆写**。
 * 症状是"扫了码过一会儿又掉了"或"改的备注名自己变回去了",且**没有任何报错**。
 * 评审把这条列为 fatal,所以这里是全代理,不是"大部分代理"。
 *
 * ## 超时
 *
 * 扫码是长轮询(无人扫码时服务端阻塞约 30 秒),所以超时用 `PROXY_TIMEOUT_MS` ——
 * 与信使侧引用**同一个常量**。两边各定一个的下场是真机上"每次扫码都超时",
 * 而两个数字看起来都挺合理。
 */
export class IpcAccountsProxy implements AccountsGateway {
  constructor(private readonly client: IpcClient) {}

  async list(): Promise<PublicAccount[]> {
    const r = (await this.call("GET", "/accounts")) as { accounts?: unknown };
    return Array.isArray(r?.accounts) ? (r.accounts as PublicAccount[]) : [];
  }

  async exists(accountId: string): Promise<boolean> {
    return (await this.list()).some((a) => a.accountId === accountId);
  }

  async rename(accountId: string, displayName: string): Promise<boolean> {
    return this.okOf(
      await this.call("POST", `/accounts/${encodeURIComponent(accountId)}/rename`, { displayName }),
    );
  }

  async unbind(accountId: string): Promise<boolean> {
    return this.okOf(await this.call("POST", `/accounts/${encodeURIComponent(accountId)}/unbind`));
  }

  async remove(accountId: string): Promise<boolean> {
    return this.okOf(await this.call("DELETE", `/accounts/${encodeURIComponent(accountId)}`));
  }

  async loginStart(target: LoginTarget): Promise<LoginSession> {
    return (await this.call("POST", "/login/start", target)) as LoginSession;
  }

  async loginPoll(loginId: string): Promise<LoginPollResult> {
    return (await this.call("POST", "/login/poll", { loginId })) as LoginPollResult;
  }

  private call(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.client.admin(method, path, body, PROXY_TIMEOUT_MS);
  }

  /** 信使用 `{ok:true}` 表示做成了;读不出就当没做成 —— 别对用户谎报成功。 */
  private okOf(v: unknown): boolean {
    return !!v && typeof v === "object" && (v as { ok?: unknown }).ok === true;
  }
}
