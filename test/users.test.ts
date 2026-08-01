import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserRegistry, listWorkspaceDirs } from "../src/core/users.js";
import { userDirName } from "../src/core/identity.js";
import { encodeProjectDir } from "../src/core/transcript.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "catman-users-"));
  const workspaceRoot = join(root, "workspace");
  const registry = new UserRegistry({
    path: join(root, "users.json"),
    workspaceRoot,
    now: () => 1000,
  });
  return { root, workspaceRoot, registry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("ensureWorkspace 建目录并写入引入共享人设的 CLAUDE.md", () => {
  const { workspaceRoot, registry, cleanup } = setup();
  try {
    const dir = registry.ensureWorkspace("wechat:acct:u1");
    assert.equal(dir, join(workspaceRoot, userDirName("wechat:acct:u1")));
    const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    // 共享人设靠显式 import 引入,不依赖向上递归查找。
    assert.match(md, /@\.\.\/CLAUDE\.md/);
    assert.match(md, /wechat:acct:u1/);
  } finally {
    cleanup();
  }
});

test("ensureWorkspace 幂等:不覆盖用户改过的 CLAUDE.md", () => {
  const { registry, cleanup } = setup();
  try {
    const dir = registry.ensureWorkspace("wechat:acct:u1");
    writeFileSync(join(dir, "CLAUDE.md"), "我自己写的偏好", "utf8");
    registry.ensureWorkspace("wechat:acct:u1");
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "我自己写的偏好");
  } finally {
    cleanup();
  }
});

test("不同用户拿到不同目录;同一 userId 在不同账号下也不同", () => {
  const { registry, cleanup } = setup();
  try {
    const a = registry.ensureWorkspace("wechat:acct-a:same@im.wechat");
    const b = registry.ensureWorkspace("wechat:acct-b:same@im.wechat");
    assert.notEqual(a, b);
    assert.ok(existsSync(a) && existsSync(b));
  } finally {
    cleanup();
  }
});

test("注册表持久化并可反查 dirName → userKey", () => {
  const { root, workspaceRoot, registry, cleanup } = setup();
  try {
    registry.ensureWorkspace("wechat:acct:u1");
    // 换一个实例读同一份文件,验证确实落盘了。
    const reloaded = new UserRegistry({ path: join(root, "users.json"), workspaceRoot });
    const snap = reloaded.snapshot();
    assert.ok(snap["wechat:acct:u1"]);
    assert.equal(reloaded.userKeyOfDir(userDirName("wechat:acct:u1")), "wechat:acct:u1");
    assert.equal(reloaded.userKeyOfDir("不存在的目录"), undefined);
  } finally {
    cleanup();
  }
});

test("工作目录路径过长时直接报错(避免与 SDK 的 project 编码分叉)", () => {
  const root = mkdtempSync(join(tmpdir(), "catman-users-"));
  try {
    // 造一个本身就接近阈值的 workspaceRoot。
    const deep = join(root, "x".repeat(180));
    const registry = new UserRegistry({ path: join(root, "users.json"), workspaceRoot: deep });
    assert.throws(() => registry.ensureWorkspace("wechat:acct:u1"), /路径过长/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listWorkspaceDirs 列出各用户目录并算出对应 projectDir", () => {
  const { workspaceRoot, registry, cleanup } = setup();
  try {
    const d1 = registry.ensureWorkspace("wechat:acct:u1");
    registry.ensureWorkspace("wechat:acct:u2");

    const dirs = listWorkspaceDirs(workspaceRoot);
    assert.equal(dirs.length, 2);
    const hit = dirs.find((d) => d.path === d1);
    assert.ok(hit);
    assert.equal(hit.projectDir, encodeProjectDir(d1));
  } finally {
    cleanup();
  }
});

test("listWorkspaceDirs 忽略共享 CLAUDE.md 与非本程序生成的目录", () => {
  const { workspaceRoot, registry, cleanup } = setup();
  try {
    registry.ensureWorkspace("wechat:acct:u1");
    // 共享人设文件,以及用户手动放进来的目录 —— 都不是某个人的 workspace。
    writeFileSync(join(workspaceRoot, "CLAUDE.md"), "共享人设", "utf8");
    mkdirSync(join(workspaceRoot, "我的笔记"), { recursive: true });
    mkdirSync(join(workspaceRoot, "notes"), { recursive: true });

    const dirs = listWorkspaceDirs(workspaceRoot);
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0]!.dirName, userDirName("wechat:acct:u1"));
  } finally {
    cleanup();
  }
});

test("listWorkspaceDirs 对不存在的目录返回空数组", () => {
  assert.deepEqual(listWorkspaceDirs("/nonexistent/catman/workspace"), []);
});

test("首次指引:needsGreeting 直到 markGreeted 才转 false", () => {
  const { registry, cleanup } = setup();
  try {
    const u = "stdin:local:u1";
    // 尚未注册的用户也算"需要指引",否则第一条消息就漏掉了。
    assert.equal(registry.needsGreeting(u), true);
    registry.ensureWorkspace(u);
    assert.equal(registry.needsGreeting(u), true);
    registry.markGreeted(u);
    assert.equal(registry.needsGreeting(u), false);
    // 幂等:重复标记不出错,ensureWorkspace 也不该把它重置回去。
    registry.markGreeted(u);
    registry.ensureWorkspace(u);
    assert.equal(registry.needsGreeting(u), false);
  } finally {
    cleanup();
  }
});

test("首次指引:标记持久化,重启后不重复推送", () => {
  const { root, workspaceRoot, registry, cleanup } = setup();
  try {
    const u = "stdin:local:u1";
    registry.ensureWorkspace(u);
    registry.markGreeted(u);
    const again = new UserRegistry({ path: join(root, "users.json"), workspaceRoot });
    assert.equal(again.needsGreeting(u), false);
  } finally {
    cleanup();
  }
});

test("setDisplayName 修改展示名并落盘;空名拒绝", () => {
  const { registry, cleanup } = setup();
  try {
    const u = "stdin:local:u1";
    assert.equal(registry.setDisplayName(u, "爱丽丝"), false, "用户还没注册");
    registry.ensureWorkspace(u);
    assert.equal(registry.setDisplayName(u, "  爱丽丝  "), true);
    assert.equal(registry.get(u)?.displayName, "爱丽丝");
    assert.throws(() => registry.setDisplayName(u, "   "), /不能为空/);
  } finally {
    cleanup();
  }
});

test("setDisplayName 截断过长的名字", () => {
  const { registry, cleanup } = setup();
  try {
    const u = "stdin:local:u1";
    registry.ensureWorkspace(u);
    registry.setDisplayName(u, "长".repeat(100));
    const name = registry.get(u)!.displayName;
    assert.equal(name.length, 65, "64 字符加省略号");
    assert.ok(name.endsWith("…"));
  } finally {
    cleanup();
  }
});

test("get 返回副本,改它不影响注册表", () => {
  const { registry, cleanup } = setup();
  try {
    const u = "stdin:local:u1";
    registry.ensureWorkspace(u);
    const rec = registry.get(u)!;
    rec.displayName = "篡改";
    assert.notEqual(registry.get(u)?.displayName, "篡改");
  } finally {
    cleanup();
  }
});
