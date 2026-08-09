# CLAUDE.md

面向在本仓库开发 catman 的 Claude Code / 开发者。运行时助手人设不在这里,而在
`/data/workspace/CLAUDE.md`(由运行中的 agent 自己加载,见下)。

## 这是什么

catman:跑在 OpenWrt / x86 软路由 Docker 里的个人 AI 助手。微信(iLink 协议)作为聊天入口,
后端用 **Claude Agent SDK** 长驻,使用 Claude 订阅计费,能在容器内执行任意命令
(含用内置 docker CLI 操作宿主 Docker)。**多账号**:多人各自扫码接入,各自独立的会话与
工作目录;dashboard 带鉴权,兼做扫码接入与账号管理。
纯 TypeScript / ESM(NodeNext),运行时除 `@anthropic-ai/claude-agent-sdk` 外无其它依赖。

**源码直跑**:镜像 `catman-env` 只是不含业务代码的运行环境,真正跑的是数据卷里的
**release 目录**(`/data/releases/<sha>/` = 浅 clone + 自带 node_modules + dist),
由符号链接 `current` 指定。升级 = 制备新 release + 换链接 + 重启容器,**不重建容器**。
配套的自进化流水线在 `scripts/evolve/`,详见下面「自进化」一节。

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

# 部署(源码直跑,首次三步;之后升级只走 prepare + deploy)
docker build -t catman-env:1 -f docker/Dockerfile .    # 基底镜像,极少重建
CATMAN_HOST_DATA_DIR=$PWD/data scripts/evolve/init.sh  # 首个 release + 指针
scripts/evolve/bless.sh                                # 固化部署机制(自进化要用)
docker compose up -d
docker exec catman scripts/evolve/prepare.sh HEAD      # 制备:测试+编译,产出 release
scripts/evolve/deployer.sh deploy <sha>                # 排水→自检→切换→健康门→观察期
scripts/evolve/deployer.sh rollback|status
# 自检(smoke)单独跑:不碰真实 /data,退出码即结论,stdout 一行 JSON
CATMAN_SELFCHECK=1 node dist/src/index.js
```

改完务必跑 `npm run typecheck && npm test`(strict + noUncheckedIndexedAccess 全开)。

## 数据流

```
Channel(收消息,产出 userKey + text + 可选图片附件) → Gateway.dispatch
  ├─ immediate 硬指令(/帮助 /状态 /取消) → runCommand  **绕过聚合与队列**(带图时不走这条)
  └─ 其余 → collect(聚合窗口,debounce,切成有序的 Segment[])
        → enqueue(每用户串行) → handleBatch = **分拣节点**
            prelude: admission → ensureWorkspace → 首次推送使用指引
            按到达顺序线性走每一段,**不等回合**:
              ├─ command 段 → runQueuedCommand 原地消化(不进 LLM)
              │     /新会话     detach 前台回合 + archiveCurrent
              │     /继续       sessions.touch()
              │     /切换会话   switchTo() 成功则 detach 前台回合;失败则中止剩下的段
              └─ input 段  → deliverInput
                    ├─ 前台回合接得住 → turn.feed()   折进正在跑的那一轮
                    ├─ 追不进去但它还在 → 等 turn.done 再来一次(同一会话绝不并发)
                    └─ 没有前台回合   → startTurn(mint 同步完成)→ runTurn 后台跑

runTurn: prefs.effective() → sessions.decide() → 并发信号量 → Agent.run(…, onFeedReady)
       → detached ? sessions.archiveTurn() : sessions.record()
       → Channel.send(后台回合的正文带【后台对话 xxx 的结果】前缀,按 maxReplyChars 分段)
       finally: 摘 feed → revoke(兑现 turn.done) → release → 撤回执

Dashboard 与清理的扫描范围 = listWorkspaceDirs(/data/workspace) 算出的那组 projectDir
```

硬指令分两类,分界线是**会不会改会话状态**。只读/中断的(`/帮助` `/状态` `/取消`)
是 immediate,在 `onMessage` 就地分流、绕过聚合与队列;改状态的(`/新会话` `/继续`
`/切换会话`)走队列,在分拣节点里与消息投递保持先后。**两类都不进 LLM。**

走队列不再意味着"排在回合后面":分拣节点投递完就返回、**不等回合跑完**,
所以卡死的 agent 堵不住它 —— 这是 `/新会话` 从 immediate 改回队列的前提。

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
| `src/core/commands.ts` | `COMMAND_TABLE`:硬指令的单一真相源(immediate = 只读/中断,其余进分拣队列) |
| `src/core/turn-tokens.ts` | 回合级一次性令牌 + 在飞回合上下文(detached / abort / feed / done);每用户可有多个回合 |
| `src/core/skills.ts` | 启动时生成两个 SKILL.md(接口说明按需加载,不占系统提示词) |
| `src/core/agent.ts` | Agent SDK 封装;**必须**带 claude_code preset 三件套(见下);常开输入通道支持回合中途追加 |
| `src/core/version.ts` | 版本戳:读 release 根目录的 VERSION;**读不到就返回 undefined,绝不编** |
| `src/core/selfcheck.ts` | SELFCHECK 模式:自己开临时目录装配一遍 + 探一次大脑;失败分类(限流/网络/凭据/代码) |
| `src/core/deploy-report.ts` | 部署报告契约(deployer 写、catman 读)+ 防御式解析 + 已播报标记 |
| `src/core/deploy.ts` | 部署控制面接口 + 已验证版本清单解析 + 走固化脚本的实现 |
| `src/dashboard/health.ts` | `GET /health` 的纯函数组装 + 排水判定;**跨版本契约,字段只增不改** |
| `scripts/evolve/` | 自进化流水线:lib / prepare / deployer / deployer-run / bless / init |
| `docker/entrypoint.sh` | 解析 release 链接再 exec node;解析不到进**引导模式**(慢速重试,不 crash-loop) |
| `src/core/agent-trace.ts` | LLM 侧可观测性:SDK 消息 → 一行日志(纯函数,分 always/trace 两级)+ 心跳文案 |
| `src/core/session.ts` | 会话状态机(纯函数 decide + 注入时钟/store/每用户超时;current + history;后台回合走 archiveTurn) |
| `src/core/gateway.ts` | 串联各层;**分拣节点**(线性处理一批、不等回合);追加输入;每会话串行;并发信号量;greeting |
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
  镜像里还有 uid 10002 的 deployer:**`/data/releases` 属它所有,主容器只读挂载**
  (compose 里 `./data/releases:/data/releases:ro`)。助手文件系统全开,一句「帮我清清磁盘」
  就足以把回滚目标 rm 掉(硬链接复用还让每个 release 在 du 里都按全量计,看着最该删);
  只读挂载让那种误删直接 EACCES 暴露而不是成功。
- **宿主 Docker 访问靠运行时注入的组,不能写死进镜像**:镜像只预装 docker CLI(无 daemon),
  `/var/run/docker.sock` 由 compose 挂载、访问权限由 `group_add: ${DOCKER_GID:-0}` 给。
  该 GID 属于宿主(OpenWrt 多为 0/root,Debian 多为 999/docker),写进镜像会一换机器就
  `permission denied`。挂了 socket 就等于把宿主 root 交给助手,**隔离边界从容器退化为对助手的信任** ——
  README「安全说明」按这个口径写,改动别改回"容器即隔离边界"。
- **`npm ci` 必须跑在目标架构下**:claude 二进制来自 Agent SDK 的
  optionalDependencies(`claude-agent-sdk-<os>-<arch>[-musl]`),npm 按**执行安装的那个容器**的
  arch/libc 选包。源码直跑之后这条自动满足 —— 依赖是在**目标机器上**制备 release 时装的
  (`prepare.sh` 用的就是本机那个 `catman-env`),整套 buildx + QEMU 多架构构建随之消失。
  基底镜像本身不含 npm 依赖,就地 `docker build` 即可。
  验证手段不变:`node -p process.arch` 与
  `ls $(readlink -f /data/releases/current)/node_modules/@anthropic-ai/` 必须对得上。
  基底是 bookworm(glibc),换 alpine 会切到 musl 变体。
- **清理严格限定在本程序自己建的 workspace 目录**(`transcript.ts` 全部函数都要 `projectDir`
  参数;多用户版的 `*Across` 函数接受调用方给定的一组 scope)。**绝不遍历整个 projects/ 树** ——
  否则 CLAUDE_CONFIG_DIR 指向共享 ~/.claude 时会误删无关的 Claude Code 历史(有专门单测守护;
  曾真实踩过)。那组 projectDir 必须由 `listWorkspaceDirs(workspaceDir)` 算出,
  **不要改成 readdir(projects/)**。
- **清理的真相源是 workspace 目录,不是 users.json / state.json**:后两者会因 history
  被挤出/删账号丢条目,而 JSONL 还在磁盘上,只按它们清理会造成永久堆积。
  反过来,清理删掉 JSONL 后要 `sessions.dropSessionIds()` 出清死引用(`index.ts`),
  否则 `/切换会话` 会把用户领到一段 resume 必然失败的会话上。
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
- **重新扫码 = 换凭据,不是换账号**(`accounts.replaceCredentials`):accountId 必须原样保留,
  因为它是 userKey 的第二段 —— 换了就等于换了个人,会话、工作目录、prefs 全部接不上,
  而这恰恰是这个功能存在的理由。同理 `poll()` 在目标账号已被删时返回 `failed` 而**不退化成
  新建账号**:静默造出一个空白用户比报错糟得多。
  两处配套机制:
  **① 连接必须按凭据比对重建**(`wechat-ilink.reconcile` 的 `usesCredentialsOf`)——
  accountId 没变,只看"这个账号有没有连接"会把作废的 token 一直用下去,表现是扫了码依然
  收不到消息且日志无异常。凭据失效(errcode=-14)的连接则**故意不重启**,重连只会再吃一次
  -14;它等的就是重新扫码。
  **② userId 归一化**(`accounts.canonicalUserId`,经 `ConnectionHooks` 注入连接):
  换一份 bot 凭据后同一个人的 from_user_id 会不会变由 iLink 决定,我们控制不了。
  `replaceCredentials` 给已绑定的账号置 `pendingRebind`,下一条来信若换了标识就登记进
  `userIdAliases`,于是 userKey 照旧。**认领与命中必须在同一条来信内完成**(先消费标记再查表),
  否则第一条消息会开出一个空白用户。标识没变时别名表是空的,整条路径等同于不存在。
  归一只作用于 userKey;`replyCtx.toUserId` 必须存**原始** from_user_id,否则回信投不到人。
  安全前提与 TOFU 同一条(bot 属于扫码那个微信号自己),所以拿别人的微信重新扫码 =
  把这位用户的会话与工作目录转手,账号页上写明了。`unbind()` 连同别名一起清空 —— 它的语义是换人。
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
- **会话规则**(`session.ts`):距上次 <1h(可每用户覆盖)→ resume,否则开新会话;
  `reminded` 标记防重复提醒,`record()` 与 `touch()` 都重置它。
  `/继续` 一律走 `touch()`(刷新时钟,不起回合),之后的消息自然命中「未超时 → resume」——
  同批还是单发都一样,分拣节点的线性顺序保证了"先续上、后说话"。
  **指令词汇不住在这里**,`decide()` 连布尔标记都不收 —— `commands.ts` 才认识 `/继续`。
- **离开的会话归档进 history,不删除**(`session.ts`):每用户 `current + history`
  (上限 `HISTORY_LIMIT`,同 id 去重),`/新会话` 与被切走都走 `archiveCurrent()`
  (在飞回合同时转后台,见上面 detached 那条),
  `/切换会话` 用 `switchTo()` 按 id 前缀切回并刷新时钟(之后的消息自然 resume,
  不需要 `/继续` 标记)。SDK 的 resume 默认不 fork,**同一段对话的 id 稳定不变** ——
  history 不会被同一段对话的多轮刷爆,这是整个设计成立的前提。
  切回的入口教育有三处:超时提醒、`/新会话` 确认语、`/切换会话` 确认语,
  都从 `canonicalOf("switchSession")` 取指令写法。
- **`/切换会话` 失败时只中止这批**剩下的**段**(`gateway.handleBatch`):那些话是冲着
  它本该切到的会话说的,落在当前会话里既答非所问又白花额度 —— 宁可让用户确认 id 后重发,
  但必须明说「这批消息先不处理」。指令**之前**已投递的段不受影响,它们本就属于前一个会话。
- **切换前用 `sessionExists` 确认目标记录还在**(`gateway` 注入,指向
  `transcript.sessionFileExists`):保留期清理与 `dropSessionIds` 同步出清,但清理
  周期之间、或 JSONL 被外部删除时,history 仍可能挂着死引用 —— 切过去让 resume
  炸出原始报错,不如提前给句人话(`gone` 分支)并当场剔除条目;会话清单也先出清
  再展示。歧义只在活着的条目之间算,死条目直接让位。
- **分拣节点是串行的,但它不等回合**(`gateway.handleBatch`)。整条流水线的立足点:
  一批消息按**到达顺序**线性处理,起了回合就往下走。由此得到三件事 ——
  ① 卡死的 agent 堵不住分拣,所以改会话状态的指令可以安全地在这里线性执行,
  不必绕队列、也不必给在飞回合打标记等它自己收尾;
  ② 指令**之前**的话投递给切换前的会话、**之后**的话投递给切换后的会话,顺序天然正确,
  不需要"整批不处理"这类粗糙语义(那是压平成「一段文本 + 几个标记」之后才被迫用的);
  ③ 指令失败时只中止**剩下的**段 —— 那些话是冲着它本该切到的会话说的,
  已投递的不受影响,它们本就属于前一个会话。
  **分拣链与"这批处理完了"是两条 promise**(`enqueue`):链上只等分拣本身,
  返回给渠道的那条额外等这批起的回合 —— stdin 靠它决定何时打提示符,
  iLink 靠它顺序处理带图的消息。两者混成一条,回合就又把队列堵上了。
- **immediate 硬指令绕过聚合与队列**(`gateway.dispatch`):`/取消` 这种救命的等不了
  聚合窗口那 1.5 秒,也不该排在前一批的处理(含发 greeting 那样的网络 IO)后面。
  代价是与分拣节点、与在飞回合都并发,所以**只做幂等的只读/中断**操作。
  改会话状态的一律走队列 —— 就地执行会与投递并发,那句话就落到谁也说不清的会话里。
- **切走会话 ≠ 停掉它的回合**(`TurnContext.detached`):`/新会话` `/切换会话`
  `/api/me/session/reset` 都只是把当前回合标成 detached,它继续跑完。三处行为随之改变:
  中途进度不再推(用户已经在跟别的会话说话了)、正文带【后台对话 xxx 的结果】前缀发出
  (否则会被当成当前对话的答复)、产出走 `sessions.archiveTurn()` 只更新 history。
  **出处对报错同样要标**(`labelIfDetached` 在 catch 分支也走一遍):一句没头没尾的
  「处理出错了」会让用户以为是他刚发的那句话出了问题。抛错告终的回合没有 reply 可问
  sessionId,所以那里允许缺 id —— resume 的用 `decide()` 给的那个,新会话的只说清
  「这是后台的」、切回写法给不出就不给,总好过为了凑齐格式干脆不标出处。
  **后台回合绝不能 `record()`** —— 那会把用户刚切过去的会话顶掉,而他正在跟它说话。
  `archiveTurn` 必须能"插入"而不只是"更新":新会话的第一轮被切走时,sessionId 要等
  回合跑完才存在,那时它还没进过任何名单。
  代价说清楚:**前台与后台回合共享同一个 cwd**(每用户一个),同时改同一个文件会互相踩 ——
  等于用户自己开了两个终端。每会话一个 cwd 更糟(切换会话就换了目录,文件不通)。
  `/取消` 只中断前台:后台那些是用户主动切走、说了"你接着跑"的,顺手灭掉是误伤。
- **同一会话绝不并发 resume**(`gateway.deliverInput`)。串行的粒度是**每会话**,不是每用户 ——
  后者只是当年用不着更细。保证它的是两条:分拣节点串行且是唯一起回合的地方;
  前台回合还在时,新输入要么追加进去,要么**等 `turn.done` 再来一次**。
  追加失败(额度用尽/图被挤光/正在收摊)就地另起一轮是错的,两个回合 resume 同一个
  sessionId 会把上下文撕坏 —— 有单测盯着 `peakInFlight`。
- **回合跑到一半进来的消息优先「追加」,不必等这一轮跑完**(`gateway.deliverInput` +
  `agent.ts` 的 `InputChannel`):它会被折进**正在跑的那个 turn**,模型下一次请求就看到。
  排队等这一轮结束在用户那边就是「发了没反应」——纠正类的消息尤其吃亏:
  跑错方向的那一轮还得跑到底,额度照花。三条**实测**结论撑着这个设计(SDK 0.3.220):
  ① 中途 push 的消息折进当前 turn,全程只出**一个** `result`;
  ② `result` 已出、输入流还开着时 push 则另起一个 turn,**session_id 不变**,再出一个 `result`;
  ③ push 之后**立刻** `close()`,那条消息照样跑 —— close 只表示"不会再有输入",
  不丢已 push 的。所以**不存在丢消息的竞态**:`run()` 收到 result 就关追加窗口 + close 流,
  然后**继续消费**剩余 result 把正文按序接起来。收到第一个 result 就 break 会把挤在
  边缘那条静默吞掉,那是最糟的失败模式。
  `MAX_FEEDS_PER_TURN` = 100 是**兜底不是配额** —— 理由与 `AGGREGATION_MAX_MULTIPLIER`
  一字不差:用户还在补话说明他还没说完,拒绝追加等于在他说话中间切断他,
  而拖长的只是他自己这一轮,碍不着别人。
  配套三条:图片上限**跨追加累计**(闸门管的是整个回合的内存峰值,不是每条消息);
  进度节流每次追加后**重置**(追加带来新的 `context_token`,发送预算跟着回来了);
  被折进 turn 的消息**不在 SDK 消息流里露面**,所以 `progress.fed` 只能网关自己记账 ——
  `/状态` 那句「期间补充 N 条」是用户确认"我刚补的赶上了没"的唯一出口。
- **`decide()` 不认识 `/继续`**(`session.ts`):规则只有一条「未超时就续上」。
  `/继续` 由分拣节点用 `touch()` 消化 —— 把时钟拨到现在,同一批里后面的话自然命中。
  线性处理让"先续上、后说话"的先后天然成立,不必把这件事一路传进状态机。
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
  用户贴图就是要它现在看。**所有回合(含纯文本)一律走流式输入**,不再传 string ——
  理由见上面「回合跑到一半进来的消息优先『追加』」那条:追加只有流式输入下才收得进。
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
- **LLM 侧的可观测性分两级,分界线是"事后才想起要查"**(`agent-trace.ts`):
  回合起止、`init`、API 重试、限流、上下文压缩、`stderr`、心跳一律记录(`always`),
  **不受开关约束** —— 需要它们时通常是事后翻日志,那时再开开关重启已经晚了;
  逐条 SDK 消息的摘要才归 `CATMAN_AGENT_TRACE=1`(`trace`)。加新的消息类型时先问
  「它是不是某种『为什么没反应』的答案」,是就进 always,否则进 trace。
  与 `formatTrace` 同一条约束:**只出标量与截断摘要,不出正文** —— 思考/文本只出字数、
  工具结果只出长度与成败、图片只出 base64 字符数。`describeSdkMessage` 是纯函数,
  这条约束钉在单测里。唯一例外是工具入参摘要:"在跑什么命令"正是要找的东西,
  而且它与推给用户的进度共用 `summarizeToolInput`,两处必须说同一句话。
- **心跳用定时器不违反「进度不用定时器」那条不变量**(`agent.ts` 的 `HEARTBEAT_MS`):
  那条约束的理由是定时器会让进度**消息**插到正文之后、在用户那边乱序,而心跳只进日志,
  没有相对正文的位置可言。心跳的"上次动静"以**任何一条** SDK 消息为准(不只是
  onProgress 透出的思考/工具),否则工具结果回填期间会把正常推进的回合误报成卡住。
- **`onProgress` 回调无条件挂上,`progressEnabled` 只决定推不推给用户**(`gateway.handle`):
  它同时在维护 `turn.ctx.progress` 快照,而 `/状态` 与心跳都读那份快照。绑在一起的话,
  一个纯粹的省流开关会顺手把可观测性也关掉。
- **`/状态` 第一行是在飞回合的状态**(`gateway.inFlightText`):排队 / 处理中 / 正在中断 /
  空闲四种分开说 —— 处置完全不同(排队时 `/取消` 自己这条没用,空闲说明消息压根没被受理)。
  它是用户侧唯一不受回合阻塞影响的观测点:`/状态` 走 immediate 分流、不进串行队列,
  所以回合卡死时照样答得出。读快照是幂等只读,符合 immediate 硬指令的约束。
  `progress.running` 与 `startedAt` 必须分开:前者是拿到并发名额的时刻,两者之差就是排队时长。
- **`result.is_error` 有两个消费者,缺一个就是一种静默**:日志(`agent.logResult`)与
  用户侧的 `TURN_ERROR_PREFIX`(`gateway.runTurn`)。SDK 以 result 报错(鉴权失败、超限、
  达到轮数上限)时,`text` 装的是错误原文而不是模型的答复,却走**与成功回复完全相同**的
  发送路径 —— 不标记的话「Credit balance is too low」在用户那边和助手说的话长得一模一样。
  原文照发不翻译:它是去查订阅/配置的唯一线索。配套的是 `agent.joinReplyTexts` 的空正文
  兜底**分失败与成功两种话术**:`errors` 可能是空数组,沿用"助手没有返回内容"会把一次
  失败伪装成一次无话可说,而这两者用户该做的事恰好相反。
- **日志一律带时间戳**(`log-stamp.ts` 在 `index.ts` 最前面包裹 console):排查发送问题时
  "这两条隔了多久"是最基本的信息。包 console 而不是换 logger,是因为几十处调用点加上
  SDK 自己打的,漏一处那行就成了时间轴上的断点。容器**不继承宿主时区**,compose 透传 `TZ`。
  排查 iLink 用 `CATMAN_ILINK_TRACE=1`,每条发送打「第几次 / 成功过几条 / token 多老」;
  **失败行无条件打印**,因为回执与进度的失败在 `gateway.trySend` 那层是被吞掉的。
  排查 LLM 侧用 `CATMAN_AGENT_TRACE=1`(逐条 SDK 消息),但回合起止/重试/限流/心跳
  本就无条件打 —— 见上面那条分级原则。
- **iLink App 标识无需申请**:`appid="bot"` 是官方包固定值,client version 是版本号编码;
  唯一个人凭据是扫码得的 `bot_token`。仅这些需真机校准:QR 端点、SKRouteTag、channel_version、限流。
- **两个 CLAUDE.md**:本文件是开发指南;运行时 agent 加载的是 `/data/workspace/CLAUDE.md`
  (在数据卷内),那才是塑造助手人设/行为的地方。多用户下它是**共享**人设,
  每人目录下还有一个自己的 `CLAUDE.md`(首行 import 共享的那份)。
- **数据向前兼容,不做迁移**(源码直跑之后这条改过口径,别按旧的写):
  **日常升级与回滚都不动 `/data`** —— 回滚只换 `releases/current` 的指向。所以改动必须
  **能读盘上现有格式**,而且因为观察期内随时可能回滚,**旧版本要能读新版本写的**。
  做不到的属于要人工介入的变更,不走自动流水线。兜底靠既有的防御式解析
  (`parseUserKey()` 非法返回 null、`SessionManager` 加载时丢弃、prefs 回落不改盘、
  `settings.effective()` 永不抛)—— 那是解析器本就该有的防御,不是迁移分支。
  跨越不兼容格式(如从单账号版本升级)才是清空 `./data` 重新扫码:
  别为一次性场景把旧格式的知识永久留在代码里。

## 自进化

目标:管理员在微信里说一个改进想法,catman 自己改代码、跑测试、制备 release,汇报后由人
确认,再由**独立的 deployer 容器**完成切换与回滚。失败的最坏结果是"这次改进没上线",
而不是"catman 下线了"。完整设计(含四轮对抗评审推翻的方案与理由)见设计文档;
下面只列实现层必须守住的不变量。

- **更新者不能是被更新者**:切换与回滚跑在独立的一次性容器里(`deployer-run.sh` 起,
  容器名固定 = 天然串行互斥)。它做的第一件事就是 `docker stop catman` —— 跑在 catman 里的
  子进程会在那一刻连同父进程一起被杀,切换停在半路。
- **执法者自己取证**:smoke 由 deployer **亲自**跑(不是让 agent 递一份"我测过了"的证明),
  健康门比对的 sha 是它从 `/health` 亲自读的。agent 改坏了自检代码,结果只会是它自己的版本
  过不了门,而不是门失效。
- **`stable` 只在观察期结束后前移**(`deployer.sh`)。观察期内 `current ≠ stable`,
  所以那段时间的任何崩溃(含宿主断电重启)都自然落回 stable。反过来(切换成功就前移)
  会让观察期变成纯仪式:真出事时"回滚目标"恰恰就是刚上线的坏版本。
- **回滚是"先停、再换、后起"**:不先停就换链接的话,restart 策略会在中途把旧容器拉起来,
  而 crash-loop 的容器每次启动都可能再写一遍状态文件 —— 回滚这个最后防线自己产出损坏状态。
- **换链接必须可从任意断点重跑**(`pointer_set`):deployer 可能在 `ln` 与 `mv` 之间被杀,
  残留的 `.tmp` 会让下一次部署在 `ln -s` 上 EEXIST 失败,而那时容器已经停了 —— 没人拉起它。
  所以开头无条件清残留并用 `-f`。
- **GC 的保留集 = 已验证清单 ∪ 全部指针的 realpath**(`gc`)。指针那一半不能省:守护人格
  钉住的 release 天然是最老的,只按"保留最近 N 个"会把它的脚下抽空 —— 而活进程握着已删
  inode 照样在跑,直到某次断电重启才暴露,那正是最需要它的时刻。
- **`docker build` 不进部署路径**:切换不重建容器(配置没变),所以流水线完全不碰
  docker compose。它的文件优先级(`compose.yaml` 盖 `docker-compose.yml`)、override 自动合并、
  `${PWD}` 在容器里插值成空串、项目名不一致导致认领失败、两个 compose 版本算出的
  config hash 不同引发反复 recreate —— 这些坑不用它就一个都不存在。改 compose 仍然要人。
- **devDependencies 保留,绝不 prune**(`prepare.sh`)。曾经的设计是"装全量→跑测试→prune",
  而下一次制备若 lockfile 没变就 `cp -al` 硬链接复用上一个 release 的 node_modules ——
  那棵树里已经没有 tsc/tsx,**最常见的那条路径必然失败**;补装又会就地写文件,透过硬链接
  污染上一个(可能正是 stable)release 的字节。不 prune 让两个坑同时消失。
  配套纪律:**复用之后对那棵树零 npm 写操作**。
- **不用 `git worktree` 制备**,用浅 clone:worktree 的 `.git` 只是指向共享仓库的指针,
  清理时 `rm -rf` 会留下元数据残骸,导致**同一个 sha 无法再次 worktree add** ——
  恰好死在"回滚之后想重新制备旧版本"这条事故恢复路径上。
- **完整性靠内容清单不靠 git**(`release_verify`):`dist/` 与 `node_modules/` 都在
  `.gitignore` 里,`git status` 对它们**全盲**,而那才是真正被执行的字节。有人往 dist 里
  打个热补丁,git 一无所知。所以制备时生成 MANIFEST,切换到任何 release 之前重验。
  目录去写权限只做**目录**不做文件:目录 inode 不被硬链接共享,chmod 文件会穿透到复用
  同一批文件的旧 release。
- **smoke 失败要分类**(`selfcheck.ts` 的 `classifyFailure`):限流与网络是**环境**的错,
  退避重试;把它们判成"新版本坏了"会让一次二十分钟的上游抖动废掉一个完好的版本。
  分类错的代价不对称,有单测逐类钉死。
- **自检模式的 stdout 是结果通道,只出一行 JSON**(`index.ts` 的 `selfCheckMain` 调
  `redirectConsoleToStderr`)。Node 的 `console.log/info/debug` 默认写 stdout,而自检期间
  装配、SDK、agent-trace 的 always 级别都在打日志 —— 漏一行进去,deployer 解析到的就不是
  JSON,于是**每一次部署都以「自检没过」告终,而 release 完全是好的**。把好版本判死的门
  比没有门更糟。改道不是静音:诊断全进 stderr,由 deployer 的容器日志收着。
  读取端同样防御式(`deployer.sh` 只取以 `{` 开头的最后一行)—— 自检代码属 Tier 1,每周都在变。
- **制备要先让 git 接受属主不同的仓库**(`lib.sh` 的 `git_trust_repo`):`/data/src/catman`
  归 catman(10001)—— agent 在上面开分支;而制备跑在 deployer(10002)下,属主一不同
  git 就 "detected dubious ownership",**第一条 git 命令就失败**。开发机上两者是同一个人,
  所以这条路径只会在真机上炸。**两条 safe.directory 都要**:`rev-parse` 认仓库目录,
  `clone` 认它下面的 `.git` —— 少一条会一路正常到 clone 那步再炸。
  单测用 git 自带的 `GIT_TEST_ASSUME_DIFFERENT_OWNER` 开关钉住。
- **一次性容器要显式补 docker.sock 的属组**(`init.sh` / `deployer-run.sh` / `bless.sh` 的
  `DOCKER_GID`):它们以 uid 10002 跑,而 socket 的属组是**宿主**的事实(OpenWrt 多为 0,
  Debian 多为 999),镜像里无从得知 —— 与 compose 给主容器 `group_add` 是同一个决定。
  漏了的症状是 `/回滚` 起了容器却什么都没干,日志里只有一句 permission denied。
  取值:bless 时在宿主 `stat -c %g` 记进 `/data/deploy/env`,运行时兜底再 stat 一次。
- **健康检查的 curl 必须 `--noproxy '*'`**(`lib.sh` 的 `health_json`):代理环境变量是
  **必须**透传给 deployer 的(smoke 要够得着 Anthropic API),而 `NO_PROXY` 里的 CIDR
  只对 IP 字面量生效、对主机名是后缀匹配 —— `172.16.0.0/12` 拦不住 `host.docker.internal`。
  于是健康门永远超时,每次部署都在最后一步自动回滚。靠"配置里记得写排除项"挡不住,钉在代码里。
- **健康门只看本地可判定项**(`health.ts`):进程起没起、渠道通不通、`version.sha` 对不对。
  大脑状态(`lastTurn`)只是观测位,**不参与判死** —— 真正的大脑探测在 SELFCHECK 里,
  由 deployer 在切换**之前**跑。
- **排水要三个计数同时归零**(`GatewayHealth`):聚合窗口(`aggregating`)、分拣链(`queued`)、
  在飞回合(`inFlight.foreground`)。只看在飞回合的话,卡在前两段的消息会被切换连人带话
  一起杀掉,用户那边就是"发了没反应"。后台回合**不算**(用户主动切走的长任务,等它们等于
  永远切不了),被中断的条数写进报告如实相告。
- **版本戳读不到就是 undefined,绝不编**(`version.ts`):健康门拿它比对,编造的值会让门
  放行一次实际没切成功的部署 —— 那正是这道门存在的理由。
- **两份 JSON 是跨版本契约**:部署报告(`deploy-report.ts`)与已验证清单(`deploy.ts`)由
  钦定版本的 deployer 写、每周都在进化的 catman 读。字段只增不改,读取端一律防御式解析,
  读不懂就当没有(而不是抛错拖垮启动)。`/health` 同理,golden 测试钉着形状。
- **部署机制不随自我进化更新**:`/回滚` 执行的是 `bless.sh` 固化到 `/data/deploy/bin/` 的
  那份脚本,不是当前 release 里的。改了 `scripts/evolve/` 要重新 bless 才生效 ——
  门禁和逃生门是同一把锁,不能让一次改坏了部署逻辑的进化把它们一起毁掉。
- **部署类指令是 `adminOnly`**(`commands.ts`):影响是全局的(一次回滚把所有用户都换版本),
  而 catman 是多用户的。**挡掉 = 当它不是指令**,于是照常走 LLM ——
  非管理员既用不了、也看不出它们存在,不必回一句"你没权限"(那句话本身就在告诉他有这个东西)。
- **部署结果发送成功才标记已播报**(`announceDeployReport`):iLink 的发送本就可能失败
  (context_token 预算耗尽),先标记就等于把这条结果永久吞掉 —— 而「升级失败已回滚」
  恰恰是最不能丢的一条(用户接下来的话都基于"改动已生效"这个错误前提)。
- **入口脚本解析不到 release 时进引导模式**(`entrypoint.sh`),慢速重试而不是 crash-loop:
  全新机器上数据卷是空的,而能造出第一个 release 的 `prepare.sh` 要在容器里跑 ——
  直接 exec 的结果是最快速度反复重启刷屏,真正该做的事(跑 `init.sh`)却没有任何提示。

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
- 改指令写法时记得 `reminderText` 之类的文案 —— 用 `canonicalOf()` 引用而不是手写字符串。
