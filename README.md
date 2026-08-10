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
- **说到一半可以补话**:助手正在跑的时候再发消息,会**折进正在进行的那一轮**,
  它下一步就能看到 —— 不用等这轮跑完。想改主意("等下,用 sed 别用 python")直接说就行,
  不必 `/取消` 重来。补进去的会立刻回一句"收到,一并交给正在处理的这一轮了",
  `/状态` 里也会显示这一轮期间补充了几条
- **会话智能管理**:上下文过长自动压缩(SDK 内置);距上次对话超过 1 小时的新消息自动开新会话;
  超时会尝试推送提醒,发 `/继续` 可延续上一段会话;离开的会话进入每人最多 10 段的历史,
  发 `/切换会话 <会话id>` 可随时切回其中一段 —— 微信只有一个聊天窗,这就是多话题并行的出路
- **硬指令**:`/帮助` `/状态` `/新会话` `/取消` `/继续` `/切换会话` 由后台直接响应,不经过 LLM ——
  所以助手卡住时它们照样管用(见 [硬指令](#硬指令))
- **切走的对话继续在后台跑**:助手忙着的时候 `/新会话` 或 `/切换会话` 不会打断它 ——
  那一轮转到后台跑完,结果带着「【后台对话 xxx 的结果】」发给你,期间你照常聊别的
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
  core/session           会话路由:1h 超时 / /继续 恢复 / /切换会话 历史(切走的回合转后台) / 30 天清理
  core/settings          全局配置层(可运行时改)+ 全部配置项的 schema
  core/prefs             每用户配置层,叠在全局默认之上
  core/commands          硬指令表:不经 LLM 的后台直答(只读的就地执行,改状态的进分拣队列)
  core/turn-tokens       回合级一次性令牌,agent 靠它读写自己的配置
  core/skills            把接口用法写成 skill(按需加载,常态不占 token)
  core/agent             Claude Agent SDK(claude_code preset, bypassPermissions);回合中途可追加输入
  core/gateway           分拣节点(按到达顺序线性处理,不等回合);每会话串行,跨会话并发有上限
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

catman 采用**源码直跑**:镜像(`catman-env`)只是一层不含业务代码的运行环境,真正跑的代码
是数据卷里的 **release 目录**,由符号链接 `data/releases/current` 指定。所以首次部署分三步 ——
构建基底镜像、初始化第一个 release、起服务:

```bash
# 0) /data 在宿主上的绝对路径,后面几步都要用(自进化的一次性容器靠它挂卷)
export CATMAN_HOST_DATA_DIR="$PWD/data"
echo "CATMAN_HOST_DATA_DIR=$CATMAN_HOST_DATA_DIR" >> .env

# 1) 构建稳定基底镜像(此后极少重建 —— 升级换的是代码,不是镜像)
docker build -t catman-env:1 -f docker/Dockerfile .

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

# ① 助手拉代码用的:GitHub 上建一个**只读** deploy key
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

这样分之后,「助手改不了远端历史」这道闸从**文件属主**上移到了 **GitHub 侧的只读
deploy key** —— 而后者更强:属主挡不住一个挂了 docker.sock 的助手,只读密钥挡得住。

只做一把也能跑:放 `$DATA/ssh/id_ed25519` 并 `chown 10001`,`init.sh` 会认出它是给助手用的
(pull 通、push 跳过)。`init.sh` 跑完会打一段诊断,把两个槽位各自的状态和属主说清楚。

助手那把是写进**仓库配置**的(`core.sshCommand`,由 `init.sh` 设),不走容器 env ——
env 要改 compose,而 compose 属 Tier 3、每次调整都要人;写进仓库之后助手一句朴素的
`git pull` 就能跑,不必知道钥匙在哪。也可以用 `CATMAN_GIT_FETCH_KEY` / `CATMAN_GIT_SSH_KEY`
把两个槽位分别指到别处。

> **SSH 出不去的话改用 HTTPS + token。** 部署密钥只能走 SSH,而 HTTP 代理转发不了裸 TCP;
> 端口 22 被挡时可试 `ssh.github.com:443`,再不行就用细粒度只读 PAT 走
> `https://<token>@github.com/...`(注意 token 会明文留在 `.git/config` 里,
> 属主那道闸对它不成立 —— 助手读得到)。
> 另外:挂了 docker.sock 的助手本来就等同宿主 root,理论上总能绕过属主,所以属主防的是
> **失误**(顺手一个 `git push`),真正的边界是 GitHub 侧那把钥匙的权限。

> **架构不必再操心**:依赖是在**目标机器上**用 `catman-env` 装的(见 `scripts/evolve/prepare.sh`),
> 天然就是对的架构。以前那套 buildx + QEMU 多架构构建随源码直跑一起消失了 ——
> 唯一要在目标架构下构建的是基底镜像本身,而它不含 npm 依赖,`docker build` 就地跑即可。

### 日常升级

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
会连自己一起被杀)。跑起来就返回,进度看 `docker logs -f catman-deployer`,结论写进
部署报告 —— catman 起来后会在你下一条消息时告诉你。

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
| `/状态` | `/status` `/狀態` | 看**当前有没有在处理**、模型、会话空闲时长、各项生效配置(不花额度) |
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

分两类:`/帮助` `/状态` `/取消` 是**就地执行**,连攒消息的那 1.5 秒都不等 ——
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
| 进度推送 | 最多 6(`MAX_PROGRESS_PER_TOKEN`) |
| 正文 | 预留 1(超过 `maxReplyChars` 分段时,后面几段仍可能超预算) |
| 会话空闲提醒 | 预留 1 |
| 部署结果播报 | 预留 1 |

超时提醒必须单独占一格:它的前提就是用户没再发消息,而 `context_token` 只在收到新消息时
更新 —— 所以它用的还是上一个回合那份额度。进度把额度吃光,这条提醒就再也发不出去。

**这笔账只有一本,在信使**(`src/courier/reply-store.ts`)。人格侧不记 —— 进度的总量上限
每次现问渠道。两处各记一份的话必然对不上(真出现过 7 对 6),而症状很隐蔽:不是超发
(信使会拒),是每个长回合都多发一条注定被拒的进度,并且「进度就报到这儿」那句交代
永远不会触发,用户看到的是进度毫无征兆地停住。预算必须有唯一权威,这也是守护人格
可能同时在往同一个 `context_token` 发东西时唯一算得清的办法。

进度的两道闸门缺一不可:**间隔阶梯**(5→15→30→60 秒)防止密集刷屏,**总条数上限**
防止长回合靠 60 秒一条把额度慢慢耗完 —— 阶梯本身并不限制总数。额度用尽时最后一条
进度会附一句「进度就报到这儿,接下来直接等答案」,免得那段静默被当成卡死。

上表算的是**一份** token 的账。往正在跑的那一轮里补话时(见"说到一半可以补话"),
这条新消息本身就带来一个新的 `context_token`,预算跟着重来 —— 所以进度的条数与
间隔阶梯也在那一刻一并重置,不是"一个回合总共只能报这么多"。

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
npm install
npm run typecheck
npm test                        # 身份 / 会话 / 网关 / 准入 / transcript / dashboard 单测
CATMAN_CHANNEL=stdin CATMAN_DATA_DIR=./data CATMAN_ADMIN_TOKEN=devtoken \
  CLAUDE_CODE_OAUTH_TOKEN=<token> npm run dev   # stdin 通道,终端直接聊
```

stdin 通道支持 `/user <名字>` 切换身份,因此**多用户隔离可以完全脱离微信在本地验证**:
切到不同名字发消息,能看到各自独立的工作目录与会话。

## 基底镜像

`catman-env` 是一层**不含应用代码**的运行环境:node 22 + git/ripgrep/curl + docker CLI +
两个用户(catman 10001 跑应用、deployer 10002 拥有 release 目录)。它极少变更 ——
改它属于要人工介入的那一类变更(见 [自进化](#自进化) 的 Tier 分级)。

```bash
docker build -t catman-env:1 -f docker/Dockerfile .
```

**构建期连不上 `download.docker.com` 时**(它是整个构建里唯一容易够不着的地方),两条路:

```bash
# ① 走代理。大小写都要传 —— apt 的 http 方法只读小写、curl 只认大写 HTTPS_PROXY,
#    只给一种的症状是"GPG key 拉得下来、apt-get update 却连不上"。
#    ⚠️ 地址不能写 host.docker.internal:那个名字靠 compose 的 extra_hosts 在**运行时**
#    注入,构建期不存在。填代理机的内网 IP。
P=http://192.168.1.2:7890
docker build -t catman-env:1 -f docker/Dockerfile \
  --build-arg HTTP_PROXY="$P"  --build-arg HTTPS_PROXY="$P" \
  --build-arg http_proxy="$P"  --build-arg https_proxy="$P" .

# ② 不配代理,换一个够得着的镜像源(布局都是 <base>/linux/debian)
docker build -t catman-env:1 -f docker/Dockerfile \
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

基底是 `node:22-bookworm-slim`(glibc),因此选中的是 glibc 变体;换 alpine 基底会切到
musl 变体,需要重新验证。

验证依赖架构对不对(这条仍然要看):

```bash
docker compose exec catman node -p process.arch                          # → arm64 / x86_64
docker compose exec catman sh -c 'ls $(readlink -f /data/releases/current)/node_modules/@anthropic-ai/'
```

两者对不上就说明制备跑在了错误的架构下。

## 自进化

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
| 自检 | **deployer 亲自** | 起一次性容器跑 `CATMAN_SELFCHECK=1`,含一次真实的最小 SDK 请求 |
| 切换 | deployer | 排水 → 停容器 → 换 current → 起容器 → 健康门(比对 `/health` 回报的 sha) |
| 观察 | deployer | 30 分钟盯重启次数与健康;**这期间 stable 不动** |
| 收尾 | deployer | 通过则前移 stable + 入清单 + GC + 推远端;不通过则退回并写报告 |

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
- **确认口令是硬指令**:`/发布 <前6位>` 由你亲手打、由网关按字面解析,是整条流水线里
  唯一一处把「你批准了什么」和「机器部署了什么」机械绑在一起的地方。交给助手转述的话,
  这把锁就挂在一个会看错字、而且正是被部署的那一方的环节上。网关也不替你补全或纠错 ——
  太短、找不到、有歧义、已经是当前版本,四种情况各回各的话。
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

## 数据格式与升级

**日常升级不动 `data/`。** 回滚只换代码(换 `releases/current` 的指向),数据一路向前 ——
所以自动进化的改动必须**能读现有格式**,而且因为观察期内随时可能回滚,**旧版本也要能读
新版本写的**。做不到的改动属于要人工介入的那一类,不走自动流水线。

兜底靠代码里本来就有的防御式解析:`parseUserKey()` 对非法 key 返回 null、`SessionManager`
加载时丢弃坏条目、prefs 失效的覆盖只在读取时回退(不改盘)、`settings.effective()` 永不抛。
这些不是为迁移准备的分支,是解析器本就该有的防御。

**跨越不兼容格式时**(比如从单账号版本升级),不提供迁移,清空 `./data` 重新扫码即可 ——
为一次性场景写迁移代码,等于把旧格式的知识永久留在代码里。旧的 `state.json` 条目会被识别为
非法格式并丢弃(日志有提示),旧的 `ilink-credentials.json` 不再被任何代码读取。

⚠️ 如果保留旧 `./data` 不删,`data/claude/projects/-data-workspace/` 下的旧会话会**永久残留**:
清理只在已知用户的目录内操作(上一条的安全约束),不会去收养这个孤儿目录。要么清空 `./data`,
要么手动删掉那个目录。
