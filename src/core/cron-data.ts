import { chmodSync, mkdirSync } from "node:fs";
import type { Config } from "../config.js";

/**
 * 确保定时任务的**跨次状态目录**存在且写得动。
 *
 * ## 为什么要有这么个目录
 *
 * 这里是**定时任务的地盘** —— 状态也好、临时文件也好,只要是定时任务的,都放这儿。
 * 从前它们没有归处,于是往 `$CATMAN_DATA_DIR/tmp/` 里放,而那边是会话里脱钩长任务
 * 的地盘,随时可以当垃圾清。
 *
 * 分界画在**归属**上而不是寿命上:定时任务无人值守,它的东西被误清了没人当场发现 ——
 * 任务照跑,只是把上次报过的又报一遍。整个任务的文件圈在一个子目录里,清理时
 * 只需要判断"这个任务还在不在",不用逐个文件猜哪份是状态、哪份是垃圾。
 *
 * ## 为什么是 0777 而不是默认权限
 *
 * `script` 类定时任务跑在独立容器里,uid 未必是 10001(镜像自己说了算),
 * 把宿主路径挂进去之后还得写得动。0777 是这里唯一不需要枚举 uid 的做法。
 *
 * ⚠️ `mkdirSync` 的 mode 会被 umask 削掉(默认 022 → 755),所以必须显式
 * `chmodSync` 一次。只写 `{ mode: 0o777 }` 是不够的 —— 那是这类代码最常见的错。
 *
 * ## 为什么失败不致命
 *
 * 与 workspace / CLAUDE_CONFIG_DIR 不同,少了这个目录只是定时任务存不了状态,
 * 而整个进程还有别的事要干。守护人格更是压根不该建它:它的 `/data` 是只读的,
 * 也没有定时任务,建不出来是**预期**而不是故障。
 */
export function ensureCronDataDir(config: Pick<Config, "cronDataDir" | "persona">): void {
  if (config.persona === "rescue") return;
  try {
    mkdirSync(config.cronDataDir, { recursive: true });
    chmodSync(config.cronDataDir, 0o777);
  } catch (err) {
    console.warn(`[cron] 建不出状态目录 ${config.cronDataDir},定时任务将存不住跨次状态:`, err);
  }
}
