import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NOTIFY_BIN_NAME = "catman-notify";
/** Notification and bounded background execution share the context's local supervisor. */
export function notifyBinBody(_apiBase: string): string {
  return '#!/bin/sh\nexec node /runtime/release/dist/src/core/execution/task-cli.js "$@"\n';
}
export function writeNotifyBin(binDir: string, apiBase: string): string {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, NOTIFY_BIN_NAME);
  writeFileSync(path, notifyBinBody(apiBase), { mode: 0o755 });
  return path;
}
