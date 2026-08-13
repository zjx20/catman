import type { Agent } from "../agent.js";
import type { PrefsStore } from "../prefs.js";
import type { GlobalSettings } from "../settings.js";
import type { UserRegistry } from "../users.js";
import type { TurnTokens } from "../turn-tokens.js";
import { buildTurnEnv } from "../turn-env.js";
import { skillsFor } from "../skills.js";
import type { Persona } from "../../config.js";
import type { AgentTask, CronJob } from "./types.js";

/**
 * agent 任务的执行面:到点让大脑去做一件需要判断的事。
 *
 * ## 与用户回合的三处刻意不同
 *
 * 1. **自己的会话。** 绝不 resume 用户正在聊的那一段 —— 共用的话,半夜一次巡检
 *    会把他第二天早上「接着昨天说」的上下文顶掉,而他完全不知道发生了什么。
 *    `chain` 模式续的是**这个任务自己**上一次的会话(id 存在任务表里)。
 *
 * 2. **没有进度推送。** 用户没在等它,中途插播「🔧 Bash: df -h」只会让他莫名其妙,
 *    还要吃掉发送预算。只有结果会推,而且是按 notify 策略推。
 *
 * 3. **有硬上限。** maxTurns + 超时(由调度器 abort)。没有人盯着的回合不能没有
 *    上限 —— 它烧的是订阅额度,而症状要到月底才看得见。
 *
 * 接口做成一个小的 interface,是为了让调度器能用替身测时序而不必真的起大脑。
 */

export interface AgentTaskRequest {
  readonly job: CronJob;
  readonly task: AgentTask;
  /** 由调度器给,超时或删任务时 abort。 */
  readonly abort: AbortController;
}

export interface AgentTaskResult {
  readonly ok: boolean;
  /** 大脑最后说的话。进执行记录,也是通知里的正文。 */
  readonly text: string;
  /** 这一次用的会话 id;chain 模式下次接着它。 */
  readonly sessionId?: string;
}

export interface AgentTaskRunner {
  run(req: AgentTaskRequest): Promise<AgentTaskResult>;
}

export interface RealAgentTaskRunnerOptions {
  readonly agent: Agent;
  readonly users: UserRegistry;
  readonly prefs: PrefsStore;
  readonly settings: GlobalSettings;
  readonly turns: TurnTokens;
  readonly apiBase: string;
  readonly persona: Persona;
}

export class RealAgentTaskRunner implements AgentTaskRunner {
  constructor(private readonly opts: RealAgentTaskRunnerOptions) {}

  async run(req: AgentTaskRequest): Promise<AgentTaskResult> {
    const { job, task } = req;
    const o = this.opts;
    const cwd = o.users.ensureWorkspace(job.userKey);
    const isAdmin = o.settings.isAdmin(job.userKey);
    // 令牌与用户回合是同一套:任务里的助手照样能调 /api/me、/api/me/cron ——
    // 「每周整理一次我的定时任务」这种事因此是做得到的。用完立刻作废。
    const turn = o.turns.mint(job.userKey);
    // ⚠️ **立刻标成 detached,这一行不能省。**
    //
    // mint 会把这一轮登记进该用户的在飞名单,而名单里第一个非 detached 的就是
    // 「前台回合」—— 也就是他正在等的那一个。定时任务显然不是:不标的话,
    // 任务一跑起来,用户发的下一条消息会被判成「前台还在跑」,于是先尝试追加
    // (定时任务没有 feed,失败),再退化成**等这一轮结束**。症状就是
    // 「半夜那个巡检任务在跑,我发消息它十分钟不理我」,而日志里一切正常。
    //
    // detached 在这个代码库里的含义正是「还在跑,但没有人在等它」—— 与被
    // `/新会话` 切走的那些回合是同一种东西,所以复用它而不是新造一个概念。
    turn.ctx.detached = true;
    // 模型:任务显式指定的优先,否则跟着这个用户当前的偏好走(他把自己换成
    // sonnet 之后,定时任务也该跟着换,而不是永远钉在建任务那天的选择上)。
    const model = task.model ?? o.prefs.effective(job.userKey).model;

    try {
      const reply = await o.agent.run(task.prompt, {
        cwd,
        ...(task.session === "chain" && job.agentSessionId
          ? { resumeSessionId: job.agentSessionId }
          : {}),
        ...(model ? { model } : {}),
        env: buildTurnEnv({ apiBase: o.apiBase, sessionToken: turn.token, isAdmin }),
        skills: skillsFor(o.persona, isAdmin),
        // 用调度器给的那个:超时与「任务被删了」都从它那边掐。
        abortController: req.abort,
        maxTurns: task.maxTurns,
        logLabel: `cron:${job.id}`,
      });
      return {
        ok: !reply.isError,
        text: reply.text,
        ...(reply.sessionId ? { sessionId: reply.sessionId } : {}),
      };
    } finally {
      // **一定要作废**:令牌活着的每一秒都是一把能改这个用户配置的钥匙。
      turn.revoke();
    }
  }
}
