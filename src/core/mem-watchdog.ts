/**
 * 会话容器的内存看门狗 —— **决策**部分。
 *
 * ## 为什么盯 anon 而不是 memory.current
 *
 * 这是整件事最容易做错的一步。实测 catman 自己:`memory.current` 510MB 里
 * **274MB 是 page cache**(54%),而 page cache 是可回收的 —— 内核要内存时直接丢掉,
 * 一个字节的 OOM 风险都没有。盯 `memory.current` 的话,任何一个"只是读了几百 MB
 * 文件"的会话都会冲过 80% 触发警告甚至被杀,而调研类会话天天在读大文件。
 *
 * 2026-08-21 那次事故的特征也正好对上:`Dirty≈0`、几乎没有磁盘 IO、**纯匿名分配**。
 * 所以信号是 `memory.stat` 里的 `anon`。
 *
 * ## 为什么决策是纯函数
 *
 * 与 `rescue/watchdog.ts` 同一条理由:它会在没有人的情况下杀掉用户正在跑的回合。
 * 判错的看门狗比没有看门狗糟 —— 误杀会让人再也不敢把活交给它。所以这里只根据
 * 一组**观测**给出一个**动作**,不碰 docker、不碰文件系统、不看时钟(时刻由调用方
 * 注入),于是每一档、每一条升级路径都能逐条断言。
 *
 * ## 阶梯为什么长这样
 *
 * | 阈值 | 动作 | 能不能保住这一回合 |
 * |---|---|---|
 * | 80% | 往回合里喂一条警告(带当前在跑哪一步) | 只对**多步慢累积**有效 |
 * | 90% | 先喂消息、再杀掉最大的那个非大脑进程 | **能** —— 唯一几秒内见效又让 agent 知情的动作 |
 * | 95% | 写事故记录 → docker kill → abort | 不能,但这是终点 |
 *
 * 80% 那条警告对"一条命令自己失控"几乎无效 —— 喂进去的消息只在 turn 边界才被
 * 读到,而 agent 正卡在那条命令里。所以 90% 那一级不是可选的锦上添花,它是唯一
 * 能救回合的一级。
 *
 * 95% 之后**没有更温和的一级**:实测 SIGKILL 掉 `docker run` 客户端,容器照跑
 * (Up 3s → Up 7s),所以 abort 释放不了内存,必须真的把容器杀掉。原本设想的
 * 95%/98% 两级物理动作是同一个,合并成一级。
 */

/** 喂警告。 */
export const WARN_RATIO = 0.8;
/** 杀掉那条失控命令,试着保住回合。 */
export const KILL_PROC_RATIO = 0.9;
/** 放弃这一回合,内核动手。 */
export const KILL_CONTAINER_RATIO = 0.95;

/**
 * 杀了进程之后等多久复查。
 *
 * **这一步不是锦上添花**:被杀的可能是个孙进程,也可能杀错了对象,内存未必降下来。
 * "发出动作"不等于"内存回来了" —— 只有复查能把这两件事分开。没降就升级。
 */
export const VERIFY_GRACE_MS = 3_000;

export interface MemObservation {
  /** `memory.stat` 里的 anon,字节。 */
  readonly anonBytes: number;
  /** 容器的 `memory.max`,字节。读不到(未设上限)时给 0,看门狗一律放行。 */
  readonly limitBytes: number;
  /**
   * 本回合内 `memory.events` 的 oom_kill 增量。
   *
   * >0 说明**内核的 cgroup OOM killer 抢在我们前面动手了** —— 分配够快的话,
   * 两次采样之间就能从 90% 冲过上限。它杀掉的可能是失控进程,也可能正好是大脑
   * 本身,容器状态从此不可信。**不要试图抢救**,直接按事故收场。
   */
  readonly kernelOomKills: number;
  /** 80% 那条警告已经喂过了吗。喂第二遍只会占上下文,不会更有用。 */
  readonly warned: boolean;
  /** 90% 那一级已经动过手了吗。 */
  readonly procKilled: boolean;
  /** 距离上次杀进程多久(ms)。`procKilled` 为假时无意义。 */
  readonly msSinceProcKill: number;
}

export type MemAction =
  | { readonly kind: "none" }
  | { readonly kind: "warn"; readonly ratio: number }
  | { readonly kind: "kill-process"; readonly ratio: number }
  | {
      readonly kind: "kill-container";
      readonly ratio: number;
      /**
       * - `threshold` 越过 95%
       * - `kernel-oom` 内核先动手,容器状态已不可信
       * - `no-relief` 杀过进程但内存没降下来 —— 说明杀错了或没杀干净
       */
      readonly reason: "threshold" | "kernel-oom" | "no-relief";
    };

/**
 * 一组观测 → 这一刻该做什么。
 *
 * 顺序即优先级:内核先动手 > 越过 95% > 90% 那一级(含复查升级) > 80% 警告。
 */
export function decideMemAction(obs: MemObservation): MemAction {
  // 没设上限就没有"百分之几"可言 —— 一律放行,而不是拿 0 去除。
  if (obs.limitBytes <= 0) return { kind: "none" };

  const ratio = obs.anonBytes / obs.limitBytes;

  if (obs.kernelOomKills > 0) return { kind: "kill-container", ratio, reason: "kernel-oom" };
  if (ratio >= KILL_CONTAINER_RATIO) return { kind: "kill-container", ratio, reason: "threshold" };

  if (ratio >= KILL_PROC_RATIO) {
    if (!obs.procKilled) return { kind: "kill-process", ratio };
    // 杀过了,给它一点时间把内存还回来;过了宽限期还在 90% 以上,
    // 说明那一刀没解决问题,升级到有保证的那一级。
    if (obs.msSinceProcKill >= VERIFY_GRACE_MS) {
      return { kind: "kill-container", ratio, reason: "no-relief" };
    }
    return { kind: "none" };
  }

  if (ratio >= WARN_RATIO && !obs.warned) return { kind: "warn", ratio };
  return { kind: "none" };
}

/**
 * 从 `memory.stat` 的内容里取 anon。
 *
 * 单独拎出来是因为它有个安静的失败模式:字段名写错、或者内核换了字段,
 * 返回 0 会让看门狗**永远不开火**而且毫无症状。所以取不到时返回 undefined,
 * 由调用方显式当成"这一轮没观测到",而不是当成"用了 0 字节"。
 */
export function parseAnonBytes(memoryStat: string): number | undefined {
  for (const line of memoryStat.split("\n")) {
    if (line.startsWith("anon ")) {
      const n = Number(line.slice(5).trim());
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

/** 从 `memory.events` 里取 oom_kill 累计值。取不到按 0 算 —— 这个方向宁可漏报。 */
export function parseOomKills(memoryEvents: string): number {
  for (const line of memoryEvents.split("\n")) {
    if (line.startsWith("oom_kill ")) {
      const n = Number(line.slice(9).trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

/** 喂给大脑的那条警告。带上它正在跑哪一步 —— 否则它只知道"内存紧张",不知道是谁干的。 */
export function warnText(ratio: number, limit: string, step: string | undefined): string {
  const pct = Math.round(ratio * 100);
  const what = step ? `当前正在跑:${step}。` : "";
  return (
    `⚠️ 内存看门狗:这一回合的容器内存已用到上限的 ${pct}%(上限 ${limit})。${what}` +
    `再涨到 90% 我会杀掉当前那条命令,95% 会中止整个回合。` +
    `请立刻换一个省内存的做法 —— 大文件走流式管道、别把几百 MB 的输出捞进内存。`
  );
}

/**
 * 90% 动手前先喂的那条。**必须在杀之前喂** —— 这样同一次 LLM 交互里,
 * 大脑既看得到这条解释、又看得到那条命令失败的结果。反过来的话工具结果先被消化,
 * 它很可能已经原样重试了一遍,才读到解释。
 *
 * 措辞用"正在杀掉"而不是"已杀掉":万一那一刀没杀成(进程刚好自己退了),
 * 说过头的话就成了假消息。
 */
export function killNoticeText(ratio: number, victim: string | undefined): string {
  const pct = Math.round(ratio * 100);
  const who = victim ? `(${victim})` : "";
  return (
    `⛔ 内存看门狗:内存已到上限的 ${pct}%,我正在杀掉当前占用最大的那个进程${who}。` +
    `它会以 137 退出 —— 那不是命令本身出错,是被杀了。**不要原样重试**,换个省内存的做法。`
  );
}

/**
 * 看门狗中止回合时,塞进 `AbortSignal.reason` 的凭据。
 *
 * 为什么要凭据而不是字符串匹配:网关那边要分辨「这次中止是谁干的」,而
 * `signal.aborted` 只是个布尔 —— 用户按了 /取消、超时、崩溃、内存看门狗动手,
 * 四种情况**措辞一模一样**(真机上就是光秃秃一句「已中断这一轮。」),
 * 而这四种用户该做的事完全不同。尤其内存那种:默认反应"再发一遍"恰恰是错的。
 */
export interface MemAbortInfo {
  readonly reason: "threshold" | "kernel-oom" | "no-relief";
  /** 中止那一刻在跑哪一步。用户最想知道的就是这个。 */
  readonly step: string | undefined;
  readonly pct: number;
  readonly limit: string;
}

const MEM_ABORT = Symbol.for("catman.memAbort");

/** 造一个带凭据的中止原因。 */
export function memAbortError(info: MemAbortInfo): Error {
  const e = new Error(`内存看门狗中止回合:${info.reason} anon=${info.pct}%`);
  (e as unknown as Record<symbol, unknown>)[MEM_ABORT] = info;
  return e;
}

/** 从 `signal.reason` 里认出凭据。不是看门狗干的就返回 undefined。 */
export function readMemAbort(reason: unknown): MemAbortInfo | undefined {
  if (!reason || typeof reason !== "object") return undefined;
  return (reason as Record<symbol, MemAbortInfo | undefined>)[MEM_ABORT];
}

/**
 * 回合非正常结束时给用户的那句话。
 *
 * **每一种都要说清「接下来怎么办」**:真机上用户看到光秃秃一句「已中断这一轮」,
 * 很可能以为整段对话废了,于是重开一个会话 —— 而那才是真的把上下文丢了。
 * 死的只是这一个回合,transcript 还在盘上,下一条消息会 resume。
 */
export function abortNoticeText(mem: MemAbortInfo | undefined): string {
  const tail = "**会话没丢**,接着说就行 —— 死的只是这一个回合,上下文还在。";
  if (!mem) return `已按你的要求中断这一轮。${tail}`;
  const where = mem.step ? `(当时在跑:${mem.step})` : "";
  if (mem.reason === "kernel-oom") {
    return (
      `⛔ 这一回合内存超了上限 ${mem.limit},内核先动手把进程杀了${where}。` +
      `直接重发大概率还会撞上,换个省内存的问法。${tail}`
    );
  }
  return (
    `⛔ 这一回合因内存超限被中止${where}:用到了上限 ${mem.limit} 的 ${mem.pct}%。` +
    `直接重发大概率还会撞上,换个省内存的问法(大文件走流式、别把大输出捞进内存)。${tail}`
  );
}

/** 80%/90% 两档给**用户**看的简短提示。跟喂给大脑的那条不同 —— 用户要的是"发生了什么"。 */
export function userNoticeText(kind: "warn" | "kill-process", pct: number, victim?: string): string {
  if (kind === "warn") {
    return `⚠️ 这一回合内存到了上限的 ${pct}%,我正在让它换个省内存的做法。回合继续。`;
  }
  return `⛔ 内存到 ${pct}%,我杀掉了那条最吃内存的命令${victim ? `(${victim})` : ""}。回合继续。`;
}

/**
 * 下一回合开头注入的前情。
 *
 * 回合被硬杀之后,transcript 末尾留下一个**悬空的 tool_use**(有调用、没结果)。
 * resume 上去的大脑看到的是一个没有下文的工具调用 —— 它不知道发生过什么,
 * 而用户往往只回一句"继续"。没有这段前情,它大概率原样再撞一次。
 *
 * 与 persona 里那段 137 预教是两回事:那个教它**认信号**(看到 137 别重试),
 * 这个告诉它**上一回合具体发生了什么**。前者是常识,后者是现场。
 */
export function priorAbortPrefix(mem: MemAbortInfo): string {
  const where = mem.step ? `,当时在跑:${mem.step}` : "";
  return (
    `(系统提示:上一回合因内存超限被中止 —— 用到了上限 ${mem.limit} 的 ${mem.pct}%${where}。` +
    `transcript 末尾那个没有结果的工具调用就是它。**同样的做法会再死一次**,换个省内存的路子。)\n\n`
  );
}
