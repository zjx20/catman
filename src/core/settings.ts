import type { Config } from "../config.js";
import { BUILTIN_ADMIN_USER_KEY, parseUserKey } from "./identity.js";
import { readJsonFile, writeJsonFileAtomic } from "./file-store.js";

/**
 * 配置项的 schema 与全局运行时层。
 *
 * 三层模型:
 *   config.ts (env)   基线,重启才变
 *     └─ settings.json  全局运行时覆盖   ← 管理员改
 *          └─ prefs.json  每用户覆盖     ← 用户自己改(见 prefs.ts)
 *
 * ## 兜底优先于交叉校验
 *
 * 核心目标:**任何配置状态下 agent 都必须能起来**。有 LLM 才有自我修复的可能,
 * 否则只能人工进容器改文件。
 *
 * 由此推出:配置项之间一律不做交叉一致性校验,改一处不用管别处;用读取时的
 * 逐级回退代替写入时的一致性检查。管理员把某个模型移出白名单时,不需要去检查
 * 有没有人正在用它 —— 读取侧会自动退到下一级,最末端是 floor。
 *
 * 落到每一项上是**读写不对称的一对函数**:
 *   validate() 写入时用,坏值抛错带原因 → HTTP 400 → agent 能告诉用户哪儿不对
 *   parse()    读取时用,坏值返回 undefined,由调用方继续退到下一级
 *
 * 因此 effective() **永不抛错**。整个 settings.json 损坏也没关系:file-store 的
 * readJsonFile 已把非 object 降级为 {},等于全部回落 env。
 *
 * ## SETTING_SCHEMA 是单一真相源
 *
 * 校验、HTTP 的 schema 字段、两个 skill 的正文、帮助文案的可配置项清单,
 * 全部从这张表生成 —— 加一项只改这里,四处同步跟着走。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 全部配置项的取值。model 为 undefined 表示不传给 SDK,由它自己决定。 */
export interface Settings {
  model: string | undefined;
  ackEnabled: boolean;
  progressEnabled: boolean;
  maxReplyChars: number;
  sessionTimeoutMs: number;
  modelAllowlist: string[];
  maxConcurrentTurns: number;
  retentionMs: number;
  cleanupIntervalMs: number;
  adminUserKeys: string[];
  maxImageBytes: number;
  maxImagesPerTurn: number;
  messageAggregationMs: number;
}

/** scope="user" 的那些项:全局可设默认值,每用户还能各自覆盖。 */
export type UserSettingKey =
  | "model"
  | "ackEnabled"
  | "progressEnabled"
  | "maxReplyChars"
  | "sessionTimeoutMs";

export const USER_SETTING_KEYS: readonly UserSettingKey[] = [
  "model",
  "ackEnabled",
  "progressEnabled",
  "maxReplyChars",
  "sessionTimeoutMs",
];

export type SettingKey = keyof Settings;

/** 解析某些项时需要的上下文。modelAllowlist 自己总是最先被解析出来。 */
export interface SettingContext {
  modelAllowlist: string[];
}

export interface SettingDef<T> {
  readonly scope: "user" | "global";
  readonly label: string;
  readonly desc: string;
  /** 取值说明,进 skill 正文与帮助文案。 */
  hint(ctx: SettingContext): string;
  /**
   * 兜底链的末端,永远可用。
   * model 的末端是 undefined —— 「不传 model,交给 SDK 默认」,这正是
   * 「不能让 agent 丢掉大脑」在类型上的表达。
   */
  readonly floor: T;
  /** 严格:写入路径用。坏值抛错,错误文案要能直接念给用户听。 */
  validate(raw: unknown, ctx: SettingContext): T;
  /** 宽容:读取路径用。坏值返回 undefined,调用方退到下一级。 */
  parse(raw: unknown, ctx: SettingContext): T | undefined;
}

type Schema = { readonly [K in SettingKey]: SettingDef<Settings[K]> };

// --- 构造器 ---

function boolDef(
  scope: "user" | "global",
  label: string,
  desc: string,
  floor: boolean,
): SettingDef<boolean> {
  return {
    scope,
    label,
    desc,
    floor,
    hint: () => "true / false",
    validate(raw) {
      if (typeof raw !== "boolean") throw new Error(`${label} 只接受 true 或 false`);
      return raw;
    },
    parse(raw) {
      return typeof raw === "boolean" ? raw : undefined;
    },
  };
}

/**
 * 整数项。越界一律 clamp 而不是拒绝 —— 写入的返回值是生效后的值,
 * agent 据此可以如实告诉用户「已设为上限 N」。非数字才算坏值。
 */
function intDef(
  scope: "user" | "global",
  label: string,
  desc: string,
  floor: number,
  min: number,
  max: number,
  unit = "",
): SettingDef<number> {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v)));
  return {
    scope,
    label,
    desc,
    floor: clamp(floor),
    hint: () => `整数 ${min} ~ ${max}${unit}`,
    validate(raw) {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new Error(`${label} 需要一个数字,取值 ${min} ~ ${max}${unit}`);
      }
      return clamp(raw);
    },
    parse(raw) {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
      return clamp(raw);
    },
  };
}

function stringArrayDef(
  label: string,
  desc: string,
  floor: string[],
  each: (v: string) => boolean,
  eachHint: string,
): SettingDef<string[]> {
  const check = (raw: unknown): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const out: string[] = [];
    for (const v of raw) {
      if (typeof v !== "string" || !each(v)) return undefined;
      if (!out.includes(v)) out.push(v);
    }
    return out;
  };
  return {
    scope: "global",
    label,
    desc,
    floor,
    hint: () => eachHint,
    validate(raw) {
      const v = check(raw);
      if (!v) throw new Error(`${label} 需要一个数组,每一项${eachHint}`);
      return v;
    },
    parse(raw) {
      const v = check(raw);
      // 空数组对白名单来说等于"什么都不许用",没有意义,当坏值退到下一级。
      return v && v.length ? v : undefined;
    },
  };
}

// --- schema ---

export const SETTING_SCHEMA: Schema = {
  model: {
    scope: "user",
    label: "模型",
    desc: "跑这个助手用哪个 Claude 模型。改完下一轮生效。",
    floor: undefined,
    hint: (ctx) => ctx.modelAllowlist.join(" / "),
    validate(raw, ctx) {
      if (typeof raw !== "string" || !ctx.modelAllowlist.includes(raw)) {
        throw new Error(`不支持的模型 ${JSON.stringify(raw)},可选:${ctx.modelAllowlist.join(" / ")}`);
      }
      return raw;
    },
    parse(raw, ctx) {
      // 白名单事后收窄时,这里会拒绝已经存下来的值 —— 调用方于是退到全局默认,
      // 再不行退到 env,最后退到「不传 model」。不改盘:白名单加回来时自动恢复。
      return typeof raw === "string" && ctx.modelAllowlist.includes(raw) ? raw : undefined;
    },
  },
  ackEnabled: boolDef("user", "回执", "收到消息后先回一条「正在处理」。", true),
  progressEnabled: boolDef("user", "进度", "把思考摘要与工具调用转发给你。", true),
  maxReplyChars: intDef("user", "分段长度", "单条回复超过这个长度就分段发。", 2000, 200, 5000, " 字"),
  sessionTimeoutMs: intDef(
    "user",
    "会话超时",
    "安静超过这个时长后,下一条消息默认开新对话。",
    HOUR,
    MINUTE,
    7 * DAY,
    " 毫秒",
  ),
  modelAllowlist: stringArrayDef(
    "可用模型",
    "允许用户选择的模型。收窄它不需要管存量用户,读取侧会自动回退。",
    ["opus", "sonnet", "haiku"],
    (v) => v.length > 0 && v.length <= 64,
    "是非空模型名(别名如 opus / sonnet / haiku,或完整 id)",
  ),
  maxConcurrentTurns: intDef("global", "并发上限", "同时进行的 agent 回合数(跨用户)。", 2, 1, 16),
  retentionMs: intDef("global", "会话保留期", "超过这个时长的会话记录会被清理。", 30 * DAY, DAY, 365 * DAY, " 毫秒"),
  cleanupIntervalMs: intDef("global", "清理间隔", "多久跑一次过期会话清理。", DAY, HOUR, 30 * DAY, " 毫秒"),
  // 上限直接决定内存峰值(base64 在内存里驻留整个回合)与图片 token 开销,
  // 所以要能按机器调 —— 软路由和 x86 主机的余量差得远。
  maxImageBytes: intDef(
    "global",
    "图片大小上限",
    "单张图片的原始字节上限,超过就拒收(不缩图)。",
    3_500_000,
    100_000,
    5_000_000,
    " 字节",
  ),
  maxImagesPerTurn: intDef("global", "单回合图片数", "一条消息最多看几张图,多的跳过。", 4, 1, 20),
  // 微信发「图 + 文字」是两条消息(实测间隔约 120ms),不攒一下会起两个回合、
  // 且先到的那条必然缺另一半。设 0 关闭聚合,每条消息各起一个回合。
  messageAggregationMs: intDef(
    "global",
    "消息聚合窗口",
    "连续消息攒这么久再一起处理;设 0 则收到就处理。",
    1500,
    0,
    10_000,
    " 毫秒",
  ),
  adminUserKeys: stringArrayDef(
    "管理员",
    `额外拥有管理员权限的 userKey。内置的 ${BUILTIN_ADMIN_USER_KEY} 不在此列且无法移除。`,
    [],
    (v) => !!parseUserKey(v) && v !== BUILTIN_ADMIN_USER_KEY,
    "是合法 userKey(<channel>:<accountId>:<userId>)",
  ),
};

/** schema 的可序列化描述,供 HTTP 返回给 agent —— 它据此知道能改什么、怎么改。 */
export interface SettingDescription {
  key: SettingKey;
  scope: "user" | "global";
  label: string;
  desc: string;
  hint: string;
}

export function describeSettings(
  keys: readonly SettingKey[],
  ctx: SettingContext,
): SettingDescription[] {
  return keys.map((key) => {
    const def = SETTING_SCHEMA[key];
    return { key, scope: def.scope, label: def.label, desc: def.desc, hint: def.hint(ctx) };
  });
}

/** 全部 scope="global" 的项。 */
export const GLOBAL_SETTING_KEYS: readonly SettingKey[] = (
  Object.keys(SETTING_SCHEMA) as SettingKey[]
).filter((k) => SETTING_SCHEMA[k].scope === "global");

// --- 回退链 ---

const warned = new Set<string>();

/**
 * 回退时告警,但同一个「谁·哪项·什么坏值」只说一次。
 * effective() 每回合都会调,不去重会把日志刷爆。
 */
export function warnFallbackOnce(scope: string, key: string, raw: unknown): void {
  const sig = `${scope}|${key}|${JSON.stringify(raw) ?? "?"}`;
  if (warned.has(sig)) return;
  warned.add(sig);
  console.warn(`[settings] ${scope} 的 ${key}=${JSON.stringify(raw)} 当前不可用,已回退到下一级`);
}

/** 仅供测试:清掉告警去重表。 */
export function resetFallbackWarnings(): void {
  warned.clear();
}

/**
 * 沿候选值链逐级解析,全都不可用时落到 floor。**永不抛错。**
 * 候选里的 undefined/null 表示「这一级没有配」,直接跳过,不算坏值。
 */
export function resolveSetting<K extends SettingKey>(
  key: K,
  ctx: SettingContext,
  scopeLabel: string,
  candidates: readonly unknown[],
): Settings[K] {
  const def = SETTING_SCHEMA[key] as SettingDef<Settings[K]>;
  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const v = def.parse(raw, ctx);
    if (v !== undefined) return v;
    warnFallbackOnce(scopeLabel, key, raw);
  }
  return def.floor;
}

// --- 全局层 ---

export type SettingsOverrides = Partial<Settings>;

/** PATCH 的入参:值为 null 表示清除这一项的覆盖。 */
export type SettingsPatch = { [K in SettingKey]?: Settings[K] | null };

export interface GlobalSettingsOptions {
  /** settings.json 路径。 */
  path: string;
  /** env 基线。settings.json 没覆盖的项回落到它。 */
  env: Config;
}

export class GlobalSettings {
  private overridesRaw: Record<string, unknown>;
  private readonly path: string;
  private readonly env: Config;
  private readonly listeners: Array<() => void> = [];

  constructor(opts: GlobalSettingsOptions) {
    this.path = opts.path;
    this.env = opts.env;
    this.overridesRaw = readJsonFile<Record<string, unknown>>(this.path, {});
  }

  /** env 基线里对应某项的值;没有对应 env 的项返回 undefined。 */
  private envBaseline(key: SettingKey): unknown {
    switch (key) {
      case "model":
        return this.env.model;
      case "ackEnabled":
        return this.env.ackEnabled;
      case "progressEnabled":
        return this.env.progressEnabled;
      case "sessionTimeoutMs":
        return this.env.sessionTimeoutMs;
      case "modelAllowlist":
        return this.env.modelAllowlist;
      case "maxConcurrentTurns":
        return this.env.maxConcurrentTurns;
      case "retentionMs":
        return this.env.retentionMs;
      case "cleanupIntervalMs":
        return this.env.cleanupIntervalMs;
      case "maxImageBytes":
        return this.env.maxImageBytes;
      case "maxImagesPerTurn":
        return this.env.maxImagesPerTurn;
      case "messageAggregationMs":
        return this.env.messageAggregationMs;
      case "adminUserKeys":
        // 空数组当"没给" —— 否则守护人格从主 settings.json 继承来的名单会被一个
        // 空基线盖掉。与别的项不同,这一项的默认值(floor)本身就是空数组,
        // 所以"给了空的"与"没给"在行为上无从区分,当没给最省事也最不会出错。
        return this.env.adminUserKeys.length ? this.env.adminUserKeys : undefined;
      default:
        // maxReplyChars 没有 env 基线,直接用 floor。
        return undefined;
    }
  }

  /** 当前生效的全局配置。永不抛错。 */
  effective(): Settings {
    // 白名单要先解析出来:model 的 parse 依赖它。
    const modelAllowlist = resolveSetting("modelAllowlist", { modelAllowlist: [] }, "global", [
      this.overridesRaw["modelAllowlist"],
      this.envBaseline("modelAllowlist"),
    ]);
    const ctx: SettingContext = { modelAllowlist };
    const pick = <K extends SettingKey>(key: K): Settings[K] =>
      resolveSetting(key, ctx, "global", [this.overridesRaw[key], this.envBaseline(key)]);

    return {
      modelAllowlist,
      model: pick("model"),
      ackEnabled: pick("ackEnabled"),
      progressEnabled: pick("progressEnabled"),
      maxReplyChars: pick("maxReplyChars"),
      sessionTimeoutMs: pick("sessionTimeoutMs"),
      maxConcurrentTurns: pick("maxConcurrentTurns"),
      retentionMs: pick("retentionMs"),
      cleanupIntervalMs: pick("cleanupIntervalMs"),
      adminUserKeys: pick("adminUserKeys"),
      maxImageBytes: pick("maxImageBytes"),
      maxImagesPerTurn: pick("maxImagesPerTurn"),
      messageAggregationMs: pick("messageAggregationMs"),
    };
  }

  /** 只返回被显式覆盖的项(dashboard 用,便于区分"默认"与"设过")。 */
  overrides(): SettingsOverrides {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(SETTING_SCHEMA) as SettingKey[]) {
      if (this.overridesRaw[key] !== undefined) out[key] = this.overridesRaw[key];
    }
    return out as SettingsOverrides;
  }

  /**
   * 写入覆盖。值为 null 表示清除该项覆盖。任何一项非法都整体抛错、不落盘。
   *
   * 同一次 PATCH 里既改 modelAllowlist 又改 model 是合法的:先算出新白名单
   * 再校验 model,否则用旧白名单会把一个本该成立的组合判错。
   */
  set(patch: SettingsPatch): Settings {
    const next = { ...this.overridesRaw };
    const keys = Object.keys(patch) as SettingKey[];
    for (const key of keys) {
      if (!(key in SETTING_SCHEMA)) throw new Error(`未知配置项 ${key}`);
    }

    // 先定新白名单,供 model 的校验使用。
    let ctxAllowlist = this.effective().modelAllowlist;
    if ("modelAllowlist" in patch) {
      const raw = patch.modelAllowlist;
      ctxAllowlist =
        raw === null
          ? resolveSetting("modelAllowlist", { modelAllowlist: [] }, "global", [
              this.envBaseline("modelAllowlist"),
            ])
          : SETTING_SCHEMA.modelAllowlist.validate(raw, { modelAllowlist: [] });
    }
    const ctx: SettingContext = { modelAllowlist: ctxAllowlist };

    for (const key of keys) {
      const raw = patch[key];
      if (raw === null) {
        delete next[key];
        continue;
      }
      const def = SETTING_SCHEMA[key] as SettingDef<unknown>;
      next[key] = def.validate(raw, ctx);
    }

    this.overridesRaw = next;
    writeJsonFileAtomic(this.path, this.overridesRaw);
    this.emit();
    return this.effective();
  }

  /**
   * 是否管理员。内置 dashboard 管理员硬编码为真,且不在 adminUserKeys 里 ——
   * 那个列表被清空也不影响它,这是不可撤销的恢复通道。
   */
  isAdmin(userKey: string): boolean {
    if (userKey === BUILTIN_ADMIN_USER_KEY) return true;
    return this.effective().adminUserKeys.includes(userKey);
  }

  /** 配置变更回调。用于并发上限、清理定时器这类"改了要重建"的东西。 */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error("[settings] 变更回调失败:", err);
      }
    }
  }
}
