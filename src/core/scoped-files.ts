import { constants, openSync, closeSync, fstatSync, realpathSync, readSync, type Stats } from "node:fs";
import { isAbsolute, relative } from "node:path";

/** Validate the opened descriptor, not a path checked before open (tenant symlinks can race). */
function withScopedFile<T>(root: string, path: string, use: (fd: number, stat: Stats) => T): T {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const actual = realpathSync(`/proc/self/fd/${fd}`);
    const rel = relative(realpathSync(root), actual);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("文件软链越出授权目录");
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("只允许读取普通文件");
    return use(fd, stat);
  } finally { closeSync(fd); }
}
export function scopedFileStat(root: string, path: string): Stats { return withScopedFile(root, path, (_fd, stat) => stat); }
export function readScopedFile(root: string, path: string, maxBytes = 1024 * 1024): string {
  return withScopedFile(root, path, (fd, stat) => {
    if (stat.size > maxBytes) throw new Error("文件超过允许读取的大小");
    const chunks: Buffer[] = []; let size = 0;
    while (size <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size));
      const count = readSync(fd, buffer, 0, buffer.length, size);
      if (!count) break;
      size += count; chunks.push(buffer.subarray(0, count));
    }
    if (size > maxBytes) throw new Error("文件超过允许读取的大小");
    return Buffer.concat(chunks, size).toString("utf8");
  });
}
