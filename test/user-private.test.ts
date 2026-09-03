import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRIVATE_MOUNT, ensureUserPrivateDir, userPrivatePaths } from "../src/core/user-private.js";
import { sessionMounts } from "../src/core/session-container.js";
import { privMounts } from "../src/core/cron/scheduler.js";
import { buildTurnEnv } from "../src/core/turn-env.js";
import { userDirName } from "../src/core/identity.js";

const dirs: string[] = [];
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "catman-private-"));
  dirs.push(d);
  return d;
}

const USER = "wechat:abc123:someone@im.wechat";
const OTHER = "wechat:def456:另一个人@im.wechat";
const mode = (p: string) => statSync(p).mode & 0o777;

/** 配好了这个机制的一台机器。 */
function configured(local: string) {
  return {
    userDataDir: local,
    hostUserDataDir: "/mnt/usb/catman_userdata",
    persona: "primary" as const,
  };
}

test("主人格:目录建出来,权限真的是 0700", () => {
  const root = tmp();
  const paths = ensureUserPrivateDir(configured(root), USER);
  assert.ok(paths, "配齐了就该拿到路径");
  assert.ok(statSync(paths.local).isDirectory());
  // mkdirSync 的 mode 会被 umask(默认 022)削成 0755,必须显式 chmod 一次 ——
  // 这条用例盯的就是那次 chmod。0755 意味着别的 uid 也读得到。
  assert.equal(mode(paths.local), 0o700, `权限是 ${mode(paths.local).toString(8)}`);
});

test("幂等:建第二次不报错,权限被改歪了也修回来", () => {
  const root = tmp();
  const first = ensureUserPrivateDir(configured(root), USER);
  assert.ok(first);
  const again = ensureUserPrivateDir(configured(root), USER);
  assert.ok(again);
  assert.equal(again.local, first.local);
  assert.equal(mode(again.local), 0o700);
});

test("两个用户拿到两个不同的目录", () => {
  const root = tmp();
  const a = ensureUserPrivateDir(configured(root), USER);
  const b = ensureUserPrivateDir(configured(root), OTHER);
  assert.ok(a && b);
  assert.notEqual(a.local, b.local);
  assert.notEqual(a.host, b.host);
  // 目录名复用 users.json 那套,别在这里另发明一套编码。
  assert.equal(a.local, join(root, userDirName(USER)));
});

test("宿主路径是宿主视角,容器内路径是那个常量", () => {
  const root = tmp();
  const p = ensureUserPrivateDir(configured(root), USER);
  assert.ok(p);
  // -v 的左边永远是宿主路径。拿容器内路径去挂,docker 会在宿主上静默建个空目录。
  assert.equal(p.host, join("/mnt/usb/catman_userdata", userDirName(USER)));
  assert.equal(p.at, PRIVATE_MOUNT);
  assert.equal(p.at, "/private");
});

test("没配 hostUserDataDir 就整个降级 —— 不建目录也不返回路径", () => {
  const root = tmp();
  const paths = userPrivatePaths(
    { userDataDir: root, hostUserDataDir: undefined, persona: "primary" },
    USER,
  );
  // 关键是**不能退回共享区**:那会把凭据写到所有人都看得见的地方,
  // 而调用方以为它是私有的。宁可没有。
  assert.equal(paths, undefined);
});

test("救援人格一律没有私有目录", () => {
  const root = tmp();
  const paths = userPrivatePaths({ ...configured(root), persona: "rescue" }, USER);
  assert.equal(paths, undefined, "它的 /data 是只读的,也不该长出别人的私有目录");
});

test("会话容器:挂的是这一个人的那一份,挂在 /private", () => {
  const mounts = sessionMounts({
    persona: "primary",
    hostDataDir: "/mnt/usb/catman_data",
    dataDir: "/data",
    mainDataDir: "/data",
    privateHostDir: "/mnt/usb/catman_userdata/someone-abc",
  });
  const priv = mounts.filter((m) => m.at === PRIVATE_MOUNT);
  assert.equal(priv.length, 1);
  assert.equal(priv[0]?.host, "/mnt/usb/catman_userdata/someone-abc");
  assert.ok(!priv[0]?.ro, "私有目录是写凭据的地方,只读挂上去这个机制就白做了");
  // 私有目录根一条都不能出现 —— 挂根等于把所有人的凭据又端进来了。
  assert.ok(
    !mounts.some((m) => m.host === "/mnt/usb/catman_userdata"),
    "挂的必须是那个人的子目录,不是根",
  );
});

test("会话容器:私有目录不在被整挂的 /data 里面", () => {
  const mounts = sessionMounts({
    persona: "primary",
    hostDataDir: "/mnt/usb/catman_data",
    dataDir: "/data",
    mainDataDir: "/data",
    privateHostDir: "/mnt/usb/catman_userdata/someone-abc",
  });
  const priv = mounts.find((m) => m.at === PRIVATE_MOUNT);
  assert.ok(priv);
  // 这是整个设计的要点:落在 /data 里面就得靠挂载覆盖顺序把别人的遮住,
  // 而那种机制漏了是**全部暴露**。落在根下则不依赖任何顺序。
  assert.ok(!priv.at.startsWith("/data"), "私有目录不能落在整挂的那棵树里");
  assert.ok(
    !priv.host.startsWith("/mnt/usb/catman_data/"),
    "宿主侧同理:它必须是 catman_data 的兄弟,不是它的子目录",
  );
});

test("会话容器:不给 privateHostDir 就一条都不挂", () => {
  const mounts = sessionMounts({
    persona: "primary",
    hostDataDir: "/mnt/usb/catman_data",
    dataDir: "/data",
    mainDataDir: "/data",
  });
  assert.ok(!mounts.some((m) => m.at === PRIVATE_MOUNT));
});

test("会话容器:救援人格即使传了也不挂", () => {
  const mounts = sessionMounts({
    persona: "rescue",
    hostDataDir: "/mnt/usb/catman_data",
    dataDir: "/data/rescue",
    mainDataDir: "/data",
    privateHostDir: "/mnt/usb/catman_userdata/someone-abc",
  });
  // 上游已经对它返回 undefined,这里是第二道 —— "谁能看见什么"两处各自成立
  // 比一处成立可靠。
  assert.ok(!mounts.some((m) => m.at === PRIVATE_MOUNT));
  // 顺带确认它原来那套护栏没被这次改动碰坏。
  assert.ok(mounts.some((m) => m.at === "/data" && m.ro));
});

test("环境变量:挂了才注入", () => {
  const withPriv = buildTurnEnv({
    apiBase: "http://catman:8787",
    sessionToken: "t",
    isAdmin: false,
    userPrivateDir: PRIVATE_MOUNT,
  });
  assert.equal(withPriv["CATMAN_USER_PRIVATE_DIR"], "/private");

  const without = buildTurnEnv({ apiBase: "http://catman:8787", sessionToken: "t", isAdmin: false });
  // 变量在而目录不在是最坏的一种:脚本会往一个不存在的路径写凭据,
  // 或者更糟 —— 往共享区写却以为自己在私有区。
  assert.ok(!("CATMAN_USER_PRIVATE_DIR" in without));
});

test("script 类 cron:私有目录追加进任务自己的挂载表,可写", () => {
  const declared = [{ host: "/mnt/usb/catman_data/cron_data/x", at: "/state", ro: false }];
  const out = privMounts(declared, {
    host: "/mnt/usb/catman_userdata/someone-abc",
    local: "/userdata/someone-abc",
    at: PRIVATE_MOUNT,
  });
  assert.equal(out.length, 2);
  assert.equal(out[1]?.at, PRIVATE_MOUNT);
  assert.equal(out[1]?.ro, false);
  // 任务自己声明的那条原样留着。
  assert.equal(out[0]?.at, "/state");
});

test("script 类 cron:没有私有目录就原样返回", () => {
  const declared = [{ host: "/a", at: "/b", ro: true }];
  assert.equal(privMounts(declared, undefined), declared);
});

test("script 类 cron:任务已经占了 /private 就不再追加", () => {
  const declared = [{ host: "/my/own", at: PRIVATE_MOUNT, ro: true }];
  const out = privMounts(declared, {
    host: "/mnt/usb/catman_userdata/someone-abc",
    local: "/userdata/someone-abc",
    at: PRIVATE_MOUNT,
  });
  // 同一个 at 挂两次 docker 直接拒绝启动,而症状是"这个任务忽然再也起不来了" ——
  // 跟私有目录八竿子打不着,排查起来很贵。
  assert.equal(out.length, 1);
  assert.equal(out[0]?.host, "/my/own");
});

/**
 * 这几条盯的是 `hostUserDataDir` **必填、不推导**。
 *
 * 推导那一版在真机上翻过车:那台机器的 `CATMAN_HOST_DATA_DIR` 是
 * `/opt/services/catman/data` —— 一条指向 `/mnt/usb/catman_data` 的软链。
 * dockerd 跟随软链所以 `/data` 一直对,但同级推导得到的是另一棵树,
 * 而症状是 `/private` 存在却写不进去,一声不吭。
 */
test("hostUserDataDir 只认显式配置,不从 hostDataDir 推", async () => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith("CATMAN_")) delete process.env[k];
  try {
    const { loadConfig } = await import("../src/config.js");

    // 只给 hostDataDir(而且是那台真机上的软链路径),不给私有目录根。
    process.env["CATMAN_HOST_DATA_DIR"] = "/opt/services/catman/data";
    assert.equal(
      loadConfig().hostUserDataDir,
      undefined,
      "不给就是不给 —— 推出一个 /opt/services/catman/catman_userdata 正是那次事故",
    );

    // 显式给了才有,而且原样取用。
    process.env["CATMAN_HOST_USER_DATA_DIR"] = "/mnt/usb/catman_userdata";
    assert.equal(loadConfig().hostUserDataDir, "/mnt/usb/catman_userdata");
  } finally {
    process.env = saved;
  }
});

test("没有 hostUserDataDir 时,userPrivatePaths 一律返回 undefined", () => {
  // 与上一条配套:配置层不给值,机制层就整个不启用(而不是退回共享区)。
  assert.equal(
    userPrivatePaths({ userDataDir: "/userdata", hostUserDataDir: undefined, persona: "primary" }, USER),
    undefined,
  );
});
