import type { PrefsStore, UserPrefsPatch } from "../core/prefs.js";
import type { GlobalSettings, SettingsPatch } from "../core/settings.js";
import type { UserRegistry } from "../core/users.js";
import { describeSettings, SETTING_SCHEMA, USER_SETTING_KEYS } from "../core/settings.js";
import { BUILTIN_ADMIN_USER_KEY } from "../core/identity.js";
import type { ApiResult } from "./api-self.js";

/**
 * `/api/settings` 与 `/api/users` —— 管理员改全局配置、代改任意用户的配置。
 *
 * 鉴权用 dashboard 的 admin 令牌,**只认 `X-Catman-Token` 请求头**(见 auth.ts:
 * 认 Cookie 的写接口会被外部页面诱导触发)。调用方由 server.ts 校验后才进来。
 *
 * 代改他人配置是刻意提供的恢复通道:用户把自己的设置弄成一团时,管理员能在
 * 聊天里一句话清掉。虽然 schema 的写入校验已经挡住了绝大多数自锁,但留一条
 * 人工路径符合「不能失去修复能力」这条原则。
 */

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const err = (status: number, message: string): ApiResult => ({ status, body: { error: message } });

export interface AdminApiDeps {
  settings: GlobalSettings;
  prefs: PrefsStore;
  users: UserRegistry;
}

/** 本模块认领的路径。 */
export function isAdminApiPath(path: string): boolean {
  return (
    path === "/api/settings" || path === "/api/users" || path.startsWith("/api/users/")
  );
}

export function handleAdminApi(
  method: string,
  path: string,
  body: unknown,
  deps: AdminApiDeps,
): ApiResult {
  const allKeys = Object.keys(SETTING_SCHEMA) as (keyof typeof SETTING_SCHEMA)[];

  if (path === "/api/settings" && method === "GET") {
    const effective = deps.settings.effective();
    return ok({
      effective,
      overrides: deps.settings.overrides(),
      schema: describeSettings(allKeys, { modelAllowlist: effective.modelAllowlist }),
    });
  }

  if (path === "/api/settings" && method === "PATCH") {
    if (!isPlainObject(body)) return err(400, "请求体需要是一个 JSON 对象");
    try {
      const effective = deps.settings.set(body as SettingsPatch);
      return ok({ ok: true, effective, overrides: deps.settings.overrides() });
    } catch (e) {
      return err(400, (e as Error).message);
    }
  }

  if (path === "/api/users" && method === "GET") {
    const users = deps.users.snapshot();
    const out = Object.entries(users).map(([userKey, rec]) => ({
      userKey,
      ...rec,
      isAdmin: deps.settings.isAdmin(userKey),
      prefs: { effective: deps.prefs.effective(userKey), overrides: deps.prefs.get(userKey) },
    }));
    return ok(out);
  }

  const one = path.match(/^\/api\/users\/(.+)$/);
  if (one?.[1] && method === "PATCH") {
    const userKey = decodeURIComponent(one[1]);
    if (!deps.users.get(userKey)) return err(404, `用户 ${userKey} 不存在`);
    if (!isPlainObject(body)) return err(400, "请求体需要是一个 JSON 对象");
    const input = body as Record<string, unknown>;
    try {
      if (input["clear"] === true) {
        return ok({ ok: true, prefs: { effective: deps.prefs.clear(userKey), overrides: {} } });
      }
      const { displayName, admin, clear: _clear, ...rest } = input;
      // 先把能白盒判的都判完再动手写:一次 PATCH 要么整批生效要么整批不生效。
      if (displayName !== undefined && typeof displayName !== "string") {
        return err(400, "displayName 需要是字符串");
      }
      if (admin !== undefined && typeof admin !== "boolean") {
        return err(400, "admin 需要是 true 或 false");
      }
      if (admin === false && userKey === BUILTIN_ADMIN_USER_KEY) {
        return err(400, `${BUILTIN_ADMIN_USER_KEY} 是内置管理员,不可撤销 —— 它是配置改坏后的恢复通道`);
      }
      const unknown = Object.keys(rest).filter(
        (k) => !(USER_SETTING_KEYS as readonly string[]).includes(k),
      );
      if (unknown.length) {
        return err(400, `${unknown.join("、")} 不是可代改的用户配置项(全局项请改 /api/settings)`);
      }
      const effective = Object.keys(rest).length
        ? deps.prefs.set(userKey, rest as UserPrefsPatch)
        : deps.prefs.effective(userKey);
      if (typeof admin === "boolean") setAdmin(userKey, admin, deps);
      if (typeof displayName === "string") deps.users.setDisplayName(userKey, displayName);
      return ok({
        ok: true,
        isAdmin: deps.settings.isAdmin(userKey),
        prefs: { effective, overrides: deps.prefs.get(userKey) },
        displayName: deps.users.get(userKey)?.displayName,
      });
    } catch (e) {
      return err(400, (e as Error).message);
    }
  }

  return err(404, `未知接口 ${method} ${path}`);
}

/**
 * 增删 adminUserKeys 里的一项。
 *
 * 名单由**服务端**照当前值算出来,而不是让调用方提交整份新名单 ——
 * "把这个人设为管理员"是意图,提交整份名单则要求调用方先读一遍再写回,
 * 两个人同时操作时后写的会把先写的抹掉。这里没有那个窗口。
 *
 * 内置管理员不在这份名单里(schema 的 validate 直接拒收),所以给它 admin:true
 * 是幂等的空操作 —— 它本来就是管理员。
 */
function setAdmin(userKey: string, admin: boolean, deps: AdminApiDeps): void {
  if (userKey === BUILTIN_ADMIN_USER_KEY) return;
  const current = deps.settings.effective().adminUserKeys;
  const next = admin
    ? current.includes(userKey)
      ? current
      : [...current, userKey]
    : current.filter((k) => k !== userKey);
  if (next !== current) deps.settings.set({ adminUserKeys: next });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
