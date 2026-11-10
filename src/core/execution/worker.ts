import { TaskSupervisor } from "./task-supervisor.js";

const supervisor = new TaskSupervisor({
  dir: process.env.CATMAN_TASKS_DIR!,
  onEvent: async (task, tail) => {
    const response = await fetch(`${process.env.CATMAN_API_BASE}/api/runtime/events`, {
      method: "POST", headers: { "content-type": "application/json", "X-Catman-Runtime": process.env.CATMAN_RUNTIME_TOKEN! },
      body: JSON.stringify({ task, tail }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`事件未被接受：HTTP ${response.status}`);
  },
});
await supervisor.listen();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void supervisor.close().then(() => process.exit()); });
