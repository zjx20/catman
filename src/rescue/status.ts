import { escapeHtml } from "../dashboard/ui.js";
import type { WatchdogAction } from "./watchdog.js";

/**
 * 守护人格的状态页 —— **不需要大脑就能用的控制面**。
 *
 * ## 为什么它必须无 LLM
 *
 * 「失败域诚实条款」:磁盘满、内存尽、OAuth token 过期,这三样同样会废掉救援大脑。
 * 也就是说**最需要救援的时候,大脑恰好也起不来**。所以机械层必须独立完整:
 * 这一页只读文件、只调固化的部署脚本,一个 SDK 请求都不发。
 *
 * ## 它回答什么
 *
 * 按"人在手机上盯着它时最想知道什么"排:现在跑的是哪个版本、看门狗刚才做了什么、
 * 消息有没有堵在信使里、有没有丢过东西。最后才是一排按钮。
 *
 * 渲染是纯函数,所以**转义**这条能被单测直接钉住 —— 页面上会出现来自 iLink 的
 * 备注名与来自部署报告的 detail,那些字符串不是我们写的。
 */

export interface StatusView {
  /** 主人格 / 信使各自的容器状态。 */
  readonly containers: ReadonlyArray<{
    readonly name: string;
    readonly running: boolean;
    readonly restarts: number;
  }>;
  /** current / stable / pinned 各指向哪儿。 */
  readonly pointers: Readonly<Record<string, string>>;
  /** 看门狗最近一次决策。 */
  readonly lastAction?: { readonly at: string; readonly action: WatchdogAction };
  /** 信使各人格队列的深度 —— **排水的第二个真相源**。 */
  readonly depths: Readonly<Record<string, number>>;
  /** 丢弃 / 读不懂 / 压根没收下的累计条数。非零就该显眼。 */
  readonly losses: Readonly<Record<string, { dropped: number; nacked: number }>>;
  readonly lost: number;
  /** 上次部署结果的一句话。 */
  readonly lastDeploy?: string;
  /** 主 /data 所在文件系统的可用 MB。读不到就缺席(不显示比显示错的强)。 */
  readonly diskFreeMb?: number;
  /**
   * OAuth token 到期的一句话(tokenStatusLine 产出)。token 过期是三大死法之一,
   * 而换发必须人在宿主跑 setup-token —— 这一行是无 LLM 侧唯一的倒计时出口。
   */
  readonly tokenLine?: string;
  /** token 那行要不要红。 */
  readonly tokenOk?: boolean;
  /** 上次冷启动点火的结果。缺席 = 从没点过火(也要显眼 —— 那说明例行演练没在跑)。 */
  readonly ignition?: { readonly ranAt: string; readonly ok: boolean; readonly detail: string };
  /** 日志尾巴。 */
  readonly logTail: readonly string[];
}

/**
 * 渲染状态页。
 *
 * **非零的丢失计数要在最上面、要红。** 它们平时是 0,而一旦非零就意味着"有消息
 * 没能送到人手里"——那是这套系统最不能接受的事,不该埋在页面下半部分。
 */
export function renderStatus(v: StatusView): string {
  const badge = (ok: boolean, text: string): string =>
    `<span class="${ok ? "ok" : "bad"}">${escapeHtml(text)}</span>`;

  const lossTotal =
    v.lost + Object.values(v.losses).reduce((n, l) => n + l.dropped + l.nacked, 0);

  const alarms = lossTotal
    ? `<div class="alarm">⚠️ 有 ${lossTotal} 条消息没能送到人手里:${escapeHtml(
        Object.entries(v.losses)
          .map(([p, l]) => `${p} 丢弃 ${l.dropped} / 读不懂 ${l.nacked}`)
          .join(";"),
      )};信使没收下 ${v.lost} 条</div>`
    : "";

  const containers = v.containers
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.name)}</td><td>${badge(c.running, c.running ? "运行中" : "已停止")}</td>` +
        `<td>重启 ${c.restarts} 次</td></tr>`,
    )
    .join("");

  const pointers = Object.entries(v.pointers)
    .map(([k, sha]) => `<tr><td>${escapeHtml(k)}</td><td><code>${escapeHtml(sha || "—")}</code></td></tr>`)
    .join("");

  const depths = Object.entries(v.depths)
    .map(([p, n]) => `<tr><td>${escapeHtml(p)}</td><td>${n} 条待处理</td></tr>`)
    .join("");

  const action = v.lastAction
    ? `<p>看门狗最近一次(${escapeHtml(v.lastAction.at)}):<b>${escapeHtml(
        v.lastAction.action.kind,
      )}</b> —— ${escapeHtml(v.lastAction.action.why)}</p>`
    : "<p>看门狗还没做过任何动作。</p>";

  // 机械防线三行:磁盘 / token / 点火。它们对应的三种死法(磁盘满、token 过期、
  // 守护人格自己锈了)恰恰都是"大脑也一起废"的那种 —— 只能摆在无 LLM 的这一页上。
  const machineRows = [
    v.diskFreeMb !== undefined
      ? `<tr><td>磁盘</td><td>${badge(v.diskFreeMb >= 2048, `剩 ${v.diskFreeMb}MB`)}</td></tr>`
      : "",
    v.tokenLine !== undefined
      ? `<tr><td>订阅凭据</td><td>${badge(v.tokenOk ?? true, v.tokenLine)}</td></tr>`
      : "",
    v.ignition
      ? `<tr><td>每周点火</td><td>${badge(
          v.ignition.ok,
          `${v.ignition.ranAt} ${v.ignition.ok ? "通过" : "失败"}:${v.ignition.detail}`,
        )}</td></tr>`
      : `<tr><td>每周点火</td><td>${badge(false, "还没跑过 —— 冷启动这条路没被验过")}</td></tr>`,
  ].join("");

  return `<h1>catman 守护人格</h1>
${alarms}
<p>这一页**不需要大脑**:只读文件、只调固化的部署脚本。磁盘满或 token 过期时,
救援大脑同样起不来,而这一页还在。</p>
${action}
${v.lastDeploy ? `<p>上次部署:${escapeHtml(v.lastDeploy)}</p>` : ""}
<h2>机械防线</h2><table>${machineRows}</table>
<h2>容器</h2><table>${containers}</table>
<h2>版本指针</h2><table>${pointers}</table>
<h2>信使队列</h2><table>${depths}</table>
<h2>操作</h2>
<form method="post" action="/act/restart-primary"><button>重启主人格</button></form>
<form method="post" action="/act/demote"><button>把 current 退回上一级</button></form>
<p class="note">「退回上一级」走的是固化的 deployer,**只动 current,绝不动 stable**。</p>
<h2>日志尾巴</h2>
<pre>${escapeHtml(v.logTail.join("\n"))}</pre>`;
}
