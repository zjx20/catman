import { existsSync, readdirSync, readlinkSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import { readVersion } from "./version.js";

/**
 * catman 这一侧对 release 目录的**只读视图**。
 *
 * 它存在的唯一理由是 `/发布 <版本号前6位>`:人打的那几位要落到一个具体的 sha 上,
 * 而候选是磁盘上真实存在的目录。真正的校验(内容清单、能不能起来)仍然由 deployer
 * 亲自做 —— 这里只做枚举与前缀解析,以及把四种失败翻译成人话。
 *
 * 主容器对 `/data/releases` 是**只读挂载**,所以这个文件里没有任何写操作,
 * 将来也不该有:能写它的只有 deployer 系的一次性容器。
 */

/** 目录名必须长这样。制备一律用 `git rev-parse` 的输出,即 40 位小写十六进制。 */
const SHA_DIR = /^[0-9a-f]{40}$/;

/**
 * 确认口令里 sha 前缀的**下限**。
 *
 * 6 位十六进制有 1600 万种可能,而磁盘上同时存在的 release 只有个位数 —— 碰撞概率
 * 可以忽略。下限的真正作用是挡住手滑:`/发布 a` 这种输入本身就不表达"我看清了是哪个版本",
 * 而 nonce 确认的全部意义正是"人批准的与机器部署的是同一个东西"。
 *
 * 展示一律用 `shortSha()`(7 位),所以照抄汇报里那串永远合规。
 */
export const MIN_SHA_PREFIX = 6;

/** 一个已经制备好、可以拿去部署的 release。 */
export interface PreparedRelease {
  readonly sha: string;
  /** 制备完成时刻(ISO 8601),读不出时是空串。 */
  readonly preparedAt: string;
  /** 制备时所在的分支,只给人看。 */
  readonly branch?: string;
}

/**
 * 枚举已制备的 release,**新→旧**。
 *
 * 三道过滤,少一道就会把不是 release 的东西当成候选:
 *
 * ① `withFileTypes` 的 `isDirectory()` 对符号链接是 false(readdir 不跟随)——
 *    current / stable / pinned 就住在这个目录里,它们是指针不是 release。
 *    `release_gc` 曾经漏掉这一道,`rm -rf current/` 顺着链接把目标掏空了。
 * ② 名字必须是 40 位小写十六进制,于是制备中途留下的 `<sha>.tmp` 一概不算。
 * ③ 目录里必须同时有 VERSION 与 MANIFEST,且 VERSION 里的 sha 与目录名对得上 ——
 *    否则它连 deployer 的 `release_verify` 都过不了,列成候选等于给人一个必然失败的选项。
 */
export function listPreparedReleases(releasesDir: string): PreparedRelease[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(releasesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: PreparedRelease[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sha = ent.name;
    if (!SHA_DIR.test(sha)) continue;
    const dir = join(releasesDir, sha);
    if (!existsSync(join(dir, "MANIFEST"))) continue;
    const version = readVersion(join(dir, "VERSION"));
    if (!version || version.sha !== sha) continue;
    out.push({
      sha,
      preparedAt: version.preparedAt,
      ...(version.branch ? { branch: version.branch } : {}),
    });
  }
  // 新的排前面:人要发布的几乎总是刚制备的那个,列候选时它该在第一行。
  // preparedAt 读不出来(空串)的排最后,而不是靠字典序偶然跑到前面。
  out.sort((a, b) => (b.preparedAt || "").localeCompare(a.preparedAt || ""));
  return out;
}

/**
 * 某个指针当前指着哪个 sha。解析不了(不是链接、断链、目录不存在)一律 undefined ——
 * 与 `version.ts` 同一条纪律:读不到就说读不到,绝不编一个。
 */
export function pointerSha(releasesDir: string, name: string): string | undefined {
  try {
    const target = readlinkSync(join(releasesDir, name));
    const sha = basename(target);
    return SHA_DIR.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** 前缀解析的四种结果。每一种在用户那边都该是不同的一句话。 */
export type ShaLookup =
  | { readonly kind: "ok"; readonly sha: string }
  | { readonly kind: "tooShort" }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly matches: readonly string[] };

/**
 * 把人打的那几位落到一个具体的 sha 上。
 *
 * 大小写不敏感(手机上很容易带出大写),但**不做任何模糊匹配** —— 前缀就是前缀。
 * 这是确认口令,宁可让人重打一次,也不能猜。
 */
export function resolveShaPrefix(shas: readonly string[], prefix: string): ShaLookup {
  const p = prefix.trim().toLowerCase();
  if (p.length < MIN_SHA_PREFIX) return { kind: "tooShort" };
  const matches = shas.filter((sha) => sha.startsWith(p));
  if (matches.length === 1) return { kind: "ok", sha: matches[0]! };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "ambiguous", matches };
}
