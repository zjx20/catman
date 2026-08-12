import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { AccountStore } from "../core/accounts.js";
import { accountAdmission } from "../core/admission.js";
import { parseUserKey } from "../core/identity.js";
import { installLogStamps } from "../core/log-stamp.js";
import { WechatILinkChannel } from "../channels/wechat-ilink.js";
import type { IncomingMessage } from "../channels/types.js";
import { ILinkLogin } from "../channels/ilink-login.js";
import { IpcServer } from "../ipc/server.js";
import { checkIpcSecret, PERSONA_IDS, type PersonaId } from "../ipc/protocol.js";
import { CourierCore } from "./core.js";
import { FileCursorStore } from "./cursors.js";
import { Inbox } from "./inbox.js";
import { ReplyStore } from "./reply-store.js";
import { RoutingTable } from "./routing.js";
import { SettingsView } from "./settings-view.js";
import { Spool } from "./spool.js";
import { courierAdmin } from "./admin-api.js";

/**
 * 信使进程的入口。
 *
 * ## 它是稳定面
 *
 * 跑**人工钦定的 pinned release**,极少更新(改它属 Tier 3)。两个人格都在它身后,
 * 所以它死了 = 微信全聋 —— 这个文件里的每一个决定都该往"起得来、不崩"那一侧倒:
 * 配置读不懂用默认、附件读不到跳过、人格不可达就缓冲,唯独**认证配错必须起不来**
 * (那种情况下起来了也只会把两个人格的队列串到一起,悄悄地)。
 *
 * ## 它是 accounts.json 的唯一写者
 *
 * 人格进程**完全不 import** `core/accounts.ts`(有单测守着)。两个进程各持一份内存
 * 快照的话,后写的那个会用陈旧数据整份覆写另一个刚写的 —— 表现是"扫了码过一会儿
 * 又掉了",而且没有任何报错。这是评审确认的 fatal。
 */
async function main(): Promise<void> {
  installLogStamps();
  const config = loadConfig();
  console.info("catman-courier 启动中");

  const dir = config.courierDir;
  mkdirSync(join(dir, "inbox"), { recursive: true });

  // ── 认证:配错必须起不来 ────────────────────────────────────────
  // 两个人格共用一个 secret、或者其中一个没配,后果是它们的 inbox 串到一起,
  // 而这件事**没有任何外部症状** —— 消息只是偶尔跑到另一个人格那儿去。
  // 所以宁可起不来,而且要在这里就说清哪个配错了。
  const secrets = new Map<string, PersonaId>();
  for (const persona of PERSONA_IDS) {
    const raw = process.env[`CATMAN_IPC_SECRET_${persona.toUpperCase()}`];
    const bad = checkIpcSecret(raw);
    if (bad) throw new Error(`CATMAN_IPC_SECRET_${persona.toUpperCase()} ${bad}`);
    if (secrets.has(raw!)) throw new Error("两个人格不能共用同一个 IPC secret —— 那会让它们的队列串到一起");
    secrets.set(raw!, persona);
  }

  const settings = new SettingsView(config.settingsPath);
  const accounts = new AccountStore(config.accountsPath);
  const replies = new ReplyStore(join(dir, "reply-ctx.json"));
  const spool = new Spool({ dir: join(dir, "spool") });
  const routing = new RoutingTable({ path: join(dir, "routes.json") });
  const inboxes = new Map<PersonaId, Inbox>(
    PERSONA_IDS.map((p) => [
      p,
      new Inbox({
        path: join(dir, "inbox", `${p}.jsonl`),
        // 溢出淘汰信封的同时清掉它引用的图片字节 —— 信封几百字节,图片好几 MB,
        // 只淘汰信封腾不出磁盘。
        onEvict: (env) => spool.drop(env.attachmentRefs.map((r) => r.id)),
      }),
    ]),
  );

  const channel = new WechatILinkChannel(
    accounts,
    () => settings.limits(),
    replies,
    new FileCursorStore(join(dir, "cursors.json")),
  );

  // 准入在**信使**这一层:未获准的来信一步都不往前走,不跨 IPC、不建工作目录、
  // 不花订阅额度。这条与单进程时代的那句"准入在网关最前面"是同一个决定,
  // 只是"最前面"现在往前挪了一个进程。
  const admission = accountAdmission(accounts);
  const login = new ILinkLogin(accounts);

  const core = new CourierCore({
    inboxes,
    routing,
    replies,
    spool,
    settings,
    greetedPath: join(dir, "greeted.json"),
    // 出站积压落盘:信使重启时里面可能正躺着一条已经跑完却没送出去的答案。
    outboxPath: join(dir, "outbox.json"),
    send: (userKey, text, kind) => channel.send(userKey, text, kind),
    ...(readBindPassphrase(join(dir, "bind-passphrase")) ?? {}),
    onForceBind: (userKey) => {
      const parts = parseUserKey(userKey);
      if (!parts) return "口令对上了,但这个身份我解析不了 —— 需要人上机看看。";
      const r = accounts.forceBind(parts.accountId, parts.userId);
      if (!r.changed) return "口令对上了,这个微信号本来就已经绑好了。直接说话就行。";
      return r.previous
        ? `口令对上了,已经把这个账号从 ${r.previous} 改绑到你。直接说话就行。`
        : "口令对上了,已经把这个微信号绑到本机。直接说话就行。";
    },
    ...(process.env["CATMAN_RESCUE_STATUS_URL"]
      ? { rescueStatusUrl: process.env["CATMAN_RESCUE_STATUS_URL"] }
      : {}),
    admin: courierAdmin({ accounts, login, routing, replies }),
  });

  // 信使这一侧的"处理完"就是"落进收件队列",没有回合可等,所以整个函数体
  // 都是 settled 该等的东西。
  const accept = async (msg: IncomingMessage): Promise<void> => {
    const verdict = admission(msg.userKey);
    if (!verdict.ok) {
      // 拒绝的说明照发(它是唯一能让人知道"我被挡在门外"的东西),但走 fallback 类,
      // 不吃正文额度。
      if (verdict.reply) {
        await channel.send(msg.userKey, verdict.reply, "fallback").catch(() => undefined);
      }
      return;
    }
    await core.accept({
      msgId: msg.msgId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      userKey: msg.userKey,
      text: msg.text,
      ...(msg.attachments ? { attachments: msg.attachments } : {}),
    });
  };
  channel.onMessage((msg) => ({ settled: accept(msg) }));

  const ipc = new IpcServer({ socketPath: config.ipcSocketPath, api: core, secrets });
  ipc.start();
  await channel.start();

  // 路由的 TTL 扫描。**unref**:它是纯观测型的,晚一轮甚至不跑都无所谓,
  // 不该拦着进程退出(与 gateway.reminderTimer 同一条分界线)。
  const sweep = setInterval(() => {
    void core.sweepRoutes();
    // spool 也在这里扫:只在构造函数里扫一次的话,一个跑几周的稳定面等于从不清扫。
    spool.sweep();
  }, 5 * 60_000);
  sweep.unref?.();

  console.info(`catman-courier 已启动,IPC=${config.ipcSocketPath}`);

  const shutdown = async (sig: string): Promise<void> => {
    console.info(`收到 ${sig},关闭 courier`);
    clearInterval(sweep);
    // 先停发件队列再停渠道:反过来的话正在排空的那一条会撞上已经关掉的连接,
    // 白烧一格额度(失败的尝试照样计数)。
    await core.stop().catch(() => undefined);
    await channel.stop().catch(() => undefined);
    await ipc.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

/**
 * 应急绑定口令。**文件不存在是正常的**(没配这个逃生阀),此时 `/绑定` 一律拒绝。
 * 放文件不放 env:它要能被 dashboard 之外的人在安装时生成一次并抄进手机备忘录,
 * 而 env 改一次要重启整个 compose。
 */
function readBindPassphrase(path: string): { bindPassphrase: string } | undefined {
  try {
    const v = readFileSync(path, "utf8").trim();
    return v ? { bindPassphrase: v } : undefined;
  } catch {
    return undefined;
  }
}

main().catch((err) => {
  console.error("catman-courier 启动失败:", err);
  process.exit(1);
});
