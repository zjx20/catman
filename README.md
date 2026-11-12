# catman

跑在 OpenWrt / x86 软路由 Docker 里的个人 AI 助手:通过**微信**与之对话,后端是基于
**Claude Agent SDK** 的长驻服务,使用 **Claude 订阅** 计费,能在容器内执行任意命令
(Claude Code 的能力与行为),并带一个 HTTP **dashboard** 查看会话记录、管理接入账号。
**支持多人各自扫码接入**,每人独立的会话上下文与工作目录。

> 个人自用工具。微信侧走腾讯官方 **iLink 协议**(Tencent/openclaw-weixin 所用),合法、
> 出站长轮询、无需公网 IP。

## 能做什么

- 微信里给"ClawBot"联系人发消息 → 助手在容器内执行(如"看下路由器内存占用")并回复
- **即时反馈**:收到消息先回一条"收到,正在处理中…"回执,处理期间转发两类动静 ——
  `💭` 思考摘要、`🔧` 工具调用(如 `🔧 Bash: free -m`),最后发出正式回复。
  它**中途说的话**(工具调用之间那几句交代)不算进度,**整条原样发**,不裁不折,
  关掉进度推送也照发 —— 那是它在跟你说话,与最终答复同等地位;最终答复本身
  只走正文那条路,不会同一句话收两遍。
  支持撤回的渠道会在回复后撤回回执
  (iLink 协议没有撤回端点,微信里回执会保留)。可用 `CATMAN_ACK` / `CATMAN_PROGRESS` 关闭。
  进度**按 5→15→30→60 秒的阶梯节流**,同一间隔内只发最新那条并标注跳过了几步
  (如 `🔧 Bash: npm test(+4 步)`)—— 原因见 [发送预算](#一个-context_token-的发送预算)
- **说到一半可以补话**:助手正在跑的时候再发消息,会**折进正在进行的那一轮**,
  它下一步就能看到 —— 不用等这轮跑完。想改主意("等下,用 sed 别用 python")直接说就行,
  不必 `/取消` 重来。补进去的会立刻回一句"收到,一并交给正在处理的这一轮了",
  `/状态` 里也会显示这一轮期间补充了几条
- **会话智能管理**:上下文过长自动压缩(SDK 内置);距上次对话达到 1 小时后尝试提醒，
  提醒实际发出后，下一条普通消息才开新会话。未发出提醒则继续原会话；发 `/继续` 可保活。
  离开的会话进入每人最多 10 段的历史,
  发 `/切换会话 <会话id>` 可随时切回其中一段 —— 微信只有一个聊天窗,这就是多话题并行的出路
- **硬指令**:`/帮助` `/状态` `/nop` `/新会话` `/取消` `/继续` `/切换会话` 由后台直接响应,不经过 LLM ——
  所以助手卡住时它们照样管用(见 [硬指令](#硬指令))
- **切走的对话继续在后台跑**:助手忙着的时候 `/新会话` 或 `/切换会话` 不会打断它 ——
  那一轮转到后台跑完,结果带着「【后台对话 xxx 的结果】」发给你,期间你照常聊别的
- **自助设置**:直接说"换成 sonnet""别刷进度了""超时改成一天",助手会调本机接口改你自己的
  配置(见 [自助设置与管理员](#自助设置与管理员))
- **定时任务**:说一句"每天早上八点看一眼磁盘",它就建好排期,到点在一次性 docker 容器里
  跑那条命令,跑完把结果和下次触发时刻推给你。断网、只读挂载、资源上限、并发 1、
  连续失败自动停用 —— 一整套闸门是按"这台机器只有 2 核"设计的(见 [定时任务](#定时任务))
- **记录与检索**:完整会话以 JSONL 持久化,dashboard 可浏览、按关键词检索
- **自动清理**:超过 30 天的会话自动删除
- **多人使用**:在 dashboard 上扫码即可接入一位新用户,各自独立的会话与工作目录;
  每个账号只服务扫码绑定的那个人,其他人的来信一律拒绝(见 [多人接入](#多人接入))
- **管理员聊天**:dashboard 自带一个聊天页,那里的对话有管理员权限,可以用大白话改全局配置
  ("把默认模型换成 opus""并发上限调到 5")。聊天记录存在服务端,刷新和重启都还在;
  页面上有一个「开新会话」按钮 —— 它只让助手忘掉上下文,**不清空聊天记录**
- **宿主运维**:agent 申请、用户硬指令授权后，通过独立 SSH 运维容器探索部署指定的宿主目录；可选完整 Docker CLI/Compose 权限，主会话不重建（见[临时运维容器](#临时运维容器)）。

## 架构

控制服务管理身份、授权、会话路由、调度、任务记录和通知。worker 的文件系统只包含当前上下文和 owner 的个人空间。

```text
用户消息 / cron → 控制服务 → owner + context → 常驻 worker
                                              ├─ 任务管理进程
                                              ├─ Claude CLI（按需启动，SDK 有后台任务时保留）
                                              └─ 有明确超时的后台脚本
```

普通聊天每段 session 使用独立 workspace；每个 cron 使用固定 workspace，多次执行共享游标与台账。两者继承同一 owner 的个人配置和 skill。
临时执行内容、中间文件和任务私有状态写在 workspace，按需要组织子目录。workspace 在容器回收后仍保留，容器的 `/tmp` 随容器回收。同一用户的聊天和 cron 共用 `/user`；长期共用的提示词、配置、脚本和需保留的输出统一归入 `/user/projects/<项目>`。项目内部结构灵活，优先沿用已有布局，`prompts/`、`scripts/`、`outputs/` 只是建议；不再使用顶层 `/user/artifacts`。
管理员可以通过受控接口修改全局设置、公共能力配置并触发自进化。worker 没有 Docker socket、整棵 `/data`、其他用户目录或原始管理员凭据。容器启动失败直接报错，不退回控制进程执行。控制服务重启后认领原容器与已登记任务；无法重连的旧 SDK stdio 连接会先停止，再恢复会话，防止两个 CLI 并发写同一会话。

全局人格在 `/data/shared/CLAUDE.md`；公共 skill 保留在控制面的 `$CLAUDE_CONFIG_DIR/skills`，按角色只读投影。个人偏好在 `/user/CLAUDE.md`，个人 skill 在 `/user/skills/<名字>/SKILL.md`。
公共模型凭据和公共 MCP/HTTP 服务凭据由控制服务持有，worker 通过限定的运行身份使用。个人 MCP 可在 `/user/mcp.json` 配置；公共 MCP 使用 HTTP 部署端点，私人 MCP 可使用 stdio。

```text
/data/
  execution/
    schema.json                  # 数据布局版本（2）
    contexts.json                # 归属、session/cron、SDK session ID
    runtimes.json                # 运行环境、身份、活动时间、任务截止时间
    events.json                  # 完成、超时、回收和通知状态
    shared-tools.json            # 公共 MCP/服务端点及凭据，0600
  shared/CLAUDE.md
  tenants/<tenantId>/
    home/                        # 本用户的持久文件、个人 skill 和配置
    contexts/<contextId>/
      work/                      # 当前 workspace
      sdk/                       # 此上下文的 SDK 会话与记忆
      tasks/                     # 有限后台任务记录与日志
```

tenantId 是 userKey 的 SHA-256 前 32 个十六进制字符。contextId 由服务端生成，SDK session ID 单独记录。控制面注册表是归属和清理的真相源。

活跃环境数量受 `CATMAN_MAX_ACTIVE_RUNTIMES` 限制，主人格默认 3、守护人格默认 1；每个环境受 `CATMAN_SESSION_MEMORY` 限制，默认 700m。部署时要按主人格、守护人格、构建任务的总内存预算配置，不能只计算前台回合数。

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

dashboard 上可以扫码接入用户，并操作管理员控制面，所以**整站需要令牌**
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
- **自家那三个容器**(`catman` / `catman-courier` / `catman-rescue`)—— 理由见下。

要改就在 `.env` 里设 `NO_PROXY=...`。注意它是**整体替换**而不是追加,自定义时上面四类得自己补回。

#### CIDR 只对 IP 字面量生效,对主机名是后缀匹配

这一条是这套东西里最难查的一类错的根源。同一台机器上:

```
curl http://172.18.0.107:8787/health   → 200   命中 172.16.0.0/12
curl http://catman-courier:8787/health → 503   容器名不在 NO_PROXY 里
```

那个 503 的响应头带 `Proxy-Connection: close` —— **是代理在说话,不是服务**。代理那边
解析不了 docker 的内嵌 DNS 名字(它只在那张网里有效),于是回一个 503,而你看到的
现象是"这个服务挂了"。`host.docker.internal` 早就因为同一条规则被显式列进名单
(它解析出的 `172.17.0.1` 确实落在 `172.16.0.0/12` 里,照样不管用)。

而且**没有通配、也没有前缀匹配**:`catman` 盖不住 `catman-courier`,三个名字得一个个写。

自家这三个进了默认名单。**别人的容器刻意不加** —— 那份名单枚举不完也维护不动。
访问它们时显式绕开代理:`curl --noproxy '*'`,或别的工具的等效写法。这条约定写在
共享人设 CLAUDE.md 里(`core/persona.ts` 的模板),新部署也带着走。

#### 定时任务的容器

聊天与 cron 由同一执行计划配置网络，普通任务不能自选网络或宿主挂载。公共模型/MCP 凭据由控制面代理持有。
worker 可继承不含凭据的 HTTP_PROXY/HTTPS_PROXY，NO_PROXY 额外包含控制服务地址。含凭据的代理应通过内部网关提供，避免原始共享密钥进入 worker。

### 构建镜像时的代理

上面配的是**运行时**。`docker compose build` 阶段要拉 Debian 源、docker.com 和 npm registry,
用的是另一套设置 —— compose 的 `build.args` 已经接上同样的 `.env` 变量,填了就自动生效,
不需要额外做什么。构建期连不上而运行期正常(或反过来)时,记得这是两处独立的设置。

## 启动

catman 采用**源码直跑**:镜像(`catman-env`)只是一层不含业务代码的运行环境,真正跑的代码
是数据卷里的 **release 目录**,由符号链接 `data/releases/current` 指定。所以首次部署分三步 ——
构建基底镜像、初始化第一个 release、起服务:

```bash
# 0) /data 在宿主上的绝对路径,后面几步都要用(自进化的一次性容器靠它挂卷)
export CATMAN_HOST_DATA_DIR="$PWD/data"
echo "CATMAN_HOST_DATA_DIR=$CATMAN_HOST_DATA_DIR" >> .env

# 1) 构建稳定基底镜像(此后极少重建 —— 升级换的是代码,不是镜像)
docker build --pull -t catman-env:1 -f docker/Dockerfile .

# 2) 初始化:clone 源码到数据卷、制备第一个 release、立起指针
scripts/evolve/init.sh

# 3) 固化部署机制(自进化与 /回滚 要用,见「自进化」)
scripts/evolve/bless.sh

# 4) 起服务
docker compose up -d
docker compose logs -f          # 看启动日志(未设令牌时这里能看到自动生成的)
# dashboard: http://<路由器内网IP>:8787/?token=<你的令牌>
```

首次启动还没有任何微信账号,日志会提示去 dashboard 扫码。

### 宿主上没有 bash / git / node 怎么办

软路由(OpenWrt 等)常常只有 busybox 和 docker,连 `bash` 都没有。
**第 2、3 步整个搬进容器跑就行** —— `catman-env` 里 bash、git、node、docker CLI 全都有,
而它们要读写的东西本来就在数据卷里。宿主上需要的只有 `docker` 一个命令。

```bash
DATA=/opt/services/catman/data                 # ← 换成你的绝对路径
GID=$(stat -c '%g' /var/run/docker.sock)

# ⚠️ 代理必须先在**当前 shell** 里存在,下面的 `-e HTTP_PROXY`(不带值)才有东西可传 ——
# docker 对未设的变量是整个跳过,于是最内层的 npm ci 直接 ENOTFOUND,而 npm 会把真因
# 埋在几百行日志中间再甩一句它自己的 "Exit handler never called!"。
set -a; . ./.env; set +a

# 够不着 registry.npmjs.org 时换镜像(npm ci 会连带把 lockfile 里的 tarball 主机也换掉,
# 完整性哈希照常逐个校验)。不需要就别设。
export CATMAN_NPM_REGISTRY=https://registry.npmmirror.com

# 制备容器的内存上限。node 的测试运行器按 CPU 数并行开进程,小机器上很容易顶到它 ——
# 被杀掉的测试文件在汇总里表现为 **cancelled** 而不是 fail,光看汇总看不出是内存。
# 两个方向二选一(或都用):放宽上限,或压住测试并发。
# export CATMAN_PREPARE_MEMORY=2500m
# export CATMAN_TEST_FLAGS="--test-concurrency=2"

# ① 源码 clone 进数据卷。以 root 跑再 chown 给 10001 —— 部署密钥归 10002(见下一节),
#    只有 root 读得到它。公开仓库用 https:// 就不需要密钥这一行。
docker run --rm -u 0:0 -v "$DATA:/data" \
  -e HTTP_PROXY -e HTTPS_PROXY -e NO_PROXY -e http_proxy -e https_proxy -e no_proxy \
  -e GIT_SSH_COMMAND="ssh -i /data/ssh/id_ed25519 -o IdentitiesOnly=yes \
      -o UserKnownHostsFile=/data/ssh/known_hosts -o StrictHostKeyChecking=accept-new" \
  catman-env:1 \
  sh -c 'mkdir -p /data/src && git clone -b <分支> git@github.com:<你>/catman.git /data/src/catman \
         && chown -R 10001:10001 /data/src'

# ② init + bless。要 root(得 chown 给 10001/10002),要 docker.sock(要起制备容器)。
#    CATMAN_DATA_DIR 是容器内的路径,CATMAN_HOST_DATA_DIR 是宿主路径 —— 两者都要给:
#    前者是它自己要写的地方,后者是它转手传给下一层 `docker run -v` 的。
docker run --rm -u 0:0 \
  -v "$DATA:/data" -v /var/run/docker.sock:/var/run/docker.sock \
  -e HTTP_PROXY -e HTTPS_PROXY -e NO_PROXY -e http_proxy -e https_proxy -e no_proxy \
  -e "TZ=${TZ:-UTC}" -e "DOCKER_GID=$GID" \
  -e CATMAN_NPM_REGISTRY -e CATMAN_PREPARE_MEMORY -e CATMAN_TEST_FLAGS \
  -e CATMAN_DATA_DIR=/data -e "CATMAN_HOST_DATA_DIR=$DATA" \
  catman-env:1 \
  sh -c '/data/src/catman/scripts/evolve/init.sh && /data/src/catman/scripts/evolve/bless.sh'
```

制备那一步会打两行 `网络:…` 与 `资源:…` —— 卡住时先看它们:
`npm ci` 报 ENOTFOUND 而「代理=无」,说明上面那句 `set -a` 没生效;
测试汇总里出现 **cancelled**(不是 fail),八成是顶到了内存上限,调那两个旋钮。

制备失败后 `<sha>.tmp` 会留在原地(下次制备开头才清),所以**不必重跑整条流水线**,
直接在那棵已经装好依赖的树上复现:

```bash
docker run --rm -u 10002:10002 -v "$DATA:/data" \
  -w "/data/releases/$(ls -d $DATA/releases/*.tmp | head -1 | xargs basename)" \
  catman-env:1 npm test 2>&1 | tail -60
```

网络问题也可以单独探一次:

```bash
docker run --rm -e HTTP_PROXY -e HTTPS_PROXY -e http_proxy -e https_proxy catman-env:1 \
  sh -c 'echo "proxy=[${https_proxy:-未设}]";
         getent hosts registry.npmjs.org || echo "DNS 解析失败";
         curl -sS -o /dev/null -m 10 -w "registry HTTP %{http_code}\n" https://registry.npmjs.org/'
```

### 私有仓库:部署密钥放哪、怎么进容器

密钥**就放在数据卷里**,于是任何挂了 `/data` 的容器天然看得到,不需要额外挂载 ——
这也是唯一能同时喂给引导容器和将来 agent 的位置。

**两把,不是一把。** ssh 对私钥有属主检查(必须归**当前用户**或 root 且 0600,否则一律
拒用),所以一把钥匙只能服务一个 uid —— 这不是设计选择,是 ssh 的硬约束。而这里有两个
用得上钥匙的角色:

```bash
mkdir -p "$DATA/ssh/fetch"
chmod 700 "$DATA/ssh" "$DATA/ssh/fetch"

# ① 控制服务拉代码用的:GitHub 上建一个**只读** deploy key
cp ~/catman_readonly     "$DATA/ssh/fetch/id_ed25519"
chmod 600 "$DATA/ssh/fetch/id_ed25519"
chown -R 10001:10001 "$DATA/ssh/fetch"

# ② deployer 推远端用的:一个**可写** deploy key
cp ~/catman_readwrite    "$DATA/ssh/id_ed25519"
chmod 600 "$DATA/ssh/id_ed25519"
chown 10002:10002 "$DATA/ssh/id_ed25519"
```

**① 是主路径,别省。** 你在电脑上改完 push 到 GitHub,路由器上的 catman 得把它拉下来才
谈得上制备 —— 这个仓库的提交就是这么到那台机器上的。软路由宿主上连 git 都没有,所以
"你自己上机 pull"实际是"再起一个容器、以 root 跑、跑完还得把 `.git` 里新生成的 root
属主对象 chown 回去",那不是一条能长期走的路。

**② 只是让远端记录上线过的版本**,缺了不影响部署,只会在日志里留一行「跳过」。
推的**永远是主线**(`main`,可用 `CATMAN_UPSTREAM_BRANCH` 改),不是制备时所在的分支 ——
自我进化的常规流程会开一个 `evolve/xxx` 临时分支,推它等于让远端堆一排临时分支而
主线长期停在很早以前(真机上攒出过 5 个提交的差距)。推成功之后那个本地临时分支
也会被删掉,前提是它的内容确实都在这次上线的提交里。绝不 `--force`:快进不了
(有人在 GitHub 上也提交了)就如实报失败,由人来合。

**推远端不碰源码仓库,所以下次开分支的 base 天生陈旧。** 推的是
`<sha>:refs/heads/main` 这个 refspec、从 release 目录推、目标写的是 URL ——
三样加起来意味着 `$SRC_DIR` 里的本地 `main` 和 `origin/main` **一个都不会动**。
于是下次 `git checkout main -b evolve/xxx` 切出来的 base 是上上个版本,
**分叉是默认结果而不是失误**,除非开工时先 `git pull --ff-only` 一次。

**所以 catman 启动时会自己把主线拨上去。** 它每次部署后都要重启,那一刻正好既知道
自己跑的是哪个 sha、又拥有那个仓库 —— 于是把本地 `main` 快进到线上版本,并顺手删掉
内容已经全进去的 `evolve/*` 分支(`src/core/src-repo-sync.ts`)。

这件事**不能**交给 deployer 顺手做:源码仓库属 uid 10001,deployer 跑在 10002 下,
`.git` 及其子目录对它全部不可写(实测)。硬给权限的话 `.git` 里会开始出现 10002
属主的对象,而那些 catman 自己就改不动了 —— 换来一个更难查的问题。

`lib.sh` 里从前有个 `drop_prepared_branch` 干这件事,那句 `git branch -D` 因为同一道
权限墙**从来没成功过**,只是被"没删掉,留着不影响什么"那条分支吞掉了 —— 残留的
`evolve/*` 正是"上次没合并"这个错觉的另一半来源。它有四条单测钉着而且全绿:测试跑在
同一个 uid 下,摸不到生产里那道墙。那段死代码已经删掉,换成一条**动词白名单**单测,
钉住"`lib.sh` 对 `$SRC_DIR` 只能只读"这条在生产里真正成立的性质。

拨动只快进、绝不 reset:本地 `main` 上有还没上线的提交时原样留着并说一句 —— 那就是
分叉,由下面那道闸接手。也**不碰 `origin/*`**:推远端发生在观察期之后,而启动这一刻
远端多半还没被推,拨它等于替一件还没发生的事作证。远端那半边交给 `git pull --ff-only`。

分叉的代价不是"推不上去"那么轻:release 是按 sha 完整签出的树,上线一个分叉的提交
等于把线上已有的改动**静默撤销**掉,而推远端被拒是这件事唯一的报警器 —— 它响在
部署的最后一步,那时新版本已经上线并过完观察期了。所以制备加了一道**分叉闸**
(`diverge_check`,与磁盘门一样在跑容器之前):要制备的提交不是线上版本的后代就拒绝,
并逐条列出会被撤销的提交。确实想撤销就 `CATMAN_ALLOW_DIVERGE=1` 重跑一次。
判不了的情况(首次制备、基线不在这个仓库里)一律放行 —— 信息不足时不制造假警报。

这样分之后,「助手改不了远端历史」这道闸从**文件属主**上移到了 **GitHub 侧的只读
deploy key** —— 而后者更强:属主挡不住一个挂了 docker.sock 的助手,只读密钥挡得住。

只做一把也能跑:放 `$DATA/ssh/id_ed25519` 并 `chown 10001`,`init.sh` 会认出它是给助手用的
(pull 通、push 跳过)。`init.sh` 跑完会打一段诊断,把两个槽位各自的状态和属主说清楚。

拉取密钥的路径写进**仓库配置**(`core.sshCommand`,由 `init.sh` 设)。
密钥路径适用于控制服务，普通 worker 不挂载部署密钥。需要拉取时先获得含 Docker socket 的运维授权，
运行 `catman-ops connect` 并执行系统清单中的“自进化源码拉取”命令；系统按当前部署生成控制服务容器名、
源码路径和 owner UID，由控制服务使用只读 SSH 密钥 fetch。随后在 worker 的 `/catman-src` 检查并
用 `git merge --ff-only '@{u}'` 快进合并。保留 SSH origin，发布后的 push 仍由 deployer 使用可写密钥。
也可以用 `CATMAN_GIT_FETCH_KEY` / `CATMAN_GIT_SSH_KEY`
把两个槽位分别指到别处。

> SSH 端口 22 被挡时，可在控制服务的 SSH 配置中使用 `ssh.github.com:443`，保留主机公钥校验。
> 含 Docker socket 的运维授权等同宿主 root，必须由用户硬指令授予；两把部署密钥用于区分拉取与发布职责。

> **架构不必再操心**:依赖是在**目标机器上**用 `catman-env` 装的(见 `scripts/evolve/prepare.sh`),
> 天然就是对的架构。以前那套 buildx + QEMU 多架构构建随源码直跑一起消失了 ——
> 唯一要在目标架构下构建的是基底镜像本身,而它不含 npm 依赖,`docker build` 就地跑即可。

### 日常升级

公共网页抓取 skill 的维护版本在 `skills/webgrab/`。管理员更新前备份数据目录中的
`claude/skills/webgrab/`，再复制这些非凭据文件；启动过程不会覆盖管理员安装的 skill。
凭据只保存在 owner 的 `/user`，不要随 skill 分发。新建 worker 会装配最新副本；
运行中的 worker 保持创建时的只读快照。

```bash
git -C data/src/catman pull            # 或让 agent 自己在 evolve/* 分支上改

# 制备:装依赖 → typecheck + 全量测试 → 编译 → 版本戳 + 内容清单,产出一个 release
# 跑的是 **bless 固化的那份** —— 制备门就在这个脚本里,理由见「自进化」
docker exec catman /data/deploy/bin/prepare.sh HEAD

# 部署:排水 → 自检 → 切换 → 健康门 → 30 分钟观察期,不通过自动回滚
data/deploy/bin/deployer-run.sh deploy <上一步输出的 sha>

# 观察期可以调短(它是 `docker run -d`,命令本身立刻返回,不占着你的终端)。
# 演练或迁移时人就在旁边看着,两分钟够用:
CATMAN_BAKE_SECONDS=120 data/deploy/bin/deployer-run.sh deploy <sha>
```

⚠️ **日常别调短观察期。** 它是这套流水线里**真正的门** —— 启动能过不代表真实负载能过,
最常见的失败恰恰是"起来了,第一个真实回合把它打崩"。调到两分钟等于把判据退化成
"起来了就算过"。观察期内 `current ≠ stable`,所以那段时间的任何崩溃(含断电重启)
都会自然落回 stable;缩短它就是缩短这层保护。

`deployer-run.sh` 起的是一个**独立的一次性容器**(它要停掉 catman 自己,跑在 catman 里
会连自己一起被杀)。跑起来就返回,进度看 `docker logs -f catman-deployer`。过程中的三个节点
(切换成功 / 观察期通过转稳定 / 推远端)与最终结论都由 catman **主动发给发起人**,
不用等你先开口 —— 发不出去时(上下文失效或预算耗尽)才退回"下次开口时补上"。

出事时随时可以手动退回:

```bash
data/deploy/bin/deployer-run.sh rollback
docker logs catman-deployer            # 看这次到底发生了什么
```

在微信里(管理员)则是 `/回滚` 与 `/升级状态`,不必开电脑。

## 多人接入

在 dashboard 的**「账号」页**先填一个**备注名**(如「老王的微信」),再点「生成二维码」,
让要接入的人用微信扫码确认。登录成功后连接会立刻建立,**不需要重启**。每接入一个人重复一次。

备注名在扫码**之前**填是有原因的:多个账号的二维码长得一模一样,扫完再回头认"刚才那个是谁"
最容易配错人。留空则用「微信账号 `<id>`」,事后在账号页随时可改(清空即恢复默认名)。

**每个账号只服务一个人。** 绑定采用 TOFU(trust on first use):账号建立后收到的**第一条消息**,
其发送者成为该账号的主人;之后其他人的来信一律拒绝并记录在账号页上。账号页会显示
「已绑定 `<标识>`」供你核对 —— 如果绑错了人,点「解除绑定」后下一条来信会重新绑定。

### 每个人自己的存储

个人 home 是 `/data/tenants/<tenantId>/home`，在本人的 worker 中挂成 `/user`。聊天 session 与 cron 各自有独立 workspace，不挂整个租户根目录。
默认把临时执行内容写当前 cwd。跨上下文共用的配置、脚本和保留的输出放 /user/projects/<项目>，目录结构按项目需要组织；个人 skill 放 /user/skills/<目录>/SKILL.md，个人偏好放 /user/CLAUDE.md，个人 MCP 配置放 /user/mcp.json。
worker 不能访问其他用户、控制配置或 Docker socket。普通用户管理自己的配置和任务，管理员通过受控接口管理全局能力与自进化。

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
| 工作目录(cwd) | `/data/tenants/<tenantId>/contexts/<contextId>/work`，每个聊天/cron 独立 |
| 个人偏好 | 本人 home 的 `CLAUDE.md`，worker 内为 `/user/CLAUDE.md` |
| 运行配置 | `prefs.json` 里各自一份(模型、回执、进度、超时、分段长度) |
| 共享人设 | `/data/shared/CLAUDE.md`，控制面合并个人指令后生成只读投影 |

新人的**第一条消息**会先收到一份使用指引(硬指令清单 + 能自助改哪些配置),然后才是对
他那条消息的回答。指引只推一次;推送失败会留到下次重试。

> 公共 skill 由控制面投影到各 worker；个人 skill 放 `/user/skills`。SDK 配置按 context
> 隔离，共享指令由控制面合并，不依赖 `@` import。公共模型、MCP 和服务凭据由可信
> broker 保管，不能通过共享 SDK settings 将控制面的凭据复制给 worker。

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

执行环境还支持 `/延长 <contextId> [分钟]` 和 `/回收 <contextId>`，两者直接由控制服务处理，不经过 LLM。

以 `/` 开头、且整条消息只有指令本身的,由后台直接响应,**不经过 LLM**:

| 指令 | 别名 | 作用 |
|---|---|---|
| `/帮助` | `/help` `/幫助` | 看使用指引 |
| `/状态` | `/status` `/狀態` | 看**当前有没有在处理**、模型、会话空闲时长、各项生效配置(不花额度) |
| `/nop` | `/noop` | 什么也不做 —— 但这条消息本身会把微信那边的发送额度续上(见[发送预算](#一个-context_token-的发送预算)) |
| `/模型 <模型名>` | `/model` | 看或切模型:只发指令本身列出可选项与当前值;带模型名就切,**下一轮生效**;`/模型 默认` 清掉自己的设置。不进 LLM、不花额度,助手卡住时照样管用 —— 换模型最需要的时刻正是当前这个不行了 |
| `/思考 <档位>` | `/effort` `/思考强度` | 看或切思考强度:`low` / `medium` / `high` / `xhigh` / `max`,也可写 低 / 中 / 高 / 极高 / 最大。同样下一轮生效 |
| `/新会话` | `/new` `/clear` `/新會話` | 丢掉当前上下文重新开始 |
| `/取消` | `/cancel` `/stop` | 中断正在进行的这一轮 |
| `/继续` | `/continue` `/繼續` | 续上刚才的对话,之后直接发消息就是接着聊 |
| `/切换会话 <会话id>` | `/switch` `/切換會話` | 切回指定的旧对话,id 给开头几位即可;只发指令本身则列出最近的对话 |

下面三条**只有管理员能用,也只对管理员显示**(见 [自进化](#自进化)):

| 指令 | 别名 | 作用 |
|---|---|---|
| `/发布 <版本号前6位>` | `/publish` `/發布` | 把制备好的那个版本部署上线;那串 sha 就是确认口令本身 |
| `/升级状态` | `/version` `/升級狀態` | 当前版本、上次部署的结果、待发布的候选、可回退的版本(不花额度) |
| `/回滚` | `/rollback` `/回退` | 退回上一个已验证版本 |

它们的影响是**全局**的 —— 一次部署或回滚把所有用户都换到另一个版本,所以必须有这道闸。
非管理员发这三条会被当成普通消息交给 LLM,既用不了、也看不出它们存在。

**为什么要有这层。** 上下文撑爆把助手卡住时,普通消息不是排在那个卡死的回合后面,
就是被追加进它 —— 两种下场一样:那个回合不动,它们就永远等不到答复,包括本该救命的那条。
硬指令一概不进 LLM、由后台直接答,所以助手卡成什么样它们都管用,也不花额度。

分两类:`/帮助` `/状态` `/nop` `/取消` 是**就地执行**,连攒消息的那 1.5 秒都不等 ——
救命的指令等不起。`/新会话` `/继续` `/切换会话` 改的是会话状态,得和你同一批发出的话
保持先后(见下一段),所以排在处理队列里;但那个队列**不等回合跑完**,
所以卡死的助手同样堵不住它们。

**一批消息按你发出的顺序处理。** 连着发「这句话」→「/切换会话 abc」→「那句话」,
第一句落在原来那段对话,第二句落在 abc —— 指令在中间把这一批切开了,
不需要你分几次发。指令要是失败了(比如 abc 找不到),它**后面**那些话不会被处理:
那些话是冲着 abc 说的,落在别的对话里既答非所问又白花额度,前面已经处理的不受影响。

**`/状态` 第一行回答「它到底有没有在干活」。** 助手久久不回话时,三种情况的处置完全不同,
所以分开说:

```
📋 当前状态
当前:处理中,已 3 分钟 · 第 12 步(48 秒前) · 🔧 Bash: npm test     ← 在跑,卡在这一步上
当前:排队中,已等 20 秒(并发上限满了,前面还有别的回合)              ← 等别人,/取消 自己这条没用
当前:空闲,没有正在处理的消息                                      ← 消息压根没被受理,重发
```

「已 X」是这一条从被受理算起等了多久,「(Y 前)」是距上一次有动静过了多久 ——
前者一直涨而后者不涨,就是卡在那一步上了。这一行不受进度推送开关影响:
关掉进度只是不主动推消息,`/状态` 照样答得出。往这一轮里补过话的话还会多一句
「期间补充 N 条」—— 补进去的消息在别处看不见,这是确认"我刚那句赶上了没"的唯一出口。

**切走对话不等于停掉它。** 助手正在跑的时候 `/新会话` 或 `/切换会话`,那一轮**不会被打断** ——
它转到后台接着跑,跑完把结果发给你,开头标着「【后台对话 xxx 的结果】」和怎么切回去。
期间你可以正常聊别的,后台那段不再推进度(免得两段对话的消息混在一起),
`/状态` 里能看到它还在跑。想真的停掉它,`/取消` 只管前台这一轮 ——
先 `/切换会话` 切回去再 `/取消`。

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
| 模型 | 全局白名单里的别名,默认 `opus` / `sonnet` / `haiku` / `fable`。别名跟着家族走最新版,要钉版本写 `opus-4-5` 这种前缀或完整 id |
| 思考强度 | `low` / `medium` / `high` / `xhigh` / `max`,不设就由 SDK 按模型默认(目前 high)。没有白名单:五档对任何模型都合法,不支持的档位 SDK 自己降级 |
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

### 公共与个人 skill、MCP

公共 skill 在控制面的 `$CLAUDE_CONFIG_DIR/skills/<目录>/SKILL.md`，按角色只读投影。个人 skill 放 `/user/skills/<目录>/SKILL.md`，系统生成的 catman skill 名称保留。
个人 `/user/mcp.json` 是服务器名到 SDK MCP 配置的映射，支持 stdio/HTTP。公共 MCP 使用已部署的 HTTP 服务，由管理员通过 `GET/PUT /api/execution/shared` 配置：

```json
{"mcp":{"search":{"url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer ..."}}},"services":{"weather":{"url":"https://api.example.com/weather","headers":{"X-API-Key":"..."},"methods":["GET"]}}}
```

请求头用 `X-Catman-Session: $CATMAN_SESSION_TOKEN`，服务端现查管理员身份。读取配置只返回 header 名称，不返回凭据。公共原始密钥不进入 worker 文件或环境变量。
worker 公共 MCP 名称带 public_ 前缀，个人 MCP 带 user_ 前缀。HTTP 服务通过 `$CATMAN_API_BASE/api/runtime/services/<名字>` 和 `X-Catman-Runtime: $CATMAN_RUNTIME_TOKEN` 调用。
授权公共服务表示可以使用它的共享权限；需要隔离数据的上游仍须实现租户鉴权。

指令和公共 skill 是环境创建时的快照；新增配置在下一次 CLI/环境启动时装配。公共端点配置即时生效，新增 MCP 连接在下一次 CLI 启动时生效。个人文件不会在程序启动时被覆盖。

## 定时任务

`/api/me/cron` 根据调用身份管理本用户任务。脚本与 agent 使用统一的 owner 执行环境，每个 cron 有自己的持久 workspace。脚本 task 只接受 `kind`、`cmd`、`env`，不接受宿主路径、镜像、网络和资源参数。

```json
{"name":"每日检查","schedule":{"kind":"cron","expr":"0 8 * * *"},"task":{"kind":"script","cmd":["bash","-lc","./check.sh"]},"timeoutMinutes":10}
```

agent task 使用 `{"kind":"agent","prompt":"检查状态","session":"chain","maxTurns":10}`。
`chain` 续此任务的 SDK 会话；`fresh` 创建新的 SDK 会话，但保留同一 cron workspace。
任务的后台工作也计入 overlap 判断。删除任务先停止其上下文，再删除该任务的文件。每次执行有硬超时；产出的后台任务另外登记自己的有限期限。
调度状态、执行记录和通知仍由控制面保存，worker 不能直接改写别人的任务表。
脚本 cron 的入口任务由控制面在启动前登记通知归属，结果统一由 CronScheduler 按成功/失败、静默时段等配置投递，不额外发送通用后台完成通知。该 cron 内另行登记的后台任务仍独立报告完成、失败和超时。

公众号日报的按文章分目录取材、预览和素材归档脚本见 [`scripts/wechat-daily/`](scripts/wechat-daily/README.md)。它们安装到任务自己的持久 workspace；仓库发版不会覆盖用户的任务脚本和提示词。

管理员页面 `/cron` 查看各用户任务，`/任务` 显示本人任务。调度频率、并发、历史保留和静默时段仍由全局设置与任务定义控制。

## 后台任务与闲置回收

```bash
catman-task run --timeout 3600 -n 下载资料 -- curl -o archive.zip https://example.com/archive.zip
catman-task list
catman-task stop <taskId>
catman-notify send "资料已准备好"
```

`catman-notify` 与 `catman-task` 使用同一任务客户端。后台任务在原容器中执行，保留调用 cwd、允许继承的环境和同一挂载视图。必须指定 `--timeout`（秒），范围 1–86400；到期先终止进程组，再强制杀死。未登记进程最终由容器回收清理。
任务完成和超时事件先保存，再通知；通知失败会重试。下一次 agent 回合会收到尚未消费的任务结果。通知本身不保证自动启动新一轮推理。

SDK 自己的后台工作通过任务快照/完成事件追踪。前台返回 result 不关闭仍有原生后台任务的 CLI，新用户消息复用同一输入流。完全没有活动进程的环境在短暂空闲后自动释放，避免空容器占满环境配额。SDK 结果按用户消息 UUID 关联，后台完成不能冒充用户回复。无 SDK 工作时 CLI 可退出，已登记的独立后台任务继续运行。

`CATMAN_RUNTIME_IDLE_MS` 默认一小时，表示没有用户交互或助手响应的执行环境回收期限。已登记、未到期的有限任务保留其期限；SDK 进度、健康检查和进程日志不刷新闲置计时。
截止前十分钟通知用户，附进程名称、SDK 任务和以下操作：

- `/延长 <contextId> [分钟]`：延长闲置期限，1–240 分钟，默认 30 分钟。
- `/回收 <contextId>`：立即回收该运行环境。

操作由控制服务处理，不经过 LLM。新的实际交互撤销旧倒计时；延长不自动修改已登记任务的硬超时。没有操作则按时销毁容器，留下回收原因并通知，保留 workspace 和会话记录。
聊天路由超时、执行环境闲置期限、后台任务硬超时和数据保留期是四个独立参数。聊天上下文超过保留期且没有活跃环境时，才清理 workspace 与 SDK 文件。

容器确认移除后，立即清理该实例的指令/skill 投影及 wrapper；用户 home、workspace、任务日志与 SDK 记录不在此清理范围。启动后及每五分钟对账历史孤儿，保护当前创建中的上下文和 Docker 中仍挂载投影的容器。Docker 状态无法确认时暂缓清理。
同一上下文的创建、重建和回收串行执行；巡检跳过这些操作，并在异步检查后核对是否仍为同一个实例，防止启动途中误判容器不存在、删除待挂载的目录。

## Docker 控制权限

Docker socket 默认仅挂载给可信的主人格、守护人格控制服务和部署执行器。管理员显式授权的临时运维容器可按部署配置获得此挂载；普通 worker 始终不继承。其宿主 GID 仍由 Compose 的 `DOCKER_GID` 配置。
worker 固定非 root、丢弃 capabilities、禁止提权、根文件系统只读，并限制内存、CPU、PID、日志和 `/tmp` 大小。worker 不继承 Docker socket 或控制进程附加组。
宿主 bind mount 的源路径由控制面从已登记上下文计算，使用 `--mount`，不存在就失败；普通用户接口不接受宿主路径。
管理员源码挂在 `/catman-src`，制备通过 `POST /api/execution/prepare` 请求固定脚本。守护人格的诊断和恢复通过 `/api/execution/diagnostics`、`/api/execution/recover` 执行有限操作。

### 临时运维容器

管理员 agent 用 `catman-ops request <用途>` 申请，系统向用户展示部署指定的挂载、读写模式、Docker 权限和所属会话。用户发送完整的 `/授权 <申请ID>` 才会创建独立 SSH 容器。挂载清单不接受 agent 参数，不由 LLM 解释授权；`/运维` 查看清单，`/运维回收 <环境ID>` 手动回收。

部署先构建工具镜像（业务 release 升级不会自动构建此镜像）：

```bash
docker build --build-arg CATMAN_BASE_IMAGE=catman-env:1 \
  -t catman-ops:1 -f docker/Dockerfile.ops .
```

在部署 `.env` 设置，定制 Compose 需要显式把这些环境变量传给主控制服务：

```dotenv
CATMAN_OPS_ENABLED=true
CATMAN_OPS_IMAGE=catman-ops:1
CATMAN_OPS_MOUNTS=["/opt/services","/mnt/usb"]
CATMAN_OPS_DOCKER_SOCKET=true
CATMAN_OPS_MEMORY=512m
CATMAN_OPS_MAX_ACTIVE=1
```

默认关闭，Docker socket 默认不挂载。`CATMAN_OPS_MOUNTS` 是 JSON 数组；字符串按宿主原路径可写挂载，也支持 `{"source":"/host/config","target":"/config","readOnly":true}`。源路径属于 Docker daemon 宿主，不要求控制服务能访问；不存在则授权启动失败，不自动创建空目录。目标不能覆盖系统目录、与其他目标嵌套或覆盖当前 workspace。软链接目标只有在额外挂载覆盖它时才可访问；`/opt/services` 与 `/mnt/usb` 同时挂载可覆盖常见的外置存储链接。

内置 [`catman-ops` skill](skills/catman-ops/SKILL.md) 的正文在仓库中维护，SSH 封装实现在 [`ops-cli.ts`](src/core/execution/ops-cli.ts)。它们随 Git 版本和 release 一起发布；启动时从当前 release 安装手册到运行时 skill 目录，不要直接维护数据目录中的副本。Skill 只提供给主人格管理员，说明申请时机、等待用户硬指令、资源使用、连接方式与回收。授权成功后，系统直接回复容器镜像、实际目录映射及读写模式、Docker socket、共享 workspace、SSH 使用方式与回收规则，并把同一份清单送入原 agent 会话继续任务。运行 `catman-ops connect` 会将本次授权专属的 SSH 私钥、固定主机公钥与配置写入该 worker 的 `/tmp`，输出清单、封装工具用法、`ssh -F ... catman-ops` 登录命令和 `scp` 示例。私钥不进入工具输出、共享 credential、skill 或 workspace。

自动操作用封装工具，不需要手写嵌套 SSH 命令：

```bash
catman-ops exec -- docker ps --format '{{.Names}} {{.Status}}'
catman-ops run inspect.sh /opt/services
catman-ops run - /opt/services <<'SCRIPT'
set -euo pipefail
find "$1" -maxdepth 2 -name '*compose*' -print
SCRIPT
```

`exec` 保留程序参数，不解释管道或重定向；多行 shell 逻辑用 `run` 传本地脚本或 stdin。工具每次核对本会话授权，固定 SSH 主机校验，保留标准输入输出和远端退出码，不自动重试命令；执行完清理本次临时连接材料。脚本与结果可放共享 workspace，无需在两个容器间复制。

主 worker 不重建。两边共享原路径的 workspace；普通 Bash 仍在 worker，宿主运维显式通过 SSH 执行。运维容器以 root 运行，具备稳定工具镜像中的常用排查工具与 Docker CLI/Compose；SSH 只允许本次公钥，禁止密码和转发，仅监听专用内部网络地址，不发布宿主端口。额外连接 `bridge` 供运维访问外网，主 worker 的原默认路由不变。

**不设运维独立时限，也没有续期。运维授权绑定原会话容器实例，同生共死。** 控制服务正常重启后，原父容器仍存在且运维配置不变则保留授权；原父容器回收、异常退出或重建，运维容器、SSH 连接及其进程一起回收，新父容器需要重新申请。待授权/已授权运维环境阻止 worker 的“无进程快速回收”；原会话的闲置预告、延长与最终回收规则继续有效。外部删除父容器、撤销管理员身份或修改/关闭部署运维配置时，巡检清理依附环境。普通用户和 cron 不能申请或继承授权。

启用运维授权机制后，agent 调用自进化 `POST /api/execution/prepare` 也要求当前会话已获含 Docker socket 的授权，因为制备会执行 agent 可修改的仓库脚本。定时 agent 不自动继承此权限。用户持有的独立 Dashboard 凭据仍可直接发起制备；发布保持 `/发布` 硬指令确认。

完整 Docker socket 相当于宿主机 root 授权；可写的大目录也可能包含其他用户数据和部署凭据。回收只终止系统管理的运维容器，不自动恢复宿主修改，也不会销毁 agent 通过宿主 Docker 另外部署的服务。控制面及固化部署机制仍是可信边界，自进化代码不能被当成安全沙箱。Dashboard 聊天和含登录凭据的页面只接受独立 Dashboard 用户认证，管理员 agent 的运行/回合令牌不能注入用户硬指令或领取 Dashboard 登录凭据。

新 CLI 与指令投影在新建 worker 时提供；升级后使用新会话容器验证。真实回归需要同时准备 `catman-env:integration` 与 `catman-ops:integration`（或用 `CATMAN_DOCKER_IMAGE`、`CATMAN_OPS_TEST_IMAGE` 指定镜像）。

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

**这个 10 复测过。** 2026-08-12 把 `SEND_BUDGET` 放宽到 20 试了一次,当天就撞回来:

```
send #10(前 9 条成功) ctx龄=668571ms 53字  → ok
send #11(前 10 条成功) ctx龄=797522ms 41字 → 失败 ret=-2 prepare failed
send #12 … #15                             → 全部失败
```

两次记录都停在**恰好 10 条成功**,与 token 年龄无关(这次的 token 13 分钟,另一次 4 分钟,
都是 10)。那次实验的代价是真的:失败的第 14 条是一整段 1175 字的汇报,用户没收到 ——
这正是下一节那个发件队列要接住的东西。

这条预算怎么花:

| 用途 | 条数 |
|---|---|
| 回执、进度、正文、空闲提醒、部署播报、兜底说明 | 共 9 格,**先到先得,不分类别** |
| 「回信额度已用完,发 /nop 补充额度」 | 预留 1 —— **整份预算里唯一的保留格**,每份 token 只说一次 |

**规则只有这一条,没有例外。** 从前是一张按类别的表:回执 1、进度上限 6、正文与两句
交代各留 1。保留靠"进度的上限"实现,而"最后一格留给交代"这条规矩只拦正文那一类 ——
于是没列进表的类别都是例外。2026-09-07 就这么撞上了:正文发完还剩 1 格,会话空闲提醒
不问保留额把它拿走;早上定时日报来时额度为 0,内容进了队列,那句"发 /nop"却一格都申请
不到,用户静默了 6 小时,而且日志里一行都没有。规则挂在类别上就会有例外;挂在预算本身上
就没有 —— 所以现在保留格只认那条提示自己的 kind(`budget`),其余一视同仁。

进度也没有单独的上限了。它曾经被封在 6 条以便正文当场发得出去;现在有进度就发,
没额度就续 —— 代价是超过七八分钟的长回合,答案必然进队列,要发一句 `/nop` 才收得到。

**这笔账只有一本,而且整个在渠道那一侧**(`src/courier/`)。助手的核心一条也不记 ——
它只管把消息交出去,发得出去信使就发,发不出去信使排队。曾经两处各记一份,必然对不上
(真出现过 7 对 6),症状很隐蔽:不是超发(信使会拒),是每个长回合都多发一条注定被拒的
进度,并且「进度就报到这儿」那句交代永远不会触发,用户看到的是进度毫无征兆地停住。

核心这边只剩**间隔阶梯**(5→15→30→60 秒),而它管的是观感 —— 多久说一次话,
不是还能说几句。额度用尽时由信使**单独发一条**「回信额度已用完,还有更多消息待发送。
发一句 `/nop` 补充额度,我接着发」,免得那段静默被当成卡死。

触发它的是**一条消息因额度被拒、进了队列**的那一刻 —— 不管那条是进度、正文还是播报,
也不等下次排空(排空要等下一条来信来催,而用户正是因为没收到提示才不知道该开口)。
因排序入队的不触发:队列非空时新消息排队尾,那时额度多半是满的,说"额度已用完"是假话。

那句提示有自己的 kind(`budget`),信使内部专用:保留格必须认得出"这条就是那句提示",
而认的唯一依据就是 kind。信使跑 pinned、版本比助手老,但这个 kind 只在信使内部产生与
消费、从不过 IPC —— 认得它的信使一定也带着用它的代码;助手发来的 `budget` 一律被拒。

上表算的是**一份** token 的账。往正在跑的那一轮里补话时(见"说到一半可以补话"),
这条新消息本身就带来一个新的 `context_token`,预算跟着重来 —— 所以进度的条数与
间隔阶梯也在那一刻一并重置,不是"一个回合总共只能报这么多"。

`/nop` 就是把这件事显式给用户用:它什么也不做、不进 LLM、不花额度,唯一的作用来自
**这条消息存在**。回合跑到一半也能发 —— 它是 immediate 指令,不排队。网关收到它时
只做一件事:把节流器重新开闸。

**它一个字都不回。** 从前它要回一句"额度续上了",理由是网关手上的余量靠发送响应
带回来、不发就停在 0;那份缓存后来跟着 `progressBudget` 一起删干净了(见上一节),
理由随之失效。剩下的只有代价:那句客套要从它刚续回来的 10 条里花掉一条,挤掉的
恰好是用户发它想看的那条进度。于是现在发 `/nop` 的可见效果是零 —— 有在飞回合就是
进度接着来,有积压就是积压接着发,都闲着就真的什么也不发生。想确认还活着用 `/状态`。

## 发件队列:发不出去的不再丢掉

从前发送是**一次性**的:额度用尽时那条消息就没了,最坏的一种没了是**正文** ——
你等了几分钟的答案,只在日志里留下一行 `发正文失败`。保留额存在的全部理由就是给
这类"丢了就没有第二次"的消息占位子。

现在信使有一个发件队列(`src/courier/outbox.ts`):发不出去就排队,下一条来信带来新的
`context_token`(计数归零),自动接着发,直到排空。于是"丢了"这件事本身消失了。
队列**不管预算**,只问 `ReplyStore.begin()` 的结果 —— 发得出去就发,被拒就排队。

队列**不是 FIFO,是按类别定策略**:

| 类别 | 发不出去时 |
|---|---|
| 正文 / 部署播报 / 兜底说明 | 一条不丢,严格保序 |
| 进度 / 空闲提醒 | 只留最新一条 —— 它们描述的是当前状态,旧的在新的面前没有意义 |
| 收到回执 | 压根不排队 —— 排到它时答案多半已经发过了,再补一句只会让人以为又要重来一轮 |
| 额度提示 | 压根不排队 —— 它说的就是"现在发不出去",排队等发得出去再说是自相矛盾 |

两条额外的性质:

- **排空限速**(默认 1.5 秒一条)。一口气连发十几条容易被微信判成骚扰,也不是人说话的样子。
- **排空不留余地**:新 token 的 9 格全用来还旧账,发到见底为止;队列还没空就说一句
  「回信额度已用完,还有 N 条消息待发送。发一句 `/nop` 补充额度」,**每份 `context_token`
  只说一次**。这里报得出**准确条数**(排空时队列是稳定的);回合还在跑时那句不报数,
  因为后面还有几段正文要交进来,当场数出的"还有 1 条"下一秒就成了假话。
  从前停在"还剩 4 格"给你的新问题让路 —— 代价是旧消息与新消息乱序,而且 `/nop`
  本身不是新问题,专门为续额度发的那句话被回敬一句"还有 N 条"很怪。
- **落盘**。信使重启(bless、改配置)时积压里可能正躺着一条已经跑完却没送出去的答案。

那句提示由**信使**发,每份 `context_token` 只说一次,说过没有落盘 —— 信使重启后忘掉它,
要么重复说,要么以为说过了而不说。

**最后一格谁也不许动,只给那句提示。** 正文分段发到额度见底时,最后一格拿去说
「回信额度已用完,还有更多消息待发送」,而不是再多发一段正文。少一段看得出来,静默看
不出来:队列保证了消息不丢,但**没保证你知道有东西没发出去**,而你看到的只是话说到一半
就停了,与卡死无从分辨。这条规矩就是补那个洞的 —— 真机上因此静默过 14 分钟、2 小时
24 分和 6 小时,都是等用户自己开口才补发。

还有一条相关的:**答案一到,排在它前面的过期进度就作废清掉**。不清的话那条被拒的进度
会让队列一直非空,而队列非空时新消息一律排队尾 —— 于是答案再也走不了直发那条路,
明明还有额度却要等下一条来信。

排查时打开 `CATMAN_ILINK_TRACE=1`,每条发送会打一行:

```
08-01 18:32:15.123 [ilink:<账号>] send #3(前 2 条成功) ctx龄=50053ms 27字 → ok
```

三个量分别对应「第几次发送」「成功过几条」「拿到 token 到现在多久」——
失败行无条件打印(不受 TRACE 开关影响),因为回执与进度的失败在网关那层是被吞掉的。

所有日志都带 `MM-DD HH:mm:ss.SSS` 前缀。容器**不会**自动继承宿主时区,不设就是 UTC,
和微信里的消息时间对不上;在 `.env` 里设 `TZ=Asia/Shanghai` 之类即可。

## 看日志:助手到底在干什么

上一节讲的是**发送**这一侧(消息发没发出去)。这一节是**LLM** 那一侧:消息已经收到、
回合已经起来了,但迟迟没有回复 —— 到底是模型还在慢慢跑、卡在一次长命令里、
上游在重试、被限流了,还是已经报错而错误被当成正文发了出去?这几种在日志上
必须长得不一样。

`docker compose logs -f` 里,一个正常回合大致长这样:

```
[agent wechat:acct-a:u1] 回合开始 model=sonnet resume=1a2b3c4d 42字 图0
[agent wechat:acct-a:u1] init model=claude-sonnet-4-5 mode=bypassPermissions tools=18 skills=2 cwd=/data/workspace/...
[agent wechat:acct-a:u1] 进行中 已 30.0s · 第 4 步(12.3s 前) · 🔧 Bash: npm test
[agent wechat:acct-a:u1] 回合完成 47.2s(API 31.8s) 第9步 3轮 $0.0421 in=1.2k out=845 缓存读=38.1k
```

**这几类不需要任何开关,一律记录** —— 因为需要它们的时候通常是事后翻日志,
那时再去开开关重启已经晚了:

| 日志行 | 说明 |
|---|---|
| `回合开始` / `回合完成` / `回合失败` | 起止、墙钟与 API 耗时、轮数、花费、token |
| `进行中 已 X · 第 N 步(Y 前)` | 心跳,默认 30 秒一条。**X 一直涨而 Y 不涨 = 卡在那一步上** |
| `init …` | SDK 实际生效的 model / 权限模式 / 工具数 / skill 数 / cwd |
| `API 重试 第2/5次 4000ms 后重试 status=529` | 上游过载,SDK 在静默退避重试 —— "看起来卡死"的头号真因 |
| `限流 status=rejected 类型=five_hour 已用 100% 恢复于 …` | 订阅额度打满 |
| `上下文压缩(auto) 150.0k→42.0k tokens 耗时 31.0s` | 自动压缩,期间没有任何别的消息 |
| `stderr: …` | CLI 子进程的错误输出(鉴权失败、启动不了都在这里) |

心跳只进日志、**不发给用户** —— 用户侧的进度受 `context_token` 发送预算约束(见上一节),
日志没有这个约束。间隔用 `CATMAN_AGENT_HEARTBEAT_MS` 调,设 `0` 关掉。

要看得更细,打开 `CATMAN_AGENT_TRACE=1`,回合内每条 SDK 消息都会打一行:

```
[agent …] assistant thinking(214字) tool:Bash(npm test) stop=tool_use [in=12.3k out=678]
[agent …] user result(4213字)
```

**日志里不会出现会话正文**:思考与文本只出字数,工具结果只出长度与成败,
图片只出 base64 字符数。工具入参会出一段截断摘要(和推给用户的进度是同一句),
因为"在跑什么命令"正是要找的东西。这条约束有单测守着。

用户那边同样问得到:发 `/状态`,第一行就是"当前:处理中 / 排队中 / 空闲",
详见「硬指令」一节。

回合**出错**时用户不会被蒙在鼓里,两条路径都会说话:SDK 以错误结束(鉴权失败、额度打满、
达到轮数上限)时,错误原文照发,但前面加一句「⚠️ 这一轮没能跑成,以下是 Claude 侧的报错原文」——
不加的话「Credit balance is too low」在微信里和助手说的话长得一模一样;回合中途抛异常
(含 `/取消`)则发一句「处理出错了:…」。**唯一发不出来的情况**是那条消息本身也发失败,
最常见的是 `context_token` 的发送预算已被耗光(见上一节)——那时日志里的 `回合失败` /
`回合中断` 是唯一线索。

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
npm ci
npm run typecheck
npm test
npm run build
```

生产入口强制使用 Docker worker。运行时需要稳定镜像、已构建的 release、正确的 CATMAN_HOST_DATA_DIR，以及 mynet 网络；不再支持让租户 agent 回落到本机执行。
无 Docker 环境可以运行测试：上下文/授权/回收测试使用可注入执行接口，任务管理器测试执行真实子进程，真实 CLI 测试使用本地假模型和临时目录，不调用付费模型服务。
有 Docker socket 时可运行真实容器集成测试：

```bash
docker build --pull -t catman-env:integration -f docker/Dockerfile .
npm run test:docker
```

集成测试使用独立临时数据、真实 worker/Claude CLI 和本地模型/MCP 服务，覆盖挂载与权限隔离、凭据代理、后台任务、取消、超时、cron 状态、重启认领和闲置回收；结束后清理测试容器与临时数据。指令加载检查覆盖主人格/守护人格 × 聊天/cron：直接检查 CLI 正式任务请求中的共享、个人和 workspace 三层标记，并拒绝其他用户、其他 workspace 和控制面标记，不依赖模型自述。可用 `CATMAN_DOCKER_IMAGE` 指定已有的基底镜像。在 devcontainer 内会自动从当前容器的挂载信息换算宿主路径；自动识别不了时，用 `CATMAN_DOCKER_HOST_ROOT` 指定仓库在 Docker 宿主上的绝对路径，必要时用 `CATMAN_DOCKER_CONTROLLER` 指定当前容器 ID。

迁移报告中的 targetContainerRoot 决定 SDK project 编码；已迁移到 /data 的数据应通过相同容器路径使用。原生开发调试使用独立测试数据，避免混入生产会话。

## 基底镜像

`catman-env` 是一层**不含应用代码**的运行环境:node 22 + git/ripgrep/curl + docker CLI +
两个用户(catman 10001 跑应用、deployer 10002 拥有 release 目录)。它极少变更 ——
改它属于要人工介入的那一类变更(见 [自进化](#自进化) 的 Tier 分级)。

```bash
docker build --pull -t catman-env:1 -f docker/Dockerfile .
```

**构建期连不上 `download.docker.com` 时**(它是整个构建里唯一容易够不着的地方),两条路:

```bash
# ① 走代理。大小写都要传 —— apt 的 http 方法只读小写、curl 只认大写 HTTPS_PROXY,
#    只给一种的症状是"GPG key 拉得下来、apt-get update 却连不上"。
#    ⚠️ 地址不能写 host.docker.internal:那个名字靠 compose 的 extra_hosts 在**运行时**
#    注入,构建期不存在。填代理机的内网 IP。
P=http://192.168.1.2:7890
docker build --pull -t catman-env:1 -f docker/Dockerfile \
  --build-arg HTTP_PROXY="$P"  --build-arg HTTPS_PROXY="$P" \
  --build-arg http_proxy="$P"  --build-arg https_proxy="$P" .

# ② 不配代理,换一个够得着的镜像源(布局都是 <base>/linux/debian)
docker build --pull -t catman-env:1 -f docker/Dockerfile \
  --build-arg DOCKER_APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/docker-ce .
```

**多架构不再是问题。** 以前 claude 二进制随镜像发货,而它来自 Agent SDK 的
optionalDependencies(`@anthropic-ai/claude-agent-sdk-<os>-<arch>[-musl]`),npm 按**执行安装
的那个容器**的架构挑包 —— 于是构建必须靠 buildx + QEMU 在目标架构下跑 `npm ci`,
且不能用 `--platform=$BUILDPLATFORM` 交叉编译提速(那会装成构建机的架构,构建期毫无征兆,
只在目标机起 agent 时才炸)。

源码直跑把 `npm ci` 挪到了**目标机器上的制备阶段**(`scripts/evolve/prepare.sh`),
依赖天然就是对的架构,整套多架构构建流程随之消失。基底镜像本身不含 npm 依赖,
在目标机上 `docker build` 就地构建即可;跨机器搬运时用 `docker save/load` 也行。

基底是浮动的 `node:22-bookworm-slim`(glibc),每次**重建镜像**时取 22.x 最新补丁;因此选中的是 glibc 变体,换 alpine 基底会切到
musl 变体,需要重新验证。

**浮动 tag 的补丁只在重建时生效。** 已经构建好的 `catman-env:1` 不会自己更新,
所以遇到 Node 安全公告(例如 2026-10 的 CVE-2026-111497 / Node2Shell)时,
真正的触发点是「重建镜像 + recreate 容器」。构建时**必须带 `--pull`** —— 不带的话
docker 会优先复用本地缓存的基底镜像,浮动 tag 等于没浮动。构建时会把实际版本写进
`/etc/catman-node-version`,构建日志里也会打印一次;重建后确认:

```bash
docker run --rm catman-env:1 cat /etc/catman-node-version
docker compose exec catman node -v
```

重建前先给旧镜像打一个带版本的 tag(如 `catman-env:1-node22.23.2`)留作回滚。

基底镜像不必经过 Docker Hub。已有兼容的 `catman-env:1` 时，业务升级只需在目标机
制备 release；只有基底工具或 Node 版本需要更新时才重建镜像。资源充足的目标机可以
直接构建；软路由上优先在构建机按目标架构构建，再用 `docker save` / `docker load`
传入，避免构建挤占在线服务。依赖仍须在目标架构的运行环境中安装。

验证依赖架构对不对(这条仍然要看):

```bash
docker compose exec catman node -p process.arch                          # → arm64 / x86_64
docker compose exec catman sh -c 'ls $(readlink -f /data/releases/current)/node_modules/@anthropic-ai/'
```

两者对不上就说明制备跑在了错误的架构下。

## 自进化

agent 内通过 /catman-src 和 /api/execution/prepare 请求制备；下面的固定脚本命令供管理员在宿主或可信控制服务中操作。worker 不直接运行部署器。

catman 可以自己改自己:管理员在微信里说一个改进想法,它改代码、跑测试、制备 release,
汇报之后由你确认,再由**独立的 deployer 容器**完成切换与回滚。

### 部署单元与指针

```
data/releases/
  <sha>/                 一个 release:浅 clone + 自带 node_modules + dist + VERSION + MANIFEST
  current -> <sha>       容器跑哪个(入口脚本解析它)
  stable  -> <sha>       出事退回哪个(**只在观察期通过后前移**)
  pinned  -> <sha>       给守护人格钉住的那个(Phase 3 用,现在占位)
  verified-history.json  已验证版本清单,新→旧;回滚沿它往回走
```

**升级不重建容器** —— 配置一个字没变,变的只是链接指向。所以 `docker-compose.yml` 平时
一动不动,部署流程也完全不碰 compose(它的文件优先级、override 自动合并、`${PWD}` 插值、
项目名不一致这些坑因此一个都碰不到)。

### 流水线

| 步骤 | 谁执行 | 做什么 |
|---|---|---|
| 编码 | agent | 在 `data/src/catman` 上开 `evolve/<slug>` 分支改代码、跑测试、提交 |
| 制备 | agent(`data/deploy/bin/prepare.sh`) | 浅 clone → 装依赖 → typecheck + 全量测试 → 编译 → 版本戳 + 内容清单 → 原子就位 |
| 汇报 | agent | 改动摘要 + 测试结果 + **变更分级** + 「回一句 `/发布 <前6位>`」 |
| 确认 | **管理员亲手打** | `/发布 <版本号前 6 位>` —— 那串 sha 就是确认口令本身 |
| 自检 | **deployer 亲自** | 起一次性容器跑 `CATMAN_SELFCHECK=1`：临时数据下的真实 CLI 指令加载检查（本地假模型、零模型费用），再跑一次真实的最小 SDK 请求；指令缺层、越界或检查超时阻止切换 |
| 切换 | deployer | 排水 → 停容器 → 换 current → 起容器 → 健康门(比对 `/health` 回报的 sha) |
| 观察 | deployer | 30 分钟盯重启次数与健康;**这期间 stable 不动** |
| 收尾 | deployer | 通过则前移 stable + 入清单 + GC + 推远端;不通过则退回并写报告 |

制备容器先获取全局 `flock` 锁，再清理历史 `<sha>.tmp` 并检查磁盘水位，避免并发构建互相删除。失败、正常退出或 TERM 会清理自己的临时目录；SIGKILL/OOM 残留由下次制备收拾。清理只修改目录权限，不修改与已验证 release 硬链接的依赖文件。

失败的最坏结果是"这次改进没上线",而不是"catman 下线了"。结果写进部署报告,
catman 起来后在你下一条消息时告诉你。

在微信里大致长这样:

```
你  :把使用指引开头那句改得短一点
它  :改好了 —— <摘要>。全量 554 条测试全绿。
      变更分级:Tier 1(常规改动,全流水线自动)。
      回一句「/发布 a1b2c3d」我就提交部署。
你  :/发布 a1b2c3d
它  :已提交部署 a1b2c3d(evolve/shorter-greeting)。
      接下来是自检 → 切换 → 30 分钟观察期,期间我会失联几分钟。
      (半小时后你再开口时)升级完成:a1b2c3d 已上线并通过 1800s 观察期。
```

`/升级状态` 随时能查当前版本、上次部署结果、**待发布的候选**(忘了那几位数字时看它)
和可回退的版本。这条指令不进 LLM、不花额度,回合卡死时照样答得出。

**观察期可以按次缩短**:`/发布 a1b2c3d 60` 就是"这次只观察 60 秒"。默认 1800 秒,
允许 30–3600。缩短是有代价的 —— 观察期正是自动回滚那张网:过了这段时间再崩就不会
自动退回,得自己发 `/回滚`,所以 catman 会在回话里把这句提醒带上。它**不是一个设置项**,
每次都要显式给,免得某天有人把它调短了就再也没调回来。

急着 bless 时它尤其有用:`stable` 只在观察期过完之后才前移,而 bless 默认钦定的
就是 `stable`。

### 变更分级(Tier)

制备完会打一段分级,agent 会转述给你。它**不拦任何事** —— Tier 3 的东西改了本就不会
自动生效,那才是机械闸;分级做的是**说出来**,免得你以为"部署成功 = 我要的都生效了"。

| 级别 | 范围 | 你还要做什么 |
|---|---|---|
| Tier 1 | `src/**`、`test/**`、文档 | 没有,全自动 |
| Tier 1★ | 门禁本体(`health.ts`、`selfcheck.ts`、`commands.ts`、部署相关模块与它们的 golden 测试) | 没有,但汇报会单独点名 —— 改坏它的后果是"门失效",而那看起来跟一切正常一样 |
| Tier 2 | `package.json` / lockfile | 没有,但制备会真跑 `npm ci`,明显更慢 |
| Tier 3 | `scripts/evolve/`、`docker/`、compose、`.env` | **要人**:重新 `bless` / 重建镜像 / recreate 容器 |

分类表住在 `data/deploy/bin/lib.sh`(固化侧)而不是 `src/` 里 —— 它要是住在被自我进化
改写的那棵树里,一行 case 就能把 Tier 3 报成 Tier 1。

### 重新 bless(改了 Tier 3 之后)

要 root —— `data/deploy/` 属 uid 10002,助手那个 uid(10001)写不进去,直接跑是
Permission denied。所以起一个一次性容器,与上面初次部署的 ② 同一个套路:

```sh
DATA=/opt/services/catman/data                 # ← 换成你的绝对路径
GID=$(stat -c '%g' /var/run/docker.sock)
PIN=$(basename "$(readlink -f "$DATA/releases/pinned")")   # ← 维持现状;要挪就填新 sha

docker run --rm -u 0:0 \
  -v "$DATA:/data" -v /var/run/docker.sock:/var/run/docker.sock \
  -e CATMAN_DATA_DIR=/data -e "CATMAN_HOST_DATA_DIR=$DATA" \
  -e "DOCKER_GID=$GID" -e "CATMAN_PIN=$PIN" \
  catman-env:1 /data/src/catman/scripts/evolve/bless.sh
```

在自己机器上把它包成一个小壳当然更省事,但**文档里不能只留壳名** —— 那个壳是某台
机器上的私有文件,换个部署就不存在了,而上面这段到哪儿都能跑。

三个点:

- **`CATMAN_PIN` 不要省。** 不给的话 `bless.sh` 默认钦定当前 `stable`,而 `pinned` 是
  信使与守护人格跑的那份:"出事时还活着的是哪份代码"不该被顺手改掉。上面那行 `PIN=`
  取的就是当前值(维持现状);真要往前挪再填新 sha。包壳的话把它做成**必填参数**,
  空值直接拒绝 —— 省一次手滑。
- **固化的是"你从哪个目录跑它"的那份**(`bless.sh` 里是 `install "$HERE"/...`)。
  上面这条命令跑的是 `/data/src/catman`,所以跑之前确认那儿工作区干净、且
  `scripts/evolve/` 与 `releases/current` 里那份逐字节一致(`cmp` 一遍)——
  否则固化进去的可能是一棵没人批准过的树,而固化的正是那道判卷子的门。
- 跑完验四样:四个脚本 `cmp` 得上、`data/deploy/env` 一个字没变、`pinned` 是你要的
  那个、`data/deploy/` 属主回到 10002。

### 几条不能改的纪律

- **执法者自己取证**:自检由 deployer 亲自跑,健康门比对的 sha 由它亲自读。
  agent 改坏了自检代码,只会让自己的版本过不了门,而不是让门失效。
- **stable 只在观察期后前移**:观察期内 `current ≠ stable`,任何崩溃(含断电重启)
  都自然落回 stable。反过来会让观察期变成纯仪式。
- **回滚是"先停、再换、后起"**:不先停就换链接的话,restart 策略会在中途把旧容器拉起来,
  crash-loop 的容器每次启动都可能再写一遍状态文件。
- **release 目录只读挂载给主容器**,属主是 uid 10002。助手跑在 bypassPermissions 下,
  一句"帮我清清磁盘"就足以让它把回滚目标删掉 —— 只读挂载让那种误删直接 EACCES 暴露。
- **部署机制不随自我进化更新**:`/回滚` 执行的是 `bless.sh` 固化到 `data/deploy/bin/` 的
  那份脚本。改了 `scripts/evolve/` 要重新 bless 才生效。门禁和逃生门是同一把锁,
  不能让一次改坏了部署逻辑的进化把它们一起毁掉。**`prepare.sh` 同属固化侧**:
  制备门(全量测试)就在它里面,跑 release 里那份等于让被考的人自己出卷子。
- **bless 要管理员开口**:固化会把 `scripts/evolve/` 的当前内容变成"以后真正执行的那份",
  包括那道判卷子的门自己。所以助手**不自动 bless** —— 制备完只汇报"这次是 Tier 3,
  还欠一次 bless",什么时候固化由你决定。你授权之后它可以代跑,但固化源必须是**你批准
  过的那棵树**(工作区干净,且与 `releases/current` 逐字节一致,跑之前 cmp 一遍)。
  少了这一条,「你批准了哪棵树」和「固化了哪棵树」就脱钩了,而脱钩的那一头正是门本身。
- **确认口令是硬指令**:`/发布 <前6位>` 由你亲手打、由网关按字面解析,是整条流水线里
  唯一一处把「你批准了什么」和「机器部署了什么」机械绑在一起的地方。交给助手转述的话,
  这把锁就挂在一个会看错字、而且正是被部署的那一方的环节上。网关也不替你补全或纠错 ——
  太短、找不到、有歧义、已经是当前版本,四种情况各回各的话。后面那个可选的观察期秒数
  **不碰口令那一半**:它单独解析、单独校验,版本号照旧原样交给同一套匹配。
- **数据向前兼容**:回滚只换代码,**不动 `data/`**。所以自动进化的改动必须能读现有格式,
  且旧版本要能读新版本写的 —— 做不到就属于要人工介入的变更。

### 相关指令(仅管理员可见可用)

- `/发布 <版本号前6位>` —— 把制备好的那个版本部署上线
- `/升级状态` —— 当前版本、上次部署结果、待发布的候选、可回退的版本
- `/回滚` —— 退回上一个已验证版本

非管理员发这几条会**按普通文本走 LLM**,既用不了也看不出它们存在 —— 回一句"你没权限"
本身就是在告诉他有这么个东西。

## 三个进程(Phase 3 起)

微信连接不再住在助手进程里。现在是三个容器,**同一个镜像、同一份 release**,
靠 `CATMAN_ROLE` 分开:

| 容器 | 跑哪份代码 | 干什么 |
|---|---|---|
| `catman-courier` | `releases/pinned`(人工钦定) | 全部微信连接、账号与凭据、收件队列、发送预算、路由 |
| `catman` | `releases/current`(每周自动进化) | 主人格:会话、agent、dashboard、自进化 |
| `catman-rescue` | `releases/pinned` | 守护人格:机械看门狗 + 无 LLM 状态页(:8788)+ 按需唤醒的救援大脑 |

**为什么值得多两个进程。** 以前主人格死了,微信就彻底聋了 —— 而立项动机恰恰是
"人不在电脑前也能救它"。现在连接归信使,两个人格都在它身后:主人格卡死时你发
`/救援` 就切到守护人格,它跑的是钉住的稳定版本,能看日志、能回退版本。
顺带还拿到三件事:部署窗口的消息不再丢(信使的队列跨重启存活)、会话超时提醒终于
有机会送达(回复上下文持久化了)、某条毒消息不会再把整个渠道钉死。

### 相关指令

- `/救援` —— 把自己切到守护人格(管理员)
- `/主人格` —— 切回来(管理员)。忘了也没关系,闲置几小时会自动切回**并告诉你**

### 信使自己起不来的时候

它跑 `releases/pinned`,而钦定 pinned 的依据是那份 release 当过 `stable` —— 但 30 分钟的
观察期**只跑主人格**,信使的代码路径(iLink 连接、账号、收件队列)一次都没被执行过。
所以一份"过了门"的 release 完全可能带着一个起不来的信使,而后果是微信整个聋掉,
连报警都发不出去。

守护人格的看门狗会自动把 `pinned` 退回 `pinned-prev`(由 `bless` 在钦定新 pinned 时存下),
但要同时满足三条:**有 pinned-prev 可退**、**这轮还没退过**、**主人格是好的**。
最后一条是关键——两个容器一起崩说明是环境问题(磁盘、内存、docker),换版本没用,
换完仍然崩却把稳定面悄悄挪走了,正在排查的人看到的代码就跟他以为的不是同一份。
任何一条不满足就只报警,并把原因写进部署报告。

它只动 `pinned`,`current` / `stable` / `pinned-prev` 一个都不碰;判据是"重启完连续
15 秒没再崩",**不是**主人格那道健康门(信使没有 HTTP 端点),报告里会如实这么写。

### 三条机械防线(不需要大脑就在跑)

磁盘满、OAuth token 过期、守护人格自己锈掉 —— 这三种死法的共同点是**大脑也一起废**,
所以对策全部下沉到机械层,状态页(:8789)上有红黄绿:

- **磁盘红色水位**(剩 <2GB):看门狗起固化的 deployer 清一次超保留期的 release。
  只清一次,清完还红说明占空间的不是旧 release,转为报警要人。
- **token 到期倒计时**:过期时刻从凭据文件读;`setup-token` 的 env 长效 token 没有
  这份信息,那时如实显示「未知」——绝不编。拿得到时,主人格会在 14/7/3/1 天与已过期
  这几个节点**各向管理员播一次**微信提醒(换发要人在宿主跑 `claude setup-token`)。
- **每周冷启动点火**:看门狗每 7 天起一次 deployer `drill`,从磁盘冷启动 pinned 跑
  自检、按契约探主人格 `/health`、验回滚机构(dry-run flip)。活进程握着已删 inode
  照常运行,只有冷启动才测得出磁盘上的真相 —— 那正是断电重启那天要走的路。
  结果在状态页上;**从没跑过也显红**,例行演练没在跑本身就是异常。

### 守护人格跟主人格哪里不一样

同一个入口、同一份代码,差别全在配置。跟人打交道时看得见的有四处:

| | 主人格 | 守护人格 |
|---|---|---|
| 自述 | "我是主人格,卡住了可以 `/救援`" | "我是守护人格,你刚发过 `/救援`" |
| skill | `catman-evolve`(改代码上线) | `catman-rescue`(诊断与退版本) |
| 数据 | `/data` | `/data/rescue`,**看不到主人格的会话** |
| 部署指令 | `/发布` `/回滚` | 没有 —— 它换版本走固化的 deployer |

自述走 SDK 的 `systemPrompt.append`(`src/core/persona.ts`),**不是** CLAUDE.md ——
那份住在数据卷里、用户能改能删,而"我是哪个人格"是装配事实。管理员名单则从主
`settings.json` 继承(守护人格的那份是空文件),否则切过去的人会被降级成普通用户,
而诊断与恢复恰好全是管理员的活;要显式指定用 `CATMAN_ADMIN_USER_KEYS`。

### 部署密钥之外还要配的两个 secret

人格与信使之间的 IPC 凭据,**两个人格各要一个**:

```bash
# .env
CATMAN_IPC_SECRET_PRIMARY=$(openssl rand -hex 24)
CATMAN_IPC_SECRET_RESCUE=$(openssl rand -hex 24)
```

共用一个的后果是两个人格的收件队列串到一起,而这件事**没有任何外部症状** ——
消息只是偶尔跑到另一个人格那儿去。所以信使发现它们相同时会**拒绝启动**。
只能用可打印 ASCII(它要进 HTTP 请求头,中文会让客户端在发出请求之前就抛错)。

> 助手的回合子进程**拿不到**这两个 secret(与管理员令牌同一条剔除规则,
> 但没有"admin 回合加回"那一档)。拿到它就等于拿到信使的整个控制面。

### 应急绑定口令(可选,但强烈建议)

准入出问题把你自己挡在门外时的逃生阀。安装时生成一次,**抄进手机备忘录**:

```bash
openssl rand -hex 8 | tee data/courier/bind-passphrase
chmod 600 data/courier/bind-passphrase
```

之后在微信里发 `/绑定 <口令>` 就能强制完成绑定。它**不需要**管理员权限——
要救的正是"被挡在门外因而不可能被认作管理员"那种处境。口令不对时它一个字都不回
(说"口令错了"等于把这条路的存在告诉任何人)。

## 安全说明

控制服务和固化部署执行器是可信边界，持有 Docker 和模型/公共服务凭据；普通 worker 通过限定身份调用它们。运行身份不接受调用方提供 userKey，权限由服务端当前设置决定。
worker 的挂载不能通过配置扩展到任意宿主路径。个人配置读取拒绝越出 home 的软链；目录与任务归属来自控制面注册表。管理员降权会回收其现有环境，防止旧源码挂载继续保留。
公共能力以服务端凭据代理调用；公共 MCP 应独立部署为 HTTP 服务。个人 stdio MCP 在 worker 内运行，只能获得该 worker 已有的权限。
请按全部控制服务、活跃 worker 和构建任务合计配置内存预算。数据、迁移备份与 shared-tools.json 都包含私有内容，不提交 Git。

## 数据格式与升级：执行上下文 v2

本次为显式、不兼容的数据布局升级。已有 users.json/state.json 而没有 `execution/schema.json` 时，启动会拒绝继续；不得通过删除状态绕过检查。

迁移由管理员 agent 执行一次，不维护自动迁移脚本。主人格与守护人格的数据根分别迁移；守护人格的 containerRoot 通常为 /data/rescue：

1. 停止主人格与守护人格的调度、消息接入及旧 worker，保存完整数据目录和旧私有目录备份，记录校验值。信使的账号凭据和消息台账保持原归属。
2. 根据 users.json 与旧 workspace 映射确定每个目录的 userKey。生成 tenantId，将个人偏好、个人 skill、原私有文件整理到该用户 home。旧 workspace 中跨 session 共用且无法细分的文件放本人 `home/legacy-workspace`，不猜测它们属于哪段聊天。
3. 每段聊天建立独立 context，每个 cron 建立固定 context。保存 owner、kind、jobId（cron）、sdkSessionId、sdkStarted、createdAt、lastActivityAt。contextId 为 `c_` 加 24 位随机十六进制字符；旧 SDK session ID 可以保留。
4. 将每段 JSONL 及其同名 subagent 目录迁到对应 `sdk/projects/<encodeProjectDir(新 cwd)>/`，核对条目数量和内容。cwd 使用目标部署的容器路径（通常 `/data/...`），不能误用迁移机器的宿主路径。SDK 会话元数据中的 cwd 随目录位置更新，历史消息正文保留。
5. 把会话状态更新为 `{current:{sessionId,lastActive},history:[],reminded:false}`，补齐已确认归属的历史引用。users.json 的 dirName 更新为 tenantId。每个 cron 的工作文件归到 owner 的 cron context，删除 task 中旧的 image/network/mounts/limits，按新 workspace 修改脚本及提示词路径。
6. 共享人格转到 shared/CLAUDE.md，去掉个人 `@../CLAUDE.md` 导入。公共模型凭据仅放控制服务环境；公共 MCP/服务凭据整理到受控 shared-tools.json，不复制进各 SDK 配置目录。公共 stdio MCP 如需共享，应先部署为 HTTP MCP 服务。
7. 无法确认 owner 的文件与会话放控制面隔离归档，保留旧位置和校验值，不能分发给所有用户。核验账号、用户数、会话数、各自 resume/搜索，以及两个用户互不可见。目录属主必须匹配目标控制服务的 uid/gid；不要修改 release 与部署器的专用属主。
8. 验证完成后最后写 `execution/schema.json` 为 `{"schema":2,"containerRoot":"/data"}`。本次还修改了 compose 的挂载和运行时配置，需要在维护窗口应用新版 compose、重建相应服务容器；仅切 release 链接或 restart 不会应用这些配置。启动新版本，分别验证聊天、cron、后台下载、超时、提前提醒、延长和重启认领。主人格、pinned 守护人格与固化部署执行器必须一起切到支持 v2 的版本，归档旧的回退候选，避免机械回退启动旧布局代码。回退到 v1 必须连同数据备份一起恢复，不能只换代码链接。备份保留到真实部署验收完成。

工作区 `data/` 的一次性迁移报告保存在 `data/execution/migration-report.json`，该目录包含私有数据，不提交 Git。生产宿主的数据需要在其实际目录中执行和验证。
