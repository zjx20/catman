import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { loadConfig, type Config } from "./config.js";
import { Agent } from "./core/agent.js";
import { SessionManager } from "./core/session.js";
import { FileStore } from "./core/file-store.js";
import { Gateway } from "./core/gateway.js";
import { AccountStore } from "./core/accounts.js";
import { UserRegistry, listWorkspaceDirs } from "./core/users.js";
import { allowAll, accountAdmission, type AdmissionPolicy } from "./core/admission.js";
import { GlobalSettings } from "./core/settings.js";
import { PrefsStore } from "./core/prefs.js";
import { TurnTokens } from "./core/turn-tokens.js";
import { writeSkills } from "./core/skills.js";
import { StdinChannel } from "./channels/stdin.js";
import { WechatILinkChannel } from "./channels/wechat-ilink.js";
import { DashboardChannel } from "./channels/dashboard.js";
import { CompositeChannel, compositeAdmission } from "./channels/composite.js";
import { ILinkLogin } from "./channels/ilink-login.js";
import type { Channel } from "./channels/types.js";
import type { AttachmentLimits } from "./core/attachments.js";
import { Dashboard } from "./dashboard/server.js";
import { cleanupOldSessionsAcross, encodeProjectDir, sessionFileExists } from "./core/transcript.js";
import { installLogStamps } from "./core/log-stamp.js";

async function main(): Promise<void> {
  // 第一件事:给所有 console 输出加时间戳。放在最前面,连启动期的日志也带上 ——
  // 排查发送失败之类的问题时,"这两条隔了多久"是最基本的信息。
  installLogStamps();

  const config = loadConfig();

  // 让 Agent SDK 把会话 JSONL 存到数据卷里(而非镜像内的 HOME)。
  if (!process.env.CLAUDE_CONFIG_DIR) {
    process.env.CLAUDE_CONFIG_DIR = `${config.dataDir}/claude`;
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  mkdirSync(config.workspaceDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  // 配置三层由外到内装配:全局层要先建,每用户层拿它当默认值,会话层拿它算超时。
  const settings = new GlobalSettings({ path: config.settingsPath, env: config });
  const prefs = new PrefsStore({
    path: config.prefsPath,
    // 传函数不是快照:管理员改了全局默认要立刻跟随,不能等重启。
    defaults: () => settings.effective(),
  });

  const agent = new Agent(config);
  const sessions = new SessionManager({
    store: new FileStore(config.statePath),
    timeoutMs: config.sessionTimeoutMs,
    timeoutMsFor: (userKey) => prefs.effective(userKey).sessionTimeoutMs,
  });
  const accounts = new AccountStore(config.accountsPath);
  const users = new UserRegistry({
    path: config.usersPath,
    workspaceRoot: config.workspaceDir,
  });
  const turns = new TurnTokens();

  // 接口说明做成 skill(按需加载,常态不占 token)。每次启动覆盖写,保证跟代码同步。
  writeSkills(configDir, { modelAllowlist: settings.effective().modelAllowlist });

  // 聊天记录落盘:网页没有本地记录,不存的话重启后页面空白、而助手那边的会话还在。
  const chat = new DashboardChannel({ path: config.chatLogPath });
  // 闭包读 settings:改了上限立刻生效,与 maxConcurrentTurns 那套一致。
  const { channel, admission } = createChannel(accounts, chat, () => {
    const s = settings.effective();
    return { maxImageBytes: s.maxImageBytes, maxImagesPerTurn: s.maxImagesPerTurn };
  });
  const gateway = new Gateway({
    channel,
    agent,
    sessions,
    users,
    prefs,
    settings,
    turns,
    apiBase: config.apiBase,
    admission,
    // /切换会话 切换前确认目标的 JSONL 还在 —— 记录没了 resume 必然失败,
    // 提前给句人话并出清死引用,比让回合炸出原始报错友好得多。
    sessionExists: (userKey, sessionId) =>
      sessionFileExists(configDir, encodeProjectDir(users.workspaceDirOf(userKey)), sessionId),
    // 提醒轮询:取超时时长的 1/10,但不短于 1 分钟。
    reminderIntervalMs: Math.max(60_000, Math.floor(config.sessionTimeoutMs / 10)),
  });

  const adminToken = resolveAdminToken(config);
  const dashboard = new Dashboard({
    configDir,
    workspaceRoot: config.workspaceDir,
    port: config.dashboardPort,
    adminToken,
    users,
    accounts,
    login: new ILinkLogin(accounts),
    chat,
    selfApi: { turns, prefs, users, sessions, settings, configDir },
    adminApi: { settings, prefs, users },
  });

  // 保留期清理:启动跑一次,之后按间隔跑;删除的会话同步从状态里出清死引用。
  // 清理范围严格来自各用户的 workspace 目录 —— 不遍历 projects/ 树。
  const runCleanup = () => {
    const scopes = listWorkspaceDirs(config.workspaceDir).map((w) => ({
      projectDir: w.projectDir,
    }));
    // 保留期每次现读,所以管理员改完下一轮清理就用新值,不必重建定时器。
    const deleted = cleanupOldSessionsAcross(configDir, scopes, settings.effective().retentionMs);
    // 当前会话与 /切换会话 的历史名单都要剔除死引用,否则会把用户领到
    // 一段 resume 必然失败的会话上。
    sessions.dropSessionIds(deleted);
    if (deleted.length) console.info(`[cleanup] 清理了 ${deleted.length} 个过期会话`);
  };
  runCleanup();

  // 清理间隔不同:它是 setInterval 的参数,改了必须重建定时器才生效。
  let cleanupTimer = scheduleCleanup(settings.effective().cleanupIntervalMs);
  settings.onChange(() => {
    clearInterval(cleanupTimer);
    cleanupTimer = scheduleCleanup(settings.effective().cleanupIntervalMs);
  });
  function scheduleCleanup(intervalMs: number): NodeJS.Timeout {
    const t = setInterval(runCleanup, intervalMs);
    t.unref?.();
    return t;
  }

  const shutdown = async () => {
    console.info("正在关闭 catman…");
    clearInterval(cleanupTimer);
    await gateway.stop();
    await dashboard.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  dashboard.start();
  await gateway.start();
  console.info(`catman 已启动,渠道=${channel.name}`);
}

/**
 * 建渠道,同时给出配套的准入策略 —— 「谁能用」和「消息从哪来」是同一个决定,
 * 分开配置容易出现新渠道忘了配准入、结果全放行。
 *
 * dashboard 聊天始终在列:它的入口本身就要 admin token 才进得来,所以准入放行。
 * 复合渠道对未登记的 channel 前缀一律拒绝 —— 漏配应当表现为不工作,而不是没防护。
 */
function createChannel(
  accounts: AccountStore,
  chat: DashboardChannel,
  /** 图片闸门。取函数而非值 —— 管理员改了上限,下一张图就按新值走,不必重启。 */
  limits: () => AttachmentLimits,
): {
  channel: Channel;
  admission: AdmissionPolicy;
} {
  const kind = process.env.CATMAN_CHANNEL ?? "stdin";
  const byChannel: Record<string, AdmissionPolicy> = { dashboard: allowAll };
  let primary: Channel;
  switch (kind) {
    case "stdin":
      // 本地测试通道,消息只可能来自跑这个进程的人。
      primary = new StdinChannel(limits);
      byChannel["stdin"] = allowAll;
      break;
    case "wechat":
      primary = new WechatILinkChannel(accounts, limits);
      byChannel["wechat"] = accountAdmission(accounts);
      break;
    default:
      throw new Error(`未知渠道 CATMAN_CHANNEL=${kind}`);
  }
  return {
    channel: new CompositeChannel([primary, chat]),
    admission: compositeAdmission(byChannel),
  };
}

/**
 * 取 dashboard 令牌。未配置 CATMAN_ADMIN_TOKEN 时自动生成一个并落盘复用 ——
 * 不阻塞启动(本地开发友好),但也不会出现无鉴权的 dashboard:
 * 能打开它的人可以扫码接入,而接入者拥有宿主 root 级别的能力。
 */
function resolveAdminToken(config: Config): string {
  if (config.adminToken) return config.adminToken;

  try {
    const existing = readFileSync(config.dashboardTokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // 不存在则生成。
  }
  const token = randomBytes(16).toString("hex");
  writeFileSync(config.dashboardTokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  console.warn(
    `[dashboard] 未设置 CATMAN_ADMIN_TOKEN,已自动生成访问令牌(也写入 ${config.dashboardTokenPath}):\n` +
      `  ${token}\n` +
      `  打开 http://<内网IP>:${config.dashboardPort}/?token=${token}`,
  );
  return token;
}

main().catch((err) => {
  console.error("catman 启动失败:", err);
  process.exit(1);
});
