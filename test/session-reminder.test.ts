import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeChannel } from "../src/channels/bridge.js";
import { CourierCore } from "../src/courier/core.js";
import { ReplyStore } from "../src/courier/reply-store.js";
import { Inbox } from "../src/courier/inbox.js";
import { RoutingTable } from "../src/courier/routing.js";
import { SettingsView } from "../src/courier/settings-view.js";
import { Spool } from "../src/courier/spool.js";
import { IpcServer, handleIpc } from "../src/ipc/server.js";
import { IpcClient } from "../src/ipc/client.js";
import { IPC_SCHEMA, type PersonaId } from "../src/ipc/protocol.js";
import { InMemoryStore, SessionManager } from "../src/core/session.js";

test("真实 Unix IPC：排队与失败不允许会话切换，渠道实际发送确认才持久化允许切换", async () => {
  const root = mkdtempSync(join(tmpdir(), "catman-reminder-"));
  const socketPath = join(root, "ipc.sock"), outboxPath = join(root, "outbox.json");
  const user = "wechat:acc:user", secrets = new Map<string, PersonaId>([["primary-secret", "primary"], ["rescue-secret", "rescue"]]);
  let now = 1000, fail = true;
  const sent: string[] = [];
  const core = new CourierCore({
    inboxes: new Map(["primary", "rescue"].map(p => [p as PersonaId, new Inbox({ path: join(root, `${p}.jsonl`) })])),
    routing: new RoutingTable({ path: join(root, "routes.json") }), replies: new ReplyStore(join(root, "reply.json")),
    spool: new Spool({ dir: join(root, "spool") }), settings: new SettingsView(join(root, "settings.json")),
    greetedPath: join(root, "greeted.json"), outboxPath,
    send: async (_user, text) => { if (fail) throw new Error("network failed"); sent.push(text); },
  });
  const server = new IpcServer({ socketPath, api: core, secrets }); server.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  try {
    const client = new IpcClient({ socketPath, secret: "primary-secret" });
    const bridge = new BridgeChannel({ client, spoolDir: join(root, "spool") });
    const store = new InMemoryStore(), sessions = new SessionManager({ store, timeoutMs: 60_000, now: () => now });
    sessions.record(user, "original"); now += 60_001;
    const cycle = sessions.currentOf(user)!;
    assert.equal(await bridge.sendReminder(user, "expired?"), false);
    assert.ok(!existsSync(outboxPath), "失败的提醒不能悄悄进入队列");
    assert.equal(sessions.decide(user).resumeSessionId, "original");
    fail = false;
    const delivered = await bridge.sendReminder(user, "expired!");
    assert.equal(delivered, true); assert.deepEqual(sent, ["expired!"]);
    if (delivered) sessions.markReminderDelivered(user, cycle);
    const restarted = new SessionManager({ store, timeoutMs: 60_000, now: () => now });
    assert.equal(restarted.decide(user).isNew, true);
    const rejected = await handleIpc({ method: "POST", path: "/reminder", secret: "primary-secret", body: { schema: IPC_SCHEMA, userKey: user, kind: "body", text: "bypass queue" } }, core, secrets, new AbortController().signal);
    assert.equal(rejected.status, 400);
    assert.equal((await new IpcClient({ socketPath, secret: "rescue-secret" }).sendReminder(user, "foreign reminder")).ok, false);
    assert.deepEqual(sent, ["expired!"]);
    fail = true;
    assert.equal((await client.send(user, "queued answer", "body")).ok, true, "普通正文仍按原规则收进队列");
    assert.ok(readFileSync(outboxPath, "utf8").includes("queued answer"));
    assert.equal(await bridge.sendReminder(user, "stale reminder"), false);
    assert.ok(!readFileSync(outboxPath, "utf8").includes("stale reminder"));
  } finally { await core.stop(); await server.stop(); rmSync(root, { recursive: true, force: true }); }
});
