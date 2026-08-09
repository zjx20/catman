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

/** Node 里默认写 stdout 的那几档(`warn`/`error` 本来就走 stderr)。 */
const STDOUT_LEVELS = ["log", "info", "debug"] as const;

/**
 * 把默认走 stdout 的那几档 console 整体改道到 stderr。
 *
 * **给 stdout 当结果通道的进程用。** 自检模式(`CATMAN_SELFCHECK=1`)就是这样:
 * 它的 stdout 只该有一行 JSON,deployer 靠解析那一行判定这份 release 能不能上线。
 * 而装配与那一次真实请求会经 console 打不少日志 —— agent-trace 的 always 级别
 * 不受开关约束,SDK 自己也打 —— 其中 `console.log/info/debug` 在 Node 里默认就是
 * stdout。**只要漏一行进去,deployer 读到的就不是 JSON**,于是每一次部署都以
 * 「自检没过」告终,而那份 release 完全是好的:一个把好版本判死的门,比没有门更糟。
 *
 * 改道而不是静音:诊断信息一条不少地进 stderr(deployer 的容器日志收的就是它),
 * 只是不再污染那条唯一的结果通道。与 `installLogStamps` 可任意先后 —— 时间戳由
 * `error` 那一档统一加,不会叠成两个。
 */
export function redirectConsoleToStderr(
  target: Record<string, unknown> = console as unknown as Record<string, unknown>,
): void {
  const toStderr = target["error"];
  if (typeof toStderr !== "function") return;
  const bound = (toStderr as (...a: unknown[]) => void).bind(target);
  for (const level of STDOUT_LEVELS) {
    target[level] = (...args: unknown[]) => bound(...args);
  }
}
