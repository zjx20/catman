/**
 * 运行时配置。全部可用环境变量覆盖,便于容器化部署。
 * 时间相关的量以毫秒为单位,便于测试注入假时钟。
 */

/**
 * 本进程是哪个人格。
 *
 * 两者跑的是**同一个入口**,差别全在配置(数据命名空间、端口、IPC secret,外加
 * 守护人格额外挂上的看门狗与状态页)。写两套装配的下场是它们慢慢走样,
 * 而守护人格恰恰是最不该在需要时才发现"它跟主人格不一样"的那个。
 */
import { parseOpsMounts, type OpsConfig } from "./core/execution/ops-config.js";

export type Persona = "primary" | "rescue";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`环境变量 ${name} 不是合法数字: ${raw}`);
  return v;
}

function boundedNum(name: string, fallback: number, min: number, max: number): number {
  const value = num(name, fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min}-${max} 之间的整数`);
  return value;
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
  /** 本人格的控制数据与租户数据根；worker 不整体挂载。 */
  dataDir: string;
  /** 租户目录根，个人 home 与执行上下文分别管理。 */
  workspaceDir: string;
  statePath: string;
  accountsPath: string;
  usersPath: string;
  settingsPath: string;
  prefsPath: string;
  chatLogPath: string;
  adminToken: string | undefined;
  dashboardTokenPath: string;
  /** 同时进行的前台 agent 回合数。 */
  maxConcurrentTurns: number;
  /** 全部活跃上下文的容器数量上限，包含后台任务。 */
  maxActiveRuntimes: number;
  /** 无用户交互或助手响应的回收期限，提前十分钟预告。 */
  runtimeIdleMs: number;
  /** 每个上下文容器的内存上限。 */
  sessionMemoryLimit: string;
  /** 执行环境镜像，必须带 Node、glibc 与常用工具。 */
  sessionImage: string;
  /** 部署指定的临时运维环境；仅经管理员硬指令授权后创建。 */
  ops?: OpsConfig;
  cgroupRoot: string;
  /** 聊天路由闲置期限，决定下一条消息是否新建会话。 */
  sessionTimeoutMs: number;
  retentionMs: number;
  cleanupIntervalMs: number;
  dashboardPort: number;
  model: string | undefined;
  modelAllowlist: string[];
  ackEnabled: boolean;
  progressEnabled: boolean;
  /** worker 访问控制服务的地址，必须可从 mynet 网络访问。 */
  apiBase: string;
  containerName: string;
  maxImageBytes: number;
  maxImagesPerTurn: number;
  messageAggregationMs: number;
  deployDir: string;
  releasesDir: string;
  srcDir: string;
  upstreamBranch: string;
  deploySeenPath: string;
  deployProgressSeenPath: string;
  courierDir: string;
  ipcSocketPath: string;
  ipcSecret: string | undefined;
  persona: Persona;
  adminUserKeys: string[];
  rescueStatusPort: number;
  mainDataDir: string;
  /** mainDataDir 在 Docker daemon 宿主上的绝对路径。 */
  hostDataDir: string | undefined;
  tz: string;
}

export function loadConfig(): Config {
  const dataDir = str("CATMAN_DATA_DIR", "/data");
  // 主 /data 默认就是 dataDir;只有守护人格会把两者分开(它自己写 /data/rescue,
  // 而部署报告、release 指针、信使队列都在主 /data 里,只读)。
  const mainDataDir = str("CATMAN_MAIN_DATA_DIR", dataDir);
  const dashboardPort = num("CATMAN_DASHBOARD_PORT", 8787);
  const hostDataDir = process.env.CATMAN_HOST_DATA_DIR || undefined;
  const persona: Persona = process.env.CATMAN_PERSONA === "rescue" ? "rescue" : "primary";
  // 容器名默认按人格给 —— 与 compose 里的 container_name 一一对应。
  const containerName = str("CATMAN_CONTAINER_NAME", persona === "rescue" ? "catman-rescue" : "catman");
  return {
    dataDir,
    workspaceDir: `${dataDir}/tenants`,
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
    modelAllowlist: list("CATMAN_MODEL_ALLOWLIST", ["opus", "sonnet", "haiku", "fable"]),
    ackEnabled: bool("CATMAN_ACK", true),
    progressEnabled: bool("CATMAN_PROGRESS", true),
    // 默认按容器名寻址,不再用 127.0.0.1 —— 见 Config.apiBase 上面那段。
    apiBase: str("CATMAN_API_BASE", `http://${containerName}:${dashboardPort}`),
    containerName,
    maxImageBytes: num("CATMAN_MAX_IMAGE_BYTES", 3_500_000),
    maxImagesPerTurn: num("CATMAN_MAX_IMAGES_PER_TURN", 4),
    messageAggregationMs: num("CATMAN_MESSAGE_AGGREGATION_MS", 1500),
    deployDir: str("CATMAN_DEPLOY_DIR", `${mainDataDir}/deploy`),
    releasesDir: str("CATMAN_RELEASES_DIR", `${mainDataDir}/releases`),
    srcDir: str("CATMAN_SRC_DIR", `${dataDir}/src/catman`),
    upstreamBranch: str("CATMAN_UPSTREAM_BRANCH", "main"),
    deploySeenPath: str("CATMAN_DEPLOY_SEEN_PATH", `${dataDir}/deploy-seen.json`),
    // 里程碑的已播报标记。**与部署结果的那份分开两个文件**:结果只有一条、里程碑
    // 是一串,合在一起就得在同一份 JSON 里同时维护两种形状,而写它的是两条独立的
    // 路径 —— 分开之后各写各的,谁也不会覆盖谁。
    deployProgressSeenPath: str(
      "CATMAN_DEPLOY_PROGRESS_SEEN_PATH",
      `${dataDir}/deploy-progress-seen.json`,
    ),
    courierDir: str("CATMAN_COURIER_DIR", `${mainDataDir}/courier`),
    ipcSocketPath: str("CATMAN_IPC_SOCKET", `${mainDataDir}/ipc/courier.sock`),
    ipcSecret: process.env.CATMAN_IPC_SECRET || undefined,
    rescueStatusPort: num("CATMAN_RESCUE_STATUS_PORT", 8789),
    persona,
    adminUserKeys: list("CATMAN_ADMIN_USER_KEYS", []),
    mainDataDir,
    hostDataDir,
    tz: str("TZ", "UTC"),
    maxActiveRuntimes: boundedNum("CATMAN_MAX_ACTIVE_RUNTIMES", persona === "rescue" ? 1 : 3, 1, 16),
    runtimeIdleMs: boundedNum("CATMAN_RUNTIME_IDLE_MS", HOUR, 10 * 60_000, 7 * DAY),
    sessionMemoryLimit: str("CATMAN_SESSION_MEMORY", "700m"),
    sessionImage: str("CATMAN_SESSION_IMAGE", "catman-env:1"),
    ...(bool("CATMAN_OPS_ENABLED", false) ? { ops: {
      image: str("CATMAN_OPS_IMAGE", "catman-ops:1"),
      mounts: parseOpsMounts(str("CATMAN_OPS_MOUNTS", "[]")),
      dockerSocket: bool("CATMAN_OPS_DOCKER_SOCKET", false),
      memory: str("CATMAN_OPS_MEMORY", "512m"),
      maxActive: boundedNum("CATMAN_OPS_MAX_ACTIVE", 1, 1, 16),
    } } : {}),
    cgroupRoot: str("CATMAN_CGROUP_ROOT", "/sys/fs/cgroup/docker"),
  };
}
