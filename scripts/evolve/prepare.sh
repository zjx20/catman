#!/usr/bin/env bash
# 制备一个 release —— 自进化流水线里 agent 负责的那一步。
#
# 用法(在 catman 容器里跑,由 agent 或人调用):
#   scripts/evolve/prepare.sh <git-ref>
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

# 上一个 release 的 node_modules,用于 lockfile 未变时的硬链接复用。
PREV_SHA="$(pointer_sha stable)"
[ -n "$PREV_SHA" ] || PREV_SHA="$(pointer_sha current)"

# 代理必须透传给一次性容器。目标环境很可能只有走代理才够得着 npm registry 与
# Anthropic API —— 漏了这一条,流水线在真实环境里**永远**全红,而在开发机上一切正常。
PROXY_ENV=()
for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
  [ -n "${!v:-}" ] && PROXY_ENV+=(-e "$v=${!v}")
done

mkdir -p "$NPM_CACHE_DIR"

# 全程在一次性容器里跑。--memory 让 npm ci 的内存峰值死在容器里,而不是让内核的
# OOM killer 去挑一个受害者(它完全可能挑中 dockerd 或正在服务的 catman)。
docker run --rm \
  --name "catman-prepare-${SHA:0:12}" \
  --user 10002:10002 \
  --memory "${CATMAN_PREPARE_MEMORY:-1500m}" \
  --add-host host.docker.internal:host-gateway \
  "${PROXY_ENV[@]}" \
  -e "SHA=$SHA" -e "BRANCH=$BRANCH" -e "PREV_SHA=$PREV_SHA" \
  -e "SRC_DIR=$SRC_DIR" -e "RELEASES_DIR=$RELEASES_DIR" -e "NPM_CACHE_DIR=$NPM_CACHE_DIR" \
  -v "${CATMAN_HOST_DATA_DIR:?必须给出 /data 在宿主上的绝对路径}:/data" \
  "$CATMAN_IMAGE" \
  bash -euo pipefail -c '
    WORK="$RELEASES_DIR/$SHA.tmp"
    rm -rf "$WORK"
    # clone 而不是 git worktree:worktree 的 .git 只是一个指向共享仓库的指针,
    # 清理时 rm -rf 会留下元数据残骸,导致**同一个 sha 无法再次 worktree add** ——
    # 那恰好死在"回滚之后想重新制备旧版本"这条事故恢复路径上。clone 出来的
    # release 自带 .git,删起来干干净净。
    # 不加 --shared:那会让 release 的 git 通过 alternates 依赖 /data/src 存活,
    # release 就不再自包含了。本地路径 clone 默认硬链接对象,已经足够快。
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
echo "$SHA"
