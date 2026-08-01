# CLAUDE.md

面向在本仓库开发 catman 的 Claude Code / 开发者。运行时助手人设不在这里,而在
`/data/workspace/CLAUDE.md`(由运行中的 agent 自己加载,见下)。

## 这是什么

catman:跑在 OpenWrt / x86 软路由 Docker 里的个人 AI 助手。微信(iLink 协议)作为聊天入口,
后端用 **Claude Agent SDK** 长驻,使用 Claude 订阅计费,能在容器内执行任意命令
(含用内置 docker CLI 操作宿主 Docker)。**多账号**:多人各自扫码接入,各自独立的会话与
工作目录;dashboard 带鉴权,兼做扫码接入与账号管理。
纯 TypeScript / ESM(NodeNext),运行时除 `@anthropic-ai/claude-agent-sdk` 外无其它依赖。

## 常用命令

```bash
npm run typecheck          # tsc --noEmit
npm test                   # node:test + tsx,含假时钟单测
npm run build              # tsc → dist/src/**
# 本地用 stdin 通道端到端手测(终端直接聊,需 Claude token):
# stdin 支持 "/user <名字>" 切换身份 —— 多用户隔离可脱离微信在本地验证。
# stdin 还支持 "/img <路径> [附言]" —— 图片输入同样不必真机扫码就能端到端验证,
# 走的是与微信图片完全相同的下游链路(同一个 Attachment、同一个网关、同一个 Agent)。
CATMAN_CHANNEL=stdin CATMAN_DATA_DIR=./data CATMAN_ADMIN_TOKEN=devtoken \
  CLAUDE_CODE_OAUTH_TOKEN=<token> npm run dev
docker compose up -d --build
```

改完务必跑 `npm run typecheck && npm test`(strict + noUncheckedIndexedAccess 全开)。

## 数据流

```
Channel(收消息,产出 userKey + text + 可选图片附件) → Gateway.dispatch
  ├─ immediate 硬指令 → runCommand   **绕过聚合与队列**,与在飞回合并发(带图时不走这条)
  └─ 其余 → collect(聚合窗口,debounce) → enqueue(每用户串行) → handle
       prelude:
         → admission(userKey)      不过就地返回,不建目录/不写状态/不花额度
         → users.ensureWorkspace()  该用户的 cwd
         → 首次则推送使用指引(发送成功才标记)
       → prefs.effective()        本回合的模型/回执/进度/分段长度
       → sessions.decide()        是否 resume
       → turns.mint()             回合令牌 + abort/reset 上下文
       → 并发信号量(跨用户上限,可运行时调整)
       → Agent.run(prompt, {cwd, resume, model, env, skills, abortController, attachments})
       → sessions.record() → Channel.send(按 maxReplyChars 分段)
       finally: resetSession 则 forget → revoke → release

Dashboard 与清理的扫描范围 = listWorkspaceDirs(/data/workspace) 算出的那组 projectDir
```

硬指令(`/帮助` `/状态` `/新会话` `/取消`)在 `onMessage` 就地分流,**不进队列** ——
见下面的不变量。`/继续` 是唯一走队列的指令。

**身份**:`userKey = <channel>:<accountId>:<userId>`(`core/identity.ts`)。
accountId 这一段不能省 —— 两份 iLink 凭据下可能出现相同的 from_user_id。
解析时只 split 前两个 `:`,所以 userId 含任意字符都能无歧义往返。

**配置三层**:`config.ts`(env 基线)→ `settings.json`(全局,管理员改)→
`prefs.json`(每用户,自己改)。读取时逐级回退,见下面的「兜底优先于交叉校验」。

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 装配启动;设置 CLAUDE_CONFIG_DIR、清理 cron、优雅关闭、令牌兜底生成 |
| `src/core/identity.ts` | userKey 编解码;**单射**的工作目录名派生;内置管理员常量 |
| `src/core/attachments.ts` | 图片附件的中立表示 + 格式嗅探 + 大小/数量上限(不认识渠道也不认识 SDK) |
| `src/core/users.ts` | UserRegistry;每用户 workspace;`listWorkspaceDirs` = 清理真相源 |
| `src/core/accounts.ts` | 账号/凭据存储(0600),连接集合变更回调 |
| `src/core/admission.ts` | 准入策略(TOFU 绑定 / 本地全放行),以函数注入网关 |
| `src/config.ts` | env 基线(**只是三层配置的最内层**);时间量用 ms 便于测试 |
| `src/core/settings.ts` | `SETTING_SCHEMA`(全部配置项的单一真相源)+ 全局运行时层 |
| `src/core/prefs.ts` | 每用户配置层,叠在全局默认之上 |
| `src/core/commands.ts` | `COMMAND_TABLE`:硬指令的单一真相源 |
| `src/core/turn-tokens.ts` | 回合级一次性令牌 + 在飞回合上下文(reset 标记 / abort) |
| `src/core/skills.ts` | 启动时生成两个 SKILL.md(接口说明按需加载,不占系统提示词) |
| `src/core/agent.ts` | Agent SDK 封装;**必须**带 claude_code preset 三件套(见下) |
| `src/core/session.ts` | 会话状态机(纯函数 decide + 注入时钟/store/每用户超时) |
| `src/core/gateway.ts` | 串联各层;入口分流硬指令;每用户串行队列;并发信号量;greeting |
| `src/channels/composite.ts` | 多渠道复合 + 复合准入,按 userKey 前缀路由 |
| `src/channels/dashboard.ts` | 管理员聊天渠道(记录落盘 + SSE 订阅 + 回执撤回) |
| `src/dashboard/api-self.ts` | `/api/me`:回合令牌鉴权,agent 管自己的配置 |
| `src/dashboard/api-admin.ts` | `/api/settings`、`/api/users`:管理员改全局与他人(含提权) |
| `src/core/transcript.ts` | JSONL 防御式解析、检索、**workspace 范围**清理 |
| `src/core/file-store.ts` | 状态原子写(tmp + rename) |
| `src/channels/types.ts` | Channel 接口(onMessage/send/start/stop);入站消息 = 文本 + 可选图片附件 |
| `src/channels/ilink-protocol.ts` | iLink 协议公共部分:端点、App 标识、请求头、POST 封装 |
| `src/channels/ilink-connection.ts` | **单账号**连接:一份凭据 = 一条长轮询 + 一份 replyCtx |
| `src/channels/ilink-login.ts` | 扫码登录流程;dashboard 与 CLI 脚本共用 |
| `src/channels/wechat-ilink.ts` | 多连接管理器,跟随 AccountStore 动态起停 |
| `src/channels/stdin.ts` | 本地测试通道 |
| `src/scripts/ilink-login.ts` | 命令行扫码(dashboard 打不开时的退路),写同一份 accounts.json |
| `src/dashboard/auth.ts` | 整站 token;读认 Cookie/query,**写只认请求头**(防 CSRF) |
| `src/dashboard/qrcode.ts` | 纯 TS 二维码编码器(byte 模式 / 纠错 M / 版本 1–20),零依赖 |
| `src/dashboard/` | HTTP + 服务端渲染(已做 XSS 转义);账号页含扫码流程,用户页是提权入口 |

## 必须知道的不变量 / 坑

- **还原 Claude Code 行为靠三个非默认选项**(`agent.ts`):`systemPrompt:{type:"preset",preset:"claude_code"}`
  + `settingSources:["user","project","local"]` + `bypassPermissions`。少任何一个"脾气"就变了。
- **bypassPermissions 不能以 root 运行**;镜像里用 uid 10001 的 catman 用户。
- **宿主 Docker 访问靠运行时注入的组,不能写死进镜像**:镜像只预装 docker CLI(无 daemon),
  `/var/run/docker.sock` 由 compose 挂载、访问权限由 `group_add: ${DOCKER_GID:-0}` 给。
  该 GID 属于宿主(OpenWrt 多为 0/root,Debian 多为 999/docker),写进镜像会一换机器就
  `permission denied`。挂了 socket 就等于把宿主 root 交给助手,**隔离边界从容器退化为对助手的信任** ——
  README「安全说明」按这个口径写,改动别改回"容器即隔离边界"。
- **镜像里的 `npm ci` 必须跑在目标架构下**:claude 二进制来自 Agent SDK 的
  optionalDependencies(`claude-agent-sdk-<os>-<arch>[-musl]`),npm 按**执行安装的那个容器**的
  arch/libc 选包。所以多架构要靠 buildx + QEMU(或原生 builder)整层在目标平台跑,
  **不能**改成 `FROM --platform=$BUILDPLATFORM` 交叉编译 —— TS 编译确实与架构无关,但同层的
  `npm ci` 会装成构建机的架构,构建期毫无征兆,只在目标机起 agent 时炸。
  验证手段:容器内 `node -p process.arch` 与 `ls node_modules/@anthropic-ai/` 必须对得上。
  基底是 bookworm(glibc),换 alpine 会切到 musl 变体。步骤见 README「构建多架构镜像」。
- **清理严格限定在本程序自己建的 workspace 目录**(`transcript.ts` 全部函数都要 `projectDir`
  参数;多用户版的 `*Across` 函数接受调用方给定的一组 scope)。**绝不遍历整个 projects/ 树** ——
  否则 CLAUDE_CONFIG_DIR 指向共享 ~/.claude 时会误删无关的 Claude Code 历史(有专门单测守护;
  曾真实踩过)。那组 projectDir 必须由 `listWorkspaceDirs(workspaceDir)` 算出,
  **不要改成 readdir(projects/)**。
- **清理的真相源是 workspace 目录,不是 users.json / state.json**:后两者会因 forget()/删账号
  丢条目,而 JSONL 还在磁盘上,只按它们清理会造成永久堆积。
- **`userDirName()` 必须保持单射**(可读前缀 + userKey 全文哈希后缀)。只用归一化后的可读部分
  会让 `x/y` 与 `x-y` 撞到同一个目录 —— 两个用户共用 cwd,隔离直接失效。有单测守护。
- **工作目录全路径必须远短于 200 字符**:超过后 SDK 会改用「截断 + djb2 哈希」编码 project 目录,
  与 `encodeProjectDir()` 的朴素替换分叉,会话就此读不到也删不掉。`ensureWorkspace()` 会拦。
- **`Channel.name` 必须等于该渠道产出的 userKey 的第一段**(真机踩过):`CompositeChannel`
  拿 userKey 的 channel 段当路由键去找渠道发回复。两处写岔的话准入、入队、agent 全都正常,
  **只有最后 send 那一步抛「没有能处理 X 的渠道」** —— 额度已经花掉,用户那边彻底没反应。
  微信渠道曾经 `name="wechat-ilink"` 而 userKey 是 `wechat:...`,正是这个症状。
  现在两处引用同一个常量(`WECHAT_CHANNEL` / stdin 的 `CHANNEL`)使其不可能走岔,
  并有单测守护「该渠道产出的 userKey 必须能路由回该渠道」这个闭环。
- **准入(`admission.ts`)在网关最前面**:未获准的来信不建工作目录、不写会话状态、不花订阅额度。
  新增渠道时在 `index.ts` 的 `createChannel` 里连同准入策略一起返回 —— 两者是同一个决定,
  分开配容易出现新渠道忘了配准入、结果全放行。
- **账号绑定是 TOFU 且不可被来信改写**:`bind()` 在已绑定时返回 false,换人必须显式 `unbind()`。
- **dashboard 写操作只认 `X-Catman-Token` 请求头,不认 Cookie**:Cookie 会被浏览器自动携带,
  只认 Cookie 的写接口能被外部页面诱导触发(CSRF)。读则两者皆可(请求头是更强的凭据,也放行)。
- **共享人设靠 `@../CLAUDE.md` 显式 import**,不依赖「向上递归查找父目录 CLAUDE.md」的隐式行为。
  注意 project settings(`.claude/settings.json`)**没有**继承机制,要全局共享得放 user settings。
- **兜底优先于交叉校验**(`settings.ts` 的核心原则):目标是**任何配置状态下 agent 都能起来** ——
  有 LLM 才有自我修复的可能。所以配置项之间**一律不做交叉一致性校验**,改一处不用管别处;
  改用读取时逐级回退。每项有一对读写不对称的函数:`validate()` 写入时严格抛错(给 agent 反馈)、
  `parse()` 读取时坏值返回 undefined 让调用方退到下一级。**`effective()` 永不抛**,
  末端落到 `floor`,而 `model` 的 floor 是 `undefined` —— 「不传 model,交给 SDK」。
  改白名单时**不要**去检查有没有人在用某个模型,那正是这条原则要消灭的东西。
- **回落但不改盘**(`prefs.ts`):失效的用户覆盖只在读取时回退,不重写 `prefs.json` ——
  白名单加回来时用户当初的选择要能自动恢复。静默改盘会把意图永久抹掉。
- **会话规则**(`session.ts`):距上次 <1h(可每用户覆盖)→ resume;超时后只有 `/继续` 才 resume,
  否则开新会话;`reminded` 标记防重复提醒;`record()` 重置该标记。
  **指令词汇不住在这里** —— `decide()` 收布尔标记,`commands.ts` 才认识 `/继续` 长什么样。
- **immediate 硬指令绕过每用户串行队列**(`gateway.ts` 的 `dispatch`)。这是它们存在的**全部理由**:
  agent 卡死时队列里的消息永远轮不到,包括本该救命的那条。代价是它们与在飞回合并发,
  所以只能做**幂等的只读/打标记**操作。别把需要与回合互斥的事放进去。
- **`/新会话` 必须同时置在飞回合的 `resetSession`**:只 `sessions.forget()` 的话,
  那个回合在 finally 里的 `record()` 会把新 sessionId 写回来,等于没重置。同理,
  `/api/me/session/reset` 也只打标记 —— **任何地方都不要对在飞回合直接 forget**。
- **子进程 env 一律剔除 `CATMAN_ADMIN_TOKEN`,只有 admin 回合加回**(`gateway.childEnv`)。
  SDK 的 `Options.env` **整体替换**子进程环境(不是合并),必须展开 `process.env` ——
  而它带着管理员令牌。这是该令牌下放的唯一出口,有单测守护。
- **内置 dashboard 管理员不可撤销**:它不在 `adminUserKeys` 里,清空名单也影响不到 ——
  刻意留的恢复通道,免得配置改坏后谁都改不了。`PATCH /api/users/<key> {admin:true}` 对它
  必须**提前短路**:schema 的 `validate` 拒收它,真走进去会 400。
- **提权是 `PATCH /api/users/<key> {admin}`,名单由服务端照当前值增删**(`api-admin.ts` 的
  `setAdmin`),**不要**改成让调用方提交整份 `adminUserKeys`:那要求先读再写,两处同时操作
  时后写的会把先写的抹掉。dashboard 的「用户」页和管理员聊天走的是同一个接口。
- **账号备注名在扫码前定**(`ILinkLogin.start(displayName)` 存进 `PendingLogin`):
  多账号时二维码之间没有任何区别,扫完再回头认"刚才那个是谁"最容易配错人。
  空串 = 恢复默认名(与 `users.setDisplayName()` 空名抛错刻意不同 —— 账号有 accountId 兜底)。
- **`Options.skills` 是上下文过滤不是沙箱**:未列出的 skill 文件仍能被 Read/Bash 读到
  (SDK 类型注释原文)。所以 **SKILL.md 里绝不能出现任何令牌**,只写环境变量引用。
- **`/api/me` 必须在 admin 读闸门之前分发**(`server.ts` 的 `handle`):它的第一件事是
  `allowsRead()`,回合令牌过不了那道闸 —— 放到后面会静默 401,极难查。
- **`Dashboard.stop()` 必须先 `res.end()` 掉所有 SSE 再 `server.close()`**:
  长连接会让 `close()` 的回调永不触发,进程卡在优雅关闭里出不去(已实测复现)。
- **dashboard 聊天记录必须落盘**(`chatLogPath`):微信客户端自己存着聊天记录,网页没有。
  只放内存里的话,重启后页面一片空白、而助手那边的会话还在(未超时就 resume)——
  **页面说"没聊过"、助手说"我记得"**。注意记录与上下文是两件事:`/新会话` 只清上下文。
- **`DashboardChannel` 必须实现 `recall`**:网关在每个回合的 finally 撤回"收到"回执。
  不实现的话落盘后每一轮都永久攒一条。撤回帧走 SSE 的 `event: delete`,且**不带 `id:`** ——
  浏览器会把 `id:` 记成 Last-Event-ID,重连起点被拉回到刚删掉那条,已推过的会重来一遍。
- **SSE 首连的补发起点由页面用 `?after=` 给**:首次连接没有 Last-Event-ID,不给的话
  服务端会把首屏刚渲染完的历史整份再推一遍。请求头优先(它是浏览器维护的)。
- **网页上的「开新会话」按钮发的就是硬指令文本本身**(`canonicalOf("newSession")`),
  不复制一份后端逻辑 —— 语义永远与在微信里打字一致,指令改名也自动跟上。
- **聊天输入框不能无条件抢 Enter**(`ui.ts` 的 `shouldSendOnEnter`):输入法合成期间
  Enter 是"上屏"不是"发送"(拼音打英文最典型)。浏览器事件顺序不一致 ——
  Chrome/Firefox 的 keydown 在 compositionend 之前且带 `isComposing`,Safari 反过来且
  **没有任何标志位**,只能靠紧挨 compositionend 的时间窗认出来。该函数被 `toString()`
  内联进页面,所以**函数体必须自足**,引用模块作用域的东西在浏览器里就是 ReferenceError
  (单测在空沙箱里求值 `ENTER_GUARD_SNIPPET` 守这条)。
- **iLink 扫码的两个反直觉点(已真机验证)**:`get_bot_qrcode` 的 `qrcode_img_content`
  是**授权 URL 文本而非图片**(所以要自己编二维码);`get_qrcode_status` 是**长轮询**,
  无人扫码时阻塞约 30 秒返回 `status:"wait"` —— 用默认 15 秒超时会每次都被中断。
- **图片走内联,不走"落盘 + 告诉模型路径"**(`agent.ts` 的 `buildUserMessage`):SDK 的 `query()`
  除 string 外还收 `AsyncIterable<SDKUserMessage>`,其 `message` 就是 Anthropic 的 `MessageParam`,
  可以直接放 image content block(已实测:SDK 原样序列化成一行 stream-json 交给 CLI,3MB base64
  单行完整通过)。给路径让模型自己 Read 要多一次工具往返,而且**模型可能压根不去读** ——
  用户贴图就是要它现在看。**无附件时仍旧传 string**,保持老路径的行为完全不变。
- **附件的格式靠嗅探 magic number,不信渠道给的 MIME**(`attachments.ts`):iLink 的图片是从 CDN
  解密出来的裸字节,协议里没有可靠的格式声明;而 `media_type` 与实际内容不符时模型侧会直接报错。
  能接的四种(jpeg/png/gif/webp)取自 `@anthropic-ai/sdk` 的 `Base64ImageSource.media_type`,
  加格式前先去那个类型上确认。超限图片**直接拒收不缩图** —— 运行时零依赖,没有图像库。
- **图片的两条闸门是配置项不是常量**(`maxImageBytes` / `maxImagesPerTurn`,scope=global):
  它们直接决定内存峰值(base64 驻留整个回合)与图片 token 开销,软路由和 x86 主机的余量差得远。
  `attachments.ts` 里只有 `AttachmentLimits` 接口,取值由调用方注入;渠道拿的是 **`() => limits`
  函数而非值**,所以管理员在 dashboard 上改完下一张图就按新值走,不必重启。
  同一条消息内用同一份快照,免得中途改配置导致一条消息里的图按不同标准处理。
- **iLink 的图片不在消息正文里**:`item_list` 的 `type=2`(`MessageItemType.IMAGE`)只带一份
  「去哪取 + 怎么解」的凭据,字节要去 CDN 拉且是 **AES-128-ECB 加密**的。两处 key 编码不同 ——
  `image_item.aeskey` 是 hex、`media.aes_key` 是 base64,弄混解出来是乱码;`aes_key` 本身还有
  base64(16 字节原文) 与 base64(32 位 hex) 两种野外编码,都得认。有单测守护。
- **收到图片的那条消息要顺序 `await` 再处理下一条**(`ilink-connection.ts` 的 pollLoop):
  dispatch 现在可能要下载几 MB。代价是下载期间暂停拉取 —— 长轮询有 `get_updates_buf` 游标兜底
  不会丢消息;而并发 dispatch 会让「先发图、后发问题」的两条消息颠倒着进队列。
- **带附件的消息不按硬指令解析**(`gateway.dispatch`):硬指令要求整条消息只有指令本身,
  「/状态 + 一张图」显然不是那个意思 —— 照常走 LLM,免得图片被指令分支静默吞掉。
- **单张图失败不能连累整条消息**:那张图跳过并单独告知用户,文字与其余图片照常投递。
  整条消息因为一张图挂掉,在用户那边就是"发了没反应"。
- **微信发「图 + 文字」不是一条消息,靠聚合窗口合并**(真机实测):两条消息相隔约 **120ms**
  (图片先到、文本后到,或反过来)。协议**给不出**"后面还有图"的信号 —— 实测
  `session_id`/`run_id` 为空、`is_completed` 与 `message_state` 两条都已是完成态,
  四个候选键全废。所以只能按时间攒:`gateway.collect()` 用 debounce(每来一条重置计时),
  窗口是 `messageAggregationMs`(默认 1500ms,设 0 关闭)。
  **用户一直在发就一直攒** —— 人还在打字说明话没说完,这时候切批去起回合是打断他,
  攒到一起既更合意图也更省。`AGGREGATION_MAX_MULTIPLIER`(×40,默认约 60 秒)因此定得很松:
  它**不是**公平性限制,唯一理由是 batch 把文本与图片攒在内存里、总得有不再增长的时刻,
  正常聊天碰不到。合并后要**重新收一次图片上限** —— 渠道只保证单条消息不超。
  排查协议用 `CATMAN_ILINK_TRACE=1`(`formatTrace` 是纯函数,有单测守护不泄漏密钥与 base64)。
- **immediate 硬指令不进聚合窗口**:让救命的 `/取消` 先等 1.5 秒,等于取消了硬指令存在的
  全部理由。反过来 `/取消` 要**连带丢掉还在窗口里那批** —— 用户看不见队列,他要取消的是
  刚发出去的那几条,不管它们变没变成回合。
- **`stop()` 要把攒着的消息 flush 进队列**:消息已经从渠道收下、长轮询游标也推进了,
  留在窗口里就是真丢。能不能跑完交给关闭流程,总好过在这里静默吞掉。
- **iLink 协议约束**:回复必须带入站消息的 `context_token`(否则 HTTP 200 静默失败);
  **协议不支持主动推送**,故超时提醒大概率发不出,网关会静默降级(不报错)。
- **一个 `context_token` 的发送次数是有预算的,约 10 条**(真机实测):第 11 条起
  `sendmessage` 返回 `ret=-2 prepare failed` 且**永不恢复**,之后连正文都发不出去,
  用户只收到"收到,正在处理中…"然后彻底静默。**是条数不是时效**:另一次记录里同一个
  token 用到 4 分钟(7 条)仍然正常;也不是限流 —— 限流会放行,而它首败后 45 秒仍全败。
  预算在 `gateway.ts` 顶部显式列支:`SEND_BUDGET(10) − 回执 1 − RESERVED_SENDS(2)`
  = `MAX_PROGRESS_PER_TURN`。**预留的两条是正文与会话空闲提醒** —— 后者容易漏:
  提醒的前提就是用户没再发消息,而 `replyCtx` 只在收到新消息时更新,所以它用的还是
  上一个回合那份额度,进度吃光了它就永远发不出去。
- **进度的两道闸门缺一不可**(`ProgressThrottle`):**间隔阶梯** 5→15→30→60 秒防密集刷屏,
  **总条数上限**防长回合靠 60 秒一条把额度慢慢耗完 —— 阶梯本身不限制总数,只有阶梯的话
  十分钟的回合照样能发十几条。同间隔内只发**最新**那条(进度是状态不是流水),
  丢掉的条数记在 `(+N 步)` 里。纯事件驱动、**不用定时器**:与旧实现一样"卡在长工具调用里
  就不更新",没有退步;而引入定时器就会有"回合结束后才触发、进度插到正文后面"的乱序。
  改任何一个数之前先把那笔账重算一遍。
- **日志一律带时间戳**(`log-stamp.ts` 在 `index.ts` 最前面包裹 console):排查发送问题时
  "这两条隔了多久"是最基本的信息。包 console 而不是换 logger,是因为几十处调用点加上
  SDK 自己打的,漏一处那行就成了时间轴上的断点。容器**不继承宿主时区**,compose 透传 `TZ`。
  排查 iLink 用 `CATMAN_ILINK_TRACE=1`,每条发送打「第几次 / 成功过几条 / token 多老」;
  **失败行无条件打印**,因为回执与进度的失败在 `gateway.trySend` 那层是被吞掉的。
- **iLink App 标识无需申请**:`appid="bot"` 是官方包固定值,client version 是版本号编码;
  唯一个人凭据是扫码得的 `bot_token`。仅这些需真机校准:QR 端点、SKRouteTag、channel_version、限流。
- **两个 CLAUDE.md**:本文件是开发指南;运行时 agent 加载的是 `/data/workspace/CLAUDE.md`
  (在数据卷内),那才是塑造助手人设/行为的地方。多用户下它是**共享**人设,
  每人目录下还有一个自己的 `CLAUDE.md`(首行 import 共享的那份)。
- **不做数据迁移**:升级方式是清空 `./data` 重新扫码。代码不认识任何历史格式,
  `parseUserKey()` 对非法 key 返回 null、`SessionManager` 加载时丢弃 —— 这是解析器本就该有的
  防御,不是迁移分支。别为一次性场景把旧格式的知识永久留在代码里。

## 约定

- 注释与文档用中文;代码标识符英文。
- ESM + NodeNext:相对 import 带 `.js` 后缀(编译前也写 `.js`)。
- 测试:`node:test` + `tsx`,纯逻辑用注入的假时钟/内存 store,不碰真实网络或 Claude。
  HTTP 层也一样:路由与鉴权写成纯函数(`api-self.ts` / `api-admin.ts` / `auth.ts` / `ui.ts`),
  `server.ts` 只做 IO 适配 —— 所以测试不必起真实 server。
- 新增聊天渠道:实现 `Channel` 接口(对外一律用 userKey,不是渠道内的裸 userId),
  在 `index.ts` 的 `createChannel` 里连同**准入策略**一起加进
  `CompositeChannel` / `compositeAdmission`;不要动会话核心。复合准入对**未登记的渠道前缀
  一律拒绝** —— 漏配应当表现为不工作,而不是没防护。
- 加配置项:只改 `SETTING_SCHEMA`。校验、`/api/*` 的 schema 字段、两个 skill 的正文、
  帮助文案会自动跟上。加硬指令同理,只改 `COMMAND_TABLE`。
- 改指令写法时记得 `REMINDER_TEXT` 之类的文案 —— 用 `canonicalOf()` 引用而不是手写字符串。
