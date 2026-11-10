> 这是 skill **webgrab** 的 `cnb` 通道的完整动作参考,不是独立 skill。
> 什么时候该用它、怎么起手,看 [SKILL.md](SKILL.md);这里是动作表和坑。
> 命令行封装:`webgrab cnb <start|status|text|html|shot|do>`,
> 它替你带 token、撞上冷启动自动重试、run_script 的两层 success 也替你判过了。


# cnb-browser

远程浏览器自动化。你通过 `curl` 调一个 HTTP 接口，接口后面是一个**真实的 Firefox 窗口**（Camoufox，带图形界面、跑在虚拟显示器上），不是无头浏览器、也不是 HTML 解析器。

拓扑是三段：

```
你 --curl--> Cloudflare Worker 网关 --转发--> 云端开发空间里的浏览器
```

网关做三件事：按需把开发空间拉起来（空间不是常驻的）、校验你的令牌、拦掉一部分危险动作。你只需要跟网关说话。

## 什么时候用它

**用**：页面内容靠 JavaScript 渲染；需要先登录或维持会话；普通 `curl`/`WebFetch` 拿到的是空壳、验证页或 403；需要真实点击、输入、滚动才能触发的流程。

**不用**：静态 HTML 直接 `curl` 就够了，别绕这一圈——远程浏览器慢得多，而且一次只能处理一个请求。

## 只对授权目标使用

这个浏览器被刻意做得难以被识别为自动化程序。因此只把它指向：

- 你自己拥有或运营的站点
- 你有**书面授权**测试的站点（安全项目、在范围内的漏洞赏金目标）
- 你自己的反爬 / 风控系统，用于回归测试

不要用它绕过第三方站点的访问控制、抓取没有许可的数据、或规避你没有权限规避的限制。`get_text`、`get_html`、`eval` 一次就能把整页内容和 DOM 结构取走——只取当前任务真正需要的部分。

## 准备

凭据放 `/user/cnb/browser.env`，chmod 600。`webgrab cnb` 自动读取，不把 token 写进命令参数。
本参考中的动作都通过入口执行：

```bash
WG=/runtime/bin/skills/webgrab/webgrab
P() { "$WG" cnb do "$1" --timeout 45; }
"$WG" cnb status --timeout 15
```

首次访问可用 `"$WG" cnb start --timeout 180` 预热，也可以直接执行目标动作。
冷启动和重试共享命令总超时；超时后报告当前状态，不无限循环直到 ready。
动作 JSON 中 timeout 单位为秒；导航默认 30 秒、retry_count 默认 0。

## 调用约定

所有浏览器动作都是同一个形状——`POST /`，请求体是一个带 `action` 的 JSON：

```bash
P '{"action":"goto","url":"https://example.com","timeout":30,"retry_count":0}'
```

响应固定是：

```json
{"success": true, "timestamp": 1757000000.0, "data": {...}}
{"success": false, "timestamp": 1757000000.0, "error": "错误描述"}
```

**先看 `success`。** HTTP 状态码是 200 不代表动作成功——动作层面的失败（元素找不到、超时）走的是 `success:false` + `error`。

反过来有一个例外要记住：`goto` 报 `NS_ERROR_ABORT` / `NS_BINDING_ABORTED` 时页面往往已经打开了，判断要靠 `get_page_info` 而不是这个 `success`。见「出错了怎么办」。

## 最常用的一套

拿一个 JS 渲染页面的正文：

```bash
P() { "$WG" cnb do "$1" --timeout 45; }

P '{"action":"goto","url":"https://example.com","wait_until":"domcontentloaded"}'
P '{"action":"get_text"}'
```

带登录的流程：

```bash
P '{"action":"goto","url":"https://example.com/login"}'
P '{"action":"fill","selector":"#username","value":"alice"}'
P '{"action":"fill","selector":"#password","value":"..."}'
P '{"action":"click","selector":"button[type=submit]"}'
P '{"action":"wait_for_url","url":"**/dashboard**"}'
P '{"action":"get_text"}'
```

浏览器是**有状态且长期存活**的：cookie、登录态、打开的标签页会一直保留到空间被回收，下一个请求接着用。不需要每次重新登录。

## 动作参考

参数表里 `required` 的必须给，其余可选。

### 导航

| 动作 | 参数 |
| --- | --- |
| `goto` | `url`(required)、`wait_until`（`domcontentloaded` 默认 / `load` / `networkidle`）、`referer`、`timeout`（秒，默认 30）、`retry_count`（0-2，默认 1）、`retry_delay` |
| `refresh` | 同 `goto` 的等待与重试参数 |
| `new_tab` | `url`、`wait_until`、`timeout`、`retry_count`、`retry_delay` |
| `list_tabs` | 无。返回每个标签的 index、URL、是否活跃 |
| `switch_tab` | `index`(required) |
| `close_tab` | `index`（省略则关当前标签） |

`goto` 和 `new_tab` 的 `url` **只能是 http/https**，其它协议被网关拒（原因见「网关拦掉了什么」）。

### 读页面

| 动作 | 参数 |
| --- | --- |
| `get_text` | 无。当前页可见文本，**截断到 10000 字符** |
| `get_html` | 无。完整 HTML 源码，很占 token，优先用 `get_text` |
| `get_page_info` | 无。URL、标题、ready state、视口、滚动位置 |
| `get_element` | `selector`(required，CSS 或 `xpath=...`)。返回标签名、文本、属性、包围盒、是否可见 |
| `get_elements` | `selector`(required)、`limit`（1-100，默认 20） |
| `get_interactive_elements` | `visible_only`（默认 true）。列出按钮/链接/输入框，带坐标和选择器——**不知道该点哪里时先调它** |
| `get_computed_style` | `selector`(required)、`properties`（CSS 属性名数组，最多 50 个） |
| `eval` | `expression`(required)。在页面里执行 JS 并返回结果 |
| `detect_challenge` | `scroll_into_view`（默认 false）。只读地判断当前页有没有人机验证控件，返回 `absent`/`present`/`unknown`。它**不会**去点、去解、去进 iframe |

### 点击与输入

| 动作 | 参数 |
| --- | --- |
| `click` | `selector`(required)。**首选**，快且可靠 |
| `fill` | `selector`(required)、`value`(required)。直接设值，不产生按键事件 |
| `type` | `selector`(required)、`text`(required)、`delay`（每键间隔秒，默认 0.05）。会产生真实按键事件 |
| `send_key` | `key`(required)，如 `"enter"`、`"tab"`、`"escape"`、`"backspace"`、`"ctrl+a"` |
| `system_click` | `x`(required)、`y`(required)、`duration`。OS 级鼠标点击，**必须先调 `calibrate`** |
| `system_type` | `text`(required)、`interval`（默认 0.08）。OS 级键盘输入 |
| `mouse_move` | `x`(required)、`y`(required)、`duration` |
| `mouse_click` | `x`、`y`（省略则点当前位置），绝对屏幕坐标 |
| `calibrate` | 无。测出浏览器窗口偏移，`system_click` 的坐标才准 |

`system_*` 走的是操作系统级输入，页面完全无法区分它和真人；代价是它按屏幕坐标操作，页面一滚动坐标就失效。**默认用 `click`/`fill`/`type`**，只有在被检测拦住时才升级到 `system_*`。

### 滚动与等待

| 动作 | 参数 |
| --- | --- |
| `scroll` | `amount`（负数向下，默认 -3）、`x`、`y` |
| `scroll_to_bottom` | `delay`（步间隔，默认 0.4） |
| `scroll_to_bottom_humanized` | `min_clicks`(默认 2)、`max_clicks`(默认 6)、`delay`(默认 0.5) |
| `wait_for_element` | `selector`(required)、`state`（`visible` 默认 / `hidden` / `attached` / `detached`）、`timeout`（默认 30） |
| `wait_for_text` | `text`(required)、`timeout` |
| `wait_for_url` | `url`(required，支持 glob)、`timeout` |
| `wait_for_network_idle` | `timeout` |
| `sleep` | `duration`（秒，默认 1） |

**优先用 `wait_for_*` 而不是 `sleep`。** 固定睡眠要么白等要么不够。

### 截图

拿图片只有一条路——`GET /screenshot/browser`，直接返回 PNG 字节：

```bash
"$WG" cnb shot --out page.png
"$WG" cnb shot --desktop --out desktop.png
```

`whLargest=512` 把最长边缩到 512 像素，**默认就用它**；全分辨率图非常费 token，只有在需要看清细节时才要。`width`/`height` 也支持。

`browser` 是页面视口，`desktop` 是整个虚拟屏幕（能看到浏览器窗口本身和弹窗）。

> `POST /` 的 `save_screenshot` 动作在这里**只返回尺寸元数据，不返回图片字节**，它的 `path` 参数又被网关禁掉了。所以单独调它没有意义——除非是在 `run_script` 里配 `output_id`（见下）。

### Cookie 与本地存储

| 动作 | 参数 |
| --- | --- |
| `get_cookies` | `urls`（URL 数组，可选，用于过滤） |
| `set_cookie` | `name`(required)、`value`(required)、`domain`、`path`、`expires`、`httpOnly`、`secure`、`sameSite` |
| `delete_cookies` | 无。清空所有 cookie |
| `get_storage` | `type`（`local` 默认 / `session`） |
| `set_storage` | `type`、`key`(required)、`value`(required) |
| `clear_storage` | `type` |

### 对话框

**页面弹出的 `alert` / `confirm` / `beforeunload` 默认被自动"确定"。** 这意味着一个"确认删除？"的弹窗会被直接点掉。

在任何可能弹确认框、而且后果不可逆的操作之前，先关掉自动确认：

```bash
P '{"action":"handle_dialog","accept":false}'   # 只对下一个弹窗生效
```

`handle_dialog` 是**一次性**的，用掉就恢复默认。`accept:true` 加 `text` 可以给 prompt 框填内容。`get_last_dialog` 查最近一次弹窗的类型和文案。

**永远不要**把这个浏览器指向一个「误点确认就会造成真实损害」的站点。

### 日志

`enable_console_log` / `get_console_log` / `clear_console_log` / `getclear_console_log` / `disable_console_log`，网络侧是同一组 `*_network_log`。都不带参数。排查页面报错时先 `enable_console_log`，再复现，再 `get_console_log`。

### 其它

`ping`（返回当前 URL，最便宜的存活检查）、`get_resolution`、`enter_fullscreen` / `exit_fullscreen`、`get_last_download`（只返回下载文件的信息，**文件本身取不出来**）。

`start_recording` / `stop_recording` / `recording_status` 能录屏，但录像存在容器里的 `/recordings`，网关没有下载接口，**你拿不到那个文件**。除非有人能 SSH 进空间，否则别用。

## 多步操作：run_script

把多个动作打成一个请求。整段在同一个浏览器实例上、同一把锁里顺序执行，中途不会被别人插队：

```bash
P '{
  "action": "run_script",
  "name": "extract",
  "on_error": "stop",
  "steps": [
    {"action": "goto", "url": "https://example.com", "wait_until": "domcontentloaded"},
    {"action": "wait_for_element", "selector": "h1"},
    {"action": "get_text", "output_id": "body"},
    {"action": "save_screenshot", "output_id": "shot", "whLargest": 512}
  ]
}'
```

> **`run_script` 的成败要看 `data.success`，不是外层的 `success`。** 外层 `success:true` 只说明"脚本跑完了"，其中某一步失败时它依然是 `true`。判断真实结果：
>
> ```
> {"success": true,                       ← 只代表请求本身没崩
>  "data": {"success": false,             ← 这个才是脚本的成败
>            "steps_executed": 2, "steps_total": 4,
>            "step_results": [...],       ← 逐步结果，失败那步带 error
>            "outputs": {...}}}
> ```
>
> 脚本失败时去 `data.step_results` 里找第一个 `success:false` 的步骤，它的 `error` 就是原因。

- 任何一步加 `output_id`，它的结果落在 **`data.outputs`** 里，键就是 `output_id`。存的是那个动作完整的 `data` 对象——比如 `get_text` 的输出是 `{"text": "...", "length": 129}`，不是裸字符串。
- `save_screenshot` 配 `output_id` 时，输出是 `data:image/png;base64,...` ——这是**在脚本里拿到图片的唯一方式**。很费 token，非必要不用。
- `on_error`：`stop`（默认，第一个失败就停）或 `continue`。

**什么时候用它**：步骤之间有依赖、要减少往返、或者一整段流程必须原子完成。单个动作直接 `POST /` 更简单。

### 控制流

步骤数组里可以放三种控制节点，它们的字段是**严格校验**的，多一个键就整段拒绝执行：

```json
{"if":     {"condition": {...}, "then": [...], "else": [...]}}
{"repeat": {"count": 3, "steps": [...]}}
{"while":  {"condition": {...}, "max_iterations": 10, "steps": [...]}}
```

`count` 和 `max_iterations` 必须是 1-100 的整数——循环**必须**有显式上界；`while` 跑到上界时条件仍为真会显式报错，不会静默结束。嵌套最深 8 层，一个循环体总共最多执行 1000 步。

`condition` 是一个带 `type` 的对象：

| `type` | 字段 | 含义 |
| --- | --- | --- |
| `element` | `selector`(required)、`state`（`visible` 默认 / `hidden` / `attached` / `detached`） | 元素处于某状态 |
| `text` | `text`(required) | 页面上出现这段文字 |
| `url` | `matches`(required，glob) | 当前 URL 匹配 |
| `javascript` | `expression`(required) | 在页面里求值，取布尔结果 |
| `output` | `output_id`(required)、`equals` 或 `exists` **二选一**、`path`（在输出对象里取值的路径） | 检查前面某一步的输出 |
| `all` / `any` | `conditions`（数组） | 与 / 或 |
| `not` | `condition` | 取反 |

最外层的条件可以带 `timeout`（秒，最大 60，条件不成立就轮询等待）；**嵌套在 `all`/`any`/`not` 里的子条件不允许带 `timeout`**。

```json
{"if": {"condition": {"type": "element", "selector": "#cookie-banner", "timeout": 5},
        "then": [{"action": "click", "selector": "#accept"}]}}
```


## 网关拦掉了什么

这些动作会返回 `403` + `{"success":false,"error":"gateway policy: ..."}`。不是 bug，别绕：

| 被拒 | 为什么 | 替代做法 |
| --- | --- | --- |
| `upload_file` | 能把容器里任意可读文件塞进网页文件框，等于文件外传 | 无 |
| `close` | 直接把浏览器进程干掉 | 不需要；空间会自己回收 |
| `save_screenshot` 带 `path` | 往容器里任意路径写文件 | `GET /screenshot/browser`，或脚本里用 `output_id` |
| `set_virtual_media_source`、`upload_virtual_media` | 虚拟摄像头/麦克风，这套部署没启用 | 无 |
| `run_script` 的 `"yaml": "..."` 形式 | 网关没有 YAML 解析器，审查不了内容 | 用 `"steps": [...]` |
| 任何字符串里的 `${env.` | 上游会把它替换成容器的环境变量值 | 无 |
| `goto` / `new_tab` 到非 http(s) 地址 | `file://` 能读出浏览器 profile（含会话 cookie）；`about:` 是特权页面 | 无 |

## 出错了怎么办

先看返回体里的 `error` 字段。

| 现象 | 含义 | 做什么 |
| --- | --- | --- |
| `401 UNAUTHORIZED` | 令牌缺失或不对 | 检查 owner 的 `/user/cnb/browser.env`；由入口自动带 token |
| `403` + `gateway policy:` | 撞上上面那张表 | 换做法，别重试 |
| `503 WORKSPACE_STARTING` | 空间正在拉起，`stage` 是当前阶段 | 等十几秒重试，直到成功。冷启动一百多秒是正常的 |
| `503 WORKSPACE_UNREACHABLE` | 空间中途没了 | 直接重试；网关会自动重新发现或拉起 |
| `502 CNB_API_*` | 网关调不动云平台 | 不是你能修的，报告给维护的人 |
| `404 NOT_FOUND` | 路径不在白名单 | 转发到浏览器的只有 `/`、`/state`、`/health`、`/screenshot/browser`、`/screenshot/desktop`；`/healthz` 和 `/gw/*` 由网关自己处理，不进浏览器 |
| `success:false` + `error` | 动作本身失败（选择器没匹配到、超时……） | 先 `get_page_info` 看现在在哪一页，再 `get_interactive_elements` 看有什么能点 |
| `goto` 报 `NS_ERROR_ABORT` / `NS_BINDING_ABORTED` | 导航被取消，**不代表页面没打开** | 先 `get_page_info`，URL 和标题对得上就当成功，别重试（见下） |
| 外层 `success:true` 但 `run_script` 没效果 | 脚本里某一步失败了 | 看 `data.success` 和 `data.step_results` |

`goto` 的这两个错值得单独说，因为它们最容易被当成「打不开」而白白重试或换方案：

- **跳转链**。目标站点连续跳几次时，最初那次导航会被后来的顶掉，`goto` 于是以
  abort 结束，而浏览器已经停在跳转终点上了。`https://www.google.com/` 是个现成
  例子：它会按出口所在地区跳到对应的国家站点，`goto` 报 `NS_ERROR_ABORT`，
  而 `get_page_info` 返回的是跳转后的 URL、标题 `Google`，正文也在。
- **没有内容可导航**。返回 `204`、或者直接触发下载的 URL，浏览器不会离开当前页，
  同样以 abort 结束。这类地址本来就不该用 `goto` 打开。

结论：**`goto` 失败之后先看 `get_page_info`，再决定要不要重试。** 拿到的 URL 是
跳转终点、标题也正常，就说明已经到位了。

卡住时的两个诊断入口：

```bash
"$WG" cnb status --timeout 15   # 空间状态、上次失败原因、noVNC 地址
"$WG" cnb do '{"action":"get_page_info"}' --timeout 15 # 浏览器页面状态
```

`/state` 的 `status` 是 `ready` 就说明浏览器活着。但它的 `url` 和 `title` 字段经常是空的（`ping` 返回的 `url` 同理），**别拿它判断当前在哪一页**——那个要用 `get_page_info`。

`/gw/status` 返回的 `vncUrl` 可以在浏览器里打开，**用眼睛看**那个远程浏览器现在停在哪一屏。它需要一组单独的用户名密码，问部署这套东西的人。

## 必须知道的几件事

- **请求是串行的。** 浏览器一次只处理一个请求，并发发过去也是排队。想减少往返就用 `run_script`。
- **状态跨请求保留，但不跨空间重建。** 空间被回收（长时间无人用，或到达运行时长上限）后重新拉起的是一个全新的浏览器：cookie、登录态、标签页全部归零。长流程做完及时把结果取走。
- **`get_text` 截断在 10000 字符。** 长页面用 `get_elements` 或 `eval` 精确取你要的那块，别指望一次拿全。
- **文件出不来。** 下载的文件、录的屏都留在容器里，网关只能返回 JSON 和截图 PNG。
- **不要用 MCP 端点。** 网关也转发 `/mcp/`，但这份说明覆盖的是 HTTP 接口，两者能力相同，混用只会让你困惑。
- **令牌就是全部权限。** 拿到它的人能完全控制这个浏览器，也能停掉空间。不要把它写进代码、日志或提交里。

---

动作语义来自上游项目 [psyb0t/docker-stealthy-auto-browse](https://github.com/psyb0t/docker-stealthy-auto-browse)（WTFPL），本文对着固定构建的 `87154cf` 核对过，并按网关的裁剪做了删改。上游完整动作表见该仓库 `.agents/skills/stealthy-auto-browse/SKILL.md`；本文没写的动作，网关同样会转发，但参数请以上游为准。
