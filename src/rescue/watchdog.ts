/**
 * 机械看门狗的**决策**。
 *
 * ## 为什么是纯函数
 *
 * 它是这套系统里最危险的自动动作:它会把 `current` 指针拨回去,也就是在没有人的
 * 情况下换掉线上版本。一个判错的看门狗比没有看门狗糟得多 —— 它会在系统健康时
 * 反复回退,把一次小抖动放大成"版本一直在变"。
 *
 * 所以决策与执行分开:这里只根据一组**观测**给出一个**动作**,不碰 docker、不碰
 * 文件系统、不看时钟(时刻由调用方注入)。于是每一条规则都能用表驱动的用例逐条钉死。
 *
 * ## 三条不能动的纪律
 *
 * ① **锁在就只观测。** deployer 正在部署时,容器本来就会被停、被换、被重启 ——
 *    看门狗把那些当故障就会与它对着干(双头决策互踩是评审确认的死法)。
 *    锁有心跳,超时才算它死了。
 * ② **绝不动 stable。** 它只把 `current` 往回拨。`stable` 只许 deployer 在观察期
 *    结束后前移 —— 指针单主。看门狗写 stable 等于把"回退目标"这个概念本身毁掉。
 * ③ **每一级只退一次。** 退到上一级还崩,再退下一级;而不是对同一级反复重试。
 *    反复重试在日志上看起来像"一直在恢复",实际是一直没恢复。
 */

/** 看门狗看到的一切。全部由调用方从 docker / 文件系统读出来。 */
export interface WatchdogObservation {
  /** 主人格容器。 */
  readonly primary: ContainerState;
  /** 信使容器。 */
  readonly courier: ContainerState;
  /**
   * 部署锁的心跳时刻(ms)。没有锁则 undefined。
   * 锁还活着 = deployer 正在干活,看门狗只观测。
   */
  readonly lockHeartbeatAt?: number;
  /** `current` 与 `stable` 指向同一个 release 吗。 */
  readonly currentIsStable: boolean;
  /** 已验证清单里,比当前更旧、还能退的级数。 */
  readonly remainingHistory: number;
  /** 本轮之前已经自动退过几级。**每一级只退一次**靠它。 */
  readonly demotedSteps: number;
}

export interface ContainerState {
  readonly running: boolean;
  /** docker 的 RestartCount。 */
  readonly restarts: number;
  /** 这个状态是从什么时候开始的(ms)。 */
  readonly since: number;
}

export type WatchdogAction =
  /** 什么都不做。 */
  | { readonly kind: "none"; readonly why: string }
  /** 只报警,不动手(拿不准或没有可退的了)。 */
  | { readonly kind: "alert"; readonly why: string }
  /** 把 current 往回拨一级。step 从 1 开始。 */
  | { readonly kind: "demote"; readonly step: number; readonly why: string }
  /** 把信使切到 pinned-prev。 */
  | { readonly kind: "courier-fallback"; readonly why: string };

export interface WatchdogThresholds {
  /** 多少次重启算 crash-loop。 */
  crashLoopRestarts: number;
  /** 锁静默多久算 deployer 已经死了。要大于观察期上限。 */
  lockStaleMs: number;
  /** "干净地停着"多久算异常。 */
  cleanStoppedMs: number;
}

export const DEFAULT_THRESHOLDS: WatchdogThresholds = {
  crashLoopRestarts: 3,
  // 45 分钟 > 30 分钟的观察期上限。小于它的话,一次正常的长观察期会被当成
  // "deployer 死了",于是看门狗在部署**成功的中途**把版本拨回去。
  lockStaleMs: 45 * 60_000,
  cleanStoppedMs: 5 * 60_000,
};

/**
 * 给出这一轮该做什么。
 *
 * 顺序有意义:先判"该不该动手",再判"动谁"。信使排在主人格前面 —— 它死了两个人格
 * 一起聋,而主人格死了至少还有守护人格能接。
 */
export function decide(
  obs: WatchdogObservation,
  now: number,
  th: WatchdogThresholds = DEFAULT_THRESHOLDS,
): WatchdogAction {
  // ① 锁还活着 = deployer 正在干活。它会停容器、换链接、再起 —— 那些在看门狗眼里
  //    与故障完全同形。这时候动手就是双头决策互踩。
  if (obs.lockHeartbeatAt !== undefined && now - obs.lockHeartbeatAt < th.lockStaleMs) {
    return { kind: "none", why: "部署锁还活着,deployer 正在干活,只观测" };
  }

  // ② 信使优先:它死了两个人格一起聋。
  if (isCrashLooping(obs.courier, th)) {
    return {
      kind: "courier-fallback",
      why: `信使重启了 ${obs.courier.restarts} 次 —— 稳定面自己崩了,切到 pinned-prev`,
    };
  }

  const primaryBad = classifyPrimary(obs.primary, now, th);
  if (!primaryBad) return { kind: "none", why: "主人格看起来正常" };

  // ③ 已经在 stable 上还崩 —— 说明问题不在"刚换的那个版本"。
  //    这时候再退是往更老的已验证版本上退,只在还有余量时做。
  if (obs.currentIsStable && obs.remainingHistory <= obs.demotedSteps) {
    return {
      kind: "alert",
      why: `${primaryBad},但已经退到没有更旧的已验证版本了 —— 多半是环境问题,需要人`,
    };
  }
  if (!obs.currentIsStable && obs.demotedSteps > 0) {
    // current≠stable 且已经退过 —— 那一步没救回来。再退一级(下面的 step 会递增)。
  }
  if (obs.remainingHistory <= obs.demotedSteps) {
    return { kind: "alert", why: `${primaryBad},且没有可退的版本了` };
  }
  return {
    kind: "demote",
    step: obs.demotedSteps + 1,
    why: `${primaryBad},往回退第 ${obs.demotedSteps + 1} 级`,
  };
}

function isCrashLooping(c: ContainerState, th: WatchdogThresholds): boolean {
  return c.restarts >= th.crashLoopRestarts;
}

/**
 * 主人格是不是坏了,坏在哪。返回空串表示正常。
 *
 * 「干净地停着」单独成一条:deployer 死在 `docker stop` 与 `docker start` 之间时,
 * 容器是**正常退出**的 —— 重启计数不涨、也没有 crash-loop,而没有人会再来拉起它。
 * 那是全灭里最安静的一种,只看 crash-loop 的话它永远不会被发现。
 */
function classifyPrimary(c: ContainerState, now: number, th: WatchdogThresholds): string {
  if (isCrashLooping(c, th)) return `主人格重启了 ${c.restarts} 次`;
  if (!c.running && now - c.since >= th.cleanStoppedMs) {
    return `主人格干净地停着已经 ${Math.round((now - c.since) / 60_000)} 分钟,没人拉它`;
  }
  return "";
}
