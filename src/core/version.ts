import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 版本戳:这个进程跑的是哪一份代码。
 *
 * 源码直跑没有"构建"这一步可以注入版本号,所以由制备流水线(scripts/evolve/prepare.sh)
 * 在 release 根目录写一个 `VERSION` 文件,运行时读它。
 *
 * **读不到就返回 undefined,绝不编一个。** 部署的健康门要拿 `/health` 回报的 sha 与
 * 待部署的 sha 比对,确认"跑起来的确实是刚切过去的那份"——编造的值会让这道门放行
 * 一次实际没切成功的部署(比如看门狗抢先用旧 current 拉起了容器)。开发机上直接跑
 * 源码时读不到是正常的,那里本来也没有部署门。
 */
export interface VersionInfo {
  /** 制备时的 git commit sha(全长)。 */
  readonly sha: string;
  /** 制备完成时刻(ISO 8601 字符串)。 */
  readonly preparedAt: string;
  /** 制备时所在的分支,只给人看,可能缺失。 */
  readonly branch?: string;
}

/** VERSION 文件名。制备脚本与运行时共用这个常量的字面值,改名要一起改。 */
export const VERSION_FILE = "VERSION";

/**
 * 从模块位置往上找到 app 根目录(带 package.json 的那一层)。
 *
 * 走上找而不是写死层数:编译产物在 `dist/src/core/`、源码直跑(tsx)在 `src/core/`,
 * 两者到根的距离不同,写死会在其中一种下悄悄读不到版本。
 */
function findAppRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  // 6 层足够覆盖上面两种布局,又不至于在异常情况下一路走到文件系统根。
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * 读版本戳。坏值一律返回 undefined —— 与 settings.ts 的 `parse()` 同一纪律:
 * 读取时坏值不抛,让调用方退到"没有版本信息"这个可用状态。
 *
 * `path` 供单测注入;不传则找 app 根目录下的 VERSION。
 */
export function readVersion(path?: string): VersionInfo | undefined {
  const file = path ?? (() => {
    const root = findAppRoot();
    return root ? join(root, VERSION_FILE) : undefined;
  })();
  if (!file) return undefined;

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return undefined;
    const rec = v as Record<string, unknown>;
    const sha = rec["sha"];
    const preparedAt = rec["preparedAt"];
    // sha 是这份数据存在的理由(健康门比对的就是它),没有就等于没有版本信息。
    if (typeof sha !== "string" || !sha) return undefined;
    const branch = rec["branch"];
    return {
      sha,
      preparedAt: typeof preparedAt === "string" ? preparedAt : "",
      ...(typeof branch === "string" && branch ? { branch } : {}),
    };
  } catch {
    return undefined;
  }
}

/** 短 sha,给人看的场合(日志、`/状态`、确认口令)用它。 */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** `/状态` 里的那一行。没有版本信息时说清是"源码直跑",不假装有版本。 */
export function versionLine(v: VersionInfo | undefined): string {
  if (!v) return "版本:开发模式(无版本戳)";
  const when = v.preparedAt ? `,${v.preparedAt}` : "";
  const branch = v.branch ? ` ${v.branch}` : "";
  return `版本:${shortSha(v.sha)}${branch}${when}`;
}

/**
 * 给助手自己看的那行版本提示(**不是给用户看的**,措辞是第二人称)。
 *
 * 助手从前没有任何带内途径知道自己跑的是哪一份代码:`readVersion()` 的结果只喂了
 * 部署控制面与健康检查,系统提示词里一个字都没有。于是它只能 shell 出去
 * `readlink releases/current`,而"不知道自己不知道"恰好是想不起来查的原因。
 *
 * **带上旧 sha** 是刻意的:只说新值的话,读的人分不清这是"刚刚升级了"还是
 * "一直就是这个",而这两者该做的事不一样(前者要留意刚上线的改动)。
 */
export function releaseNote(cur: VersionInfo, prev: string | undefined): string {
  const now = shortSha(cur.sha);
  if (!prev) return `你现在跑的是 release ${now}。`;
  if (prev === cur.sha) return `你现在跑的是 release ${now}。`;
  return `你现在跑的是 release ${now} —— 上次告诉你的时候还是 ${shortSha(prev)},中间升级过。`;
}
