import { spawn } from "node:child_process";
import { taskRequest } from "./task-supervisor.js";

async function main(): Promise<void> {
  const [verb, ...args] = process.argv.slice(2);
  if (verb === "exec") {
    const cmd = args[0] === "--" ? args.slice(1) : args;
    if (!cmd.length) throw new Error("缺少 agent 命令");
    const child = spawn(cmd[0]!, cmd.slice(1), { detached: true, stdio: "inherit", env: process.env });
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    });
    // Install listeners before registration: authentication/startup failures can exit immediately.
    void exited.catch(() => {});
    if (!child.pid) { await exited; return; }
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { try { process.kill(-child.pid!, signal); } catch {} });
    try { await taskRequest("/agents", "POST", { id: process.env.CATMAN_AGENT_ID, pid: child.pid }); }
    catch (error) { try { process.kill(-child.pid, "SIGKILL"); } catch {} throw error; }
    process.exitCode = await exited;
    await taskRequest(`/agents/${process.env.CATMAN_AGENT_ID}`, "DELETE", { exited: true }).catch(() => {});
    return;
  }
  if (verb === "rpc") { console.log(JSON.stringify(await taskRequest(args[0]!, args[1] ?? "GET", args[2] ? JSON.parse(args[2]) : undefined))); return; }
  if (verb === "list") { console.log(JSON.stringify(await taskRequest("/tasks"), null, 2)); return; }
  if (verb === "stop") { if (!args[0]) throw new Error("需要任务 ID"); console.log(JSON.stringify(await taskRequest(`/tasks/${args[0]}`, "DELETE"))); return; }
  if (verb === "send") {
    let text = args.join(" ");
    if (!args.length && !process.stdin.isTTY) {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of process.stdin) {
        length += chunk.length;
        if (length > 24_000) throw new Error("通知正文过长");
        chunks.push(chunk);
      }
      text = Buffer.concat(chunks).toString("utf8");
    }
    if (!text.trim()) throw new Error("通知正文不能为空");
    const response = await fetch(`${process.env.CATMAN_API_BASE}/api/runtime/notify`, { method: "POST", headers: {
      "content-type": "application/json", "X-Catman-Runtime": process.env.CATMAN_RUNTIME_TOKEN ?? "" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`通知失败 HTTP ${response.status}`);
    return;
  }
  if (verb !== "run") throw new Error("用法：catman-task run --timeout <秒> [-n 名字] -- <命令...> | list | stop <id>");
  let seconds: number | undefined; let name: string | undefined; let i = 0;
  while (i < args.length && args[i] !== "--") {
    if (args[i] === "--timeout") { seconds = Number(args[i + 1]); i += 2; }
    else if (args[i] === "-n") { name = args[i + 1]; i += 2; }
    else throw new Error(`未知参数 ${args[i]}`);
  }
  if (args[i] !== "--" || !Number.isSafeInteger(seconds) || !seconds || seconds <= 0) throw new Error("run 必须提供 --timeout <秒> 和 -- <命令>");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const task = await taskRequest("/tasks", "POST", { cmd: args.slice(i + 1), name, timeoutMs: seconds * 1000, cwd: process.cwd(), env });
  console.log(JSON.stringify(task, null, 2));
}
main().catch(err => { console.error(String(err)); process.exitCode = 1; });
