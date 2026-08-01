/**
 * 给所有 console 输出加时间戳前缀。
 *
 * **为什么是包裹 console,而不是换一个自己的 logger**:日志的价值在**对账** ——
 * 一条 `sendmessage` 失败要能和它前面的入站 TRACE、后面的网关报错对上时刻,
 * 才看得出"这中间过了多久"。只要有一处没带前缀,那一行就成了时间轴上的断点。
 * 全项目几十处 console 调用,还有 SDK 与依赖自己打的,只有在这一层包一次
 * 才能保证无遗漏;换 logger 则要求每个调用点都记得改,漏一处就前功尽弃。
 *
 * 时区跟随进程的 `TZ` 环境变量(容器里由 compose 注入,不设则是 UTC)。
 */

/** 被包过的 console 打上这个标记,重复调用 install 不会叠出两个时间戳。 */
const INSTALLED = Symbol.for("catman.logStamp.installed");

/** 会被加前缀的方法。`debug` 也算 —— 排查时它和 info 一样要对时刻。 */
const LEVELS = ["log", "info", "warn", "error", "debug"] as const;

/**
 * 格式化成 `MM-DD HH:mm:ss.SSS`。
 *
 * 带月日是因为容器长跑数周,翻旧日志时"几点"不足以定位是哪一天;
 * 不带年份与时区偏移则是为了让行首短一些,毕竟每一行都要付这个成本。
 */
export function formatStamp(d: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/**
 * 就地包裹 console 的输出方法。启动时调一次即可,重复调用无副作用。
 * `target` / `now` 可注入,便于单测。
 */
export function installLogStamps(
  target: Record<string, unknown> = console as unknown as Record<string, unknown>,
  now: () => Date = () => new Date(),
): void {
  if (target[INSTALLED as unknown as string]) return;
  for (const level of LEVELS) {
    const orig = target[level];
    if (typeof orig !== "function") continue;
    const bound = (orig as (...a: unknown[]) => void).bind(target);
    target[level] = (...args: unknown[]) => bound(formatStamp(now()), ...args);
  }
  target[INSTALLED as unknown as string] = true;
}
