import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import type { Attachment } from "./attachments.js";
import {
  AGENT_TRACE,
  HEARTBEAT_MS,
  describeProgress,
  describeSdkMessage,
  formatHeartbeat,
  shortMs,
  shortNum,
} from "./agent-trace.js";
import { personaBriefing } from "./persona.js";
import { startTurnWatchdog } from "./mem-watchdog-runner.js";
import {
  DEFAULT_SESSION_LIMITS,
  buildSessionImageArgs,
  buildSessionRunArgs,
  type SessionContainerSpec,
  buildWrapperScript,
  claudePathIn,
  sessionContainerName,
  staleWrappers,
} from "./session-container.js";

/**
 * Agent SDK 封装。目标:尽量还原 Claude Code 的行为("脾气"),
 * 关键是三项非默认配置 —— 系统提示词 preset、加载 setting sources、启用 skills。
 * 参考:code.claude.com/docs/en/agent-sdk/claude-code-features
 */

export interface AgentReply {
  /** 要发回给用户的最终文本。 */
  text: string;
  /** 本轮的 session id;供会话层记录以便下次 resume。 */
  sessionId: string;
  /** 是否为错误结果(鉴权失败、超限等)。 */
  isError: boolean;
}

/** 一次回合中的中间过程事件,供上层向用户透出进度。 */
export type AgentProgressEvent =
  | { kind: "thinking"; text: string }
  /**
   * 助手**中途**说的话(不是最终答复)。
   *
   * "中途"这个限定是硬的:最终答复本身也是一个 text 块,原样透出去的话用户会
   * 收到两遍同一句话 —— 一遍当进度、一遍当正文。所以 text 块**延后一拍**发:
   * 只有当后面还有别的动作(又一个 text、思考、或工具调用)时,前一个 text 才
   * 确定不是答复,这时才把它交出去。回合结束时手上那个一律丢掉。
   */
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: unknown };

/** SDK 内容块里我们认得的那几样。只声明用得上的字段,免得跟着 SDK 的类型走。 */
export interface ContentBlockLike {
  readonly type: string;
  readonly thinking?: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: unknown;
}

/**
 * 内容块 → 进度事件。**存在的理由只有一条:text 块要延后一拍。**
 *
 * 最终答复本身也是一个 text 块,当场透出去用户就会收到两遍同一句话 ——
 * 一遍当进度、一遍当正文。而"这个 text 是不是最终答复"只有看它后面还有没有动静
 * 才知道:后面又来了块,它就是中途说的话;回合结束时它还攒着,它就是答复。
 *
 * 单独拎出来是为了能测 —— `query()` 是直接 import 的,那个循环没法在单测里驱动。
 */
export class ProgressFan {
  private pending: AgentProgressEvent | undefined;

  /** 交一条 assistant 消息的内容块进来,拿回**此刻**该推出去的事件(按序)。 */
  take(blocks: readonly ContentBlockLike[]): AgentProgressEvent[] {
    const out: AgentProgressEvent[] = [];
    for (const block of blocks) {
      // display 未生效或被覆盖时 thinking 可能为空串,跳过以免发出空的 💭 消息。
      const ev: AgentProgressEvent | undefined =
        block.type === "thinking" && block.thinking?.trim()
          ? { kind: "thinking", text: block.thinking }
          : block.type === "tool_use" && block.name
            ? { kind: "tool", name: block.name, input: block.input }
            : block.type === "text" && block.text?.trim()
              ? { kind: "text", text: block.text }
              : undefined;
      if (!ev) continue;
      // 后面来了动静,攒着的那个就确定不是答复了 —— 按原顺序先放它出去。
      if (this.pending) {
        out.push(this.pending);
        this.pending = undefined;
      }
      if (ev.kind === "text") {
        this.pending = ev;
        continue;
      }
      out.push(ev);
    }
    return out;
  }
}

/**
 * 往**正在跑的**回合里追加一批输入。回合已收摊则返回 false。
 *
 * 追加进去的内容会被 SDK 折进当前 turn,模型在下一次请求就能看到 ——
 * 这正是"用户中途补一句话"该有的语义。调用方拿到 false 时应当回落到
 * 起一个新回合,而不是把消息丢掉。
 */
export type AgentFeed = (prompt: string, attachments: readonly Attachment[]) => boolean;

export interface AgentRunOptions {
  /** 传入则 resume 该会话;不传则开启新会话。 */
  resumeSessionId?: string;
  /**
   * 本次回合的工作目录。多用户下每人一个,不传则回落到全局 workspaceDir。
   * cwd 同时决定 SDK 把会话 JSONL 写到哪个 project 目录,因此它也是会话隔离的载体。
   */
  cwd?: string;
  /**
   * 本回合用的模型。不传则回落到 config.model;两个都空就完全不传给 SDK,
   * 由它自己决定 —— 这是配置兜底链的末端,保证 agent 永远能起来。
   */
  model?: string;
  /**
   * 子进程环境变量。**SDK 会用它整体替换子进程环境**(不是合并),
   * 调用方必须自己展开 process.env,并对不该下放的变量做剔除。
   */
  env?: Record<string, string | undefined>;
  /** 本回合可见的 skill 名单。注意这是上下文过滤而非沙箱,详见 skills.ts。 */
  skills?: string[];
  /**
   * 本回合最多几轮。不传则不限(日常对话就该不限:回合该跑多久由任务决定)。
   *
   * 存在的理由是自检:smoke 要的是"大脑通不通"这一个事实,一次请求就够了,
   * 而它跑在部署流水线里、没有人盯着 —— 万一模型开始自顾自地干活,烧的是订阅额度
   * 且会把部署门拖到超时。给它一个硬上限,自检就不可能跑飞。
   */
  maxTurns?: number;
  /** 供 /取消 中断本回合。abort 后 run() 抛错,由上层的错误分支处理。 */
  abortController?: AbortController;
  /** 中间过程回调(思考/工具调用)。回调应快速返回,耗时操作自行异步化。 */
  onProgress?: (ev: AgentProgressEvent) => void;
  /**
   * 日志里标识这是谁的回合(网关传 userKey)。多用户并发时,不带这个的话
   * 几个回合的日志会交织成一团分不开。
   */
  logLabel?: string;
  /**
   * 随本回合带上的图片。会作为 image content block **内联**进这一轮的用户消息,
   * 模型第一次推理就能看到 —— 而不是先落盘再让它自己去 Read(那要多一次
   * 工具往返,且模型可能压根不去读)。
   */
  attachments?: readonly Attachment[];
  /**
   * 回合已经可以接收追加输入了,把句柄交给调用方。
   *
   * 在 `query()` 建好之后**同步**调用一次。给出的 `feed` 在本回合收摊后失效
   * (返回 false),调用方不必自己判断时机。
   */
  onFeedReady?: (feed: AgentFeed) => void;
  /**
   * 给**用户**发一条带外通知(目前只有内存看门狗在用)。
   *
   * 与 onProgress 分开:进度是"助手在干什么",这条是"系统对这个回合做了什么"。
   * 混在进度里的话,用户按偏好关掉进度推送就再也看不到看门狗动手了 ——
   * 而那恰恰是最该让他知道的一类消息。
   */
  onNotice?: (text: string) => void;
}

/**
 * 把文本与附件拼成一条 SDK 用户消息。
 *
 * 图片放在文字**前面**:提问往往在指代图片("这张图里是什么"),先图后文才让
 * 指代有对象。文本与附件**不能同时为空** —— 空 content 会被模型侧拒收;
 * 调用方(网关的 handle 与 tryFeed)负责挡在前面。
 */
export function buildUserMessage(
  prompt: string,
  attachments: readonly Attachment[],
): SDKUserMessage {
  const content: SDKUserMessage["message"]["content"] = attachments.map((a) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: a.mediaType, data: a.data },
  }));
  // 空 text block 会被模型侧拒绝,所以只在真有文字时才加。
  if (prompt.trim()) content.push({ type: "text", text: prompt });

  return {
    type: "user",
    session_id: "",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

/**
 * 把一个回合产出的各段正文拼成最终回复。
 *
 * 正常回合只有一段;追加输入落在 turn 边界上时会多出几段(见 run 的收尾注释)。
 *
 * 空正文的兜底话术**必须分失败与成功两种**:SDK 以错误结束时 `errors` 可能是空数组、
 * `result` 可能是空串,此时沿用"助手没有返回内容"会把一次失败伪装成一次无话可说 ——
 * 而这两者用户该做的事恰好相反(去查订阅/配置 vs 换个问法再问一遍)。
 */
export function joinReplyTexts(texts: readonly string[], isError: boolean): string {
  const joined = texts.filter((t) => t.trim()).join("\n\n");
  if (joined) return joined;
  return isError ? "(回合失败,SDK 没有给出错误详情)" : "(助手没有返回内容)";
}

/**
 * 回合的输入通道:一个**常开**的 AsyncIterable,回合跑起来之后仍能往里追加消息。
 *
 * **为什么必须常开**:SDK 只在流式输入下接受回合中途的追加输入。喂进来的消息会被
 * 折进**正在跑的那个 turn**,模型下一次请求就看到 —— 这正是"用户中途补一句话"
 * 该有的语义。传 string(或一个 yield 完就结束的 iterable)等于告诉 SDK
 * "输入到此为止",追加无从谈起。代价是纯文本回合也走流式输入,不再传 string。
 *
 * **关闭语义**:`close()` 只表示"不会再有新输入",**不丢**已经 push 进来的消息 ——
 * 它们照样会被执行,只是可能各自跑成一个 turn。所以回合收尾时无脑 close 是安全的,
 * 不存在"消息挤在 result 与 close 之间被吞掉"的竞态(实测确认,见 run 里的收尾注释)。
 */
export class InputChannel {
  private readonly queue: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  push(msg: SDKUserMessage): void {
    this.queue.push(msg);
    this.wake?.();
  }

  /** 幂等:回合的正常收尾与 finally 的兜底都会调它。 */
  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      // 先排空再判关闭:close() 之后剩在队列里的消息仍要交出去。
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }
}

/**
 * 清扫过期的包装脚本。失败一律吞掉 —— 清理不该把回合带走。
 */
function sweepStaleWrappers(tmpDir: string): void {
  try {
    const entries = readdirSync(tmpDir).map((name) => {
      try {
        return { name, mtimeMs: statSync(`${tmpDir}/${name}`).mtimeMs };
      } catch {
        return { name, mtimeMs: Date.now() }; // 读不到就当它是新的,宁可不删
      }
    });
    for (const name of staleWrappers(entries, Date.now())) {
      try {
        unlinkSync(`${tmpDir}/${name}`);
      } catch {
        /* 删不掉就算了,下次再说 */
      }
    }
  } catch {
    /* 目录不在等等,不是问题 */
  }
}

export class Agent {
  constructor(private readonly config: Config) {}

  /**
   * 把这一回合的大脑关进容器所需的那点准备:拼 `docker run` 参数、把包装脚本
   * 落到盘上、返回给 SDK 的 `pathToClaudeCodeExecutable`。
   *
   * 任何一步不满足就返回 undefined 让回合**退回原路**(直接跑本机二进制)。
   * 这里刻意不抛错:一次配置疏忽不该表现成"助手不回话了"。但每种退回都留一行
   * 日志说清缺什么 —— 静默退回比不开更糟,那意味着你以为有防护而其实没有。
   */
  private prepareContainer(
    tag: string,
    cwd: string,
    logLabel: string | undefined,
  ): { execPath: string; container: string } | undefined {
    if (!this.config.sessionContainer) return undefined;
    // -v 的左边永远是**宿主**路径。容器里的 /data 在宿主上是别的位置,
    // 不给 hostDataDir 的话 docker 会静默建一个空目录,而症状是"助手失忆"。
    const host = this.config.hostDataDir;
    if (!host) {
      console.warn(`${tag} 会话容器已开启但缺 CATMAN_HOST_DATA_DIR —— 退回本机执行`);
      return undefined;
    }
    // 大脑二进制在哪。**必须解开软链**:会话容器里要的是那条具体路径,
    // 而 `current` 这个名字在它眼里随时可能指向别处(自我进化就在拨它)。
    //
    // ⚠️ 这里踩过一次:上一版我照着"应该有个 CATMAN_RELEASE_DIR"写,而部署根本
    // 不提供那个变量 —— 于是开关打开了、日志喊了一句缺变量、防护整个是空的。
    // 真实存在的是 `CATMAN_RELEASE_LINK`(entrypoint 注入,值是那条软链)。
    // 教训不是"记住变量名",是**别信自己没在真机上查过的环境变量**。
    const link = process.env.CATMAN_RELEASE_LINK || `${this.config.dataDir}/releases/current`;
    let release: string;
    try {
      release = realpathSync(link);
    } catch {
      console.warn(`${tag} 会话容器已开启但解不开 release 软链(${link}) —— 退回本机执行`);
      return undefined;
    }
    const claudePath = claudePathIn(release);
    // 落地自检:路径拼错、二进制没跟着 release 一起制备,都在这里现形。
    // 少了这一步,同一类错会表现成"容器起来了但立刻退出",而 SDK 那侧只报一句
    // 含糊的子进程失败 —— 要从那里回溯到"路径少了一段"是很贵的。
    if (!existsSync(claudePath)) {
      console.warn(`${tag} 会话容器已开启但找不到大脑二进制(${claudePath}) —— 退回本机执行`);
      return undefined;
    }
    const container = sessionContainerName(logLabel ?? "anon", String(process.hrtime.bigint()));
    // 顺手扫掉过期的包装脚本。**不能只靠回合结束时删** —— 进程被 SIGKILL(内存
    // 看门狗动手、或部署换版本)时 finally 根本不跑,那些文件就永远留下了。
    // 真机上两小时攒了 14 个。放在这里是因为它天然随"新回合"触发,不必另接生命周期。
    sweepStaleWrappers(`${this.config.dataDir}/tmp`);
    const specIn = {
      container,
      image: this.config.sessionImage,
      claudePath,
      limits: { ...DEFAULT_SESSION_LIMITS, memory: this.config.sessionMemoryLimit },
      mounts: [
        { host: `${host}/releases`, at: "/data/releases", ro: true },
        { host, at: this.config.dataDir },
        { host: "/var/run/docker.sock", at: "/var/run/docker.sock" },
        { host: "/opt/services", at: "/opt/services" },
      ],
      cwd,
      tz: this.config.tz,
      // 身份从**自己的进程**读,不写死、也不再开配置项 —— 这一版三个 bug 全是
      // "我假设了环境而没去查环境",而进程自己的 uid/组是唯一不会猜错的来源。
      user: `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`,
      // 主组已经在 --user 里了,附加组只留其余的(docker.sock 那个就在里面)。
      groupAdd: (process.getgroups?.() ?? []).filter((g) => g !== process.getgid?.()),
      addHosts: ["host.docker.internal:host-gateway"],
    } satisfies SessionContainerSpec;
    const execPath = `${this.config.dataDir}/tmp/session-exec-${container}.sh`;
    try {
      mkdirSync(dirname(execPath), { recursive: true });
      writeFileSync(
        execPath,
        buildWrapperScript(buildSessionRunArgs(specIn), buildSessionImageArgs(specIn)),
        { mode: 0o755 },
      );
    } catch (err) {
      console.warn(`${tag} 包装脚本写不下去(${String(err)}) —— 退回本机执行`);
      return undefined;
    }
    return { execPath, container };
  }

  /**
   * 处理一条用户消息,返回助手回复。
   * 每条消息一次 query();通过 resume 维持多轮上下文,由 SDK 负责
   * auto-compaction 与 JSONL 持久化。
   */
  async run(prompt: string, opts: AgentRunOptions = {}): Promise<AgentReply> {
    const attachments = opts.attachments ?? [];
    const tag = `[agent${opts.logLabel ? ` ${opts.logLabel}` : ""}]`;
    const startedAt = Date.now();
    const model = opts.model ?? this.config.model;
    console.info(
      `${tag} 回合开始 model=${model ?? "(交给 SDK)"} ` +
        `${opts.resumeSessionId ? `resume=${opts.resumeSessionId.slice(0, 8)}` : "新会话"} ` +
        `${prompt.length}字 图${attachments.length}`,
    );

    // 输入一律走常开通道(不再按有无附件分叉):回合中途的追加输入只有流式输入下才收得进。
    const input = new InputChannel();
    input.push(buildUserMessage(prompt, attachments));

    const cwd = opts.cwd ?? this.config.workspaceDir;
    const boxed = this.prepareContainer(tag, cwd, opts.logLabel);
    // 看门狗要能中止回合,所以 abortController 从"调用方给了才传"变成"没有就自己造"。
    // 只在关进容器时才这样 —— 本机执行那条路没有 cgroup 可读,造了也没人用。
    const abortController = opts.abortController ?? (boxed ? new AbortController() : undefined);

    const q = query({
      prompt: input,
      options: {
        ...(boxed ? { pathToClaudeCodeExecutable: boxed.execPath } : {}),
        // append 是**唯一**无条件在场的身份出口:skill 正文按需加载(模型可能压根
        // 不去读)、CLAUDE.md 住在数据卷里(用户能改能删),而"我是哪个人格"是装配
        // 事实。守护人格真机上正是因为缺这一段,张口就自称主人格。见 persona.ts。
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          // 内存那一段**只在真的关进容器时才给** —— 没有上限却说有,是假话。
          append: personaBriefing(
            this.config.persona,
            boxed ? this.config.sessionMemoryLimit : undefined,
          ),
        },
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
        // 当前模型的 API 默认 display="omitted":thinking 块存在但文本为空。
        // 要向用户透出思考摘要必须显式开启 summarized。
        thinking: { type: "adaptive", display: "summarized" },
        cwd,
        // 两个都空就整个不传 model —— 兜底链的末端,交给 SDK 决定。
        ...(model ? { model } : {}),
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.skills ? { skills: opts.skills } : {}),
        ...(opts.maxTurns === undefined ? {} : { maxTurns: opts.maxTurns }),
        ...(abortController ? { abortController } : {}),
        // CLI 子进程的 stderr 是启动失败/鉴权报错的唯一去处,不接就彻底看不见。
        // 无条件转发(不受 TRACE 开关约束):正常回合它一个字都不输出,
        // 一旦有内容就正是要找的东西。
        stderr: (data: string) => {
          const line = data.trim();
          if (line) console.warn(`${tag} stderr: ${line.slice(0, 2000)}`);
        },
      },
    });

    let sessionId = opts.resumeSessionId ?? "";
    let isError = false;
    /** 各 result 的正文。正常回合只有一段;追加输入落在 turn 边界上时会多出几段。 */
    const texts: string[] = [];

    // 追加窗口。收到 result 就关,而 feed 本身是同步函数 —— JS 单线程保证两者
    // 不会交错,不存在"判定通过之后窗口才关"的半开状态。窗口关了返回 false,
    // 调用方据此回落去起新回合。
    let accepting = true;
    let fed = 0;
    // 提成具名的 const:看门狗要用同一个句柄往回合里塞警告,而不是自己
    // 再造一条通往 InputChannel 的路(两条路会各自漏掉"窗口已关"这个判断)。
    const feed: AgentFeed = (feedPrompt, feedAttachments) => {
      if (!accepting) return false;
      input.push(buildUserMessage(feedPrompt, feedAttachments));
      fed += 1;
      console.info(
        `${tag} 追加输入 #${fed} ${feedPrompt.length}字 图${feedAttachments.length}`,
      );
      return true;
    };
    opts.onFeedReady?.(feed);

    // 心跳所需的状态。**覆盖所有 SDK 消息**而不只是 onProgress 透出的那两类:
    // 工具结果回填、API 重试同样是"还在动"的证据,漏掉它们会把正常推进的回合
    // 误报成卡住。计时器起在 query() 之后、紧挨着 finally 所在的 try ——
    // 中间任何一步抛错都不会留下一个空转着打日志的定时器。
    let steps = 0;
    let lastAt = startedAt;
    let lastStep: string | undefined;
    // 内容块 → 进度事件。它替我们攒着最后那个 text 块(见 ProgressFan)。
    const fan = new ProgressFan();
    const heartbeat =
      HEARTBEAT_MS > 0
        ? setInterval(() => {
            const now = Date.now();
            console.info(
              `${tag} ${formatHeartbeat(now - startedAt, now - lastAt, steps, lastStep)}`,
            );
          }, HEARTBEAT_MS)
        : undefined;
    // 心跳不该拖着进程不退出 —— 它是观测,不是工作。
    heartbeat?.unref?.();

    // 看门狗与心跳一样,起在 query() 之后、紧挨着 finally 所在的 try ——
    // 中间任何一步抛错都不会留下一个空转着、还握着 feed 句柄的定时器。
    const stopWatchdog =
      boxed && abortController
        ? startTurnWatchdog(this.config.cgroupRoot, boxed.container, this.config.sessionMemoryLimit, {
            feed: (text) => void feed(text, []),
            abortWith: (err) => abortController.abort(err),
            notifyUser: (text) => opts.onNotice?.(text),
            step: () => lastStep,
            log: (line) => console.warn(`${tag} ${line}`),
          })
        : undefined;

    try {
      for await (const message of q) {
        // 每条消息都带 session_id;新会话时从这里捕获。
        if ("session_id" in message && message.session_id) {
          sessionId = message.session_id;
        }

        const line = describeSdkMessage(message);
        if (line && (line.level === "always" || AGENT_TRACE)) {
          console.info(`${tag} ${line.text}`);
        }
        // 心跳的"上次动静"以任何一条 SDK 消息为准,与要不要打日志无关。
        lastAt = Date.now();

        if (message.type === "assistant") {
          // 攒着的那个 text 块留在 fan 里,回合结束时随它一起丢掉 ——
          // 那就是最终答复,它会走正文那条路。
          for (const ev of fan.take(message.message.content)) {
            steps += 1;
            lastStep = describeProgress(ev);
            opts.onProgress?.(ev);
          }
        }

        if (message.type === "result") {
          // 先关追加窗口再 close 输入流。close **不会**丢掉已 push 的消息:
          // 挤在 result 与 close 之间的那条(管道延迟造成的窄窗口)照样会跑,
          // 只是自成一个 turn 并再吐一个 result —— 所以这里不 break,继续把
          // 后续 result 的正文接在后面。就此收摊等于把用户那条话静默吞掉。
          accepting = false;
          input.close();
          isError ||= message.is_error;
          const body = message.subtype === "success" ? message.result : message.errors.join("\n");
          if (body) texts.push(body);
          this.logResult(tag, message, Date.now() - startedAt, steps);
        }
      }
      if (texts.length > 1) {
        console.info(
          `${tag} 本回合产出 ${texts.length} 段正文 —— 有追加输入正好落在 turn 边界上,各自成了一轮`,
        );
      }
    } catch (err) {
      // 回合以异常告终(abort / SDK 内部错误)也要留一行:上层网关只会打
      // 一句"处理失败",而这里能说清它跑了多久、走到第几步就断了。
      console.error(
        `${tag} 回合中断 ${shortMs(Date.now() - startedAt)} 第 ${steps} 步:${String(err)}`,
      );
      throw err;
    } finally {
      // 抛错(abort / SDK 内部错误)路径同样要关掉窗口与输入流:
      // 窗口不关的话,已经收摊的回合还会对 feed 返回 true,那条消息就没人跑了。
      accepting = false;
      input.close();
      if (heartbeat) clearInterval(heartbeat);
      // 删掉本回合的包装脚本。正常路径靠这里,被 SIGKILL 时靠下一回合开头的清扫。
      if (boxed) { try { unlinkSync(boxed.execPath); } catch { /* 已经没了就算了 */ } }
      // 三条收尾路径(正常结束 / abort / SDK 内部抛错)都要停看门狗。
      // 漏掉任一条都会留下一个每秒敲 dockerd、而且还握着 feed 的定时器。
      stopWatchdog?.();
    }

    return { text: joinReplyTexts(texts, isError), sessionId, isError };
  }

  /**
   * 回合结束的那一行。**无条件打** —— 一个回合只有一条,而它回答的问题
   * (成功没有、花了多久、几轮、多少 token)正是事后翻日志最先要看的。
   */
  private logResult(
    tag: string,
    msg: Extract<SDKMessage, { type: "result" }>,
    wallMs: number,
    steps: number,
  ): void {
    const u = msg.usage;
    const usage = u
      ? ` in=${shortNum(u.input_tokens)} out=${shortNum(u.output_tokens)}` +
        ` 缓存读=${shortNum(u.cache_read_input_tokens ?? 0)}`
      : "";
    const body =
      `${shortMs(wallMs)}(API ${shortMs(msg.duration_api_ms)}) 第${steps}步 ` +
      `${msg.num_turns}轮 $${msg.total_cost_usd.toFixed(4)}${usage}`;
    if (msg.subtype === "success" && !msg.is_error) {
      console.info(`${tag} 回合完成 ${body}`);
      return;
    }
    // is_error 以前被读出来却从没人看 —— SDK 报错(鉴权失败、超限、达到轮数上限)
    // 时,错误文本被当成正文发给用户,日志里一个字都没有。
    const detail = msg.subtype === "success" ? "" : ` errors=${msg.errors.map((e) => e).join(" | ")}`;
    console.error(`${tag} 回合失败 subtype=${msg.subtype} ${body}${detail}`);
  }
}
