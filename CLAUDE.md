# CLAUDE.md

面向在本仓库开发 catman 的 Claude Code / 开发者。运行时的助手人设不在这里,而在
`/data/workspace/CLAUDE.md`(数据卷里,由运行中的 agent 自己加载)。

## 这是什么

catman:跑在 OpenWrt / x86 软路由 Docker 里的个人 AI 助手。微信(iLink 协议)作为聊天入口,
后端用 **Claude Agent SDK** 长驻,按 Claude 订阅计费,能在容器内执行任意命令
(含用内置 docker CLI 操作宿主 Docker)。**多账号**:多人各自扫码接入,各自独立的会话与
工作目录;dashboard 带鉴权,兼做扫码接入与账号管理。
纯 TypeScript / ESM(NodeNext),运行时除 `@anthropic-ai/claude-agent-sdk` 外零依赖。

**源码直跑**:镜像 `catman-env` 只是不含业务代码的运行环境,真正跑的是数据卷里的
**release 目录**(`/data/releases/<sha>/` = 浅 clone + 自带 node_modules + dist),
由符号链接 `current` 指定。升级 = 制备新 release + 换链接 + 重启容器,**不重建容器**。

## 常用命令

```bash
npm run typecheck          # tsc --noEmit
npm test                   # node:test + tsx,含假时钟单测
npm run build              # tsc → dist/src/**

# 本地端到端手测(终端直接聊,需 Claude token)。stdin 通道支持
# "/user <名字>" 切身份、"/img <路径> [附言]" 送图 —— 多用户隔离与图片输入
# 都不必真机扫码就能验,走的是与微信完全相同的下游链路。
CATMAN_CHANNEL=stdin CATMAN_DATA_DIR=./data CATMAN_ADMIN_TOKEN=devtoken \
  CLAUDE_CODE_OAUTH_TOKEN=<token> npm run dev

# 自检(smoke)单独跑:不碰真实 /data,退出码即结论,stdout 一行 JSON
CATMAN_SELFCHECK=1 node dist/src/index.js
```

改完务必 `npm run typecheck && npm test`(strict + noUncheckedIndexedAccess 全开)。

⚠️ 源码工作区**没有** `node_modules`(依赖只装在制备容器里)。本地跑测试前先
`ln -s /data/releases/current/node_modules .`;`.gitignore` 里**带斜杠与不带斜杠的两条
都要有** —— 带斜杠只匹配目录,不匹配这条软链,漏了它会被 `git add -A` 收进仓库,
然后制备在 `cp` 阶段撞进硬链接复用的目录,只报一句 `Permission denied`,看不出跟软链有关。

## 日常维护动作

```bash
# 部署(首次三步;之后升级只走 prepare + deploy)
docker build -t catman-env:1 -f docker/Dockerfile .      # 基底镜像,极少重建
CATMAN_HOST_DATA_DIR=$PWD/data scripts/evolve/init.sh    # 首个 release + 指针
scripts/evolve/bless.sh                                  # 固化部署机制
docker compose up -d

# 制备:测试+编译,产出 release。跑的是 **bless 固化的那份**(制备门在它里面);
# 路径要写全 —— 镜像没设 WORKDIR,docker exec 从 / 起步。
docker exec catman /data/deploy/bin/prepare.sh HEAD
scripts/evolve/deployer.sh deploy <sha>                  # 排水→自检→切换→健康门→观察期
scripts/evolve/deployer.sh rollback|status
# 微信里(管理员)则是 /发布 <前6位> 与 /回滚,不必开电脑。

# 钦定稳定面(信使 + 守护人格跑的那份)。**显式写全 sha**,不带参数会默认取 stable。
/opt/services/catman/bless.sh <40位sha>
docker compose restart catman-rescue     # 先救援:它挂了你还能发消息
docker compose restart catman-courier    # 后信使:它挂了你什么都发不了
```

构建基底镜像时够不着 `download.docker.com`:代理要**大小写都传**(apt 只读小写、
curl 只认大写),或 `--build-arg DOCKER_APT_MIRROR=<国内镜像>`。

排查用的环境变量:`CATMAN_ILINK_TRACE=1`(逐条 iLink 收发)、`CATMAN_AGENT_TRACE=1`
(逐条 SDK 消息)。回合起止 / 重试 / 限流 / 心跳**无条件打**,不受开关约束。

内存事故记录落在 `/opt/services/catman/mem-incidents.log`(**SSD**,不在 U 盘上 ——
事故当下 U 盘正是被打满的那块)。宿主还有一个常驻黑匣子 `/opt/services/blackbox/`,
10 秒一采 load / 内存 / vmstat / diskstats / top-3 RSS / D 状态进程。

## 进程拓扑

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
  └─ 无 LLM 状态页 :8789
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
```

硬指令分两类,分界线是**会不会改会话状态**。只读/中断的(`/帮助` `/状态` `/取消`)
是 immediate,在 `onMessage` 就地分流、绕过聚合与队列;改状态的(`/新会话` `/继续`
`/切换会话`)走队列,在分拣节点里与消息投递保持先后。**两类都不进 LLM。**

**身份**:`userKey = <channel>:<accountId>:<userId>`(`core/identity.ts`)。
accountId 这一段不能省 —— 两份 iLink 凭据下可能出现相同的 from_user_id。
解析时只 split 前两个 `:`,所以 userId 含任意字符都能无歧义往返。

**配置三层**:`config.ts`(env 基线)→ `settings.json`(全局,管理员改)→
`prefs.json`(每用户,自己改)。读取时逐级回退,见「兜底优先于交叉校验」。

Dashboard 与清理的扫描范围 = `listWorkspaceDirs(/data/workspace)` 算出的那组 projectDir。

## 关键文件

只列**光看文件名猜不到职责**的。其余按目录约定即可(`channels/` 渠道实现、
`dashboard/` HTTP 与页面、`courier/` 信使、`cron/` 定时任务)。

| 文件 | 职责 |
|---|---|
| `src/core/identity.ts` | userKey 编解码;**单射**的工作目录名派生;内置管理员常量 |
| `src/core/users.ts` | UserRegistry;每用户 workspace;`listWorkspaceDirs` = 清理真相源 |
| `src/core/user-private.ts` | 每用户私有目录:**独立于 `/data` 的一棵树**,只把本人那一份挂进回合容器的 `/private` |
| `src/core/admission.ts` | 准入策略(TOFU 绑定 / 本地全放行),以函数注入网关 |
| `src/core/settings.ts` | `SETTING_SCHEMA`:全部配置项的单一真相源 + 全局运行时层 |
| `src/core/commands.ts` | `COMMAND_TABLE`:硬指令的单一真相源 |
| `src/core/turn-tokens.ts` | 回合级一次性令牌 + 在飞回合上下文(detached / abort / feed / done) |
| `src/core/turn-env.ts` | agent 子进程环境的**唯一**定义(用户回合与定时任务共用) |
| `src/core/skills.ts` | 启动时**按人格**生成 SKILL.md(按需加载,不占系统提示词) |
| `src/core/persona.ts` | 人格自述(进 `systemPrompt.append`)、共享人设占位、管理员名单跨命名空间继承 |
| `src/core/agent.ts` | Agent SDK 封装;preset 三件套;常开输入通道支持回合中途追加;会话容器装配 |
| `src/core/session-container.ts` | 会话容器的参数与包装脚本(纯函数,见「内存与会话容器」) |
| `src/core/mem-watchdog.ts` | 内存看门狗的**决策层**(纯函数,不碰 docker 不看时钟) |
| `src/core/mem-watchdog-runner.ts` | 看门狗的**执行层**:读 cgroup、动手、落事故记录 |
| `src/core/session.ts` | 会话状态机(纯函数 decide + 注入时钟/store;current + history) |
| `src/core/gateway.ts` | 串联各层;**分拣节点**;追加输入;每会话串行;并发信号量;greeting |
| `src/core/agent-trace.ts` | LLM 侧可观测性:SDK 消息 → 一行日志(纯函数,分 always/trace 两级) |
| `src/core/attachments.ts` | 图片附件的中立表示 + 格式嗅探 + 上限(不认识渠道也不认识 SDK) |
| `src/core/transcript.ts` | JSONL 防御式解析、检索、**workspace 范围**清理 |
| `src/core/file-store.ts` | 状态原子写(tmp + rename) |
| `src/core/version.ts` | 版本戳:读 release 根目录的 VERSION;**读不到返回 undefined,绝不编** |
| `src/core/selfcheck.ts` | SELFCHECK 模式:临时目录装配一遍 + 探一次大脑;失败分类(限流/网络/凭据/代码) |
| `src/core/deploy-report.ts` | 部署报告契约(deployer 写、catman 读)+ 防御式解析 |
| `src/core/deploy-progress.ts` | 部署里程碑契约(JSONL 追加)+ 防御式解析 |
| `src/core/releases.ts` | release 目录的**只读**视图 + `/发布` 的 sha 前缀解析 |
| `src/core/token-alert.ts` | Claude token 到期播报(读不到就说未知,绝不编) |
| `src/core/notify-bin.ts` | `catman-notify`:长任务脱钩跑在独立容器里,跑完推结果 |
| `src/core/cron/schedule.ts` | cron 解析 + 下次触发 + 频率下限。**纯函数**,自带时区换算 |
| `src/core/cron/validate.ts` | 入口校验。调用方是 LLM,所以未知字段一律拒收、字段名自带单位 |
| `src/core/cron/store.ts` | 任务表 + 执行记录 + 保留策略;**认不出的任务隔离不删**(回滚安全) |
| `src/core/cron/scheduler.ts` | tick 调度:先收尸再点火;错过只补一次;agent 任务**不等它跑完** |
| `src/core/cron/docker.ts` | 脚本任务的执行面:detached 一次性容器;**catman 重启不打断在跑的任务** |
| `src/core/cron/agent-runner.ts` | agent 任务的执行面。**必须把 turn 标成 detached** —— 否则会被当成用户的前台回合,他下一条消息要等它跑完 |
| `src/dashboard/api-cron-admin.ts` | `/api/admin/cron`:页面上那几个按钮。**只让改 enabled** —— 别的改动必须走有完整校验的那条路 |
| `src/dashboard/ui-cron.ts` | 定时任务的两个页面(纯函数产出 HTML)。**全站视图**,与 `/api/me/cron` 的每人视角刻意不同 |
| `src/core/cron/notices.ts` | 静默时段判定 + 攒着的结果合并成摘要,落盘 |
| `src/courier/reply-store.ts` | replyCtx 落盘 + 发送预算的**唯一权威** |
| `src/courier/outbox.ts` | 发件队列:发不出去的消息不丢,按 kind 定策略 |
| `src/rescue/watchdog.ts` | 机械看门狗(**管版本回退**,与内存看门狗无关) |
| `src/dashboard/health.ts` | `GET /health` 的纯函数组装 + 排水判定;**跨版本契约,字段只增不改** |
| `src/dashboard/auth.ts` | 整站 token;读认 Cookie/query,**写只认请求头**(防 CSRF) |
| `src/dashboard/qrcode.ts` | 纯 TS 二维码编码器(byte 模式 / 纠错 M / 版本 1–20),零依赖 |
| `src/dashboard/api-self.ts` | `/api/me`:回合令牌鉴权,agent 管自己的配置 |
| `scripts/evolve/` | 自进化流水线:lib / prepare / deployer / deployer-run / bless / init |
| `docker/entrypoint.sh` | 解析 release 链接再 exec node;解析不到进**引导模式**(慢速重试,不 crash-loop) |

---

# 不变量与坑

下面每一条都对应一次真机事故或一次被推翻的设计。**改到某一块之前先读那一块。**

## 人格与身份

- **还原 Claude Code 行为靠三个非默认选项**(`agent.ts`):`systemPrompt:{type:"preset",preset:"claude_code"}`
  + `settingSources:["user","project","local"]` + `bypassPermissions`。少任何一个"脾气"就变了。
- **人格身份走 `systemPrompt.append`,不走 skill 也不走 CLAUDE.md**(`persona.ts`)。
  真机踩过:管理员发 `/救援` 切过去,守护人格张口就说"我现在跟你对话的就是主人格本身"——
  它没说谎,三处身份来源当时全是人格无关的(preset 一模一样、skill 同一套、
  而**人设 CLAUDE.md 在它的命名空间下压根不存在**)。三个候选载体各自的问题:
  **skill 正文按需加载**,模型可能压根不去读;**CLAUDE.md** 住在数据卷里、用户能改能删,
  而"我是哪个人格"是装配事实,改不掉才对;**消息前缀**会污染对话记录且 resume 之后就没了。
  代价如实记:append 每回合都付钱,所以两段自述刻意短(单测钉着 <1200 字符)。
  **每条禁令都对应一个它做得到但不该做的动作** —— 泛泛一句"你是守护人格"挡不住一个
  手上有 bypassPermissions 的 agent。
- **skill 也要按人格分**(`skills.ts` 的 `skillsFor` / `writeSkills`):守护人格拿
  `catman-rescue`,**拿不到** `catman-evolve`。它跑钉住的稳定版本,改了代码也上不了线,
  而 skill 的 description 常驻上下文 —— 摆一份「怎么改自己的代码」在那儿,就是在邀请它
  去做一件注定白费的事,而人正在等它诊断。
- **主人格是黑名单,守护人格是白名单**(`skillsFor`)。主人格扫 `$CLAUDE_CONFIG_DIR/skills/`,
  装了什么给什么,只减掉「不属于这个人格的 + 非管理员该挡的 + `disabledSkills`」——
  能往那儿写文件的只有管理员和 catman 自己,装进去本身就是认可,再要一份代码里的登记表
  只会让漏登记的 skill **安静地不存在**(实测哑了十几天)。守护人格不跟着改:它的价值
  就是没有惊喜,不该继承磁盘现状,`disabledSkills` 对它也无效 —— 手滑禁一个,救援手册
  就在最需要时消失,而解禁要走主人格那边的接口。**磁盘读不到时退回硬编码名单**,
  一次 readdir 失败不该让它连改配置都不会。
- **`writeSkills` 要清理旧生成物**,只认 `GENERATED_SKILLS` 里的名字(手写的一个都不碰)。
  以前只写不删,守护人格那边就留着一份换分支前的旧 `catman-evolve`:白名单时代它只是哑着,
  黑名单下会自己复活并开始教错东西。
- **管理员名单要跨命名空间继承**(`persona.ts` 的 `adminBaseline`):`isAdmin` 读的是
  **本进程数据目录**下的 settings.json,而守护人格的是一个全新的空文件 —— 真机症状是管理员
  一发 `/救援` 就被降级成普通用户,**而诊断与恢复恰好全是管理员的活**。所以它从主
  settings.json 继承一份当 **env 基线**,显式 `CATMAN_ADMIN_USER_KEYS` 又赢过继承
  (后者是排查时唯一的旋钮)。读不懂就当空、绝不抛:守护人格起不来比它少一个管理员糟得多。
- **`Options.skills` 是上下文过滤不是沙箱**:未列出的 skill 文件仍能被 Read/Bash 读到
  (SDK 类型注释原文)。所以 **SKILL.md 里绝不能出现任何令牌**,只写环境变量引用。
- **两个 CLAUDE.md**:本文件是开发指南;运行时 agent 加载的是 `/data/workspace/CLAUDE.md`。
  多用户下它是**共享**人设,每人目录下还有一个自己的(首行 `@../CLAUDE.md` 显式 import ——
  不依赖「向上递归查找父目录」的隐式行为)。project settings(`.claude/settings.json`)
  **没有**继承机制,要全局共享得放 user settings。

## 每用户私有目录

放某个人的凭据、令牌这类**别人不该看见**的东西。实现在 `core/user-private.ts`,
容器里固定是 `/private`,环境变量 `CATMAN_USER_PRIVATE_DIR`。

- **它是 `/data` 的兄弟,不是子目录。** 会话容器把整个 `/data` 读写挂进去,
  放里面就得再挂一个空目录去遮住别人那几份 —— 那条路走得通(挂载按目标路径深度排,
  救援人格的只读挂载就是这么写的),但**坏的方向不对**:遮罩漏了是所有人的凭据
  一次性全部暴露,而且悄无声息。放外面则相反:漏挂只会让私有目录访问不到,
  功能立刻不工作,一眼看得见。**安全机制要往「坏了就用不了」的方向坏。**
- **挂载与环境变量必须同源。** 三个装配处(网关、cron agent、cron script)都是
  先算一次 `priv`,再同时喂给挂载和 env。变量在而挂载不在是最坏的一种:脚本会往
  一个不存在的路径写凭据,或者更糟 —— 往共享区写却以为自己在私有区。
- **没配置就整个降级,绝不退回共享区。** `hostUserDataDir` 缺席时
  `userPrivatePaths` 返回 undefined,三处都当没有这个机制。退回共享区等于把凭据
  写到所有人都看得见的地方,而调用方以为它是私有的。
- **救援人格一律不参与**,两道:`userPrivatePaths` 对它返回 undefined,
  `sessionMounts` 即使收到也不挂。它的文件系统视图是"别人的状态一律只读",
  给它挂上别人的私有目录与那条约定直接冲突。
- **隔离靠挂载不可见,不靠文件权限。** 所有回合容器都是同一个 uid(10001),
  0700 只是万一挂载漏了时的第二层。`script` 类 cron 容器是 `--user 10001:10001`
  (见 `cron/docker.ts` 的 `RUN_AS`),所以读得动 —— 换成镜像自带用户的话这条会
  **静默失效**(读不了,而任务照跑)。
- ⚠️ **这仍然是护栏不是安全边界。** 两个人格都挂着 docker.sock,起个 root 容器挂
  宿主路径就什么都读得到。它挡的是"随手一读"和"写错路径串了用户"。
- 宿主上那个根目录(`/mnt/usb/catman_userdata`)**要预先建好且属主 10001**。
  不建的话 dockerd 会自动建一个 root 属主的空目录,catman 建子目录 EACCES,
  机制安静降级(日志一行 warn)。
- **为什么 catman 主进程也要挂 `/userdata`**(每次看到都会想省掉的那条):
  挂载本身确实不用 —— `-v` 是宿主 dockerd 解析的。卡点是**每个用户的子目录
  得先存在且属 10001**:dockerd 自动建的挂载源是 `root:root 0755`,
  **父目录属 10001 也不继承**(2026-09-03 实测),而会话容器是 `--user 10001`,
  于是写不进去。替代方案是每回合起个 root 容器 mkdir+chown,成本高得多,
  而且 catman 从此看不见这棵树,清理/迁移/备份都无从下手。

## 内存与会话容器

背景:2026-08-21 路由器被搞挂三次。会话吃光内存 → 宿主没 swap → 内核把包括可执行页在内的
page cache 全逐出 → U 盘上的二进制反复重新缺页 → **回收活锁**,而 OOM killer 因为
"回收有进展"永远不开火。表现是 ping 得通、ssh 连不上、WiFi SSID 搜得到连不上,只能断电。

- **每个回合的大脑跑在一次性容器里**(`session-container.ts`):700m / 1.5 核 / 256 pid,
  `--memory-swap` 与 `--memory` 相等,`AutoRemove`,一回合一个(约 1 秒开销)。
  接法是 SDK 的 `pathToClaudeCodeExecutable` 指向一个生成的包装脚本。
- **包装脚本有三条不能破的性质**(`buildWrapperScript`):
  ① **绝不用 `set --`** —— 它会吃掉 SDK 传进来的位置参数(`--input-format stream-json` 那些),
     症状是回合起来了但一句话都不说。单测钉着 `set --` 不许出现。
  ② `"$@"` **必须在最后**,镜像与命令排在所有 flag 之后。
  ③ 环境变量**运行时全量枚举转发**,不是白名单。白名单版本丢了 12 个变量(含 `PATH`、
     两个 catman 令牌、以及全部代理变量)—— 少了代理,容器里打 api.anthropic.com 直接 403,
     那是**全面停摆**。唯一的例外是 `CATMAN_IPC_SECRET`,一条都不下放。
  ④ `docker run` 退 **125**(守护进程起不来容器)时退回本机执行。主人格可以没有这条,
     救援人格不能没有 —— 它是最后一道防线。
- **环境变量按名字传(`-e NAME`)不按值传(`-e NAME=value`)**:后者会让令牌出现在
  `docker inspect` 和宿主的 `ps` 里。
- **`--user` / `--group-add` 必须从当前进程推导**(`process.getuid()/getgid()/getgroups()`)。
  漏了的话容器以 root 跑,产出 root 属主的文件,而且容器内的 `docker` 全部
  permission denied(socket 是 `root:32768` 且 660)。
- **看门狗盯 `anon`,不盯 `memory.current`**(`mem-watchdog.ts`):后者含 page cache,
  实测 54% 是可回收的,照它开火会天天误杀。
- **三级阶梯,阈值 80 / 90 / 95**(演练三档全部真机命中):
  80% 往回合里塞一条警告**并给用户也发一条**(只喂给大脑的话,用户只看到助手忽然
  改了做法,不知道发生了什么);90% 杀掉最大的**非大脑**进程,回合存活;
  95% 中止整个回合。90% 那一级是**先喂消息再动手**,让大脑在同一次 LLM 交互里
  既看到通知、又观察到工具失败。
- **90% 的击杀必须排除 `claude|node`**:占用最大的通常就是大脑自己(常态 RSS 约 293MB),
  杀了它等于杀掉整个回合 —— 而这一级存在的全部意义正是**保住回合**。
  代价是"大脑自己在吃内存"那种场景只能靠 95%,那正是 95% 存在的理由。
- **动手一律走 `docker kill`,`cgroup.kill` 是死路**:那个文件是 `--w------- root root`,
  而 catman 跑在 uid 10001 上,**永远写不进去**。当初那次"端到端验证通过"是在一个没加
  `--user` 的容器里以 root 跑的 —— **验证条件与生产条件不一致 = 没验**。
  顾虑("事故时 dockerd 可能是废的")也已不成立:700m 上限消除的正是整机活锁,
  会话撞的是自己的上限,那一刻宿主还剩好几个 G。
- **系统提示词里要预教 exit 137**(`persona.ts` 的 `memoryBriefing`):不说的话大脑
  会把被杀的命令当成写错了原样重试,于是再死一次。这段**只在真的容器化时才追加** ——
  没开会话容器却说"你有 700m 上限"是假话,而大脑没法验证它,只会白白畏手畏脚。
- **事故记录落 SSD**(`/opt/services/catman/mem-incidents.log`),不落 U 盘 —— 事故当下
  U 盘正是被打满的那块(实测 ioticks 逼近 100%)。容器日志会轮转,而内存事故恰恰是
  "几周后才有人回头查"的那类东西。写失败吞掉,不把中止流程带偏。
- **`CATMAN_API_BASE` 必须按容器名寻址**,不能是 `127.0.0.1`:会话容器里的 127.0.0.1
  是**它自己**。这条坏掉时 `catman-notify` 与 `catman-settings` / `catman-admin` /
  `catman-cron` 三个 skill 全部静默失效。
- **`catman-notify` 用 `docker run -d`,不用 `setsid nohup`**(`notify-bin.ts`):
  `setsid` 脱得开会话、**脱不开容器**,而会话容器每回合即焚。故障模式特别坏:
  它照常说"跑完推给你",然后静默失效。
- ⚠️ **容器化会静默改掉三个隐含前提**:我在哪、我能活多久、localhost 是谁。
  三个都各自产生过一次**静默**失败。加任何跨进程/跨容器的东西之前,把这三条各问一遍。
- **内存看门狗与 `rescue/watchdog.ts` 是两个东西**:后者管**版本回退**(容器崩了退版本),
  前者管**单个回合的内存**。别混用,职责会错乱。

## 会话与回合

- **会话规则**(`session.ts`):距上次 <1h(可每用户覆盖)→ resume,否则开新会话;
  `reminded` 标记防重复提醒,`record()` 与 `touch()` 都重置它。
  **指令词汇不住在这里**,`decide()` 连布尔标记都不收 —— 规则只有一条「未超时就续上」,
  `/继续` 由分拣节点用 `touch()` 消化(把时钟拨到现在,同一批里后面的话自然命中)。
- **离开的会话归档进 history,不删除**:每用户 `current + history`(上限 `HISTORY_LIMIT`,
  同 id 去重),`/新会话` 与被切走都走 `archiveCurrent()`,`/切换会话` 用 `switchTo()`
  按 id 前缀切回并刷新时钟。SDK 的 resume 默认不 fork,**同一段对话的 id 稳定不变** ——
  history 不会被同一段对话的多轮刷爆,这是整个设计成立的前提。
  切回的入口教育有三处(超时提醒、`/新会话` 确认语、`/切换会话` 确认语),
  都从 `canonicalOf("switchSession")` 取写法。
- **切换前用 `sessionExists` 确认目标记录还在**:清理周期之间、或 JSONL 被外部删除时,
  history 仍可能挂着死引用 —— 切过去让 resume 炸出原始报错,不如提前给句人话并当场剔除。
- **懒注入(要让助手知道某件"环境事实"时,用这个套路)**:不在事情发生时推,
  而是**等它下一回合开始时顺路带上**,条件是"这个用户还没被告知过当前的值"。
  首个用例是版本感知(`releaseNoteFor` + `UserState.seenReleaseSha` + `AgentRunOptions.ambient`)。

  为什么不用那两个看起来更直接的放法:

  - **写进系统提示词**:那是缓存前缀,改一次等于让所有会话各吃一次 cache miss。
    (容器重启本身**不**破坏缓存 —— 前缀内容没变哈希就没变;打掉缓存的是改前缀这个动作。)
  - **事情发生时主动推一条**:立刻要回答"这个会话还活着吗""要不要为一句通告开个新会话"。
    后者尤其糟:助手醒在一个没有任何用户意图的会话里,第一反应是"我为什么在这儿"。

  懒注入把这两个问题一起消掉:**静默的会话压根不触发,所以根本不需要判断它是否静默** ——
  省掉的不是几行代码,是一整类边界条件。代价是"事情发生"到"助手知道"之间有延迟,
  所以它只适合**环境事实**(版本、配额、某个开关的状态),不适合需要及时反应的事件。

  三条落地纪律:

  1. **挂成同一条用户消息里的独立 text block**(`buildUserMessage` 的 `ambient`),
     不要拼进用户那句话 —— 那句可能是 `/发布 abc1234`,拼进去污染命令解析;
     更不要单独 `InputChannel.push` 一条,它收的是 `SDKUserMessage`,身份就是用户,
     读起来是"用户说了句他没说的话"。放在**最后**,别挤掉"图在文字前"那条规矩。
  2. **标记落 `UserState` 而不是 `SessionRef`**:`current` 要等回合跑完 `record()`
     才有,回合**开始**时新会话根本没有 SessionRef 可查。"新会话也该被告知"那一半
     由调用方用 `isNew` 判。
  3. **标记必须落盘,且用可选字段**:部署会重启进程,只放内存等于每次升级后人人多挨一条;
     可选字段才满足"新代码读得懂旧盘、旧代码也读得懂新盘"(见「自进化与部署」)。
     在回合**开始**时标记、不等成功 —— 回合失败最多白说一次,而漏标记会导致每轮都注入。
  歧义只在活着的条目之间算,死条目直接让位。
- **切走会话 ≠ 停掉它的回合**(`TurnContext.detached`):`/新会话` `/切换会话`
  `/api/me/session/reset` 都只是把当前回合标成 detached,它继续跑完。三处行为随之改变:
  中途进度不再推、正文带【后台对话 xxx 的结果】前缀、产出走 `sessions.archiveTurn()`。
  **出处对报错同样要标**(`labelIfDetached` 在 catch 分支也走一遍)—— 一句没头没尾的
  「处理出错了」会让用户以为是他刚发的那句话出了问题。
  **后台回合绝不能 `record()`** —— 那会把用户刚切过去的会话顶掉,而他正在跟它说话。
  `archiveTurn` 必须能"插入"而不只是"更新":新会话的第一轮被切走时,sessionId 要等
  回合跑完才存在。
  代价说清楚:**前台与后台回合共享同一个 cwd**(每用户一个),等于用户自己开了两个终端。
  每会话一个 cwd 更糟(切换会话就换了目录,文件不通)。`/取消` 只中断前台。
- **同一会话绝不并发 resume**(`gateway.deliverInput`)。串行的粒度是**每会话**,不是每用户。
  保证它的是两条:分拣节点串行且是唯一起回合的地方;前台回合还在时,新输入要么追加进去,
  要么**等 `turn.done` 再来一次**。追加失败就地另起一轮是错的,两个回合 resume 同一个
  sessionId 会把上下文撕坏 —— 有单测盯着 `peakInFlight`。
- **清理严格限定在本程序自己建的 workspace 目录**(`transcript.ts` 全部函数都要 `projectDir`
  参数)。**绝不遍历整个 projects/ 树** —— 否则 CLAUDE_CONFIG_DIR 指向共享 ~/.claude 时会
  误删无关的 Claude Code 历史(有专门单测守护;曾真实踩过)。那组 projectDir 必须由
  `listWorkspaceDirs(workspaceDir)` 算出,**不要改成 readdir(projects/)**。
- **清理的真相源是 workspace 目录,不是 users.json / state.json**:后两者会因 history
  被挤出/删账号丢条目,而 JSONL 还在磁盘上,只按它们清理会造成永久堆积。
  反过来,清理删掉 JSONL 后要 `sessions.dropSessionIds()` 出清死引用,
  否则 `/切换会话` 会把用户领到一段 resume 必然失败的会话上。
- **`userDirName()` 必须保持单射**(可读前缀 + userKey 全文哈希后缀)。只用归一化后的
  可读部分会让 `x/y` 与 `x-y` 撞到同一个目录 —— 两个用户共用 cwd,隔离直接失效。
- **工作目录全路径必须远短于 200 字符**:超过后 SDK 会改用「截断 + djb2 哈希」编码 project
  目录,与 `encodeProjectDir()` 的朴素替换分叉,会话就此读不到也删不掉。`ensureWorkspace()` 会拦。

## 消息投递与聚合

- **分拣节点是串行的,但它不等回合**(`gateway.handleBatch`)。整条流水线的立足点:
  一批消息按**到达顺序**线性处理,起了回合就往下走。由此得到三件事 ——
  ① 卡死的 agent 堵不住分拣,所以改会话状态的指令可以安全地在这里线性执行;
  ② 指令**之前**的话投递给切换前的会话、**之后**的话投递给切换后的会话,顺序天然正确;
  ③ 指令失败时只中止**剩下的**段(那些话是冲着它本该切到的会话说的),已投递的不受影响 ——
     宁可让用户确认 id 后重发,但**必须明说「这批消息先不处理」**,否则在他那边就是凭空消失。
  **分拣链与"这批处理完了"是两条 promise**(`enqueue`):链上只等分拣本身,
  返回给渠道的那条额外等这批起的回合。两者混成一条,回合就又把队列堵上了。
- **immediate 硬指令绕过聚合与队列**(`gateway.dispatch`):`/取消` 这种救命的等不了
  聚合窗口那 1.5 秒。代价是与分拣节点、与在飞回合都并发,所以**只做幂等的只读/中断**操作。
  反过来 `/取消` 要**连带丢掉还在窗口里那批** —— 用户看不见队列,他要取消的是刚发出去的
  那几条,不管它们变没变成回合。
- **回合跑到一半进来的消息优先「追加」,不必等这一轮跑完**(`gateway.deliverInput` +
  `agent.ts` 的 `InputChannel`):它会被折进**正在跑的那个 turn**,模型下一次请求就看到。
  ⚠️ 这条只在**消息真能在回合跑着时到达网关**的前提下成立,而这个前提整整坏过一个版本。
  改渠道那一层时先看 `channels/types.ts` 的 `Accepted`:任何"投递完再投下一条"的写法
  都会把这套机制悄悄废掉,**而它坏掉的样子与从来没实现过一模一样**。
  三条**实测**结论撑着这个设计(SDK 0.3.220):
  ① 中途 push 的消息折进当前 turn,全程只出**一个** `result`;
  ② `result` 已出、输入流还开着时 push 则另起一个 turn,**session_id 不变**;
  ③ push 之后**立刻** `close()`,那条消息照样跑 —— close 只表示"不会再有输入"。
  所以**不存在丢消息的竞态**:`run()` 收到 result 就关追加窗口 + close 流,
  然后**继续消费**剩余 result 把正文按序接起来。收到第一个 result 就 break 会把挤在
  边缘那条静默吞掉,那是最糟的失败模式。
  `MAX_FEEDS_PER_TURN` = 100 是**兜底不是配额**:用户还在补话说明他还没说完,
  拒绝追加等于在他说话中间切断他,而拖长的只是他自己这一轮。
  配套三条:图片上限**跨追加累计**;进度节流每次追加后**重置**(追加带来新的
  `context_token`);被折进 turn 的消息**不在 SDK 消息流里露面**,所以 `progress.fed`
  只能网关自己记账 —— `/状态` 那句「期间补充 N 条」是用户确认"我刚补的赶上了没"的唯一出口。
- **微信发「图 + 文字」不是一条消息,靠聚合窗口合并**(真机实测):两条消息相隔约 **120ms**。
  协议**给不出**"后面还有图"的信号 —— `session_id`/`run_id` 为空、`is_completed` 与
  `message_state` 都已是完成态,四个候选键全废。所以只能按时间攒:`gateway.collect()`
  用 debounce,窗口是 `messageAggregationMs`(默认 1500ms,设 0 关闭)。
  **用户一直在发就一直攒** —— 人还在打字说明话没说完。`AGGREGATION_MAX_MULTIPLIER`(×40,
  约 60 秒)因此定得很松:它**不是**公平性限制,唯一理由是 batch 攒在内存里、总得有不再
  增长的时刻。合并后要**重新收一次图片上限** —— 渠道只保证单条消息不超。
- **`stop()` 要把攒着的消息 flush 进队列**:消息已经从渠道收下、长轮询游标也推进了,
  留在窗口里就是真丢。
- **`Channel.name` 必须等于该渠道产出的 userKey 的第一段**(真机踩过):`CompositeChannel`
  拿 userKey 的 channel 段当路由键去找渠道发回复。两处写岔的话准入、入队、agent 全都正常,
  **只有最后 send 那一步抛「没有能处理 X 的渠道」** —— 额度已经花掉,用户那边彻底没反应。
  现在两处引用同一个常量,并有单测守护「该渠道产出的 userKey 必须能路由回该渠道」这个闭环。
- **渠道消息的接线是 `gateway.onIncoming` 一个方法,不写在 `start()` 的闭包里**:
  单测为了不起真实渠道曾经自己抄了一份等价接线 —— 于是 `start()` 每加一件事,
  那份抄件就悄悄少一件,**测的是一条生产里不存在的路径**。
- **准入(`admission.ts`)在网关最前面**:未获准的来信不建工作目录、不写会话状态、
  不花订阅额度。新增渠道时在 `index.ts` 的 `createChannel` 里连同准入策略一起返回。
- **greeting 的判定权在信使,人格只消费**(`IncomingMessage.greeted`):信使是唯一见过某个
  userKey **全部**历史的进程,而人格有好几个、各有各的 `users.json`。不接这个标记的话,
  用户每切一次人格就吃一整份欢迎语。**只能用来抑制,不能用来触发**:缺席表示这个渠道
  没有这项知识(stdin / dashboard),那时退回人格自己的记录判断。消费点必须在
  `ensureWorkspace()` **之后** —— `markGreeted` 对还没注册的用户是空操作。

## 图片与附件

- **图片走内联,不走"落盘 + 告诉模型路径"**(`agent.ts` 的 `buildUserMessage`):SDK 的
  `query()` 除 string 外还收 `AsyncIterable<SDKUserMessage>`,其 `message` 就是
  `MessageParam`,可以直接放 image content block(实测 3MB base64 单行完整通过)。
  给路径让模型自己 Read 要多一次工具往返,而且**模型可能压根不去读** —— 用户贴图就是
  要它现在看。**所有回合(含纯文本)一律走流式输入** —— 追加只有流式输入下才收得进。
- **附件的格式靠嗅探 magic number,不信渠道给的 MIME**(`attachments.ts`):iLink 的图片是
  从 CDN 解密出来的裸字节,协议里没有可靠的格式声明;而 `media_type` 与实际内容不符时
  模型侧会直接报错。能接的四种(jpeg/png/gif/webp)取自 `@anthropic-ai/sdk` 的
  `Base64ImageSource.media_type`。超限图片**直接拒收不缩图** —— 运行时零依赖,没有图像库。
- **图片的两条闸门是配置项不是常量**(`maxImageBytes` / `maxImagesPerTurn`,scope=global):
  它们直接决定内存峰值(base64 驻留整个回合)与 token 开销,软路由和 x86 主机的余量差得远。
  渠道拿的是 **`() => limits` 函数而非值**,所以管理员改完下一张图就按新值走。
  同一条消息内用同一份快照。
- **iLink 的图片不在消息正文里**:`item_list` 的 `type=2` 只带一份「去哪取 + 怎么解」的凭据,
  字节要去 CDN 拉且是 **AES-128-ECB 加密**的。两处 key 编码不同 —— `image_item.aeskey`
  是 hex、`media.aes_key` 是 base64,弄混解出来是乱码;`aes_key` 本身还有 base64(16 字节原文)
  与 base64(32 位 hex) 两种野外编码,都得认。有单测守护。
- **收到图片的那条消息要顺序 `await` 再处理下一条**(`ilink-connection.ts` 的 pollLoop):
  dispatch 现在可能要下载几 MB。代价是下载期间暂停拉取 —— 长轮询有 `get_updates_buf`
  游标兜底不会丢消息;而并发 dispatch 会让「先发图、后发问题」颠倒着进队列。
- **带附件的消息不按硬指令解析**(`gateway.dispatch`):「/状态 + 一张图」显然不是那个意思。
- **单张图失败不能连累整条消息**:那张图跳过并单独告知用户,文字与其余图片照常投递。

## 发送预算与信使

- **iLink 协议约束**:回复必须带入站消息的 `context_token`(否则 HTTP 200 静默失败)。
  所以"主动推送"能不能成,取决于**手上还有没有一份没花完的上下文** —— 信使把它落了盘
  (`courier/reply-store.ts`),于是超时提醒、部署进展这类没人开口时要说的话是发得出去的
  (真机日志里有一条 `ctx龄=3532555ms` 的成功发送)。发不出去仍是常态,所以主动推送一律
  **静默降级 + 保留待播标记**,绝不是"发不出就算了"。
- **一个 `context_token` 的发送次数有预算,实测上限是 10**:第 11 条起 `sendmessage` 返回
  `ret=-2 prepare failed` 且**永不恢复**,之后连正文都发不出去,用户只收到"收到,正在
  处理中…"然后彻底静默。**是条数不是时效**(另一次记录里同一个 token 用到 4 分钟 7 条
  仍正常),也不是限流(限流会放行,而它首败后 45 秒仍全败)。
  ⚠️ **这个 10 复测过,别再往上调。** 2026-08-12 放宽到 20 试过一次,当天撞回来:
  两次记录都停在**恰好 10 条成功**。代价是真的 —— 那次失败的一条是 1175 字的汇报,
  用户没收到。
  预算在 `reply-store.ts` 顶部显式列支:`SEND_BUDGET(10) − 回执 1 − RESERVED_SENDS(2)`
  = `MAX_PROGRESS_PER_TOKEN`,**预留的两条是正文与额度提示**。
  **保留就是靠进度的上限实现的**(进度撞上限就再也发不出去,剩下的谁也抢不走),
  所以改进度上限等于改保留额,改之前先把这笔账重算一遍。排空余地 `LIVE_TURN_SENDS`
  也从这笔账推出来 —— 预算一动,余地必须跟着动。
- **发不出去的消息进发件队列,不再丢**(`courier/outbox.ts`)。四条性质:
  ① **住在信使**,不能住 bridge —— 人格每周被进化重启、每次部署重启,队列放那边等于
     一次部署清空积压,而积压里正是那条没送出去的答案;预算的权威也在信使。
  ② **不是 FIFO,是按 kind 定策略**(`POLICY`):正文/播报/兜底 `append` 一条不丢;
     进度/空闲提醒 `replace` 只留最新(它们是**状态**不是流水,补发十分钟前那句
     「🔧 Bash: npm test」毫无意义还白烧一格);回执 `drop` 压根不排队。
  ③ **排空要限速(1.5s)也要留余地**(停在还剩 `DRAIN_FLOOR` 条)。榨干新额度等于让
     用户每问一句都先替上一轮买单。停下时说一句「还有 N 条」,**每份 token 只说一次**。
  ④ **催促不能丢**:排空跑着时又被 `kick`,要记下来跑完再来一遍(`rekick`)。少了它,
     用户发 `/nop` 时若恰好有一轮排空正在收尾,那次催促连同新额度一起被吞掉。
- **额度花光了不是绝路,`/nop` 就是那条出路**:用户随便发一句话都带来新的 `context_token`。
  所以进度报到头时会**单独发一条**交代把这个口令告诉他,**那条交代自己占一格保留额**
  (附在最后一条进度尾巴上就与进度共用同一份额度,而"进度用完了"正是它唯一该出现的时刻)。
  它复用 `reminder` 这个 kind 而不新开一种:信使跑 pinned、版本天然更老,`parseSendKind`
  认不出的 kind 会让**整个信封**读不懂,那句提示就恰好在最需要它的时候消失。
  **两句额度提示都归信使说**(「进度就报到这儿」「还有 N 条没发出去」),共用一份
  "这个 token 已经提示过"的记录;进度那句的触发条件是**一条进度被拒**而不是"余量剩 1"。
  网关收到 `/nop` 时必须把节流器重新开闸(`TurnContext.resetProgress`),少了它表现就是
  "照做了却没反应"。所以 `/nop` 归**人格**执行,不归信使。**开闸之外它一个字都不回。**
- **发送预算整个不在核心里。** 核心只管把消息交给渠道,发得出去渠道就发,发不出去渠道排队。
  这条边界是踩了两次坑才挪过去的,**别往回走**:网关自己记一份账 → 与信使成了两本账
  (7 对 6),每个长回合都多发一条注定被拒的进度;改成每次现问渠道 → 单一权威有了,
  但核心仍要懂"还剩几条",而 stdin / dashboard 上这个问题压根没有答案。
- **进度事件有三类:💭 思考、💬 中途说的话、🔧 工具调用**(`ProgressFan`)。
  💬 那类**必须延后一拍**:最终答复本身也是一个 `text` 块,当场透出去用户就会收到两遍
  同一句话。而"这个 text 是不是答复"只有看它后面还有没有动静才知道。这个"攒一拍"是
  `ProgressFan` 存在的全部理由。
- **`ProgressThrottle` 只剩间隔阶梯**(5→15→30→60 秒),它管的是**观感**不是额度。
  同间隔内只发**最新**那条,丢掉的条数记在 `(+N 步)` 里。纯事件驱动、**不用定时器** ——
  引入定时器就会有"回合结束后才触发、进度插到正文后面"的乱序。
- **`onProgress` 回调无条件挂上,`progressEnabled` 只决定推不推给用户**:它同时在维护
  `turn.ctx.progress` 快照,而 `/状态` 与心跳都读那份快照。绑在一起的话,一个纯粹的
  省流开关会顺手把可观测性也关掉。
- **`/状态` 第一行是在飞回合的状态**:排队 / 处理中 / 正在中断 / 空闲四种分开说 ——
  处置完全不同。它是用户侧唯一不受回合阻塞影响的观测点(走 immediate 分流)。
  `progress.running` 与 `startedAt` 必须分开:两者之差就是排队时长。
- **`result.is_error` 有两个消费者,缺一个就是一种静默**:日志(`agent.logResult`)与
  用户侧的 `TURN_ERROR_PREFIX`。SDK 以 result 报错时 `text` 装的是错误原文,却走**与成功
  回复完全相同**的发送路径 —— 不标记的话「Credit balance is too low」在用户那边和助手
  说的话长得一模一样。原文照发不翻译。配套的 `joinReplyTexts` 空正文兜底**分失败与成功
  两种话术**:沿用"助手没有返回内容"会把一次失败伪装成一次无话可说。

## 配置

- **兜底优先于交叉校验**(`settings.ts` 的核心原则):目标是**任何配置状态下 agent 都能
  起来** —— 有 LLM 才有自我修复的可能。所以配置项之间**一律不做交叉一致性校验**,
  改用读取时逐级回退。每项有一对读写不对称的函数:`validate()` 写入时严格抛错(给 agent
  反馈)、`parse()` 读取时坏值返回 undefined 让调用方退到下一级。**`effective()` 永不抛**,
  末端落到 `floor`,而 `model` 的 floor 是 `undefined`(不传 model,交给 SDK)。
  改白名单时**不要**去检查有没有人在用某个模型,那正是这条原则要消灭的东西。
- **回落但不改盘**(`prefs.ts`):失效的用户覆盖只在读取时回退,不重写 `prefs.json` ——
  白名单加回来时用户当初的选择要能自动恢复。静默改盘会把意图永久抹掉。
- **加配置项只改 `SETTING_SCHEMA`**,加硬指令只改 `COMMAND_TABLE`。校验、`/api/*` 的
  schema 字段、两个 skill 的正文、帮助文案会自动跟上。
- **数据向前兼容,不做迁移**:**日常升级与回滚都不动 `/data`**,回滚只换 `releases/current`
  的指向。所以改动必须**能读盘上现有格式**,而且因为观察期内随时可能回滚,
  **旧版本要能读新版本写的**。兜底靠既有的防御式解析(`parseUserKey()` 非法返回 null、
  `SessionManager` 加载时丢弃、prefs 回落不改盘、`settings.effective()` 永不抛)——
  那是解析器本就该有的防御,不是迁移分支。跨越不兼容格式才是清空 `./data` 重新扫码。

## dashboard 与 HTTP

- **写操作只认 `X-Catman-Token` 请求头,不认 Cookie**:Cookie 会被浏览器自动携带,
  只认 Cookie 的写接口能被外部页面诱导触发(CSRF)。读则两者皆可。
- **`/api/me` 必须在 admin 读闸门之前分发**(`server.ts` 的 `handle`):它的第一件事是
  `allowsRead()`,回合令牌过不了那道闸 —— 放到后面会静默 401,极难查。
  同理 `/api/me/cron` 必须排在 `isSelfApiPath` **之前**(那个判定认领整个 `/api/me/` 前缀)。
- **`Dashboard.stop()` 必须先 `res.end()` 掉所有 SSE 再 `server.close()`**:长连接会让
  `close()` 的回调永不触发,进程卡在优雅关闭里出不去(已实测复现)。
- **聊天记录必须落盘**(`chatLogPath`):微信客户端自己存着聊天记录,网页没有。只放内存里
  的话,重启后页面一片空白、而助手那边的会话还在 —— **页面说"没聊过"、助手说"我记得"**。
  记录与上下文是两件事:`/新会话` 只清上下文。
- **`DashboardChannel` 必须实现 `recall`**:网关在每个回合的 finally 撤回"收到"回执。
  撤回帧走 SSE 的 `event: delete`,且**不带 `id:`** —— 浏览器会把 `id:` 记成 Last-Event-ID,
  重连起点被拉回到刚删掉那条。
- **SSE 首连的补发起点由页面用 `?after=` 给**:首次连接没有 Last-Event-ID,不给的话
  服务端会把首屏刚渲染完的历史整份再推一遍。请求头优先(它是浏览器维护的)。
- **网页上的「开新会话」按钮发的就是硬指令文本本身**(`canonicalOf("newSession")`),
  不复制一份后端逻辑 —— 语义永远与在微信里打字一致,指令改名也自动跟上。
- **聊天输入框不能无条件抢 Enter**(`ui.ts` 的 `shouldSendOnEnter`):输入法合成期间
  Enter 是"上屏"不是"发送"。浏览器事件顺序不一致 —— Chrome/Firefox 的 keydown 在
  compositionend 之前且带 `isComposing`,Safari 反过来且**没有任何标志位**,只能靠紧挨
  compositionend 的时间窗认出来。该函数被 `toString()` 内联进页面,所以**函数体必须自足**,
  引用模块作用域的东西在浏览器里就是 ReferenceError(单测在空沙箱里求值守这条)。
- **提权是 `PATCH /api/users/<key> {admin}`,名单由服务端照当前值增删**,**不要**改成让
  调用方提交整份 `adminUserKeys`:那要求先读再写,两处同时操作时后写的会把先写的抹掉。
- **内置 dashboard 管理员不可撤销**:它不在 `adminUserKeys` 里,清空名单也影响不到 ——
  刻意留的恢复通道。`PATCH {admin:true}` 对它必须**提前短路**。

## 账号与 iLink 协议

- **账号绑定是 TOFU 且不可被来信改写**:`bind()` 在已绑定时返回 false,换人必须显式 `unbind()`。
- **重新扫码 = 换凭据,不是换账号**(`accounts.replaceCredentials`):accountId 必须原样保留,
  因为它是 userKey 的第二段 —— 换了就等于换了个人,会话、工作目录、prefs 全部接不上,
  而这恰恰是这个功能存在的理由。同理 `poll()` 在目标账号已被删时返回 `failed` 而**不退化成
  新建账号**:静默造出一个空白用户比报错糟得多。两处配套机制:
  ① **连接必须按凭据比对重建**(`wechat-ilink.reconcile` 的 `usesCredentialsOf`)——
     accountId 没变,只看"这个账号有没有连接"会把作废的 token 一直用下去,表现是扫了码
     依然收不到消息且日志无异常。凭据失效(errcode=-14)的连接则**故意不重启**,
     重连只会再吃一次 -14;它等的就是重新扫码。
  ② **userId 归一化**(`accounts.canonicalUserId`):换一份 bot 凭据后同一个人的
     from_user_id 会不会变由 iLink 决定。`replaceCredentials` 给已绑定的账号置
     `pendingRebind`,下一条来信若换了标识就登记进 `userIdAliases`,于是 userKey 照旧。
     **认领与命中必须在同一条来信内完成**(先消费标记再查表),否则第一条消息会开出一个
     空白用户。归一只作用于 userKey;`replyCtx.toUserId` 必须存**原始** from_user_id。
     安全前提与 TOFU 同一条(bot 属于扫码那个微信号自己),所以拿别人的微信重新扫码 =
     把这位用户的会话与工作目录转手,账号页上写明了。`unbind()` 连同别名一起清空。
- **iLink 扫码的两个反直觉点(已真机验证)**:`get_bot_qrcode` 的 `qrcode_img_content`
  是**授权 URL 文本而非图片**(所以要自己编二维码);`get_qrcode_status` 是**长轮询**,
  无人扫码时阻塞约 30 秒返回 `status:"wait"` —— 用默认 15 秒超时会每次都被中断。
- **账号备注名在扫码前定**(`ILinkLogin.start(displayName)`):多账号时二维码之间没有任何
  区别,扫完再回头认"刚才那个是谁"最容易配错人。空串 = 恢复默认名(与 `users.setDisplayName()`
  空名抛错刻意不同 —— 账号有 accountId 兜底)。
- **iLink App 标识无需申请**:`appid="bot"` 是官方包固定值,client version 是版本号编码;
  唯一个人凭据是扫码得的 `bot_token`。仅这些需真机校准:QR 端点、SKRouteTag、
  channel_version、限流。

## 稳定面:信使与守护人格

- **人格进程不能持有 `AccountStore`**:`accounts.json` 只能有一个写者(信使)。人格里留一个
  实例就握着一份可能过时的快照,而那个类每次写都是**整份覆写** —— 症状是"扫了码过一会儿
  又掉了"、"改的备注名自己变回去了",**没有任何报错**。`test/persona-isolation.test.ts`
  从入口走**真实的模块图**断言到不了它,并配一条反向用例(信使**必须**到得了 —— 少了它,
  把 accounts.ts 删光也全绿)。dashboard 的账号面全部走 IPC 代理。
- **IPC secret 一条例外都没有**(`gateway.childEnv`,连 admin 回合也剔除):拿到它就是拿到
  信使的整个控制面 —— 同容器同 uid,一句 `curl --unix-socket` 就能冒充任意 userKey 发消息
  (顺带烧光**别人**那条来信的 10 条预算 = 把他打成永久静默)、拉走并 ack 掉别人的消息、
  走 `/admin/*` 删账号(把 persona-isolation 那道墙整个绕过去)。
- **子进程 env 一律剔除 `CATMAN_ADMIN_TOKEN`,只有 admin 回合加回**:SDK 的 `Options.env`
  **整体替换**子进程环境(不是合并),必须展开 `process.env` —— 而它带着管理员令牌。
  这是该令牌下放的唯一出口,有单测守护。
- **拉取与投递是两条循环**(`channels/bridge.ts`):合成一条的话,长回合期间人格根本不再拉取,
  于是 ① `detach` 在它唯一该起作用的场景(主人格正跑长回合时用户发 `/救援`)送不到;
  ② 信使的"不可达"误判波及**所有其他用户**,各吃一条保留额;③ `health().live` 翻假。
- **"收下"与"处理完"是两个信号,`handler()` 同步返回前者**(`channels/types.ts` 的 `Accepted`)。
  它们曾经是同一个 promise,而它 resolve 的时机是**回合跑完**,于是长回合期间消息拉得进
  本地队列、投不进网关。后果不是"慢一点",是**两个功能整个够不着**:① 追加通道只在回合
  跑着时开着,而消息偏偏要等它结束才到,真机日志里「追加输入」一行都没有;② 微信
  「图 + 文字」那 120ms 的第二条同样进不来。纪律两条:**网关 `dispatch`/`collect`/`enqueue`
  一个都不许是 `async`**;**ack 仍等 `settled`,但不占投递链**(期间 msgId 占着 `queuedIds`
  挡住重复拉取)。
- **中止信号挂 `res` 不挂 `req`**(`ipc/server.ts`):`IncomingMessage` 的 `close` 在请求体
  **读完**那一刻就触发(实测),而端点都要先读 body —— 挂 `req` 的话 signal 一进门就是
  aborted,长轮询退化成忙轮询把 CPU 打满,**而且没有任何报错**。
- **同一个 `context_token` 不重置预算**(`reply-store.ts`):崩溃重放会让同一条来信被
  `remember` 第二次,清零之后就会超发,而超发是 `ret=-2` 且永不恢复。
- **投递失败必须有出口**(bridge):只 `break` 而不 ack/nack/退避的话,信使在队列非空时
  立刻返回,两者相乘是每秒上万次的热循环;而**单 inbox** 意味着所有用户的后续消息全堵在
  这一条后面。连续失败 3 次交回信使,退避 400ms(比拉取那个 3 秒短,因为撞上限的总时长
  就是全体用户的堵塞时长)。
- **写盘失败不能静默吞掉**(`courier/core.ts`):磁盘满时消息没进队列、`dropped` 覆盖不到、
  用户一个字收不到,而 `accept` 正常返回 → iLink 游标照常推进 → **永远不会重放**。
- **IPC socket 必须在可写区**:守护人格把主 `/data` 整个只读挂载,而 unix socket 的
  `connect()` 需要对 socket 文件的**写**权限 —— 放只读区的症状是"rescue 起来了但一条消息
  都收不到",日志里只有一句 EACCES。所以 `/data/ipc` 单独 rw 挂给三个容器。
- **`pinned` 由 `bless.sh` 钦定,且先把旧的存进 `pinned-prev`**:钦定错误只会在"信使起不来"
  时才发现,而那时两个人格已经一起聋了。
- **钦定之前必须确认目标跑得动稳定面的每一个角色**(`bless.sh` 查 `dist/src/index.js` 与
  `dist/src/courier/main.js`,判据与 `entrypoint.sh` 一致)。只查"目录存在"不够,真机上栽过:
  bless 不带 `CATMAN_PIN` 时默认取 `stable`,而**手工迁移过的机器上 stable 还停在旧拓扑**。
  那个 release 目录完好、内容齐全,只是没有 `courier/main.js`,于是信使进引导模式转一辈子;
  **守护人格更糟**,它的入口在旧 release 里存在,安安静静地跑起了旧代码。所以缺文件就
  **拒绝并非零退出,一个指针都不动**。加角色时 `entrypoint.sh` 与 `bless.sh` 两处都要改,
  有单测从 entrypoint 解析出角色清单跟 bless 对账。
- **token 到期时刻读不到就诚实说未知,绝不编**(`core/token-alert.ts`):过期时刻只有凭据
  文件(`$CLAUDE_CONFIG_DIR/.credentials.json` 的 `claudeAiOauth.expiresAt`)里有,
  `claude setup-token` 的 env 长效 token 是不透明字符串 —— 生产上多半就是这种。编一个假
  倒计时比没有倒计时糟得多(人会信它)。告警出口两个:守护人格状态页的红黄绿(无 LLM,
  token 过期时它还活着),以及主人格 prelude 里**只对管理员**的播报。**每个阈值
  (14/7/3/1 天/已过期)只播一次**,发送成功才落账,换 token 自动重来。

## 机械看门狗(版本回退)

⚠️ 与「内存与会话容器」里那个看门狗是**两回事**:这个管版本,那个管单回合的内存。

- **锁在就只观测、绝不动 `stable`、每级只退一次**(`rescue/watchdog.ts`)。决策是纯函数
  (不碰 docker、不看时钟),因为它是唯一在**没有人**的情况下换掉线上版本的东西 ——
  判错的看门狗比没有看门狗糟。锁的超时阈值**必须大于观察期上限**,否则一次正常的
  30 分钟观察期会被判成"deployer 死了",它就在部署成功的中途拨回去。
  「干净地停着」单独成一条规则:deployer 死在 stop 与 start 之间时容器是**正常退出**的,
  只看 crash-loop 永远发现不了。**看不见 ≠ 坏了**:`docker inspect` 取不到时什么都不做。
- **`demote` 与 `rollback` 的区别是语义**:rollback 是人的判断,所以连 `stable` 一起拨;
  demote 是机械判据(容器重启了几次),远弱于观察期,所以**只拨 `current`**。
  让看门狗写 stable 等于允许一次误判永久改写「回退目标」这个概念本身。
- **`courier-fallback` 是唯一会自动改写稳定面的动作,所以比 demote 多三道闸**。
  它修的是一种别处修不了的故障:`pinned` 的依据是那份 release 当过 `stable`,而**观察期
  只跑主人格** —— 信使的代码路径在那 30 分钟里一次都没执行过。于是一份"过了门"的 release
  完全可能带着一个起不来的信使,后果是微信整个聋掉,连报警都发不出去。三道闸:
  ① **有 pinned-prev 且不同于 pinned**(它由 bless 在**第二次**钦定时才产生);
  ② **只退一次**(退过还崩多半不是版本问题);
  ③ **主人格必须是好的**(两个一起崩说明是环境问题,换 pinned 没用却把稳定面悄悄挪走了)。
  反过来「信使崩、主人格好」是很强的信号。执行侧只动 `pinned`,重启的是**信使容器**;
  判据只是"连续 15 秒没再重启"(信使没有 HTTP 端点)。**不重启守护人格** —— 重启它等于
  杀掉正在执行这次兜底的决策者,何况它此刻是唯一还活着的观测点。
- **磁盘红色水位由看门狗清一次,清完还红就报警**:磁盘满是"两个容器一起崩"最常见的环境
  原因,规则排在容器规则**前面**——那时退版本没用,清理可能直接治好。动作只是起固化的
  deployer 跑 `gc`,**不写 report.json**(那是部署结果的播报通道,覆写等于把一条可能是失败
  的部署结果永久顶掉)。**只清一次**。读不到磁盘余量就当没这条规则(看不见 ≠ 满了)。
  红线(2GB)与制备门(5GB)是**两个不同的问题**:后者是"别开始一件要几百 MB 的事",
  前者是"再不清连回滚都要做不了了"。
- **每周冷启动点火**(`deployer.sh drill` + `watchdog.shouldIgnite`):活进程握着已删 inode
  照常运行,pinned 的字节坏没坏只有**从磁盘冷启动**才测得出来 —— 那正是断电重启那天要走
  的路。四项检查按依赖顺序:字节完整 → 冷启动 SELFCHECK → 主人格 /health 健康且 sha 一致
  → 回滚机构(history 可解析 + dry-run flip)。结果写 **ignition.json**(与 report.json 分开);
  从没点过火也要红 —— 例行演练没在跑本身就是异常。

## 自进化与部署

目标:管理员在微信里说一个改进想法,catman 自己改代码、跑测试、制备 release,汇报后由人
确认,再由**独立的 deployer 容器**完成切换与回滚。失败的最坏结果是"这次改进没上线",
而不是"catman 下线了"。

```
改代码 → 制备 release → 汇报 → /发布 <前6位> → 切换+观察期
 agent    agent            agent   **管理员亲手打**   deployer
(开 evolve/<slug> 分支)   (末行是新 sha)          (自检→排水→切换→
                                                  健康门→30min→前移 stable→push)
```

agent 那一侧的全部知识写在 `catman-evolve` skill 里(只对**主人格的**管理员回合可见)。

- **更新者不能是被更新者**:切换与回滚跑在独立的一次性容器里(`deployer-run.sh` 起,
  容器名固定 = 天然串行互斥)。它做的第一件事就是 `docker stop catman` —— 跑在 catman 里的
  子进程会在那一刻连同父进程一起被杀,切换停在半路。
- **执法者自己取证**:smoke 由 deployer **亲自**跑(不是让 agent 递一份"我测过了"的证明),
  健康门比对的 sha 是它从 `/health` 亲自读的。agent 改坏了自检代码,结果只会是它自己的版本
  过不了门,而不是门失效。
- **`stable` 只在观察期结束后前移**。观察期内 `current ≠ stable`,所以那段时间的任何崩溃
  (含宿主断电重启)都自然落回 stable。反过来(切换成功就前移)会让观察期变成纯仪式:
  真出事时"回滚目标"恰恰就是刚上线的坏版本。
- **观察期长度是 `CATMAN_BAKE_SECONDS`**(默认 1800)。它是**真正的门**,缩短等于把判据
  退化成"起来了就算过"—— 首个真实回合把它打崩这类失败未必在两分钟内出现。日常别改。
- **回滚是"先停、再换、后起"**:不先停就换链接的话,restart 策略会在中途把旧容器拉起来,
  而 crash-loop 的容器每次启动都可能再写一遍状态文件 —— 回滚这个最后防线自己产出损坏状态。
- **换链接必须可从任意断点重跑**(`pointer_set`):deployer 可能在 `ln` 与 `mv` 之间被杀,
  残留的 `.tmp` 会让下一次部署在 `ln -s` 上 EEXIST 失败,而那时容器已经停了 —— 没人拉起它。
- **GC 的保留集 = 已验证清单 ∪ 全部指针的 realpath**(`lib.sh` 的 `release_gc`)。指针那一半
  不能省:守护人格钉住的 release 天然是最老的,只按"保留最近 N 个"会把它的脚下抽空 ——
  而活进程握着已删 inode 照样在跑,直到某次断电重启才暴露。
- **GC 枚举时必须跳过符号链接,并且只认 40 位十六进制的目录名**。带尾斜杠的 glob(`"$DIR"/*/`)
  会把 current/stable/pinned 这些**指向目录的链接**一并列出来,而它们的名字当然不在保留集里
  —— 于是 `rm -rf current/` 顺着链接进去**把目标 release 的内容掏空**,链接本身完好无损,
  日志上只有一句轻描淡写的"GC 清理 release current"。
  **保留集算得再对也白搭:删错的不是"没被保留的那些",而是"保留集本身指着的那些"。**
  真机上发生过一次,current 与全部回滚目标同时变成空目录。第二道闸的取向是
  **宁可漏删,不可错删**。`release_gc` 因此住在 lib.sh 而不是 deployer.sh:它是这套脚本里
  最危险的函数,必须能被 shell 层单测直接跑起来验(拆掉任一道闸,用例立刻变红)。
- **完整性靠内容清单不靠 git**(`release_verify`):`dist/` 与 `node_modules/` 都在
  `.gitignore` 里,`git status` 对它们**全盲**,而那才是真正被执行的字节。所以制备时生成
  MANIFEST,切换到任何 release 之前重验。目录去写权限只做**目录**不做文件:目录 inode
  不被硬链接共享,chmod 文件会穿透到复用同一批文件的旧 release。
- **devDependencies 保留,绝不 prune**(`prepare.sh`)。下一次制备若 lockfile 没变就
  `cp -al` 硬链接复用上一个 release 的 node_modules —— 若那棵树里没有 tsc/tsx,
  **最常见的那条路径必然失败**;补装又会就地写文件,透过硬链接污染上一个(可能正是
  stable)release 的字节。配套纪律:**复用之后对那棵树零 npm 写操作**。
- **不用 `git worktree` 制备,用浅 clone**:worktree 的 `.git` 只是指向共享仓库的指针,
  清理时 `rm -rf` 会留下元数据残骸,导致**同一个 sha 无法再次 worktree add** ——
  恰好死在"回滚之后想重新制备旧版本"这条事故恢复路径上。
- **`npm ci` 必须跑在目标架构下**:claude 二进制来自 Agent SDK 的 optionalDependencies,
  npm 按**执行安装的那个容器**的 arch/libc 选包。源码直跑之后这条自动满足 —— 依赖是在
  **目标机器上**制备时装的。验证:`node -p process.arch` 与
  `ls $(readlink -f /data/releases/current)/node_modules/@anthropic-ai/` 必须对得上。
  基底是 bookworm(glibc),换 alpine 会切到 musl 变体。
- **smoke 失败要分类**(`selfcheck.ts` 的 `classifyFailure`):限流与网络是**环境**的错,
  退避重试;把它们判成"新版本坏了"会让一次二十分钟的上游抖动废掉一个完好的版本。
- **自检模式的 stdout 是结果通道,只出一行 JSON**(`redirectConsoleToStderr`)。Node 的
  `console.log` 默认写 stdout,而自检期间装配、SDK、agent-trace 都在打日志 —— 漏一行进去,
  deployer 解析到的就不是 JSON,于是**每一次部署都以「自检没过」告终,而 release 完全是好的**。
  把好版本判死的门比没有门更糟。读取端同样防御式(只取以 `{` 开头的最后一行)。
- **健康门只看本地可判定项**(`health.ts`):进程起没起、渠道通不通、`version.sha` 对不对。
  大脑状态(`lastTurn`)只是观测位,**不参与判死**。
- **健康检查的 curl 必须 `--noproxy '*'`**(`lib.sh` 的 `health_json`):代理环境变量是
  **必须**透传给 deployer 的(smoke 要够得着 Anthropic API),而 `NO_PROXY` 里的 CIDR
  只对 IP 字面量生效、对主机名是后缀匹配 —— `172.16.0.0/12` 拦不住 `host.docker.internal`。
  于是健康门永远超时,每次部署都在最后一步自动回滚。钉在代码里,别靠"配置里记得写排除项"。
- **排水要三个计数同时归零**(`GatewayHealth`):聚合窗口、分拣链、在飞回合(前台)。
  只看在飞回合的话,卡在前两段的消息会被切换连人带话一起杀掉。后台回合**不算**。
- **版本戳读不到就是 undefined,绝不编**(`version.ts`):健康门拿它比对,编造的值会让门
  放行一次实际没切成功的部署 —— 那正是这道门存在的理由。
- **两份 JSON 是跨版本契约**:部署报告与已验证清单由钦定版本的 deployer 写、每周都在进化的
  catman 读。字段只增不改,读取端一律防御式解析。`/health` 同理,golden 测试钉着形状。
- **部署机制不随自我进化更新**:`/回滚` 执行的是 `bless.sh` 固化到 `/data/deploy/bin/` 的
  那份脚本。改了 `scripts/evolve/` 要重新 bless 才生效 —— 门禁和逃生门是同一把锁。
  **`prepare.sh` 同属固化侧,理由一字不差**:制备门(typecheck + 全量测试)就在它里面,
  跑 release 里那份等于让被考的人自己出卷子 —— 一次把 `npm test` 改没了的进化,会让
  **此后每一次**制备都不再跑测试,而日志上看起来一切正常。固化不是沙箱,它拦的是
  "约定路径悄悄变了"。
- **确认口令必须是硬指令**(`/发布 <前6位>`):它是整条流水线里唯一一处把「人批准了什么」
  与「机器部署了什么」机械绑在一起的地方 —— sha 由人亲手打进来、由网关按字面解析。
  交给 LLM 识别「发布 abc123」再去起 deployer 的话,这把锁就挂在一个会看错字、会自作主张、
  而且**正是被部署的那一方**的环节上。网关在这里也**不做任何解释**(不补全、不纠错、
  不挑最近的一个),四种拒绝各说各的话。前缀下限 6 位,展示一律用 `shortSha()`(7 位)。
- **判「已经是当前版本」看版本戳,不看 `current` 指针**(`deploy.ts` 的 `runningSha`):
  指针与运行中的进程对不上时(换了链接没重启、crash-loop 卡在旧代码上),重新部署一次
  **恰恰是修复手段**,按指针拒绝会把这条修复路径堵死。
- **Tier 分类表必须住在固化侧**(`lib.sh` 的 `tier_of`,不是 `src/` 里的 TS):它要是住在
  被自我进化改写的那棵树里,agent 顺手改一行 case 就能把 Tier 3 报成 Tier 1 ——
  而人正是靠这份报告决定还欠什么(重新 bless / 重建镜像 / recreate 容器)。
  分级**不拦任何事**也拦不住;这里做的是**说出来**,免得人以为"部署成功 = 我要的都生效了"。
- **部署密钥是两把不是一把**(`lib.sh` 的 `fetch_key_path` / `push_key_path`):ssh 对私钥有
  属主检查(必须归当前用户或 root 且 0600),所以**一把钥匙只能服务一个 uid** —— 这是硬约束,
  不是设计选择。`/data/ssh/fetch/id_ed25519`(10001,**只读** deploy key)给 agent 拉代码;
  `/data/ssh/id_ed25519`(10002,可写)给 deployer 推远端。
  **agent 的 pull 是主路径,不能省**:曾经把密钥整个归 10002,结果 agent 一行 `git pull`
  都跑不了,而软路由宿主上连 git 都没有。「agent 改不了远端历史」这道闸因此从**文件属主**
  上移到 **GitHub 侧的只读 deploy key**,而后者更强:属主挡不住挂了 docker.sock 的助手,
  只读密钥挡得住。agent 那把写进**仓库配置**(`core.sshCommand`)而不是容器 env ——
  env 要改 compose(Tier 3,每次都要人)。**`init.sh` 绝不 chown 密钥**:属主就是"这把给谁用"
  的唯一声明。
- **远端只由 deployer 在部署成功、stable 前移之后推进**(`lib.sh` 的 `push_upstream`):
  GitHub 上出现的永远是真正上线过并活下来的提交(推得更早会让远端记录一堆从未运行过的
  东西,而人恰恰靠远端判断线上是什么)。推失败**只记日志,绝不反过来判部署失败**;
  同理**绝不 `--force`**,快进失败正是它该失败的样子。
- **制备要先让 git 接受属主不同的仓库**(`lib.sh` 的 `git_trust_repo`):`/data/src/catman`
  归 catman(10001),而制备跑在 deployer(10002)下。这个跨属主是**设计使然**,不是意外。
  属主一不同 git 就 "detected dubious ownership",**第一条 git 命令就失败**;开发机上两者是
  同一个人,所以这条路径只会在真机上炸。三条缺一不可:
  ① **两个路径都要放行** —— `rev-parse` 认仓库目录,`clone` 认它下面的 `.git`;
  ② **必须走 `GIT_CONFIG_GLOBAL` 配置文件,不能用 `GIT_CONFIG_COUNT` 那族环境变量** ——
     `git clone <本地路径>` 会 fork `git-upload-pack` 去读源仓库,而 git 在 fork 前显式
     `unset GIT_CONFIG_COUNT`,子进程一个例外都收不到,只留下一句 "Could not read from
     remote repository";
  ③ 配置文件写在 `/tmp`,**每个容器各自调一次**,不要把 `GIT_CONFIG_GLOBAL` 传给别的容器 ——
     那边没有这个文件,而 git 对读不到的 global 配置是静默当空的。
- **一次性容器要显式补 docker.sock 的属组**(`DOCKER_GID`):它们以 uid 10002 跑,而 socket
  的属组是**宿主**的事实(OpenWrt 多为 0,Debian 多为 999),镜像里无从得知。漏了的症状是
  `/回滚` 起了容器却什么都没干,日志里只有一句 permission denied。
- **固化环境由 lib.sh 自己读**(`load_blessed_env`):谁 source 了 lib.sh 谁就自动拿到
  `/data/deploy/env` 里的宿主路径、镜像名、docker.sock 属组。这是 agent 能直接跑
  `prepare.sh` 的前提。**已经有值的一律不覆盖** —— 命令行上的显式覆盖是排查时唯一的旋钮。
- **bless 换文件必须换 inode**(用 `install` 而不是 `cp`):bash 边读边执行,`cp` 保留目标
  inode、原地覆写字节,会让正在跑的脚本从中间读到新内容 —— 而"正在跑的"最可能是一个处在
  30 分钟观察期里的 deployer。`install` 先 unlink 再新建,老 inode 活到那个进程读完。
- **agent 的 git 身份在仓库级设**(`init.sh`):镜像里什么都没配,而 `git commit` 没有
  `user.name`/`user.email` 就直接失败 —— 自进化的第一步就是提交。写仓库级而不是 global,
  不依赖 HOME 可写,且这份配置随仓库走。
- **`init.sh` 重跑修的是配置,不是版本**:`current` 指针在就**立即退出**。那两段是**引导**
  动作(把三个指针立到一个从未过门的 release 上、把清单重写成只有它一条);在活着的机器上
  重跑等于绕过整套门禁换掉线上版本,**并把全部回滚目标从清单里抹掉**。
- **`docker build` 不进部署路径**:切换不重建容器,所以流水线完全不碰 docker compose。
  它的文件优先级、override 自动合并、`${PWD}` 在容器里插值成空串、项目名不一致导致认领失败、
  两个 compose 版本算出的 config hash 不同引发反复 recreate —— 这些坑不用它就一个都不存在。
  改 compose 仍然要人。
- **入口脚本必须让显式命令穿透**(`entrypoint.sh` 开头的 `[ "$#" -gt 0 ] && exec "$@"`)。
  整条流水线全靠一次性容器干活,都是 `docker run <镜像> <命令>` 的形式;不认显式命令的话
  那个命令会变成 node 的 argv,于是**没有 release 时容器在引导模式里永远转下去**,
  **已有 release 时更糟 —— 再起一个完整的 catman,两个进程同时写同一份 `/data`**。
  两种都不报错,只是不干你让它干的事。调用方补 `--entrypoint` 不算修好(要求每个调用点
  都记得写,而且会绕开 tini,子进程僵尸没人收)。
- **入口脚本解析不到 release 时进引导模式**,慢速重试而不是 crash-loop:全新机器上数据卷
  是空的,而能造出第一个 release 的 `prepare.sh` 要在容器里跑。
- **部署类指令是 `adminOnly`**:影响是全局的(一次回滚把所有用户都换版本),而 catman 是
  多用户的。**挡掉 = 当它不是指令**,于是照常走 LLM —— 非管理员既用不了、也看不出它们存在,
  不必回一句"你没权限"(那句话本身就在告诉他有这个东西)。
- **部署进展是主动推的,不等用户开口**(`Gateway.flushDeployNews`,15 秒一轮)。从前只在
  prelude 里捎带,于是真机上的体验是"发布之后等多久都等不到结果,直到自己先说话"。
  三条纪律:**发送成功才标记已播报**(先标记等于把这条永久吞掉,而「升级失败已回滚」
  最不能丢);**失败最多再试两次、间隔 1 分钟**(失败的尝试照样烧同一份发送预算);
  **定时器与 prelude 共用一条串行链**(否则两边同时判"还没播过",用户收到两遍)。
- **里程碑与报告分工**:里程碑说"这一步过了"(切换 / 转稳定 / 推远端),报告说"整件事的
  结局"。失败**不写里程碑** —— 否则用户先收到"已切到 xxx"再收到"已回滚"。里程碑是
  **JSONL 追加**而非覆盖:三条之间隔着几十分钟,覆盖会让中间那条消失。

## 权限与隔离

- **bypassPermissions 不能以 root 运行**;镜像里用 uid 10001 的 catman 用户。
  镜像里还有 uid 10002 的 deployer:**`/data/releases` 属它所有,主容器只读挂载**。
  助手文件系统全开,一句「帮我清清磁盘」就足以把回滚目标 rm 掉(硬链接复用还让每个
  release 在 du 里都按全量计,看着最该删);只读挂载让那种误删直接 EACCES 暴露。
- **宿主 Docker 访问靠运行时注入的组,不能写死进镜像**:镜像只预装 docker CLI(无 daemon),
  `/var/run/docker.sock` 由 compose 挂载、访问权限由 `group_add: ${DOCKER_GID:-0}` 给。
  该 GID 属于宿主,写进镜像会一换机器就 `permission denied`。
  ⚠️ 挂了 socket 就等于把宿主 root 交给助手,**隔离边界从容器退化为对助手的信任** ——
  README「安全说明」按这个口径写,别改回"容器即隔离边界"。同理,救援人格的 `/data` 只读
  是**防手滑的护栏,不是安全边界**。

## 可观测性

- **LLM 侧的可观测性分两级,分界线是"事后才想起要查"**(`agent-trace.ts`):回合起止、
  `init`、API 重试、限流、上下文压缩、`stderr`、心跳一律记录(`always`),**不受开关约束**
  —— 需要它们时通常是事后翻日志,那时再开开关重启已经晚了;逐条 SDK 消息的摘要才归
  `CATMAN_AGENT_TRACE=1`。加新的消息类型时先问「它是不是某种『为什么没反应』的答案」。
  **只出标量与截断摘要,不出正文**(思考/文本只出字数、工具结果只出长度与成败、
  图片只出 base64 字符数),这条钉在单测里。唯一例外是工具入参摘要:"在跑什么命令"正是
  要找的东西,而且它与推给用户的进度共用 `summarizeToolInput`。
- **日志一律带时间戳**(`log-stamp.ts` 在 `index.ts` 最前面包裹 console):排查发送问题时
  "这两条隔了多久"是最基本的信息。包 console 而不是换 logger,是因为几十处调用点加上
  SDK 自己打的,漏一处那行就成了时间轴上的断点。容器**不继承宿主时区**,compose 透传 `TZ`。
  `CATMAN_ILINK_TRACE=1` 下每条发送打「第几次 / 成功过几条 / token 多老」;
  **失败行无条件打印**,因为回执与进度的失败在 `gateway.trySend` 那层是被吞掉的。
- **心跳用定时器不违反「进度不用定时器」那条**(`agent.ts` 的 `HEARTBEAT_MS`):那条约束的
  理由是定时器会让进度**消息**插到正文之后、在用户那边乱序,而心跳只进日志。心跳的
  "上次动静"以**任何一条** SDK 消息为准,否则工具结果回填期间会把正常推进的回合误报成卡住。
- **`unref()` 只给纯观测的定时器,欠着动作的绝不 unref**。分界线是「它手里有没有别人在等
  的东西」:超时提醒、回合心跳、SSE keepalive 只是定期看一眼,不该拦着进程退出;而聚合窗口
  的 debounce 攥着**已经从渠道收下、长轮询游标也推进了**的消息,自检的超时欠着「中止并给出
  分类结论」—— unref 它们等于宣告「只剩这件事没做时可以直接退出」,于是消息真丢、结论真的没有。
  **这类 bug 在生产里永远看不见**(进程总有 dashboard 与长轮询占着事件循环),它是靠制备
  容器里 node 22 的测试运行器暴露的 —— 也就是说,**流水线在镜像里跑全量测试这件事本身
  抓到了它**。注意开发容器与镜像的 node 版本可能不同,**以镜像里的为准**。

## 约定

- 注释与文档用中文;代码标识符英文。
- ESM + NodeNext:相对 import 带 `.js` 后缀(编译前也写 `.js`)。
- 测试:`node:test` + `tsx`,纯逻辑用注入的假时钟/内存 store,不碰真实网络或 Claude。
  HTTP 层也一样:路由与鉴权写成纯函数,`server.ts` 只做 IO 适配 —— 测试不必起真实 server。
- **验脚本行为的用例必须自带干净环境**(`test/evolve-lib.test.ts` 的 `cleanEnv`):测试跑在
  **制备容器**里,而那个容器的 shell 是 `. /data/deploy/bin/lib.sh` 起来的 ——
  `load_blessed_env` 于是把**真机的** `/data/deploy/env` 整个 export 进环境。而它的语义是
  "已有值不覆盖",于是用例摆好的那份固化 env 永远赢不了真机那份:**开发机上全绿,
  制备容器里报「部署机制还没固化」并打出真机的路径**。所以这类用例一律剔除
  `CATMAN_*` / `DOCKER_GID` / `GIT_CONFIG_GLOBAL` / `GIT_SSH_COMMAND` 再起子进程。
- **别拿 inode 号验"文件被换掉了"**:inode 号会被**回收**。要验"正在读它的进程不受影响",
  就开一个 fd、换完再从那个 fd 读。比对 inode 号在开发容器里碰巧能过、在真机上直接假红,
  而假红比没有测试更浪费人。
- **`npm run typecheck && npm test` 两条都要跑,而且要在改完之后跑。**
  两条各自能漏的东西**恰好不重叠**,所以缺一条就等于没验:
  - `npx tsx --test <某个文件>` 跑得通**不代表类型对** —— tsx 只剥掉类型,不检查它。
  - `npm test` **不含 typecheck**。
  - 于是"先 typecheck、再写新测试文件、然后只用 tsx 单跑它"这个顺序会一路绿灯,
    直到制备门(它跑全量 typecheck)才红。真实发生过:新写的测试里构造了一个缺字段的
    `ImageAttachment`,本地三种跑法全绿,制备第一步就 `error TS2739`。

  这条和上面两条是同一个家族:**本地那次绿是假绿**。前两条的成因是"环境比你以为的脏",
  这条是"**工具比你以为的弱**"。共同的解法也一样 —— 别问"我跑过了吗",
  问"**我跑的那个东西,验得动我要验的性质吗**"。

- 新增聊天渠道:实现 `Channel` 接口(对外一律用 userKey,不是渠道内的裸 userId),
  在 `index.ts` 的 `createChannel` 里连同**准入策略**一起加进 `CompositeChannel` /
  `compositeAdmission`;不要动会话核心。复合准入对**未登记的渠道前缀一律拒绝** ——
  漏配应当表现为不工作,而不是没防护。
- 改指令写法时记得 `reminderText` 之类的文案 —— 用 `canonicalOf()` 引用而不是手写字符串。
