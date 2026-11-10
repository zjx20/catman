import { isAbsolute, normalize } from "node:path";

export interface OpsMount { source: string; target: string; readOnly: boolean }
export interface OpsConfig { image: string; mounts: OpsMount[]; dockerSocket: boolean; memory: string; maxActive: number }

/** 只读部署环境变量；用户偏好、skill 和请求正文不能扩大挂载。 */
export function parseOpsMounts(raw: string): OpsMount[] {
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries)) throw new Error("CATMAN_OPS_MOUNTS 必须是 JSON 数组");
  const mounts = entries.map((entry: unknown): OpsMount => {
    const value = typeof entry === "string" ? { source: entry } : entry;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("运维挂载必须是路径或挂载对象");
    const { source, target = source, readOnly = false } = value as Record<string, unknown>;
    const valid = (path: unknown): path is string => typeof path === "string" && isAbsolute(path) && normalize(path) === path && !/[\s,\x00-\x1f\x7f]/.test(path);
    if (!valid(source) || !valid(target) || typeof readOnly !== "boolean") throw new Error("运维挂载要求规范绝对路径和布尔 readOnly");
    // 不允许覆盖系统工具、SSH 身份与控制面生成的启动材料。
    if (target === "/" || ["/bin", "/sbin", "/usr", "/lib", "/lib64", "/etc", "/proc", "/sys", "/dev", "/run", "/tmp"].some(p => target === p || target.startsWith(`${p}/`))) throw new Error(`运维挂载目标受保护：${target}`);
    return { source, target, readOnly };
  });
  for (const [i, mount] of mounts.entries()) {
    if (mounts.slice(0, i).some(m => m.target === mount.target || m.target.startsWith(`${mount.target}/`) || mount.target.startsWith(`${m.target}/`))) throw new Error("运维挂载目标不能重复或嵌套");
  }
  return mounts;
}
