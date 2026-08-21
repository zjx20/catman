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
export type Persona = "primary" | "rescue";

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
  /**
   * 把每个回合的大脑关进它自己的容器(受内存上限与看门狗管束)。
   *
   * **默认关。** 它依赖两件本进程给不了自己的东西:compose 里 `/sys/fs/cgroup/docker`
   * 的挂载(Tier 3,要管理员 `up -d`),以及宿主上存在 `sessionImage`。缺任一样就
   * 只能退回原路,而"悄悄退回"比"没开"更糟 —— 所以做成显式开关,由管理员在
   * 挂载就位之后再打开。
   *
   * ⚠️ 所有并发会话的上限之和必须小于宿主内存,否则两个会话同时失控照样拖垮宿主。
   * 700m × maxConcurrentTurns 就是这条约束的实际形态。
   */
  sessionContainer: boolean;
  /** 单个会话容器的内存上限,docker `--memory` 的写法。 */
  sessionMemoryLimit: string;
  /** 会话容器用的镜像。必须自带 glibc(大脑二进制是 linux-x64 那个变体)。 */
  sessionImage: string;
  /** 宿主 cgroup 里 docker 子树的位置。看门狗从这里读 anon、往这里写 cgroup.kill。 */
  cgroupRoot: string;
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
  /**
   * 源码工作区 —— 自进化时 agent 在这上面开分支干活。属主是 catman(10001),
   * 与只读的 release 目录是两回事:release 是从这里 clone 出去的、不可变的快照。
   * 默认值必须与 `scripts/evolve/lib.sh` 的 `SRC_DIR` 一致(两边读同一个 env)。
   */
  srcDir: string;
  /** 部署结果"已播报"的标记。catman 自己写,所以必须在可写区,不能放 deployDir。 */
  deploySeenPath: string;
  /** 部署里程碑"已播报"的标记。同上,catman 自己写。 */
  deployProgressSeenPath: string;
  /**
   * 信使的状态目录(收件队列、回复上下文、路由表、附件 spool、游标)。
   * **写者只有信使**;人格对它只读(只读 spool 里的附件字节)。
   */
  courierDir: string;
  /**
   * IPC 的 unix socket。
   *
   * 单独一个目录而不是放在 courierDir 里:守护人格把主 `/data` 整个**只读**挂载,
   * 而 unix socket 的 `connect()` 需要对 socket 文件的**写**权限 —— 放在只读区的
   * 症状是"rescue 起来了但一条消息都收不到",而日志上只有一句 EACCES。
   */
  ipcSocketPath: string;
  /** 本进程(人格)的 IPC secret。信使按它反查身份。 */
  ipcSecret: string | undefined;
  /** 本进程是哪个人格(见 Persona)。 */
  persona: Persona;
  /**
   * 管理员名单的 **env 基线**(`settings.json` 没覆盖时的默认值)。
   *
   * 存在的理由是守护人格:`isAdmin` 读的是**本进程数据目录**下的 settings.json,
   * 而守护人格的是 `/data/rescue/settings.json` —— 一个全新的空文件。真机上的症状是
   * 管理员一发 `/救援` 就被降级成普通用户:`catman-admin` 看不到、部署指令当不认识、
   * 管理员令牌也拿不到,**而诊断与恢复恰好全是管理员的活**。
   *
   * 所以名单要能从进程外面给进来。守护人格由 index.ts 从主 settings.json 继承
   * (主 /data 对它只读可读),别处则可用 `CATMAN_ADMIN_USER_KEYS` 显式指定。
   */
  adminUserKeys: string[];
  /**
   * 守护人格的**无 LLM 状态页**端口。
   *
   * 与 dashboard 分开一个端口而不是共用:两者的可用前提不同 —— dashboard 要装配
   * 起来(会话、agent、skill),状态页只读文件。磁盘满或 token 过期时前者可能起不来,
   * 而后者恰恰是那时唯一还能用的东西。共用一个 server 就把它们绑成同生共死了。
   */
  rescueStatusPort: number;
  /**
   * **主** /data 的位置。
   *
   * 守护人格的 `CATMAN_DATA_DIR` 指向它自己的命名空间(`/data/rescue`),
   * 而它要读的部署报告、release 指针、信使队列都在主 /data 里 —— 两者必须分开表达,
   * 否则它会去自己的小卷里找那些文件然后什么都读不到,而且**不报错**。
   */
  mainDataDir: string;
  /**
   * /data 在**宿主**上的绝对路径。缺席 = 这台机器没配。
   *
   * 定时任务要用它把工作目录挂进一次性容器 —— docker 的 `-v` 只认宿主视角,
   * 传容器内的路径进去,dockerd 会在宿主上静默建一个空目录然后挂上,症状是
   * "任务跑了但什么都没有"。缺席时脚本任务在创建那一步就被拒,而不是每次都失败。
   */
  hostDataDir: string | undefined;
  /**
   * 展示用时区(IANA 名)。容器不继承宿主时区,不设就是 UTC。
   * 定时任务的"每天 8 点"是谁的 8 点、通知里那句"下次 08-14 08:00"按哪儿算,
   * 都取决于它 —— 所以它是配置项而不是散落在各处的 `process.env.TZ`。
   */
  tz: string;
}

export function loadConfig(): Config {
  const dataDir = str("CATMAN_DATA_DIR", "/data");
  // 主 /data 默认就是 dataDir;只有守护人格会把两者分开(它自己写 /data/rescue,
  // 而部署报告、release 指针、信使队列都在主 /data 里,只读)。
  const mainDataDir = str("CATMAN_MAIN_DATA_DIR", dataDir);
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
    deployDir: str("CATMAN_DEPLOY_DIR", `${mainDataDir}/deploy`),
    releasesDir: str("CATMAN_RELEASES_DIR", `${mainDataDir}/releases`),
    srcDir: str("CATMAN_SRC_DIR", `${dataDir}/src/catman`),
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
    persona: process.env.CATMAN_PERSONA === "rescue" ? "rescue" : "primary",
    adminUserKeys: list("CATMAN_ADMIN_USER_KEYS", []),
    mainDataDir,
    hostDataDir: process.env.CATMAN_HOST_DATA_DIR || undefined,
    tz: str("TZ", "UTC"),
    sessionContainer: bool("CATMAN_SESSION_CONTAINER", false),
    sessionMemoryLimit: str("CATMAN_SESSION_MEMORY", "700m"),
    sessionImage: str("CATMAN_SESSION_IMAGE", "catman-env:1"),
    cgroupRoot: str("CATMAN_CGROUP_ROOT", "/sys/fs/cgroup/docker"),
  };
}
