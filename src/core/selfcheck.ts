import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { Agent } from "./agent.js";
import { GlobalSettings } from "./settings.js";
import { PrefsStore } from "./prefs.js";
import { SessionManager } from "./session.js";
import { FileStore } from "./file-store.js";
import { UserRegistry } from "./users.js";
import { TurnTokens } from "./turn-tokens.js";
import { writeSkills } from "./skills.js";
import { readVersion, type VersionInfo } from "./version.js";

/**
 * 启动自检(smoke)。`CATMAN_SELFCHECK=1` 时 index.ts 走这条路,不起渠道、不起
 * dashboard,跑完就退出,退出码即结论。
 *
 * ## 它回答的问题
 *
 * "这份 release 能不能跑" —— 依赖装齐了吗(尤其 claude 二进制的 arch/libc 对不对)、
 * 各层装配会不会当场抛错、**大脑通不通**(一次真实的最小 SDK 请求)。部署流水线在
 * 切换**之前**跑它:不通就中止,正在服务的旧版本一根汗毛都没动。
 *
 * ## 两条硬纪律
 *
 * **① 绝不碰真实数据目录。** 自检自己开一个临时目录当 `CATMAN_DATA_DIR` 与
 * `CLAUDE_CONFIG_DIR`,不管调用方传了什么。写成代码而不是写进脚本注释 ——
 * 一个会往生产数据里写东西的自检,比没有自检更糟。
 *
 * **② 失败要分类,不能一律判死。** 限流与网络故障是**环境**的错,不是这份代码的错;
 * 把它们判成"新版本坏了"会让一次二十分钟的上游抖动废掉一个完好的版本(rev 1 评审的
 * 具体失败序列)。所以结论带 `category`,由 deployer 决定重试还是中止 —— 见
 * SelfCheckCategory 各项的说明。
 */

/**
 * 自检结论的分类。deployer 按它决定下一步:
 * - `ok`:通过。
 * - `ratelimit` / `network`:**环境**问题,退避后重试;重试超时就中止部署
 *   (中止 ≠ 回滚,此时还没切换,旧版本照常服务)。
 * - `auth`:凭据/额度问题(token 过期、余额不足)。同样不是代码的错,但重试无用 ——
 *   直接中止并在报告里点名,让人去换发 token。
 * - `code`:这份代码的问题(起不来、装配抛错、SDK 用法错)。中止部署。
 */
export type SelfCheckCategory = "ok" | "ratelimit" | "network" | "auth" | "code";

export interface SelfCheckResult {
  readonly ok: boolean;
  readonly category: SelfCheckCategory;
  /** 给人看的一句话 + 原始错误摘要。原文照留:它是去查订阅/配置的唯一线索。 */
  readonly detail: string;
  /** 这份 release 的版本戳;开发模式下没有。 */
  readonly version?: VersionInfo;
  readonly elapsedMs: number;
}

/**
 * 把一段错误文本归类。**纯函数**,单测钉着它 —— 分类错了的代价是不对称的:
 * 把环境问题误判成 `code` 会白白废掉一个好版本,把代码问题误判成 `network`
 * 会让 deployer 空转重试三十分钟。
 *
 * 判定顺序有意义:限流信息里常同时出现 "rate limit" 与 429/529,先匹配限流;
 * 额度/鉴权类("credit balance too low"、401)与限流长得像,单独一档。
 */
export function classifyFailure(text: string): Exclude<SelfCheckCategory, "ok"> {
  const t = text.toLowerCase();
  if (/rate.?limit|429|529|overloaded|too many requests|quota exceeded/.test(t)) return "ratelimit";
  if (/credit balance|insufficient|401|403|unauthorized|authentication|invalid.{0,12}token|expired.{0,12}token|oauth/.test(t)) {
    return "auth";
  }
  if (
    /enotfound|econnrefused|econnreset|etimedout|eai_again|epipe|socket hang up|fetch failed|network|proxy|tunneling socket|timed? ?out/.test(
      t,
    )
  ) {
    return "network";
  }
  return "code";
}

/** 自检给模型的那句话。要短、要便宜、要不需要任何工具。 */
const PROBE_PROMPT = "只回复两个字:ok。不要使用任何工具,不要做别的事。";

/** 自检默认的总超时。跑在部署流水线里、没人盯着,必须有上限。 */
const DEFAULT_TIMEOUT_MS = 180_000;

/** 自检默认用的模型 —— 便宜的那档就够回答"大脑通不通"。 */
const DEFAULT_PROBE_MODEL = "haiku";

export interface SelfCheckOptions {
  /**
   * 真正跑一次 agent 的那步。单测注入假实现 —— 自检的价值在于它跑真链路,
   * 但它的**分类与收尾逻辑**必须能脱离网络与 Claude 单独验证。
   */
  runProbe?: (agent: Agent, cwd: string, model: string, signal: AbortController) => Promise<{ text: string; isError: boolean }>;
  timeoutMs?: number;
}

/**
 * 跑一次自检。返回结论,不负责退出进程(调用方决定,便于单测)。
 */
export async function runSelfCheck(opts: SelfCheckOptions = {}): Promise<SelfCheckResult> {
  const startedAt = Date.now();
  const version = readVersion();
  const envTimeout = Number(process.env["CATMAN_SELFCHECK_TIMEOUT_MS"] ?? "");
  const timeoutMs =
    opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);

  // 纪律 ①:自己开临时目录,覆盖掉调用方给的任何数据目录。
  const sandbox = mkdtempSync(join(tmpdir(), "catman-selfcheck-"));
  process.env["CATMAN_DATA_DIR"] = sandbox;
  process.env["CLAUDE_CONFIG_DIR"] = join(sandbox, "claude");

  try {
    // ── 第一段:装配。这里抛错就说明这份代码根本起不来,是最该被 smoke 挡住的那类。
    const config = loadConfig();
    const configDir = process.env["CLAUDE_CONFIG_DIR"]!;
    const settings = new GlobalSettings({ path: config.settingsPath, env: config });
    const prefs = new PrefsStore({ path: config.prefsPath, defaults: () => settings.effective() });
    const agent = new Agent(config);
    const sessions = new SessionManager({
      store: new FileStore(config.statePath),
      timeoutMs: config.sessionTimeoutMs,
      timeoutMsFor: (userKey) => prefs.effective(userKey).sessionTimeoutMs,
    });
    const users = new UserRegistry({ path: config.usersPath, workspaceRoot: config.workspaceDir });
    const turns = new TurnTokens();
    turns.counts();
    writeSkills(
      configDir,
      { modelAllowlist: settings.effective().modelAllowlist },
      {
        srcDir: config.srcDir,
        deployBinDir: `${config.deployDir}/bin`,
        releasesDir: config.releasesDir,
      },
    );
    // 工作目录派生 + 长度闸门也走一遍:它会在真实部署里拦下路径过长的会话目录,
    // 自检里跑通它才谈得上"这份代码能服务一个用户"。
    const probeKey = "selfcheck:probe:local";
    const cwd = users.ensureWorkspace(probeKey);
    sessions.decide(probeKey);

    // ── 第二段:大脑。一次真实请求,带硬超时与轮数上限,跑飞不了。
    const abort = new AbortController();
    // **不 unref**:这个定时器欠着一个动作 —— 中止探测并给出 network 分类的结论。
    // unref 掉的话,一旦事件循环没有别的句柄,进程会在它触发前直接退出、什么都不打印,
    // 而 deployer 把「没有可解析的结论」判成代码问题 —— 一次上游卡顿就此废掉一个好版本。
    // finally 里会 clearTimeout,所以它最多把进程多留 timeoutMs,而那正是该活着的时候。
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const model = process.env["CATMAN_SELFCHECK_MODEL"] || DEFAULT_PROBE_MODEL;
    try {
      const probe = opts.runProbe ?? defaultProbe;
      const reply = await probe(agent, cwd, model, abort);
      if (reply.isError) {
        return fail(classifyFailure(reply.text), `大脑自检返回错误:${reply.text}`, version, startedAt);
      }
      return {
        ok: true,
        category: "ok",
        detail: `装配通过,大脑应答正常(${reply.text.trim().slice(0, 40) || "空回复"})`,
        ...(version ? { version } : {}),
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const text = abort.signal.aborted ? `自检超时(${timeoutMs}ms):${String(err)}` : String(err);
      // 超时归到 network:等不到应答与连不上,对 deployer 是同一个处置(退避重试)。
      const category = abort.signal.aborted ? "network" : classifyFailure(text);
      return fail(category, `大脑自检失败:${text}`, version, startedAt);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // 装配段抛错 = 这份代码起不来。这正是 smoke 存在的头号理由,不必再分类。
    return fail("code", `装配失败:${String(err)}`, version, startedAt);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function fail(
  category: Exclude<SelfCheckCategory, "ok">,
  detail: string,
  version: VersionInfo | undefined,
  startedAt: number,
): SelfCheckResult {
  return {
    ok: false,
    category,
    detail,
    ...(version ? { version } : {}),
    elapsedMs: Date.now() - startedAt,
  };
}

async function defaultProbe(
  agent: Agent,
  cwd: string,
  model: string,
  abort: AbortController,
): Promise<{ text: string; isError: boolean }> {
  const reply = await agent.run(PROBE_PROMPT, {
    cwd,
    model,
    maxTurns: 1,
    abortController: abort,
    logLabel: "selfcheck",
  });
  return { text: reply.text, isError: reply.isError };
}
