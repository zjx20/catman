---
name: webgrab
description: 获取网页正文、原始 HTML、截图，或使用远程真实浏览器处理 JS、登录和交互。用户要求访问链接、读取文章、使用浏览器，或普通抓取遇到反爬/空壳时使用。会员内容仍需要合法访问权限。
---

# 网页抓取与浏览器

先确定用户要的是正文、浏览器访问还是交互。不要把一次访问请求变成长时间搜寻全文。

## 执行目录与入口

```bash
WG=/runtime/bin/skills/webgrab/webgrab
"$WG" --help
```

产物默认写**当前 workspace 的相对路径**，例如 `article.md`、`page.html`。
父目录要先创建。个人长期文件放 `/user`，跨会话产物放 `/user/artifacts`。
公共 skill 及参考资料只读。不要写旧全局临时目录，也不要请求增加宿主挂载。

大页面用 `--out` 保存，再分段读取。不要把整个 HTML 灌进上下文。
命令失败就先读错误；不要接 `| tail`、`| head` 或 `; wc ...` 覆盖退出状态。
需要裁剪日志时先保存退出码，检查成功后再读取文件。

## 选择通道

| 用户需要 | 首选 | 边界 |
|---|---|---|
| 静态 HTML、RSS、JSON、原始字节 | `plain` | 不执行 JS；403 后换通道，不换 UA 反复试 |
| 文章正文、Markdown | `jina` | 返回第三方阅读器结果；可能只有预览，不代表真实浏览器访问成功 |
| 明确要求浏览器、JS 渲染、登录、截图、点击填表 | `cnb` | 远程 Firefox，有状态、串行；冷启动可能需要一两分钟 |
| cnb 不可用，或需要 PDF/结构化 JSON | `cf` | 无状态、有额度限制；Medium 需要 `--chromium`，仍无法获得无权限的会员正文 |

用户明确要求真实浏览器时先用 cnb。若改用 jina，说明是降级到阅读器，不要混报结果。
网络默认继承代理；只有已知需要直连的国内站才用 `plain --noproxy`。
外站连接失败时先查代理配置，不要盲目关闭代理再等一分钟。

```bash
"$WG" plain https://example.com --timeout 30 --out page.html
"$WG" jina 'https://medium.com/@author/article-id' --timeout 45 --out article.md
"$WG" cnb text https://example.com --timeout 180 --out article.txt
"$WG" cnb html https://example.com --selector article --timeout 180 --out page.html
"$WG" cnb shot https://example.com --timeout 180 --out page.png
```

`jina --plain` 只是关闭浏览器引擎请求头，**仍返回阅读器文本，不是原始 HTML**。
原始 HTML 使用 plain 或 cnb html。jina 会编码完整目标 URL，避免丢失 query；默认禁用缓存。

## 超时和停止条件

- `--timeout N` 单位为**秒**，限制整条命令，包括冷启动、请求、重试和内部诊断。
  默认 120 秒；cnb 冷启动可显式给 180 秒。不要不断拉长超时重跑同一条命令。
- 简单读文章通常一次获取、至多一次有理由的备用通道即可。
- 看到会员墙/截断且没有公开的授权链接，就报告只能拿到预览。
  除非用户明确要求继续找，不自动搜索存档、RSS、翻译代理和各种镜像。
- cnb 导航失败，先查一次当前页面和网关；页面仍是 `about:blank` 或错误页时停止导航重试。
  不要把同一条 `html` 换成 `text` 再完整导航一次。
- 冷启动或诊断预计超过一分钟，先向用户交代正在等待什么。
- 真正需要后台运行时，使用当前容器的任务管理器并指定硬超时：

```bash
catman-task run --timeout 180 -- "$WG" cnb text https://example.com --timeout 170 --out article.txt
```

catman-task 继承当前 cwd、环境和挂载。cron 使用 owner 的独立固定 workspace，
同样可以读取 owner 的 `/user`；不需要复制凭据或自行配置 Docker。

## cnb 动作与诊断

```bash
"$WG" cnb status --timeout 15
"$WG" cnb do '{"action":"get_page_info"}' --timeout 15
"$WG" cnb do '{"action":"goto","url":"https://example.com","timeout":30,"retry_count":0}' --timeout 45
```

动作 JSON 中 `timeout` 同样使用**秒**，不要填 `30000`。goto/new_tab/refresh
默认补上 `timeout:30`、`retry_count:0`、`wait_until:domcontentloaded`。
`networkidle` 在广告/埋点多的站点常常等不到，不作为默认等待条件。
导航、选择器和 settle 的累计等待应留在网关约 60 秒内。

`text`/`html` 自动验证是否切换到新文档，避免把旧页面当成新结果。
goto 的 abort 有时来自跳转链，必须看页面状态；504 也不保证动作已停止。
如果自动验证仍判定失败，不原样重试。需要原始导航错误时，最多单独诊断一次 goto。
`get_text` 上游最多 10000 字符，截断时用 html 再提取所需片段。

多步动作支持 `cnb do @flow.json` 或 `cnb do -`。JSON 写在 workspace。
完整动作参考：[cnb-browser.md](cnb-browser.md)。token 由脚本读取，不自行拼入 curl 参数。
远程浏览器有跨请求登录态，串行操作；空间被回收后状态可能丢失。

## Cloudflare 后备通道

```bash
"$WG" cf markdown https://example.com --timeout 45 --out article.md
"$WG" cf markdown https://medium.com/example --chromium --timeout 45 --out article.md
"$WG" cf screenshot https://example.com --timeout 45 --out page.png
"$WG" cf pdf https://example.com --timeout 45 --out page.pdf
"$WG" cf json https://example.com --prompt '提取标题和价格'
```

默认 Kitesurf；需要 Chromium 时显式指定。429 时报告额度/限流，不反复重试。
用 `--dry-run` 查看已打码的请求，`--raw` 查看原始响应，`actions` 查看支持的 action。

## 凭据

| 通道 | owner 私有文件 | 环境变量（优先于文件） |
|---|---|---|
| cnb | `/user/cnb/browser.env` | `CNB_BROWSER_URL`、`CNB_BROWSER_TOKEN` |
| cf | `/user/cloudflare/browser-run.env` | `CF_BROWSER_ACCOUNT_ID`、`CF_BROWSER_API_TOKEN` |
| jina | 可选环境变量 | `JINA_API_KEY` |

格式见同目录的 `*.env.example`。真实凭据 chmod 600；不写入公共 skill、输出、聊天或记忆。
公共凭据应由控制面的能力代理保管，不复制给普通用户。
同步参考文档时输出到 `/user/notes/cnb-browser.md`；全局参考资料由管理员更新。

## 对用户说明结果

分别交代：实际使用的通道、是否成功访问、取得全文还是预览、失败原因及保存文件。
“没有找到公开授权链接”不等于“这种链接不存在”；浏览器失败也不等于文章有会员墙。
已经取得预览且无法继续时尽快回复，不堆砌未请求的相关文章。
