import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Persona } from "../../config.js";
import { personaBriefing } from "../persona.js";
import { readTenantFile } from "./contexts.js";

/** Production and the native-CLI selfcheck must use the same instruction loader. */
export function instructionOptions(persona: Persona, memoryLimit?: string): Pick<Options, "settingSources" | "systemPrompt" | "permissionMode"> {
  return {
    settingSources: ["user", "project", "local"],
    permissionMode: "bypassPermissions",
    systemPrompt: { type: "preset", preset: "claude_code", append: `${personaBriefing(persona, memoryLimit)}\n\n${REPLY_FORMAT}` },
  };
}

const REPLY_FORMAT = `## 回复格式
聊天客户端按 Markdown 渲染。段落、列表、代码围栏之间留空行，不依赖单换行排版。
需要用户复制执行或发送的完整命令（包括 /授权、/发布、/回收 等硬指令）单独放进代码围栏；每条指令一个代码块，填好实际参数，不带 shell 提示符或解释文字。
路径、版本号、程序名使用行内代码。汇报先给结论和必要的验证结果，不直接粘贴整段工具输出；确需展示的日志片段放进 text 代码围栏。`;

/** Materialize User memory; Project memory remains native CLI discovery in the workspace. */
export function projectInstructions(dataDir: string, home: string, target: string, ops = false): void {
  const shared = join(dataDir, "shared", "CLAUDE.md");
  const common = existsSync(shared) ? readFileSync(shared, "utf8") : "";
  const personal = readTenantFile(home, "CLAUDE.md") ?? "";
  const operations = ops ? "\n## 临时运维环境\n宿主维护按 catman-ops skill 申请用户硬指令授权，使用 catman-ops exec/run 执行；普通 Bash 仍在原 worker 中。\n" : "";
  writeFileSync(target, `${common}\n\n${personal}\n\n## 执行环境\n当前 workspace 是本会话或定时任务的独立工作区。任务产物、脚本与中间文件直接写在这里，按任务需要组织子目录。workspace 在执行容器回收后仍保留；容器的 /tmp 随容器回收。需要跨会话使用的产物放 /user/artifacts，个人项目放 /user/projects，skill 放 /user/skills。不要把共享目录或控制面数据目录当作工作区。后台命令必须通过 catman-task run --timeout <秒> -- <命令> 登记；最长 86400 秒。长期服务需要部署。\n${operations}`, { mode: 0o600 });
}
