import type { GatewayHealth } from "../core/gateway.js";
import type { ChannelHealth } from "../channels/types.js";
import type { VersionInfo } from "../core/version.js";

/**
 * `GET /health` —— 部署流水线唯一的机器可读观测点。
 *
 * ## 三个消费者,三种用法
 *
 * **① 健康门**:切换之后确认新版本真的起来了。判据只取**本地可判定**的事实
 * (进程活着、渠道起来了、`version.sha` 与刚切过去的那份一致),绝不含大脑状态 ——
 * 把上游可用性放进部署门,一次二十分钟的限流就能废掉一个完好的版本。
 *
 * **② 排水门**:切换之前确认没有话卡在半路。三个计数必须同时归零,
 * 见 `GatewayHealth` 的说明。
 *
 * **③ 版本确证**:`docker start` 返回成功不等于跑的是你切的那份(比如看门狗
 * 抢先用旧 current 拉起过容器)。健康门比对 sha,才谈得上"验的是新版本"。
 *
 * ## 两条纪律
 *
 * **不鉴权,因此不能含敏感内容。** 它必须在 admin 读闸门之前分发(与 `/api/me`
 * 同理),否则 deployer 拿不到;所以这里只出标量与版本号 —— 没有 userKey、
 * 没有会话 id、没有账号信息。
 *
 * **`schema` 只增不改。** 读它的 deployer 与守护人格跑的是人工钦定的旧版本,
 * 可能比正在服务的这份旧几十个版本。字段语义变更 = 破坏性变更 = Tier 3,
 * 要连同那些消费者一起更新。golden 测试钉着这份形状。
 */

/** 契约版本。字段只增不改;真要改语义就升它,并同步更新全部消费者。 */
export const HEALTH_SCHEMA = 1;

export interface HealthPayload {
  readonly schema: number;
  /** 这份 release 的版本戳;开发模式下直接跑源码时为 null。 */
  readonly version: { sha: string; preparedAt: string; branch?: string } | null;
  /** 装配跑完、渠道已启动。为 false 说明进程起来了但还没就绪。 */
  readonly bootOk: boolean;
  /** 各渠道自述;`live` 与 `started` 的区别见 ChannelHealth。 */
  readonly channels: readonly ChannelHealth[];
  readonly inFlight: { foreground: number; background: number };
  readonly queued: number;
  readonly aggregating: number;
  /** 最近一个回合的结果(观测位,健康门不看)。 */
  readonly lastTurn: { at: number; isError: boolean } | null;
  /** 进程已运行毫秒数 —— crash-loop 时这个数一直很小,是最直接的证据。 */
  readonly uptimeMs: number;
}

export interface HealthDeps {
  readonly version: VersionInfo | undefined;
  readonly bootOk: () => boolean;
  readonly channels: () => readonly ChannelHealth[];
  readonly gateway: () => GatewayHealth;
  readonly startedAt: number;
  readonly now?: () => number;
}

export function isHealthPath(path: string): boolean {
  return path === "/health";
}

/** 组装那份 JSON。纯函数,单测直接喂假依赖,不必起 server。 */
export function buildHealth(deps: HealthDeps): HealthPayload {
  const g = deps.gateway();
  const now = (deps.now ?? Date.now)();
  return {
    schema: HEALTH_SCHEMA,
    version: deps.version
      ? {
          sha: deps.version.sha,
          preparedAt: deps.version.preparedAt,
          ...(deps.version.branch ? { branch: deps.version.branch } : {}),
        }
      : null,
    bootOk: deps.bootOk(),
    channels: deps.channels(),
    inFlight: g.inFlight,
    queued: g.queued,
    aggregating: g.aggregating,
    lastTurn: g.lastTurn ?? null,
    uptimeMs: Math.max(0, now - deps.startedAt),
  };
}

/**
 * 排水是否完成:网关里一条消息都不剩。
 *
 * 后台回合**不计入** —— 它们是用户主动切走、说过"你接着跑"的长任务,可能跑几十
 * 分钟;等它们等于永远切不了。deployer 会把"切换时有 N 段后台回合被中断"写进报告,
 * 让用户知道那几段没了,而不是假装无事发生。
 */
export function isDrained(h: HealthPayload): boolean {
  return h.inFlight.foreground === 0 && h.queued === 0 && h.aggregating === 0;
}
