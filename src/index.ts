import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { loadConfig, type Config } from "./config.js";
import { Agent } from "./core/agent.js";
import { SessionManager } from "./core/session.js";
import { FileStore, readJsonFile } from "./core/file-store.js";
import { Gateway } from "./core/gateway.js";
import { UserRegistry, listWorkspaceDirs } from "./core/users.js";
import { adminBaseline, initialSharedClaudeMd } from "./core/persona.js";
import { ensureCronDataDir } from "./core/cron-data.js";
import { TokenAlerter, readTokenExpiry } from "./core/token-alert.js";
import { allowAll, type AdmissionPolicy } from "./core/admission.js";
import { GlobalSettings } from "./core/settings.js";
import { PrefsStore } from "./core/prefs.js";
import { TurnTokens } from "./core/turn-tokens.js";
import { writeSkills } from "./core/skills.js";
import { NotifyTokens } from "./core/notify-tokens.js";
import { writeNotifyBin } from "./core/notify-bin.js";
import { NotifyRateLimiter } from "./dashboard/api-notify.js";
import { StdinChannel } from "./channels/stdin.js";
import { BridgeChannel } from "./channels/bridge.js";
import { IpcClient } from "./ipc/client.js";
import { IpcAccountsProxy } from "./dashboard/accounts-proxy.js";
import { DashboardChannel } from "./channels/dashboard.js";
import { CompositeChannel, compositeAdmission } from "./channels/composite.js";
import type { Channel } from "./channels/types.js";
import type { AttachmentLimits } from "./core/attachments.js";
import { Dashboard } from "./dashboard/server.js";
import { cleanupOldSessionsAcross, encodeProjectDir, sessionFileExists } from "./core/transcript.js";
import { installLogStamps, redirectConsoleToStderr } from "./core/log-stamp.js";
import { readVersion, versionLine, type VersionInfo } from "./core/version.js";
import { syncSrcRepoToRelease } from "./core/src-repo-sync.js";
import { runSelfCheck } from "./core/selfcheck.js";
import { ScriptDeployControl } from "./core/deploy.js";
import { CronStore, DEFAULT_RUN_MAX_AGE_MS } from "./core/cron/store.js";
import { CronScheduler } from "./core/cron/scheduler.js";
import { collectProxyEnv, DockerScriptRunner } from "./core/cron/docker.js";
import { RealAgentTaskRunner } from "./core/cron/agent-runner.js";
import { NoticeSpool } from "./core/cron/notices.js";
import type { CronApiDeps } from "./dashboard/api-cron.js";
import { formatDeployReport } from "./core/deploy-report.js";
import { RescueRunner } from "./rescue/runner.js";

async function main(): Promise<void> {
  // 第一件事:给所有 console 输出加时间戳。放在最前面,连启动期的日志也带上 ——
  // 排查发送失败之类的问题时,"这两条隔了多久"是最基本的信息。
  installLogStamps();

  // 自检模式:装配一遍 + 探一次大脑就退出,不起渠道、不起 dashboard、不碰真实数据。
  // 部署流水线在**切换之前**跑它,所以这个分支必须排在任何会碰 /data 的动作前面。
  if (process.env["CATMAN_SELFCHECK"]) return await selfCheckMain();

  const version = readVersion();
  console.info(`catman 启动中,${versionLine(version)}`);

  const config = loadConfig();

  // ── 守护人格:机械层**先于装配**起来 ──────────────────────────────
  //
  // 顺序就是这条不变量本身。它存在的理由是「失败域诚实条款」:磁盘满 / 内存尽 /
  // token 过期这三样同样会废掉大脑 —— 而那正是最需要看门狗与状态页的时候。
  // 放在装配之后的话,一次 `mkdirSync` 或 `writeSkills` 写盘失败就会让整个进程退出,
  // **状态页从来没起过** —— 于是"大脑起不来时它还在"这句话只是一句注释,不是事实。
  // (这正是评审在 IPC secret 那条上抓到的同一类错误:注释描述了一个不存在的东西。)
  //
  // 所以:它自带 try/catch,起不来只记一行,绝不拖垮别的;而下面的装配若失败,
  // 守护人格**不退出** —— 见文件末尾 main().catch 的分流。
  let rescueRef: RescueRunner | undefined;
  if (config.persona === "rescue") {
    try {
      rescueRef = new RescueRunner({
        dataDir: config.mainDataDir,
        releasesDir: config.releasesDir,
        deployDir: config.deployDir,
        courierDir: config.courierDir,
        primaryContainer: process.env["CATMAN_CONTAINER"] ?? "catman",
        courierContainer: process.env["CATMAN_COURIER_CONTAINER"] ?? "catman-courier",
        statusPort: config.rescueStatusPort,
        token: rescueToken(config),
      });
      rescueRef.start();
    } catch (err) {
      console.error("[rescue] 机械层起不来(这很严重,它本该是最后一道):", err);
    }
  }

  // 让 Agent SDK 把会话 JSONL 存到数据卷里(而非镜像内的 HOME)。
  if (!process.env.CLAUDE_CONFIG_DIR) {
    process.env.CLAUDE_CONFIG_DIR = `${config.dataDir}/claude`;
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  mkdirSync(config.workspaceDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  ensureCronDataDir(config);

  // 配置三层由外到内装配:全局层要先建,每用户层拿它当默认值,会话层拿它算超时。
  const settings = new GlobalSettings({
    path: config.settingsPath,
    env: { ...config, adminUserKeys: resolveAdminBaseline(config) },
  });
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
  const users = new UserRegistry({
    path: config.usersPath,
    workspaceRoot: config.workspaceDir,
  });
  // 共享人设缺席时补一份占位:每用户 CLAUDE.md 首行的 `@../CLAUDE.md` 否则悬空。
  // 主人格那边人手写过、不会被碰;守护人格的 workspace 是新建的,一直是空的。
  users.ensureSharedClaudeMd(initialSharedClaudeMd(config.persona));
  const turns = new TurnTokens();

  // 接口说明做成 skill(按需加载,常态不占 token)。每次启动覆盖写,保证跟代码同步。
  // 按人格生成不同的一套 —— 守护人格拿 catman-rescue 而不是 catman-evolve。
  writeSkills(
    configDir,
    { modelAllowlist: settings.effective().modelAllowlist },
    {
      srcDir: config.srcDir,
      deployBinDir: `${config.deployDir}/bin`,
      releasesDir: config.releasesDir,
      deployDir: config.deployDir,
      courierDir: config.courierDir,
    },
    config.persona,
  );

  // 推送令牌与 `catman-notify`。
  //
  // 这一对存在的理由是一句一直兑现不了的承诺:脱钩的长任务活得过会话,但回合令牌
  // 不会,于是"跑完通知你"从来只能说成"你下次开口时我再去看日志"。令牌落盘(寿命
  // 与回合无关),脚本挂进回合 PATH —— 与 skill 同一条规矩:每次启动覆盖写,
  // 真相源是代码不是磁盘。
  const notifyTokens = new NotifyTokens(`${config.dataDir}/notify-tokens.json`);
  const binDir = `${config.dataDir}/bin`;
  writeNotifyBin(binDir, config.apiBase);

  // 守护人格**不给**部署控制面:它跑 pinned release,不自进化;而 `/发布` `/回滚`
  // 是全局动作,让两个人格都能发等于多了一条谁也说不清是谁按的路径。
  // 它要动版本时走的是状态页上那个按钮(或看门狗自动),两者都经固化的 deployer。
  const deploy = config.persona === "rescue" ? undefined : resolveDeployControl(config, version);

  // 有一条还没送出去的部署结果就在启动时打出来,**无条件**。
  // 网关起来之后会主动把它推给该收到的人(发起人;没有发起人时是管理员名单的第一位),
  // 但推送要有一份可用的回复上下文,而"名单为空"或"上下文已失效"时没有任何人收得到。
  // 而这恰恰是最不能丢的一条:用户接下来说的话,都建立在"改动已生效"这个错误前提上。
  // 日志是它唯一不依赖任何配置的出口,所以不管播不播得出去,先在这里留一份。
  // 只打不标记已播报:该收到的人照样会收到。
  const pendingReport = deploy?.pendingReport();
  if (pendingReport) {
    console.warn(`[deploy] 有一条尚未播报的部署结果:${formatDeployReport(pendingReport)}`);
  }

  // 部署之后把源码仓库的主线拨到线上版本 —— deployer 干不了这件事(源码仓库属 10001,
  // 它跑在 10002 下,`.git` 对它不可写),而 catman 每次部署后都会重启,启动这一刻
  // 正好既知道自己是哪个 sha、又拥有那个仓库。不做的话下次开分支的基线天生陈旧,
  // 分叉就成了默认结果。守护人格不参与:它跑 pinned、且 /data 对它只读。
  //
  // **不 await**:这是省事用的,不值得让启动为它多等一毫秒,更不该被它拖垮。
  if (config.persona !== "rescue" && version) {
    void syncSrcRepoToRelease({ srcDir: config.srcDir, sha: version.sha, branch: version.branch })
      .then((r) => {
        if (r.detail) console.info(`[deploy] ${r.detail}`);
        if (r.dropped.length) console.info(`[deploy] 顺手删掉已合入的分支:${r.dropped.join(" ")}`);
      })
      .catch((err) => console.warn(`[deploy] 同步源码仓库失败(不影响运行):${err}`));
  }

  // 聊天记录落盘:网页没有本地记录,不存的话重启后页面空白、而助手那边的会话还在。
  const chat = new DashboardChannel({ path: config.chatLogPath });
  // 闭包读 settings:改了上限立刻生效,与 maxConcurrentTurns 那套一致。
  // gateway 要在 createChannel 之后建,而 bridge 的 onDetach 要指向 gateway ——
  // 用一个后填的引用打破这个环。detach 帧在 gateway 装好之前不可能到达
  // (bridge 要等 start() 才开始拉取),所以这里的 undefined 窗口是安全的。
  let gatewayRef: Gateway | undefined;
  let cronRef: { store: CronStore } | undefined;
  const { channel, admission, ipcClient: bridgeClient } = createChannel(
    config,
    chat,
    () => {
      const s = settings.effective();
      return { maxImageBytes: s.maxImageBytes, maxImagesPerTurn: s.maxImagesPerTurn };
    },
    (userKey) => gatewayRef?.detachUser(userKey),
  );
  const gateway = new Gateway({
    channel,
    agent,
    sessions,
    users,
    prefs,
    settings,
    turns,
    apiBase: config.apiBase,
    notifyTokens,
    binDir,
    admission,
    version,
    persona: config.persona,
    // token 到期告警的微信出口。过期时刻从凭据文件读(env 长效 token 没有这份信息,
    // 那时它安静地什么都不报 —— 绝不编)。记账落在本进程自己的可写区。
    tokenAlert: new TokenAlerter({
      expiry: () => readTokenExpiry(configDir),
      seenPath: `${config.dataDir}/token-alert-seen.json`,
    }),
    ...(deploy ? { deploy } : {}),
    // /切换会话 切换前确认目标的 JSONL 还在 —— 记录没了 resume 必然失败,
    // 提前给句人话并出清死引用,比让回合炸出原始报错友好得多。
    sessionExists: (userKey, sessionId) =>
      sessionFileExists(configDir, encodeProjectDir(users.workspaceDirOf(userKey)), sessionId),
    // 提醒轮询:取超时时长的 1/10,但不短于 1 分钟。
    reminderIntervalMs: Math.max(60_000, Math.floor(config.sessionTimeoutMs / 10)),
    // `/任务` 的数据源。任务表在 gateway 之后才建,用一个后填的引用打破这个环 ——
    // 与上面 gatewayRef 同一个手法,而且 `/任务` 要等用户开口才可能被调到。
    cron: {
      jobsOf: (userKey) => cronRef?.store.ofUser(userKey) ?? [],
      tz: config.tz,
    },
  });
  gatewayRef = gateway;

  // ── 定时任务 ────────────────────────────────────────────────────
  //
  // **只在主人格里跑。** 守护人格挂的主 /data 是只读的,执行记录一个字都写不下去;
  // 而"每类状态只有一个写者"这条纪律里,任务表的写者就是主人格。两边都跑的话,
  // 一次 `/救援` 期间两个进程会各自去点同一批火。
  const cron =
    config.persona === "primary"
      ? createCron(config, settings, turns, gateway, { agent, users, prefs, notifyTokens, binDir })
      : undefined;
  cronRef = cron;

  const adminToken = resolveAdminToken(config);
  // 渠道起来之前一律报 bootOk=false:部署的健康门等的就是这个翻转,
  // 提前报 true 会让它把一个还没就绪的进程判成部署成功。
  let bootOk = false;
  const startedAt = Date.now();
  const dashboard = new Dashboard({
    configDir,
    workspaceRoot: config.workspaceDir,
    port: config.dashboardPort,
    adminToken,
    users,
    ...(bridgeClient ? { accounts: new IpcAccountsProxy(bridgeClient) } : {}),
    chat,
    selfApi: { turns, prefs, users, sessions, settings, configDir },
    notifyApi: {
      tokens: notifyTokens,
      limiter: new NotifyRateLimiter(),
      // 与定时任务播报同一条出路,于是也同享那份纪律:发不出去有信使的发件队列兜着。
      push: (userKey, text) => gateway.push(userKey, text, "announce"),
    },
    ...(cron ? { cronApi: cron.api } : {}),
    ...(cron
      ? {
          cronAdmin: {
            store: cron.store,
            scheduler: cron.scheduler,
            tz: config.tz,
            enabled: () => settings.effective().cronEnabled,
          },
        }
      : {}),
    adminApi: { settings, prefs, users },
    health: {
      version,
      bootOk: () => bootOk,
      channels: () => channel.health?.() ?? [],
      gateway: () => gateway.healthSnapshot(),
      startedAt,
    },
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
    // 只停轮询,**不碰在跑的容器**:它们是 detached 的,本来就该活过这次重启,
    // 回来之后照常认领(见 cron/docker.ts 开头)。
    cron?.scheduler.stop();
    await gateway.stop();
    await dashboard.stop();
    await rescueRef?.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // dashboard 先起:渠道连接可能要好几秒,这期间 /health 就该答得出
  // (bootOk=false),否则 deployer 的健康门只能干等到超时,分不清"还在起"
  // 与"起不来"。
  dashboard.start();
  await gateway.start();
  // 调度器**排在渠道之后**起:它起来就会去收上一轮遗留的执行,而收完是要发通知的 ——
  // 渠道还没起来时那条结果只能石沉大海,而它恰恰是用户睡前定下、等着看的那一条。
  cron?.scheduler.start();

  bootOk = true;
  console.info(`catman 已启动,渠道=${channel.name},${versionLine(version)}`);
}

/**
 * 装配定时任务:任务表 + docker 执行面 + 调度器 + 给 agent 用的接口。
 *
 * 配置一律**现读**(闭包里 `settings.effective()`),与并发上限、图片闸门同一套 ——
 * 管理员在 dashboard 上把总开关关掉,下一次 tick 就停,不必重启。
 */
function createCron(
  config: Config,
  settings: GlobalSettings,
  turns: TurnTokens,
  gateway: Gateway,
  deps: {
    agent: Agent;
    users: UserRegistry;
    prefs: PrefsStore;
    notifyTokens: NotifyTokens;
    binDir: string;
  },
): { store: CronStore; scheduler: CronScheduler; api: CronApiDeps } {
  const store = new CronStore({
    dir: `${config.dataDir}/cron`,
    // 宿主路径由**装配处**给出:只有这里同时知道容器内与宿主两个视角。
    ...(config.hostDataDir ? { hostDir: `${config.hostDataDir.replace(/\/$/, "")}/cron` } : {}),
  });
  const scheduler = new CronScheduler({
    store,
    runner: new DockerScriptRunner(),
    // agent 任务的执行面。它自己铸令牌、自己挑 skill —— 与用户回合共用同一份
    // 环境组装规则(core/turn-env.ts),抄两份迟早走样。
    agentRunner: new RealAgentTaskRunner({
      agent: deps.agent,
      users: deps.users,
      prefs: deps.prefs,
      settings,
      turns,
      apiBase: config.apiBase,
      persona: config.persona,
      // 定时 agent 任务里的助手同样会起长任务,`catman-notify` 对它一样有用。
      notifyTokens: deps.notifyTokens,
      binDir: deps.binDir,
    }),
    // 静默时段攒下来的结果。落盘 —— 部署很可能就发生在攒着的那几个小时里。
    notices: new NoticeSpool(`${config.dataDir}/cron/notices.json`),
    runtime: () => {
      const s = settings.effective();
      return {
        enabled: s.cronEnabled,
        maxConcurrent: s.cronMaxConcurrent,
        catchUpMs: s.cronCatchUpMs,
        runMaxAgeMs: DEFAULT_RUN_MAX_AGE_MS,
      };
    },
    tz: config.tz,
    // 联网的脚本任务跟着 catman 用同一套代理。**NO_PROXY 必须一起给** ——
    // 只给 HTTP_PROXY 的话,任务打内网地址会被送去代理然后收到一个 503,
    // 而那个 503 是代理说的,看起来完全像目标服务坏了。
    proxyEnv: collectProxyEnv(process.env),
    notify: (userKey, text, kind) => gateway.push(userKey, text, kind),
  });
  const api: CronApiDeps = {
    turns,
    store,
    scheduler,
    validateContext: () => {
      const s = settings.effective();
      return {
        defaultTz: config.tz,
        minIntervalMs: s.cronMinIntervalMs,
        defaultKeepRuns: s.cronKeepRuns,
        mountAllowlist: s.cronMountAllowlist,
        modelAllowlist: s.modelAllowlist,
        hostDataDir: config.hostDataDir,
        now: Date.now(),
      };
    },
    tz: config.tz,
  };
  return { store, scheduler, api };
}

/**
 * 自检入口。结论以**单行 JSON** 打到 stdout —— deployer 是脚本,人也可能直接
 * `docker run` 它,两边都要能读。退出码只有 0/1:分类信息在 JSON 里,
 * 用退出码编码分类会诱使调用方去记一张数字表。
 */
async function selfCheckMain(): Promise<void> {
  // stdout 在这个模式下是**结果通道**,只该有最后那一行 JSON —— deployer 解析它来
  // 判定这份 release 能不能上线。console.log/info/debug 在 Node 里默认也写 stdout,
  // 漏一行进去 deployer 就读不到 JSON,于是好版本被判死。见 redirectConsoleToStderr。
  redirectConsoleToStderr();
  const result = await runSelfCheck();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  console.info(`[selfcheck] ${result.ok ? "通过" : `失败(${result.category})`}:${result.detail}`);
  process.exit(result.ok ? 0 : 1);
}

/**
 * 建渠道,同时给出配套的准入策略 —— 「谁能用」和「消息从哪来」是同一个决定,
 * 分开配置容易出现新渠道忘了配准入、结果全放行。
 *
 * dashboard 聊天始终在列:它的入口本身就要 admin token 才进得来,所以准入放行。
 * 复合渠道对未登记的 channel 前缀一律拒绝 —— 漏配应当表现为不工作,而不是没防护。
 */
function createChannel(
  config: Config,
  chat: DashboardChannel,
  /** 图片闸门。取函数而非值 —— 管理员改了上限,下一张图就按新值走,不必重启。 */
  limits: () => AttachmentLimits,
  /** 收到 detach 控制帧:把这个用户的在飞回合转后台。 */
  onDetach: (userKey: string) => void,
): {
  channel: Channel;
  admission: AdmissionPolicy;
  /** 有信使时给出,dashboard 的账号页靠它代理过去。 */
  ipcClient?: IpcClient;
} {
  const kind = process.env.CATMAN_CHANNEL ?? "stdin";
  const byChannel: Record<string, AdmissionPolicy> = { dashboard: allowAll };
  let primary: Channel;
  let ipcClient: IpcClient | undefined;
  switch (kind) {
    case "stdin":
      // 本地测试通道,消息只可能来自跑这个进程的人。
      primary = new StdinChannel(limits);
      byChannel["stdin"] = allowAll;
      break;
    case "wechat": {
      // 微信连接**不在这个进程里** —— 它归信使(见 src/courier/)。这里只有一根管子。
      //
      // 准入随之也搬走了:信使在消息跨 IPC **之前**就判过,未获准的一步都不往前走。
      // 所以这里放行 —— 不是"没有准入",而是"准入在更前面"。写死成 allowAll 而不是
      // 留个 accountAdmission 的影子,是因为后者要 import accounts.ts,
      // 而人格进程**一行都不能 import 它**(见下面 assertNoAccountStore 的说明)。
      const secret = config.ipcSecret;
      if (!secret) {
        throw new Error(
          "CATMAN_CHANNEL=wechat 需要 CATMAN_IPC_SECRET —— 微信连接在信使进程里,人格靠它认身份",
        );
      }
      ipcClient = new IpcClient({ socketPath: config.ipcSocketPath, secret });
      primary = new BridgeChannel({
        client: ipcClient,
        spoolDir: `${config.courierDir}/spool`,
        onDetach,
      });
      byChannel["wechat"] = allowAll;
      break;
    }
    default:
      throw new Error(`未知渠道 CATMAN_CHANNEL=${kind}`);
  }
  return {
    channel: new CompositeChannel([primary, chat]),
    admission: compositeAdmission(byChannel),
    ...(ipcClient ? { ipcClient } : {}),
  };
}

/**
 * 装配部署控制面 —— 只在这台机器**真的固化过部署脚本**时才给。
 *
 * 判据是那个脚本存不存在,而不是某个开关:开关会与现实脱节(配了开关但没 bless,
 * 于是 `/回滚` 起一个不存在的脚本然后报一句看不懂的 ENOENT)。没有它时网关会
 * 明说"这台机器没配自进化",本地开发与 stdin 调试就是这种情况。
 */
function resolveDeployControl(
  config: Config,
  version: VersionInfo | undefined,
): ScriptDeployControl | undefined {
  const runnerPath = `${config.deployDir}/bin/deployer-run.sh`;
  if (!existsSync(runnerPath)) return undefined;
  console.info(`[deploy] 已固化的部署脚本:${runnerPath}`);
  return new ScriptDeployControl({
    runnerPath,
    reportPath: `${config.deployDir}/report.json`,
    seenPath: config.deploySeenPath,
    // 里程碑由固化的 deployer 追加。这台机器上那份还不会写时,文件不存在 =
    // 没有里程碑可播,报告照旧 —— 部署机制属 Tier 3,它的更新要经人。
    progressPath: `${config.deployDir}/progress.jsonl`,
    progressSeenPath: config.deployProgressSeenPath,
    releasesDir: config.releasesDir,
    historyPath: `${config.releasesDir}/verified-history.json`,
    runningSha: version?.sha,
  });
}

/**
 * 取 dashboard 令牌。未配置 CATMAN_ADMIN_TOKEN 时自动生成一个并落盘复用 ——
 * 不阻塞启动(本地开发友好),但也不会出现无鉴权的 dashboard:
 * 能打开它的人可以扫码接入,而接入者拥有宿主 root 级别的能力。
 */
/**
 * 管理员名单的 env 基线:读盘 + 说一句日志,判断本身在 `core/persona.ts` 里。
 *
 * **只当基线,不写盘。** 本进程 settings.json 若显式设过 `adminUserKeys`,
 * 那份照旧赢 —— 与整套三层配置的优先级一致。
 */
function resolveAdminBaseline(config: Config): string[] {
  const main =
    config.persona === "rescue"
      ? readJsonFile<unknown>(`${config.mainDataDir}/settings.json`, undefined)
      : undefined;
  const { keys, source } = adminBaseline(config.persona, config.adminUserKeys, main);
  if (config.persona !== "rescue") return keys;
  if (source === "inherited") {
    console.info(`[rescue] 管理员名单继承自主 settings.json:${keys.length} 人`);
  } else if (source === "empty") {
    // 说出来。否则管理员切过来发现自己什么都干不了,而日志里一个字都没有。
    console.warn(
      "[rescue] 主 settings.json 里没有 adminUserKeys —— 切到守护人格的人会是普通用户," +
        "看不到诊断用的 skill。可用 CATMAN_ADMIN_USER_KEYS 显式指定。",
    );
  }
  return keys;
}

/**
 * 守护人格的访问令牌。**只读,绝不生成。**
 *
 * 两个站点两份令牌意味着出事时人要先想起来是哪一份,而那时他正着急。所以它读的是
 * 主 dashboard 那一份(`CATMAN_ADMIN_TOKEN`,或主 /data 下那个文件)。
 * 读不到就给一个当场生成的随机值 —— 那等于**没人进得来**,但比"无鉴权"好:
 * 能打开这一页的人可以重启容器、回退版本。同时打一行日志说清是这种状态。
 */
function rescueToken(config: Config): string {
  if (config.adminToken) return config.adminToken;
  try {
    const existing = readFileSync(`${config.mainDataDir}/dashboard-token`, "utf8").trim();
    if (existing) return existing;
  } catch {
    // 读不到 —— 落到下面那句。
  }
  console.error(
    "[rescue] 取不到主 dashboard 的令牌,状态页将无人可进。" +
      "在 .env 里设 CATMAN_ADMIN_TOKEN,或确认主 /data 已只读挂载进来。",
  );
  return randomBytes(16).toString("hex");
}

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
  // 守护人格的机械层(看门狗 + 状态页)在装配**之前**就起来了,而它恰恰是为
  // "大脑起不来"这种处境准备的 —— 这里退出等于把最后一道防线跟着一起关掉。
  // 所以它只报错、继续跑;主人格与信使照旧退出(让 restart 策略去重试)。
  if (process.env["CATMAN_PERSONA"] === "rescue") {
    console.error("[rescue] 大脑那半没起来,机械层继续跑 —— 去状态页看看,它还在。");
    return;
  }
  process.exit(1);
});
