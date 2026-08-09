import { canonicalOf } from "../core/commands.js";
import type { PersonaId } from "../ipc/protocol.js";

/**
 * 目标人格不可达时,由信使自己回的那句话。
 *
 * ## 为什么它必须"路由感知"
 *
 * 兜底文案最容易犯的错是**劝用户切到他已经在的那个人格**:他发 `/救援` 切过去了,
 * 守护人格也没起来,这时候再回一句"管理员可以发 /救援" —— 用户照做,什么也没发生,
 * 而他会认为是自己操作错了。评审专门点了这一条。
 *
 * 所以文案按**当前路由**分岔:
 *   - 路由在 primary:主人格没响应 → 告诉管理员可以召唤守护人格,那是真出口。
 *   - 路由在 rescue:守护人格也没响应 → **不再提任何切换**,这时候真正的出口是
 *     内网状态页或 SSH。如实说,别给一个按了没用的建议。
 *
 * ## 它是 fallback 类,受预算保留规则约束
 *
 * 走的是保留额而不是进度额度(见 reply-store):人格不可达的时候,那句解释是用户能
 * 拿到的**唯一**信息,不能被之前的进度消息挤掉。
 */

export interface FallbackContext {
  /** 这个用户当前归谁。 */
  readonly persona: PersonaId;
  /** 他是不是管理员 —— `/救援` 是 adminOnly,对普通用户提它等于给一个用不了的建议。 */
  readonly isAdmin: boolean;
  /** 守护人格的状态页地址,已知时给出。 */
  readonly rescueStatusUrl?: string;
}

export function fallbackText(ctx: FallbackContext): string {
  if (ctx.persona === "rescue") {
    // 已经在守护人格了还不可达 —— 两个人格都没起来,这是最坏的一档。
    const lines = [
      "守护人格现在也没有响应 —— 这说明两边都没起来,不是你的操作有问题。",
      "我(信使)还活着,你的消息我收着了,等它起来会送过去。",
    ];
    if (ctx.rescueStatusUrl) {
      lines.push(`内网能连的话,状态页在 ${ctx.rescueStatusUrl},那上面不需要大脑也能重启和回退。`);
    } else {
      lines.push("要马上处理的话,只能回内网开状态页或者 SSH 上机了。");
    }
    return lines.join("\n");
  }

  const lines = [
    "主人格现在没有响应。你的消息我收着了,它起来之后会照顺序送过去。",
  ];
  if (ctx.isAdmin) {
    lines.push(
      `等不了的话发「${canonicalOf("rescue")}」切到守护人格 —— ` +
        "它跑的是钉住的稳定版本,能看日志、能回退版本。",
    );
  }
  return lines.join("\n");
}
