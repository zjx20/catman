import type { CronJob } from "../src/core/cron/types.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Gateway,
  type CronView,
  reminderText,
  shortSessionId,
  ACK_TEXT,
  formatProgress,
  formatProgressBatch,
  ProgressThrottle,
  MAX_FEEDS_PER_TURN,
  FEED_ACK_TEXT,
  TURN_ERROR_PREFIX,
  helpText,
} from "../src/core/gateway.js";
import { canonicalOf } from "../src/core/commands.js";
import { SessionManager, InMemoryStore } from "../src/core/session.js";
import { UserRegistry } from "../src/core/users.js";
import { GlobalSettings, type SettingsPatch } from "../src/core/settings.js";
import { PrefsStore } from "../src/core/prefs.js";
import { TurnTokens } from "../src/core/turn-tokens.js";
import { ADMIN_SKILL } from "../src/core/skills.js";
import { BUILTIN_ADMIN_USER_KEY } from "../src/core/identity.js";
import { loadConfig, type Config } from "../src/config.js";
import type { AdmissionPolicy } from "../src/core/admission.js";
import type { Channel, MessageHandler } from "../src/channels/types.js";
import type { SendKind } from "../src/ipc/protocol.js";
import type { Attachment } from "../src/core/attachments.js";
import type { Agent, AgentProgressEvent, AgentReply, AgentRunOptions } from "../src/core/agent.js";
import type { DeployControl, PublishCandidate, VerifiedRelease } from "../src/core/deploy.js";
import type { DeployReport } from "../src/core/deploy-report.js";
import type { DeployProgress } from "../src/core/deploy-progress.js";

const TIMEOUT = 60 * 60 * 1000;

/** 测试里的 userKey:三段式,和真实渠道产出的形态一致。 */
const U1 = "stdin:local:u1";
const U2 = "stdin:local:u2";

/** 可编排的假渠道:手动注入进来的消息,记录发出/撤回的消息。 */
class FakeChannel implements Channel {
  readonly name = "fake";
  handler?: MessageHandler;
  sent: Array<{ userKey: string; text: string; kind: SendKind }> = [];
  recalled: string[] = [];
  /** 设为 true 时 send 抛错,模拟主动推送发不出去(预算耗尽 / 上下文失效)。 */
  failSend = false;
  /**
   * 只让**第 N+1 条**失败(前面已成功 N 条时抛),之后恢复正常。
   *
   * 一直失败下去的话,"接着发后面几段"与"停下"两种实现看起来一模一样 ——
   * 后面几段反正都发不出去。只坏一条才分得出来。
   */
  failSendOn?: number;
  /** 试过几次发送(**含失败的**)。失败的尝试照样烧 iLink 的发送预算,所以要单独数。 */
  attempted = 0;
  /** 仅"支持撤回"的实例才有 recall 方法(网关按方法是否存在判断能力)。 */
  recall?: (userKey: string, messageId: string) => Promise<void>;

  constructor(supportsRecall = false) {
    if (supportsRecall) {
      this.recall = async (_userKey, messageId) => {
        this.recalled.push(messageId);
      };
    }
  }

  onMessage(h: MessageHandler): void {
    this.handler = h;
  }
  async send(userKey: string, text: string, kind: SendKind = "body"): Promise<string | void> {
    this.attempted += 1;
    if (this.failSend) throw new Error("push not supported");
    if (this.failSendOn !== undefined && this.sent.length === this.failSendOn) {
      this.failSendOn = undefined; // 只坏这一条
      throw new Error("push not supported");
    }
    this.sent.push({ userKey, text, kind });
    // 支持撤回的渠道返回消息 id
    if (this.recall) return `msg-${this.sent.length}`;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  /**
   * 注入一条用户消息并等待**整批处理完**(`settled`,含它起的回合)。
   *
   * 用例大多写成"发一条、断言结果",等的正是这个。真实渠道不该这么等 ——
   * 见 channels/types.ts 的 `Accepted`:等回合跑完的渠道收不到中途插话。
   */
  async receive(userKey: string, text: string, attachments?: readonly Attachment[]): Promise<void> {
    await this.handler!({ userKey, text, ...(attachments ? { attachments } : {}) }).settled;
  }

  /** 注入一条**渠道说他早收过指引**的消息(bridge 就是这么带 greeted 的)。 */
  async receiveGreeted(userKey: string, text: string): Promise<void> {
    await this.handler!({ userKey, text, greeted: true }).settled;
  }
}

/** 假 Agent:按调用序号返回递增的 session id;记录传给 SDK 的关键选项。 */
interface FakeCall {
  prompt: string;
  resume?: string;
  cwd?: string;
  hasProgress: boolean;
  model?: string;
  skills?: string[];
  env?: Record<string, string | undefined>;
  attachments?: readonly Attachment[];
}

/** abort 时 reject 的 promise;没有 controller 就永不 settle。 */
function rejectOnAbort(ac?: AbortController): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!ac) return;
    if (ac.signal.aborted) return reject(new Error("aborted"));
    ac.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

class FakeAgent {
  calls: FakeCall[] = [];
  private n = 0;
  nextSessionId?: string;
  /** 各回合中途收到的追加输入,按到达顺序。 */
  fed: Array<{ prompt: string; attachments: readonly Attachment[] }> = [];
  /** run 时依序回放给 onProgress 的事件。 */
  progressEvents: AgentProgressEvent[] = [];
  /**
   * 回放每个事件**之前**调一次,用来推进假时钟。
   * 进度是节流的,不推进时间的话一条都放不出来 —— 而"瞬间连发一串事件"
   * 恰恰不是真实回合的样子(真机上每约 10 秒一组)。
   */
  beforeProgress?: () => void;
  /** 设为 true 时 run 抛错,模拟 Agent 失败。 */
  fail = false;
  /**
   * 设为 true 时 run 正常返回但带 isError —— 模拟 SDK 以 result 报错
   * (鉴权失败、额度耗尽、达到轮数上限)。这与 `fail` 是**两条不同的路径**:
   * 那条抛异常走网关的 catch,这条走正常的正文发送路径。
   */
  replyIsError = false;
  /** 设置后 run 会等待此 promise,用于测并发控制与"卡住的回合"。 */
  gate?: Promise<void>;
  /** 当前同时在 run 里的调用数,以及历史峰值。 */
  inFlight = 0;
  peakInFlight = 0;

  async run(prompt: string, opts: AgentRunOptions = {}): Promise<AgentReply> {
    this.calls.push({
      prompt,
      resume: opts.resumeSessionId,
      cwd: opts.cwd,
      hasProgress: !!opts.onProgress,
      model: opts.model,
      skills: opts.skills,
      env: opts.env,
      attachments: opts.attachments,
    });
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    // 如实模拟 agent 侧的追加窗口:回合一收摊就拒绝,由网关回落去起新回合。
    let accepting = true;
    opts.onFeedReady?.((feedPrompt, feedAttachments) => {
      if (!accepting) return false;
      this.fed.push({ prompt: feedPrompt, attachments: feedAttachments });
      return true;
    });
    // 真实 SDK 的 session_id 随**第一条**消息就到,远早于任何工具调用 ——
    // 假件必须照做,否则"回合中途死掉时 id 已经到手了"这个前提在测试里不成立,
    // 而那正是要验的东西。
    const sessionId = opts.resumeSessionId ?? this.nextSessionId ?? `sess-${++this.n}`;
    opts.onSessionId?.(sessionId);
    try {
      // abort 会打断正在跑的回合,而不是等它跑完 —— 如实模拟 SDK 的行为。
      if (this.gate) await Promise.race([this.gate, rejectOnAbort(opts.abortController)]);
      for (const ev of this.progressEvents) {
        this.beforeProgress?.();
        opts.onProgress?.(ev);
      }
      if (this.fail) throw new Error("agent boom");
      if (this.replyIsError) {
        return { text: "Credit balance is too low", sessionId, isError: true };
      }
      return { text: `echo:${prompt}`, sessionId, isError: false };
    } finally {
      accepting = false;
      this.inFlight -= 1;
    }
  }
}

interface BuildOpts {
  failSend?: boolean;
  supportsRecall?: boolean;
  admission?: AdmissionPolicy;
  /** 预置的全局配置覆盖(并发上限、默认模型、管理员名单等)。 */
  settings?: SettingsPatch;
  /** 会话记录存活检查(/切换会话 用)。不传则视为都活着,与生产默认一致。 */
  sessionExists?: (userKey: string, sessionId: string) => boolean;
  /** 部署控制面。不传 = 这台机器没配自进化(本地开发就是这样)。 */
  deploy?: DeployControl;
  /** token 到期告警。不传 = 不播(stdin 调试就是这样)。 */
  tokenAlert?: { pending(): string | undefined; markAnnounced(): void };
  /** 定时任务只读视图(/任务 用)。不传 = 这台机器没有定时任务。 */
  cron?: CronView;
}

/** 可编排的假部署控制面:记录发布与回滚请求,报告、清单、候选由用例摆好。 */
class FakeDeploy implements DeployControl {
  rollbackRequests: string[] = [];
  rollbackError?: Error;
  deployRequests: Array<{ prefix: string; requestedBy: string }> = [];
  deployError?: Error;
  candidates: PublishCandidate[] = [];
  report?: DeployReport;
  announced: string[] = [];
  progress: DeployProgress[] = [];
  progressAnnounced: string[] = [];
  history: VerifiedRelease[] = [];

  async requestDeploy(shaPrefix: string, requestedBy: string): Promise<string> {
    if (this.deployError) throw this.deployError;
    this.deployRequests.push({ prefix: shaPrefix, requestedBy });
    return "已提交部署。";
  }
  publishable(): readonly PublishCandidate[] {
    return this.candidates;
  }
  async requestRollback(requestedBy: string): Promise<string> {
    if (this.rollbackError) throw this.rollbackError;
    this.rollbackRequests.push(requestedBy);
    return "已请求回滚。";
  }
  pendingReport(): DeployReport | undefined {
    return this.report && !this.announced.includes(this.report.id) ? this.report : undefined;
  }
  markReportAnnounced(id: string): void {
    this.announced.push(id);
  }
  pendingProgress(): readonly DeployProgress[] {
    return this.progress.filter((p) => !this.progressAnnounced.includes(p.id));
  }
  markProgressAnnounced(id: string): void {
    this.progressAnnounced.push(id);
  }
  lastReport(): DeployReport | undefined {
    return this.report;
  }
  verifiedHistory(): readonly VerifiedRelease[] {
    return this.history;
  }
}

const tempDirs: string[] = [];

/** 一份不依赖真实环境变量的 Config —— 只作为配置层的 env 基线。 */
function testConfig(root: string): Config {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("CATMAN_")) delete process.env[k];
  }
  const cfg = loadConfig();
  process.env = saved;
  return { ...cfg, dataDir: root, sessionTimeoutMs: TIMEOUT };
}

function build(now: () => number, opts: BuildOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), "catman-gw-"));
  tempDirs.push(root);
  const channel = new FakeChannel(opts.supportsRecall ?? false);
  channel.failSend = opts.failSend ?? false;
  const agent = new FakeAgent();

  const settings = new GlobalSettings({ path: join(root, "settings.json"), env: testConfig(root) });
  // 默认关掉聚合窗口:绝大多数用例测的是队列/会话/并发语义,不该被 1.5 秒的
  // 攒消息延迟搅进来。聚合本身由下面专门的一组用例显式开启后验证。
  settings.set({ messageAggregationMs: 0, ...(opts.settings ?? {}) });
  const prefs = new PrefsStore({
    path: join(root, "prefs.json"),
    defaults: () => settings.effective(),
  });
  const sessions = new SessionManager({
    store: new InMemoryStore(),
    timeoutMs: TIMEOUT,
    now,
    timeoutMsFor: (k) => prefs.effective(k).sessionTimeoutMs,
  });
  const users = new UserRegistry({
    path: join(root, "users.json"),
    workspaceRoot: join(root, "workspace"),
    now,
  });
  const turns = new TurnTokens();
  const gw = new Gateway({
    channel,
    agent: agent as unknown as Agent,
    sessions,
    users,
    prefs,
    settings,
    turns,
    apiBase: "http://127.0.0.1:8787",
    reminderIntervalMs: 999_999, // 测试里手动触发,不依赖定时器
    now,
    ...(opts.admission ? { admission: opts.admission } : {}),
    ...(opts.sessionExists ? { sessionExists: opts.sessionExists } : {}),
    ...(opts.deploy ? { deploy: opts.deploy } : {}),
    ...(opts.tokenAlert ? { tokenAlert: opts.tokenAlert } : {}),
    ...(opts.cron ? { cron: opts.cron } : {}),
  });
  // 只注册 handler,不启动真实定时器/渠道 —— 但接线走 `onIncoming`,与
  // `Gateway.start()` **同一个方法**。这里曾经自己抄了一份等价接线,
  // 于是 start() 每加一件事(比如消费渠道给的 greeted 标记),测的就是一条
  // 生产里不存在的路径:实现明明对了,用例却红。
  channel.onMessage((m) => gw.onIncoming(m));
  return { channel, agent, sessions, users, prefs, settings, turns, gw, root };
}

/**
 * 等到条件成立(靠让出事件循环推进,不用真实计时器)。
 * 等不到就抛错而不是一直等 —— 挂死的测试比失败的测试难查得多。
 */
async function waitUntil(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`等不到:${label}`);
}

/** 首次消息会先推一份使用指引;多数用例只关心之后的内容。 */
function afterGreeting(sent: Array<{ userKey: string; text: string }>) {
  return sent.filter((m) => !m.text.startsWith("你好,我是 catman。"));
}

test.after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test("完整回合:准入 → decide → 回执 → agent → record → send", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  await channel.receive(U1, "你好");
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0]!.resume, undefined); // 新会话
  assert.deepEqual(afterGreeting(channel.sent), [
    { userKey: U1, text: ACK_TEXT, kind: "ack" },
    { userKey: U1, text: "echo:你好", kind: "body" },
  ]);
  // 渠道不支持撤回:回执保留
  assert.deepEqual(channel.recalled, []);
});

test("回执:渠道支持撤回时,回复发出后撤回回执", async () => {
  const t = 1_000_000;
  const { channel } = build(() => t, { supportsRecall: true });
  await channel.receive(U1, "你好");
  assert.equal(afterGreeting(channel.sent)[0]!.text, ACK_TEXT);
  // greeting 占掉了 msg-1,回执是 msg-2。
  assert.deepEqual(channel.recalled, ["msg-2"]);
});

test("回执:Agent 失败时也撤回回执,并发出错误提示", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t, { supportsRecall: true });
  agent.fail = true;
  await channel.receive(U1, "你好");
  assert.ok(channel.sent.some((m) => m.text.includes("处理出错了")));
  assert.deepEqual(channel.recalled, ["msg-2"]);
});

test("SDK 以 result 报错时:错误原文照发,但要标明这不是答复", async () => {
  // 与「Agent 失败」是两条路径:那条抛异常,这条正常返回且 isError=true,
  // 正文走的是与成功回复完全相同的发送路径 —— 不加标记的话,一句
  // 「Credit balance is too low」在用户那边和助手说的话长得一模一样。
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  agent.replyIsError = true;
  await channel.receive(U1, "你好");

  const body = afterGreeting(channel.sent).find((m) => m.text.includes("Credit balance is too low"));
  assert.ok(body, `错误原文要照发(它是去查订阅的唯一线索),实际:
    ${JSON.stringify(channel.sent.map((m) => m.text))}`);
  assert.ok(body.text.startsWith(TURN_ERROR_PREFIX), "要标明这是报错而不是答复");
});

test("回执:ackEnabled=false 时不发回执", async () => {
  const t = 1_000_000;
  const { channel } = build(() => t, { settings: { ackEnabled: false } });
  await channel.receive(U1, "你好");
  assert.deepEqual(afterGreeting(channel.sent), [
    { userKey: U1, text: "echo:你好", kind: "body" },
  ]);
});

test("进度:按序转发,且最终回复永远排在进度之后", async () => {
  // 守的是顺序:进度走一条串行链,正文在 `await progress` 之后才发。
  // 乱序的话用户会先看到答案、再看到"正在读文件",莫名其妙。
  let t = 1_000_000;
  const { channel, agent } = build(() => t);
  agent.progressEvents = [
    { kind: "thinking", text: "先看看内存" },
    { kind: "tool", name: "Bash", input: { command: "free -m" } },
  ];
  // 每个事件之间推进一整档,保证两条都放行 —— 节流本身由 ProgressThrottle 的用例覆盖。
  agent.beforeProgress = () => {
    t += 60_000;
  };
  await channel.receive(U1, "内存占用?");
  assert.deepEqual(
    afterGreeting(channel.sent).map((m) => m.text),
    [ACK_TEXT, "💭 先看看内存", "🔧 Bash: free -m", "echo:内存占用?"],
  );
});

test("进度:短回合里连发的事件被节流掉,只留回执与正文", async () => {
  // 真机上一个 83 秒的回合发了 21 条进度,把 context_token 用废,连正文都发不出去。
  // 时间不推进 = 所有事件挤在同一瞬间,一条都不该放行。
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  agent.progressEvents = Array.from({ length: 20 }, (_, i) => ({
    kind: "tool" as const,
    name: `T${i}`,
    input: {},
  }));
  await channel.receive(U1, "内存占用?");
  assert.deepEqual(
    afterGreeting(channel.sent).map((m) => m.text),
    [ACK_TEXT, "echo:内存占用?"],
  );
});

test("进度:progressEnabled=false 只停推送,回合快照照常更新", async () => {
  // 关进度是个省流开关,不该顺手把可观测性也关掉 —— /状态 与心跳日志都靠这份
  // 快照回答"现在在干什么",两者绑在一起的话关了进度就彻底成了黑盒。
  const t = 1_000_000;
  const { channel, agent, turns } = build(() => t, { settings: { progressEnabled: false } });
  agent.progressEvents = [{ kind: "tool", name: "Bash", input: { command: "npm test" } }];
  let snapshot: { steps: number; last?: string } | undefined;
  agent.beforeProgress = () => {
    // 事件回放期间回合还在飞,此刻正是 /状态 能看到的东西。
    const ctx = turns.foregroundFor(U1);
    if (ctx) snapshot = { steps: ctx.progress.steps, last: ctx.progress.last };
  };
  await channel.receive(U1, "你好");

  assert.equal(agent.calls[0]!.hasProgress, true, "回调无条件挂上");
  assert.deepEqual(
    afterGreeting(channel.sent).map((m) => m.text),
    [ACK_TEXT, "echo:你好"],
    "但一条进度都不推给用户",
  );
  // beforeProgress 在事件送达之前跑,所以这里看到的是"上一条"的累计值;
  // 回合结束后 revoke 会清掉 ctx,故快照要在回合内取。
  assert.equal(snapshot?.steps, 0);
});

test("回合快照:步数与最后一步随事件推进,回合结束后清空", async () => {
  const t = 1_000_000;
  const { channel, agent, turns } = build(() => t);
  agent.progressEvents = [
    { kind: "tool", name: "Read", input: { file_path: "/etc/hosts" } },
    { kind: "tool", name: "Bash", input: { command: "npm test" } },
  ];
  const seen: Array<{ steps: number; last?: string }> = [];
  agent.beforeProgress = () => {
    const ctx = turns.foregroundFor(U1);
    if (ctx) seen.push({ steps: ctx.progress.steps, last: ctx.progress.last });
  };
  await channel.receive(U1, "跑个测试");

  // 两次采样分别发生在第 1、第 2 个事件送达之前。
  assert.deepEqual(seen[0], { steps: 0, last: undefined });
  assert.deepEqual(seen[1], { steps: 1, last: "🔧 Read: /etc/hosts" });
  assert.equal(turns.foregroundFor(U1), undefined, "回合结束后不再有在飞回合");
});

test("/状态 报告在飞回合:卡住时也答得出「在干什么」", async () => {
  const t = 1_000_000;
  const { channel, agent, turns } = build(() => t);
  let release!: () => void;
  agent.gate = new Promise<void>((r) => (release = r));

  const inFlight = channel.receive(U1, "跑个长任务");
  await waitUntil(() => agent.inFlight === 1, "回合进到 agent 里挂住");
  const ctx = turns.foregroundFor(U1)!;
  ctx.progress.steps = 3;
  ctx.progress.last = "🔧 Bash: npm test";
  ctx.progress.lastAt = t - 30_000;

  await channel.receive(U1, "/状态");
  const status = afterGreeting(channel.sent).find((m) => m.text.startsWith("📋"))!;
  assert.match(status.text, /当前:处理中/);
  assert.match(status.text, /第 3 步/);
  assert.match(status.text, /🔧 Bash: npm test/);

  release();
  await inFlight;
  // 回合结束后再问一次:必须明确说空闲,而不是沿用上一轮的说法。
  await channel.receive(U1, "/状态");
  const idle = afterGreeting(channel.sent).filter((m) => m.text.startsWith("📋")).at(-1)!;
  assert.match(idle.text, /当前:空闲/);
});

test("/状态 区分排队与真在跑:并发满时说排队", async () => {
  const t = 1_000_000;
  const { channel, agent, turns } = build(() => t, { settings: { maxConcurrentTurns: 1 } });
  let release!: () => void;
  agent.gate = new Promise<void>((r) => (release = r));

  const first = channel.receive(U2, "占住名额");
  await waitUntil(() => agent.inFlight === 1, "U2 占住唯一的名额");
  const second = channel.receive(U1, "我在后面等");
  // U1 走完 prelude 与 mint 之后停在 semaphore.acquire 上:有回合上下文,但没名额。
  await waitUntil(() => turns.foregroundFor(U1) !== undefined, "U1 铸出回合令牌");
  assert.equal(turns.foregroundFor(U1)?.progress.running, undefined, "还没拿到名额");

  await channel.receive(U1, "/状态");
  const status = afterGreeting(channel.sent).find((m) => m.text.startsWith("📋"))!;
  assert.match(status.text, /当前:排队中/);

  release();
  await Promise.all([first, second]);
});

test("formatProgress:超长内容截断,工具入参挑代表性字段", () => {
  const long = "x".repeat(500);
  assert.equal(formatProgress({ kind: "thinking", text: long }), `💭 ${"x".repeat(200)}…`);
  assert.equal(
    formatProgress({ kind: "tool", name: "Read", input: { file_path: "/etc/hosts" } }),
    "🔧 Read: /etc/hosts",
  );
  assert.equal(formatProgress({ kind: "tool", name: "Foo", input: { n: 1 } }), '🔧 Foo: {"n":1}');
  // 中途说的话也推给用户 —— 大多数时候它埋头调工具,偶尔开口那几句正是最能
  // 看出它在怎么干活的地方。前缀与 describeProgress 必须一致,两处各写各的就会
  // 出现"/状态 里是 💬,推送里是别的"。
  assert.equal(formatProgress({ kind: "text", text: "先看看日志" }), "💬 先看看日志");
  assert.equal(formatProgress({ kind: "text", text: long }), `💬 ${"x".repeat(200)}…`);
});

/** 造一个工具事件,名字带序号便于断言"发出去的是最新那条"。 */
const toolEv = (n: number): AgentProgressEvent => ({ kind: "tool", name: `T${n}`, input: {} });

test("进度节流:间隔按 5/15/30/60 逐级拉长,最后一档保持", () => {
  // 一个长回合发几十条进度会把 iLink 的 context_token 用废(实测第 11 条起
  // prepare failed 且永不恢复),所以这个阶梯是发送预算,不是观感偏好。
  const t0 = 1_000_000;
  const th = new ProgressThrottle(t0);
  const at = (ms: number, n = 0) => th.offer(t0 + ms, toolEv(n));

  assert.equal(at(4_999), undefined, "5 秒内不该发");
  assert.ok(at(5_000), "到 5 秒放行第 1 条");
  assert.equal(at(19_999), undefined, "第 2 条要等 15 秒");
  assert.ok(at(20_000), "5+15 放行第 2 条");
  assert.equal(at(49_999), undefined, "第 3 条要等 30 秒");
  assert.ok(at(50_000), "20+30 放行第 3 条");
  assert.equal(at(109_999), undefined, "第 4 条要等 60 秒");
  assert.ok(at(110_000), "50+60 放行第 4 条");
  assert.equal(at(169_999), undefined, "之后一直是 60 秒");
  assert.ok(at(170_000), "阶梯用完后保持最后一档");
});

test("进度节流:同一间隔内攒下的步骤拼进同一条消息,不再丢掉", () => {
  // 旧行为是只发最新那条、其余丢掉,只留一个 (+N 步)。改掉是因为那笔账算错了:
  // 攒下的步骤本来就是**拼进同一条消息**的,context_token 一分没多花 ——
  // 省下的只是屏幕。而十步里只看得见一步,信息损失远大于省下的那几行。
  const t0 = 1_000_000;
  const th = new ProgressThrottle(t0);

  assert.ok(th.offer(t0 + 5_000, toolEv(1)));
  for (let i = 2; i <= 5; i += 1) {
    assert.equal(th.offer(t0 + 5_000 + i, toolEv(i)), undefined, "没到点仍然不发");
  }
  const text = th.offer(t0 + 20_000, toolEv(6));
  assert.ok(text, "到点应当放行");
  // 摘要行是最新那步,而且在第一行 —— 用户扫一眼要先看到"现在在干什么"。
  assert.ok(text.startsWith("🔧 T6"), `摘要行该是最新那步,实际:${text}`);
  // 中间那几步一条都不能少,这正是这次改动要买的东西。
  for (const n of [2, 3, 4, 5]) {
    assert.ok(text.includes(`T${n}`), `T${n} 该出现在回顾里:${text}`);
  }
  assert.match(text, /前面 4 步:/);
  // 列表前要有空行,否则 markdown 会把它跟摘要行黏成一段。
  assert.match(text, /\n\n前面 4 步:\n\n- /);

  // 放行后清空,不把上一轮的账算到下一轮头上。
  const next = th.offer(t0 + 50_000, toolEv(7));
  assert.ok(next && !next.includes("T6"), `上一轮的步骤不该重复出现:${next}`);
});

test("进度节流:攒太多只留最近几步,更早的报数量 —— 一条进度不该翻屏", () => {
  // 折叠指望不上(微信不渲染 <details>),这些行实打实占屏幕,所以必须封顶。
  const t0 = 1_000_000;
  const th = new ProgressThrottle(t0);
  assert.ok(th.offer(t0 + 5_000, toolEv(0)));
  for (let i = 1; i <= 30; i += 1) th.offer(t0 + 5_000 + i, toolEv(i));
  const text = th.offer(t0 + 20_000, toolEv(99));
  assert.ok(text);
  const bullets = text.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(bullets.length <= 8, `回顾行不该超过上限,实际 ${bullets.length} 行`);
  assert.match(text, /更早的 \d+ 步略过/);
  assert.ok(!text.includes("T1:"), "最老的那些该被挤掉");
});

test("进度批量:只有一步时就是一行,不摆一个空列表", () => {
  assert.equal(formatProgressBatch(["🔧 A"]), "🔧 A");
});

test("进度批量:回顾行裁得比摘要行短 —— 它们是索引不是正文", () => {
  const long = `🔧 T: ${"x".repeat(300)}`;
  const text = formatProgressBatch([long, long]);
  const [head, ...rest] = text.split("\n");
  const bullet = rest.find((l) => l.startsWith("- "));
  assert.ok(head && head.length > 150, "摘要行按 200 字裁");
  assert.ok(bullet && bullet.length < 100, `回顾行该裁到 60 字上下,实际 ${bullet?.length}`);
});

test("进度节流:核心不再有总条数上限 —— 发多少条由渠道那边的额度说了算", () => {
  // 阶梯管的是**观感**(多久说一次话),不是额度。额度是渠道那一侧的事:
  // 发不出去的进度由信使排队(而且只留最新一条),额度到头也由信使去说
  // "发 /nop 可以续上"。核心这边曾经现问渠道要余量,那是"核心也得懂一点预算"的
  // 最后一块 —— 而 stdin / dashboard 上那个问题压根没有答案。
  const t0 = 1_000_000;
  const th = new ProgressThrottle(t0);
  let sent = 0;
  for (let ms = 0; ms <= 1_800_000; ms += 1_000) {
    if (th.offer(t0 + ms, toolEv(ms))) sent += 1;
  }
  // 30 分钟 / 最后一档 60 秒 ≈ 30 条,远多于任何常量上限。
  assert.ok(sent > 20, `不该被封顶,实际只发了 ${sent} 条`);
  assert.ok(
    !th.offer(t0 + 1_800_500, toolEv(1))?.includes("进度就报到这儿"),
    "那句交代不归核心说了",
  );
});

test("进度节流:开闸只是阶梯重来 —— /nop 之后不必等满 60 秒", () => {
  // 用户刚开口,正是最想知道"接住了没"的时刻。不重置的话,长回合后半段要等满
  // 最后一档(60 秒)才有下一条,与卡死无从分辨。
  const t0 = 1_000_000;
  const th = new ProgressThrottle(t0);
  assert.ok(th.offer(t0 + 5_000, toolEv(1)), "第一档 5 秒");
  assert.ok(th.offer(t0 + 20_000, toolEv(2)), "第二档 15 秒");
  assert.equal(th.offer(t0 + 30_000, toolEv(3)), undefined, "第三档要等 30 秒");

  th.reset(t0 + 30_000);
  assert.equal(th.offer(t0 + 34_999, toolEv(4)), undefined, "阶梯一并重来,不会变成刷屏");
  assert.ok(th.offer(t0 + 35_000, toolEv(5)), "但只要等满第一档就接着报");
});
test("进度节流:一个 83 秒的回合只发 3 条进度", () => {
  // 真机上那次失败的回合:每约 10 秒一组三条事件,旧实现共发了 21 条进度。
  const t0 = 1_000_000;
  const th = new ProgressThrottle(t0);
  let sent = 0;
  for (let ms = 0; ms <= 83_000; ms += 300) {
    if (th.offer(t0 + ms, toolEv(ms))) sent += 1;
  }
  assert.equal(sent, 3, "5s / 20s / 50s 各一条,下一档要到 110s");
});

test("同一用户第二条消息在超时内 → resume", async () => {
  let t = 1_000_000;
  const { channel, agent } = build(() => t);
  await channel.receive(U1, "第一条");
  t += 10_000;
  await channel.receive(U1, "第二条");
  assert.equal(agent.calls[1]!.resume, "sess-1");
});

test("同一用户的消息串行处理(不并发 resume)", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  // 不 await 第一条,紧接着发第二条
  const p1 = channel.receive(U1, "A");
  const p2 = channel.receive(U1, "B");
  await Promise.all([p1, p2]);
  assert.equal(agent.calls.length, 2);
  // 第二条必须看到第一条产生的会话
  assert.equal(agent.calls[1]!.resume, "sess-1");
});

test("超时提醒:可推送时发出提醒文案", async () => {
  let t = 1_000_000;
  const { channel, gw } = build(() => t);
  await channel.receive(U1, "hi");
  t += TIMEOUT;
  await gw["flushReminders"]();
  const reminder = channel.sent.find(
    (m) => m.userKey === U1 && m.text === reminderText(shortSessionId("sess-1")),
  );
  assert.ok(reminder, "应发出超时提醒");
  // 提醒里必须教"怎么切回来":用户直接发新话题后,这是他知道旧会话 id 的唯一机会。
  assert.ok(reminder.text.includes("/切换会话 sess-1"), `提醒里缺了切回指引:${reminder.text}`);
});

test("超时提醒:渠道不支持推送时静默降级,不抛错", async () => {
  let t = 1_000_000;
  const { channel, gw } = build(() => t, { failSend: true });
  // failSend 也会让首条回复发送失败,但 handle 内部已捕获
  await channel.receive(U1, "hi");
  t += TIMEOUT;
  await assert.doesNotReject(gw["flushReminders"]());
});

// --- 多用户隔离 ---

test("不同用户各自独立的 cwd 与会话,互不影响", async () => {
  const t = 1_000_000;
  const { channel, agent, sessions, users } = build(() => t);
  await channel.receive(U1, "A的消息");
  await channel.receive(U2, "B的消息");

  const cwd1 = agent.calls[0]!.cwd;
  const cwd2 = agent.calls[1]!.cwd;
  assert.ok(cwd1 && cwd2);
  assert.notEqual(cwd1, cwd2);
  assert.equal(cwd1, users.workspaceDirOf(U1));
  assert.equal(cwd2, users.workspaceDirOf(U2));

  // 会话状态各存一份,且都不是 resume。
  const snap = sessions.snapshot();
  assert.equal(Object.keys(snap).length, 2);
  assert.equal(agent.calls[1]!.resume, undefined);
  assert.notEqual(snap[U1]!.current!.sessionId, snap[U2]!.current!.sessionId);
});

test("同一 userId 在不同账号下不串会话(核心隔离断言)", async () => {
  const t = 1_000_000;
  const { channel, agent, sessions, users } = build(() => t);
  // 两份凭据下出现同一个 from_user_id —— 单账号时代会被当成同一个人。
  const a = "wechat:acct-aaa:same-user@im.wechat";
  const b = "wechat:acct-bbb:same-user@im.wechat";

  await channel.receive(a, "第一条");
  await channel.receive(b, "第一条");

  assert.notEqual(users.workspaceDirOf(a), users.workspaceDirOf(b));
  assert.notEqual(agent.calls[0]!.cwd, agent.calls[1]!.cwd);
  // 第二个账号的用户必须是新会话,而不是 resume 前一个人的。
  assert.equal(agent.calls[1]!.resume, undefined);
  assert.equal(Object.keys(sessions.snapshot()).length, 2);
});

// --- 准入 ---

test("准入拒绝:不跑 agent、不写会话状态、不建工作目录", async () => {
  const t = 1_000_000;
  const { channel, agent, sessions, users } = build(() => t, {
    admission: () => ({ ok: false, reason: "测试拒绝", reply: "没有对你开放。" }),
  });
  await channel.receive(U1, "让我进去");

  assert.equal(agent.calls.length, 0);
  assert.deepEqual(sessions.snapshot(), {});
  assert.deepEqual(users.snapshot(), {});
  assert.deepEqual(channel.sent, [{ userKey: U1, text: "没有对你开放。", kind: "body" }]);
  // 被拒的人连 greeting 都不该收到 —— 那会泄漏"这个服务存在且能用"。
});

test("准入拒绝且无回复文案时完全静默", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t, {
    admission: () => ({ ok: false, reason: "静默丢弃" }),
  });
  await channel.receive(U1, "hello");
  assert.equal(agent.calls.length, 0);
  assert.deepEqual(channel.sent, []);
});

// --- 并发上限 ---

test("并发上限:同时在跑的回合数不超过 maxConcurrentTurns", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t, { settings: { maxConcurrentTurns: 2 } });
  let open!: () => void;
  agent.gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  // 5 个不同用户同时发消息(同一用户会被串行队列挡住,测不出并发)。
  const pending = [0, 1, 2, 3, 4].map((i) => channel.receive(`stdin:local:c${i}`, "跑"));
  // 让已获准的回合都进到 run 里。
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.peakInFlight, 2, "同时进行的回合应被限制在 2");

  open();
  await Promise.all(pending);
  assert.equal(agent.calls.length, 5, "排队的回合最终都要执行");
  assert.equal(agent.peakInFlight, 2);
});

// --- 首次使用指引 ---

test("greeting:首条消息先推指引再回答,第二条不再推", async () => {
  const t = 1_000_000;
  const { channel } = build(() => t);
  await channel.receive(U1, "你好");
  const greetings = channel.sent.filter((m) => m.text.startsWith("你好,我是 catman。"));
  assert.equal(greetings.length, 1);
  // 指引排在最前面,用户的问题照常得到回答。
  assert.equal(channel.sent[0]!.text, greetings[0]!.text);
  assert.ok(channel.sent.some((m) => m.text === "echo:你好"));

  await channel.receive(U1, "第二条");
  assert.equal(channel.sent.filter((m) => m.text.startsWith("你好,我是 catman。")).length, 1);
});

test("greeting:指引里列全了硬指令,它是唯一的发现入口", async () => {
  const t = 1_000_000;
  const { channel } = build(() => t);
  await channel.receive(U1, "你好");
  const g = channel.sent[0]!.text;
  for (const cmd of ["/帮助", "/状态", "/新会话", "/取消", "/继续", "/切换会话"]) {
    assert.ok(g.includes(cmd), `指引里缺了 ${cmd}`);
  }
});

test("指引:每个列表块前面都空一行 —— 紧贴上一段的话渲染完会糊成一坨", () => {
  // 这是它以前难看的真因:靠缩进两格分行,而 markdown 会把连续的行并成一段,
  // 十几条指令连成一大坨,看不出哪里是一条的开头。
  const lines = helpText(["sonnet", "opus"], true).split("\n");
  lines.forEach((line, i) => {
    if (!line.startsWith("- ")) return;
    const prev = lines[i - 1] ?? "";
    assert.ok(
      prev === "" || prev.startsWith("- "),
      `第 ${i + 1} 行是列表项,但上一行既不是空行也不是列表项:${JSON.stringify(prev)}`,
    );
  });
});

test("指引:带参指令的占位名包在反引号里 —— 裸的 <会话id> 会被当成 HTML 标签吃掉", () => {
  // 吃掉之后用户看到的是一条没有参数的 /切换会话,而它恰恰是最需要说清参数的那条。
  const help = helpText(["sonnet"], false);
  const line = help.split("\n").find((l) => l.includes(canonicalOf("switchSession")));
  assert.ok(line, "指引里没有 /切换会话");
  assert.match(line, /`\/切换会话 <会话id>`/, "占位名没被反引号保护");
});

test("greeting:推送失败时不标记,下次重试", async () => {
  const t = 1_000_000;
  const { channel, users } = build(() => t, { failSend: true });
  await channel.receive(U1, "你好");
  assert.equal(users.needsGreeting(U1), true, "发送失败不该标记为已推送");

  channel.failSend = false;
  await channel.receive(U1, "再来一条");
  assert.ok(channel.sent.some((m) => m.text.startsWith("你好,我是 catman。")));
  assert.equal(users.needsGreeting(U1), false);
});

test("greeting:渠道说他早收过了就不再推 —— 判定权在信使", async () => {
  // 信使是唯一见过某个 userKey 全部历史的进程,而人格有好几个、各有各的 users.json。
  // 不接这个标记的话,用户每切一次人格就收到一整份一模一样的欢迎语,
  // 白烧一条发送预算(一个 context_token 只够发约 10 条)。真机上首次 /救援 就是这样。
  const t = 1_000_000;
  const { channel, users } = build(() => t);
  await channel.receiveGreeted(U1, "你好");
  assert.equal(
    channel.sent.filter((m) => m.text.startsWith("你好,我是 catman。")).length,
    0,
    "信使说过了就不该再推",
  );
  assert.ok(channel.sent.some((m) => m.text === "echo:你好"), "消息本身照常处理");
  // 顺手把本地记录也补上:信使不在场的路径(dashboard 聊天)从此也不会再推。
  assert.equal(users.needsGreeting(U1), false);
});

test("greeting:标记缺席只表示渠道不知道,不表示没收过", async () => {
  // 它只能用来**抑制**推送,不能用来触发 —— stdin / dashboard 压根没有这项知识,
  // 把缺席当成"没收过"是对的,当成"收过了"会让本地渠道永远收不到指引。
  const t = 1_000_000;
  const { channel } = build(() => t);
  await channel.receive(U1, "你好");
  assert.equal(channel.sent.filter((m) => m.text.startsWith("你好,我是 catman。")).length, 1);
});

// --- token 到期告警 ---

test("token 告警只发给管理员,发送成功才落账", async () => {
  // 换发要人在宿主跑 setup-token —— 普通用户拿这条消息什么都做不了,只会吓一跳。
  // 发送成功才 markAnnounced,与部署结果播报同一条纪律:先标记等于把告警永久吞掉。
  const t = 1_000_000;
  let marked = 0;
  const tokenAlert = {
    pending: () => "【订阅凭据】还有约 5 天到期",
    markAnnounced: () => {
      marked += 1;
    },
  };
  const { channel, settings } = build(() => t, { tokenAlert });
  settings.set({ adminUserKeys: [U1] });

  await channel.receive(U2, "你好"); // 非管理员
  assert.equal(channel.sent.filter((m) => m.text.includes("订阅凭据")).length, 0);
  assert.equal(marked, 0);

  await channel.receive(U1, "你好"); // 管理员
  assert.equal(
    channel.sent.filter((m) => m.userKey === U1 && m.text.includes("订阅凭据")).length,
    1,
  );
  assert.equal(marked, 1);
});

test("token 告警发送失败不落账 —— 留给下次重试", async () => {
  const t = 1_000_000;
  let marked = 0;
  const tokenAlert = {
    pending: () => "【订阅凭据】快到期了",
    markAnnounced: () => {
      marked += 1;
    },
  };
  const { channel, settings } = build(() => t, { tokenAlert, failSend: true });
  settings.set({ adminUserKeys: [U1] });
  await channel.receive(U1, "你好");
  assert.equal(marked, 0, "发送失败不该标记已播报");
});

// --- 硬指令 ---

test("/帮助 不进 agent、不花额度", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  await channel.receive(U1, "先聊一句"); // 消化掉 greeting
  const before = agent.calls.length;
  channel.sent.length = 0;

  await channel.receive(U1, "/帮助");
  assert.equal(agent.calls.length, before, "/帮助 不该触发 agent 回合");
  assert.equal(channel.sent.length, 1);
  assert.ok(channel.sent[0]!.text.includes("/新会话"));
});

test("首条消息就是 /帮助 时不重复推送同样的内容", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  await channel.receive(U1, "/帮助");
  assert.equal(agent.calls.length, 0);
  // greeting 里已经含有整份指引,不该紧接着再来一条。
  assert.equal(channel.sent.length, 1);
  assert.ok(channel.sent[0]!.text.startsWith("你好,我是 catman。"));
});

test("裸词一律不是指令,照常交给 LLM", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  await channel.receive(U1, "先聊一句");
  const before = agent.calls.length;
  for (const word of ["帮助", "help", "继续", "新会话", "取消"]) {
    await channel.receive(U1, word);
  }
  assert.equal(agent.calls.length, before + 5, "五个裸词都应该进 agent,一条都不能被截胡");
});

test("硬指令绕过串行队列:回合卡住时 /状态 仍然立即响应", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  let open!: () => void;
  agent.gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  // 不 await:这一回合会一直卡在 gate 上,把串行队列堵死。
  const stuck = channel.receive(U1, "跑个很久的任务");
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.inFlight, 1, "回合应当已经进到 agent 里卡住了");
  channel.sent.length = 0;

  // 这就是硬指令存在的理由:排队的话它永远轮不到。
  await channel.receive(U1, "/状态");
  assert.ok(channel.sent.some((m) => m.text.startsWith("📋 当前状态")));
  assert.equal(agent.calls.length, 1, "/状态 不该触发新的 agent 回合");

  open();
  await stuck;
});

test("/取消 中断在飞回合,用户收到交代", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  agent.gate = new Promise<void>(() => {}); // 永不放行,只能靠 abort 打断
  const stuck = channel.receive(U1, "跑个很久的任务");
  await new Promise((r) => setImmediate(r));

  await channel.receive(U1, "/取消");
  await stuck; // abort 让回合抛错,由既有的错误分支收尾
  // 2026-08-21 起这句话按中止原因分岔:用户按 /取消 走"按你的要求"那一支,
  // 内存看门狗动手走另一支。原来一律是「已中断这一轮。」,分不清是谁干的 ——
  // 而这两种用户该做的事恰好相反(取消了就重发,内存中止重发还会死)。
  const cancelMsg = channel.sent.find((m) => /中断这一轮|按你的要求/.test(m.text));
  assert.ok(cancelMsg, "用户主动取消后要有交代");
  assert.match(cancelMsg!.text, /按你的要求/, "别把用户主动取消说得像出了故障");
  assert.doesNotMatch(cancelMsg!.text, /内存/, "这不是内存中止,别乱扣帽子");
  // 每一种中止都要告诉用户会话还在 —— 否则他会重开会话,那才真的丢上下文。
  assert.match(cancelMsg!.text, /会话没丢/);
});

test("/取消:没有在飞回合时如实说明", async () => {
  const t = 1_000_000;
  const { channel } = build(() => t);
  await channel.receive(U1, "先聊一句");
  channel.sent.length = 0;
  await channel.receive(U1, "/取消");
  assert.deepEqual(
    channel.sent.map((m) => m.text),
    ["现在没有正在跑的任务。"],
  );
});

test("/新会话:在飞回合结束后不把 sessionId 写回来", async () => {
  const t = 1_000_000;
  const { channel, agent, sessions } = build(() => t);
  let open!: () => void;
  agent.gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const stuck = channel.receive(U1, "长任务");
  await new Promise((r) => setImmediate(r));

  await channel.receive(U1, "/新会话");
  open();
  await stuck;

  // 回合的 record() 发生在 try 里,finally 里的归档必定在其后 ——
  // 净效果:没有进行中的会话,但那段对话进了历史,还能凭 id 切回。
  assert.equal(sessions.currentOf(U1), undefined);
  assert.deepEqual(
    sessions.historyOf(U1).map((h) => h.sessionId),
    ["sess-1"],
  );
});

test("/新会话:没有在飞回合时立即归档,并教用户怎么切回来", async () => {
  const t = 1_000_000;
  const { channel, sessions } = build(() => t);
  await channel.receive(U1, "先聊一句");
  assert.equal(sessions.currentOf(U1)?.sessionId, "sess-1");
  channel.sent.length = 0;

  await channel.receive(U1, "/新会话");
  assert.equal(sessions.currentOf(U1), undefined);
  assert.deepEqual(
    sessions.historyOf(U1).map((h) => h.sessionId),
    ["sess-1"],
  );
  // 归档不等于删除:确认语要教切回的完整指令,这是用户知道这件事的入口之一。
  assert.ok(
    channel.sent.some((m) => m.text.includes("/切换会话 sess-1")),
    `确认语里缺了切回指引:${JSON.stringify(channel.sent)}`,
  );
});

test("/继续 由后台消化:不触发回合,续上的会话留给下一条消息", async () => {
  let t = 1_000_000;
  const { channel, agent } = build(() => t);
  await channel.receive(U1, "第一条");
  t += TIMEOUT + 1; // 超时:此刻普通消息本该开新会话
  channel.sent.length = 0;

  await channel.receive(U1, "/继续");
  assert.equal(agent.calls.length, 1, "/继续 不该触发 agent 回合");
  assert.deepEqual(
    channel.sent.map((m) => m.text),
    ["好,接上刚才的对话了,直接发消息继续聊。"],
  );

  await channel.receive(U1, "那件事后来怎么样了");
  assert.equal(agent.calls.length, 2);
  assert.equal(agent.calls[1]!.resume, "sess-1", "/继续 之后的消息应当续上旧会话");
});

test("/继续:没有可继续的会话时如实说明,同样不触发回合", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  await channel.receive(U1, "/帮助"); // 消化掉 greeting;/帮助 不产生会话
  channel.sent.length = 0;

  await channel.receive(U1, "/继续");
  assert.equal(agent.calls.length, 0);
  assert.deepEqual(
    channel.sent.map((m) => m.text),
    ["现在没有可继续的对话,直接发消息就会开新的。"],
  );
});

test("/继续 在分拣节点里就地消化,不等在飞回合、也不起新回合", async () => {
  // 分拣节点不等回合,所以 /继续 不会被卡死的那一轮堵住 —— 这正是
  // "走队列"不再等于"排在回合后面"的地方。
  const t = 1_000_000;
  const { channel, agent, sessions } = build(() => t);
  await channel.receive(U1, "先聊一句"); // 有个 current 会话可续
  const open = stuckTurn(agent);
  const stuck = channel.receive(U1, "长任务");
  await waitUntil(() => agent.inFlight === 1, "长任务进到 agent 里");
  channel.sent.length = 0;

  await channel.receive(U1, "/继续");
  assert.equal(agent.calls.length, 2, "/继续 不该起回合");
  assert.ok(
    channel.sent.some((m) => m.text === "好,接上刚才的对话了,直接发消息继续聊。"),
    `回合卡着也该立刻答复,实际:${JSON.stringify(channel.sent.map((m) => m.text))}`,
  );

  open();
  await stuck;
  assert.equal(sessions.currentOf(U1)?.sessionId, "sess-1");
});

// --- /切换会话 ---

/** 造出「历史里躺着 sess-1、当前是 sess-2」的局面:聊一句 → /新会话 → 再聊一句。 */
async function withTwoSessions(channel: FakeChannel) {
  await channel.receive(U1, "聊聊 docker 镜像");
  await channel.receive(U1, "/新会话");
  await channel.receive(U1, "写个爬虫");
  channel.sent.length = 0;
}

test("单发 /切换会话:列出最近会话(含主题提示),不触发回合", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  await withTwoSessions(channel);
  const before = agent.calls.length;

  await channel.receive(U1, "/切换会话");
  assert.equal(agent.calls.length, before, "列表不该触发 agent 回合");
  assert.equal(channel.sent.length, 1);
  const list = channel.sent[0]!.text;
  assert.ok(list.includes("sess-2") && list.includes("(当前)"), `缺当前会话:${list}`);
  assert.ok(list.includes("sess-1"), `缺历史会话:${list}`);
  assert.ok(list.includes("聊聊 docker 镜像"), `缺主题提示:${list}`);
});

test("/切换会话 <id>:切回旧会话,之后的消息 resume 它;确认语教怎么切回来", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  await withTwoSessions(channel);

  await channel.receive(U1, "/切换会话 sess-1");
  const confirm = channel.sent[0]!.text;
  assert.ok(confirm.includes("sess-1"), `确认语要说切到了哪段:${confirm}`);
  assert.ok(confirm.includes("/切换会话 sess-2"), `确认语要教切回原会话:${confirm}`);

  await channel.receive(U1, "刚才那个镜像的事");
  assert.equal(agent.calls.at(-1)!.resume, "sess-1", "切换后的消息应 resume 目标会话");
});

test("/切换会话 找不到目标:如实说明并附列表,状态不动、不起回合", async () => {
  const t = 1_000_000;
  const { channel, agent, sessions } = build(() => t);
  await withTwoSessions(channel);
  const before = agent.calls.length;

  await channel.receive(U1, "/切换会话 zzzz");
  assert.equal(agent.calls.length, before);
  assert.equal(sessions.currentOf(U1)?.sessionId, "sess-2", "失败不该动当前会话");
  const reply = channel.sent[0]!.text;
  assert.ok(reply.includes("没找到"), reply);
  assert.ok(reply.includes("sess-1"), `失败时应附上可选清单:${reply}`);
});

test("聚合:/切换会话 id + 问题连发时合成一个回合,直接落在切到的会话里", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t, { settings: { messageAggregationMs: AGG } });
  await withTwoSessions(channel);

  await Promise.all([
    channel.receive(U1, "/切换会话 sess-1"),
    channel.receive(U1, "那个镜像后来构建成功了吗"),
  ]);
  const last = agent.calls.at(-1)!;
  assert.equal(last.prompt, "那个镜像后来构建成功了吗", "指令本身不该混进给 LLM 的文本");
  assert.equal(last.resume, "sess-1", "问题应落在切到的会话里");
});

test("聚合:窗口里的定时器必须维持事件循环 —— 否则只剩这批消息时进程会直接退出", async () => {
  // 这个定时器攥着**已经从渠道收下、长轮询游标也推进了**的消息,unref 掉就等于宣告
  // 「只剩这批没处理时可以直接退出」,那批消息真丢。生产进程总有 dashboard 与长轮询
  // 占着事件循环,永远看不出来;只有没有别的句柄时才暴露 —— 曾经就是靠制备容器里
  // node 22 的测试运行器抓出来的(它见事件循环跑空就把后面的用例全判 cancelled)。
  // 所以这里不靠特定 node 版本的行为,直接问运行时:这个定时器算不算"活着的句柄"。
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const { channel } = build(() => 1_000_000, { settings: { messageAggregationMs: AGG } });
  const done = channel.receive(U1, "先说一句"); // 故意不 await:此刻这批还在窗口里
  await new Promise((r) => setImmediate(r));
  const during = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.ok(during > before, "聚合窗口开着的时候,必须有一个维持事件循环的定时器");
  await done;
});

test("聚合:切换失败时同批的问题不处理 —— 那些话是冲着目标会话说的", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t, { settings: { messageAggregationMs: AGG } });
  await withTwoSessions(channel);
  const before = agent.calls.length;

  await Promise.all([
    channel.receive(U1, "/切换会话 zzzz"),
    channel.receive(U1, "那个镜像后来构建成功了吗"),
  ]);
  assert.equal(agent.calls.length, before, "落在错的会话里既答非所问又白花额度");
  assert.ok(
    channel.sent.some((m) => m.text.includes("先不处理")),
    `要明说消息没被处理:${JSON.stringify(channel.sent.map((m) => m.text))}`,
  );
});

test("/切换会话 目标记录已被清理:友好提示、剔除死条目、状态不动", async () => {
  // 保留期清理与 dropSessionIds 是同步的,但清理周期之间(或记录被外部删除)
  // history 仍可能挂着死引用 —— 切过去让 resume 炸出原始报错,不如提前给句人话。
  const t = 1_000_000;
  const { channel, agent, sessions } = build(() => t, {
    sessionExists: (_userKey, sessionId) => sessionId !== "sess-1",
  });
  await withTwoSessions(channel);
  const before = agent.calls.length;

  await channel.receive(U1, "/切换会话 sess-1");
  assert.equal(agent.calls.length, before, "不该起回合");
  assert.equal(sessions.currentOf(U1)?.sessionId, "sess-2", "当前会话不动");
  assert.deepEqual(sessions.historyOf(U1), [], "死条目应当场剔除,不再骗第二次");
  const reply = channel.sent[0]!.text;
  assert.ok(reply.includes("已被自动清理"), `要说清楚是被清理了而不是打错了:${reply}`);
});

test("单发 /切换会话:清单先出清已被清理的条目,不列切不过去的会话", async () => {
  const t = 1_000_000;
  const { channel, sessions } = build(() => t, {
    sessionExists: (_userKey, sessionId) => sessionId !== "sess-1",
  });
  await withTwoSessions(channel);

  await channel.receive(U1, "/切换会话");
  const list = channel.sent[0]!.text;
  assert.ok(!list.includes("sess-1"), `死条目不该出现在清单里:${list}`);
  assert.ok(list.includes("sess-2"), list);
  assert.deepEqual(sessions.historyOf(U1), [], "出清应落到状态里,不只是显示上藏起来");
});

test("/切换会话 当场生效:被切走的那一轮转后台跑完,产出进 history 不顶掉 current", async () => {
  const t = 1_000_000;
  const { channel, agent, sessions, turns } = build(() => t);
  await channel.receive(U1, "聊聊 docker 镜像"); // sess-1
  await channel.receive(U1, "/新会话");
  const open = stuckTurn(agent);
  const stuck = channel.receive(U1, "写个爬虫"); // sess-2,卡住
  await waitUntil(() => agent.inFlight === 1, "第二轮进到 agent 里");

  const sw = channel.receive(U1, "/切换会话 sess-1");
  await waitUntil(() => sessions.currentOf(U1)?.sessionId === "sess-1", "切换当场生效");
  assert.equal(turns.allFor(U1).length, 1, "那一轮没被停掉");
  assert.equal(turns.foregroundFor(U1), undefined, "但它已经不是前台了");
  assert.ok(
    channel.sent.some((m) => m.text.includes("后台接着跑")),
    "要告诉用户那一轮还在跑",
  );

  open();
  await Promise.all([stuck, sw]);
  assert.equal(sessions.currentOf(U1)?.sessionId, "sess-1", "后台回合不该顶掉当前会话");
  assert.ok(
    sessions.historyOf(U1).some((h) => h.sessionId === "sess-2"),
    "后台回合的产出应当落在 history 里",
  );
  assert.ok(
    channel.sent.some((m) => m.text.includes("【后台对话 sess-2 的结果】")),
    `后台结果要标明出处,实际:${JSON.stringify(channel.sent.map((m) => m.text))}`,
  );
});

// --- 每用户配置 ---

test("每用户模型覆盖传给 agent", async () => {
  const t = 1_000_000;
  const { channel, agent, prefs } = build(() => t);
  prefs.set(U1, { model: "sonnet" });
  await channel.receive(U1, "你好");
  await channel.receive(U2, "你好");
  assert.equal(agent.calls[0]!.model, "sonnet");
  assert.equal(agent.calls[1]!.model, undefined, "没设过的人回落到全局(此处为不指定)");
});

test("模型被移出白名单后回落,加回来自动恢复,盘上不改", async () => {
  const t = 1_000_000;
  const { channel, agent, prefs, settings } = build(() => t, {
    settings: { model: "opus" },
  });
  prefs.set(U1, { model: "sonnet" });

  settings.set({ modelAllowlist: ["opus"] });
  await channel.receive(U1, "一");
  assert.equal(agent.calls[0]!.model, "opus", "失效的覆盖应当回落到全局默认");
  assert.deepEqual(prefs.get(U1), { model: "sonnet" }, "回落不该改盘");

  settings.set({ modelAllowlist: ["opus", "sonnet"] });
  await channel.receive(U1, "二");
  assert.equal(agent.calls[1]!.model, "sonnet", "白名单加回来后应当自动恢复");
});

test("全局默认也失效时完全不传 model —— 兜底链末端,agent 照样能起来", async () => {
  const t = 1_000_000;
  const { channel, agent, prefs, settings } = build(() => t, { settings: { model: "opus" } });
  prefs.set(U1, { model: "sonnet" });
  // 白名单收到只剩 haiku:用户的 sonnet 和全局的 opus 同时失效。
  settings.set({ modelAllowlist: ["haiku"] });
  await channel.receive(U1, "你好");
  assert.equal(agent.calls[0]!.model, undefined);
  assert.ok(channel.sent.some((m) => m.text === "echo:你好"), "仍然要能正常回答");
});

test("并发上限可运行时调整", async () => {
  const t = 1_000_000;
  const { channel, agent, settings } = build(() => t, { settings: { maxConcurrentTurns: 1 } });
  let open!: () => void;
  agent.gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const pending = [0, 1, 2].map((i) => channel.receive(`stdin:local:n${i}`, "跑"));
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.peakInFlight, 1);

  settings.set({ maxConcurrentTurns: 3 });
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.peakInFlight, 3, "调高上限应当立刻放行排队的回合");

  open();
  await Promise.all(pending);
});

// --- 管理员权限的下放 ---

test("管理员令牌只注入 admin 回合的子进程", async () => {
  const t = 1_000_000;
  process.env.CATMAN_ADMIN_TOKEN = "secret-token";
  try {
    const { channel, agent } = build(() => t);
    await channel.receive(U1, "普通用户");
    await channel.receive(BUILTIN_ADMIN_USER_KEY, "管理员");

    assert.equal(agent.calls[0]!.env?.["CATMAN_ADMIN_TOKEN"], undefined, "普通回合不得拿到管理员令牌");
    assert.equal(agent.calls[1]!.env?.["CATMAN_ADMIN_TOKEN"], "secret-token");
    // 回合令牌两边都有,且各不相同。
    assert.ok(agent.calls[0]!.env?.["CATMAN_SESSION_TOKEN"]);
    assert.notEqual(
      agent.calls[0]!.env?.["CATMAN_SESSION_TOKEN"],
      agent.calls[1]!.env?.["CATMAN_SESSION_TOKEN"],
    );
  } finally {
    delete process.env.CATMAN_ADMIN_TOKEN;
  }
});

test("IPC secret 一条例外都没有 —— 连管理员回合也拿不到", async () => {
  // 拿到它 = 拿到信使的整个控制面(同容器同 uid,socket 就在 /data/ipc 下):
  // 冒充任意 userKey 发消息并烧光他的预算、拉走并 ack 掉别人的消息、
  // 走 /admin/* 删账号 —— 最后这条会把 persona-isolation 那道墙整个绕过去。
  const t = 1_000_000;
  process.env.CATMAN_IPC_SECRET = "ipc-secret-value";
  process.env.CATMAN_ADMIN_TOKEN = "secret-token";
  try {
    const { channel, agent } = build(() => t);
    await channel.receive(U1, "普通用户");
    await channel.receive(BUILTIN_ADMIN_USER_KEY, "管理员");
    assert.equal(agent.calls[0]!.env?.["CATMAN_IPC_SECRET"], undefined);
    assert.equal(
      agent.calls[1]!.env?.["CATMAN_IPC_SECRET"],
      undefined,
      "管理员令牌有「admin 回合加回」那一档,IPC secret 没有 —— 回合一次都不需要它",
    );
  } finally {
    delete process.env.CATMAN_IPC_SECRET;
    delete process.env.CATMAN_ADMIN_TOKEN;
  }
});

test("admin skill 只对 admin 回合可见", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  await channel.receive(U1, "普通用户");
  await channel.receive(BUILTIN_ADMIN_USER_KEY, "管理员");
  assert.equal(agent.calls[0]!.skills?.includes(ADMIN_SKILL), false);
  assert.equal(agent.calls[1]!.skills?.includes(ADMIN_SKILL), true);
});

test("把普通用户列为管理员后,他的回合也拿到管理员能力", async () => {
  const t = 1_000_000;
  process.env.CATMAN_ADMIN_TOKEN = "secret-token";
  try {
    const { channel, agent, settings } = build(() => t);
    await channel.receive(U1, "还不是管理员");
    settings.set({ adminUserKeys: [U1] });
    await channel.receive(U1, "现在是了");

    assert.equal(agent.calls[0]!.env?.["CATMAN_ADMIN_TOKEN"], undefined);
    assert.equal(agent.calls[1]!.env?.["CATMAN_ADMIN_TOKEN"], "secret-token");
    assert.equal(agent.calls[1]!.skills?.includes(ADMIN_SKILL), true);
  } finally {
    delete process.env.CATMAN_ADMIN_TOKEN;
  }
});

test("/api/me/session/reset:回合转后台,当前会话归档,产出不写回 current", async () => {
  const t = 1_000_000;
  const { channel, sessions, turns } = build(() => t);
  await channel.receive(U1, "第一条");
  assert.equal(Object.keys(sessions.snapshot()).length, 1);

  // 模拟 agent 在回合中调了 reset 接口 —— 与 api-self 里那两步一模一样:
  // 本回合转后台,当前会话就地归档。
  let seen = false;
  const orig = turns.mint.bind(turns);
  turns.mint = (userKey: string) => {
    const m = orig(userKey);
    if (!seen) {
      seen = true;
      m.ctx.detached = true;
      sessions.archiveCurrent(userKey);
    }
    return m;
  };
  await channel.receive(U1, "第二条");
  assert.equal(sessions.currentOf(U1), undefined, "detached 的回合不该写回 current");
  assert.ok(
    sessions.historyOf(U1).some((h) => h.sessionId === "sess-1"),
    "被 reset 的会话应归档而不是消失",
  );
});

// --- 图片附件透传 ---

/** 一张最小的合法 PNG 附件(网关不校验内容,只透传)。 */
function fakeImage(): Attachment {
  return {
    kind: "image",
    mediaType: "image/png",
    data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    bytes: 4,
  };
}

test("图片附件透传到 Agent,不在网关里被丢掉", async () => {
  const { channel, agent } = build(() => 1_000_000);
  const img = fakeImage();
  await channel.receive(U1, "这是什么?", [img]);
  assert.equal(agent.calls.length, 1);
  assert.deepEqual(agent.calls[0]!.attachments, [img]);
  assert.equal(agent.calls[0]!.prompt, "这是什么?");
});

test("只发图不发字也照常起一个回合", async () => {
  // 老实现里空文本会被 `if (!text) return` 丢掉 —— 用户视角就是"发了没反应"。
  const { channel, agent } = build(() => 1_000_000);
  await channel.receive(U1, "", [fakeImage()]);
  assert.equal(agent.calls.length, 1, "纯图片消息应当触发回合");
  assert.equal(agent.calls[0]!.prompt, "");
  assert.equal(agent.calls[0]!.attachments?.length, 1);
});

test("纯文本回合不带 attachments —— 调用形状与从前完全一致", async () => {
  const { channel, agent } = build(() => 1_000_000);
  await channel.receive(U1, "只有文字");
  assert.equal(agent.calls[0]!.attachments, undefined);
});

test("带图时不按硬指令解析:图片不会被指令分支吞掉", async () => {
  // 「/状态 + 一张图」显然不是想看状态。硬指令要求整条消息只有指令本身。
  const { channel, agent } = build(() => 1_000_000);
  await channel.receive(U1, "/状态", [fakeImage()]);
  assert.equal(agent.calls.length, 1, "应当走 LLM 而不是 immediate 指令");
  assert.equal(agent.calls[0]!.attachments?.length, 1);
});

test("带图的回合跑着时,后面的话追加进去而不是另起一轮", async () => {
  // 同一会话永远只有一个回合在跑 —— 后来的话要么追加进去,要么排在它后面。
  const { channel, agent } = build(() => 1_000_000);
  const release = stuckTurn(agent);

  const first = channel.receive(U1, "第一条", [fakeImage()]);
  await waitUntil(() => agent.inFlight === 1, "第一条进到 agent 里");
  const second = channel.receive(U1, "第二条");
  await new Promise((r) => setImmediate(r));

  assert.equal(agent.calls.length, 1, "不该为第二条另起一轮");
  assert.deepEqual(agent.fed.map((f) => f.prompt), ["第二条"]);
  release();
  await Promise.all([first, second]);
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.peakInFlight, 1, "同一会话绝不并发");
});

// --- 消息聚合窗口 ---

/**
 * 微信发「图 + 文字」是两条消息(真机实测相隔约 120ms)。不聚合的话会起两个回合,
 * 而且先到的那条必然缺另一半 —— 助手先答一句"我没看到图"再答一遍。
 *
 * 用例里把窗口设成几十毫秒,靠 await dispatch 返回的 promise 判定完成。
 */
const AGG = 40;

test("聚合:连发的图与文合并成一个回合", async () => {
  const { channel, agent } = build(() => 1_000_000, { settings: { messageAggregationMs: AGG } });
  const img = fakeImage();
  // 真机顺序:图片先到,文本紧随其后。
  const a = channel.receive(U1, "", [img]);
  const b = channel.receive(U1, "这是什么?");
  await Promise.all([a, b]);

  assert.equal(agent.calls.length, 1, "两条消息应当只起一个回合");
  assert.equal(agent.calls[0]!.prompt, "这是什么?");
  assert.deepEqual(agent.calls[0]!.attachments, [img]);
});

test("聚合:多条文字按到达顺序合并", async () => {
  const { channel, agent } = build(() => 1_000_000, { settings: { messageAggregationMs: AGG } });
  await Promise.all([
    channel.receive(U1, "第一句"),
    channel.receive(U1, "第二句"),
    channel.receive(U1, "第三句"),
  ]);
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0]!.prompt, "第一句\n第二句\n第三句");
});

test("聚合:窗口过后再来的消息另起一个回合", async () => {
  const { channel, agent } = build(() => 1_000_000, { settings: { messageAggregationMs: AGG } });
  await channel.receive(U1, "第一批");
  await channel.receive(U1, "第二批");
  assert.equal(agent.calls.length, 2, "隔开的两条不该被并到一起");
  assert.equal(agent.calls[0]!.prompt, "第一批");
  assert.equal(agent.calls[1]!.prompt, "第二批");
});

test("聚合:不同用户各攒各的,不会串到一起", async () => {
  const { channel, agent } = build(() => 1_000_000, { settings: { messageAggregationMs: AGG } });
  await Promise.all([
    channel.receive(U1, "甲的话"),
    channel.receive(U2, "乙的话"),
    channel.receive(U1, "甲的第二句"),
  ]);
  assert.equal(agent.calls.length, 2);
  const byPrompt = agent.calls.map((c) => c.prompt).sort();
  assert.deepEqual(byPrompt, ["乙的话", "甲的话\n甲的第二句"]);
});

test("聚合:用户一直在发就一直攒 —— 攒到一起本身就是想要的结果", async () => {
  // 上限不是公平性限制:人还在打字说明话没说完,这时候切批去起回合是打断他。
  // 窗口 40ms、上限 40 倍 = 1.6s;这里连发 10 条、间隔半个窗口,远不到上限。
  const { channel, agent } = build(() => 1_000_000, { settings: { messageAggregationMs: AGG } });
  const sent: Promise<void>[] = [];
  for (let i = 0; i < 10; i++) {
    sent.push(channel.receive(U1, `第${i}条`));
    await new Promise((r) => setTimeout(r, AGG / 2));
  }
  await Promise.all(sent);
  assert.equal(agent.calls.length, 1, "持续发消息期间不该切批");
  assert.equal(agent.calls[0]!.prompt.split("\n").length, 10, "十条应当全在同一个回合里");
});

test("聚合:极端连发有个兜底上限,batch 不会无限攒下去", async () => {
  // 唯一的理由是内存 —— batch 把文本与图片攒在内存里,总得有不再增长的时刻。
  // 窗口 10ms → 上限 400ms;每 5ms 发一条,发满 1 秒必然跨过它。
  const { channel, agent } = build(() => 1_000_000, { settings: { messageAggregationMs: 10 } });
  const sent: Promise<void>[] = [];
  const started = Date.now();
  while (Date.now() - started < 1000) {
    sent.push(channel.receive(U1, "x"));
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.all(sent);
  assert.ok(agent.calls.length >= 2, `兜底上限应当切批,实际只有 ${agent.calls.length} 批`);
});

test("聚合:immediate 硬指令不进窗口,依旧立即响应", async () => {
  // 这是硬指令存在的全部理由 —— 让救命的指令先等 1.5 秒等于取消了这个理由。
  const { channel, agent } = build(() => 1_000_000, { settings: { messageAggregationMs: 5000 } });
  void channel.receive(U1, "先发一条正常消息"); // 进窗口攒着
  await channel.receive(U1, "/状态");
  const status = afterGreeting(channel.sent).find((m) => m.text.startsWith("📋"));
  assert.ok(status, "/状态 应当在聚合窗口之外立即响应");
  assert.equal(agent.calls.length, 0, "正常消息这时还在窗口里攒着");
});

test("聚合:/取消 把还没入队的那批也丢掉", async () => {
  // 用户看不见队列。他要取消的是刚发出去的那几条,不管它们变没变成回合。
  const { channel, agent } = build(() => 1_000_000, { settings: { messageAggregationMs: 5000 } });
  void channel.receive(U1, "算了不问了");
  await channel.receive(U1, "/取消");
  assert.equal(agent.calls.length, 0, "被取消的那批不该再进 agent");
  const replies = afterGreeting(channel.sent).map((m) => m.text);
  assert.ok(
    replies.some((t) => t.includes("还没开始处理")),
    `应当告诉用户丢掉了,实际:${JSON.stringify(replies)}`,
  );
});

test("聚合:/继续 与问题连发时合成一个回合 —— 只带 resume 标记,不混进文本", async () => {
  let t = 1_000_000;
  const { channel, agent } = build(() => t, { settings: { messageAggregationMs: AGG } });
  await channel.receive(U1, "第一条");
  t += TIMEOUT + 1; // 超时:没有 /继续 的话,下一批本该开新会话

  await Promise.all([channel.receive(U1, "/继续"), channel.receive(U1, "接着改那个脚本")]);
  assert.equal(agent.calls.length, 2, "两条应当合成一个回合");
  const last = agent.calls[1]!;
  assert.equal(last.prompt, "接着改那个脚本", "指令本身不该混进给 LLM 的文本");
  assert.equal(last.resume, "sess-1", "批里带着 /继续:超时后也应当续上旧会话");
});

test("聚合:合并后仍然重新收一次图片上限", async () => {
  // 渠道只保证单条消息不超上限;连发几条各带图仍可能超。
  const { channel, agent } = build(() => 1_000_000, {
    settings: { messageAggregationMs: AGG, maxImagesPerTurn: 2 },
  });
  await Promise.all([
    channel.receive(U1, "", [fakeImage(), fakeImage()]),
    channel.receive(U1, "看图", [fakeImage()]),
  ]);
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0]!.attachments?.length, 2, "超出的应当被截断");
});

test("聚合:关闭时(设 0)每条消息各起一个回合", async () => {
  const { channel, agent } = build(() => 1_000_000, { settings: { messageAggregationMs: 0 } });
  await channel.receive(U1, "一");
  await channel.receive(U1, "二");
  assert.equal(agent.calls.length, 2);
});

test("聚合:stop() 把攒着的消息交出去,不静默吞掉", async () => {
  // 消息已经从渠道收下了(长轮询游标也推进了),丢掉就是真丢。
  const { channel, agent, gw } = build(() => 1_000_000, {
    settings: { messageAggregationMs: 5000 },
  });
  const pending = channel.receive(U1, "关机前发的");
  await gw.stop();
  await pending;
  assert.equal(agent.calls.length, 1, "stop() 应当把攒着的那批 flush 出去");
  assert.equal(agent.calls[0]!.prompt, "关机前发的");
});

// --- 追加输入:回合跑到一半再发消息 ---

/**
 * 排队等这一轮跑完,在用户那边就是"发了没反应" —— 连回执都发不出来
 * (回执在 handle 里,而 handle 排在队列尾)。追加进去则是模型下一次请求就看到。
 *
 * 这组用例把回合卡在 gate 上模拟"正在跑",再往里发消息。
 */
function stuckTurn(agent: FakeAgent): () => void {
  let open!: () => void;
  agent.gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => open();
}

test("追加输入:回合跑着时发的消息折进这一轮,不另起回合", async () => {
  const { channel, agent } = build(() => 1_000_000);
  const open = stuckTurn(agent);

  const first = channel.receive(U1, "帮我改那个脚本");
  await waitUntil(() => agent.inFlight === 1, "第一轮进到 agent 里");

  await channel.receive(U1, "等下,用 sed 别用 python");
  assert.deepEqual(
    agent.fed.map((f) => f.prompt),
    ["等下,用 sed 别用 python"],
    "补充应当追加进在飞回合",
  );
  assert.equal(agent.calls.length, 1, "不该为补充另起一个回合");

  open();
  await first;
  assert.equal(agent.calls.length, 1, "回合跑完后也不该补一个回合出来");
});

test("追加输入:聚合窗口照旧生效,图与文一起追加", async () => {
  // 「图 + 文字是两条消息」那条不变量在追加路径上同样成立。
  const { channel, agent } = build(() => 1_000_000, { settings: { messageAggregationMs: AGG } });
  const open = stuckTurn(agent);
  const img = fakeImage();

  const first = channel.receive(U1, "先看看这个");
  // 第一条要先走完自己的聚合窗口才会入队;waitUntil 靠 setImmediate 推进,
  // 空转得比窗口快得多,不先睡一下会等不到。
  await new Promise((r) => setTimeout(r, AGG * 2));
  await waitUntil(() => agent.inFlight === 1, "第一轮进到 agent 里");

  await Promise.all([channel.receive(U1, "", [img]), channel.receive(U1, "还有这张图")]);
  assert.equal(agent.fed.length, 1, "两条应当攒成一次追加");
  assert.equal(agent.fed[0]!.prompt, "还有这张图");
  assert.deepEqual(agent.fed[0]!.attachments, [img]);

  open();
  await first;
});

test("追加输入:回合已收摊时回落到新回合,消息不丢", async () => {
  const { channel, agent } = build(() => 1_000_000);
  await channel.receive(U1, "第一句");
  assert.equal(agent.calls.length, 1);

  // 回合早跑完了,agent 侧的追加窗口已关 —— 这条该照常起新回合。
  await channel.receive(U1, "第二句");
  assert.equal(agent.fed.length, 0, "收摊后不该还能追加");
  assert.equal(agent.calls.length, 2);
  assert.equal(agent.calls[1]!.prompt, "第二句");
  assert.equal(agent.calls[1]!.resume, "sess-1", "回落的回合照常 resume");
});

test("追加输入:/切换会话 不追加,留在队列里排在 record() 之后", async () => {
  // 它改会话指针,折进在飞回合的话会被那一轮结束时的 record() 写回覆盖 ——
  // 与它不走 immediate 分流是同一个理由。
  const { channel, agent, sessions } = build(() => 1_000_000);
  await channel.receive(U1, "第一段对话"); // 产生 sess-1
  await channel.receive(U1, "/新会话");

  const open = stuckTurn(agent);
  const second = channel.receive(U1, "第二段对话");
  await waitUntil(() => agent.inFlight === 1, "第二轮进到 agent 里");

  const switching = channel.receive(U1, "/切换会话 sess-1");
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.fed.length, 0, "/切换会话 不该被折进在飞回合");

  open();
  await Promise.all([second, switching]);
  assert.equal(sessions.currentOf(U1)?.sessionId, "sess-1", "切换应当发生在回合收尾之后");
});

test("追加输入:次数用尽后回落到队列", async () => {
  // 兜底而非公平性限制:每次追加都把这一轮往后拖,而正文要等回合结束才发得出。
  const { channel, agent } = build(() => 1_000_000);
  const open = stuckTurn(agent);
  const first = channel.receive(U1, "开工");
  await waitUntil(() => agent.inFlight === 1, "第一轮进到 agent 里");

  for (let i = 0; i < MAX_FEEDS_PER_TURN; i++) {
    await channel.receive(U1, `补充${i}`);
  }
  assert.equal(agent.fed.length, MAX_FEEDS_PER_TURN, "上限之内都该追加进去");

  // 第 N+1 条:追加额度没了,回落到队列 —— 它会等这一轮跑完再起回合。
  const overflow = channel.receive(U1, "再补一条");
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.fed.length, MAX_FEEDS_PER_TURN, "超出的不该再追加");
  assert.equal(agent.calls.length, 1, "它应当还在队列里等着");

  open();
  await Promise.all([first, overflow]);
  assert.equal(agent.calls.length, 2, "回落的那条应当自己起一个回合");
  assert.equal(agent.calls[1]!.prompt, "再补一条");
});

test("追加输入:图片上限跨追加累计 —— 闸门管的是整个回合", async () => {
  const { channel, agent } = build(() => 1_000_000, { settings: { maxImagesPerTurn: 3 } });
  const open = stuckTurn(agent);
  const first = channel.receive(U1, "看图", [fakeImage(), fakeImage()]);
  await waitUntil(() => agent.inFlight === 1, "第一轮进到 agent 里");

  await channel.receive(U1, "再看这两张", [fakeImage(), fakeImage()]);
  assert.equal(agent.fed[0]!.attachments.length, 1, "回合里已经有 2 张,只放得下 1 张");

  await channel.receive(U1, "还有这张", [fakeImage()]);
  assert.equal(agent.fed[1]!.attachments.length, 0, "额度已经用满");
  assert.equal(agent.fed[1]!.prompt, "还有这张", "图放不下也不影响文字追加进去");

  open();
  await first;
});

test("追加输入:/状态 报出补充了几条 —— 别处看不见它们", async () => {
  // 被折进 turn 的消息不会在 SDK 消息流里露面,不记账的话
  // 「我刚补的那句进去了吗」没有任何地方答得出。
  const { channel, agent } = build(() => 1_000_000);
  const open = stuckTurn(agent);
  const first = channel.receive(U1, "开工");
  await waitUntil(() => agent.inFlight === 1, "第一轮进到 agent 里");

  await channel.receive(U1, "补充一");
  await channel.receive(U1, "补充二");
  channel.sent.length = 0;
  await channel.receive(U1, "/状态");
  const status = channel.sent.find((m) => m.text.startsWith("📋"));
  assert.ok(status?.text.includes("期间补充 2 条"), `实际:${status?.text}`);

  open();
  await first;
});

test("追加输入:回执发出并在回合收尾时一并撤回", async () => {
  const { channel, agent } = build(() => 1_000_000, { supportsRecall: true });
  const open = stuckTurn(agent);
  const first = channel.receive(U1, "开工");
  await waitUntil(() => agent.inFlight === 1, "第一轮进到 agent 里");

  await channel.receive(U1, "补一句");
  await waitUntil(
    () => channel.sent.some((m) => m.text === FEED_ACK_TEXT),
    "追加回执发出去",
  );

  open();
  await first;
  // greeting=msg-1、首条回执=msg-2、追加回执=msg-3;两条回执都该撤掉,
  // 不撤的话被追加过的回合会在聊天记录里永久攒下一串"收到"。
  assert.deepEqual(channel.recalled.sort(), ["msg-2", "msg-3"]);
});

test("追加输入:关掉回执的用户不会收到追加回执", async () => {
  const { channel, agent, prefs } = build(() => 1_000_000);
  prefs.set(U1, { ackEnabled: false });
  const open = stuckTurn(agent);
  const first = channel.receive(U1, "开工");
  await waitUntil(() => agent.inFlight === 1, "第一轮进到 agent 里");

  await channel.receive(U1, "补一句");
  assert.equal(agent.fed.length, 1, "追加本身照常发生");
  assert.ok(!channel.sent.some((m) => m.text === FEED_ACK_TEXT), "但不该有回执");

  open();
  await first;
});

test("追加输入:排队中的回合不接受追加 —— 那时还没有 turn 可折", async () => {
  // 并发名额被别人占着时,自己这一轮还没进 agent。消息该照常排队。
  const { channel, agent } = build(() => 1_000_000, { settings: { maxConcurrentTurns: 1 } });
  const open = stuckTurn(agent);
  const blocking = channel.receive(U2, "占住唯一的名额");
  await waitUntil(() => agent.inFlight === 1, "U2 占住名额");

  const queued = channel.receive(U1, "我先排着");
  await new Promise((r) => setImmediate(r));
  // 不 await:它排在 U1 队列里那条还没拿到名额的回合后面,await 会直接死锁。
  const extra = channel.receive(U1, "再补一句");
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.fed.length, 0, "排队中的回合没有 feed 可挂");

  open();
  await Promise.all([blocking, queued, extra]);
  assert.equal(agent.calls.length, 3, "两条各自成回合");
});

test("追加输入:纯 /继续 不追加,仍旧走队列里的 touch", async () => {
  const { channel, agent } = build(() => 1_000_000);
  const open = stuckTurn(agent);
  const first = channel.receive(U1, "开工");
  await waitUntil(() => agent.inFlight === 1, "第一轮进到 agent 里");

  const cont = channel.receive(U1, "/继续");
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.fed.length, 0, "没有可追加的内容");

  open();
  await Promise.all([first, cont]);
  assert.equal(agent.calls.length, 1, "/继续 不该起回合");
});

test("追加输入:图被额度挤光又没文字时回落到队列,不递空内容给模型", async () => {
  // 截断后可能什么都不剩 —— 空 content 会被模型侧直接拒收。回落反而更好:
  // 新回合有一整份图片额度。
  const { channel, agent } = build(() => 1_000_000, { settings: { maxImagesPerTurn: 1 } });
  const open = stuckTurn(agent);
  const first = channel.receive(U1, "看图", [fakeImage()]);
  await waitUntil(() => agent.inFlight === 1, "第一轮进到 agent 里");

  const overflow = channel.receive(U1, "", [fakeImage()]); // 纯图片,额度已满
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.fed.length, 0, "没东西可追加就不该追加");
  assert.equal(agent.calls.length, 1, "它应当在队列里等着");

  open();
  await Promise.all([first, overflow]);
  assert.equal(agent.calls.length, 2, "回落的那条自己起一个回合");
  assert.equal(agent.calls[1]!.attachments?.length, 1, "新回合有完整的图片额度");
});

test("空批不起回合 —— 没有内容可给模型,额度也不该花", async () => {
  // 渠道通常挡了空消息;这里防的是"纯图片消息的图在渠道那边解码失败被跳过"
  // 之后剩下的空壳。
  const { channel, agent } = build(() => 1_000_000);
  await channel.receive(U1, "");
  assert.equal(agent.calls.length, 0, "空消息不该起回合");
});

test("追加输入:「/继续 + 话」按顺序处理 —— 先 touch,话再追加进在飞回合", async () => {
  // 线性分拣的直接结果:指令原地消化,它后面的话照常投递给当前会话。
  // 有回合在跑说明会话根本没超时,/继续 本就是个 no-op。
  const { channel, agent } = build(() => 1_000_000, { settings: { messageAggregationMs: AGG } });
  const open = stuckTurn(agent);
  const first = channel.receive(U1, "开工");
  await new Promise((r) => setTimeout(r, AGG * 2));
  await waitUntil(() => agent.inFlight === 1, "第一轮进到 agent 里");

  const batch = Promise.all([
    channel.receive(U1, "/继续"),
    channel.receive(U1, "接着刚才那个"),
  ]);
  await new Promise((r) => setTimeout(r, AGG * 2));
  assert.deepEqual(agent.fed.map((f) => f.prompt), ["接着刚才那个"]);
  assert.equal(agent.calls.length, 1, "不该另起一轮");

  open();
  await Promise.all([first, batch]);
});

// --- 线性分拣与后台会话 ---

test("线性分拣:指令之前的话落在原会话,之后的话落在切过去那段", async () => {
  // 这是整个流水线的核心断言。压平成「一段文本 + 几个标记」就丢掉了顺序,
  // 只能靠"整批不处理"兜底;按到达顺序线性处理则天然正确。
  const { channel, agent, sessions } = build(() => 1_000_000, {
    settings: { messageAggregationMs: AGG },
  });
  await channel.receive(U1, "第一段对话"); // sess-1
  await channel.receive(U1, "/新会话");
  await channel.receive(U1, "第二段对话"); // sess-2
  agent.calls.length = 0;

  // 一批里:先说一句 → 切回 sess-1 → 再说一句
  await Promise.all([
    channel.receive(U1, "这句属于第二段"),
    channel.receive(U1, "/切换会话 sess-1"),
    channel.receive(U1, "这句属于第一段"),
  ]);

  assert.equal(agent.calls.length, 2, "指令把这批切成了两次投递");
  assert.equal(agent.calls[0]!.prompt, "这句属于第二段");
  assert.equal(agent.calls[0]!.resume, "sess-2", "指令之前的话该落在原来那段");
  assert.equal(agent.calls[1]!.prompt, "这句属于第一段");
  assert.equal(agent.calls[1]!.resume, "sess-1", "指令之后的话该落在切过去那段");
  assert.equal(sessions.currentOf(U1)?.sessionId, "sess-1");
});

test("线性分拣:指令失败时只中止剩下的段,已投递的不受影响", async () => {
  const { channel, agent } = build(() => 1_000_000, { settings: { messageAggregationMs: AGG } });
  await channel.receive(U1, "开个头"); // sess-1
  agent.calls.length = 0;

  await Promise.all([
    channel.receive(U1, "这句照常处理"),
    channel.receive(U1, "/切换会话 根本不存在"),
    channel.receive(U1, "这句冲着那段说的"),
  ]);

  assert.deepEqual(
    agent.calls.map((c) => c.prompt),
    ["这句照常处理"],
    "指令之前的话属于当前会话,照常投递;之后的话该被中止",
  );
  assert.ok(
    channel.sent.some((m) => m.text.includes("这批消息先不处理")),
    "要交代剩下的话没处理",
  );
});

test("/新会话:在飞回合转后台跑完,结果带出处送来", async () => {
  const { channel, agent, sessions, turns } = build(() => 1_000_000);
  const open = stuckTurn(agent);
  const stuck = channel.receive(U1, "跑个长任务");
  await waitUntil(() => agent.inFlight === 1, "回合进到 agent 里");

  await channel.receive(U1, "/新会话");
  assert.equal(turns.allFor(U1).length, 1, "那一轮没被停掉");
  assert.equal(turns.foregroundFor(U1), undefined, "但已经不是前台");
  assert.ok(channel.sent.some((m) => m.text.includes("后台接着跑")));

  open();
  await stuck;
  assert.ok(
    channel.sent.some((m) => m.text.startsWith("【后台对话 sess-1 的结果】")),
    `后台结果要标明出处,实际:${JSON.stringify(channel.sent.map((m) => m.text))}`,
  );
  assert.equal(sessions.currentOf(U1), undefined, "后台回合不该把自己写成当前会话");
  assert.deepEqual(sessions.historyOf(U1).map((h) => h.sessionId), ["sess-1"]);
});

test("后台回合报错时,错误说明也要标明出处", async () => {
  // 正文标出处、错误说明不标的话,这句「处理出错了」会被当成当前会话的答复 ——
  // 而用户此刻正在跟另一段对话说话,他会以为是刚发的那句话出了问题。
  const { channel, agent } = build(() => 1_000_000);
  const open = stuckTurn(agent);
  const stuck = channel.receive(U1, "跑个长任务");
  await waitUntil(() => agent.inFlight === 1, "回合进到 agent 里");
  await channel.receive(U1, "/新会话");

  channel.sent.length = 0;
  agent.fail = true;
  open();
  await stuck;

  const err = channel.sent.find((m) => m.text.includes("处理出错了"));
  assert.ok(err, `报错要送到用户那儿,实际:${JSON.stringify(channel.sent.map((m) => m.text))}`);
  // 2026-08-21 改:这里原来断言的是「【后台对话的结果】」(不带 id),理由写着
  // "新会话的首轮抛错,sessionId 压根还没存在过"。**那个前提是错的** ——
  // sessionId 随第一条 SDK 消息就到,远早于任何工具调用,只是从前没往外传。
  // 同一个错误认知让被中止的会话再也接不上(见「回合被中止:会话仍要记下来」),
  // 修好之后这里顺带也能给出切回的指令了。
  assert.ok(err.text.startsWith("【后台对话 sess-1 的结果】"), `实际:${err.text}`);
  assert.match(err.text, /切换会话 sess-1/, "id 有了就该告诉用户怎么切回去");
});

test("后台回合报错:resume 的那轮报得出会话 id", async () => {
  const { channel, agent } = build(() => 1_000_000);
  await channel.receive(U1, "第一轮"); // 建立 sess-1

  const open = stuckTurn(agent);
  const stuck = channel.receive(U1, "接着聊"); // resume sess-1,卡住
  await waitUntil(() => agent.inFlight === 1, "第二轮进到 agent 里");
  await channel.receive(U1, "/新会话");

  channel.sent.length = 0;
  agent.fail = true;
  open();
  await stuck;

  const err = channel.sent.find((m) => m.text.includes("处理出错了"));
  assert.ok(err, `报错要送到用户那儿,实际:${JSON.stringify(channel.sent.map((m) => m.text))}`);
  assert.ok(err.text.startsWith("【后台对话 sess-1 的结果】"), `实际:${err.text}`);
  assert.ok(err.text.includes(`${canonicalOf("switchSession")} sess-1`), "要给出切回去的写法");
});

test("后台回合不推进度,前台的照推", async () => {
  let t = 1_000_000;
  const { channel, agent } = build(() => t);
  agent.progressEvents = [{ kind: "tool", name: "Bash", input: { command: "npm test" } }];
  agent.beforeProgress = () => (t += 60_000);
  const open = stuckTurn(agent);
  const stuck = channel.receive(U1, "长任务");
  await waitUntil(() => agent.inFlight === 1, "回合进到 agent 里");

  await channel.receive(U1, "/新会话"); // 切走 → 转后台
  channel.sent.length = 0;
  open();
  await stuck;
  assert.ok(
    !channel.sent.some((m) => m.text.startsWith("🔧")),
    `后台回合不该推进度,实际:${JSON.stringify(channel.sent.map((m) => m.text))}`,
  );
});

test("/取消 只中断前台,后台那些继续跑", async () => {
  const { channel, agent, turns } = build(() => 1_000_000);
  const open = stuckTurn(agent);
  const bg = channel.receive(U1, "这个切到后台"); // 将成为后台
  await waitUntil(() => agent.inFlight === 1, "第一轮进到 agent 里");
  await channel.receive(U1, "/新会话");

  // 再起一个前台回合(gate 已经换成新的,不会立刻结束)
  const fgOpen = stuckTurn(agent);
  const fg = channel.receive(U1, "这个是前台");
  await waitUntil(() => turns.foregroundFor(U1) !== undefined, "前台回合起来了");

  await channel.receive(U1, "/取消");
  const bgCtx = turns.allFor(U1).find((c) => c.detached);
  assert.equal(bgCtx?.abort.signal.aborted, false, "后台的不该被顺手灭掉");

  fgOpen();
  open();
  await Promise.all([bg, fg]);
});

test("分段正文发到一半失败:停下,而且不把这一轮记成出错", async () => {
  // 两件事各自都出过问题:① 直接 channel.send 抛出去会被 runTurn 的 catch 接住,
  // 用户于是收到半截答案**外加**一句"处理出错了",而那一轮其实跑成功了;
  // ② 接着发后面几段的话,用户看到的是中间缺一块 —— 截断看得出来,空洞看不出来。
  const { channel, agent } = build(() => 1_000_000, { settings: { maxReplyChars: 10 } });
  agent.nextSessionId = "s1";
  // 已成功 2 条(回执 + 正文第 1 段)时坏一条,之后恢复 —— 坏的是正文第 2 段。
  channel.failSendOn = 2;

  await channel.receive(U1, "这是一个很长的问题需要分成好几段来回答才发得完");

  const bodies = channel.sent.filter((m) => m.kind === "body");
  assert.equal(
    bodies.length,
    1,
    `断了就该停下,不能跳过坏掉那段接着发(那是空洞):${JSON.stringify(bodies.map((m) => m.text))}`,
  );
  assert.ok(
    !channel.sent.some((m) => m.text.includes("处理出错")),
    `回合跑成功了,不该顺带报一句错:${JSON.stringify(channel.sent.map((m) => m.text))}`,
  );
});

test("/nop:回合跑到一半也能续额,节流器跟着重新开闸", async () => {
  // 它的全部作用来自"这条消息存在"(新 context_token = 新预算),而不是它做了什么。
  // 网关这边只配合一件事:重新开闸。
  const { channel, agent, turns } = build(() => 1_000_000);
  const open = stuckTurn(agent);
  const running = channel.receive(U1, "长任务");
  await waitUntil(() => turns.foregroundFor(U1) !== undefined, "前台回合起来了");

  const ctx = turns.foregroundFor(U1)!;
  const reopen = ctx.resetProgress;
  assert.ok(reopen, "回合跑起来之后必须挂得出开闸的手柄");
  let reopened = 0;
  ctx.resetProgress = () => {
    reopened += 1;
    reopen();
  };

  channel.sent.length = 0;
  await channel.receive(U1, "/nop");
  assert.equal(reopened, 1, "额度回来了,节流器必须重新开闸");
  assert.equal(
    channel.sent.length,
    0,
    `/nop 一个字都不回 —— 确认话术要从它刚续回来的额度里花掉一条,挤掉的正是` +
      `用户发它想看的那条进度:${JSON.stringify(channel.sent)}`,
  );
  assert.equal(agent.fed.length, 0, "它不是补话,不该被折进在飞回合");

  open();
  await running;
  assert.equal(agent.calls.length, 1, "也不该另起一个回合");
});

test("/nop:闲着的时候发它也一个字不回 —— 那就是「什么也不做」的字面意思", async () => {
  // 没有在飞回合、也没有积压时,`/nop` 的可见效果是零。这是刻意的:它唯一的作用
  // 发生在消息**抵达渠道**那一刻(新 context_token = 新预算),网关这边无事可做,
  // 而"好,什么也没做"这句确认要从刚续回来的 10 条里花掉一条。
  // 想确认还活着,那是 /状态 的活儿。
  const { channel, agent } = build(() => 1_000_000);
  // 头一条消息会把初次见面的问候推出来 —— 那是 prelude 的活儿,不是 /nop 的回话。
  await channel.receive(U1, "/nop");
  channel.sent.length = 0;

  await channel.receive(U1, "/nop");
  assert.equal(channel.sent.length, 0, `不该有任何回话:${JSON.stringify(channel.sent)}`);
  assert.equal(agent.calls.length, 0, "更不该惊动 agent —— 它不花额度");
});

test("/状态 交代后台还有几段在跑 —— 别处看不见它们", async () => {
  const { channel, agent } = build(() => 1_000_000);
  const open = stuckTurn(agent);
  const stuck = channel.receive(U1, "长任务");
  await waitUntil(() => agent.inFlight === 1, "回合进到 agent 里");
  await channel.receive(U1, "/新会话");

  channel.sent.length = 0;
  await channel.receive(U1, "/状态");
  const status = channel.sent.find((m) => m.text.startsWith("📋"));
  assert.ok(status?.text.includes("后台:1 段对话还在跑"), `实际:${status?.text}`);

  open();
  await stuck;
});

test("同一会话绝不并发:追加额度用尽的那段排在这一轮后面,不另起一轮", async () => {
  // 追不进去就另起一轮的话,两个回合会 resume 同一个 sessionId,上下文会被撕坏。
  const { channel, agent } = build(() => 1_000_000);
  const open = stuckTurn(agent);
  const first = channel.receive(U1, "开工");
  await waitUntil(() => agent.inFlight === 1, "第一轮进到 agent 里");

  for (let i = 0; i < MAX_FEEDS_PER_TURN; i++) await channel.receive(U1, `补充${i}`);
  const overflow = channel.receive(U1, "额度之外的那条");
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.calls.length, 1, "它必须等这一轮结束,不能并发同一会话");

  open();
  await Promise.all([first, overflow]);
  assert.equal(agent.calls.length, 2);
  assert.equal(agent.calls[1]!.prompt, "额度之外的那条");
  assert.equal(agent.peakInFlight, 1, "全程没有两个回合同时在跑");
});

// ── 部署指令与升级播报 ──────────────────────────────────────────────
//
// 这一组守的核心是**权限的机械性**:部署类指令的影响是全局的(一次回滚把所有
// 用户都换到另一个版本),而 catman 是多用户的 —— 朋友扫码就能接入。没有这道闸,
// 任何人打一句带斜杠的话就能触发,那正是「防失误」要拦的东西。

const REPORT: DeployReport = {
  schema: 1,
  id: "d-1",
  outcome: "rolled-back",
  sha: "newsha1234",
  revertedTo: "oldsha5678",
  finishedAt: "2026-08-08T10:00:00Z",
  detail: "健康门超时",
  requestedBy: U1,
};

test("非管理员的 /回滚 不生效,而且当它不是指令 —— 连「你没权限」都不说", async () => {
  const t = 1_000_000;
  const deploy = new FakeDeploy();
  deploy.history = [{ sha: "a", verifiedAt: "t2" }, { sha: "b", verifiedAt: "t1" }];
  const { channel, agent } = build(() => t, { deploy });

  await channel.receive(U1, "/回滚");
  assert.deepEqual(deploy.rollbackRequests, [], "普通用户不该能触发回滚");
  // 当它不是指令 → 照常走 LLM(未知斜杠文本本来就是这个待遇)。这样既用不了、
  // 也看不出这条指令存在 —— 回一句"你没权限"本身就是在告诉他有这么个东西。
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0]!.prompt, "/回滚");
});

test("非管理员的 /升级状态 同样当作普通文本", async () => {
  const t = 1_000_000;
  const deploy = new FakeDeploy();
  const { channel, agent } = build(() => t, { deploy });
  await channel.receive(U1, "/升级状态");
  assert.equal(agent.calls.length, 1, "走了 LLM,没走硬指令分支");
});

test("管理员的 /回滚 请求回滚,并把发起人传下去", async () => {
  const t = 1_000_000;
  const deploy = new FakeDeploy();
  deploy.history = [{ sha: "a", verifiedAt: "t2" }, { sha: "b", verifiedAt: "t1" }];
  const { channel, agent } = build(() => t, { deploy, settings: { adminUserKeys: [U1] } });

  await channel.receive(U1, "/回滚");
  assert.deepEqual(deploy.rollbackRequests, [U1]);
  assert.equal(agent.calls.length, 0, "硬指令不进 LLM");
});

test("起不动 deployer 时必须明说版本没变 —— 用户以为回滚在跑,实际什么都没发生", async () => {
  const t = 1_000_000;
  const deploy = new FakeDeploy();
  deploy.rollbackError = new Error("no such file");
  const { channel } = build(() => t, { deploy, settings: { adminUserKeys: [U1] } });

  await channel.receive(U1, "/回滚");
  const last = afterGreeting(channel.sent).at(-1)!;
  assert.match(last.text, /no such file/);
  assert.match(last.text, /没有任何变化/);
});

test("信使执行的指令到了人格这儿一律当它不是指令 —— 那说明信使版本比人格老", () => {
  // /救援 /主人格 /绑定 正常情况下压根到不了人格:信使在消息进人格之前就消化掉了。
  // 真到了,说明跑着的那份 pinned 信使还不认识这条指令(它是人工 bless 的,可以比
  // 人格老几十个版本)。那时安静地退化成普通消息,比回一句"这条我不管"有用。
  return (async () => {
    const { channel, agent } = build(() => 1_000_000, { settings: { adminUserKeys: [U1] } });
    await channel.receive(U1, "/救援");
    assert.equal(agent.calls.length, 1, "该照常走 LLM");
    assert.equal(agent.calls[0]!.prompt, "/救援");
  })();
});

test("非管理员的 /发布 同样当它不是指令 —— 一次部署把所有人都换了版本", async () => {
  const deploy = new FakeDeploy();
  const { channel, agent } = build(() => 1_000_000, { deploy });

  await channel.receive(U1, "/发布 a1b2c3d");
  assert.deepEqual(deploy.deployRequests, []);
  assert.equal(agent.calls.length, 1, "照常走 LLM,不透露这条指令存在");
});

test("管理员的 /发布 把那几位原样交给部署层 —— 网关不做任何解释", async () => {
  // 确认口令的全部意义是"人打进来的与机器部署的是同一个东西"。网关在这里多做
  // 一步(补全、纠错、挑一个最近的)都会把那把锁拆掉,所以它只负责原样透传。
  const deploy = new FakeDeploy();
  const { channel, agent } = build(() => 1_000_000, {
    deploy,
    settings: { adminUserKeys: [U1] },
  });

  await channel.receive(U1, "/发布 a1b2c3d");
  assert.deepEqual(deploy.deployRequests, [{ prefix: "a1b2c3d", requestedBy: U1 }]);
  assert.equal(agent.calls.length, 0, "硬指令不进 LLM");
});

test("起不动 deployer 时 /发布 也要明说版本没变", async () => {
  const deploy = new FakeDeploy();
  deploy.deployError = new Error("no such file");
  const { channel } = build(() => 1_000_000, { deploy, settings: { adminUserKeys: [U1] } });

  await channel.receive(U1, "/发布 a1b2c3d");
  const last = afterGreeting(channel.sent).at(-1)!;
  assert.match(last.text, /no such file/);
  assert.match(last.text, /没有任何变化/);
});

test("没配部署机制时 /发布 明说没配", async () => {
  const { channel } = build(() => 1_000_000, { settings: { adminUserKeys: [U1] } });
  await channel.receive(U1, "/发布 a1b2c3d");
  assert.match(afterGreeting(channel.sent).at(-1)!.text, /没有配自进化/);
});

test("没配部署机制时 /回滚 明说没配,而不是假装成功", async () => {
  const t = 1_000_000;
  const { channel } = build(() => t, { settings: { adminUserKeys: [U1] } });
  await channel.receive(U1, "/回滚");
  assert.match(afterGreeting(channel.sent).at(-1)!.text, /没有配自进化/);
});

test("/升级状态 列出可回退版本与上次部署结果", async () => {
  const t = 1_000_000;
  const deploy = new FakeDeploy();
  deploy.report = REPORT;
  deploy.history = [
    { sha: "current999", verifiedAt: "t2" },
    { sha: "previous11", verifiedAt: "t1" },
  ];
  const { channel } = build(() => t, { deploy, settings: { adminUserKeys: [U1] } });

  await channel.receive(U1, "/升级状态");
  const text = afterGreeting(channel.sent).at(-1)!.text;
  assert.match(text, /previou/, "要列出可回退的版本(短 sha,7 位)");
  assert.match(text, /健康门超时/, "要带上次失败的原因");
});

test("/升级状态 列出待发布的候选 —— 那是 /发布 后面那几位的唯一查法", async () => {
  // 制备时的汇报早被后面的聊天顶上去了,而这条指令不进 LLM、不花额度、
  // 回合卡死时也答得出。少了它,人就只能翻聊天记录找那串十六进制。
  const deploy = new FakeDeploy();
  deploy.candidates = [
    { sha: "f".repeat(40), preparedAt: "t2", branch: "evolve/x", running: false },
    { sha: "e".repeat(40), preparedAt: "t1", running: true },
  ];
  const { channel } = build(() => 1_000_000, { deploy, settings: { adminUserKeys: [U1] } });

  await channel.receive(U1, "/升级状态");
  const text = afterGreeting(channel.sent).at(-1)!.text;
  assert.match(text, /待发布/);
  assert.match(text, /fffffff/, "候选要给短 sha");
  assert.match(text, /evolve\/x/, "带上分支名,人一眼认得出是哪次改动");
  assert.equal(text.includes("eeeeeee"), false, "正在跑的那个不是候选");
});

/** 一条里程碑。用例只改要点的那几个字段。 */
function progressOf(over: Partial<DeployProgress> = {}): DeployProgress {
  return {
    schema: 1,
    id: "run1-switched",
    stage: "switched",
    sha: "a".repeat(40),
    at: new Date(1_000_000).toISOString(),
    detail: "接下来是观察期。",
    ok: true,
    requestedBy: U1,
    ...over,
  };
}

// 这一组守的是同一件事:**用户不必先开口才知道结果**。
// 真机上的症状是"发布之后无论等多久都等不到结果",而他等的恰恰就是这个 ——
// 让他先说话才肯告诉他,等于让他自己去问一件他已经在等的事。
test("部署结果不等用户开口就主动推给发起人,且只推一次", async () => {
  const t = 1_000_000;
  const deploy = new FakeDeploy();
  deploy.report = REPORT; // requestedBy = U1
  const { channel, gw } = build(() => t, { deploy, settings: { adminUserKeys: [U1] } });

  await gw.flushDeployNews(); // 定时器就是这么调的
  const first = channel.sent.filter((m) => m.text.includes("已自动回滚"));
  assert.equal(first.length, 1, "没人开口也该播出去");
  assert.equal(first[0]!.userKey, U1, "发给发起人");
  assert.deepEqual(deploy.announced, ["d-1"]);

  await gw.flushDeployNews();
  await channel.receive(U1, "改好了吗");
  assert.equal(
    channel.sent.filter((m) => m.text.includes("已自动回滚")).length,
    1,
    "播报过就不再重复,定时器与用户开口两条路径都不会让它重来",
  );
});

test("三个里程碑按发生顺序主动播给发起人", async () => {
  const t = 1_000_000;
  const deploy = new FakeDeploy();
  deploy.progress = [
    progressOf({ id: "run1-switched", stage: "switched" }),
    progressOf({ id: "run1-stable", stage: "stable" }),
    progressOf({ id: "run1-pushed", stage: "pushed" }),
  ];
  const { channel, gw } = build(() => t, { deploy, settings: { adminUserKeys: [U1] } });

  await gw.flushDeployNews();
  const texts = channel.sent.filter((m) => m.userKey === U1).map((m) => m.text);
  assert.equal(texts.length, 3);
  assert.match(texts[0]!, /已切到/);
  assert.match(texts[1]!, /观察期通过/);
  assert.match(texts[2]!, /已推送到远端/);
  assert.deepEqual(deploy.progressAnnounced, ["run1-switched", "run1-stable", "run1-pushed"]);

  await gw.flushDeployNews();
  assert.equal(channel.sent.length, 3, "播过的不再重播");
});

test("推远端失败的里程碑照样播 —— 「本地上线了但远端没有」下次开工会踩到", async () => {
  const deploy = new FakeDeploy();
  deploy.progress = [progressOf({ id: "run1-pushed", stage: "pushed", ok: false })];
  const { channel, gw } = build(() => 1_000_000, { deploy, settings: { adminUserKeys: [U1] } });

  await gw.flushDeployNews();
  assert.match(channel.sent.at(-1)!.text, /没能推上远端/);
});

test("部署结果只发给发起人 —— 别人收到一句「升级完成」只会莫名其妙", async () => {
  const t = 1_000_000;
  const deploy = new FakeDeploy();
  deploy.report = REPORT; // requestedBy = U1
  const { channel } = build(() => t, { deploy, settings: { adminUserKeys: [U1, U2] } });

  await channel.receive(U2, "你好");
  assert.equal(
    channel.sent.filter((m) => m.userKey === U2 && m.text.includes("已自动回滚")).length,
    0,
    "U2 不是发起人,不该收到",
  );
  assert.equal(
    channel.sent.filter((m) => m.userKey === U1 && m.text.includes("已自动回滚")).length,
    1,
    "收件人由报告决定,与此刻谁在说话无关",
  );
});

test("没有发起人的报告(比如看门狗自动回退)发给管理员,不发给普通用户", async () => {
  const t = 1_000_000;
  const deploy = new FakeDeploy();
  const { requestedBy: _drop, ...noOwner } = REPORT;
  deploy.report = noOwner as DeployReport;
  const { channel, gw } = build(() => t, { deploy, settings: { adminUserKeys: [U2] } });

  await gw.flushDeployNews();
  const sent = channel.sent.filter((m) => m.text.includes("已自动回滚"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.userKey, U2, "没有发起人时归管理员 —— 那种情况更要有人知道");
});

test("一个管理员都没有时只记日志,并标记已播免得每轮重算", async () => {
  const deploy = new FakeDeploy();
  deploy.progress = [progressOf({ requestedBy: undefined })];
  const { channel, gw } = build(() => 1_000_000, { deploy, settings: { adminUserKeys: [] } });

  await gw.flushDeployNews();
  assert.equal(channel.sent.length, 0);
  assert.deepEqual(deploy.progressAnnounced, ["run1-switched"]);
});

test("播报发送失败时不标记已读 —— 否则这条结果就被永久吞掉了", async () => {
  const t = 1_000_000;
  const deploy = new FakeDeploy();
  deploy.report = REPORT;
  const { channel, gw } = build(() => t, {
    deploy,
    failSend: true, // 模拟 iLink 发送失败(context_token 预算耗尽是常态)
    settings: { adminUserKeys: [U1] },
  });

  await gw.flushDeployNews();
  assert.deepEqual(deploy.announced, [], "发送失败就不该记成已播报");
  // 下次发得出去时还得能播 —— 「升级失败已回滚」是最不能丢的一条。
  channel.failSend = false;
  await channel.receive(U1, "再来一次");
  assert.equal(channel.sent.filter((m) => m.text.includes("已自动回滚")).length, 1);
});

test("主动重试有上限 —— 失败的发送烧的是同一份预算,烧光了连正文都发不出去", async () => {
  let t = 1_000_000;
  const deploy = new FakeDeploy();
  deploy.report = REPORT;
  const { channel, gw } = build(() => t, {
    deploy,
    failSend: true,
    settings: { adminUserKeys: [U1] },
  });

  // 三次之后收手(每次之间要过够退避间隔,否则连这三次都攒不满)。
  for (let i = 0; i < 6; i += 1) {
    await gw.flushDeployNews();
    t += 61_000;
  }
  assert.equal(channel.attempted, 3, "试满三次就不再主动试");

  // 但用户开口时照样试 —— 他手上是一份崭新的回复上下文,发送几乎不会失败。
  channel.failSend = false;
  await channel.receive(U1, "怎么样了");
  assert.equal(channel.sent.filter((m) => m.text.includes("已自动回滚")).length, 1);
});

test("普通用户的帮助文案里没有部署指令,管理员的有", async () => {
  const t = 1_000_000;
  const { channel } = build(() => t, { settings: { adminUserKeys: [U2] } });

  await channel.receive(U1, "/帮助");
  const plain = channel.sent.map((m) => m.text).join("\n");
  assert.equal(plain.includes(canonicalOf("rollback")), false);

  await channel.receive(U2, "/帮助");
  const withAdmin = channel.sent.map((m) => m.text).join("\n");
  assert.equal(withAdmin.includes(canonicalOf("rollback")), true);
});

/**
 * 2026-08-21 真机 bug:内存看门狗中止了某人会话的**第一个**回合,他说"再试试",
 * 大脑答「I don't have the prior context — the earlier part got cut off」。
 *
 * 而我们刚刚才在中止通知里跟他说过「会话没丢,接着说就行」。
 *
 * 盘上的记录一直是好的(实测那份 15 条对话条目,每个 tool_use 都有配对的
 * tool_result,尾巴停在合法的 resume 点上)—— 缺的只是**谁记得它的 id**:
 * `record()` 排在 `Agent.run()` 返回之后,而回合是抛错告终的,永远走不到。
 * 于是那段对话在盘上完好无损却再也没人指得到。
 */
test("回合被中止:会话仍要记下来,下一句话能接上", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  agent.nextSessionId = "sess-被中止的那段";
  agent.gate = new Promise<void>(() => {}); // 永不放行,只能靠 abort 打断

  const stuck = channel.receive(U1, "帮我调研一件很费内存的事");
  await new Promise((r) => setImmediate(r));
  await channel.receive(U1, "/取消");
  await stuck;

  // 关键断言:下一句话必须 resume 到那一段,而不是开一个全新会话。
  agent.gate = undefined;
  await channel.receive(U1, "再试试");
  const last = agent.calls.at(-1);
  assert.equal(
    last?.resume,
    "sess-被中止的那段",
    "回合死了但会话没死 —— 不接上的话,那句「会话没丢」就是假话",
  );
});

test("回合被中止:被切走的回合写 history,不能顶掉用户刚切过去的那段", async () => {
  // 与成功路径同一条纪律。分岔写错的话,用户切到别的会话正说着话,
  // 后台那个死掉的回合会把 current 覆盖成自己 —— 比不记还糟。
  const t = 1_000_000;
  const { channel, agent } = build(() => t);
  agent.nextSessionId = "sess-后台";
  const open = stuckTurn(agent);

  const stuck = channel.receive(U1, "跑个长任务");
  await new Promise((r) => setImmediate(r));
  await channel.receive(U1, "/新会话"); // 把它切走 → detached
  open(); // 放它跑完(detached 的回合不会被 /新会话 杀掉,只是转后台)
  await stuck;

  await channel.receive(U1, "新会话里说话");
  const last = agent.calls.at(-1);
  assert.notEqual(last?.resume, "sess-后台", "后台那段不该顶掉当前会话");
});
