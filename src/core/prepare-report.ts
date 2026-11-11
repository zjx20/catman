import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { codeBlock, inlineCode } from "./markdown.js";

/** A failed build can be arbitrarily noisy; only read the bounded end of its log. */
export function readPrepareTail(path: string, maxBytes = 64 * 1024): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const bytes = Buffer.alloc(Math.min(size, maxBytes));
    const tail = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, start)).toString("utf8");
    // Discard the partial first line, including any partial UTF-8 character.
    return start ? tail.slice(tail.indexOf("\n") + 1) : tail;
  } finally { closeSync(fd); }
}

/** Interpret the fixed executor's report; the executor remains responsible for gates and tiers. */
export function formatPrepareReport(status: string, log: string, logPath: string): string {
  const parts = [`自进化制备${status}。`];
  if (status !== "完成") {
    if (log.trim()) parts.push("日志末尾：", codeBlock(log.trim().slice(-1500)));
  } else {
    const sha = /^([a-f0-9]{40})\s*$/.exec(log.trim().split("\n").at(-1) ?? "")?.[1];
    if (sha) parts.push(`候选版本：${inlineCode(sha.slice(0, 7))}。`);
    const passed = /^# pass (\d+)$/m.exec(log)?.[1];
    const total = /^# tests (\d+)$/m.exec(log)?.[1];
    if (total && passed) parts.push(`验证：测试 ${passed}/${total} 通过。`);

    const tiers = Array.from(log.matchAll(/^Tier (3|2|1★|1) [^\n]*\n((?:  [^\n]*\n)*)/gm));
    const summaries: string[] = [];
    for (const [, tier, body] of tiers) {
      const files = body!.split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("→"));
      const labels: Record<string, string> = {
        "3": "Tier 3：含需人工处理的部署变更，自动发布不能完成这些步骤",
        "2": "Tier 2：依赖变更",
        "1★": "Tier 1★：修改了门禁本体，确认发布时需单独核对",
        "1": "Tier 1：常规改动",
      };
      summaries.push(`- ${labels[tier!]}（${files.length} 个文件）${tier === "1" ? "。" : `：${files.slice(0, 12).map(inlineCode).join("、")}${files.length > 12 ? "，其余见完整日志" : ""}。`}`);
    }
    if (summaries.length) parts.push(`变更分级：\n\n${summaries.join("\n")}`);
    if (tiers.some(t => t[1] === "3")) parts.push("部署提示：scripts/evolve/ 变更需要重新 bless；docker/ 变更需要重建镜像；compose 变更需要重新创建容器。请先核对完整日志中的要求。");
    parts.push(sha ? "确认后，发送下面的指令发布：" : "未从日志中识别到完整候选版本，请先查看升级状态：", codeBlock(sha ? `/发布 ${sha.slice(0, 7)}` : "/升级状态", "text"));
  }
  parts.push(`完整日志：${inlineCode(logPath)}`);
  return parts.join("\n\n");
}
