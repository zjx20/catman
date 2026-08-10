import { readJsonFile } from "../core/file-store.js";
import type { AttachmentLimits } from "../core/attachments.js";

/**
 * 信使对 `settings.json` 的**只读**视图。
 *
 * ## 为什么不直接用 GlobalSettings
 *
 * 「每类状态只有一个写者」是这套架构的地基。`settings.json` 的写者是主人格
 * (管理员在 dashboard 上改),信使只是读 —— 引进那个会写盘的类,迟早有人在信使里
 * 调一次 `set()`,而那会用信使的陈旧快照整份覆写管理员刚改的配置。
 * 这个视图**没有写方法**,所以那条路不存在。
 *
 * ## 防御式到什么程度
 *
 * 读不出来一律退到内置默认。信使是稳定面,配置文件坏掉不该让它起不来 ——
 * 那会让两个人格一起聋,而起因只是一个多打的逗号。
 */

/** 与 SETTING_SCHEMA 的 floor 保持一致的内置默认。读不出配置时用它。 */
const FALLBACK: AttachmentLimits = { maxImageBytes: 3_500_000, maxImagesPerTurn: 4 };

/** 配置的缓存时长。每条消息读一次文件太浪费,而配置改动晚几秒生效无所谓。 */
const CACHE_MS = 5000;

interface Shape {
  maxImageBytes?: unknown;
  maxImagesPerTurn?: unknown;
  adminUserKeys?: unknown;
}

export class SettingsView {
  private cached?: { at: number; limits: AttachmentLimits; admins: readonly string[] };

  constructor(
    private readonly path: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  limits(): AttachmentLimits {
    return this.read().limits;
  }

  /**
   * 这个人是不是管理员。
   *
   * 信使要用它挡 `/救援` `/主人格`(adminOnly)。**内置 dashboard 管理员不在这份
   * 名单里**,但那个 userKey 走的是 dashboard 渠道、根本不经过信使,所以这里不必
   * 也不该复制那条例外。
   */
  isAdmin(userKey: string): boolean {
    return this.read().admins.includes(userKey);
  }

  private read(): { limits: AttachmentLimits; admins: readonly string[] } {
    const now = this.now();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached;
    const raw = readJsonFile<Shape>(this.path, {});
    const num = (v: unknown, fallback: number): number =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
    const admins = Array.isArray(raw.adminUserKeys)
      ? raw.adminUserKeys.filter((x): x is string => typeof x === "string" && !!x)
      : [];
    const value = {
      at: now,
      limits: {
        maxImageBytes: num(raw.maxImageBytes, FALLBACK.maxImageBytes),
        maxImagesPerTurn: num(raw.maxImagesPerTurn, FALLBACK.maxImagesPerTurn),
      },
      admins,
    };
    this.cached = value;
    return value;
  }
}
