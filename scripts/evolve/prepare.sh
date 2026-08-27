#!/usr/bin/env bash
# 制备一个 release —— 自进化流水线里 agent 负责的那一步。
#
# 用法(在 catman 容器里跑,由 agent 或人调用):
#   /data/deploy/bin/prepare.sh <git-ref>
#
# ## 跑的必须是 bless 固化的那一份
#
# **制备门(typecheck + 全量测试)就在这个脚本里**,而这个脚本住在同一个仓库里 ——
# 自我进化改得到它。跑 release 里那份(`/data/releases/current/scripts/evolve/prepare.sh`)
# 的话,一次把 `npm test` 改没了的进化,会让**此后每一次**制备都不再跑测试,
# 而日志上看起来一切正常。这与 deployer.sh 是同一个理由、同一个解法:
# 能改门的人不能是被门管的人,所以 bless 把它固化到 `/data/deploy/bin/`。
#
# 固化不是沙箱(谁都还能 `bash` 那份源码副本),它拦的是"约定路径悄悄变了"这件事 ——
# 与本项目其它地方一样:不防恶意,只防失误。
#
# 它起一个**一次性容器**(与生产同一个 catman-env 镜像、uid 10002)完成全部工作:
#   浅 clone → 装依赖 → typecheck + 全量测试 → 编译 → 版本戳 → 内容清单 → 原子就位
#
# ## 三条不能改的纪律
#
# **① 测试环境即生产环境。** 用的是同一个镜像、同一份 node_modules —— 测试跑过的
# 那份字节就是将来要跑的那份。分成两套的话,"测试机上好好的、目标机上炸"这类问题
# 会以最难查的形式回来(依赖的 arch/libc 尤其)。
#
# **② devDependencies 保留,绝不 prune。** 曾经的设计是"装全量 → 跑测试 → prune 掉
# devDeps",而下一次制备若 lockfile 没变就硬链接复用上一个 release 的 node_modules ——
# 那棵树里已经没有 tsc/tsx 了,于是**最常见的那条路径必然失败**。补装又会就地写文件,
# 透过硬链接污染上一个(可能正是 stable)release 的字节。两个坑同时消失的办法就是不 prune。
#
# **③ 复用之后对那棵树零写操作。** cp -al 之后新旧 release 的 node_modules 逐文件
# 共享 inode,任何就地写(npm install 重写 .package-lock.json、包的 postinstall 改自己
# 目录里的文件、chmod)都会**穿透**到已验证的旧 release。所以复用分支下一条 npm 写命令
# 都不许有;lockfile 变了就老老实实全量装一份新的。

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

REF="${1:-HEAD}"

# 源码仓库归 catman(10001),制备跑在 deployer(10002)下 —— 见 lib.sh 的说明。
git_trust_repo "$SRC_DIR"

command -v docker >/dev/null || die "容器里没有 docker CLI"
[ -d "$SRC_DIR/.git" ] || die "源码仓库不在 $SRC_DIR —— 先 clone 一份(见 README「自进化」)"

SHA="$(git -C "$SRC_DIR" rev-parse "$REF")"
BRANCH="$(git -C "$SRC_DIR" rev-parse --abbrev-ref "$REF" 2>/dev/null || echo "")"
log "制备 release $SHA(ref=$REF branch=${BRANCH:-?})"

TARGET="$RELEASES_DIR/$SHA"
if [ -d "$TARGET" ]; then
  # 已经制备过就直接复验:重复制备既慢又会把已验证的目录推倒重来。
  release_verify "$SHA" && { log "release $SHA 已存在且校验通过,跳过制备"; echo "$SHA"; exit 0; }
  die "release $SHA 已存在但校验不通过 —— 先人工确认再删掉 $TARGET"
fi

# 磁盘水位门。**放在最前面**:一次制备要几百 MB,磁盘满了之后 dockerd 会全面异常,
# 那时连回滚都做不了。宁可这次不进化,不可赌一把。
AVAIL_MB="$(df -Pm "$RELEASES_DIR" | awk 'NR==2 {print $4}')"
MIN_MB="${CATMAN_MIN_DISK_MB:-5120}"
[ "$AVAIL_MB" -ge "$MIN_MB" ] || die "磁盘只剩 ${AVAIL_MB}MB(要求 ≥ ${MIN_MB}MB),拒绝制备"

# 分叉闸。和磁盘门一样放在**跑容器之前** —— 这道闸不需要任何构建产物就能判,而一次
# 制备要在一台 2 核软路由上跑好几分钟全量测试,判得出来的事没理由让人先等完。
#
# 基线取**正在跑的那个版本**,与下面的分级报告同一个基准:人关心的是"相对线上"。
CURRENT_SHA="$(pointer_sha current)"
diverge_check "$CURRENT_SHA" "$SHA" || die "拒绝制备:与线上版本分叉(上面列出了会被撤销的提交)"

# 上一个 release 的 node_modules,用于 lockfile 未变时的硬链接复用。
PREV_SHA="$(pointer_sha stable)"
[ -n "$PREV_SHA" ] || PREV_SHA="$(pointer_sha current)"

# 代理必须透传给一次性容器。目标环境很可能只有走代理才够得着 npm registry 与
# Anthropic API —— 漏了这一条,流水线在真实环境里**永远**全红,而在开发机上一切正常。
PROXY_ENV=()
for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
  [ -n "${!v:-}" ] && PROXY_ENV+=(-e "$v=${!v}")
done

# npm registry。目标网络够不着 registry.npmjs.org 时换个镜像:
#   CATMAN_NPM_REGISTRY=https://registry.npmmirror.com
# `npm ci` 照样可用 —— lockfile 里记的 tarball 主机是 registry.npmjs.org,而 npm 的
# `replace-registry-host` 默认值(npmjs)就是"把它替换成配置的 registry";完整性哈希
# 仍然逐个校验,换镜像不降低这一层保证。
NPM_ENV=()
[ -n "${CATMAN_NPM_REGISTRY:-}" ] && NPM_ENV+=(-e "npm_config_registry=$CATMAN_NPM_REGISTRY")

# 把网络配置**说出来**。这一层失败时 npm 只会甩几百行日志外加一句自己的
# "Exit handler never called!",真因(ENOTFOUND)埋在中间 —— 而它十有八九就是
# "代理没传进来"。传没传进来是这里唯一说得清的地方,所以在这里说。
log "网络:registry=${CATMAN_NPM_REGISTRY:-默认} 代理=${HTTPS_PROXY:-${https_proxy:-无}}"
# 内存上限同理。node 的测试运行器按 CPU 数并行开进程,小机器上很容易顶到 --memory,
# 被杀掉的那些文件在汇总里表现为 **cancelled**(不是 fail)—— 而汇总里看不出内存这回事。
# CATMAN_TEST_FLAGS 就是那时候要用的旋钮,比如 --test-concurrency=2。
log "资源:内存=${CATMAN_PREPARE_MEMORY:-1500m} 测试参数=${CATMAN_TEST_FLAGS:-默认}"

mkdir -p "$NPM_CACHE_DIR"

# 全程在一次性容器里跑。--memory 让 npm ci 的内存峰值死在容器里,而不是让内核的
# OOM killer 去挑一个受害者(它完全可能挑中 dockerd 或正在服务的 catman)。
docker run --rm \
  --name "catman-prepare-${SHA:0:12}" \
  --user 10002:10002 \
  --memory "${CATMAN_PREPARE_MEMORY:-1500m}" \
  --add-host host.docker.internal:host-gateway \
  "${PROXY_ENV[@]}" \
  "${NPM_ENV[@]}" \
  -e "TZ=${TZ:-UTC}" -e "CATMAN_TEST_FLAGS=${CATMAN_TEST_FLAGS:-}" \
  -e "SHA=$SHA" -e "BRANCH=$BRANCH" -e "PREV_SHA=$PREV_SHA" \
  -e "CATMAN_SRC_DIR=$SRC_DIR" -e "CATMAN_RELEASES_DIR=$RELEASES_DIR" \
  -e "CATMAN_NPM_CACHE_DIR=$NPM_CACHE_DIR" -e "LIB=$HERE/lib.sh" \
  -v "${CATMAN_HOST_DATA_DIR:?必须给出 /data 在宿主上的绝对路径}:/data" \
  "$CATMAN_IMAGE" \
  bash -euo pipefail -c '
    # 同一份 lib.sh —— 它就在 /data 下面,这个容器也挂着 /data,路径原样有效。
    # 让内层自己 source 而不是把值一个个 -e 进来,是为了 git_trust_repo 只有一份实现:
    # 属主放行必须**在这个容器里**重做一遍(见 lib.sh —— 配置文件在 /tmp,不跨容器)。
    . "$LIB"
    git_trust_repo "$SRC_DIR"

    WORK="$RELEASES_DIR/$SHA.tmp"
    # 不是 `rm -rf` —— 上一次被中途杀掉留下的 $WORK 删不掉,见 lib.sh 里那段说明。
    rm_release_tmp "$WORK"
    # clone 而不是 git worktree:worktree 的 .git 只是一个指向共享仓库的指针,
    # 清理时 rm -rf 会留下元数据残骸,导致**同一个 sha 无法再次 worktree add** ——
    # 那恰好死在"回滚之后想重新制备旧版本"这条事故恢复路径上。clone 出来的
    # release 自带 .git,删起来干干净净。
    # 不加 --shared:那会让 release 的 git 通过 alternates 依赖 /data/src 存活,
    # release 就不再自包含了。本地路径 clone 会尽量硬链接对象(属主不同 + 内核的
    # protected_hardlinks 不允许时,git 自己退化成复制),两种都比走网络快得多。
    git clone --quiet --no-checkout "$SRC_DIR" "$WORK"
    git -C "$WORK" checkout --quiet --detach "$SHA"

    export npm_config_cache="$NPM_CACHE_DIR"
    PREV_MODULES="$RELEASES_DIR/$PREV_SHA/node_modules"
    if [ -n "$PREV_SHA" ] && [ -d "$PREV_MODULES" ] \
       && cmp -s "$WORK/package-lock.json" "$RELEASES_DIR/$PREV_SHA/package-lock.json"; then
      echo "lockfile 未变,硬链接复用 $PREV_SHA 的 node_modules(此后对它零写操作)"
      cp -al "$PREV_MODULES" "$WORK/node_modules"
    else
      echo "全量安装依赖(含 devDependencies —— 见脚本头纪律 ②)"
      ( cd "$WORK" && npm ci --no-audit --no-fund )
    fi

    cd "$WORK"
    echo "── typecheck ──"; npm run typecheck
    echo "── 全量测试 ──"; npm test
    echo "── 编译 ──";     npm run build

    # 版本戳。运行时靠它回答"我是哪个版本",部署的健康门靠它确认"跑起来的确实是
    # 刚切过去的那份"。
    node -e "
      const fs = require(\"fs\");
      fs.writeFileSync(\"VERSION\", JSON.stringify({
        sha: process.env.SHA,
        preparedAt: new Date().toISOString(),
        ...(process.env.BRANCH ? { branch: process.env.BRANCH } : {}),
      }, null, 2));
    "

    # 内容清单。git status 对 dist/ 与 node_modules/ 全盲(都在 .gitignore 里),
    # 而那才是真正被执行的字节 —— 有人往 dist 里打个热补丁,git 一无所知。
    # 清单只覆盖 dist 与 VERSION:node_modules 动辄十万个文件,逐个哈希在软路由上
    # 要跑很久,而它由 lockfile + 只读挂载 + 零写纪律共同保护。
    find dist VERSION -type f -print0 | sort -z | xargs -0 sha256sum > MANIFEST

    # 目录去写权限。**目录的 inode 不被硬链接共享**,所以这一步各 release 独立,
    # 不会穿透到复用同一批文件的旧 release(而 chmod 文件会穿透,故意不做)。
    # 它拦的是结构性误改:往 release 里新增/删除文件。
    # .git 整个跳过 —— 锁死它没有收益(release 里不再跑 git),却会让将来任何
    # 需要读写 git 元数据的排查动作平白失败。
    find . -type d -not -path "./.git" -not -path "./.git/*" -exec chmod a-w {} +

    mv -T "$RELEASES_DIR/$SHA.tmp" "$RELEASES_DIR/$SHA"
    echo "release $SHA 就位"
  '

release_verify "$SHA" || die "制备完成但校验不通过 —— 这是个 bug,别部署它"
log "制备完成:$SHA"

# 分级报告。基线取**正在跑的那个版本**:人关心的是"相对线上多了什么",
# 而不是相对某个分支点。打在 stderr —— stdout 是结果通道,调用方在捕获末行那个 sha。
# CURRENT_SHA 在上面的分叉闸那里就取过了,这里复用同一个值 —— 两处必须是同一个基准。
if [ -n "$CURRENT_SHA" ] && [ "$CURRENT_SHA" != "$SHA" ]; then
  tier_report "$CURRENT_SHA" "$SHA"
fi

log "确认发布:在微信里发「/发布 ${SHA:0:7}」"
echo "$SHA"
