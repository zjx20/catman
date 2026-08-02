import type { SessionSummary, TranscriptEntry } from "../core/transcript.js";
import type { PublicAccount } from "../core/accounts.js";
import type { UserRecord } from "../core/users.js";
import type { ChatMessage } from "../channels/dashboard.js";
import { canonicalOf } from "../core/commands.js";
import { BUILTIN_ADMIN_USER_KEY } from "../core/identity.js";

/**
 * 极简服务端渲染。单文件内联样式,无外部资源,内网直接看。
 * 所有用户内容都经 escapeHtml 转义,避免会话文本注入页面。
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 放进 <script> 里的字面量。除 HTML 转义外还要挡住 </script> 提前闭合。 */
function jsString(s: string): string {
  return JSON.stringify(s).replace(/</g, "\\u003c");
}

/** 同上,但用于对象/数组:直接生成 JS 字面量,不必在页面里再 JSON.parse。 */
function jsJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

/** 时间戳转本地时间。0/缺失显示为破折号,免得渲染出 1970。 */
function fmtTime(ms: number | undefined): string {
  return ms ? new Date(ms).toLocaleString("zh-CN") : "—";
}

const STYLE = `
  body{font:14px/1.6 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#222}
  header{background:#1f2937;color:#fff;padding:12px 20px;font-weight:600;
    display:flex;justify-content:space-between;align-items:center;gap:12px}
  header a{color:#c7d2fe;font-weight:400;margin-left:14px}
  main{max-width:900px;margin:0 auto;padding:20px}
  a{color:#2563eb;text-decoration:none}
  .row{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;margin:8px 0}
  .meta{color:#6b7280;font-size:12px}
  .search{margin:12px 0}
  .search input{padding:8px 10px;width:70%;border:1px solid #d1d5db;border-radius:6px}
  .search button,.btn{padding:8px 14px;border:0;background:#2563eb;color:#fff;border-radius:6px;cursor:pointer;font-size:13px}
  .btn.warn{background:#b45309}
  .btn.danger{background:#b91c1c}
  .btn:disabled{background:#9ca3af;cursor:default}
  .msg{border-radius:8px;padding:10px 12px;margin:8px 0;white-space:pre-wrap;word-break:break-word}
  .user{background:#eef2ff;border:1px solid #c7d2fe}
  .assistant{background:#fff;border:1px solid #e5e7eb}
  .result{background:#ecfdf5;border:1px solid #a7f3d0}
  .system,.other{background:#f3f4f6;border:1px solid #e5e7eb;color:#6b7280}
  .role{font-size:11px;text-transform:uppercase;color:#6b7280;margin-bottom:2px}
  h4.group{margin:22px 0 6px;font-size:13px;color:#374151;border-bottom:1px solid #e5e7eb;padding-bottom:4px}
  .tag{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:4px;padding:0 6px;font-size:11px;margin-left:6px}
  .tag.bad{background:#fee2e2;color:#991b1b}
  .tag.ok{background:#dcfce7;color:#166534}
  .qr img{width:220px;height:220px;image-rendering:pixelated;background:#fff;border:1px solid #e5e7eb}
  code{background:#f3f4f6;padding:1px 5px;border-radius:4px;word-break:break-all}
  #log{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;
    height:60vh;overflow-y:auto}
  #log .msg{margin:6px 0}
  .bot{background:#fff;border:1px solid #e5e7eb}
  .compose{display:flex;gap:8px;margin-top:10px}
  .chatbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:12px 0 8px}
  .userops{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0 0}
  .userops input{padding:7px 9px;border:1px solid #d1d5db;border-radius:6px;min-width:160px}
  .compose textarea{flex:1;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;
    font:inherit;resize:vertical;min-height:44px}
`;

function shell(title: string, inner: string, script = ""): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><header><span>catman</span><span><a href="/">会话记录</a><a href="/chat">聊天</a><a href="/users">用户</a><a href="/accounts">账号</a></span></header>
<main>${inner}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

// --- 会话列表 / 详情 ---

export interface ListPageData {
  sessions: SessionSummary[];
  /** userKey → 注册信息,用来把会话按人分组展示。 */
  users: Record<string, UserRecord>;
}

export interface SessionPageData {
  sessionId: string;
  entries: TranscriptEntry[];
}

export interface AccountsPageData {
  accounts: PublicAccount[];
  /** 注入页面供写操作带上 X-Catman-Token 头。 */
  token: string;
}

export interface ChatPageData {
  history: ChatMessage[];
  /** 注入页面供发消息带上 X-Catman-Token 头(发消息是写操作)。 */
  token: string;
  /** 首屏水位:history 已经渲染过的最大 id,页面据此订阅 SSE,避免重复推送。 */
  lastId: number;
}

/** 用户页的一行。字段来自 users.json + settings + prefs,由 server.ts 拼好。 */
export interface UserRow {
  userKey: string;
  displayName: string;
  channel: string;
  isAdmin: boolean;
  /** 生效模型。undefined = 不传,交给 SDK 默认(兜底链的末端)。 */
  model: string | undefined;
  workspace: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface UsersPageData {
  users: UserRow[];
  /** 注入页面供写操作带上 X-Catman-Token 头。 */
  token: string;
}

export function renderPage(kind: "list", data: ListPageData): string;
export function renderPage(kind: "session", data: SessionPageData): string;
export function renderPage(kind: "accounts", data: AccountsPageData): string;
export function renderPage(kind: "chat", data: ChatPageData): string;
export function renderPage(kind: "users", data: UsersPageData): string;
export function renderPage(
  kind: "list" | "session" | "accounts" | "chat" | "users",
  data: ListPageData | SessionPageData | AccountsPageData | ChatPageData | UsersPageData,
): string {
  if (kind === "list") return renderList(data as ListPageData);
  if (kind === "accounts") return renderAccounts(data as AccountsPageData);
  if (kind === "chat") return renderChat(data as ChatPageData);
  if (kind === "users") return renderUsers(data as UsersPageData);
  return renderSession(data as SessionPageData);
}

function renderList({ sessions, users }: ListPageData): string {
  const search = `<form class="search" action="/api/search" method="get">
      <input name="q" placeholder="检索会话内容(返回 JSON)"><button>搜索</button></form>`;
  if (!sessions.length) {
    return shell("会话列表", `${search}<p class="meta">还没有会话记录。</p>`);
  }

  // 按用户分组:多账号下同一个页面会混着好几个人的会话,不分组读不了。
  const groups = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const key = s.userKey ?? "";
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }

  const blocks = [...groups.entries()].map(([userKey, list]) => {
    const rec = users[userKey];
    const title = rec
      ? `${escapeHtml(rec.displayName)} <span class="tag">${escapeHtml(rec.channel)}</span>`
      : escapeHtml(userKey || "(未归属)");
    const rows = list
      .map((s) => {
        const when = new Date(s.mtimeMs).toLocaleString("zh-CN");
        return `<div class="row"><a href="/session/${encodeURIComponent(s.sessionId)}?p=${encodeURIComponent(
          s.projectDir,
        )}">${escapeHtml(s.preview || s.sessionId)}</a>
        <div class="meta">${escapeHtml(s.sessionId)} · ${when} · ${s.sizeBytes} B</div></div>`;
      })
      .join("");
    return `<h4 class="group">${title}</h4>${rows}`;
  });

  return shell("会话列表", `${search}${blocks.join("")}`);
}

function renderSession({ sessionId, entries }: SessionPageData): string {
  const msgs = entries
    .map(
      (e) =>
        `<div class="msg ${e.role}"><div class="role">${e.role}${
          e.ts ? " · " + escapeHtml(e.ts) : ""
        }</div>${escapeHtml(e.text)}</div>`,
    )
    .join("");
  const body = `<p><a href="/">← 返回列表</a></p><h3>${escapeHtml(sessionId)}</h3>${
    entries.length ? msgs : `<p class="meta">空会话。</p>`
  }`;
  return shell(`会话 ${sessionId}`, body);
}

// --- 管理员聊天 ---

/**
 * 「刚结束合成」的时间窗(ms)。取值要同时满足两头:
 * 远大于浏览器把 compositionend 与 keydown 两个事件派发出来的间隔(同一次物理按键
 * 产生,通常 <2ms),又远小于人连按两次 Enter 的最短间隔(≳60ms)——
 * 于是「上屏后立刻再按一次 Enter 发送」不会被误吞。见 shouldSendOnEnter。
 */
const COMPOSITION_TAIL_MS = 30;

/**
 * 这一下 Enter 是「发送」,还是该留给输入法?
 *
 * 中文/日文输入法在候选未上屏时,Enter 的语义是确认当前输入 —— 拼音模式下打英文
 * 尤其典型:字母停在合成缓冲区里,要按 Enter 才原样上屏。此时抢走 Enter 会把
 * 半截内容发出去,而用户本来只是想把这几个字母敲定。
 *
 * 三个信号都要看,因为浏览器对「上屏那一下 Enter」的事件顺序并不一致:
 * - Chrome / Firefox:keydown 先于 compositionend,keydown 带 isComposing=true
 *   (部分实现只给出 keyCode 229);
 * - Safari:compositionend 先于 keydown,那一下 keydown 的 isComposing 已是 false、
 *   keyCode 是 13 —— 没有任何标志位可查,只能靠「紧挨着刚结束的合成」认出它。
 *
 * 时间窗比的是事件自带的 timeStamp 而不是 Date.now():前者是浏览器生成事件的时刻,
 * 主线程卡顿不会把两个事件的间隔压扁成 0。
 *
 * **函数体必须自足**(除 COMPOSITION_TAIL_MS 外不引用任何外部标识符):页面里跑的
 * 就是它 toString() 出来的这一份,引用了模块作用域的东西在浏览器里就是 ReferenceError。
 * 单测在空沙箱里求值 ENTER_GUARD_SNIPPET,正是为了守住这一点。
 */
function shouldSendOnEnter(
  e: { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number; timeStamp: number },
  state: { composing: boolean; composedAt: number },
): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  if (state.composing || e.isComposing || e.keyCode === 229) return false;
  return e.timeStamp - state.composedAt >= COMPOSITION_TAIL_MS;
}

/**
 * 内联进聊天页的判定逻辑。导出是为了让单测能把**页面里真正跑的那一份**取出来求值,
 * 而不是另测一个同名的 TS 函数 —— 两者同源,不会分叉。
 */
export const ENTER_GUARD_SNIPPET = `const COMPOSITION_TAIL_MS = ${COMPOSITION_TAIL_MS};
${shouldSendOnEnter}`;

/**
 * 管理员聊天页。回复走 SSE 实时推(能看到 💭/🔧 进度),发消息走 POST。
 *
 * 发消息是**写操作,必须带 X-Catman-Token 请求头** —— 只认 Cookie 的话,
 * 外部页面能诱导浏览器向拥有管理员权限的 agent 投喂指令。
 */
function renderChat({ history, token, lastId }: ChatPageData): string {
  const body = `<h3>聊天</h3>
    <p class="meta">这里的对话拥有<b>管理员权限</b>:可以改全局配置(可用模型、默认模型、
    并发上限、管理员名单)、代改任意用户的设置、管理账号。发 <code>/帮助</code> 看指令清单。</p>
    <div class="chatbar">
      <span class="meta">聊天记录存在服务端,刷新或重启都还在。
      「开新会话」只让助手忘掉上下文,<b>不会清空这里的记录</b>。</span>
      <button class="btn warn" id="newsession">开新会话</button>
    </div>
    <div id="log"></div>
    <div class="compose">
      <textarea id="text" placeholder="说点什么…(Enter 发送,Shift+Enter 换行)"></textarea>
      <button class="btn" id="send">发送</button>
    </div>`;

  const script = `
const TOKEN = ${jsString(token)};
// 按钮发的就是硬指令本身,语义与在微信里打字完全一致(单一真相源在 COMMAND_TABLE)。
const NEW_SESSION = ${jsString(canonicalOf("newSession"))};
const log = document.getElementById('log');
const input = document.getElementById('text');
// id → DOM 节点:既用来去重,也用来在收到撤回事件时把那条抹掉。
const nodes = new Map();

function append(m) {
  if (nodes.has(m.id)) return;
  const div = document.createElement('div');
  div.className = 'msg ' + (m.role === 'user' ? 'user' : 'bot');
  div.textContent = m.text;
  nodes.set(m.id, div);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function drop(id) {
  const div = nodes.get(id);
  if (!div) return;
  div.remove();
  nodes.delete(id);
}

for (const m of ${jsJson(history)}) append(m);

// SSE:断线由浏览器自动重连,重连时带 Last-Event-ID,服务端据此补发缺口。
// 首次连接没有 Last-Event-ID,所以把首屏水位放进 ?after= —— 否则服务端会把
// 刚刚已经渲染出来的历史再整份推一遍。
const es = new EventSource('/api/chat/stream?after=' + ${JSON.stringify(lastId)});
es.onmessage = (e) => {
  try { append(JSON.parse(e.data)); } catch (err) { /* 心跳等非 JSON 帧 */ }
};
// 撤回:网关在回合结束时抹掉"收到"回执,页面跟着删,免得记录里越积越多。
es.addEventListener('delete', (e) => {
  try { drop(JSON.parse(e.data).id); } catch (err) { /* 忽略坏帧 */ }
});

async function post(text) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'X-Catman-Token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    append({ id: -Date.now(), role: 'bot', text: '发送失败:' + (d.error || res.status) });
  }
}

function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  return post(text);
}

document.getElementById('send').onclick = send;
document.getElementById('newsession').onclick = () => {
  // 上下文丢了就找不回来,而按钮只需一次误点 —— 打字发指令没有这个风险。
  if (confirm('让助手忘掉当前对话的上下文,从新会话开始?聊天记录会保留。')) post(NEW_SESSION);
};

${ENTER_GUARD_SNIPPET}

// 输入法合成期间的 Enter 属于输入法(确认候选 / 把字母原样上屏),不是发送。
const composition = { composing: false, composedAt: -Infinity };
input.addEventListener('compositionstart', () => { composition.composing = true; });
input.addEventListener('compositionend', (e) => {
  composition.composing = false;
  composition.composedAt = e.timeStamp;
});
input.addEventListener('keydown', (e) => {
  if (!shouldSendOnEnter(e, composition)) return;
  e.preventDefault();
  send();
});
`;
  return shell("聊天", body, script);
}

// --- 用户与权限 ---

/**
 * 用户页。**提权在这里做** —— 在此之前只能在管理员聊天里说一句,
 * 或者自己去 curl `/api/settings`,没有可点的地方。
 *
 * 写操作一律走 `PATCH /api/users/<userKey>` + `X-Catman-Token` 请求头(防 CSRF)。
 * 管理员名单由服务端照当前值增删,页面不提交整份名单 —— 见 api-admin.ts 的 setAdmin。
 */
function renderUsers({ users, token }: UsersPageData): string {
  const rows = users.length
    ? users
        .map((u) => {
          const key = escapeHtml(u.userKey);
          const builtin = u.userKey === BUILTIN_ADMIN_USER_KEY;
          const tag = u.isAdmin ? `<span class="tag ok">管理员</span>` : "";
          const grant = builtin
            ? `<span class="meta">内置管理员,不可撤销(配置改坏后的恢复通道)</span>`
            : u.isAdmin
              ? `<button class="btn warn" data-admin="0" data-key="${key}">取消管理员</button>`
              : `<button class="btn" data-admin="1" data-key="${key}">设为管理员</button>`;
          return `<div class="row">
            <b>${escapeHtml(u.displayName || u.userKey)}</b> ${tag}
            <div class="meta">${key}</div>
            <div class="meta">${escapeHtml(u.channel)} · 模型 ${escapeHtml(
              u.model ?? "(未设,交给 SDK 默认)",
            )} · 目录 ${escapeHtml(u.workspace)}</div>
            <div class="meta">接入于 ${fmtTime(u.createdAt)} · 最后活跃 ${fmtTime(u.lastSeenAt)}</div>
            <p class="userops">
              <input data-name="${key}" value="${escapeHtml(u.displayName)}" placeholder="备注名">
              <button class="btn" data-rename="${key}">改名</button>
              ${grant}
              <button class="btn warn" data-clear="${key}">清空个人设置</button>
            </p>
          </div>`;
        })
        .join("")
    : `<p class="meta">还没有用户。扫码接入后,对方发来第一条消息时才会登记。</p>`;

  const body = `<h3>用户</h3>
    <p class="meta">用户在<b>发来第一条消息</b>时登记(扫码本身只建账号)。
    「设为管理员」等于把管理员令牌和 dashboard 的全部写权限交给对方 ——
    他的助手能改全局配置、代改别人的设置、增删账号。</p>
    ${rows}`;

  const script = `
const TOKEN = ${jsString(token)};

async function patch(key, body) {
  const res = await fetch('/api/users/' + encodeURIComponent(key), {
    method: 'PATCH',
    headers: { 'X-Catman-Token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    alert('操作失败:' + (d.error || res.status));
    return false;
  }
  location.reload();
  return true;
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;

  const admin = t.getAttribute('data-admin');
  if (admin !== null) {
    const key = t.getAttribute('data-key');
    // 提权是把整台机器的控制权交出去,不是"权限稍微高一点"。
    const msg = admin === '1'
      ? '把 ' + key + ' 设为管理员?他将能改全局配置、代改他人设置、增删账号。'
      : '取消 ' + key + ' 的管理员权限?';
    if (confirm(msg)) patch(key, { admin: admin === '1' });
    return;
  }

  const rename = t.getAttribute('data-rename');
  if (rename !== null) {
    const box = document.querySelector('[data-name="' + CSS.escape(rename) + '"]');
    if (box) patch(rename, { displayName: box.value });
    return;
  }

  const clear = t.getAttribute('data-clear');
  if (clear !== null) {
    if (confirm('清空 ' + clear + ' 的全部个人设置(模型、回执、进度…),回到全局默认?')) {
      patch(clear, { clear: true });
    }
  }
});
`;
  return shell("用户", body, script);
}

// --- 账号管理 ---

function renderAccounts({ accounts, token }: AccountsPageData): string {
  const rows = accounts.length
    ? accounts
        .map((a) => {
          const bound = a.boundUserId
            ? `<span class="tag ok">已绑定 ${escapeHtml(a.boundUserId)}</span>`
            : `<span class="tag">待绑定(下一条来信的发送者将成为主人)</span>`;
          const rejections = (a.rejections ?? []).length
            ? `<div class="meta">被拒来信:${a.rejections!
                .map(
                  (r) =>
                    `${escapeHtml(r.userId)} ×${r.count}(${new Date(r.lastAt).toLocaleString("zh-CN")})`,
                )
                .join("、")}</div>`
            : "";
          const id = escapeHtml(a.accountId);
          // 凭据失效是"该点重新扫码了"的唯一明确信号 —— 不显示的话表现只是"不回消息"。
          const expired = a.expiredAt
            ? `<span class="tag bad">凭据已失效(${fmtTime(a.expiredAt)}),请重新扫码</span>`
            : "";
          const pending = a.pendingRebind
            ? `<div class="meta">已换新凭据,等这个账号的主人发一条消息来认领。</div>`
            : "";
          return `<div class="row">
            <b>${escapeHtml(a.displayName)}</b> ${bound} ${expired}
            <div class="meta">${id} · ${escapeHtml(a.channel)} · 创建于 ${fmtTime(a.createdAt)}</div>
            ${pending}
            ${rejections}
            <p class="userops">
              <input data-name="${id}" value="${escapeHtml(a.displayName)}" placeholder="备注名(留空恢复默认)">
              <button class="btn" data-rename="${id}">改备注名</button>
              <button class="btn" data-rescan="${id}">重新扫码</button>
              <button class="btn warn" data-unbind="${id}">解除绑定</button>
              <button class="btn danger" data-remove="${id}">移除账号</button>
            </p>
          </div>`;
        })
        .join("")
    : `<p class="meta">还没有绑定任何账号。</p>`;

  const body = `<h3>账号</h3>
    <p class="meta">每个账号服务一位用户:绑定后收到的第一条消息,其发送者成为该账号的主人,
    其他人的来信一律拒绝。移除账号只停止收发,<b>不会删除已有会话记录</b>(交由保留期清理)。</p>
    <p class="meta"><b>「重新扫码」用于凭据失效或换手机</b>:换掉这个账号的凭据,
    账号本身与它服务的用户不变 —— 会话上下文、工作目录、个人配置全都接着用。
    请让<b>同一个人</b>来扫;换别人扫,等于把这位用户的会话与工作目录交给对方。
    要接入新的人请用下面的「添加账号」。</p>
    ${rows}
    <h4 class="group">添加账号</h4>
    <p class="userops">
      <input id="newname" placeholder="备注名(可选,如「老王的微信」)">
      <button class="btn" id="start">生成二维码</button>
    </p>
    <p class="meta">多个账号的二维码长得一模一样,扫完再回头认"刚才那个是谁"最容易配错人 ——
    所以备注名在扫码<b>之前</b>填。事后也能改。</p>
    <div id="login"></div>`;

  const script = `
const TOKEN = ${jsString(token)};
const post = (url, method, body) => fetch(url, {
  method: method || 'POST',
  headers: body
    ? { 'X-Catman-Token': TOKEN, 'content-type': 'application/json' }
    : { 'X-Catman-Token': TOKEN },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const box = document.getElementById('login');

// 新建与重新扫码走同一段流程,只是 payload 与提示语不同 —— 分成两套的话,
// 二维码渲染、降级展示、轮询三处都得各维护一份。
async function beginLogin(payload, hint, btn) {
  if (btn) btn.disabled = true;
  box.innerHTML = '正在申请二维码…';
  box.scrollIntoView({ block: 'nearest' });
  try {
    const res = await post('/api/accounts/login/start', 'POST', payload);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '申请失败');
    render(data, hint);
    poll(data.loginId);
  } catch (err) {
    box.innerHTML = '出错了:' + String(err && err.message || err);
    if (btn) btn.disabled = false;
  }
}

document.getElementById('start').onclick = (e) =>
  beginLogin({ displayName: document.getElementById('newname').value }, '', e.target);

function render(d, hint) {
  // 降级时要展示 qrcodeContent(二维码承载的授权 URL),而不是 qrcode key —— 后者
  // 只是查询扫码状态用的凭据,把它转成二维码扫了也没用。
  const img = d.qrcodeImage
    ? '<div class="qr"><img alt="登录二维码" src="' + d.qrcodeImage + '"></div>'
    : d.qrcodeContent
      ? '<p class="meta">二维码生成失败。可手动把下面的链接转成二维码扫描:</p><p><code>'
        + escapeText(d.qrcodeContent) + '</code></p>'
      : '<p class="meta">接口未返回二维码内容,无法生成。请查看服务端日志里的原始响应。</p>';
  const head = hint ? '<p class="meta"><b>' + escapeText(hint) + '</b></p>' : '';
  box.innerHTML = head + img + '<p class="meta" id="st">请用微信扫码并确认授权…</p>';
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

async function poll(loginId) {
  const st = document.getElementById('st');
  for (;;) {
    // 服务端那一跳是长轮询(无人扫码时阻塞约 30 秒),这里不需要再等 —— 只留一点
    // 间隔,避免接口万一秒回时打成死循环。
    await new Promise(r => setTimeout(r, 500));
    let data;
    try {
      const res = await post('/api/accounts/login/' + encodeURIComponent(loginId));
      data = await res.json();
    } catch (err) {
      if (st) st.textContent = '查询状态失败,重试中…';
      continue;
    }
    if (data.status === 'confirmed') {
      if (st) {
        st.textContent = data.rebound
          ? '凭据已更新,连接正在重建。让他发一条消息就能接上原来的会话。'
          : '登录成功,连接已建立,正在刷新…';
      }
      location.reload();
      return;
    }
    if (data.status === 'failed') {
      // 例如重新扫码期间目标账号被删了。此时刻意**不**退化成新建账号 ——
      // 那会静默造出一个空白用户,而发起者要的恰恰是接上原来那位。
      if (st) st.textContent = data.message || '登录失败。';
      return;
    }
    if (data.status === 'expired') {
      if (st) st.textContent = '二维码已过期,请重新生成。';
      return;
    }
  }
}

document.addEventListener('click', async (e) => {
  const at = (k) => e.target.getAttribute && e.target.getAttribute(k);
  const unbind = at('data-unbind');
  const remove = at('data-remove');
  const rename = at('data-rename');
  const rescan = at('data-rescan');
  if (rescan) {
    // 扫码的人决定了这个账号之后归谁 —— 换个人扫就是把原用户的会话与工作目录转手。
    if (!confirm('重新扫码会换掉这个账号的凭据,账号与它服务的用户不变(会话、工作目录、'
      + '个人配置都接着用)。请让同一个人来扫;换别人扫等于把这位用户的会话交给对方。继续?')) return;
    await beginLogin({ rebindAccountId: rescan }, '重新扫码:' + rescan, e.target);
  } else if (unbind) {
    if (!confirm('解除绑定后,下一条来信的发送者会成为新主人。继续?')) return;
    await post('/api/accounts/' + encodeURIComponent(unbind) + '/unbind');
    location.reload();
  } else if (remove) {
    if (!confirm('移除该账号将停止收发消息(已有会话记录保留)。继续?')) return;
    await post('/api/accounts/' + encodeURIComponent(remove), 'DELETE');
    location.reload();
  } else if (rename) {
    const box = document.querySelector('[data-name="' + CSS.escape(rename) + '"]');
    if (!box) return;
    const res = await post('/api/accounts/' + encodeURIComponent(rename), 'PATCH',
      { displayName: box.value });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert('改名失败:' + (d.error || res.status));
      return;
    }
    location.reload();
  }
});
`;

  return shell("账号", body, script);
}
