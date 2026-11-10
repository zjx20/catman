import { spawn } from "node:child_process";
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { OpsConnection } from "./ops.js";

/** 凭证只写进当前 worker 的临时目录；工具输出只有清单和登录命令。 */
export function installOpsConnection(connection: OpsConnection): { configPath: string; text: string } {
  if (!/^catman-ops-o_[a-f0-9]{24}$/.test(connection.host) || connection.user !== "root" || connection.port !== 2222 || !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/.test(connection.hostKey) || /[\r\n]/.test(connection.hostKey)) throw new Error("运维 SSH 连接信息无效");
  const dir = mkdtempSync(join(tmpdir(), "catman-ops-"));
  const key = join(dir, "identity"), hosts = join(dir, "known_hosts"), configPath = join(dir, "ssh_config");
  writeFileSync(key, connection.privateKey, { mode: 0o600, flag: "wx" });
  writeFileSync(hosts, `[${connection.host}]:${connection.port} ${connection.hostKey}\n`, { mode: 0o600, flag: "wx" });
  writeFileSync(configPath, ["Host catman-ops", `  HostName ${connection.host}`, `  Port ${connection.port}`, "  User root", `  IdentityFile ${key}`, `  UserKnownHostsFile ${hosts}`, "  StrictHostKeyChecking yes", "  IdentitiesOnly yes", "  BatchMode yes", "  ForwardAgent no", "  ClearAllForwardings yes", "  ConnectTimeout 10", "  ServerAliveInterval 15", "  ServerAliveCountMax 3", ""].join("\n"), { mode: 0o600, flag: "wx" });
  return { configPath, text: `${connection.description}\n\n执行程序：catman-ops exec -- <程序> [参数...]\n运行本地脚本：catman-ops run <脚本路径或-> [参数...]\n脚本与产物可直接放在两边共享的 workspace，无需复制。\nSSH 登录：ssh -F ${configPath} catman-ops\n复制文件：scp -F ${configPath} <本地文件> catman-ops:<远端路径>\n私钥保存在当前容器临时目录，不要输出或保存到 workspace、skill、credential。` };
}

/** SSH 会再次把命令交给远端 shell，不能只依赖本地 spawn 的 argv 分隔。 */
export function opsRemoteCommand(argv: string[]): string {
  if (!argv.length || argv.some(arg => arg.includes("\0"))) throw new Error("远端程序与参数无效");
  return argv.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

const USAGE = "用法：catman-ops request <用途> | status | connect | exec -- <程序> [参数...] | run <本地脚本或-> [参数...]";

async function execute(configPath: string, verb: string, args: string[]): Promise<number> {
  let input: number | undefined;
  try {
    const argv = verb === "run" ? ["bash", "-s", "--", ...args.slice(1)] : args;
    if (verb === "run" && args[0] !== "-") {
      input = openSync(args[0]!, "r");
      if (!fstatSync(input).isFile()) throw new Error("run 需要本地普通脚本文件，或用 - 从 stdin 读取");
    }
    return await new Promise<number>((resolve, reject) => {
      const child = spawn("ssh", ["-F", configPath, "-T", "catman-ops", opsRemoteCommand(argv)], { stdio: [input ?? "inherit", "inherit", "inherit"] });
      const terminate = () => { child.kill("SIGTERM"); };
      const interrupt = () => { child.kill("SIGINT"); };
      process.on("SIGTERM", terminate); process.on("SIGINT", interrupt);
      const cleanup = () => { process.off("SIGTERM", terminate); process.off("SIGINT", interrupt); };
      child.once("error", error => { cleanup(); reject(error); });
      child.once("exit", (code, signal) => { cleanup(); resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)); });
    });
  } finally { if (input !== undefined) closeSync(input); }
}

async function main(): Promise<void> {
  const [verb, ...rawArgs] = process.argv.slice(2);
  if (verb === "--help" || verb === "help" || !verb) { console.log(USAGE); return; }
  if (!["request", "connect", "status", "exec", "run"].includes(verb)) throw new Error(USAGE);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  if ((["request", "exec", "run"].includes(verb) && !args[0]) || (["connect", "status"].includes(verb) && args.length)) throw new Error(USAGE);
  const base = process.env.CATMAN_API_BASE, token = process.env.CATMAN_RUNTIME_TOKEN;
  if (!base || !token) throw new Error("必须在 catman 会话执行环境中运行");
  const endpoint = ["connect", "exec", "run"].includes(verb) ? "connection" : verb;
  const response = await fetch(`${base}/api/runtime/ops/${endpoint}`, {
    method: verb === "request" ? "POST" : "GET",
    headers: { "X-Catman-Runtime": token, "content-type": "application/json" },
    ...(verb === "request" ? { body: JSON.stringify({ reason: args.join(" ") }) } : {}), signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json() as { error?: string; description?: string } & OpsConnection;
  if (!response.ok) throw new Error(value.error ?? `运维接口返回 ${response.status}`);
  if (verb === "connect") { console.log(installOpsConnection(value).text); return; }
  if (endpoint !== "connection") { console.log(value.description); return; }
  const connection = installOpsConnection(value);
  try { process.exitCode = await execute(connection.configPath, verb, args); }
  finally { rmSync(dirname(connection.configPath), { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
