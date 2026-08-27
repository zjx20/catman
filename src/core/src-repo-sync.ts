import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * 部署之后把源码仓库拨到线上版本。
 *
 * ## 为什么这件事非得由 catman 自己做
 *
 * deployer 推远端用的是 `<sha>:refs/heads/main` 这个 refspec、从 release 目录推、
 * 目标写的是 URL —— 三样加起来意味着**源码仓库一个字节都没被碰过**:本地 `main`
 * 停在原地,`origin/main` 也停在原地。于是下次 `git checkout main -b evolve/xxx`
 * 切出来的基线是上上个版本,分叉成了默认结果而不是失误。
 *
 * 顺手在 deployer 里补一句 `git update-ref` 是行不通的:源码仓库属 uid 10001
 * (catman),deployer 跑在 10002 下,`.git` 及其子目录对它**全部不可写**(实测)。
 * 硬给它权限的话,`.git` 里会开始出现 10002 属主的对象,而那些对象此后 catman
 * 自己改不动 —— 换来一个更难查的问题。
 *
 * 所以这件事挪到有权限的那一方:catman 每次部署后都会重启,启动时它正好知道自己
 * 跑的是哪个 sha,也正好拥有那个仓库。
 *
 * ## 只快进,绝不 reset
 *
 * 本地分支上可能有还没上线的提交(比如人在电脑上刚 push 了别的东西、或者上一次
 * 制备失败留下的),移动它就是丢东西。所以只在"线上 sha 是本地分支的后代"时才动,
 * 否则原样留着并说一句 —— 那正是分叉,而制备的分叉闸会在下一次拦住它。
 *
 * ## 不碰 origin/*
 *
 * 推远端发生在观察期**之后**,而这个函数跑在启动时,那会儿远端多半还没被推。
 * 拨 `origin/main` 等于替一件还没发生的事作证。留给 `git pull --ff-only` 去对齐。
 */

export type SrcSyncResult = {
  /** 本地分支有没有被拨动。 */
  moved: boolean;
  /** 一句话,直接进日志;没什么可说时为空。 */
  detail: string;
  /** 顺手删掉的、内容已经全在线上版本里的 `evolve/*` 分支。 */
  dropped: string[];
};

const NOTHING: SrcSyncResult = { moved: false, detail: "", dropped: [] };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    // 本地仓库操作,正常都是毫秒级。卡住多半是 index.lock 之类的意外,
    // 不值得让启动跟着一起悬着。
    timeout: 10_000,
  });
  return stdout.trim();
}

/** git 命令失败一律当成"这条路不通",返回 undefined —— 同步失败绝不能拖垮启动。 */
async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

export async function syncSrcRepoToRelease(opts: {
  srcDir: string;
  /** 线上正在跑的 sha。 */
  sha: string;
  /**
   * 主线分支名(与 `scripts/evolve/lib.sh` 的 `CATMAN_UPSTREAM_BRANCH` 同源)。
   *
   * ⚠️ **不是 VERSION 里那个 branch** —— 那是制备时所在的分支,每次都是新的
   * `evolve/xxx`。传错了不会报错,只会静默空转:函数发现"这个分支已经就是线上
   * sha 了",一声不吭地返回。上线过一次才发现,所以参数特意不叫 branch。
   */
  mainline?: string;
}): Promise<SrcSyncResult> {
  const { srcDir, sha } = opts;
  const branch = opts.mainline || "main";
  if (!sha || !existsSync(join(srcDir, ".git"))) return NOTHING;

  // 仓库属 10001 而进程也是 10001,但挂载方式变过好几轮 —— 与其假设,不如先问一句。
  // 拿不到就干脆不做:这个功能是"省事",不值得为它冒任何险。
  const trusted = await tryGit(srcDir, ["rev-parse", "--git-dir"]);
  if (trusted === undefined) return NOTHING;

  // 线上那个提交必须在这个仓库里认得出来。制备就是从这儿 clone 的,正常都在;
  // 认不出来说明这不是同一个仓库(换了远端、或者被重新 clone 过),那就别动它。
  if ((await tryGit(srcDir, ["cat-file", "-e", `${sha}^{commit}`])) === undefined) {
    return { moved: false, detail: `线上版本 ${sha.slice(0, 7)} 不在源码仓库里,没动它`, dropped: [] };
  }
  if ((await tryGit(srcDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) === undefined) {
    return NOTHING;
  }

  const already = await tryGit(srcDir, ["rev-parse", `refs/heads/${branch}`]);
  if (already === sha) return { moved: false, detail: "", dropped: await dropMerged(srcDir, sha) };

  // 只快进。`--is-ancestor` 用退出码表态,失败即"不是后代"。
  const ff = await tryGit(srcDir, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, sha]);
  if (ff === undefined) {
    return {
      moved: false,
      detail: `源码仓库的 ${branch} 上有不在线上版本里的提交,没动它(制备时分叉闸会拦)`,
      dropped: [],
    };
  }

  const head = await tryGit(srcDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head === branch) {
    // 正检出在这个分支上:只拨 ref 会让工作区凭空多出一堆"改动"(实为反向 diff)。
    // 要连工作区一起走,而那只有在干净时才安全。
    const dirty = await tryGit(srcDir, ["status", "--porcelain"]);
    if (dirty === undefined || dirty !== "") {
      return { moved: false, detail: `源码仓库正停在 ${branch} 且工作区不干净,没动它`, dropped: [] };
    }
    if ((await tryGit(srcDir, ["merge", "--ff-only", sha])) === undefined) {
      return { moved: false, detail: `源码仓库的 ${branch} 快进失败,没动它`, dropped: [] };
    }
  } else if ((await tryGit(srcDir, ["update-ref", `refs/heads/${branch}`, sha])) === undefined) {
    return { moved: false, detail: `源码仓库的 ${branch} 快进失败,没动它`, dropped: [] };
  }

  return {
    moved: true,
    detail: `源码仓库的 ${branch} 已快进到线上版本 ${sha.slice(0, 7)}`,
    dropped: await dropMerged(srcDir, sha),
  };
}

/**
 * 删掉那些内容已经全部进了线上版本的 `evolve/*` 分支。
 *
 * 这本来是 `lib.sh` 的 `drop_prepared_branch` 干的,而它跑在 deployer 下 ——
 * 写不了 `.git`,于是每次都落进"没删掉,留着不影响什么"那条分支。残留的分支会让
 * 下次开工误判成"上次没合并"。
 *
 * 三道闸照搬那边:只碰 `evolve/` 前缀、当前检出的不碰、**尖端必须已经包含在线上
 * 版本里**(最后一条是唯一真正的安全依据)。
 */
async function dropMerged(srcDir: string, sha: string): Promise<string[]> {
  const listed = await tryGit(srcDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/evolve"]);
  if (!listed) return [];
  const head = await tryGit(srcDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const dropped: string[] = [];
  for (const b of listed.split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (b === head) continue;
    if ((await tryGit(srcDir, ["merge-base", "--is-ancestor", b, sha])) === undefined) continue;
    // -D 而不是 -d:安全性由上面那句 is-ancestor 保证,而 -d 判的是"合进当前 HEAD 没有",
    // 那取决于此刻检出的是什么,与我们要问的问题不是一回事。
    if ((await tryGit(srcDir, ["branch", "-D", b])) !== undefined) dropped.push(b);
  }
  return dropped;
}
