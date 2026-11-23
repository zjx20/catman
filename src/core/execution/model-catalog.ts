import { accessSync, constants, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { EnvHttpProxyAgent, request } from "undici";
import { DEFAULT_MODELS_BY_HARNESS, type Config, type HarnessId } from "../../config.js";
import { InputChannel } from "../agent.js";
import { readJsonFile, writeJsonFileAtomic } from "../file-store.js";
import { codeBlock, inlineCode } from "../markdown.js";
import { classifyFailure } from "../selfcheck.js";
import { readTokenExpiry } from "../token-alert.js";
import { findAppRoot } from "../version.js";
import { discoverAcpModels, spawnAcpSubprocess } from "./acp-session.js";
import { extractSdkSupportedModels, sdkNativePackage } from "./harness.js";

/**
 * 多 Harness 动态模型目录与引擎就绪度中心（零 Token 发现 + 持久化缓存 + 故障切换引导）。
 *
 * 设计约束：
 * 1. **零 Token 发现**：
 *    - `claude` 走 SDK `Query.supportedModels()` 握手（不发送任何用户消息，不扣费）并合并自定义网关 `GET /v1/models`；
 *    - `agy` 与 `acp` 走 ACP `initialize` -> `session/new` 读取 `configOptions`（不调用 `session/prompt`，不扣费），
 *      若服务端未返回 `configOptions` 再回退读取上游 `/v1beta/models` 或 `/v1/models`。
 * 2. **双层引导**：
 *    - 事前（`/引擎`、`/模型`）：拦截不可用的引擎或拼错的模型，解释具体原因并给出可复制切换代码块；
 *    - 事中（回合报鉴权失败、限流、模型不存在或二进制缺失）：绝不静默偷换计费通道重跑，而是在错误下方附上当前健康引擎/模型的一键切换指引。
 */

export interface DiscoveredModel {
  id: string;
  name?: string;
  description?: string;
  resolvedId?: string;
  /** 完整版本号等次级别名：允许用户直接输入校验通过，但在简短摘要里折叠以免刷屏。 */
  hiddenInSummary?: boolean;
}

export interface HarnessAvailability {
  available: boolean;
  reason?: string;
}

export interface HarnessCatalogEntry {
  harness: HarnessId;
  available: boolean;
  reason?: string;
  models: DiscoveredModel[];
  source: "discovered" | "cached" | "fallback";
  updatedAt?: number;
}

interface PersistedCatalogFile {
  schema: 1;
  entries: Partial<Record<HarnessId, { models: DiscoveredModel[]; updatedAt: number }>>;
}

export interface ModelCatalogOptions {
  config: Config;
  cachePath?: string;
  configDir?: string;
  env?: () => NodeJS.ProcessEnv;
  checkAvailability?: (harness: HarnessId) => HarnessAvailability;
  discover?: (harness: HarnessId) => Promise<DiscoveredModel[]>;
  now?: () => number;
  refreshIntervalMs?: number;
}

export type ModelChoiceResolution =
  | {
      ok: true;
      harness: HarnessId;
      model: string;
      switchedHarness: boolean;
    }
  | {
      ok: false;
      message: string;
    };

export type HarnessChoiceResolution =
  | {
      ok: true;
      harness: HarnessId;
      recommendedModel: string | undefined;
    }
  | {
      ok: false;
      message: string;
    };

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return existsSync(filePath);
  }
}

export function findExecutableInPath(bin: string, pathEnv: string | undefined): string | undefined {
  if (!bin) return undefined;
  if (bin.includes("/")) {
    return isExecutableFile(bin) ? bin : undefined;
  }
  for (const dir of (pathEnv ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function editDistance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length;
  const n = t.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]!;
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
      prev = temp;
    }
  }
  return dp[n]!;
}

function inferNaturalHarness(modelId: string): HarnessId | undefined {
  const lower = modelId.trim().toLowerCase();
  if (/^(claude-|opus$|sonnet$|haiku$|fable$)/.test(lower)) return "claude";
  if (/^gemini-/.test(lower)) return "agy";
  return undefined;
}

export class ModelCatalog {
  private readonly discovered = new Map<HarnessId, { models: DiscoveredModel[]; source: "discovered" | "cached"; updatedAt: number }>();
  private readonly listeners: Array<() => void> = [];
  private timer?: NodeJS.Timeout;
  private refreshing?: Promise<void>;
  private readonly now: () => number;
  private readonly env: () => NodeJS.ProcessEnv;

  constructor(private readonly opts: ModelCatalogOptions) {
    this.now = opts.now ?? Date.now;
    this.env = opts.env ?? (() => process.env);
    if (opts.cachePath) {
      const raw = readJsonFile<PersistedCatalogFile | undefined>(opts.cachePath, undefined);
      if (raw?.schema === 1 && raw.entries && typeof raw.entries === "object") {
        for (const h of ["claude", "agy", "acp"] as const) {
          const item = raw.entries[h];
          if (item && Array.isArray(item.models) && item.models.length > 0 && typeof item.updatedAt === "number") {
            const valid = item.models.filter((m) => m && typeof m.id === "string" && m.id.trim());
            if (valid.length) {
              this.discovered.set(h, { models: valid, source: "cached", updatedAt: item.updatedAt });
            }
          }
        }
      }
    }
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch {}
    }
  }

  private persistCache(): void {
    if (!this.opts.cachePath) return;
    const entries: PersistedCatalogFile["entries"] = {};
    for (const [h, data] of this.discovered.entries()) {
      entries[h] = { models: data.models, updatedAt: data.updatedAt };
    }
    try {
      writeJsonFileAtomic(this.opts.cachePath, { schema: 1, entries } satisfies PersistedCatalogFile, 0o600);
    } catch {}
  }

  /** 由真实在线会话或探测任务写入某引擎最新发现的模型目录。 */
  recordDiscoveredModels(harness: HarnessId, models: readonly DiscoveredModel[]): void {
    const cleaned: DiscoveredModel[] = [];
    const seen = new Set<string>();
    for (const m of models) {
      const id = m.id?.trim();
      if (!id || id === "default" || id.length > 64 || seen.has(id)) continue;
      seen.add(id);
      cleaned.push({
        id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.description ? { description: m.description } : {}),
        ...(m.resolvedId ? { resolvedId: m.resolvedId } : {}),
        ...(m.hiddenInSummary ? { hiddenInSummary: true } : {}),
      });
    }
    if (!cleaned.length) return;
    const prev = this.discovered.get(harness);
    const prevSig = prev ? prev.models.map((x) => x.id).join("\0") : "";
    const nextSig = cleaned.map((x) => x.id).join("\0");
    this.discovered.set(harness, {
      models: cleaned,
      source: "discovered",
      updatedAt: this.now(),
    });
    this.persistCache();
    if (prevSig !== nextSig) this.emit();
  }

  private candidateHarnesses(): HarnessId[] {
    const list: HarnessId[] = ["claude", "agy"];
    if (this.opts.config.harness === "acp" || this.opts.config.acpCommand?.length) {
      list.push("acp");
    }
    return list;
  }

  private tryResolveReleaseDir(): string | undefined {
    const envLink = this.env()["CATMAN_RELEASE_LINK"];
    const candidates = [
      ...(envLink ? [envLink] : []),
      `${this.opts.config.releasesDir}/current`,
      `${this.opts.config.dataDir}/releases/current`,
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        try { return realpathSync(c); } catch { return c; }
      }
    }
    return undefined;
  }

  private resolveAgyExecutable(): string | undefined {
    const cfg = this.opts.config;
    const env = this.env();
    const releaseDir = this.tryResolveReleaseDir();
    const candidates = [
      ...(cfg.harnessBin ? [cfg.harnessBin] : []),
      join(cfg.mainDataDir, "harness", "agy"),
      ...(releaseDir ? [join(releaseDir, "bin", "agy")] : []),
    ];
    for (const c of candidates) {
      if (isExecutableFile(c)) return c;
    }
    return findExecutableInPath("agy", env["PATH"]);
  }

  private resolveClaudeExecutable(): string | undefined {
    const env = this.env();
    const releaseDir = this.tryResolveReleaseDir();
    const candidates = [
      ...(releaseDir ? [join(releaseDir, "node_modules/@anthropic-ai", sdkNativePackage, "claude")] : []),
    ];
    const appRoot = findAppRoot();
    if (appRoot) {
      candidates.push(join(appRoot, "node_modules/@anthropic-ai", sdkNativePackage, "claude"));
    }
    for (const c of candidates) {
      if (isExecutableFile(c)) return c;
    }
    return findExecutableInPath("claude", env["PATH"]);
  }

  checkAvailability(harness: HarnessId): HarnessAvailability {
    if (this.opts.checkAvailability) return this.opts.checkAvailability(harness);
    const env = this.env();
    const cfg = this.opts.config;

    if (harness === "claude") {
      if (!this.resolveClaudeExecutable()) {
        return { available: false, reason: "缺少 Claude SDK 二进制文件" };
      }
      if (env["ANTHROPIC_API_KEY"]?.trim() || env["CLAUDE_CODE_OAUTH_TOKEN"]?.trim() || env["ANTHROPIC_AUTH_TOKEN"]?.trim()) {
        return { available: true };
      }
      const configDir = this.opts.configDir || env["CLAUDE_CONFIG_DIR"];
      if (configDir && existsSync(join(configDir, ".credentials.json"))) {
        const expiry = readTokenExpiry(configDir);
        if (expiry !== undefined && expiry <= this.now()) {
          return { available: false, reason: "Claude OAuth 凭据已过期，请执行 claude setup-token 更新" };
        }
        return { available: true };
      }
      return { available: false, reason: "未配置 CLAUDE_CODE_OAUTH_TOKEN 或 ANTHROPIC_API_KEY" };
    }

    if (harness === "agy") {
      const hasCustomCmd = cfg.harness === "agy" && Boolean(cfg.acpCommand?.length);
      if (!hasCustomCmd && !this.resolveAgyExecutable()) {
        return { available: false, reason: "未找到 agy 可执行文件（请放入 /data/harness/agy 或加入镜像 PATH）" };
      }
      if (!env["GEMINI_API_KEY"]?.trim()) {
        return { available: false, reason: "未配置 GEMINI_API_KEY" };
      }
      return { available: true };
    }

    // generic acp
    if (!cfg.acpCommand?.length || !cfg.acpCommand[0]) {
      return { available: false, reason: "未配置 CATMAN_ACP_COMMAND" };
    }
    if (!findExecutableInPath(cfg.acpCommand[0], env["PATH"])) {
      return { available: false, reason: `未找到 ACP 可执行文件 ${cfg.acpCommand[0]}` };
    }
    if (cfg.acpUpstream === "gemini" && !env["GEMINI_API_KEY"]?.trim()) {
      return { available: false, reason: "未配置 GEMINI_API_KEY" };
    }
    if (cfg.acpUpstream === "openai" && !env["OPENAI_API_KEY"]?.trim()) {
      return { available: false, reason: "未配置 OPENAI_API_KEY" };
    }
    if (
      cfg.acpUpstream === "anthropic" &&
      !(env["ANTHROPIC_API_KEY"]?.trim() || env["CLAUDE_CODE_OAUTH_TOKEN"]?.trim() || env["ANTHROPIC_AUTH_TOKEN"]?.trim())
    ) {
      return { available: false, reason: "未配置 Anthropic 模型凭据" };
    }
    return { available: true };
  }

  entryOf(harness: HarnessId): HarnessCatalogEntry {
    const status = this.checkAvailability(harness);
    const cached = this.discovered.get(harness);
    const models = cached?.models.length
      ? cached.models
      : DEFAULT_MODELS_BY_HARNESS[harness].map((id) => ({ id }));
    return {
      harness,
      available: status.available,
      ...(status.reason ? { reason: status.reason } : {}),
      models: models.map((m) => ({ ...m })),
      source: cached ? cached.source : "fallback",
      ...(cached ? { updatedAt: cached.updatedAt } : {}),
    };
  }

  entries(): HarnessCatalogEntry[] {
    return this.candidateHarnesses().map((h) => this.entryOf(h));
  }

  /** 动态汇总当前开放给用户的模型名列表（供未显式配置 modelAllowlist 时自动生效）。 */
  dynamicAllowlist(): string[] {
    const out: string[] = [];
    const add = (id: string) => {
      if (id && id !== "default" && !out.includes(id)) out.push(id);
    };
    const all = this.entries();
    const available = all.filter((e) => e.available);
    if (available.length > 0) {
      for (const entry of available) {
        for (const m of entry.models) add(m.id);
      }
    } else {
      // 全部引擎都未就绪（如离线调试）时，保底给出基线引擎模型列表，确保配置层永不为空。
      for (const m of this.entryOf(this.opts.config.harness).models) add(m.id);
    }
    return out.length ? out : [...DEFAULT_MODELS_BY_HARNESS[this.opts.config.harness]];
  }

  visibleModelsFor(harness: HarnessId, explicitAllowlist?: readonly string[]): DiscoveredModel[] {
    const entry = this.entryOf(harness);
    const allowed = explicitAllowlist?.length
      ? entry.models.filter((m) => explicitAllowlist.includes(m.id))
      : entry.models;
    const summary = allowed.filter((m) => !m.hiddenInSummary);
    return summary.length ? summary : allowed;
  }

  ownsModel(harness: HarnessId, modelId: string): boolean {
    const target = modelId.trim().toLowerCase();
    if (!target) return false;
    const entry = this.entryOf(harness);
    if (entry.models.some((m) => m.id.toLowerCase() === target)) return true;
    return inferNaturalHarness(target) === harness;
  }

  /**
   * 判定给定 `(harness, model)` 是否匹配；若 `model` 仅属于别的引擎（例如用户刚通过 `/引擎 agy`
   * 切了引擎、但全局默认 `model` 仍是 `opus`），返回 `undefined` 让新引擎采用自身默认模型。
   */
  compatibleModelFor(harness: HarnessId, model: string | undefined): string | undefined {
    if (!model) return undefined;
    if (this.ownsModel(harness, model)) return model;
    // 若该模型明确属于其他已知引擎，不把它硬塞给当前引擎导致模型不存在报错
    for (const other of ["claude", "agy", "acp"] as const) {
      if (other !== harness && this.ownsModel(other, model)) return undefined;
    }
    return harness === "acp" ? model : undefined;
  }

  private bestFallbackCommand(preferHarness?: HarnessId, explicitAllowlist?: readonly string[]): { harness: HarnessId; model: string } | undefined {
    const candidates = this.entries().filter((e) => e.available);
    if (!candidates.length) return undefined;
    const ordered = preferHarness
      ? [...candidates.filter((c) => c.harness === preferHarness), ...candidates.filter((c) => c.harness !== preferHarness)]
      : candidates;
    for (const entry of ordered) {
      const visible = this.visibleModelsFor(entry.harness, explicitAllowlist);
      if (visible[0]) return { harness: entry.harness, model: visible[0].id };
    }
    return undefined;
  }

  formatCatalogSummary(currentHarness: HarnessId, explicitAllowlist?: readonly string[]): string {
    const lines: string[] = [];
    const entries = this.entries();
    const ordered = [
      ...entries.filter((e) => e.harness === currentHarness),
      ...entries.filter((e) => e.harness !== currentHarness),
    ];
    for (const e of ordered) {
      if (e.available) {
        const models = this.visibleModelsFor(e.harness, explicitAllowlist).map((m) => m.id);
        if (models.length) {
          lines.push(`- ✅ **${e.harness}**：${models.join(" / ")}`);
        } else {
          lines.push(`- ✅ **${e.harness}**：由引擎默认决定`);
        }
      } else {
        lines.push(`- ⚠️ **${e.harness}**（不可用：${e.reason ?? "未就绪"}）`);
      }
    }
    return lines.join("\n");
  }

  resolveHarnessChoice(rawArg: string, explicitAllowlist?: readonly string[]): HarnessChoiceResolution {
    const normalized = rawArg.trim().toLowerCase();
    const target: HarnessId | undefined =
      normalized === "claude"
        ? "claude"
        : normalized === "agy" || normalized === "antigravity"
          ? "agy"
          : normalized === "acp"
            ? "acp"
            : undefined;

    if (!target) {
      const fb = this.bestFallbackCommand(undefined, explicitAllowlist);
      return {
        ok: false,
        message: [
          `引擎没改:不认识的引擎 ${JSON.stringify(rawArg)},可选:claude / agy / acp`,
          "当前引擎状态：",
          this.formatCatalogSummary(this.opts.config.harness, explicitAllowlist),
          ...(fb ? ["可复制切换：", codeBlock(`/引擎 ${fb.harness}`)] : []),
        ].join("\n\n"),
      };
    }

    const entry = this.entryOf(target);
    if (!entry.available) {
      const fb = this.bestFallbackCommand(undefined, explicitAllowlist);
      return {
        ok: false,
        message: [
          `引擎没改:${target} 当前不可用（${entry.reason ?? "未就绪"}）。`,
          "当前引擎状态：",
          this.formatCatalogSummary(this.opts.config.harness, explicitAllowlist),
          ...(fb ? [`建议保持或切换到可用的 ${inlineCode(fb.harness)}：`, codeBlock(`/引擎 ${fb.harness}`)] : []),
        ].join("\n\n"),
      };
    }

    const visible = this.visibleModelsFor(target, explicitAllowlist);
    return {
      ok: true,
      harness: target,
      recommendedModel: visible[0]?.id,
    };
  }

  resolveModelChoice(
    rawArg: string,
    currentHarness: HarnessId,
    explicitAllowlist?: readonly string[],
  ): ModelChoiceResolution {
    const trimmed = rawArg.trim();
    let explicitHarness: HarnessId | undefined;
    let modelQuery = trimmed;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const prefix = trimmed.slice(0, colonIdx).trim().toLowerCase();
      if (prefix === "claude" || prefix === "agy" || prefix === "antigravity" || prefix === "acp") {
        explicitHarness = prefix === "antigravity" ? "agy" : (prefix as HarnessId);
        modelQuery = trimmed.slice(colonIdx + 1).trim();
      }
    }

    if (!modelQuery) {
      return {
        ok: false,
        message: `模型没改:请给出具体模型名。\n\n可选:\n\n${this.formatCatalogSummary(currentHarness, explicitAllowlist)}`,
      };
    }

    const entries = this.entries();
    const matchInEntry = (entry: HarnessCatalogEntry): DiscoveredModel | undefined =>
      entry.models.find((m) => m.id.toLowerCase() === modelQuery.toLowerCase()) ??
      entry.models.find((m) => m.name?.toLowerCase() === modelQuery.toLowerCase());

    let matchedEntry: HarnessCatalogEntry | undefined;
    let matchedModel: string | undefined;

    if (explicitHarness) {
      const entry = this.entryOf(explicitHarness);
      matchedEntry = entry;
      const hit = matchInEntry(entry);
      if (hit) matchedModel = hit.id;
      else if (explicitHarness === "acp" && entry.source === "fallback" && modelQuery.length <= 64) {
        matchedModel = modelQuery;
      }
    } else {
      // 优先匹配当前引擎，其次匹配其他可用引擎，最后看是否命中某个暂不可用的引擎以给出精准诊断
      const currentEntry = this.entryOf(currentHarness);
      const hitCurrent = currentEntry.available ? matchInEntry(currentEntry) : undefined;
      if (hitCurrent) {
        matchedEntry = currentEntry;
        matchedModel = hitCurrent.id;
      } else {
        for (const e of entries) {
          if (!e.available) continue;
          const hit = matchInEntry(e);
          if (hit) {
            matchedEntry = e;
            matchedModel = hit.id;
            break;
          }
        }
        if (!matchedEntry) {
          for (const e of entries) {
            const hit = matchInEntry(e);
            if (hit) {
              matchedEntry = e;
              matchedModel = hit.id;
              break;
            }
          }
        }
        if (!matchedEntry) {
          const natural = inferNaturalHarness(modelQuery);
          if (natural) {
            const natEntry = this.entryOf(natural);
            if (!natEntry.available) {
              matchedEntry = natEntry;
              matchedModel = modelQuery;
            }
          }
        }
      }
    }

    // 命中某个已知引擎，但该引擎此刻未就绪（缺 API Key 或二进制）
    if (matchedEntry && !matchedEntry.available) {
      const fb = this.bestFallbackCommand(currentHarness, explicitAllowlist);
      return {
        ok: false,
        message: [
          `模型没改:${inlineCode(matchedModel ?? modelQuery)} 属于 ${inlineCode(matchedEntry.harness)} 引擎，但该引擎当前不可用（${matchedEntry.reason ?? "未就绪"}）。`,
          "可选:",
          this.formatCatalogSummary(currentHarness, explicitAllowlist),
          ...(fb ? ["可复制切换到当前可用模型：", codeBlock(`/模型 ${fb.model}`)] : []),
        ].join("\n\n"),
      };
    }

    // 命中可用引擎与模型：再核对管理员显式白名单（若有）
    if (matchedEntry && matchedModel) {
      if (explicitAllowlist?.length && !explicitAllowlist.includes(matchedModel)) {
        const fb = this.bestFallbackCommand(currentHarness, explicitAllowlist);
        return {
          ok: false,
          message: [
            `模型没改:管理员已限制可选模型范围，${inlineCode(matchedModel)} 当前未开放。`,
            `可选:${explicitAllowlist.join(" / ")}`,
            ...(fb ? ["可复制切换：", codeBlock(`/模型 ${fb.model}`)] : []),
          ].join("\n\n"),
        };
      }
      return {
        ok: true,
        harness: matchedEntry.harness,
        model: matchedModel,
        switchedHarness: matchedEntry.harness !== currentHarness,
      };
    }

    // 若管理员手工在白名单里放行了某个自定义网关模型名（如第三方 OpenAI/Anthropic 代理上的 deepseek-chat），且当前引擎可用则允许使用
    if (explicitAllowlist?.includes(modelQuery)) {
      const targetHarness = explicitHarness ?? currentHarness;
      const targetEntry = this.entryOf(targetHarness);
      if (targetEntry.available) {
        return {
          ok: true,
          harness: targetHarness,
          model: modelQuery,
          switchedHarness: targetHarness !== currentHarness,
        };
      }
    }

    // 拼写相近候选推荐
    const pool = entries
      .filter((e) => e.available)
      .flatMap((e) =>
        e.models
          .filter((m) => !m.hiddenInSummary && (!explicitAllowlist?.length || explicitAllowlist.includes(m.id)))
          .map((m) => m.id),
      );
    const uniquePool = [...new Set(pool)];
    const lowerQ = modelQuery.toLowerCase();
    const suggestions = uniquePool
      .map((id) => ({
        id,
        score: id.toLowerCase().includes(lowerQ) || lowerQ.includes(id.toLowerCase()) ? 0 : editDistance(lowerQ, id.toLowerCase()),
      }))
      .filter((x) => x.score <= 4)
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map((x) => x.id);

    const bestModel = suggestions[0] ?? this.bestFallbackCommand(currentHarness, explicitAllowlist)?.model;
    return {
      ok: false,
      message: [
        `模型没改:不支持或未找到模型 ${JSON.stringify(rawArg)}。`,
        ...(suggestions.length ? [`相近的可用模型：${suggestions.map(inlineCode).join(" / ")}`] : []),
        "可选:",
        this.formatCatalogSummary(currentHarness, explicitAllowlist),
        ...(bestModel ? ["可复制切换：", codeBlock(`/模型 ${bestModel}`)] : []),
      ].join("\n\n"),
    };
  }

  /**
   * 回合运行失败时生成模型/引擎切换引导。
   * 仅针对凭据失效、限流超额、模型不存在或引擎二进制缺失触发，常规业务/代码错误不打扰用户。
   */
  failureGuidance(input: {
    harness: HarnessId;
    model?: string;
    errorText: string;
    explicitAllowlist?: readonly string[];
  }): string | undefined {
    const t = input.errorText.toLowerCase();
    const category = classifyFailure(input.errorText);
    const isModelMissing =
      /model.{0,28}(not found|invalid|unknown|unsupported|does not exist|deprecated)|not_found_error|invalid_model/.test(t);
    const isBinaryMissing =
      /缺少执行运行时|可执行文件|二进制不存在|spawn .* enoent/.test(t);

    if (category !== "auth" && category !== "ratelimit" && !isModelMissing && !isBinaryMissing) {
      return undefined;
    }

    const entries = this.entries();
    const otherHealthy = entries.filter((e) => e.harness !== input.harness && e.available);

    if (isModelMissing) {
      const sameEntry = this.entryOf(input.harness);
      const sameAlternatives = sameEntry.available
        ? this.visibleModelsFor(input.harness, input.explicitAllowlist).filter((m) => m.id !== input.model)
        : [];
      const primaryAlt = sameAlternatives[0]?.id ?? (otherHealthy[0] ? this.visibleModelsFor(otherHealthy[0].harness, input.explicitAllowlist)[0]?.id : undefined);
      if (!primaryAlt) return undefined;
      const hintLines = [
        `💡 当前指定的模型${input.model ? ` ${inlineCode(input.model)}` : ""}不可用或已下线。`,
        ...(sameAlternatives.length
          ? [`同引擎（${inlineCode(input.harness)}）可用模型：${sameAlternatives.map((m) => m.id).join(" / ")}`]
          : []),
        ...otherHealthy.map((e) => {
          const ms = this.visibleModelsFor(e.harness, input.explicitAllowlist).map((m) => m.id);
          return ms.length ? `其他可用引擎（${inlineCode(e.harness)}）：${ms.join(" / ")}` : "";
        }).filter(Boolean),
        "发送下方指令即可切换模型后重试：",
        codeBlock(`/模型 ${primaryAlt}`),
      ];
      return hintLines.join("\n\n");
    }

    // 鉴权失败 / 额度限流 / 引擎二进制缺失：优先推荐其他就绪引擎
    for (const alt of otherHealthy) {
      const altModels = this.visibleModelsFor(alt.harness, input.explicitAllowlist);
      if (altModels[0]) {
        const reasonLabel =
          isBinaryMissing ? "执行组件缺失" : category === "ratelimit" ? "触发限流或配额耗尽" : "凭据不可用或余额不足";
        return [
          `💡 当前 ${inlineCode(input.harness)} 引擎${reasonLabel}。检测到 ${inlineCode(alt.harness)} 引擎当前可用（${altModels.map((m) => m.id).slice(0, 4).join(" / ")}），发送下方指令即可切换后重试：`,
          codeBlock(`/模型 ${altModels[0].id}`),
        ].join("\n\n");
      }
    }

    // 没有其他引擎可用，但属于限流且当前引擎有更轻量的备选模型（如 opus 限流时切 sonnet/haiku）
    if (category === "ratelimit") {
      const sameEntry = this.entryOf(input.harness);
      if (sameEntry.available) {
        const others = this.visibleModelsFor(input.harness, input.explicitAllowlist).filter((m) => m.id !== input.model);
        const lighter = others.find((m) => /sonnet|haiku|flash/i.test(m.id)) ?? others[0];
        if (lighter) {
          return [
            `💡 当前模型触发限流，可尝试切换到同引擎的 ${inlineCode(lighter.id)} 后重试：`,
            codeBlock(`/模型 ${lighter.id}`),
          ].join("\n\n");
        }
      }
    }

    return undefined;
  }

  /**
   * 主动零 Token 刷新各就绪引擎的可用模型目录。单飞防重入，任何单引擎探测失败静默保留旧缓存。
   */
  async refresh(onlyHarness?: HarnessId): Promise<void> {
    if (!onlyHarness && this.refreshing) return this.refreshing;
    const task = (async () => {
      const targets = onlyHarness ? [onlyHarness] : this.candidateHarnesses();
      await Promise.all(
        targets.map(async (harness) => {
          const status = this.checkAvailability(harness);
          if (!status.available) return;
          try {
            const models = this.opts.discover
              ? await this.opts.discover(harness)
              : await this.defaultDiscover(harness);
            if (models.length) this.recordDiscoveredModels(harness, models);
          } catch (err) {
            console.warn(`[model-catalog] ${harness} 模型目录探测跳过: ${String(err)}`);
          }
        }),
      );
    })();
    if (!onlyHarness) this.refreshing = task;
    try {
      await task;
    } finally {
      if (!onlyHarness && this.refreshing === task) this.refreshing = undefined;
    }
  }

  start(): void {
    void this.refresh();
    const interval = this.opts.refreshIntervalMs ?? 30 * 60_000;
    this.timer = setInterval(() => {
      void this.refresh();
    }, interval);
    this.timer.unref?.();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async defaultDiscover(harness: HarnessId): Promise<DiscoveredModel[]> {
    const sandbox = mkdtempSync(join(tmpdir(), `catman-catalog-${harness}-`));
    try {
      if (harness === "claude") {
        return await this.discoverClaudeModels(sandbox);
      }
      if (harness === "agy") {
        return await this.discoverAgyModels(sandbox);
      }
      return await this.discoverGenericAcpModels(sandbox);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }

  private async discoverClaudeModels(sandbox: string): Promise<DiscoveredModel[]> {
    const env = this.env();
    const ch = new InputChannel();
    const q = query({
      prompt: ch,
      options: {
        cwd: sandbox,
        env: {
          ...env,
          HOME: sandbox,
          CLAUDE_CONFIG_DIR: this.opts.configDir || env["CLAUDE_CONFIG_DIR"] || sandbox,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_TELEMETRY: "1",
        },
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sdkModels: DiscoveredModel[] = [];
    try {
      const raw = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Claude supportedModels 超时")), 10_000);
        }),
      ]);
      sdkModels = extractSdkSupportedModels(raw);
    } finally {
      if (timer) clearTimeout(timer);
      ch.close();
      q.close();
    }

    // 自定义网关（如第三方兼容端点）额外拉取一次 /v1/models 合并可用 ID
    const customBase = env["ANTHROPIC_BASE_URL"]?.trim();
    if (customBase) {
      const upstream = await this.fetchOpenAiStyleModels(
        `${customBase.replace(/\/$/, "")}/v1/models`,
        env["ANTHROPIC_API_KEY"]
          ? { "x-api-key": env["ANTHROPIC_API_KEY"] }
          : env["ANTHROPIC_AUTH_TOKEN"] || env["CLAUDE_CODE_OAUTH_TOKEN"]
            ? { authorization: `Bearer ${env["ANTHROPIC_AUTH_TOKEN"] || env["CLAUDE_CODE_OAUTH_TOKEN"]}` }
            : {},
      );
      const seen = new Set(sdkModels.map((m) => m.id));
      for (const m of upstream) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          sdkModels.push(m);
        }
      }
    }
    return sdkModels;
  }

  private async discoverAgyModels(sandbox: string): Promise<DiscoveredModel[]> {
    const env = this.env();
    const cfg = this.opts.config;
    const home = join(sandbox, "home");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({
        modelProvider: "gemini",
        toolPermission: "always-proceed",
        notifications: false,
        showTips: false,
        showFeedbackSurvey: false,
      }),
      { mode: 0o600 },
    );
    const bin = this.resolveAgyExecutable() || "agy";
    const cmd = cfg.harness === "agy" && cfg.acpCommand?.length
      ? cfg.acpCommand
      : [bin, "acp", "--dangerously-skip-permissions", "--disable-telemetry"];
    const acpModels = await discoverAcpModels(
      () =>
        spawnAcpSubprocess(cmd, {
          cwd: sandbox,
          env: {
            ...env,
            HOME: home,
            AGY_CLI_DISABLE_AUTO_UPDATE: "true",
          },
        }),
      { cwd: sandbox, timeoutMs: 10_000 },
    );
    if (acpModels.length) return acpModels;
    return this.fetchGeminiModels();
  }

  private async discoverGenericAcpModels(sandbox: string): Promise<DiscoveredModel[]> {
    const env = this.env();
    const cfg = this.opts.config;
    if (!cfg.acpCommand?.length) return [];
    const acpModels = await discoverAcpModels(
      () => spawnAcpSubprocess(cfg.acpCommand!, { cwd: sandbox, env: { ...env } }),
      { cwd: sandbox, timeoutMs: 10_000 },
    );
    if (acpModels.length) return acpModels;
    if (cfg.acpUpstream === "gemini") return this.fetchGeminiModels();
    if (cfg.acpUpstream === "openai" && env["OPENAI_API_KEY"]) {
      const base = (env["OPENAI_BASE_URL"] || "https://api.openai.com/v1").replace(/\/$/, "");
      const url = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
      return this.fetchOpenAiStyleModels(url, { authorization: `Bearer ${env["OPENAI_API_KEY"]}` });
    }
    return [];
  }

  private async requestJsonViaEnvProxy(url: string, headers: Record<string, string>): Promise<unknown | undefined> {
    const env = this.env();
    const dispatcher = new EnvHttpProxyAgent({
      httpProxy: env["http_proxy"] ?? env["HTTP_PROXY"] ?? "",
      httpsProxy: env["https_proxy"] ?? env["HTTPS_PROXY"] ?? "",
      noProxy: ["localhost", "127.0.0.1", env["no_proxy"] ?? env["NO_PROXY"] ?? ""].filter(Boolean).join(","),
      proxyTunnel: false,
    });
    try {
      const res = await request(url, {
        dispatcher,
        method: "GET",
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      if (res.statusCode < 200 || res.statusCode >= 300) {
        await res.body.dump();
        return undefined;
      }
      return await res.body.json();
    } catch {
      return undefined;
    } finally {
      await dispatcher.destroy().catch(() => {});
    }
  }

  private async fetchGeminiModels(): Promise<DiscoveredModel[]> {
    const env = this.env();
    const key = env["GEMINI_API_KEY"]?.trim();
    if (!key) return [];
    const base = (env["GOOGLE_GEMINI_BASE_URL"] || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
    const data = (await this.requestJsonViaEnvProxy(`${base}/v1beta/models`, {
      "x-goog-api-key": key,
    })) as { models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }> } | undefined;
    if (!data) return [];
    const out: DiscoveredModel[] = [];
    for (const m of data.models ?? []) {
      if (Array.isArray(m.supportedGenerationMethods) && !m.supportedGenerationMethods.includes("generateContent")) continue;
      const id = m.name?.replace(/^models\//, "").trim();
      if (id) out.push({ id, ...(m.displayName ? { name: m.displayName } : {}) });
    }
    return out;
  }

  private async fetchOpenAiStyleModels(url: string, headers: Record<string, string>): Promise<DiscoveredModel[]> {
    const data = (await this.requestJsonViaEnvProxy(url, headers)) as { data?: Array<{ id?: string }> } | undefined;
    if (!data) return [];
    return (data.data ?? [])
      .map((m) => (typeof m.id === "string" ? m.id.trim() : ""))
      .filter((id) => id.length > 0 && id.length <= 64)
      .map((id) => ({ id }));
  }
}
