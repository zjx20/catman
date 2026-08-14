import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunArgs, collectProxyEnv, containerNameFor, CRON_LABEL } from "../src/core/cron/docker.js";
import type { LaunchSpec } from "../src/core/cron/docker.js";

/**
 * 这串参数里有一半是**隔离闸门**。它们出错的方式是"照跑不误,只是没有防护" ——
 * 那种错在真机上没有任何症状,只能靠断言钉住。
 */
function spec(over: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    container: "catman-cron-j_1-20260813t000000z-0001",
    jobId: "j_1",
    image: "catman-env:1",
    cmd: ["bash", "-lc", "df -h /"],
    env: {},
    network: "none",
    mounts: [],
    limits: { memory: "512m", cpus: 0.5, pids: 128 },
    hostWorkDir: "/mnt/usb/catman_data/cron/work/j_1",
    ...over,
  };
}

/** 取某个开关后面紧跟的那个值。 */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

test("四道隔离闸门一个都不能少", () => {
  const args = buildRunArgs(spec());
  assert.equal(valueOf(args, "--network"), "none", "默认必须断网");
  assert.equal(valueOf(args, "--user"), "10001:10001", "绝不以 root 跑");
  assert.equal(valueOf(args, "--memory"), "512m");
  assert.equal(valueOf(args, "--cpus"), "0.5");
  assert.equal(valueOf(args, "--pids-limit"), "128", "fork 炸弹只有这一道闸");
});

test("detached + 有标签:重启后认领与孤儿清理都靠它们", () => {
  const args = buildRunArgs(spec());
  assert.equal(args[0], "run");
  assert.ok(args.includes("-d"), "必须 detached —— 部署重启不该劈断在跑的任务");
  assert.equal(valueOf(args, "--label"), `${CRON_LABEL}=j_1`);
  assert.equal(valueOf(args, "--name"), "catman-cron-j_1-20260813t000000z-0001");
});

test("容器日志有上限 —— 磁盘满会让 dockerd 全面异常", () => {
  const args = buildRunArgs(spec());
  assert.equal(valueOf(args, "--log-driver"), "json-file");
  assert.ok(args.includes("max-size=8m"));
});

test("init 与 TINI_SUBREAPER 配套出现", () => {
  const args = buildRunArgs(spec());
  assert.ok(args.includes("--init"));
  // 少了它,默认镜像里的第二个 tini 会往每个任务的输出顶三行告警,
  // 而通知只截尾巴 —— 没有输出的任务,用户收到的整条消息就是那堆告警。
  assert.ok(args.includes("TINI_SUBREAPER=1"), "真机实测:两个 tini 时里面那个会抱怨");
});

test("工作目录挂在 /work 且可写;额外挂载默认只读", () => {
  const args = buildRunArgs(
    spec({ mounts: [{ host: "/opt/services/x", at: "/x", ro: true }, { host: "/opt/services/y", at: "/y", ro: false }] }),
  );
  assert.ok(args.includes("/mnt/usb/catman_data/cron/work/j_1:/work"), "工作目录用宿主路径,且不加 :ro");
  assert.ok(args.includes("/opt/services/x:/x:ro"));
  assert.ok(args.includes("/opt/services/y:/y"), "显式 ro:false 才可写");
  assert.equal(valueOf(args, "-w"), "/work");
});

test("镜像与命令排在最后,命令原样透传(不过 shell)", () => {
  const args = buildRunArgs(spec({ cmd: ["bash", "-lc", "echo 'a b' && ls"] }));
  const i = args.indexOf("catman-env:1");
  assert.deepEqual(args.slice(i), ["catman-env:1", "bash", "-lc", "echo 'a b' && ls"]);
});

test("env 逐项传,不拼成一串", () => {
  const args = buildRunArgs(spec({ env: { FOO: "bar", BAZ: "带空格 的值" } }));
  assert.ok(args.includes("FOO=bar"));
  assert.ok(args.includes("BAZ=带空格 的值"));
});

test("容器名合法:小写、可读、带得出任务与那一次", () => {
  const name = containerNameFor("j_7k2m", "20260813T081500Z-ab12");
  assert.match(name, /^[a-z0-9][a-z0-9_.-]*$/, "docker 对容器名有字符集要求");
  assert.ok(name.includes("j_7k2m"));
});

// ── 代理透传 ────────────────────────────────────────────────────────

const PROXY = {
  HTTP_PROXY: "http://192.168.1.95:1088",
  HTTPS_PROXY: "http://192.168.1.95:1088",
  NO_PROXY: "localhost,127.0.0.1,catman,10.0.0.0/8",
  http_proxy: "http://192.168.1.95:1088",
  https_proxy: "http://192.168.1.95:1088",
  no_proxy: "localhost,127.0.0.1,catman,10.0.0.0/8",
};

test("联网的任务拿到全部六个代理变量 —— NO_PROXY 少一个就掉进 503 陷阱", () => {
  const args = buildRunArgs(spec({ network: "mynet", proxyEnv: PROXY }));
  for (const [k, v] of Object.entries(PROXY)) {
    assert.ok(args.includes(`${k}=${v}`), `少了 ${k}`);
  }
  // 大小写各一份:curl 的 http_proxy 只认小写、HTTPS_PROXY 只认大写。
  assert.ok(args.includes(`http_proxy=${PROXY.http_proxy}`));
  assert.ok(args.includes(`HTTPS_PROXY=${PROXY.HTTPS_PROXY}`));
  // NO_PROXY 是重点:只给代理地址不给排除名单,任务打内网会收到代理回的 503,
  // 而那看起来完全像目标服务坏了。
  assert.ok(args.includes(`NO_PROXY=${PROXY.NO_PROXY}`));
  assert.ok(args.includes(`no_proxy=${PROXY.no_proxy}`));
});

test("断网的任务一个代理变量都不给 —— 摆在那儿只会让排错多绕一圈", () => {
  const args = buildRunArgs(spec({ network: "none", proxyEnv: PROXY }));
  assert.ok(!args.some((a) => a.startsWith("HTTP_PROXY=")));
  assert.ok(!args.some((a) => a.startsWith("NO_PROXY=")));
});

test("任务自己写了同名变量就听他的(与 TZ 同一条规矩)", () => {
  const args = buildRunArgs(
    spec({ network: "mynet", proxyEnv: PROXY, env: { HTTP_PROXY: "http://自己的:8080" } }),
  );
  assert.ok(args.includes("HTTP_PROXY=http://自己的:8080"));
  assert.ok(!args.includes(`HTTP_PROXY=${PROXY.HTTP_PROXY}`));
  // 只覆盖他写了的那一个,别的照给 —— 否则他补一个代理就把 NO_PROXY 弄丢了。
  assert.ok(args.includes(`NO_PROXY=${PROXY.NO_PROXY}`));
});

test("没配代理的机器上不多传任何东西", () => {
  const args = buildRunArgs(spec({ network: "mynet" }));
  assert.ok(!args.some((a) => a.includes("PROXY") || a.includes("proxy")));
});

test("collectProxyEnv:只摘那六个,空值按未设处理", () => {
  const got = collectProxyEnv({
    HTTP_PROXY: "http://p:1",
    HTTPS_PROXY: "",
    no_proxy: "localhost",
    PATH: "/usr/bin",
    CATMAN_ADMIN_TOKEN: "秘密",
  });
  assert.deepEqual(got, { HTTP_PROXY: "http://p:1", no_proxy: "localhost" });
  // 空串不能透传成 HTTPS_PROXY="":有些程序会把它当成"配了一个空代理"。
  assert.ok(!("HTTPS_PROXY" in got));
  // 顺带钉一下别把无关的东西(尤其是凭据)一起摘走。
  assert.ok(!("CATMAN_ADMIN_TOKEN" in got));
});
