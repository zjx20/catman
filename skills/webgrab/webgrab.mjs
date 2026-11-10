#!/usr/bin/env node
/**
 * webgrab —— 抓那些「直接 curl 抓不到」的网页。
 *
 * 四条通道,一个入口:
 *   plain  本机 curl + 浏览器 UA(最便宜,先试它)
 *   jina   r.jina.ai 阅读器(免费无 key,能过 Medium 那类 TLS 指纹墙)
 *   cf     Cloudflare Browser Run Quick Actions(无状态渲染,已退居后备)
 *   cnb    远程的真实 Firefox(Camoufox + Worker 网关):有登录态、能点能填能截图
 *
 * 所有网络请求都 exec 出去交给 curl,不用 node 自带 fetch —— 因为 fetch 不认
 * HTTP_PROXY,而这台机器出网必须走 catwalk 那个代理(curl 自动认环境变量)。
 * 顺带 curl 的 --config - 让我们能把 API token 从 argv 里拿掉(见 runCurl)。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, accessSync, statSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'

const UA_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// CF Quick Actions:文本类返回 {success,result},二进制类直接返回文件流。
const CF_TEXT_ACTIONS = ['markdown', 'content', 'json']
const CF_BIN_ACTIONS = ['screenshot', 'pdf']
const CF_ACTIONS = [...CF_TEXT_ACTIONS, ...CF_BIN_ACTIONS]

const CONFIG_PATHS = [
  '/user/cloudflare/browser-run.env',
]
let deadline = Infinity

function remainingSeconds() {
  const remaining = (deadline - Date.now()) / 1000
  if (remaining <= 0) die('命令总超时，已停止。不要原样重试；先检查网络或浏览器状态。', 28)
  return remaining
}

function die(msg, code = 1) {
  process.stderr.write(`webgrab: ${msg}\n`)
  process.exit(code)
}

function loadCfConfig() {
  const out = {
    accountId: process.env.CF_BROWSER_ACCOUNT_ID || '',
    token: process.env.CF_BROWSER_API_TOKEN || '',
    from: 'env',
  }
  if (out.accountId && out.token) return out
  for (const p of CONFIG_PATHS) {
    if (!p || !existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (!m) continue
      const val = m[2].replace(/^["']|["']$/g, '')
      if (m[1] === 'CF_BROWSER_ACCOUNT_ID' && !out.accountId) out.accountId = val
      if (m[1] === 'CF_BROWSER_API_TOKEN' && !out.token) out.token = val
    }
    out.from = p
    if (out.accountId && out.token) return out
  }
  return out
}

/** curl 的 config 文件里,双引号值支持 \\ \" 转义。 */
function q(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 把 curl 的参数全部塞进 --config 从 stdin 喂进去。
 * 好处:token 不出现在 argv 里(`ps` 看不到),也不用落临时文件。
 */
function runCurl(configLines) {
  const remaining = remainingSeconds()
  const requested = Number(configLines.find(s => s.startsWith('max-time = '))?.slice(11)) || remaining
  const dir = mkdtempSync(join(tmpdir(), 'webgrab-'))
  const hdrFile = join(dir, 'h')
  const lines = [...configLines, `max-time = ${Math.min(requested, remaining)}`, `dump-header = ${q(hdrFile)}`, 'silent', 'show-error']
  try {
    const r = spawnSync('curl', ['--config', '-'], {
      input: lines.join('\n') + '\n',
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8', // 二进制一律靠 curl 的 output= 直写文件,stdout 不经手
      timeout: Math.ceil(remaining * 1000) + 1000,
    })
    if (r.error) die(r.error.code === 'ETIMEDOUT' ? '命令总超时，已终止 curl' : `curl 起不来: ${r.error.message}`, r.error.code === 'ETIMEDOUT' ? 28 : 1)
    if (r.status !== 0) die(`curl 失败（退出码 ${r.status ?? r.signal}）：${String(r.stderr || '').trim().slice(0, 600)}`, r.status || 1)
    let status = 0
    let headers = ''
    if (existsSync(hdrFile)) {
      headers = readFileSync(hdrFile, 'utf8')
      const codes = [...headers.matchAll(/^HTTP\/[\d.]+ (\d{3})/gm)].map((m) => +m[1])
      status = codes.length ? codes[codes.length - 1] : 0
    }
    const ms = /^x-browser-ms-used:\s*(\d+)/im.exec(headers)
    if (ms) process.stderr.write(`[browser-ms-used ${ms[1]}]\n`)
    return {
      status,
      body: r.stdout,
      stderr: (r.stderr || '').toString(),
      exit: r.status,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── plain ────────────────────────────────────────────────────────────────────

function cmdPlain(url, opt) {
  const cfg = [
    `url = ${q(url)}`,
    'location',
    'compressed',
    `max-time = ${opt.timeout}`,
    `user-agent = ${q(opt.ua || UA_CHROME)}`,
    `header = ${q('Accept-Language: zh-CN,zh;q=0.9,en;q=0.8')}`,
  ]
  if (opt.noproxy) cfg.push('noproxy = "*"')
  if (opt.out) cfg.push(`output = ${q(opt.out)}`)
  const r = runCurl(cfg)
  if (r.status >= 400) die(`HTTP ${r.status}(反爬墙?换 jina 或 cf 通道)`, 2)
  if (!opt.out) process.stdout.write(r.body)
  else process.stderr.write(`→ ${opt.out}\n`)
}

// ── jina ─────────────────────────────────────────────────────────────────────

function cmdJina(url, opt) {
  // 目标 URL 必须整段百分号编码,否则它自己的 query(?sk=…)会被 jina 当成
  // jina 的参数吃掉 —— Medium friend link 失效就是栽在这儿。
  const target = `https://r.jina.ai/${encodeURIComponent(url)}`
  const cfg = [`url = ${q(target)}`, 'location', `max-time = ${opt.timeout}`]
  if (!opt.plain) {
    // x-engine: browser 才会真渲染;x-no-cache 才不会把之前那次没带 sk 的
    // 付费墙预览原样还给你。两个必须一起给,少一个都拿不到全文。
    cfg.push(`header = ${q('x-engine: browser')}`)
    if (!opt.cache) cfg.push(`header = ${q('x-no-cache: true')}`)
  }
  if (process.env.JINA_API_KEY) {
    cfg.push(`header = ${q(`Authorization: Bearer ${process.env.JINA_API_KEY}`)}`)
  }
  if (opt.out) cfg.push(`output = ${q(opt.out)}`)
  const r = runCurl(cfg)
  if (r.status >= 400) die(`jina HTTP ${r.status}: ${String(r.body).slice(0, 300)}`, 2)
  if (!opt.out) process.stdout.write(r.body)
  else process.stderr.write(`→ ${opt.out}\n`)
}

// ── cf(Browser Run Quick Actions) ───────────────────────────────────────────

function buildCfBody(action, url, opt) {
  const body = {}
  if (opt.html) body.html = opt.html
  else body.url = url
  if (opt.wait || opt.timeoutMs) {
    body.gotoOptions = {}
    if (opt.wait) body.gotoOptions.waitUntil = opt.wait
    if (opt.timeoutMs) body.gotoOptions.timeout = opt.timeoutMs
  }
  if (opt.selector) body.waitForSelector = { selector: opt.selector }
  if (opt.ua) body.userAgent = opt.ua
  if (opt.cookies) body.cookies = JSON.parse(opt.cookies)
  if (opt.rejectCss) body.rejectRequestPattern = ['/^.*\\.(css)/']
  if (action === 'json') {
    if (opt.prompt) body.prompt = opt.prompt
    if (opt.schema) body.response_format = JSON.parse(readFileSync(opt.schema, 'utf8'))
    if (!body.prompt && !body.response_format) die('json 要 --prompt 或 --schema')
  }
  if (opt.extra) Object.assign(body, JSON.parse(opt.extra))
  return JSON.stringify(body)
}

function cmdCf(action, url, opt) {
  if (!CF_ACTIONS.includes(action)) {
    die(`未知 action ${action};可用: ${CF_ACTIONS.join(' ')}`)
  }
  const { accountId, token, from } = loadCfConfig()
  if (!accountId || !token) {
    die(
      `没有 CF 凭据。给 CF_BROWSER_ACCOUNT_ID / CF_BROWSER_API_TOKEN 环境变量,或写进\n` +
        `  /user/cloudflare/browser-run.env   (chmod 600,格式见 browser-run.env.example)\n` +
        `已找过: ${CONFIG_PATHS.filter(Boolean).join(', ')}(当前来源 ${from})`
    )
  }
  const isBin = CF_BIN_ACTIONS.includes(action)
  if (isBin && !opt.out) die(`${action} 返回二进制,必须给 --out <文件>`)

  const body = buildCfBody(action, url, opt)
  // Kitesurf 是默认浏览器,要 Chromium 得显式 --chromium。理由是钱:同样的活
  // Kitesurf 省 3~4 倍 CPU、5~7 倍内存,而免费额度只有每天 10 分钟浏览器时长。
  // 反过来默认的话,每次忘了加 flag 都在偷偷多花额度,而且完全看不出来。
  const qs = opt.chromium ? '' : '?browser=kitesurf'
  // 路径两个都活:/browser-rendering 是老名字,/browser-run 是改名后的。
  // kitesurf 的官方示例走的是新名字,所以按浏览器选顺序,404 再退到另一条。
  const bases = opt.chromium
    ? ['browser-rendering', 'browser-run']
    : ['browser-run', 'browser-rendering']

  if (opt.dryRun) {
    process.stdout.write(
      `POST https://api.cloudflare.com/client/v4/accounts/${accountId}/${bases[0]}/${action}${qs}\n` +
        `Authorization: Bearer <REDACTED>\n${body}\n`
    )
    return
  }

  let r
  for (const base of bases) {
    const cfg = [
      `url = ${q(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${base}/${action}${qs}`)}`,
      'request = "POST"',
      `header = ${q(`Authorization: Bearer ${token}`)}`,
      `header = ${q('Content-Type: application/json')}`,
      `data = ${q(body)}`,
      `max-time = ${opt.timeout}`,
    ]
    if (isBin) cfg.push(`output = ${q(opt.out)}`)
    r = runCurl(cfg)
    if (r.status !== 404) break
  }

  // Kitesurf 只实现了一部分 action,没实现的报 400 + code 2000。上面那五个
  // 2026-09-05 实测都支持(links / scrape / snapshot 不支持,所以压根没收进来),
  // 但它还在 beta,支持范围会动。真撞上了唯一的出路就是换 Chromium ——
  // 那就别让调用方再跑一趟,自己换,但要说一声。
  // 二进制 action 的正文被 curl 直写进文件了,r.body 是空的,报错要去文件里看。
  const probe =
    isBin && r.status >= 400 && existsSync(opt.out)
      ? readFileSync(opt.out, 'utf8').slice(0, 2000)
      : String(r.body)
  if (!opt.chromium && /not supported by the kitesurf browser/i.test(probe)) {
    process.stderr.write(`[kitesurf 不支持 ${action},自动改用 Chromium]\n`)
    return cmdCf(action, url, { ...opt, chromium: true })
  }

  if (r.status === 429) {
    die('429 —— 免费额度是「每 10 秒 1 次请求 / 每天 10 分钟浏览器时长」,等一会儿再来', 3)
  }
  if (isBin) {
    if (r.status >= 400) die(`HTTP ${r.status}(二进制模式,错误正文在 ${opt.out} 里)`, 2)
    process.stderr.write(`→ ${opt.out}\n`)
    return
  }
  const text = String(r.body)
  if (r.status >= 400) die(`HTTP ${r.status}: ${text.slice(0, 500)}`, 2)
  if (opt.raw) return void process.stdout.write(text)
  let j
  try {
    j = JSON.parse(text)
  } catch {
    return void process.stdout.write(text)
  }
  if (j.success === false) {
    die(`CF 报错: ${JSON.stringify(j.errors || j).slice(0, 500)}`, 2)
  }
  const out = typeof j.result === 'string' ? j.result : JSON.stringify(j.result, null, 2)
  if (opt.out) {
    writeFileSync(opt.out, out)
    process.stderr.write(`→ ${opt.out}\n`)
  } else process.stdout.write(out.endsWith('\n') ? out : out + '\n')
}

// ── cnb(远程真实 Firefox,Camoufox + Cloudflare Worker 网关) ─────────────────
//
// 跟 cf 那条通道的根本区别:cf 是「发一个 URL,拿一份渲染结果」,无状态;
// cnb 是一个**一直开着的浏览器窗口**,cookie/登录态跨请求保留,能点能填能滚。
// 代价是它串行、要冷启动一两分钟、而且拿到 token 就等于拿到那个浏览器。
// 完整动作表在同目录的 cnb-browser.md,这里只封装最常用的几件事。

const CNB_CONFIG_PATHS = [
  '/user/cnb/browser.env',
]

function loadCnbConfig() {
  const out = {
    url: (process.env.CNB_BROWSER_URL || '').replace(/\/+$/, ''),
    token: process.env.CNB_BROWSER_TOKEN || '',
    from: 'env',
  }
  if (out.url && out.token) return out
  for (const p of CNB_CONFIG_PATHS) {
    if (!p || !existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (!m) continue
      const val = m[2].replace(/^["']|["']$/g, '')
      if (m[1] === 'CNB_BROWSER_URL' && !out.url) out.url = val.replace(/\/+$/, '')
      if (m[1] === 'CNB_BROWSER_TOKEN' && !out.token) out.token = val
    }
    out.from = p
    if (out.url && out.token) return out
  }
  return out
}

function cnbConfigOrDie() {
  const c = loadCnbConfig()
  if (!c.url || !c.token) {
    die(
      `没有 CNB 凭据。给 CNB_BROWSER_URL / CNB_BROWSER_TOKEN 环境变量,或写进\n` +
        `  /user/cnb/browser.env   (chmod 600,格式见 cnb-browser.env.example)\n` +
        `已找过: ${CNB_CONFIG_PATHS.filter(Boolean).join(', ')}`
    )
  }
  return c
}

/** 网关只认 Authorization 头(/healthz 除外)。token 走 --config,不进 argv。 */
function cnbCurl(c, { path, post, body, out, timeout }) {
  const cfg = [
    `url = ${q(c.url + path)}`,
    `header = ${q(`Authorization: Bearer ${c.token}`)}`,
    `max-time = ${timeout || 180}`,
  ]
  if (post) cfg.push('request = "POST"')
  if (body !== undefined) {
    cfg.push(`header = ${q('Content-Type: application/json')}`, `data = ${q(body)}`)
  }
  if (out) cfg.push(`output = ${q(out)}`)
  return runCurl(cfg)
}

function tryParse(s) {
  try {
    return JSON.parse(String(s))
  } catch {
    return null
  }
}

function sleepSec(n) {
  spawnSync('sleep', [String(Math.min(n, remainingSeconds()))])
}

/**
 * 把空间拉到 ready。冷启动一百多秒是正常的,503 WORKSPACE_STARTING 就是「还在起」,
 * 要接着调同一个接口,不是换别的手段。
 */
function cnbStart(c, { tries = 10 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = cnbCurl(c, { path: '/gw/start?wait=120', post: true, timeout: 180 })
    const j = tryParse(r.body)
    if (r.status === 200 && j && j.state === 'ready') return j
    if (r.status === 503) {
      process.stderr.write(
        `[空间拉起中 ${(j && j.stage) || '?'} ${(j && j.elapsedMs) || 0}ms,第 ${i + 1} 次]\n`
      )
      sleepSec(5)
      continue
    }
    cnbFail(r, j)
  }
  die('空间迟迟起不来;跑 `webgrab cnb status` 看网关怎么说', 3)
}

function cnbFail(r, j) {
  const err = (j && (j.error || j.message)) || String(r.body).slice(0, 400)
  if (r.status === 401) die('401 —— token 不对或没带上。检查凭据文件', 2)
  if (r.status === 504 || (r.status >= 500 && !j)) {
    // 实测:机器之心那种「资源一直不停」的页面,goto 会跑满 30s×2(默认 retry_count=1),
    // 而网关 ~60s 就断,于是拿到一个 CF 的纯文本 504。动作其实还在浏览器里跑着,
    // 页面多半已经导航过去了 —— 所以下一句该问 get_page_info,不是原样重发。
    die(
      `${r.status} —— 网关约 60 秒就断了(动作可能还在浏览器里跑)。\n` +
        `  慢站别用 --wait networkidle；goto timeout 使用秒，建议 30，retry_count: 0。\n` +
        `  或者先 \`cnb do '{"action":"get_page_info"}'\` 看它到哪儿了,再单独取正文。`,
      3
    )
  }
  if (r.status === 403) die(`403 网关策略挡下了(别重试,换做法): ${err}`, 2)
  if (r.status === 502) die(`502 网关调不动云平台,不是你能修的: ${err}`, 2)
  die(`HTTP ${r.status}: ${err}`, 2)
}

/** 发一个浏览器动作。撞上「空间没起来」就自动拉起再来一次。 */
function cnbAction(c, bodyObj, opt, tolerant) {
  const body = JSON.stringify(bodyObj)
  let r = cnbCurl(c, { path: '/', post: true, body, timeout: opt.timeout })
  let j = tryParse(r.body)
  if (r.status === 503 || (j && /WORKSPACE_(STARTING|UNREACHABLE)/.test(j.error || ''))) {
    process.stderr.write('[空间未就绪,先拉起]\n')
    cnbStart(c)
    r = cnbCurl(c, { path: '/', post: true, body, timeout: opt.timeout })
    j = tryParse(r.body)
  }
  if (r.status >= 400 || !j) cnbFail(r, j)
  // HTTP 200 不代表动作成功:选择器没匹配到、超时都走 success:false。
  if (j.success === false) die(`动作失败: ${j.error}`, 2)
  // run_script 更绕一层:外层 success 只说明脚本跑完了,某一步失败它照样是 true。
  const d = j.data
  if (d && d.success === false && tolerant && d.outputs && Object.keys(d.outputs).length) {
    const bad = (d.step_results || []).filter((x) => x && x.success === false)
    process.stderr.write(
      `[有 ${bad.length} 步没成功但拿到了产出: ${bad.map((x) => `${x.action}: ${x.error}`).join('; ').slice(0, 200)}]\n`
    )
    return j
  }
  if (d && d.success === false) {
    const bad = (d.step_results || []).find((s) => s && s.success === false)
    die(
      `脚本第 ${d.steps_executed || '?'}/${d.steps_total || '?'} 步失败: ` +
        `${(bad && (bad.error || bad.action)) || JSON.stringify(d).slice(0, 300)}`,
      2
    )
  }
  return j
}

/**
 * goto 报错 ≠ 没打开。两种情况都会让 goto 以 abort(NS_ERROR_ABORT / NS_BINDING_ABORTED)
 * 结束而页面其实已经到位:跳转链(最初那次导航被后来的顶掉,`https://www.google.com/`
 * 就是现成例子)、以及 204/直接触发下载(浏览器根本不离开当前页)。
 * 反过来,真连不上时浏览器**停在上一页**,而 get_text 照样有产出 —— 那份产出是
 * 上一次抓的东西,长得跟成功一模一样(实测抓 medium 失败,拿回一整页机器之心)。
 *
 * 判据不能用 URL 变没变:重抓一个当前已经停着的页面时,前后 URL 一样但确实导航了。
 * 也不能比 host:跳转链本来就换 host(google.com → google.com.hk)。
 * 所以在 goto 之前往当前文档上插一个记号,goto 之后看它还在不在 ——
 * 文档被换掉了记号就没了,那就是真的导航过去了。
 */
const MARK = 'window.__wgMark = 1; "marked"'
// 一次 eval 问两件事:记号还在不在(判有没有换文档)、以及当前文档是不是
// Firefox 的错误页(about:neterror?…&d=<人话原因>)—— 后者是「域名解析不了 /
// 连不上」的确证,比 run_script 吞剩的那句 action dispatch failed 有用得多。
const MARK_CHECK = 'String(window.__wgMark) + "|" + document.documentURI'

/** 从 about:neterror 的 query 里把那句人话原因抠出来。 */
function netError(docURI) {
  if (!/^about:neterror/.test(docURI || '')) return ''
  const m = /[?&]d=([^&]*)/.exec(docURI)
  try {
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '浏览器打不开这个地址'
  } catch {
    return '浏览器打不开这个地址'
  }
}

function assertLanded(c, j, url, opt) {
  const d = j.data || {}
  const out = d.outputs || {}
  const split = (r) => String((r || {}).result || '').split('|')
  // 错误页要先判:goto 这时候可能报成功(浏览器确实"打开"了那张错误页)。
  const err = netError(split(out.mark)[1])
  if (err) die(`打不开 ${url}:${err}`, 2)
  const goto = (d.step_results || []).find((x) => x && x.action === 'goto')
  if (!goto || goto.success !== false) return
  let navigated = split(out.mark)[0] === 'undefined' // 记号没了 = 换文档了
  let after = (out.after || {}).url || ''

  // abort 之后新文档还要几百毫秒才 commit,紧跟着的 eval 会在旧页面上跑,
  // 于是「记号还在」这一眼是假的。实测:从一个错误页 goto google.com,脚本里判成
  // 没动,隔一会儿再看已经停在 google.com.hk 了。所以只在**疑似失败**时补一次确认
  // ——成功路径上一次往返都不多花。
  if (!navigated) {
    const j2 = cnbAction(
      c,
      {
        action: 'run_script',
        name: 'webgrab-recheck',
        on_error: 'continue',
        steps: [
          { action: 'sleep', duration: 2 },
          { action: 'eval', expression: MARK_CHECK, output_id: 'mark' },
          { action: 'get_page_info', output_id: 'after' },
        ],
      },
      opt,
      true
    )
    const o2 = (j2.data || {}).outputs || {}
    const err2 = netError(split(o2.mark)[1])
    if (err2) die(`打不开 ${url}:${err2}`, 2)
    navigated = split(o2.mark)[0] === 'undefined'
    after = (o2.after || {}).url || after
  }

  if (navigated) {
    process.stderr.write(`[goto 报了 ${goto.error},但文档已经换成 ${after} —— 按到位处理]\n`)
    return 'late' // 页面是事后才 commit 的 → 之前那份产出取自旧页面,调用方得重取
  }
  die(
    `goto 失败(${goto.error}),而且浏览器没离开原来那页(还在 ${after || '上一页'})。\n` +
      `  这时候的正文是上一页的,不是 ${url} 的。单独发一次\n` +
      `  不要原样重试。先用 cnb status 检查网关；确需诊断导航时，只单独执行一次\n` +
      `  \`cnb do '{"action":"goto","url":"…","timeout":30,"retry_count":0}'\`，timeout 单位为秒。`,
    2
  )
}

function cnbEmit(text, opt) {
  if (opt.out) {
    writeFileSync(opt.out, text.endsWith('\n') ? text : text + '\n')
    process.stderr.write(`→ ${opt.out}\n`)
  } else process.stdout.write(text.endsWith('\n') ? text : text + '\n')
}

function cmdCnb(sub, pos, opt) {
  const c = cnbConfigOrDie()

  if (sub === 'start') {
    const j = cnbStart(c)
    return void cnbEmit(JSON.stringify(j, null, 2), opt)
  }
  if (sub === 'status') {
    const r = cnbCurl(c, { path: '/gw/status', timeout: 60 })
    if (r.status >= 400) cnbFail(r, tryParse(r.body))
    return void cnbEmit(String(r.body), opt)
  }
  if (sub === 'do') {
    // 原样透传一个动作 JSON。'-' 读 stdin,'@f' 读文件 —— 长脚本别塞进 argv。
    let raw = pos[0] || die('缺动作 JSON;例:webgrab cnb do \'{"action":"get_page_info"}\'')
    if (raw === '-') raw = readFileSync(0, 'utf8')
    else if (raw.startsWith('@')) raw = readFileSync(raw.slice(1), 'utf8')
    const obj = normalizeCnbAction(tryParse(raw), opt)
    const j = cnbAction(c, obj, opt)
    return void cnbEmit(JSON.stringify(j.data ?? j, null, 2), opt)
  }
  if (sub === 'text' || sub === 'html') {
    const url = pos[0] || die('缺 url')
    // 默认 domcontentloaded + 不重试 + 30s:networkidle 在广告埋点多的站上永远等不到,
    // 而 goto 上游默认 retry_count=1,30s×2 正好撞穿网关那 60 秒(实测机器之心)。
    // on_error:continue 是配套的 —— 页面 readyState 还是 loading 时正文往往已经在了。
    const tail = [
      ...(opt.selector
        ? [{ action: 'wait_for_element', selector: opt.selector, state: opt.attached ? 'attached' : 'visible', timeout: opt.selTimeout }]
        : []),
      ...(opt.settle ? [{ action: 'sleep', duration: opt.settle }] : []),
      { action: sub === 'html' ? 'get_html' : 'get_text', output_id: 'body' },
    ]
    const steps = [
      { action: 'eval', expression: MARK },
      {
        action: 'goto',
        url,
        wait_until: opt.wait || 'domcontentloaded',
        timeout: opt.navTimeout,
        retry_count: 0,
      },
      { action: 'eval', expression: MARK_CHECK, output_id: 'mark' },
      { action: 'get_page_info', output_id: 'after' },
      ...tail,
    ]
    let j = cnbAction(
      c,
      { action: 'run_script', name: `webgrab-${sub}`, on_error: 'continue', steps },
      opt,
      true
    )
    if (assertLanded(c, j, url, opt) === 'late') {
      process.stderr.write('[页面是晚到的,重取一次正文]\n')
      j = cnbAction(
        c,
        { action: 'run_script', name: `webgrab-${sub}-again`, on_error: 'continue', steps: tail },
        opt,
        true
      )
    }
    const o = (j.data && j.data.outputs && j.data.outputs.body) || {}
    const text = o.text ?? o.html ?? JSON.stringify(o)
    if (sub === 'text' && o.length >= 10000) {
      // 上游硬截断在 10000 字符,不说一声的话会当成「这页就这么长」。
      process.stderr.write('[get_text 截断在 10000 字符;要全文用 cnb html 或 eval 精确取]\n')
    }
    return void cnbEmit(text, opt)
  }
  if (sub === 'shot') {
    if (!opt.out) die('shot 返回 PNG,必须给 --out <文件.png>')
    const url = pos[0]
    if (url) {
      const steps = [
        { action: 'eval', expression: MARK },
        { action: 'goto', url, wait_until: opt.wait || 'domcontentloaded', timeout: opt.navTimeout, retry_count: 0 },
        ...(opt.selector
        ? [{ action: 'wait_for_element', selector: opt.selector, state: opt.attached ? 'attached' : 'visible', timeout: opt.selTimeout }]
        : []),
        ...(opt.settle ? [{ action: 'sleep', duration: opt.settle }] : []),
        { action: 'eval', expression: MARK_CHECK, output_id: 'mark' },
        { action: 'get_page_info', output_id: 'after' },
      ]
      const jj = cnbAction(c, { action: 'run_script', name: 'webgrab-shot', on_error: 'continue', steps }, opt, true)
      assertLanded(c, jj, url, opt)
    }
    const which = opt.desktop ? 'desktop' : 'browser'
    const wh = opt.wh || '512' // 全分辨率图非常费 token,默认缩到 512
    const r = cnbCurl(c, {
      path: `/screenshot/${which}?whLargest=${encodeURIComponent(wh)}`,
      out: opt.out,
      timeout: opt.timeout,
    })
    if (r.status >= 400) die(`HTTP ${r.status}(错误正文在 ${opt.out} 里)`, 2)
    return void process.stderr.write(`→ ${opt.out}\n`)
  }
  die(`未知 cnb 子命令 ${sub};可用: start status text html shot do`)
}

// ── args ─────────────────────────────────────────────────────────────────────

const HELP = `webgrab —— 抓直接 curl 抓不到的网页

  webgrab plain <url> [--ua S] [--noproxy] [--out F]
  webgrab jina  <url> [--plain] [--cache] [--out F]
  webgrab cf <action> <url> [选项]      (后备:无状态渲染,已不是首选)
  webgrab cnb <start|text|html|shot|do|status> [url] [选项]
  webgrab actions                      列出 CF 的 action

cf action: ${CF_ACTIONS.join(' ')}

通用: --out F 写当前 workspace 的相对路径；父目录须已存在。
      --timeout N 秒是整条命令总时间(含冷启动与重试，默认 120；冷启动可显式给 180)。
jina: --plain 只关闭浏览器引擎请求头，返回的仍是阅读器文本，不是原始 HTML。
cf:   默认用 Kitesurf(轻量、省额度)。要视频/WebGL/bot 挑战握手才加 --chromium
      --wait networkidle0|networkidle2|load|domcontentloaded   SPA 必给
      --selector CSS   等某个元素出现(比 networkidle0 快)
      --ua S / --cookies JSON / --extra JSON(合并进请求体)
      --prompt S | --schema F.json (json)
      --raw 打印原始响应   --dry-run 只打印将要发的请求(token 打码)
cnb:  远程真实浏览器,有状态(cookie/登录态跨请求保留),串行,冷启动一两分钟。
      start 预热(503 就自己重试到 ready)  status 网关诊断
      text/html <url>  goto 后取正文/源码(text 上游截断 10000 字符)
      shot [url] --out x.png [--desktop] [--wh 512]
      do '<动作JSON>' | do @f.json | do -    goto timeout 单位为秒，默认 30，retry_count 默认 0
      --wait domcontentloaded(默认)|load|networkidle   networkidle 慢站等不到
      --nav-timeout 30  --sel-timeout 15   两者相加要留在网关 ~60s 硬顶内
      --selector CSS 等元素;默认等 visible,命中隐藏元素会白等 → 加 --attached
      --settle N   取正文前再等 N 秒(懒加载列表用它,比猜 selector 省事)
      goto 报 abort 不一定是失败(跳转链):脚本靠文档记号判,晚到会自动重取正文
      完整动作表: /runtime/bin/skills/webgrab/cnb-browser.md
`

function parse(argv) {
  const opt = { timeout: 120 }
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const takes = {
      '--out': 'out', '--ua': 'ua', '--wait': 'wait', '--selector': 'selector',
      '--prompt': 'prompt', '--schema': 'schema',
      '--extra': 'extra', '--cookies': 'cookies',
      '--html': 'html', '--timeout': 'timeout', '--goto-timeout': 'timeoutMs',
      '--wh': 'wh', '--nav-timeout': 'navTimeout', '--sel-timeout': 'selTimeout',
      '--settle': 'settle',
    }
    const flags = {
      // kitesurf 是默认,所以 --kitesurf 留着只为向后兼容,是个空开关
      '--kitesurf': 'kitesurfNoop', '--chromium': 'chromium', '--no-kitesurf': 'chromium',
      '--raw': 'raw', '--dry-run': 'dryRun', '--plain': 'plain', '--cache': 'cache',
      '--noproxy': 'noproxy', '--reject-css': 'rejectCss', '--desktop': 'desktop',
      '--attached': 'attached',
    }
    if (takes[a]) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) die(`${a} 缺少参数`)
      opt[takes[a]] = argv[++i]
    }
    else if (flags[a]) opt[flags[a]] = true
    else if (a === '-h' || a === '--help') opt.help = true
    else if (a.startsWith('--')) die(`未知选项 ${a}；见 --help`)
    else pos.push(a)
  }
  for (const [key, flag, fallback, min, max] of [
    ['timeout', '--timeout', 120, 0.1, 600],
    ['navTimeout', '--nav-timeout', 30, 0.1, 120],
    ['selTimeout', '--sel-timeout', 15, 0.1, 120],
    ['settle', '--settle', 0, 0, 120],
    ['timeoutMs', '--goto-timeout', undefined, 1, 120000],
  ]) {
    if (opt[key] === undefined && fallback === undefined) continue
    const value = Number(opt[key] ?? fallback)
    if (!Number.isFinite(value) || value < min || value > max) die(`${flag} 范围为 ${min}–${max}${key === 'timeoutMs' ? ' 毫秒' : ' 秒'}`)
    opt[key] = value
  }
  return { opt, pos }
}

function normalizeCnbAction(obj, opt) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) die('动作 JSON 必须是对象')
  function visit(value) {
    if (!value || typeof value !== 'object') return
    if (['goto', 'new_tab', 'refresh'].includes(value.action)) {
      value.timeout ??= opt.navTimeout
      if (typeof value.timeout !== 'number' || !Number.isFinite(value.timeout) || value.timeout < 0.1 || value.timeout > 120) die('CNB goto timeout 使用秒，范围 0.1–120；建议 timeout:30、retry_count:0，不要传 30000 毫秒')
      value.retry_count ??= 0
      value.wait_until ??= 'domcontentloaded'
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(obj)
  return obj
}

function checkOutput(path) {
  try {
    accessSync(dirname(resolve(path)), constants.W_OK)
    if (existsSync(path)) {
      if (!statSync(path).isFile()) die(`输出路径不是普通文件：${path}`)
      accessSync(path, constants.W_OK)
    }
  } catch (error) {
    die(`输出路径不可写：${path}（${error.code}）。请使用当前 workspace 的相对路径，并先创建父目录。`)
  }
}

const { opt, pos } = parse(process.argv.slice(2))
const cmd = pos.shift()
if (opt.help || !cmd) {
  process.stdout.write(HELP)
  process.exit(opt.help ? 0 : 1)
}
deadline = Date.now() + opt.timeout * 1000
if (opt.out) checkOutput(opt.out)
if (cmd === 'actions') {
  process.stdout.write(CF_ACTIONS.join('\n') + '\n')
} else if (cmd === 'plain') {
  cmdPlain(pos[0] || die('缺 url'), opt)
} else if (cmd === 'jina') {
  cmdJina(pos[0] || die('缺 url'), opt)
} else if (cmd === 'cnb') {
  cmdCnb(pos.shift() || die('缺子命令;可用: start status text html shot do'), pos, opt)
} else if (cmd === 'cf') {
  const action = pos.shift() || die('缺 action')
  cmdCf(action, pos[0], opt)
} else {
  die(`未知子命令 ${cmd};看 webgrab --help`)
}
