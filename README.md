# catman

跑在 OpenWrt / x86 软路由 Docker 里的个人 AI 助手:通过**微信**与之对话,后端是基于
**Claude Agent SDK** 的长驻服务,使用 **Claude 订阅** 计费,能在容器内执行任意命令
(Claude Code 的能力与行为),并带一个 HTTP **dashboard** 查看会话记录、管理接入账号。
**支持多人各自扫码接入**,每人独立的会话上下文与工作目录。

> 个人自用工具。微信侧走腾讯官方 **iLink 协议**(Tencent/openclaw-weixin 所用),合法、
> 出站长轮询、无需公网 IP。

## 能做什么

- 微信里给"ClawBot"联系人发消息 → 助手在容器内执行(如"看下路由器内存占用")并回复
- **即时反馈**:收到消息先回一条"收到,正在处理中…"回执,处理期间转发思考摘要与工具调用
  (如 `🔧 Bash: free -m`),最后发出正式回复;支持撤回的渠道会在回复后撤回回执
  (iLink 协议没有撤回端点,微信里回执会保留)。可用 `CATMAN_ACK` / `CATMAN_PROGRESS` 关闭。
  进度**按 5→15→30→60 秒的阶梯节流**,同一间隔内只发最新那条并标注跳过了几步
  (如 `🔧 Bash: npm test(+4 步)`)—— 原因见 [发送预算](#一个-context_token-的发送预算)
- **会话智能管理**:上下文过长自动压缩(SDK 内置);距上次对话超过 1 小时的新消息自动开新会话;
  超时会尝试推送提醒,发 `/继续` 可延续上一段会话;离开的会话进入每人最多 10 段的历史,
  发 `/切换会话 <会话id>` 可随时切回其中一段 —— 微信只有一个聊天窗,这就是多话题并行的出路
- **硬指令**:`/帮助` `/状态` `/新会话` `/取消` `/继续` `/切换会话` 由后台直接响应,不经过 LLM ——
  所以助手卡住时它们照样管用(见 [硬指令](#硬指令))
- **自助设置**:直接说"换成 sonnet""别刷进度了""超时改成一天",助手会调本机接口改你自己的
  配置(见 [自助设置与管理员](#自助设置与管理员))
- **记录与检索**:完整会话以 JSONL 持久化,dashboard 可浏览、按关键词检索
- **自动清理**:超过 30 天的会话自动删除
- **多人使用**:在 dashboard 上扫码即可接入一位新用户,各自独立的会话与工作目录;
  每个账号只服务扫码绑定的那个人,其他人的来信一律拒绝(见 [多人接入](#多人接入))
- **管理员聊天**:dashboard 自带一个聊天页,那里的对话有管理员权限,可以用大白话改全局配置
  ("把默认模型换成 opus""并发上限调到 5")。聊天记录存在服务端,刷新和重启都还在;
  页面上有一个「开新会话」按钮 —— 它只让助手忘掉上下文,**不清空聊天记录**
- **操作宿主 Docker**:镜像内置 docker CLI + compose 插件,挂载宿主 socket 后可用微信指挥
  "重启 xx 容器"、"看下哪个容器在吃内存"(见下面的 [操作宿主 Docker](#操作宿主-docker最高权限能力))

## 架构

```
微信 App(多人各自扫码)←→ 腾讯 iLink ←(每账号一条出站长轮询)→ catman 容器
  channels/wechat-ilink  多账号连接管理,收发文本
  core/identity          userKey = <渠道>:<账号>:<用户>,全局唯一身份
  core/admission         准入:每个账号只服务绑定的那个人
  core/users             每用户一个工作目录(cwd)
  core/session           会话路由:1h 超时 / /继续 恢复 / /切换会话 历史 / 30 天清理
  core/settings          全局配置层(可运行时改)+ 全部配置项的 schema
  core/prefs             每用户配置层,叠在全局默认之上
  core/commands          硬指令表:不经 LLM、绕过队列的后台直答
  core/turn-tokens       回合级一次性令牌,agent 靠它读写自己的配置
  core/skills            把接口用法写成 skill(按需加载,常态不占 token)
  core/agent             Claude Agent SDK(claude_code preset, bypassPermissions)
  core/gateway           串联各层;同用户串行,跨用户并发但有上限
  channels/composite     多渠道复合,按 userKey 前缀路由
  channels/dashboard     管理员聊天渠道(记录落盘 + SSE 推送)
  dashboard              web:会话 / 检索 / 扫码接入 / 账号管理 / 用户与提权 / 管理员聊天(整站 token)
  /data 卷               Claude 会话 JSONL + 网关状态 + 账号凭据 + 两层配置
```

**配置三层**,由外到内逐级覆盖:

```
环境变量        基线,重启才变
  └─ settings.json   全局运行时覆盖   ← 管理员改
       └─ prefs.json   每用户覆盖     ← 用户自己改
```

读取时逐级回退:某人选的模型不在白名单里 → 退到全局默认 → 再不行退到环境变量 →
最后干脆不指定模型交给 SDK。**所以改配置不需要检查别处**:把某个模型移出白名单时不必去
查谁在用它,读取侧会自己兜住,而那个人的选择留在盘上,模型加回来时自动恢复。

**身份与隔离**:每条消息都带一个 `userKey`(`<渠道>:<账号>:<用户>`)。带上账号这一段是必须的 ——
两份不同的微信凭据下可能出现相同的用户标识,只按用户标识分会让两个人共用同一段上下文和同一个
工作目录。每个 `userKey` 映射到 `/data/workspace/` 下自己的子目录,即该用户的 cwd。

## 前置:两项授权

### 1. Claude 订阅 token(宿主机执行一次)

```bash
npm install -g @anthropic-ai/claude-code   # 或用已装好的 claude CLI
claude setup-token                          # 浏览器授权,输出 1 年期 OAuth token
export CLAUDE_CODE_OAUTH_TOKEN="<上一步输出的 token>"
```

把该 token 放进 `.env`(与 docker-compose.yml 同目录):

```
CLAUDE_CODE_OAUTH_TOKEN=<token>
```

### 2. dashboard 访问令牌

dashboard 上可以扫码把新用户接进来,而接入者拥有宿主 root 级别的能力,所以**整站需要令牌**
(会话记录本身也是敏感内容)。写进 `.env`:

```
CATMAN_ADMIN_TOKEN=<自己生成,如 openssl rand -hex 16>
```

不设也能启动:首次启动会自动生成一个,打印在日志里并写入 `./data/dashboard-token`(0600),
之后重启复用。**没有"无令牌裸奔"这个选项。**

微信账号不在这里配 —— 启动之后在 dashboard 上扫码接入(见下一节)。

## 网络代理

`api.anthropic.com` 在境内多半直连不通,而**容器不会继承宿主或路由器的代理设置** ——
即使软路由上已经有旁路由/透明代理,docker 里也未必走得上。要用代理就在 `.env` 里填:

```
HTTP_PROXY=http://192.168.1.2:7890
HTTPS_PROXY=http://192.168.1.2:7890
```

compose 里已经预留好透传(大小写两份都传,程序之间认哪种并不统一),**不填就是不用代理**,
行为与完全没这回事时一致。

**地址不能写 `127.0.0.1`** —— 在容器里那是它自己的回环地址,不是宿主。填代理机的内网 IP
最稳;代理就跑在 docker 宿主上时可以写 `http://host.docker.internal:7890`
(compose 已配好这个名字到宿主网关的映射)。

### 哪些流量会走代理

| 流量 | |
|---|---|
| Claude API(模型请求) | ✅ 走代理 |
| 助手用 WebFetch 抓网页 | ✅ 走代理(请求由容器本地发起) |
| 助手在 Bash 里跑的命令(`curl` / `git` / `npm` …) | ✅ 走代理,子进程继承环境变量 |
| 助手用 WebSearch 搜索 | ➖ **不经过你的代理**:搜索在 Anthropic 服务端执行,结果随 API 响应回来 |
| Claude 的遥测上报 | ✅ 走代理。代理若是白名单模式记得放行,否则每回合多几次失败重试 |
| 微信 iLink(收发消息、下载图片) | ➖ 不走,见下面的 `NO_PROXY` |

覆盖不到的只有**不读这些环境变量的程序**。catman 自身代码里访问微信服务器用的就是这类
(Node 的 `fetch` 不读代理变量),而那本来就该直连,所以正好合适。

想自己复验:把 `HTTPS_PROXY` 指向一个会打日志的代理,跑一轮对话,看日志里出现了哪些域名。

### `NO_PROXY`:必须绕开代理的地址

默认值已经排除了三类,通常不用动:

- **微信服务器**(`.qq.com`)—— 境内地址,走代理只会更慢甚至不通。
- **本机**(`localhost` / `127.0.0.1` / `::1`)—— **这条不能省**:不排除的话,助手访问本机
  端口上的服务会被送去代理然后失败,包括它访问 catman 自己的 dashboard。
- **内网段**(`10.0.0.0/8` / `172.16.0.0/12` / `192.168.0.0/16`)—— 同理,访问局域网里的
  设备不该绕一圈出去。

要改就在 `.env` 里设 `NO_PROXY=...`。注意它是**整体替换**而不是追加,自定义时上面三类得自己补回。

### 构建镜像时的代理

上面配的是**运行时**。`docker compose build` 阶段要拉 Debian 源、docker.com 和 npm registry,
用的是另一套设置 —— compose 的 `build.args` 已经接上同样的 `.env` 变量,填了就自动生效,
不需要额外做什么。构建期连不上而运行期正常(或反过来)时,记得这是两处独立的设置。

## 启动

```bash
docker compose up -d --build
docker compose logs -f          # 看启动日志(未设令牌时这里能看到自动生成的)
# dashboard: http://<路由器内网IP>:8787/?token=<你的令牌>
```

首次启动还没有任何微信账号,日志会提示去 dashboard 扫码。

> 上面这条命令**只产出本机架构的镜像**。如果构建机与软路由架构不同(典型:x86 开发机 →
> arm64 路由器),见 [构建多架构镜像](#构建多架构镜像)。

## 多人接入

在 dashboard 的**「账号」页**先填一个**备注名**(如「老王的微信」),再点「生成二维码」,
让要接入的人用微信扫码确认。登录成功后连接会立刻建立,**不需要重启**。每接入一个人重复一次。

备注名在扫码**之前**填是有原因的:多个账号的二维码长得一模一样,扫完再回头认"刚才那个是谁"
最容易配错人。留空则用「微信账号 `<id>`」,事后在账号页随时可改(清空即恢复默认名)。

**每个账号只服务一个人。** 绑定采用 TOFU(trust on first use):账号建立后收到的**第一条消息**,
其发送者成为该账号的主人;之后其他人的来信一律拒绝并记录在账号页上。账号页会显示
「已绑定 `<标识>`」供你核对 —— 如果绑错了人,点「解除绑定」后下一条来信会重新绑定。

### 重新扫码(凭据失效 / 换手机)

扫码换来的 `bot_token` 会失效。表现是那个账号**收不到消息了**,账号页上会打出
「凭据已失效,请重新扫码」的红标(日志里对应 `errcode=-14`)。

这时点该账号那一行的**「重新扫码」**,让**同一个人**扫新二维码。凭据换掉,**账号本身与
它服务的用户不变** —— 会话上下文、工作目录、个人配置全都接着用。他之后发的第一条消息
会被认作原主人,不需要任何额外操作。

> ⚠️ 别用「移除账号 + 重新添加」代替它。账号 id 是身份(`<渠道>:<账号>:<用户>`)的一部分,
> 换一个就等于换了个人:过去的会话、工作目录、个人配置全都接不上。
>
> ⚠️ 换**别人**来扫,等于把这位用户的会话与工作目录交给对方 —— 扫码的人就是这个账号之后
> 服务的人。要接入新的人请用「添加账号」。

dashboard 打不开时同样有命令行退路(**仅限主进程没在跑的时候**,见下一节的说明):

```bash
docker compose exec catman node dist/src/scripts/ilink-login.js --rebind <账号id>
```

接入后每个人得到:

| | 隔离情况 |
|---|---|
| 会话上下文 | 各自独立,互不可见 |
| 工作目录(cwd) | `/data/workspace/<每人一个子目录>` |
| 个人偏好 | 各自目录下的 `CLAUDE.md`(自动生成,首行 `@../CLAUDE.md` 引入共享人设) |
| 运行配置 | `prefs.json` 里各自一份(模型、回执、进度、超时、分段长度) |
| 共享人设 | `/data/workspace/CLAUDE.md`,所有人继承 |

新人的**第一条消息**会先收到一份使用指引(硬指令清单 + 能自助改哪些配置),然后才是对
他那条消息的回答。指引只推一次;推送失败会留到下次重试。

> **共享配置放哪**:`CLAUDE.md` 靠 `@` import 继承,而 **project settings
> (`.claude/settings.json`)没有继承机制** —— 要让某项 setting 对所有人生效,
> 得放到 user settings(`$CLAUDE_CONFIG_DIR/settings.json`,即 `./data/claude/settings.json`)。

移除账号只停止收发,**不会删除已有会话记录**(交给 30 天保留期自然清理)。

dashboard 打不开时的退路是命令行扫码,写入同一份 `accounts.json`:

```bash
docker compose exec catman node dist/src/scripts/ilink-login.js "老王的微信"
docker compose exec catman node dist/src/scripts/ilink-login.js --rebind <账号id>
```

> ⚠️ 这条路径下二维码只能以文本形式打印,多数情况下没法直接扫。优先用 dashboard。
>
> ⚠️ 脚本是**另一个进程**在直接改 `accounts.json`,而主进程手里是自己内存里的那一份:
> 它看不到脚本写的内容,并且下一次落盘会把脚本写的覆盖掉。**主进程在跑时请用 dashboard。**

## 硬指令

以 `/` 开头、且整条消息只有指令本身的,由后台直接响应,**不经过 LLM**:

| 指令 | 别名 | 作用 |
|---|---|---|
| `/帮助` | `/help` `/幫助` | 看使用指引 |
| `/状态` | `/status` `/狀態` | 看当前模型、会话空闲时长、各项生效配置(不花额度) |
| `/新会话` | `/new` `/clear` `/新會話` | 丢掉当前上下文重新开始 |
| `/取消` | `/cancel` `/stop` | 中断正在进行的这一轮 |
| `/继续` | `/continue` `/繼續` | 续上刚才的对话,之后直接发消息就是接着聊 |
| `/切换会话 <会话id>` | `/switch` `/切換會話` | 切回指定的旧对话,id 给开头几位即可;只发指令本身则列出最近的对话 |

**为什么要有这层。** 上下文撑爆把助手卡住时,普通消息全都排在那个卡死的回合后面 ——
包括本该救命的那条。所以除 `/继续` 和 `/切换会话` 外的指令都**绕过每用户串行队列**就地执行:
助手卡住时 `/取消` 和 `/新会话` 照样管用,`/状态` 也照样能告诉你现在是什么情况。
`/继续` 和 `/切换会话` 走队列:它们改会话时钟/指针,得排在正在进行的回合之后
才不会被回合结束时写回的状态覆盖 —— 但都不进 LLM,由后台直接确认,不花额度。

**会话切不丢。** `/新会话` 只是把当前对话**归档进历史**(每人最多 10 段,超出挤掉最老的;
超过保留期被清理的会话会自动从清单剔除),不是删除。`/新会话` 的确认语、超时提醒、
`/切换会话` 的确认语都会告诉你切回上一段该发什么;忘了 id 就单发 `/切换会话` 看清单。
临时想问个无关的问题,`/新会话` 切出去、`/切换会话` 切回来,原话题的上下文原样还在。

**只认斜杠形式,没有例外。** 裸词「帮助」「继续」「取消」都不是指令,会正常交给助手 ——
所以「帮助我写个脚本」「继续帮我改」永远不会被后台截胡。代价是这些指令只能从
第一次的使用指引或 `/帮助` 里发现。

## 自助设置与管理员

### 用户改自己的

直接说人话就行:「换成 sonnet」「别刷进度了」「超时改成一天」「忘掉刚才重新开始」。
助手会去调本机的 `/api/me` 接口。能改的:

| 项 | 取值 |
|---|---|
| 模型 | 全局白名单里的别名,默认 `opus` / `sonnet` / `haiku` |
| 回执 | 开 / 关 |
| 进度推送 | 开 / 关 |
| 分段长度 | 200 ~ 5000 字 |
| 会话超时 | 1 分钟 ~ 7 天 |
| 展示名 | dashboard 上显示的名字 |

**凭据是回合级的一次性令牌**:网关在每个回合开始时铸一枚,经环境变量交给子进程,回合一
结束立刻作废。它只解析得出发起该回合的那个用户 —— 接口根本没有「改谁」这个参数,所以
动不了别人的配置。

### 管理员改全局的

打开 dashboard 的**「聊天」页**,那里的对话有管理员权限。可以说:

- 「把默认模型换成 opus」/「把 sonnet 从可用列表里去掉」
- 「并发上限调到 5」/「保留期改成 7 天」
- 「把张三的模型改回默认」/「清掉李四的所有自定义设置」
- 「列出所有账号」/「解绑那个账号」
- 「把张三设为管理员」

### 提权:把管理员权限给某个微信用户

两条路,做的是同一件事(改 `adminUserKeys`):

- **dashboard 的「用户」页** —— 每个用户一行,点「设为管理员 / 取消管理员」。
  同一页还能改他的备注名、一键清空他的全部个人设置。
- **在管理员聊天里说一句** —— 「把张三设为管理员」。

用户在**发来第一条消息**时才登记到这个页面(扫码本身只建账号,还不知道对方是谁)。

> ⚠️ **给某人管理员权限 = 把管理员令牌和 dashboard 的全部写权限(含删账号)交给他。**
> 这不是"稍微高一点"的权限。dashboard 自带的那个内置管理员**不在名单里、也无法移除**,
> 是刻意留的恢复通道 —— 免得名单被清空后谁都改不了配置(页面上那一行没有撤销按钮,
> 接口也会拒绝)。

提权立即生效,不用重启:每个回合现算一次是不是管理员。

### 接口用法是 skill,不是系统提示词

`/api/me` 与管理员接口的用法写在两个 skill 里(启动时生成到
`$CLAUDE_CONFIG_DIR/skills/catman-settings` 与 `catman-admin`),按需加载,常态下几乎不占
token。文件每次启动覆盖写,所以内容永远跟代码同步 —— 别去手改它们。

`catman-admin` 只对管理员回合可见。但**这是上下文过滤而不是沙箱**:普通用户的助手看不到
它的列表项,却仍能用 Read/Bash 读到那个文件。所以 skill 正文里没有任何令牌,只有
`$CATMAN_ADMIN_TOKEN` 这样的环境变量引用 —— 而那个变量只注入管理员回合的子进程。

## 操作宿主 Docker(最高权限能力)

镜像里预装了 **docker CLI 与 compose 插件**(只有客户端,没有 daemon);`docker-compose.yml`
把宿主的 `/var/run/docker.sock` 挂进容器,助手便能操作**宿主的 Docker** —— 即
docker-outside-of-docker,而不是在容器里再跑一个 daemon(那需要 `--privileged`,更危险也更慢)。

### ⚠️ 先明白你交出了什么

有了这个 socket,助手就能 `docker run -v /:/host ...` 挂载并读写**宿主整个文件系统**,
等价于**宿主 root 权限**。开启后**容器不再是隔离边界**,只有"信任这台机器上的助手"这一条约束。
自用软路由上这通常可以接受;不接受就删掉 compose 里那行 socket 挂载 —— 镜像里的 docker CLI
拿不到 socket 就只是个摆设,不影响其它功能。

### 配置:socket 的组 GID

容器以非 root 的 `catman`(uid 10001)运行(`bypassPermissions` 的硬性要求),要读 socket
就得给它一个匹配的**补充组**。该 GID 属于宿主、各机器不同,所以运行时注入而不写死进镜像:

```bash
stat -c '%g' /var/run/docker.sock     # 在宿主执行,拿到 GID
echo "DOCKER_GID=<上一步的数字>" >> .env
docker compose up -d --build
```

不设时默认用 `0`(root 组),适配 socket 属 `root:root` 的系统(OpenWrt 常见);
Debian/Ubuntu 上一般是 `root:docker`(GID 多为 999/998),**必须显式设置**,否则容器内
`docker` 报 `permission denied`。

### 验证

```bash
docker compose exec catman docker ps        # 能列出宿主容器即通
docker compose exec catman docker compose version
```

若报 `client version is too new`,说明宿主 dockerd 比容器内 CLI 老太多,
用宿主 `docker version --format '{{.Server.APIVersion}}'` 的值设 `DOCKER_API_VERSION` 锁定协商版本。

### 一个必然会踩的坑:`-v` 的路径是宿主的

命令在容器里发出,**执行在宿主的 daemon 上**,所以 `-v`/`--mount` 左边的路径由宿主解析,
与容器内看到的文件系统无关。助手在容器里看到 `/data/foo`,写 `docker run -v /data/foo:/x`
挂到的是**宿主**的 `/data/foo`(多半不存在,Docker 还会默默建一个空目录)。
要把 catman 自己的数据传给新容器,得用宿主侧的真实路径(本仓库的 `./data`),
或者干脆用 `docker cp` / 命名卷绕开。这一条值得写进 `/data/workspace/CLAUDE.md` 提醒助手。

## M0 验证清单(首次部署务必先走一遍)

iLink 的部分底层常量只能在真机联调确认,先按此顺序验证、失败即止损:

1. **Claude 通路**:进容器非 root 跑通
   `docker compose exec catman node -e "import('./dist/src/core/agent.js')"` 之类,或直接发一条微信消息看是否回复。
2. **iLink 扫码**:dashboard「账号」页能拿到二维码,扫码后账号出现在列表里。
   两个端点已真机验证可用,行为与字面直觉不同的两点已在代码里处理:
   - `get_bot_qrcode` 的 `qrcode_img_content` **是授权 URL 文本,不是图片**(尽管名字里有 img),
     二维码由 `src/dashboard/qrcode.ts` 自己编码(纯 TS,零依赖)。
   - `get_qrcode_status` 是**长轮询**,无人扫码时阻塞约 30 秒返回 `status:"wait"`。
3. **收发文本**:微信发消息能收到、能回复(回复依赖入站消息的 `context_token`)。
4. **⚠️ 主动推送(关键待验证)**:iLink 协议设计上**不支持主动推送**(回复必须带 `context_token`)。
   因此"超时提醒"很可能推送失败——这是已知的,网关会**自动降级**:提醒推送失败时不报错,
   用户下次发消息仍按会话规则处理(不是 `/继续` 就开新会话)。若你需要可靠的主动提醒,
   后续接入钉钉 Stream 通道(见 v2 计划)。

## 一个 context_token 的发送预算

iLink 的回复必须带上入站消息的 `context_token`,而**同一个 token 能发的消息数是有限的**。
真机实测:第 11 条起 `sendmessage` 返回 `ret=-2 prepare failed`,并且**永不恢复** ——
不是限流(限流会放行),是这个 token 彻底作废。之后连正式回复都发不出去,
用户那边只收到最初那句"收到,正在处理中…",然后彻底静默。

```
send #10(前 9 条成功) ctx龄=28275ms  → ok
send #11(前 10 条成功) ctx龄=37798ms → 失败 ret=-2 prepare failed
send #12 … #23                       → 全部失败
```

**是条数上限,不是时效**。另一次记录里同一个 token 用到 4 分钟仍然正常:

```
send #7(前 6 条成功) ctx龄=239780ms 259字 → ok
```

差别只在条数(7 条 vs 10 条),与 token 存活多久无关。也不是限流 —— 限流会放行,
而上面那次在首次失败后 45 秒仍然全败。

这条预算怎么花:

| 用途 | 条数 |
|---|---|
| 收到回执 | 1 |
| 进度推送 | 最多 5(`MAX_PROGRESS_PER_TURN`) |
| 正文 | 预留 1(超过 `maxReplyChars` 分段时,后面几段仍可能超预算) |
| 会话空闲提醒 | 预留 1 |

超时提醒必须单独占一格:它的前提就是用户没再发消息,而 `context_token` 只在收到新消息时
更新 —— 所以它用的还是上一个回合那份额度。进度把额度吃光,这条提醒就再也发不出去。

进度的两道闸门缺一不可:**间隔阶梯**(5→15→30→60 秒)防止密集刷屏,**总条数上限**
防止长回合靠 60 秒一条把额度慢慢耗完 —— 阶梯本身并不限制总数。额度用尽时最后一条
进度会附一句「进度就报到这儿,接下来直接等答案」,免得那段静默被当成卡死。

排查时打开 `CATMAN_ILINK_TRACE=1`,每条发送会打一行:

```
08-01 18:32:15.123 [ilink:<账号>] send #3(前 2 条成功) ctx龄=50053ms 27字 → ok
```

三个量分别对应「第几次发送」「成功过几条」「拿到 token 到现在多久」——
失败行无条件打印(不受 TRACE 开关影响),因为回执与进度的失败在网关那层是被吞掉的。

所有日志都带 `MM-DD HH:mm:ss.SSS` 前缀。容器**不会**自动继承宿主时区,不设就是 UTC,
和微信里的消息时间对不上;在 `.env` 里设 `TZ=Asia/Shanghai` 之类即可。

## App 标识:无需申请

iLink 的 `iLink-App-Id` 在官方 openclaw-weixin 包里固定为 `"bot"`(所有实例共用),
`iLink-App-ClientVersion` 只是包版本号的编码,都**不是需要去后台注册的凭证**。
唯一属于你个人的凭据是**扫码换来的 `bot_token`**,即上面的登录步骤。这两个内置值已写好默认,
仅在官方包升级或真机校准时才需用 `ILINK_APP_ID` / `ILINK_APP_VERSION` 覆盖。

## 待真机校准的细节

`src/channels/ilink-protocol.ts` 顶部列出:`SKRouteTag` 来源、`base_info.channel_version` 取值、
限流阈值。均可用环境变量调整。

扫码登录的两个端点(`get_bot_qrcode` / `get_qrcode_status`)**已真机验证**,
实测行为记在同一处的注释里。

## 本地开发

```bash
npm install
npm run typecheck
npm test                        # 身份 / 会话 / 网关 / 准入 / transcript / dashboard 单测
CATMAN_CHANNEL=stdin CATMAN_DATA_DIR=./data CATMAN_ADMIN_TOKEN=devtoken \
  CLAUDE_CODE_OAUTH_TOKEN=<token> npm run dev   # stdin 通道,终端直接聊
```

stdin 通道支持 `/user <名字>` 切换身份,因此**多用户隔离可以完全脱离微信在本地验证**:
切到不同名字发消息,能看到各自独立的工作目录与会话。

## 构建多架构镜像

`docker compose up -d --build` 只出**构建机自己那个架构**的镜像。软路由是 x86_64 的话就地
构建即可,这一节可以跳过;若目标是 arm64 设备(NanoPi R4S/R5S、树莓派、各类 ARM NAS)而你
在 x86 机器上构建,直接把镜像搬过去会在启动时报 `exec format error`。

### 一条必须遵守的约束:`npm ci` 要跑在目标架构下

Agent SDK 把 claude 二进制拆成一组 **optionalDependencies**
(`@anthropic-ai/claude-agent-sdk-<os>-<arch>[-musl]`),`npm ci` 按**执行安装的那个容器**的
`process.arch` 与 libc 挑一个装下来。由此:

- 构建**必须**让 `npm ci` 在目标平台下执行 —— buildx + QEMU 模拟,或一台原生 arm64 builder。
  Dockerfile 是多阶段的,进最终镜像的是**运行时阶段**那次 `npm ci --omit=dev`,这条约束
  至少约束它(build 阶段的 node_modules 不发货,理论上可交叉,目前两个阶段都跑目标平台)。
- **不要**给运行时阶段加 `FROM --platform=$BUILDPLATFORM` 那套交叉编译提速。TypeScript
  编译本身确实与架构无关,但那一层的 `npm ci` 会装成**构建机**的架构:镜像能构建成功、
  `tsc` 产物也正常,只有真正去起 agent 时才炸。这个坑不会在构建期暴露,别顺手"优化"掉。
- 基础镜像是 `node:22-bookworm-slim`(glibc),因此选中的是 glibc 变体。改用 alpine 基底
  会切到 musl 变体,需要重新验证。

Dockerfile 的其余部分本身已经是架构中立的:docker apt 源那行用 `$(dpkg --print-architecture)`
拼出来,`node:22-bookworm-slim`、`docker-ce-cli`、`ripgrep` 在 amd64 与 arm64 上都有。

### 一次性准备(构建机)

```bash
# 注册 QEMU 解释器,让本机能跑异架构容器
docker run --privileged --rm tonistiigi/binfmt --install all
# 多架构必须用 docker-container 驱动,默认的 docker 驱动不支持多 platform
docker buildx create --name catman --driver docker-container --use
docker buildx inspect --bootstrap        # Platforms 一行里应出现 linux/amd64, linux/arm64
```

### 方式 A:推到 registry(要给多台不同架构的机器用时)

多架构镜像是一份 manifest list,**没法 `docker load` 进本地 daemon**(本地镜像存储只认单
架构),所以必须经 registry 中转:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f docker/Dockerfile \
  -t <registry>/catman:0.1.0 \
  --provenance=false \
  --push .
```

`--provenance=false` 关掉 buildx 默认附加的 attestation:它会让 manifest 变成较新的 OCI
格式,老版本 dockerd(软路由上很常见)拉取时会报看不懂的 manifest 错误。

路由器侧把 compose 的 `build:` 一节换成拉镜像:

```yaml
services:
  catman:
    image: <registry>/catman:0.1.0
    # build: 一节删掉,否则 compose 仍可能在本机重新构建
```

```bash
docker compose pull && docker compose up -d      # 自动挑本机架构那一份
```

### 方式 B:没有 registry,单架构直出 tar

只伺候一台路由器时不必搞 manifest list —— 直接构建**目标架构的单架构镜像**导成 tar 更省事:

```bash
docker buildx build --platform linux/arm64 -f docker/Dockerfile \
  -t catman:0.1.0 -o type=docker,dest=catman-arm64.tar .
scp catman-arm64.tar root@<路由器>:/tmp/
ssh root@<路由器> 'docker load -i /tmp/catman-arm64.tar'
```

同样要把路由器上的 `docker-compose.yml` 改成 `image: catman:0.1.0` 且不带 `build:`。

### 验证

```bash
# 构建机:确认 manifest 里真有两个架构(方式 A)
docker buildx imagetools inspect <registry>/catman:0.1.0

# 目标机:确认容器架构与装进去的 claude 二进制一致
docker compose exec catman node -p process.arch                  # → arm64
docker compose exec catman ls /app/node_modules/@anthropic-ai/   # → ...-linux-arm64
```

第二条是这一节真正要守的东西:两者对不上就说明 `npm ci` 跑在了错误的架构下。最后照例走一遍
[M0 验证清单](#m0-验证清单首次部署务必先走一遍),发一条真实消息确认 agent 起得来。

> QEMU 模拟下 `npm ci` 与 `tsc` 都跑在翻译过的指令上,比原生慢一个量级不奇怪。有原生 arm64
> 机器的话,用 `docker buildx create --append --name catman ssh://<host>` 把它挂成 builder
> 节点,buildx 会把对应架构的那一路交给它原生构建。

| 变量 | 默认 | 说明 |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude 订阅 token(必填) |
| `CATMAN_CHANNEL` | `stdin` | `wechat` / `stdin` |
| `CATMAN_DATA_DIR` | `/data` | 数据卷根目录 |
| `CATMAN_SESSION_TIMEOUT_MS` | `3600000` | 会话空闲超时(1h) |
| `CATMAN_RETENTION_MS` | `2592000000` | 会话保留期(30 天) |
| `CATMAN_DASHBOARD_PORT` | `8787` | dashboard 端口 |
| `CATMAN_ADMIN_TOKEN` | 自动生成 | dashboard 访问令牌;未设则生成并写入 `./data/dashboard-token` |
| `CATMAN_MAX_CONCURRENT_TURNS` | `2` | 同时进行的回合数上限(跨用户);软路由 CPU 与订阅限流的双重约束 |
| `CATMAN_MODEL` | SDK 默认 | 全局默认模型 |
| `CATMAN_MODEL_ALLOWLIST` | `opus,sonnet,haiku` | 允许用户选的模型。用别名而非完整 id —— 别名不随版本腐化 |
| `CATMAN_ACK` | `1` | 收到消息先回"处理中"回执;`0` 关闭 |
| `CATMAN_PROGRESS` | `1` | 转发思考/工具调用进度;`0` 关闭 |
| `CATMAN_API_BASE` | `http://127.0.0.1:<端口>` | 告诉助手从容器内怎么访问本进程的接口 |
| `CATMAN_SETTINGS_PATH` | `<数据卷>/settings.json` | 全局运行时配置覆盖的落盘位置 |
| `CATMAN_PREFS_PATH` | `<数据卷>/prefs.json` | 每用户配置覆盖的落盘位置 |
| `CATMAN_CHAT_LOG_PATH` | `<数据卷>/dashboard-chat.json` | 管理员聊天记录的落盘位置(网页没有本地记录) |

> 上表里带 ✱ 语义的几项(模型、回执、进度、超时、保留期、清理间隔、并发上限)只是**基线**:
> 管理员在聊天里改的值写进 `settings.json`,优先级更高且**改完立即生效,不用重启**。
> 环境变量只在两份 json 都没覆盖时起作用。

下面两个不由 catman 读取,分别给 compose 和容器内的 docker CLI 用:

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOCKER_GID` | `0` | 宿主 `/var/run/docker.sock` 的组 GID,compose 用它给 catman 补充组 |
| `DOCKER_API_VERSION` | 自动协商 | 宿主 dockerd 过老导致 CLI 报版本不兼容时锁定 API 版本 |

## 安全说明

- 助手以 `bypassPermissions` 在容器内执行任意命令。**是否挂载 `/var/run/docker.sock` 决定了
  隔离边界在哪**:不挂时边界是容器;挂了(默认配置)助手即拥有宿主 root 等价权限,
  边界退化为"你对这台机器上的助手的信任"(详见 [操作宿主 Docker](#操作宿主-docker最高权限能力))。
  其它敏感宿主目录/特权同理,按需再加。
- **多账号的"隔离"不是安全边界。** 挂了 `docker.sock` 之后,任何一个接入者都能通过 docker
  拿到宿主 root,从而读写其他用户的工作目录。每人独立 cwd 解决的是"别互相干扰、别看到对方的
  文件",不是"互相防备"。**只把你信任的人接进来。**
- dashboard 整站需要令牌(读写都要),写操作还额外要求 `X-Catman-Token` 请求头 —— Cookie
  会被浏览器自动携带,只认 Cookie 的写接口能被外部页面诱导触发(CSRF)。仅监听内网,勿暴露公网。
  **向管理员聊天发消息(`POST /api/chat`)是其中权限最高的一个写操作**,同样只认请求头。
- **回合令牌防的是误操作,不是对抗。** 助手拿到的 `/api/me` 凭据只解析得出它自己那个用户,
  接口也没有"改谁"这个参数 —— 正确路径就是安全路径,不存在填错对象的可能。但助手以
  `bypassPermissions` 运行、与 `./data/dashboard-token`(0600)同一个 uid,真要绕开这个接口
  是做得到的。这与上面 docker socket 的口径一致:**边界是对助手的信任,不是进程隔离**。
- **给某个微信用户管理员权限,等于把管理员令牌和 dashboard 的全部写权限(含删账号)交给他。**
  内置的 dashboard 管理员不在名单里也无法移除,是配置改坏后的恢复通道。
- **skill 是上下文过滤而不是沙箱。** 管理员 skill 只对管理员回合出现在列表里,普通用户的助手
  仍能 Read 到那个文件 —— 所以里面没有任何令牌,只有环境变量引用。
- 账号凭据(`./data/accounts.json`,含 `bot_token`)以 0600 落盘;dashboard 的账号接口
  只返回去掉凭据的视图。
- 会话 JSONL 可能含敏感对话,`./data` 卷注意访问权限。
- **清理范围严格限定在 catman 自己创建的 workspace 目录**:dashboard 与 30 天清理的扫描范围
  由 `/data/workspace/` 下的一级子目录精确算出,**绝不遍历整个 `projects/` 树**。
  因此即便有人把 `CLAUDE_CONFIG_DIR` 指向了共享的 `~/.claude`,catman 也不会误删其它项目的
  Claude Code 会话历史(见 `src/core/transcript.ts` 的安全约束与对应单测)。

## 从单账号版本升级

**不提供迁移,清空 `./data` 重新扫码即可** —— 为一次性场景写迁移代码,等于把旧格式的知识
永久留在代码里。旧的 `state.json` 条目会被识别为非法格式并丢弃(日志有提示),
旧的 `ilink-credentials.json` 不再被任何代码读取。

⚠️ 如果保留旧 `./data` 不删,`data/claude/projects/-data-workspace/` 下的旧会话会**永久残留**:
清理只在已知用户的目录内操作(上一条的安全约束),不会去收养这个孤儿目录。要么清空 `./data`,
要么手动删掉那个目录。
