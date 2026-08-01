import { readJsonFile, writeJsonFileAtomic } from "./file-store.js";
import {
  SETTING_SCHEMA,
  USER_SETTING_KEYS,
  resolveSetting,
  type SettingContext,
  type SettingDef,
  type Settings,
  type UserSettingKey,
} from "./settings.js";

/**
 * 每用户配置层。三层模型里最靠外的一层,见 settings.ts 的说明。
 *
 * 这里最要紧的一条:**回落但不改盘**。管理员把某个模型移出白名单后,
 * 某用户 prefs 里存的那个值会失效 —— effective() 让它回退到全局默认(并告警一次),
 * 但**不重写 prefs.json**。白名单加回来时,用户当初的选择就自动恢复了。
 * 静默改盘会把用户的意图永久抹掉,而回退只是临时的。
 */

export type UserPrefs = Partial<Pick<Settings, UserSettingKey>>;
export type EffectiveUserPrefs = Pick<Settings, UserSettingKey>;
export type UserPrefsPatch = { [K in UserSettingKey]?: Settings[K] | null };

export type PrefsMap = Record<string, Record<string, unknown>>;

export interface PrefsStoreOptions {
  /** prefs.json 路径。 */
  path: string;
  /**
   * 全局默认值。**是函数不是快照** —— 管理员改了全局默认,这里必须立刻跟随,
   * 拿快照会让改动要等重启才生效。
   */
  defaults: () => Settings;
}

export class PrefsStore {
  private readonly prefs: PrefsMap;
  private readonly path: string;
  private readonly defaults: () => Settings;

  constructor(opts: PrefsStoreOptions) {
    this.path = opts.path;
    this.defaults = opts.defaults;
    this.prefs = readJsonFile<PrefsMap>(this.path, {});
  }

  /** 某用户显式设过的项(未设过的不出现)。 */
  get(userKey: string): UserPrefs {
    const raw = this.prefs[userKey] ?? {};
    const out: Record<string, unknown> = {};
    for (const key of USER_SETTING_KEYS) {
      if (raw[key] !== undefined) out[key] = raw[key];
    }
    return out as UserPrefs;
  }

  /** 该用户当前生效的配置:用户覆盖 → 全局默认。**永不抛错。** */
  effective(userKey: string): EffectiveUserPrefs {
    const globals = this.defaults();
    const ctx: SettingContext = { modelAllowlist: globals.modelAllowlist };
    const raw = this.prefs[userKey] ?? {};
    const pick = <K extends UserSettingKey>(key: K): Settings[K] =>
      resolveSetting(key, ctx, userKey, [raw[key], globals[key]]);

    return {
      model: pick("model"),
      ackEnabled: pick("ackEnabled"),
      progressEnabled: pick("progressEnabled"),
      maxReplyChars: pick("maxReplyChars"),
      sessionTimeoutMs: pick("sessionTimeoutMs"),
    };
  }

  /** 写入覆盖。值为 null 表示清除该项。任何一项非法都整体抛错、不落盘。 */
  set(userKey: string, patch: UserPrefsPatch): EffectiveUserPrefs {
    const keys = Object.keys(patch) as UserSettingKey[];
    for (const key of keys) {
      if (!USER_SETTING_KEYS.includes(key)) {
        throw new Error(`${key} 不是可自助修改的配置项`);
      }
    }
    const ctx: SettingContext = { modelAllowlist: this.defaults().modelAllowlist };
    const next = { ...(this.prefs[userKey] ?? {}) };
    for (const key of keys) {
      const raw = patch[key];
      if (raw === null) {
        delete next[key];
        continue;
      }
      const def = SETTING_SCHEMA[key] as SettingDef<unknown>;
      next[key] = def.validate(raw, ctx);
    }

    if (Object.keys(next).length) this.prefs[userKey] = next;
    else delete this.prefs[userKey];
    writeJsonFileAtomic(this.path, this.prefs);
    return this.effective(userKey);
  }

  /** 清掉某用户的全部覆盖(管理员的恢复通道)。 */
  clear(userKey: string): EffectiveUserPrefs {
    delete this.prefs[userKey];
    writeJsonFileAtomic(this.path, this.prefs);
    return this.effective(userKey);
  }

  /** 全部用户的覆盖项快照(dashboard 用)。 */
  snapshot(): Record<string, UserPrefs> {
    const out: Record<string, UserPrefs> = {};
    for (const userKey of Object.keys(this.prefs)) out[userKey] = this.get(userKey);
    return out;
  }
}
