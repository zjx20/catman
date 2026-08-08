/**
 * 运行时配置。全部可用环境变量覆盖,便于容器化部署。
 * 时间相关的量以毫秒为单位,便于测试注入假时钟。
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`环境变量 ${name} 不是合法数字: ${raw}`);
  return v;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw);
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface Config {
  /** 持久化根目录,同时用作 CLAUDE_CONFIG_DIR 的父级。 */
  dataDir: string;
  /** 助手执行命令时的工作目录。 */
  workspaceDir: string;
  /** 会话状态文件路径(userKey→session 映射)。 */
  statePath: string;
  /** 账号注册表路径(含 bot_token,以 0600 落盘)。 */
  accountsPath: string;
  /** 用户注册表路径(userKey→工作目录等)。 */
  usersPath: string;
  /** 全局运行时配置覆盖的落盘位置(管理员改的那一层)。 */
  settingsPath: string;
  /** 每用户配置覆盖的落盘位置。 */
  prefsPath: string;
  /** dashboard 聊天记录的落盘位置(网页没有本地聊天记录,只能服务端存)。 */
  chatLogPath: string;
  /** dashboard 访问令牌;留空则启动时自动生成并写入 dashboardTokenPath。 */
  adminToken: string | undefined;
  /** 自动生成的令牌落盘位置。 */
  dashboardTokenPath: string;
  /** 同时进行的 agent 回合数上限(跨用户)。 */
  maxConcurrentTurns: number;
  /** 超过此空闲时长的新消息归入新会话。默认 1 小时。 */
  sessionTimeoutMs: number;
  /** 会话 JSONL 超过此保留期后清理。默认 30 天。 */
  retentionMs: number;
  /** 清理任务的执行间隔。默认每天一次。 */
  cleanupIntervalMs: number;
  /** dashboard HTTP 端口。 */
  dashboardPort: number;
  /** 传给 Agent SDK 的模型;留空则用 SDK/账户默认。 */
  model: string | undefined;
  /** 允许用户选择的模型。用别名而非完整 id —— 别名不随版本腐化。 */
  modelAllowlist: string[];
  /** 收到消息后是否先回一条"处理中"回执。 */
  ackEnabled: boolean;
  /** 是否把思考/工具调用过程转发给用户。 */
  progressEnabled: boolean;
  /** 告诉 agent 从容器内怎么访问本进程的 HTTP 接口。 */
  apiBase: string;
  /** 单张图片的原始字节上限,超过就拒收(不缩图 —— 运行时没有图像库)。 */
  maxImageBytes: number;
  /** 一条消息最多内联几张图。 */
  maxImagesPerTurn: number;
  /** 连续消息攒多久再一起处理(ms)。0 = 不聚合。 */
  messageAggregationMs: number;
  /**
   * 部署机制的固化目录(bless 时人工生成)。里面是 deployer 脚本、compose 副本、
   * 以及 deployer 写的部署报告。catman 对它**只读** —— 部署机制属 Tier 3,
   * 更新必须经人,不能被一次自我进化顺手改掉。
   * 不存在 = 这台机器没配自进化,两条部署指令会明说。
   */
  deployDir: string;
  /** release 目录(deployer 写、catman 只读)。已验证版本清单也在里面。 */
  releasesDir: string;
  /** 部署结果"已播报"的标记。catman 自己写,所以必须在可写区,不能放 deployDir。 */
  deploySeenPath: string;
}

export function loadConfig(): Config {
  const dataDir = str("CATMAN_DATA_DIR", "/data");
  const dashboardPort = num("CATMAN_DASHBOARD_PORT", 8787);
  return {
    dataDir,
    workspaceDir: str("CATMAN_WORKSPACE_DIR", `${dataDir}/workspace`),
    statePath: str("CATMAN_STATE_PATH", `${dataDir}/state.json`),
    accountsPath: str("CATMAN_ACCOUNTS_PATH", `${dataDir}/accounts.json`),
    usersPath: str("CATMAN_USERS_PATH", `${dataDir}/users.json`),
    settingsPath: str("CATMAN_SETTINGS_PATH", `${dataDir}/settings.json`),
    prefsPath: str("CATMAN_PREFS_PATH", `${dataDir}/prefs.json`),
    chatLogPath: str("CATMAN_CHAT_LOG_PATH", `${dataDir}/dashboard-chat.json`),
    adminToken: process.env.CATMAN_ADMIN_TOKEN || undefined,
    dashboardTokenPath: str("CATMAN_DASHBOARD_TOKEN_PATH", `${dataDir}/dashboard-token`),
    maxConcurrentTurns: num("CATMAN_MAX_CONCURRENT_TURNS", 2),
    sessionTimeoutMs: num("CATMAN_SESSION_TIMEOUT_MS", HOUR),
    retentionMs: num("CATMAN_RETENTION_MS", 30 * DAY),
    cleanupIntervalMs: num("CATMAN_CLEANUP_INTERVAL_MS", DAY),
    dashboardPort,
    model: process.env.CATMAN_MODEL || undefined,
    modelAllowlist: list("CATMAN_MODEL_ALLOWLIST", ["opus", "sonnet", "haiku"]),
    ackEnabled: bool("CATMAN_ACK", true),
    progressEnabled: bool("CATMAN_PROGRESS", true),
    apiBase: str("CATMAN_API_BASE", `http://127.0.0.1:${dashboardPort}`),
    maxImageBytes: num("CATMAN_MAX_IMAGE_BYTES", 3_500_000),
    maxImagesPerTurn: num("CATMAN_MAX_IMAGES_PER_TURN", 4),
    messageAggregationMs: num("CATMAN_MESSAGE_AGGREGATION_MS", 1500),
    deployDir: str("CATMAN_DEPLOY_DIR", `${dataDir}/deploy`),
    releasesDir: str("CATMAN_RELEASES_DIR", `${dataDir}/releases`),
    deploySeenPath: str("CATMAN_DEPLOY_SEEN_PATH", `${dataDir}/deploy-seen.json`),
  };
}
