import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { DashboardAuth, parseCookies, tokenEquals, urlWithoutToken } from "../src/dashboard/auth.js";

const TOKEN = "s3cret-token";
const auth = new DashboardAuth(TOKEN);

function req(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function url(path: string): URL {
  return new URL(path, "http://localhost");
}

test("tokenEquals 只对完全相同的值返回 true", () => {
  assert.equal(tokenEquals(TOKEN, TOKEN), true);
  assert.equal(tokenEquals(TOKEN, "wrong"), false);
  // 前缀相同但长度不同也必须为 false(且不抛错)。
  assert.equal(tokenEquals(TOKEN, TOKEN.slice(0, 5)), false);
  assert.equal(tokenEquals("", ""), true);
});

test("parseCookies 解析多个 Cookie 并解码", () => {
  assert.deepEqual(parseCookies("a=1; catman_token=x%20y; b=2"), {
    a: "1",
    catman_token: "x y",
    b: "2",
  });
  assert.deepEqual(parseCookies(undefined), {});
});

test("读操作:无凭据被拒", () => {
  assert.equal(auth.allowsRead(req(), url("/")), false);
});

test("读操作:?token= 或 Cookie 任一命中即可", () => {
  assert.equal(auth.allowsRead(req(), url(`/?token=${TOKEN}`)), true);
  assert.equal(auth.allowsRead(req({ cookie: `catman_token=${TOKEN}` }), url("/")), true);
});

test("读操作:请求头是更强的凭据,也应放行", () => {
  // 否则只带头的纯 API 客户端连读都进不来,写操作更无从谈起(端到端跑出来的真实缺陷)。
  assert.equal(auth.allowsRead(req({ "x-catman-token": TOKEN }), url("/api/sessions")), true);
});

test("读操作:错误的 token 被拒", () => {
  assert.equal(auth.allowsRead(req(), url("/?token=nope")), false);
  assert.equal(auth.allowsRead(req({ cookie: "catman_token=nope" }), url("/")), false);
});

test("写操作:只认请求头,Cookie 不算数(CSRF 守护)", () => {
  // 浏览器会自动带 Cookie,外部页面因此能诱导内网 dashboard 执行删账号一类的写操作;
  // 自定义请求头无法被跨站表单伪造,所以写操作只认它。
  assert.equal(auth.allowsWrite(req({ cookie: `catman_token=${TOKEN}` })), false);
  assert.equal(auth.allowsWrite(req({ "x-catman-token": TOKEN })), true);
});

test("写操作:错误或缺失的请求头被拒", () => {
  assert.equal(auth.allowsWrite(req()), false);
  assert.equal(auth.allowsWrite(req({ "x-catman-token": "nope" })), false);
});

test("?token= 命中时应换 Cookie", () => {
  assert.equal(auth.shouldExchangeQueryToken(url(`/?token=${TOKEN}`)), true);
  assert.equal(auth.shouldExchangeQueryToken(url("/?token=nope")), false);
  assert.equal(auth.shouldExchangeQueryToken(url("/")), false);
});

test("Cookie 属性:HttpOnly + SameSite,不设 Secure(内网多为 http)", () => {
  const header = auth.cookieHeader();
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Path=\//);
  assert.doesNotMatch(header, /Secure/);
});

test("重定向目标去掉 token,保留其余查询参数", () => {
  assert.equal(urlWithoutToken(url(`/session/s1?token=${TOKEN}&p=abc`)), "/session/s1?p=abc");
  assert.equal(urlWithoutToken(url(`/?token=${TOKEN}`)), "/");
});
