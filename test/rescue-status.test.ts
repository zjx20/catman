import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatus, type StatusView } from "../src/rescue/status.js";

/**
 * 状态页是**无 LLM 的完整控制面**:磁盘满、内存尽、token 过期时救援大脑同样起不来,
 * 而这一页还在。所以它的两条性质要钉住 —— 转义(页面上有来自外部的字符串),
 * 以及"丢失计数非零时必须显眼"。
 */

function view(over: Partial<StatusView> = {}): StatusView {
  return {
    containers: [{ name: "catman", running: true, restarts: 0 }],
    pointers: { current: "a".repeat(40) },
    depths: { primary: 0, rescue: 0 },
    losses: { primary: { dropped: 0, nacked: 0 } },
    lost: 0,
    logTail: [],
    ...over,
  };
}

test("外部来的字符串一律转义 —— 备注名与部署 detail 都不是我们写的", () => {
  const html = renderStatus(
    view({
      containers: [{ name: '<img src=x onerror=alert(1)>', running: false, restarts: 2 }],
      lastDeploy: '</pre><script>bad()</script>',
      logTail: ['<script>alert("log")</script>'],
    }),
  );
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img src=x"), false);
  assert.ok(html.includes("&lt;script&gt;"));
});

test("丢失计数为 0 时不出警告块 —— 平时不该有噪音", () => {
  assert.equal(renderStatus(view()).includes("没能送到人手里"), false);
});

test("丢失计数非零时必须显眼 —— 那是这套系统最不能接受的事", () => {
  const html = renderStatus(
    view({ losses: { primary: { dropped: 3, nacked: 1 } }, lost: 2 }),
  );
  assert.match(html, /6 条消息没能送到人手里/);
  // 警告要排在容器表之前 —— 埋在下半部分等于没有。
  assert.ok(html.indexOf("没能送到人手里") < html.indexOf("<h2>容器</h2>"));
});

test("信使队列深度出现在页面上 —— 它是排水的第二个真相源", () => {
  // 只看人格 /health 的三个计数是"假清零":还躺在信使队列里的一条都不算。
  const html = renderStatus(view({ depths: { primary: 7, rescue: 0 } }));
  assert.match(html, /7 条待处理/);
});

test("看门狗的决策与理由都要露出来 —— 没有 why 就查不出为什么退了版本", () => {
  const html = renderStatus(
    view({ lastAction: { at: "2026-08-10T00:00:00Z", action: { kind: "demote", step: 1, why: "主人格重启了 5 次" } } }),
  );
  assert.match(html, /demote/);
  assert.match(html, /主人格重启了 5 次/);
});

test("页面写明「退回上一级」不动 stable —— 那是指针单主的用户可见面", () => {
  assert.match(renderStatus(view()), /只动 current.*绝不动 stable/);
});

test("机械防线三行:磁盘 / 订阅凭据 / 每周点火 —— 三种「大脑也一起废」的死法", () => {
  const html = renderStatus(
    view({
      diskFreeMb: 900,
      tokenLine: "还有约 2 天到期",
      tokenOk: false,
      ignition: { ranAt: "2026-08-10T00:00:00Z", ok: false, detail: "smoke:自检没过" },
    }),
  );
  assert.match(html, /900MB/);
  assert.match(html, /2 天到期/);
  assert.match(html, /smoke:自检没过/);
  // 红线以下的磁盘、快到期的 token、失败的点火都要红(class="bad")。
  const bad = html.match(/class="bad"/g) ?? [];
  assert.ok(bad.length >= 3, `该有至少 3 处红,实际 ${bad.length}`);
});

test("从没点过火也要显眼 —— 例行演练没在跑本身就是异常", () => {
  // 缺席不等于没事:冷启动这条路一次都没被验过,断电那天走的就是它。
  const html = renderStatus(view({}));
  assert.match(html, /还没跑过/);
});
