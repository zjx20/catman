import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { ContextStore } from "../../src/core/execution/contexts.js";
import { RuntimeManager } from "../../src/core/execution/runtime.js";
import type { TaskRecord } from "../../src/core/execution/task-supervisor.js";

export function executionFixture(admin = false) {
  const root = mkdtempSync(join(tmpdir(), "catman-exec-"));
  const dataDir = join(root, "data"); const release = join(dataDir, "releases", "fixture");
  const native = join(release, `node_modules/@anthropic-ai/claude-agent-sdk-linux-${process.arch}`);
  mkdirSync(native, { recursive: true });
  mkdirSync(join(release, "dist/src/core/execution"), { recursive: true });
  writeFileSync(join(native, "claude"), "fixture");
  writeFileSync(join(release, "dist/src/core/execution/worker.js"), "fixture");
  writeFileSync(join(release, "package.json"), '{"type":"module"}');
  const previousRelease = process.env.CATMAN_RELEASE_LINK, previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CATMAN_RELEASE_LINK = release;
  process.env.CLAUDE_CONFIG_DIR = join(dataDir, "claude");
  const config = { ...loadConfig(), dataDir, mainDataDir: dataDir, hostDataDir: "/host/catman", workspaceDir: join(dataDir, "tenants"),
    srcDir: join(dataDir, "src/catman"), apiBase: "http://catman:8787", runtimeIdleMs: 3600_000, maxActiveRuntimes: 3 };
  mkdirSync(config.srcDir, { recursive: true });
  let now = Date.now();
  const contexts = new ContextStore(dataDir, () => now);
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const containers = new Set<string>(); const tasks: TaskRecord[] = [];
  let inspectError: Error | undefined;
  let beforeSnapshot: (() => Promise<void>) | undefined;
  let empty = false;
  const notices: string[] = [];
  const docker = async (args: string[], env?: NodeJS.ProcessEnv): Promise<string> => {
    calls.push({ args, env });
    if (args[0] === "run") { containers.add(args[args.indexOf("--name") + 1]!); return "container"; }
    if (args[0] === "inspect") { if (inspectError) throw inspectError; return containers.has(args.at(-1)!) ? "true" : "false"; }
    if (args[0] === "rm") { containers.delete(args.at(-1)!); return ""; }
    const rpc = args.indexOf("rpc");
    if (rpc >= 0) {
      if (args[rpc + 1] === "/processes") { await beforeSnapshot?.(); return JSON.stringify({ tasks, processes: ["PID PPID COMMAND ELAPSED", "20 1 node 300"], agents: [], unmanaged: empty ? [] : ["node"] }); }
      if (args[rpc + 1] === "/tasks") return JSON.stringify(tasks);
      return "{}";
    }
    return "";
  };
  const options = { isAdmin: () => admin, notify: async (_user: string, text: string) => { notices.push(text); }, docker, now: () => now };
  const runtimes = new RuntimeManager(config, contexts, options);
  return { root, config, contexts, runtimes, options, calls, containers, tasks, notices,
    time: () => now, advance: (ms: number) => { now += ms; },
    failInspect: (error?: Error) => { inspectError = error; },
    beforeSnapshot: (callback?: () => Promise<void>) => { beforeSnapshot = callback; },
    emptySnapshot: () => { empty = true; },
    cleanup: () => {
      runtimes.close();
      if (previousRelease === undefined) delete process.env.CATMAN_RELEASE_LINK; else process.env.CATMAN_RELEASE_LINK = previousRelease;
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
