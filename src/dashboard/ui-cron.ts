import { escapeHtml, shell } from "./ui.js";
import { describeSchedule, formatAt } from "../core/cron/schedule.js";
import type { CronJob, CronRun, RunStatus } from "../core/cron/types.js";

/**
 * 定时任务的两个页面:列表与详情。
 *
 * 与别的页面同一个拆法:**纯函数产出 HTML**,不碰 req/res,server.ts 只做 IO 适配。
 * 于是 XSS 转义、危险标记这些能靠断言钉住,而不必起一个真 server 去点。
 *
 * ## 这里是**全站视图**
 *
 * dashboard 整站要管理员令牌才进得来,所以这两页直接列出**所有人**的任务,
 * 并标出归属。这与 `/api/me/cron` 刻意不同:那边按回合令牌定身份、谁也看不见
 * 别人的;这边是管理员在看自己这台机器上到底有什么东西在定时跑 —— 那正是
 * 「后台能看到」要回答的问题。
 */

export interface CronJobRow {
  readonly job: CronJob;
  /** 归属用户的展示名。 */
  readonly owner: string;
  /** 最近一次执行(没有则 undefined)。 */
  readonly last?: CronRun;
}

export interface CronListPageData {
  readonly rows: readonly CronJobRow[];
  readonly tz: string;
  /** 全局开关关掉时页面要说清楚 —— 否则"为什么都不跑"要查很久。 */
  readonly enabled: boolean;
  /** 页面上的写操作(启停、试跑)要带这个头。 */
  readonly token: string;
}

export interface CronDetailPageData {
  readonly row: CronJobRow;
  readonly runs: readonly CronRun[];
  readonly tz: string;
  readonly token: string;
}

const STATUS_TEXT: Record<RunStatus, string> = {
  running: "跑着",
  ok: "成功",
  failed: "失败",
  timeout: "超时",
  skipped: "跳过",
  interrupted: "中断",
  error: "没起来",
};

function statusTag(status: RunStatus | undefined): string {
  if (!status) return `<span class="tag">还没跑过</span>`;
  const cls = status === "ok" ? "tag ok" : status === "running" || status === "skipped" ? "tag" : "tag bad";
  return `<span class="${cls}">${STATUS_TEXT[status]}</span>`;
}

function fmt(ms: number | undefined, tz: string): string {
  return ms === undefined ? "—" : formatAt(ms, tz);
}

function duration(run: CronRun): string {
  if (run.endedAt === undefined) return "—";
  const s = Math.round((run.endedAt - run.startedAt) / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** 任务体的一行摘要。脚本看命令,agent 看那句话。 */
function taskLine(job: CronJob): string {
  if (job.task.kind === "agent") {
    const head = job.task.prompt.length > 90 ? `${job.task.prompt.slice(0, 90)}…` : job.task.prompt;
    return `🧠 agent · ${escapeHtml(head.replace(/\s+/g, " "))}`;
  }
  return `⚙️ ${escapeHtml(job.task.cmd.join(" "))}`;
}

/**
 * 危险标记。管理员一眼要看见的是「这台机器上有没有哪个定时任务能碰到宿主」——
 * 而那正是出事时最先要查的东西。
 */
function dangerTags(job: CronJob): string {
  if (job.task.kind !== "script") return "";
  const tags: string[] = [];
  const rw = job.task.mounts.filter((m) => !m.ro);
  if (rw.length) {
    tags.push(`<span class="tag bad">可写挂载 ${escapeHtml(rw.map((m) => m.host).join("、"))}</span>`);
  }
  const ro = job.task.mounts.filter((m) => m.ro);
  if (ro.length) tags.push(`<span class="tag">只读挂载 ${ro.length} 条</span>`);
  if (job.task.network !== "none") tags.push(`<span class="tag bad">联网 ${job.task.network}</span>`);
  return tags.join(" ");
}

export function renderCronList(data: CronListPageData): string {
  const off = data.enabled
    ? ""
    : `<p class="meta"><b>定时任务总开关是关的</b>(cronEnabled=false):下面这些到点也不会触发,排期不丢。</p>`;

  const rows = data.rows.length
    ? data.rows
        .map((r) => {
          const j = r.job;
          const id = escapeHtml(j.id);
          const streak = j.failStreak ? `<span class="tag bad">连续失败 ${j.failStreak} 次</span>` : "";
          const enabled = j.enabled
            ? `<button class="btn warn" data-toggle="${id}" data-to="0">停用</button>`
            : `<button class="btn" data-toggle="${id}" data-to="1">启用</button>`;
          return `<div class="row">
            <b><a href="/cron/${id}">${escapeHtml(j.name)}</a></b> ${statusTag(j.lastStatus)} ${streak} ${dangerTags(j)}
            <div class="meta">${taskLine(j)}</div>
            <div class="meta">${escapeHtml(describeSchedule(j.schedule, data.tz))} · 下次 ${
              j.enabled ? fmt(j.nextAt, data.tz) : "已停用"
            } · 上次 ${fmt(j.lastRunAt, data.tz)}</div>
            <div class="meta">${escapeHtml(r.owner)} · ${id}</div>
            <p class="userops">
              ${enabled}
              <button class="btn" data-run="${id}">立即跑一次</button>
              <a class="btn" href="/cron/${id}">执行记录</a>
            </p>
          </div>`;
        })
        .join("")
    : `<p class="meta">还没有定时任务。跟助手说一句「每天早上八点看一眼磁盘」就能建一个。</p>`;

  const body = `<h3>定时任务</h3>
    <p class="meta">这台机器上**所有人**的定时任务。任务归属各自的用户,
    他们自己只看得见自己的;这一页是管理员视角。</p>
    ${off}${rows}`;

  return shell("定时任务", body, script(data.token));
}

export function renderCronDetail(data: CronDetailPageData): string {
  const j = data.row.job;
  const id = escapeHtml(j.id);
  const cfg =
    j.task.kind === "agent"
      ? `<pre>${escapeHtml(j.task.prompt)}</pre>
         <div class="meta">会话 ${j.task.session === "chain" ? "续上一次(chain)" : "每次干净起步(fresh)"} · 最多 ${j.task.maxTurns} 轮 · 模型 ${escapeHtml(j.task.model ?? "(跟用户偏好)")}</div>`
      : `<pre>${escapeHtml(j.task.cmd.join(" "))}</pre>
         <div class="meta">镜像 ${escapeHtml(j.task.image)} · 网络 ${escapeHtml(j.task.network)} · ${escapeHtml(
           j.task.limits.memory,
         )} / ${j.task.limits.cpus} 核 / ${j.task.limits.pids} pid</div>
         ${
           j.task.mounts.length
             ? `<div class="meta">挂载 ${j.task.mounts
                 .map((m) => escapeHtml(`${m.host} → ${m.at}${m.ro ? "(只读)" : "(可写)"}`))
                 .join("、")}</div>`
             : ""
         }`;

  const runs = data.runs.length
    ? data.runs
        .map((run) => {
          const note = run.note ? `<div class="meta">${escapeHtml(run.note)}</div>` : "";
          const code = run.exitCode === undefined ? "" : ` · 退出码 ${run.exitCode}`;
          const size = run.logBytes ? ` · 输出 ${run.logBytes} B` : "";
          return `<details class="blk${run.status === "ok" ? "" : " bad"}">
            <summary><span class="blabel">${statusTag(run.status)} ${fmt(run.startedAt, data.tz)}</span>
            <span class="bsum">${duration(run)}${code}${size} · ${escapeHtml(run.trigger)}</span></summary>
            <pre data-log="${escapeHtml(run.id)}">点开加载…</pre></details>${note}`;
        })
        .join("")
    : `<p class="meta">还没有执行记录。</p>`;

  const body = `<p><a href="/cron">← 返回任务列表</a></p>
    <h3>${escapeHtml(j.name)} ${statusTag(j.lastStatus)} ${dangerTags(j)}</h3>
    <div class="meta">${escapeHtml(data.row.owner)} · ${id} · ${escapeHtml(
      describeSchedule(j.schedule, data.tz),
    )} · 下次 ${j.enabled ? fmt(j.nextAt, data.tz) : "已停用"}</div>
    <div class="meta">超时 ${Math.round(j.timeoutMs / 60_000)} 分钟 · 撞车策略 ${escapeHtml(
      j.overlap,
    )} · 保留 ${j.keepRuns} 条记录 · 通知 ${notifyText(j)}</div>
    ${cfg}
    <h4 class="group">最近 ${data.runs.length} 次执行</h4>
    ${runs}`;

  return shell(j.name, body, `${script(data.token)}\n${logScript(j.id)}`);
}

function notifyText(job: CronJob): string {
  const parts: string[] = [];
  if (job.notify.start) parts.push("开跑");
  if (job.notify.end) parts.push(job.notify.onlyFailure ? "只在失败时" : "跑完");
  if (!parts.length) parts.push("不推");
  if (job.notify.quiet) parts.push(`静默 ${job.notify.quiet}`);
  return escapeHtml(parts.join(" / "));
}

/** 启停与试跑。走 /api/admin/cron,写操作只认请求头(与别处同一条 CSRF 纪律)。 */
function script(token: string): string {
  return `
const TOKEN = ${JSON.stringify(token)};
async function call(path, method, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Catman-Token': TOKEN, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || ('失败:' + res.status)); return null; }
  return data;
}
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-toggle],[data-run]');
  if (!t) return;
  if (t.dataset.toggle) {
    const r = await call('/api/admin/cron/' + t.dataset.toggle, 'PATCH', { enabled: t.dataset.to === '1' });
    if (r) location.reload();
  } else if (t.dataset.run) {
    const r = await call('/api/admin/cron/' + t.dataset.run + '/run', 'POST');
    if (r) { alert('已经起跑了,跑完在执行记录里看。'); location.reload(); }
  }
});`;
}

/** 输出按需拉取:一次执行的日志可能有几百 KB,全塞进页面会把列表拖垮。 */
function logScript(jobId: string): string {
  return `
document.addEventListener('toggle', async (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.open) return;
  const pre = d.querySelector('pre[data-log]');
  if (!pre || pre.dataset.loaded) return;
  pre.dataset.loaded = '1';
  const res = await fetch('/api/admin/cron/${jobId}/runs/' + pre.dataset.log, {
    headers: { 'X-Catman-Token': TOKEN },
  });
  const data = await res.json().catch(() => ({}));
  pre.textContent = data.log || '(没有输出)';
}, true);`;
}
