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
# 基底镜像,极少重建。构建期够不着 download.docker.com 时:代理要**大小写都传**
# (apt 只读小写、curl 只认大写),或 --build-arg DOCKER_APT_MIRROR=<国内镜像>。
docker build -t catman-env:1 -f docker/Dockerfile .
CATMAN_HOST_DATA_DIR=$PWD/data scripts/evolve/init.sh  # 首个 release + 指针
scripts/evolve/bless.sh                                # 固化部署机制(自进化要用)
docker compose up -d
# 制备:测试+编译,产出 release。跑的是 **bless 固化的那份**(制备门在它里面,
# 见下面「自进化」);路径要写全 —— 镜像没设 WORKDIR,docker exec 从 / 起步。
docker exec catman /data/deploy/bin/prepare.sh HEAD
scripts/evolve/deployer.sh deploy <sha>                # 排水→自检→切换→健康门→观察期
scripts/evolve/deployer.sh rollback|status
# 微信里(管理员)则是 /发布 <前6位> 与 /回滚,不必开电脑。
# 自检(smoke)单独跑:不碰真实 /data,退出码即结论,stdout 一行 JSON
CATMAN_SELFCHECK=1 node dist/src/index.js
```

改完务必跑 `npm run typecheck && npm test`(strict + noUncheckedIndexedAccess 全开)。

## 进程拓扑(Phase 3 起)

```
catman-courier   pinned release · 稳定面 · restart:always
  ├─ 全部 iLink 连接 + AccountStore(**唯一写者**)+ 扫码 + TOFU 准入
  ├─ inbox:每人格一个持久化队列(at-least-once,人格落批后才 ack)
  ├─ replyCtx 持久化 + 发送预算**唯一权威**(按 kind 预留)
  ├─ 路由表 userKey → persona(+ TTL 自动回落)+ /救援 /主人格 /绑定
  └─ IPC:unix socket 上的 HTTP(/data/ipc/courier.sock)

catman           releases/current · 主人格 · 每周被自动进化
  └─ BridgeChannel(name="wechat")⇄ IPC

catman-rescue    pinned release · CATMAN_DATA_DIR=/data/rescue
  ├─ BridgeChannel ⇄ IPC(persona=rescue)
  ├─ 机械看门狗(决策纯函数;执行走固化的 deployer demote)
  └─ 无 LLM 状态页 :8788
```

三种角色**同镜像、同一份 release**,靠 `CATMAN_ROLE` 分开(`docker/entrypoint.sh`)——
写成三个镜像会破坏「测试环境即生产环境」。守护人格与主人格是**同一个入口**,
差别全在配置;两套装配会慢慢走样,而它恰恰是最不该在需要时才发现"跟主人格不一样"的那个。

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
| `src/core/skills.ts` | 启动时按人格生成三个 SKILL.md(接口说明按需加载,不占系统提示词) |
| `src/core/persona.ts` | 人格自述(进 `systemPrompt.append`)、共享人设占位、管理员名单的跨命名空间继承 |
| `src/core/agent.ts` | Agent SDK 封装;**必须**带 claude_code preset 三件套(见下);常开输入通道支持回合中途追加 |
| `src/core/version.ts` | 版本戳:读 release 根目录的 VERSION;**读不到就返回 undefined,绝不编** |
| `src/core/selfcheck.ts` | SELFCHECK 模式:自己开临时目录装配一遍 + 探一次大脑;失败分类(限流/网络/凭据/代码) |
| `src/core/deploy-report.ts` | 部署报告契约(deployer 写、catman 读)+ 防御式解析 + 已播报标记 |
| `src/core/deploy-progress.ts` | 部署里程碑契约(切换/转稳定/推远端,JSONL 追加)+ 防御式解析 + 已播报标记 |
| `src/core/deploy.ts` | 部署控制面接口 + 已验证版本清单解析 + 走固化脚本的实现 |
| `src/core/releases.ts` | release 目录的**只读**视图:枚举已制备的候选 + `/发布` 的 sha 前缀解析 |
| `src/dashboard/health.ts` | `GET /health` 的纯函数组装 + 排水判定;**跨版本契约,字段只增不改** |
| `scripts/evolve/` | 自进化流水线:lib / prepare / deployer / deployer-run / bless / init |
| `docker/entrypoint.sh` | 解析 release 链接再 exec node;解析不到进**引导模式**(慢速重试,不 crash-loop) |
| `src/core/agent-trace.ts` | LLM 侧可观测性:SDK 消息 → 一行日志(纯函数,分 always/trace 两级)+ 心跳文案 |
| `src/core/session.ts` | 会话状态机(纯函数 decide + 注入时钟/store/每用户超时;current + history;后台回合走 archiveTurn) |
| `src/core/gateway.ts` | 串联各层;**分拣节点**(线性处理一批、不等回合);追加输入;每会话串行;并发信号量;greeting |
| `src/channels/composite.ts` | 多渠道复合 + 复合准入,按 userKey 前缀路由 |
| `src/channels/dashboard.ts` | 管理员聊天渠道(记录落盘 + SSE 订阅 + 回执撤回) |
| `src/dashboard/api-self.ts` | `/api/me`:回合令牌鉴权,agent 管自己的配置 |
| `src/dashboard/api-cron.ts` | `/api/me/cron`:同一枚回合令牌,agent 管自己的定时任务(**必须排在 `isSelfApiPath` 之前**,那个判定认领整个 `/api/me/` 前缀) |
| `src/core/cron/schedule.ts` | cron 解析 + 下次触发时刻 + 频率下限判据。**纯函数**,自带时区换算,零依赖 |
| `src/core/cron/validate.ts` | 创建/修改任务的入口校验。调用方是 LLM,所以未知字段一律拒收、字段名自带单位、能当场算的都当场算 |
| `src/core/cron/store.ts` | 任务表 + 执行记录 + 保留策略(按次数为主、年龄为辅);**认不出的任务隔离不删**(回滚安全) |
| `src/core/cron/docker.ts` | 脚本任务的执行面:detached 一次性容器 + 隔离参数;**catman 重启不打断在跑的任务** |
| `src/core/cron/scheduler.ts` | tick 调度:先收尸再点火;错过只补一次且要在窗口内;overlap 判定排在全局并发之前;agent 任务**不等它跑完**(在 tick 里 await 会把整个调度器挂住) |
| `src/core/cron/agent-runner.ts` | agent 任务的执行面。**必须把 turn 标成 detached** —— 否则它会被当成用户的前台回合,用户下一条消息会等它跑完 |
| `src/core/cron/notices.ts` | 静默时段判定 + 攒着的结果合并成摘要。落盘(部署常常就发生在攒着的那几小时里) |
| `src/core/turn-env.ts` | agent 子进程环境的**唯一**定义(用户回合与定时任务共用)。IPC secret 一条例外都不下放 |
| `src/core/cron/notify.ts` | 通知文案(纯函数)。只用信使已认识的 SendKind:开跑 `reminder`(只留最新)、结果 `announce`(一条不丢) |
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
- **人格身份走 `systemPrompt.append`,不走 skill 也不走 CLAUDE.md**(`persona.ts`)。
  真机踩过:管理员发 `/救援` 切过去,守护人格张口就说"我现在跟你对话的就是主人格本身"——
  它没说谎,三处身份来源当时全是人格无关的(preset 一模一样、skill 同一套、
  而**人设 CLAUDE.md 在它的命名空间下压根不存在** —— 它的 workspace 是
  `/data/rescue/workspace`,人手写的那份共享人设在主 `/data/workspace`,只读且不在同一棵树)。
  三个候选载体各自的问题:**skill 正文按需加载**,模型可能压根不去读(与「图片走内联
  不给路径」同一条理由);**CLAUDE.md** 住在数据卷里、用户能改能删,而"我是哪个人格"是
  装配事实,改不掉才对;**消息前缀**会污染对话记录且 resume 之后就没了。
  代价如实记:append 每回合都付钱,所以两段自述刻意短(单测钉着 <1200 字符),
  细节交给按需加载的 `catman-rescue` skill。**每条禁令都对应一个它做得到但不该做的动作** ——
  泛泛一句"你是守护人格"挡不住一个手上有 bypassPermissions 的 agent。
- **skill 也要按人格分**(`skills.ts` 的 `skillsFor` / `writeSkills`):守护人格拿
  `catman-rescue`,**拿不到** `catman-evolve`。它跑钉住的稳定版本,改了代码也上不了线,
  而 skill 的 description 常驻上下文 —— 摆一份「怎么改自己的代码」在那儿,就是在邀请它
  去做一件注定白费的事,而人正在等它诊断。两个分支必须对齐(列一个磁盘上没写的 skill,
  SDK 那边只是安静地少一份说明,而它恰好是最需要的那份),有单测跑 `writeSkills` 再逐个查文件。
- **管理员名单要跨命名空间继承**(`persona.ts` 的 `adminBaseline`):`isAdmin` 读的是
  **本进程数据目录**下的 settings.json,而守护人格的是一个全新的空文件 —— 真机症状是管理员
  一发 `/救援` 就被降级成普通用户(`catman-rescue` 看不到、部署指令当不认识、管理员令牌
  也拿不到),**而诊断与恢复恰好全是管理员的活**。所以它从主 settings.json 继承一份当
  **env 基线**(自己那份的显式值照旧赢),显式 `CATMAN_ADMIN_USER_KEYS` 又赢过继承 ——
  后者是排查时唯一的旋钮。读不懂就当空、绝不抛:守护人格起不来比它少一个管理员糟得多。
- **greeting 的判定权在信使,人格只消费**(`IncomingMessage.greeted` → `gateway.onIncoming`):
  信使是唯一见过某个 userKey **全部**历史的进程,而人格有好几个、各有各的 `users.json`。
  不接这个标记的话,用户每切一次人格就吃一整份一模一样的欢迎语 —— 白烧一条发送预算
  (一个 context_token 只够发约 10 条),而且看起来像"它把我当新人了"。
  **只能用来抑制,不能用来触发**:缺席表示这个渠道没有这项知识(stdin / dashboard),
  那时退回人格自己的记录判断。消费点必须在 `ensureWorkspace()` **之后** ——
  `markGreeted` 对还没注册的用户是空操作,而首次 `/救援` 恰好就是"这个人格第一次见到他"。
- **渠道消息的接线是 `gateway.onIncoming` 一个方法,不写在 `start()` 的闭包里**:
  单测为了不起真实渠道,曾经自己抄了一份等价接线 —— 于是 `start()` 每加一件事,
  那份抄件就悄悄少一件,**测的是一条生产里不存在的路径**(greeted 那次实现明明对了、
  用例却红)。收成一个方法之后两边共用同一份。
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
  ⚠️ 这条只在**消息真能在回合跑着时到达网关**的前提下成立,而这个前提整整坏过一个
  版本(bridge 的投递链在等回合跑完)。改渠道那一层时先看 `channels/types.ts`
  的 `Accepted`:任何"投递完再投下一条"的写法都会把这套机制悄悄废掉,
  而它坏掉的样子与从来没实现过一模一样。
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
- **iLink 协议约束**:回复必须带入站消息的 `context_token`(否则 HTTP 200 静默失败)。
  所以"主动推送"能不能成,取决于**手上还有没有一份没花完的上下文** —— 信使把它落了盘
  (`courier/reply-store.ts`),于是超时提醒、部署进展这类没人开口时要说的话是发得出去的
  (真机日志里有一条 `ctx龄=3532555ms` 的成功发送,58 分钟前的上下文照样能用)。
  ⚠️ 这里长期写着"协议不支持主动推送",而落盘之后那句话已经不成立 ——
  它让部署结果一直挂在"等用户先开口"上,症状是发布之后**等多久都等不到结果**。
  发不出去仍是常态(预算耗尽 / 上下文失效),所以主动推送一律**静默降级 + 保留待播标记**,
  绝不是"发不出就算了"。
- **一个 `context_token` 的发送次数是有预算的**。真机实测过的上限是 **10**:第 11 条起
  `sendmessage` 返回 `ret=-2 prepare failed` 且**永不恢复**,之后连正文都发不出去,
  用户只收到"收到,正在处理中…"然后彻底静默。**是条数不是时效**:另一次记录里同一个
  token 用到 4 分钟(7 条)仍然正常;也不是限流 —— 限流会放行,而它首败后 45 秒仍全败。
  预算在 `courier/reply-store.ts` 顶部显式列支:`SEND_BUDGET(10) − 回执 1 −
  RESERVED_SENDS(2)` = `MAX_PROGRESS_PER_TOKEN`。**预留的两条是正文与额度提示。**
  从前预留四条(还有空闲提醒、部署播报),发件队列上线后砍掉了 —— 见下一条。
  排空留的余地写成 `LIVE_TURN_SENDS`(= 回执 + 保留额),从这笔账推出来而不是另写
  一个常量:预算一动,余地必须跟着动。
  **保留就是靠进度的上限实现的**(进度撞上限就再也发不出去,剩下 3 条谁也抢不走),
  所以改进度上限等于改保留额,改之前先把这笔账重算一遍。
  ⚠️ **这个 10 复测过,别再往上调。** 2026-08-12 放宽到 20 试过一次,当天撞回来:
  两次记录都停在**恰好 10 条成功**,第 11 条起 `ret=-2` 且永不恢复,与 token 年龄无关。
  代价是真的 —— 那次失败的一条是 1175 字的汇报,用户没收到。真想再试,先确认
  发件队列已经上线(积压至少补发得回来),并盯着 `ret=-2` 那行。
- **发不出去的消息进发件队列,不再丢**(`courier/outbox.ts`)。这是保留额能从 4 砍到 2
  的前提:"丢了就没有第二次"这件事消失之后,保留额就只是**时延旋钮**(答案当场到 vs
  等用户刷额度),不再是安全机制。四条必须记住的性质:
  ① **住在信使**,不能住 bridge —— 人格每周被进化重启、每次部署重启,队列放那边等于
     一次部署清空积压,而积压里正是那条没送出去的答案;预算的权威也在信使,
     两处各一个队列就又成了两本账。
  ② **不是 FIFO,是按 kind 定策略**(`POLICY`):正文/播报/兜底 `append` 一条不丢;
     进度/空闲提醒 `replace` 只留最新(它们是**状态**不是流水,补发十分钟前那句
     「🔧 Bash: npm test」毫无意义还白烧一格);回执 `drop` 压根不排队。
     这是 `SendKind` 换了岗位:从"预留几条"变成"发不出去时怎么办"。
  ③ **排空要限速(1.5s)也要留余地**(停在还剩 `DRAIN_FLOOR` 条)。榨干新额度等于让
     用户每问一句都先替上一轮买单。停下时说一句「还有 N 条」,**每份 token 只说一次** ——
     说这句话本身也花一格,反复说就成了用剩下的额度刷屏。
  ④ **催促不能丢**:排空跑着时又被 `kick`,要记下来跑完再来一遍(`rekick`)。少了它,
     用户发 `/nop` 时若恰好有一轮排空正在收尾,那次催促连同它带来的新额度一起被吞掉,
     表现就是"照做了却什么也没发生"。
  ⑤ **两句额度提示都归信使说**(「进度就报到这儿」「还有 N 条没发出去」),共用一份
     "这个 token 已经提示过"的记录。进度那句的触发条件是**一条进度被拒**而不是
     "余量剩 1"。当初这么写是为了让还带着 `progressBudget` 的旧人格撞不到它
     (它在上限前就收手),新旧两侧不会各说一遍;那份判断现在已经删了,
     于是这个条件成了唯一的触发点。
- **额度花光了不是绝路,`/nop` 就是那条出路**:用户随便发一句话都带来新的
  `context_token`,信使那边的计数随之归零。所以进度报到头时会**单独发一条**交代
  (`PROGRESS_CAP_NOTICE`)把这个口令告诉他。**那条交代自己占一格保留额**,不附在最后
  一条进度的尾巴上 —— 附着走就与进度共用同一份额度,而"进度用完了"正是它唯一该出现的
  时刻。它复用 `reminder` 这个 kind 而不新开一种:信使跑 pinned、版本天然更老,
  `parseSendKind` 认不出的 kind 会让**整个信封**读不懂(IPC 读不懂等于聋),
  那句提示就恰好在最需要它的时候消失。
  口令这一侧要成立还需要**两件事都做到**:网关收到 `/nop` 时
  ① 把节流器重新开闸(`TurnContext.resetProgress`)、② 真的发一条回话出去。
  少了①,节流器还记着"余量为 0",从此一条不发;少了②,网关手里的余量停在 0
  —— 它是上一次**发送响应**带回来的,不发就永远不更新。两种都表现为"照做了却没反应",
  而那句提示恰恰是我们让用户信的。所以 `/nop` 归**人格**执行,不归信使:
  信使就地消化掉的话,节流器压根不知道额度回来了。
- **发送预算整个不在核心里。** 核心只管把消息交给渠道,发得出去渠道就发,发不出去
  渠道排队。这条边界是分三步挪过去的,每一步都是踩了坑才走的,别往回走:
  ① 网关自己记一份账 → 信使上线后成了两本账(7 对 6),每个长回合都多发一条注定被拒的
     进度,而「进度就报到这儿」永远不触发(信使第 6 条就拒,网关第 7 条才提示);
  ② 改成每次现问渠道(`Channel.progressBudget`)→ 单一权威有了,但核心仍然要懂
     "还剩几条"这个概念,而 stdin / dashboard 上这个问题压根没有答案;
  ③ 现在:`progressBudget` 删了,`bridge.send` 也不再缓存余量。**额度、排队、以及
     那句"发 /nop 可以续上",全在渠道那一侧**(`courier/`)。
- **进度事件有三类:💭 思考、💬 中途说的话、🔧 工具调用**(`ProgressFan`)。
  💬 那类**必须延后一拍**:最终答复本身也是一个 `text` 块,当场透出去用户就会收到
  两遍同一句话(一遍当进度、一遍当正文)。而"这个 text 是不是答复"只有看它后面
  还有没有动静才知道 —— 后面又来了块,它就是中途说的;回合结束时还攒着,它就是答复。
  这个"攒一拍"是 `ProgressFan` 存在的全部理由,也是它被单独拎出来的原因:
  `query()` 是直接 import 的,那个循环没法在单测里驱动。
- **`ProgressThrottle` 只剩间隔阶梯**(5→15→30→60 秒),它管的是**观感**(多久说一次话),
  不是额度 —— 总条数由渠道那边的额度决定,发不出去的进度由信使排队且**只留最新一条**。
  同间隔内只发**最新**那条(进度是状态不是流水),丢掉的条数记在 `(+N 步)` 里。
  纯事件驱动、**不用定时器**:与旧实现一样"卡在长工具调用里就不更新",没有退步;
  而引入定时器就会有"回合结束后才触发、进度插到正文后面"的乱序。
- **LLM 侧的可观测性分两级,分界线是"事后才想起要查"**(`agent-trace.ts`):
  回合起止、`init`、API 重试、限流、上下文压缩、`stderr`、心跳一律记录(`always`),
  **不受开关约束** —— 需要它们时通常是事后翻日志,那时再开开关重启已经晚了;
  逐条 SDK 消息的摘要才归 `CATMAN_AGENT_TRACE=1`(`trace`)。加新的消息类型时先问
  「它是不是某种『为什么没反应』的答案」,是就进 always,否则进 trace。
  与 `formatTrace` 同一条约束:**只出标量与截断摘要,不出正文** —— 思考/文本只出字数、
  工具结果只出长度与成败、图片只出 base64 字符数。`describeSdkMessage` 是纯函数,
  这条约束钉在单测里。唯一例外是工具入参摘要:"在跑什么命令"正是要找的东西,
  而且它与推给用户的进度共用 `summarizeToolInput`,两处必须说同一句话。
- **`unref()` 只给纯观测的定时器,欠着动作的绝不 unref**。分界线是「它手里有没有别人
  在等的东西」:超时提醒(`gateway.reminderTimer`)、回合心跳(`agent.ts`)、SSE keepalive
  只是定期看一眼,晚一轮甚至不发都无所谓,不该拦着进程退出;而聚合窗口的 debounce
  (`gateway.collect`)攥着**已经从渠道收下、长轮询游标也推进了**的消息,自检的超时
  (`selfcheck.ts`)欠着「中止并给出分类结论」—— unref 它们等于宣告「只剩这件事没做时
  可以直接退出」,于是消息真丢、结论真的没有。
  **这类 bug 在生产里永远看不见**:进程总有 dashboard 与长轮询占着事件循环。
  它是靠制备容器里 node 22 的测试运行器暴露的(见事件循环跑空就把后面的用例全判
  `cancelled` 而非 `fail`)—— 也就是说,**流水线在镜像里跑全量测试这件事本身抓到了它**。
  `test/gateway.test.ts` 有一个不依赖 node 版本的用例直接问运行时要活跃句柄,钉住这条。
  注意开发容器与镜像的 node 版本可能不同,**以镜像里的为准**。
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

闭环的五步与各自的执行者:

```
改代码 → 制备 release → 汇报 → /发布 <前6位> → 切换+观察期
 agent    agent            agent   **管理员亲手打**   deployer
(/data/src/catman         (末行是                    (自检→排水→切换→
 上开 evolve/<slug> 分支)  新 sha)                    健康门→30min→前移 stable→push)
```

agent 那一侧的全部知识写在 `catman-evolve` skill 里(`skills.ts`,只对**主人格的**管理员
回合可见),包括开工前要核对的三件事、分支纪律、固化的制备路径、汇报格式、以及
"绝不自己起 deployer"。守护人格拿到的是另一份 `catman-rescue`(诊断与退版本),
两者互斥 —— 见上面「skill 也要按人格分」那条。

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
- **GC 的保留集 = 已验证清单 ∪ 全部指针的 realpath**(`lib.sh` 的 `release_gc`)。指针那一半
  不能省:守护人格钉住的 release 天然是最老的,只按"保留最近 N 个"会把它的脚下抽空 ——
  而活进程握着已删 inode 照样在跑,直到某次断电重启才暴露,那正是最需要它的时刻。
- **GC 枚举时必须跳过符号链接,并且只认 40 位十六进制的目录名**(同上)。带尾斜杠的
  glob(`"$DIR"/*/`)会把 current/stable/pinned 这些**指向目录的链接**一并列出来,而它们的
  名字当然不在保留集里 —— 于是 `rm -rf current/` 顺着链接进去**把目标 release 的内容掏空**,
  链接本身完好无损,日志上只有一句轻描淡写的"GC 清理 release current"。
  **保留集算得再对也白搭:删错的不是"没被保留的那些",而是"保留集本身指着的那些"。**
  真机上发生过一次,current 与全部回滚目标同时变成空目录。第二道闸(名字必须像 sha)
  的取向是**宁可漏删,不可错删** —— 漏删只占磁盘且人看得见,错删的是出事时唯一的退路。
  `release_gc` 因此住在 lib.sh 而不是 deployer.sh:它是这套脚本里最危险的函数,
  必须能被 shell 层单测直接跑起来验(拆掉任一道闸,用例立刻变红)。
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
  归 catman(10001)—— agent 在上面开分支;而制备跑在 deployer(10002)下。这个跨属主是
  **设计使然**(两个平面各写各的),不是意外,所以放行机制必须可靠。属主一不同 git 就
  "detected dubious ownership",**第一条 git 命令就失败**;开发机上两者是同一个人,
  所以这条路径只会在真机上炸。三条缺一不可:
  ① **两个路径都要放行** —— `rev-parse` 认仓库目录,`clone` 认它下面的 `.git`;
  ② **必须走 `GIT_CONFIG_GLOBAL` 配置文件,不能用 `GIT_CONFIG_COUNT` 那族环境变量** ——
  `git clone <本地路径>` 会 fork `git-upload-pack` 去读源仓库,而 git 在 fork 前显式
  `unset GIT_CONFIG_COUNT`(trace 里看得见),子进程一个例外都收不到,只留下一句
  "Could not read from remote repository";
  ③ 配置文件写在 `/tmp`,**每个容器各自调一次**,不要把 `GIT_CONFIG_GLOBAL` 传给别的容器 ——
  那边没有这个文件,而 git 对读不到的 global 配置是静默当空的,例外无声无息地丢掉。
  单测用 git 自带的 `GIT_TEST_ASSUME_DIFFERENT_OWNER` 钉住,并专门模拟一次子进程环境清洗。
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
  **`prepare.sh` 同属固化侧,理由一字不差**:制备门(typecheck + 全量测试)就在它里面,
  跑 release 里那份等于让被考的人自己出卷子 —— 一次把 `npm test` 改没了的进化,会让
  **此后每一次**制备都不再跑测试,而日志上看起来一切正常。所以 agent 跑的是
  `/data/deploy/bin/prepare.sh`,skill 与 README 只写这条路径(有单测钉着 skill 不教旧路径)。
  固化不是沙箱(谁都还能 `bash` 那份源码副本),它拦的是"约定路径悄悄变了"。
- **确认口令必须是硬指令**(`/发布 <版本号前6位>`,`commands.ts`):它是整条流水线里唯一一处
  把「人批准了什么」与「机器部署了什么」机械绑在一起的地方 —— sha 由人亲手打进来、
  由网关按字面解析。交给 LLM 识别「发布 abc123」再去起 deployer 的话,这把锁就挂在一个
  会看错字、会自作主张、而且**正是被部署的那一方**的环节上。网关在这里也**不做任何解释**
  (不补全、不纠错、不挑最近的一个),四种拒绝各说各的话:太短 / 没有(列候选)/ 歧义 /
  已经是当前版本。前缀下限 6 位,展示一律用 `shortSha()`(7 位),照抄汇报里那串永远合规。
- **判「已经是当前版本」看版本戳,不看 `current` 指针**(`deploy.ts` 的 `runningSha`):
  指针与运行中的进程对不上时(换了链接没重启、crash-loop 卡在旧代码上),重新部署一次
  **恰恰是修复手段**,按指针拒绝会把这条修复路径堵死。
- **Tier 分类表必须住在固化侧**(`lib.sh` 的 `tier_of`,不是 `src/` 里的 TS):它要是住在
  被自我进化改写的那棵树里,agent 顺手改一行 case 就能把 Tier 3 报成 Tier 1 ——
  而人正是靠这份报告决定还欠什么(重新 bless / 重建镜像 / recreate 容器)。
  分级**不拦任何事**也拦不住:Tier 3 的东西改了本就不会自动生效,那才是机械闸;
  这里做的是**说出来**,免得人以为"部署成功 = 我要的都生效了"。
  `gateway.ts` 故意不列进 1★:排水计数确实出自它,但它每周都在改,列进来会让几乎每次
  改动都是 1★,点名就失去意义 —— 守住排水语义的是 health 那份 golden 测试,而它在表上。
- **部署密钥是两把不是一把**(`lib.sh` 的 `fetch_key_path` / `push_key_path`):ssh 对私钥有
  属主检查(必须归当前用户或 root 且 0600),所以**一把钥匙只能服务一个 uid** —— 这是硬约束,
  不是设计选择。`/data/ssh/fetch/id_ed25519`(10001,**只读** deploy key)给 agent 拉代码;
  `/data/ssh/id_ed25519`(10002,可写)给 deployer 推远端。
  **agent 的 pull 是主路径,不能省**:人在开发机上改完 push 到 GitHub,catman 得拉得下来
  才谈得上制备。曾经把密钥整个归 10002,结果 agent 一行 `git pull` 都跑不了,而软路由宿主上
  连 git 都没有 —— "人上机 pull"实际是"再起一个容器、以 root 跑、跑完还得把 `.git` 里新生成的
  root 属主对象 chown 回去"。「agent 改不了远端历史」这道闸因此从**文件属主**上移到
  **GitHub 侧的只读 deploy key**,而后者更强:属主挡不住挂了 docker.sock 的助手,只读密钥挡得住。
  agent 那把写进**仓库配置**(`core.sshCommand`,`init.sh` 设)而不是容器 env —— env 要改
  compose(Tier 3,每次都要人),写进仓库之后 agent 一句朴素的 `git pull` 就能跑。
  **`init.sh` 绝不 chown 密钥**:属主就是"这把给谁用"的唯一声明,猜错等于把一份凭据改坏;
  它只诊断并按**属主**(不是可读性 —— 它以 root 跑,`[ -r ]` 永远为真)报告两个槽位的状态。
- **远端只由 deployer 在部署成功、stable 前移之后推进**(`lib.sh` 的 `push_upstream`):
  GitHub 上出现的永远是真正上线过并活下来的提交(推得更早会让远端记录一堆从未运行过的东西,
  而人恰恰靠远端判断线上是什么)。推失败(多半是远端也有人提交了)**只记日志,绝不反过来
  判部署失败**;同理**绝不 `--force`**,快进失败正是它该失败的样子。没有可写密钥时先说一句
  「跳过」再返回 —— 否则每次部署都会甩一段 ssh 的 Permission denied,看着像部署出了问题。
- **验脚本行为的用例必须自带干净环境**(`test/evolve-lib.test.ts` 的 `cleanEnv`):
  测试跑在**制备容器**里,而那个容器的 shell 是 `. /data/deploy/bin/lib.sh` 起来的 ——
  `load_blessed_env` 于是把**真机的** `/data/deploy/env`(宿主路径、镜像名、docker 属组)
  整个 export 进环境,`npm test` 一路继承。而它的语义是"已有值不覆盖",于是用例摆好的
  那份固化 env 永远赢不了真机那份:**开发机上全绿,制备容器里报「部署机制还没固化」
  并打出真机的路径**。所以这类用例一律剔除 `CATMAN_*` / `DOCKER_GID` /
  `GIT_CONFIG_GLOBAL` / `GIT_SSH_COMMAND` 再起子进程 —— 验的是脚本对给定输入的行为,
  不是它碰巧继承到什么。往固化 env 里加字段时这条自动继续管用。
- **别拿 inode 号验"文件被换掉了"**:inode 号会被**回收** —— unlink 之后紧接着在同一个
  目录建文件,文件系统很可能把刚释放的号再分配回来。要验"正在读它的进程不受影响",
  就开一个 fd、换完再从那个 fd 读(`bless` 那条用例)。比对 inode 号在开发容器里碰巧
  能过、在真机上直接假红,而假红比没有测试更浪费人。
- **固化环境由 lib.sh 自己读**(`load_blessed_env`):谁 source 了 lib.sh 谁就自动拿到
  `/data/deploy/env` 里的宿主路径、镜像名、docker.sock 属组,调用点不必记得 export。
  这是 agent 能直接跑 `prepare.sh` 的前提(它的进程环境里没有宿主路径,而制备要拿它去
  `docker run -v`)。**已经有值的一律不覆盖** —— 命令行上的显式覆盖是排查时唯一的旋钮。
- **agent 的 git 身份在仓库级设**(`init.sh`):镜像里什么都没配,而 `git commit` 没有
  `user.name`/`user.email` 就直接失败 —— 自进化的第一步就是提交。写仓库级而不是 global,
  不依赖 HOME 可写,且这份配置随仓库走。
- **`init.sh` 重跑修的是配置,不是版本**:`current` 指针在就**立即退出**,绝不碰指针与
  已验证清单。那两段是**引导**动作(把三个指针立到一个从未过门的 release 上、把清单重写成
  只有它一条);在活着的机器上重跑等于绕过整套门禁换掉线上版本,**并把全部回滚目标从清单里
  抹掉** —— 而抹掉回滚目标要等到真出事那天才被发现。配置类动作(git 身份、拉码密钥、
  属主、诊断)排在退出之前,幂等且确实需要能重跑。
- **bless 换文件必须换 inode**(`bless.sh` 用 `install` 而不是 `cp`):bash 边读边执行,
  `cp` 保留目标 inode、原地覆写字节,会让正在跑的脚本从中间读到新内容 —— 而"正在跑的"
  最可能是一个处在 30 分钟观察期里的 deployer(人往往正是在等它的时候顺手 bless)。
  `install` 先 unlink 再新建,老 inode 活到那个进程读完。有单测钉着(改成 `cp` 就变红)。
- **观察期长度是 `CATMAN_BAKE_SECONDS`**(默认 1800),`deployer-run.sh` 会透传。
  它是**真正的门**,缩短等于把判据退化成"起来了就算过"——首个真实回合把它打崩这类失败
  未必在两分钟内出现。迁移/演练时人在旁边看着,可以显式调短;日常别改。
- **部署类指令是 `adminOnly`**(`commands.ts`):影响是全局的(一次回滚把所有用户都换版本),
  而 catman 是多用户的。**挡掉 = 当它不是指令**,于是照常走 LLM ——
  非管理员既用不了、也看不出它们存在,不必回一句"你没权限"(那句话本身就在告诉他有这个东西)。
- **部署进展是主动推的,不等用户开口**(`Gateway.flushDeployNews`,15 秒一轮)。
  从前只在 prelude 里捎带,于是真机上的体验是"发布之后等多久都等不到结果,直到自己
  先说话" —— 而先说话恰恰是他想避免的事。主动推送做得到:信使把回复上下文落了盘
  (`courier/reply-store.ts`),会话空闲提醒早就靠它送达。三条纪律:**发送成功才标记
  已播报**(先标记等于把这条永久吞掉,而「升级失败已回滚」最不能丢);**失败最多再试
  两次、间隔 1 分钟**(失败的尝试照样烧同一份发送预算,烧光了连正文都发不出去);
  **定时器与 prelude 共用一条串行链**(否则两边同时判"还没播过",用户收到两遍)。
  用户开口那条路径不受重试上限约束 —— 他手上有一份崭新的上下文。
- **里程碑与报告分工**(`deploy-progress.ts` / `deploy-report.ts`):里程碑说"这一步过了"
  (切换成功 / 转稳定 / 推远端),报告说"整件事的结局"。失败**不写里程碑** ——
  否则用户先收到"已切到 xxx"再收到"已回滚",而中间那条本就不该发。
  里程碑是 **JSONL 追加**而非覆盖:三条之间隔着几十分钟(观察期),覆盖会让中间那条消失。
- **入口脚本解析不到 release 时进引导模式**(`entrypoint.sh`),慢速重试而不是 crash-loop:
  全新机器上数据卷是空的,而能造出第一个 release 的 `prepare.sh` 要在容器里跑 ——
  直接 exec 的结果是最快速度反复重启刷屏,真正该做的事(跑 `init.sh`)却没有任何提示。
- **入口脚本必须让显式命令穿透**(`entrypoint.sh` 开头的 `[ "$#" -gt 0 ] && exec "$@"`)。
  整条流水线全靠一次性容器干活(制备、自检、部署,以及宿主没有 bash 时的 init/bless),
  它们都是 `docker run <镜像> <命令>` 的形式;不认显式命令的话那个命令会变成 node 的 argv,
  于是**没有 release 时容器在引导模式里永远转下去**(首次初始化就此挂死),
  **已有 release 时更糟 —— 再起一个完整的 catman,两个进程同时写同一份 `/data`**。
  两种都不报错,只是不干你让它干的事。调用方补 `--entrypoint` 不算修好:那要求每个
  调用点(含将来新增的)都记得写,而且会绕开 tini,子进程僵尸没人收。
  `test/entrypoint.test.ts` 把三条分流都跑起来验(纯 sh,不需要 docker)。

## Phase 3 的不变量

- **人格进程不能持有 `AccountStore`**:`accounts.json` 只能有一个写者(信使)。
  人格里留一个实例就握着一份可能过时的快照,而那个类每次写都是**整份覆写** ——
  症状是"扫了码过一会儿又掉了"、"改的备注名自己变回去了",**没有任何报错**。
  `test/persona-isolation.test.ts` 从入口走**真实的模块图**断言到不了它,
  并配一条反向用例(信使**必须**到得了 —— 少了它,把 accounts.ts 删光也全绿)。
  dashboard 的账号面全部走 IPC 代理,超时与信使侧引用**同一个常量**。
- **IPC secret 一条例外都没有**(`gateway.childEnv`,连 admin 回合也剔除):
  拿到它就是拿到信使的整个控制面 —— 同容器同 uid,一句 `curl --unix-socket` 就能
  冒充任意 userKey 发消息(顺带烧光**别人**那条来信的 10 条预算 = 把他打成永久静默)、
  拉走并 ack 掉别人的消息、走 `/admin/*` 删账号(把 persona-isolation 那道墙整个绕过去)。
  管理员令牌还有"admin 回合加回"那一档,这个没有。
- **拉取与投递是两条循环**(`channels/bridge.ts`):合成一条的话,长回合期间人格根本
  不再拉取,于是 ① `detach` 在它唯一该起作用的场景(主人格正跑长回合时用户发 `/救援`)
  送不到;② 信使的"不可达"误判波及**所有其他用户**,各吃一条保留额;
  ③ `health().live` 在健康回合期间翻假。
  用例里 handler 必须能"挂住",否则把回合时长这个变量整个消掉了。
- **"收下"与"处理完"是两个信号,`handler()` 同步返回前者**(`channels/types.ts`
  的 `Accepted`)。它们曾经是同一个 promise,而它 resolve 的时机是**回合跑完** ——
  拆出 `deliverLoop` 只治好了拉取那一半,投递这一半仍旧 `await handler(...)`,
  于是长回合期间消息拉得进本地队列、投不进网关。后果不是"慢一点",是**两个功能
  整个够不着**:① 网关备好的追加通道只在回合跑着时开着,而消息偏偏要等它结束才到,
  真机日志里「追加输入」一行都没有,用户看到的是"插话等于没说";② 微信「图 + 文字」
  那 120ms 的第二条同样进不来,1.5 秒的聚合窗口只等到它自己。
  纪律有两条:**网关 `dispatch`/`collect`/`enqueue` 一个都不许是 `async`**
  (顺序靠"渠道 FIFO 调用 + 收下是同步的"保证);**ack 仍等 `settled`,但不占投递链** ——
  提前 ack 的窗口从聚合那 1.5 秒变成整个回合,太大,所以异步等、期间 msgId 占着
  `queuedIds` 挡住重复拉取(走 `seen` 的补 ack 等于替没跑完的回合提前签收)。
- **中止信号挂 `res` 不挂 `req`**(`ipc/server.ts`):`IncomingMessage` 的 `close` 在请求体
  **读完**那一刻就触发(实测),而端点都要先读 body —— 挂 `req` 的话 signal 一进门
  就是 aborted,长轮询退化成忙轮询把 CPU 打满,**而且没有任何报错**。
- **同一个 `context_token` 不重置预算**(`reply-store.ts`):崩溃重放会让同一条来信被
  `remember` 第二次,清零之后就会超发,而超发是 `ret=-2` 且永不恢复。
- **投递失败必须有出口**(bridge):只 `break` 而不 ack/nack/退避的话,信使在队列非空时
  立刻返回,两者相乘是每秒上万次的热循环;而**单 inbox** 意味着所有用户的后续消息
  全堵在这一条后面。连续失败 3 次交回信使(复用"出队 + 亮红灯"),退避 400ms ——
  比拉取那个 3 秒短,因为撞上限的总时长就是全体用户的堵塞时长。
- **写盘失败不能静默吞掉**(`courier/core.ts`):磁盘满时消息没进队列、`dropped` 覆盖
  不到、用户一个字收不到,而 `accept` 正常返回 → iLink 游标照常推进 → **永远不会重放**。
  必须计数并让用户知道要重发。
- **token 到期时刻读不到就诚实说未知,绝不编**(`core/token-alert.ts`):过期时刻只有
  凭据文件(`$CLAUDE_CONFIG_DIR/.credentials.json` 的 `claudeAiOauth.expiresAt`)里有,
  `claude setup-token` 的 env 长效 token 是不透明字符串 —— 生产上多半就是这种,那时
  状态页显示「未知」、不发任何告警。编一个假倒计时比没有倒计时糟得多(人会信它)。
  告警出口两个:守护人格状态页的红黄绿(无 LLM,token 过期时它还活着),以及主人格
  prelude 里**只对管理员**的播报(换发要人在宿主跑 setup-token,普通用户拿这条什么都
  做不了)。**每个阈值(14/7/3/1 天/已过期)只播一次**,发送成功才落账(与部署结果播报
  同一条纪律),换 token(expiresAt 变了)自动重来。
- **磁盘红色水位由看门狗清一次,清完还红就报警**(`watchdog.decide` 的 disk-gc 规则):
  磁盘满是"两个容器一起崩"最常见的环境原因,规则排在容器规则**前面**——那时退版本
  没用,清理可能直接治好。动作只是起固化的 deployer 跑 `gc`(= `release_gc`,双重闸门,
  清不掉指针指着的东西;**不写 report.json**——那是部署结果的播报通道,覆写等于把一条
  可能是失败的部署结果永久顶掉)。**只清一次**:清完还红说明占空间的不是旧 release,
  反复清是空转。读不到磁盘余量就当没这条规则(看不见 ≠ 满了)。
  红线(2GB)与制备门(5GB)是**两个不同的问题**:后者是"别开始一件要几百 MB 的事",
  前者是"再不清连回滚都要做不了了"。
- **每周冷启动点火**(`deployer.sh drill` + `watchdog.shouldIgnite`):活进程握着已删
  inode 照常运行,pinned 的字节坏没坏只有**从磁盘冷启动**才测得出来 —— 那正是断电
  重启那天要走的路。四项检查按依赖顺序:字节完整(清单重验)→ 冷启动 SELFCHECK →
  主人格 /health 健康且 sha 与 current 一致 → 回滚机构(history 可解析 + dry-run flip,
  临时指针用完就拆、开头清残留可断点重跑)。结果写 **ignition.json**(与 report.json
  分开,两个消费者),守护人格按它排程(7 天)并上状态页;从没点过火也要红 ——
  例行演练没在跑本身就是异常。排程受部署锁约束(drill 占锁,与真部署互斥),
  进程内 kick 冷却防止把一次点火起成一串容器(容器名互斥会让后面的全失败)。
- **看门狗:锁在就只观测、绝不动 `stable`、每级只退一次**(`rescue/watchdog.ts`)。
  决策是纯函数(不碰 docker、不看时钟),因为它是唯一在**没有人**的情况下换掉线上
  版本的东西 —— 判错的看门狗比没有看门狗糟。锁的超时阈值**必须大于观察期上限**,
  否则一次正常的 30 分钟观察期会被判成"deployer 死了",它就在部署成功的中途拨回去。
  「干净地停着」单独成一条规则:deployer 死在 stop 与 start 之间时容器是**正常退出**的,
  只看 crash-loop 永远发现不了。**看不见 ≠ 坏了**:`docker inspect` 取不到时什么都不做。
- **`demote` 与 `rollback` 的区别是语义**:rollback 是人的判断,所以连 `stable` 一起拨;
  demote 是机械判据(容器重启了几次),远弱于观察期,所以**只拨 `current`**。
  让看门狗写 stable 等于允许一次误判永久改写「回退目标」这个概念本身。
- **`courier-fallback` 是唯一会自动改写稳定面的动作,所以比 demote 多三道闸**
  (`watchdog.decide` + `deployer.sh do_courier_fallback`)。它修的是一种别处修不了的故障:
  `pinned` 由人钦定、依据是那份 release 当过 `stable`,而**观察期只跑主人格** ——
  信使的代码路径(iLink 连接、accounts.json、收件队列)在那 30 分钟里一次都没执行过。
  于是一份"过了门"的 release 完全可能带着一个起不来的信使,而后果是微信整个聋掉,
  连报警都发不出去。三道闸:
  ① **有 pinned-prev 且不同于 pinned** —— 它由 `bless` 在**第二次**钦定时才产生,
  首次部署后切过去就是切到空气;一次兜底之后两者相等,再退是空动作却像又救了一回。
  ② **只退一次** —— 退过还崩多半不是版本问题,反复换指针只会让人更难判断现在跑的
  是哪一份,而那时他正需要这个信息。
  ③ **主人格必须是好的** —— 两个一起崩说明是环境问题(磁盘/内存/docker),换 pinned
  换完仍然崩,却把稳定面悄悄挪走了,于是正在排查的人看到的代码跟他以为的不是同一份。
  反过来「信使崩、主人格好」是很强的信号:问题就在信使那份从没被观察期跑过的代码里。
  执行侧只动 `pinned`(`current` / `stable` / `pinned-prev` 一个都不碰),换之前验内容清单,
  重启的是**信使容器**;判据只是"连续 15 秒没再重启"而不是健康门(信使没有 HTTP 端点),
  这一点如实写进部署报告。**不重启守护人格** —— 换链接不影响已经跑起来的进程,
  而重启它等于杀掉正在执行这次兜底的决策者,何况它此刻是唯一还活着的观测点。
  解闩看 `pinned-prev`:人重新 bless 之后两者不同(bless 先存旧的),我们自己那次
  兜底之后两者相等 —— 不分开的话,人换了一份好代码上去它再崩时看门狗会袖手旁观。
- **`pinned` 由 `bless.sh` 钦定,且先把旧的存进 `pinned-prev`**:钦定错误只会在
  "信使起不来"时才发现,而那时两个人格已经一起聋了。
- **钦定之前必须确认目标跑得动稳定面的每一个角色**(`bless.sh` 查
  `dist/src/index.js` 与 `dist/src/courier/main.js`,判据与 `entrypoint.sh` 一致)。
  只查"目录存在"不够,真机上栽过:bless 不带 `CATMAN_PIN` 时默认取 `stable`,而**手工
  迁移过的机器上 stable 还停在旧拓扑** —— 迁移时是人工切的 `current`,deployer 没参与,
  stable 从没被推进过。那个 release 目录完好、内容齐全,只是没有 `courier/main.js`,
  于是信使进引导模式转一辈子;**守护人格更糟**,它的入口在旧 release 里存在,
  安安静静地跑起了旧代码。所以缺文件就**拒绝并非零退出,一个指针都不动** ——
  报成功会让人以为稳定面已经换过了。加角色时 `entrypoint.sh` 与 `bless.sh` 两处都要改,
  有单测从 entrypoint 解析出角色清单跟 bless 对账。
- **IPC socket 必须在可写区**:守护人格把主 `/data` 整个只读挂载,而 unix socket 的
  `connect()` 需要对 socket 文件的**写**权限 —— 放只读区的症状是"rescue 起来了但一条
  消息都收不到",日志里只有一句 EACCES。所以 `/data/ipc` 单独 rw 挂给三个容器。

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
