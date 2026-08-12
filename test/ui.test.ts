import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  ENTER_GUARD_SNIPPET,
  escapeHtml,
  renderPage,
  type UserRow,
} from "../src/dashboard/ui.js";
import { BUILTIN_ADMIN_USER_KEY } from "../src/core/identity.js";
import { canonicalOf } from "../src/core/commands.js";
import type { UserRecord } from "../src/core/users.js";

function user(displayName: string, over: Partial<UserRecord> = {}): UserRecord {
  return {
    dirName: "d-00000000",
    channel: "wechat",
    accountId: "acct",
    displayName,
    createdAt: 0,
    lastSeenAt: 0,
    ...over,
  };
}

test("escapeHtml 转义所有危险字符", () => {
  assert.equal(escapeHtml(`<script>"&'`), "&lt;script&gt;&quot;&amp;'");
});

test("列表页渲染会话预览与链接", () => {
  const html = renderPage("list", {
    sessions: [
      {
        sessionId: "s1",
        projectDir: "-data-workspace-a",
        path: "/x/s1.jsonl",
        mtimeMs: Date.now(),
        sizeBytes: 12,
        preview: "查看内存",
      },
    ],
    users: {},
  });
  assert.match(html, /查看内存/);
  assert.match(html, /\/session\/s1/);
});

test("会话详情页把工具调用渲染成默认收起的折叠块", () => {
  const html = renderPage("session", {
    sessionId: "s1",
    entries: [
      {
        role: "assistant",
        text: "看一下",
        blocks: [
          { kind: "tool_use", label: "Bash", summary: "df -h", detail: '{\n  "command": "df -h"\n}' },
        ],
      },
      {
        role: "user",
        text: "",
        blocks: [{ kind: "tool_result", label: "Bash 结果", summary: "满了", detail: "/dev/sda1 100%" }],
      },
    ],
  });
  assert.match(html, /<details class="blk">/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/, "默认收起,几十个块摊开就没法读了");
  assert.match(html, /Bash 结果/);
  assert.match(html, /df -h/, "收起时的摘要");
  assert.match(html, /\/dev\/sda1 100%/, "展开后的完整输出也在页面里");
});

test("会话详情页转义工具输出,不让它注入页面", () => {
  const html = renderPage("session", {
    sessionId: "s1",
    entries: [
      {
        role: "user",
        text: "",
        blocks: [
          {
            kind: "tool_result",
            label: "Bash 结果",
            summary: "<script>alert(1)</script>",
            detail: "<script>alert(2)</script>",
            isError: true,
          },
        ],
      },
    ],
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(2\)/);
  assert.match(html, /class="blk bad"/, "失败的工具结果要看得出来");
});

test("列表页按用户分组,展示各自的显示名", () => {
  const base = { path: "/x.jsonl", mtimeMs: Date.now(), sizeBytes: 1, preview: "p" };
  const html = renderPage("list", {
    sessions: [
      { ...base, sessionId: "s1", projectDir: "-p-a", userKey: "wechat:a:u1" },
      { ...base, sessionId: "s2", projectDir: "-p-b", userKey: "wechat:b:u2" },
    ],
    users: {
      "wechat:a:u1": user("小王"),
      "wechat:b:u2": user("小李"),
    },
  });
  assert.match(html, /小王/);
  assert.match(html, /小李/);
});

test("列表页对用户显示名做转义(防注入)", () => {
  const html = renderPage("list", {
    sessions: [
      {
        sessionId: "s1",
        projectDir: "-p",
        path: "/x.jsonl",
        mtimeMs: 0,
        sizeBytes: 1,
        preview: "p",
        userKey: "k",
      },
    ],
    users: { k: user("<img src=x onerror=alert(1)>") },
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("会话详情页对消息文本做转义(防注入)", () => {
  const html = renderPage("session", {
    sessionId: "s1",
    entries: [{ role: "user", text: "<img src=x onerror=alert(1)>" }],
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("空会话有占位提示", () => {
  const html = renderPage("session", { sessionId: "s1", entries: [] });
  assert.match(html, /空会话/);
});

test("账号页展示绑定状态,且不泄露 botToken", () => {
  const html = renderPage("accounts", {
    accounts: [
      {
        accountId: "a1",
        channel: "wechat",
        baseUrl: "https://x",
        botId: "b1",
        displayName: "我的微信",
        boundUserId: "u@im.wechat",
        createdAt: 0,
        rejections: [{ userId: "bad@im.wechat", count: 3, lastAt: 0 }],
      },
    ],
    token: "tok",
  });
  assert.match(html, /已绑定 u@im\.wechat/);
  assert.match(html, /bad@im\.wechat/);
  // PublicAccount 类型上没有 botToken,这里守护渲染层不会意外带出凭据。
  assert.doesNotMatch(html, /botToken/);
});

test("账号页对账号显示名做转义(防注入)", () => {
  const html = renderPage("accounts", {
    accounts: [
      {
        accountId: "a1",
        channel: "wechat",
        baseUrl: "",
        botId: "",
        displayName: "<script>alert(1)</script>",
        createdAt: 0,
      },
    ],
    token: "tok",
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("注入页面的 token 不会提前闭合 script 标签", () => {
  const html = renderPage("accounts", {
    accounts: [],
    token: "</script><img src=x onerror=alert(1)>",
  });
  assert.doesNotMatch(html, /<\/script><img/);
});

// --- 聊天输入框:输入法合成期间不能抢 Enter ---

/**
 * 把页面里**真正跑的那一份**判定逻辑取出来,在空沙箱里求值。
 * 沙箱没有模块作用域,所以函数体一旦引用了外部标识符,这里就直接 ReferenceError ——
 * 而不是等到浏览器里才炸。行为断言与自足性断言同时靠它完成。
 */
const shouldSendOnEnter = runInNewContext(
  `${ENTER_GUARD_SNIPPET}; shouldSendOnEnter`,
) as (e: unknown, state: unknown) => boolean;

const IDLE = { composing: false, composedAt: -Infinity };
const evt = (over: Record<string, unknown>) => ({
  key: "Enter",
  shiftKey: false,
  isComposing: false,
  keyCode: 13,
  timeStamp: 1000,
  ...over,
});

test("聊天页内联的正是同一份 Enter 判定逻辑", () => {
  const html = renderPage("chat", { history: [], token: "tok", lastId: 0 });
  assert.ok(html.includes(ENTER_GUARD_SNIPPET), "页面与单测必须同源,否则测了个寂寞");
  assert.match(html, /compositionstart/);
});

test("没在合成:Enter 发送,Shift+Enter 与其它键不发送", () => {
  assert.equal(shouldSendOnEnter(evt({}), IDLE), true);
  assert.equal(shouldSendOnEnter(evt({ shiftKey: true }), IDLE), false);
  assert.equal(shouldSendOnEnter(evt({ key: "a", keyCode: 65 }), IDLE), false);
});

test("Chrome / Firefox:合成中的 keydown 带 isComposing,不能发送", () => {
  const composing = { composing: true, composedAt: -Infinity };
  assert.equal(shouldSendOnEnter(evt({ isComposing: true }), composing), false);
  // 只给 keyCode 229、isComposing 却是 false 的实现同样要挡住。
  assert.equal(shouldSendOnEnter(evt({ keyCode: 229 }), IDLE), false);
});

test("Safari:compositionend 先于 keydown,上屏那一下没有任何标志位", () => {
  // 同一次物理按键产生的两个事件,间隔在 1ms 量级 —— 只能靠时间窗认出来。
  const justComposed = { composing: false, composedAt: 1000 };
  assert.equal(shouldSendOnEnter(evt({ timeStamp: 1000.4 }), justComposed), false);
});

test("上屏之后再按一次 Enter 要能发送 —— 时间窗不许吞掉真正的发送", () => {
  const justComposed = { composing: false, composedAt: 1000 };
  // 60ms 是人连按两次键的下限量级,必须放行,否则中文用户永远发不出消息。
  assert.equal(shouldSendOnEnter(evt({ timeStamp: 1060 }), justComposed), true);
});

// --- 聊天页:历史与会话控制 ---

test("聊天页首屏渲染历史,刷新后不会重头开始", () => {
  const html = renderPage("chat", {
    history: [
      { id: 1, role: "user", text: "上一轮问的", at: 0 },
      { id: 2, role: "bot", text: "上一轮答的", at: 0 },
    ],
    token: "tok",
    lastId: 2,
  });
  assert.match(html, /上一轮问的/);
  assert.match(html, /上一轮答的/);
});

test("首屏水位进 ?after= —— 服务端不会把刚渲染过的历史再推一遍", () => {
  const html = renderPage("chat", { history: [], token: "tok", lastId: 42 });
  assert.match(html, /\/api\/chat\/stream\?after=' \+ 42/);
});

test("开新会话按钮发的就是硬指令本身,不写死字符串", () => {
  const html = renderPage("chat", { history: [], token: "tok", lastId: 0 });
  assert.match(html, /id="newsession"/);
  // 指令写法改了(比如从 /新会话 改名),按钮必须跟着变 —— 单一真相源在 COMMAND_TABLE。
  assert.ok(html.includes(JSON.stringify(canonicalOf("newSession"))));
  assert.match(html, /confirm\(/, "上下文丢了找不回来,一次误点的代价太大");
});

test("聊天页说清「开新会话」不清空记录 —— 这是网页比微信多出来的信息", () => {
  const html = renderPage("chat", { history: [], token: "tok", lastId: 0 });
  assert.match(html, /不会清空这里的记录/);
});

test("聊天页对历史消息做转义(防注入)", () => {
  const html = renderPage("chat", {
    history: [{ id: 1, role: "bot", text: "<img src=x onerror=alert(1)>", at: 0 }],
    token: "tok",
    lastId: 1,
  });
  assert.doesNotMatch(html, /<img src=x/);
});

test("用户报的场景:中文输入法里打英文,Enter 只上屏不发送", () => {
  const state = { composing: false, composedAt: -Infinity };
  // 打字母 → 进入合成
  state.composing = true;
  assert.equal(shouldSendOnEnter(evt({ isComposing: true, timeStamp: 500 }), state), false);
  // 按 Enter 把字母原样上屏:Chrome 顺序(keydown 在前)
  assert.equal(shouldSendOnEnter(evt({ isComposing: true, timeStamp: 900 }), state), false);
  state.composing = false;
  state.composedAt = 900;
  // Safari 顺序(compositionend 在前,keydown 紧随其后)
  assert.equal(shouldSendOnEnter(evt({ timeStamp: 900.6 }), state), false);
  // 内容已在框里,用户再按 Enter 才是发送
  assert.equal(shouldSendOnEnter(evt({ timeStamp: 1400 }), state), true);
});

// --- 用户页:提权入口 ---

function row(over: Partial<UserRow> = {}): UserRow {
  return {
    userKey: "wechat:a1:u@im.wechat",
    displayName: "小王",
    channel: "wechat",
    isAdmin: false,
    model: "sonnet",
    workspace: "/data/workspace/w-x",
    createdAt: 1,
    lastSeenAt: 2,
    ...over,
  };
}

test("用户页给出提权按钮 —— 在此之前只能靠聊天或 curl", () => {
  const html = renderPage("users", { users: [row()], token: "tok" });
  assert.match(html, /data-admin="1"/);
  assert.match(html, /data-key="wechat:a1:u@im\.wechat"/);
  assert.match(html, /confirm\(/, "提权是把整台机器交出去,不能一点就生效");
});

test("已经是管理员的显示为可取消", () => {
  const html = renderPage("users", { users: [row({ isAdmin: true })], token: "tok" });
  // 断言按钮本身而不是文案 —— confirm 的提示语里也有"设为管理员"四个字。
  assert.match(html, /data-admin="0"/);
  assert.doesNotMatch(html, /data-admin="1"/);
});

test("内置管理员那一行没有撤销按钮,并说明原因", () => {
  const html = renderPage("users", {
    users: [row({ userKey: BUILTIN_ADMIN_USER_KEY, isAdmin: true, displayName: "管理员" })],
    token: "tok",
  });
  assert.doesNotMatch(html, /data-admin=/);
  assert.match(html, /不可撤销/);
});

test("未设模型时显示兜底说明,而不是空白", () => {
  const html = renderPage("users", { users: [row({ model: undefined })], token: "tok" });
  assert.match(html, /交给 SDK 默认/);
});

test("用户页对显示名做转义(防注入)", () => {
  const html = renderPage("users", {
    users: [row({ displayName: "<img src=x onerror=alert(1)>" })],
    token: "tok",
  });
  assert.doesNotMatch(html, /<img src=x/);
});

test("没有用户时给出解释,而不是空页面", () => {
  const html = renderPage("users", { users: [], token: "tok" });
  assert.match(html, /还没有用户/);
});

test("导航里有用户页入口", () => {
  const html = renderPage("users", { users: [], token: "tok" });
  assert.match(html, /href="\/users"/);
});

// --- 账号页:备注名 ---

const acct = (over = {}) => ({
  accountId: "a1",
  channel: "wechat",
  baseUrl: "https://x",
  botId: "b1",
  displayName: "老王的微信",
  createdAt: 0,
  ...over,
});

test("扫码前可以填备注名 —— 二维码之间没区别,扫完再认最容易配错", () => {
  const html = renderPage("accounts", { accounts: [], token: "tok" });
  assert.match(html, /id="newname"/);
  assert.match(html, /displayName: document\.getElementById\('newname'\)\.value/);
});

test("每行都有「重新扫码」,发的是带 rebindAccountId 的登录请求(而非新建账号)", () => {
  const html = renderPage("accounts", { accounts: [acct()], token: "tok" });
  assert.match(html, /data-rescan="a1"/);
  assert.match(html, /rebindAccountId: rescan/);
});

test("凭据失效要在账号页显性提示 —— 否则表现只是「不回消息」", () => {
  const html = renderPage("accounts", { accounts: [acct({ expiredAt: 1_700_000_000_000 })], token: "tok" });
  assert.match(html, /凭据已失效/);
  assert.match(html, /请重新扫码/);
});

test("等待认领的账号要说明在等什么", () => {
  const html = renderPage("accounts", {
    accounts: [acct({ boundUserId: "u@im.wechat", pendingRebind: true })],
    token: "tok",
  });
  assert.match(html, /等这个账号的主人发一条消息来认领/);
});

test("已有账号每行都能改备注名", () => {
  const html = renderPage("accounts", { accounts: [acct()], token: "tok" });
  assert.match(html, /data-rename="a1"/);
  assert.match(html, /data-name="a1"/);
  assert.match(html, /老王的微信/);
});
