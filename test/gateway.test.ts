import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Gateway,
  REMINDER_TEXT,
  ACK_TEXT,
  formatProgress,
  ProgressThrottle,
  MAX_PROGRESS_PER_TURN,
} from "../src/core/gateway.js";
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
import type { Attachment } from "../src/core/attachments.js";
import type { Agent, AgentProgressEvent, AgentReply, AgentRunOptions } from "../src/core/agent.js";

const TIMEOUT = 60 * 60 * 1000;

/** 测试里的 userKey:三段式,和真实渠道产出的形态一致。 */
const U1 = "stdin:local:u1";
const U2 = "stdin:local:u2";

/** 可编排的假渠道:手动注入进来的消息,记录发出/撤回的消息。 */
class FakeChannel implements Channel {
  readonly name = "fake";
  handler?: MessageHandler;
  sent: Array<{ userKey: string; text: string }> = [];
  recalled: string[] = [];
  /** 设为 true 时 send 抛错,模拟渠道不支持主动推送。 */
  failSend = false;
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
  async send(userKey: string, text: string): Promise<string | void> {
    if (this.failSend) throw new Error("push not supported");
    this.sent.push({ userKey, text });
    // 支持撤回的渠道返回消息 id
    if (this.recall) return `msg-${this.sent.length}`;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  /** 注入一条用户消息并等待处理完成。 */
  async receive(userKey: string, text: string, attachments?: readonly Attachment[]): Promise<void> {
    await this.handler!({ userKey, text, ...(attachments ? { attachments } : {}) });
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
    try {
      // abort 会打断正在跑的回合,而不是等它跑完 —— 如实模拟 SDK 的行为。
      if (this.gate) await Promise.race([this.gate, rejectOnAbort(opts.abortController)]);
      for (const ev of this.progressEvents) {
        this.beforeProgress?.();
        opts.onProgress?.(ev);
      }
      if (this.fail) throw new Error("agent boom");
      const sessionId = opts.resumeSessionId ?? this.nextSessionId ?? `sess-${++this.n}`;
      return { text: `echo:${prompt}`, sessionId, isError: false };
    } finally {
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
  });
  // 只注册 handler,不启动真实定时器/渠道。走 dispatch 才能覆盖硬指令分流。
  // 附件要一并转交 —— 与 Gateway.start() 里的接线保持一致,否则这里测不到透传。
  channel.onMessage((m) => gw["dispatch"](m.userKey, m.text, m.attachments ?? []));
  return { channel, agent, sessions, users, prefs, settings, turns, gw, root };
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
    { userKey: U1, text: ACK_TEXT },
    { userKey: U1, text: "echo:你好" },
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

test("回执:ackEnabled=false 时不发回执", async () => {
  const t = 1_000_000;
  const { channel } = build(() => t, { settings: { ackEnabled: false } });
  await channel.receive(U1, "你好");
  assert.deepEqual(afterGreeting(channel.sent), [{ userKey: U1, text: "echo:你好" }]);
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

test("进度:progressEnabled=false 时不传 onProgress 给 Agent", async () => {
  const t = 1_000_000;
  const { channel, agent } = build(() => t, { settings: { progressEnabled: false } });
  agent.progressEvents = [{ kind: "thinking", text: "不该出现" }];
  await channel.receive(U1, "你好");
  assert.equal(agent.calls[0]!.hasProgress, false);
  assert.deepEqual(
    afterGreeting(channel.sent).map((m) => m.text),
    [ACK_TEXT, "echo:你好"],
  );
});

test("formatProgress:超长内容截断,工具入参挑代表性字段", () => {
  const long = "x".repeat(500);
  assert.equal(formatProgress({ kind: "thinking", text: long }), `💭 ${"x".repeat(200)}…`);
  assert.equal(
    formatProgress({ kind: "tool", name: "Read", input: { file_path: "/etc/hosts" } }),
    "🔧 Read: /etc/hosts",
  );
  assert.equal(formatProgress({ kind: "tool", name: "Foo", input: { n: 1 } }), '🔧 Foo: {"n":1}');
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

test("进度节流:同一间隔内只发最新那条,丢掉的条数如实交代", () => {
  // 进度是"现在在干什么"这个状态,不是必须完整送达的流水 —— 但丢了多少得说,
  // 否则"卡在一件事上"和"飞快跑了 20 步"在用户眼里一模一样。
  const t0 = 1_000_000;
  const th = new ProgressThrottle(t0);

  assert.ok(th.offer(t0 + 5_000, toolEv(1)));
  for (let i = 2; i <= 5; i += 1) {
    assert.equal(th.offer(t0 + 5_000 + i, toolEv(i)), undefined);
  }
  const text = th.offer(t0 + 20_000, toolEv(6));
  assert.ok(text, "到点应当放行");
  assert.ok(text.includes("T6"), `发的应是最新那条,实际:${text}`);
  assert.ok(!text.includes("T2"), `不该补发旧事件:${text}`);
  assert.ok(text.includes("+4 步"), `应交代丢了 4 条:${text}`);

  // 计数在放行后归零,不会把上一轮的账算到下一轮头上。
  const next = th.offer(t0 + 50_000, toolEv(7));
  assert.ok(next && !next.includes("步"), `不该重复计数:${next}`);
});

test("进度节流:总条数封顶,给正文与超时提醒留出额度", () => {
  // 阶梯只拉长间隔,不限制总数 —— 一个十分钟的回合照样能发十几条,
  // 撞满预算后被挤掉的正好是正文和超时提醒(两者共用同一个 context_token)。
  const t0 = 1_000_000;
  const th = new ProgressThrottle(t0);
  const texts: string[] = [];
  // 跨度 30 分钟,远超阶梯能自然产生的条数。
  for (let ms = 0; ms <= 1_800_000; ms += 1_000) {
    const out = th.offer(t0 + ms, toolEv(ms));
    if (out) texts.push(out);
  }
  assert.equal(texts.length, MAX_PROGRESS_PER_TURN, "封顶后不该再放行");
  // 最后一条要交代"后面没了" —— 否则长回合里那段几分钟的静默与卡死无从分辨。
  assert.ok(texts.at(-1)!.includes("进度就报到这儿"), `缺少收尾交代:${texts.at(-1)}`);
  assert.ok(!texts.at(-2)!.includes("进度就报到这儿"), "只有最后一条该带交代");
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
  assert.ok(channel.sent.some((m) => m.userKey === U1 && m.text === REMINDER_TEXT));
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
  assert.notEqual(snap[U1]!.sessionId, snap[U2]!.sessionId);
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
  assert.deepEqual(channel.sent, [{ userKey: U1, text: "没有对你开放。" }]);
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
  for (const cmd of ["/帮助", "/状态", "/新会话", "/取消", "/继续"]) {
    assert.ok(g.includes(cmd), `指引里缺了 ${cmd}`);
  }
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
  assert.ok(channel.sent.some((m) => m.text === "已中断这一轮。"));
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

  // 回合的 record() 发生在 try 里,finally 里的 forget 必定在其后 —— 净效果是清空。
  assert.deepEqual(sessions.snapshot(), {});
});

test("/新会话:没有在飞回合时直接清掉状态", async () => {
  const t = 1_000_000;
  const { channel, sessions } = build(() => t);
  await channel.receive(U1, "先聊一句");
  assert.equal(Object.keys(sessions.snapshot()).length, 1);
  await channel.receive(U1, "/新会话");
  assert.deepEqual(sessions.snapshot(), {});
});

test("/继续 走队列,喂给 LLM 的是「继续」而不是「/继续」", async () => {
  let t = 1_000_000;
  const { channel, agent } = build(() => t);
  await channel.receive(U1, "第一条");
  t += TIMEOUT + 1; // 超时,普通消息会开新会话

  await channel.receive(U1, "/继续");
  const last = agent.calls[agent.calls.length - 1]!;
  assert.equal(last.prompt, "继续", "字面量斜杠可能被模型当成它自己的指令");
  assert.equal(last.resume, "sess-1", "超时后的 /继续 应当续上旧会话");
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

test("/api/me/session/reset 打的标记在回合结束时生效", async () => {
  const t = 1_000_000;
  const { channel, sessions, turns } = build(() => t);
  await channel.receive(U1, "第一条");
  assert.equal(Object.keys(sessions.snapshot()).length, 1);

  // 模拟 agent 在回合中调了 reset 接口:拿到自己的回合上下文并置位。
  let seen = false;
  const orig = turns.mint.bind(turns);
  turns.mint = (userKey: string) => {
    const m = orig(userKey);
    if (!seen) {
      seen = true;
      m.ctx.resetSession = true;
    }
    return m;
  };
  await channel.receive(U1, "第二条");
  assert.deepEqual(sessions.snapshot(), {}, "标记应当在回合的 finally 里生效");
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

test("带图的消息仍然进每用户串行队列", async () => {
  const { channel, agent } = build(() => 1_000_000);
  let release!: () => void;
  agent.gate = new Promise<void>((r) => (release = r));

  const first = channel.receive(U1, "第一条", [fakeImage()]);
  const second = channel.receive(U1, "第二条");
  await new Promise((r) => setImmediate(r));
  assert.equal(agent.calls.length, 1, "第二条必须等第一条跑完");
  release();
  await Promise.all([first, second]);
  assert.equal(agent.calls.length, 2);
  assert.equal(agent.peakInFlight, 1);
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
