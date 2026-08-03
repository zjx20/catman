import type { PrefsStore, UserPrefsPatch } from "../core/prefs.js";
import type { SessionManager } from "../core/session.js";
import type { GlobalSettings } from "../core/settings.js";
import type { TurnTokens } from "../core/turn-tokens.js";
import type { UserRegistry } from "../core/users.js";
import { COMMAND_TABLE } from "../core/commands.js";
import { describeSettings, USER_SETTING_KEYS } from "../core/settings.js";
import { encodeProjectDir, listSessionsAcross } from "../core/transcript.js";

/**
 * `/api/me` —— agent 管理**自己这个用户**的配置。
 *
 * 鉴权用回合令牌(请求头 `X-Catman-Session`),它由网关在每个回合开始时铸造、
 * 结束时作废,且只解析得出发起该回合的那个 userKey。所以这里拿不到"改谁"这个
 * 参数 —— 身份完全由令牌决定,不接受调用方指定。这是"不得干预其他用户"最
 * 直接的落地方式:没有可以填错的参数。
 *
 * 与 auth.ts 的 admin 令牌**刻意用不同的请求头名**:两种凭据作用域不同,
 * 同名迟早会写出"该收 session 的地方收了 admin"这种错。
 *
 * 路由与鉴权做成纯函数(不碰 req/res),server.ts 只做 IO 适配 ——
 * 与 auth.ts / ui.ts 的拆法一致,测试因此不必起真实 server。
 */

export const SESSION_HEADER = "x-catman-session";

export interface SelfApiDeps {
  turns: TurnTokens;
  prefs: PrefsStore;
  users: UserRegistry;
  sessions: SessionManager;
  settings: GlobalSettings;
  configDir: string;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const err = (status: number, message: string): ApiResult => ({ status, body: { error: message } });

/** 本模块认领的路径前缀。server.ts 据此分流。 */
export function isSelfApiPath(path: string): boolean {
  return path === "/api/me" || path.startsWith("/api/me/");
}

export function handleSelfApi(
  method: string,
  path: string,
  token: string | undefined,
  body: unknown,
  deps: SelfApiDeps,
): ApiResult {
  const ctx = token ? deps.turns.resolve(token) : undefined;
  if (!ctx) return err(401, "需要有效的 X-Catman-Session 请求头(回合令牌只在本回合内有效)");
  const userKey = ctx.userKey;

  if (path === "/api/me" && method === "GET") {
    return ok(describeMe(userKey, deps));
  }

  if (path === "/api/me" && method === "PATCH") {
    return patchMe(userKey, body, deps);
  }

  if (path === "/api/me/session/reset" && method === "POST") {
    // 与用户发 /新会话 完全一样的两步:本回合切到后台(它继续跑完,产出进
    // history 而不是 current),当前会话就地归档。立刻生效 —— 不再需要
    // "打个标记等回合自己收尾",因为 detached 的回合本就不会写回 current。
    ctx.detached = true;
    deps.sessions.archiveCurrent(userKey);
    return ok({
      ok: true,
      effective: "已生效:下一条消息就是新对话;这一轮我在后台跑完再把结果发出去",
    });
  }

  if (path === "/api/me/sessions" && method === "GET") {
    const projectDir = encodeProjectDir(deps.users.workspaceDirOf(userKey));
    return ok(listSessionsAcross(deps.configDir, [{ projectDir, userKey }]));
  }

  return err(404, `未知接口 ${method} ${path}`);
}

function describeMe(userKey: string, deps: SelfApiDeps): unknown {
  const globals = deps.settings.effective();
  const effective = deps.prefs.effective(userKey);
  const idleMs = deps.sessions.idleMsOf(userKey);
  const state = deps.sessions.snapshot()[userKey];
  const rec = deps.users.get(userKey);

  return {
    identity: {
      userKey,
      displayName: rec?.displayName ?? "",
      isAdmin: deps.settings.isAdmin(userKey),
      workspace: deps.users.workspaceDirOf(userKey),
      createdAt: rec?.createdAt,
      lastSeenAt: rec?.lastSeenAt,
    },
    session: {
      sessionId: state?.current?.sessionId,
      idleMs,
      // 空闲未超时就会接着聊;超时了要 /继续 才续,否则下一条开新对话。
      willResume: idleMs !== undefined && idleMs < effective.sessionTimeoutMs,
      // 归档的旧会话(新→旧)。用户问"帮我切回之前那段"时,助手可凭这份
      // 名单告诉他该发哪条 /切换会话 指令 —— 切换本身仍走硬指令,不开写接口。
      history: state?.history ?? [],
    },
    prefs: { effective, overrides: deps.prefs.get(userKey) },
    schema: describeSettings(USER_SETTING_KEYS, { modelAllowlist: globals.modelAllowlist }),
    commands: COMMAND_TABLE.map((c) => ({
      canonical: c.canonical,
      aliases: c.aliases,
      desc: c.desc,
    })),
  };
}

function patchMe(userKey: string, body: unknown, deps: SelfApiDeps): ApiResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return err(400, "请求体需要是一个 JSON 对象");
  }
  const input = body as Record<string, unknown>;
  const { displayName, ...rest } = input;

  // 先把能白盒判的都判完再动手写:一次 PATCH 要么整批生效要么整批不生效,
  // 不能出现"名字改了、模型没改"的半截状态。
  if (displayName !== undefined && typeof displayName !== "string") {
    return err(400, "displayName 需要是字符串");
  }
  if (displayName !== undefined && !deps.users.get(userKey)) {
    return err(404, "用户尚未注册");
  }

  try {
    // prefs 的校验在 set() 内部,失败会抛 —— 放在最前面,让它先于任何写入。
    const effective = Object.keys(rest).length
      ? deps.prefs.set(userKey, rest as UserPrefsPatch)
      : deps.prefs.effective(userKey);
    if (typeof displayName === "string") deps.users.setDisplayName(userKey, displayName);
    return ok({
      ok: true,
      // 返回生效值而不是回显入参:数值项可能被夹到上下限,agent 要照这个告诉用户。
      prefs: { effective, overrides: deps.prefs.get(userKey) },
      displayName: deps.users.get(userKey)?.displayName,
    });
  } catch (e) {
    return err(400, (e as Error).message);
  }
}
