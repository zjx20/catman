import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SESSION_LIMITS,
  PASS_THROUGH_ENV,
  SESSION_LABEL,
  buildSessionRunArgs,
  buildWrapperScript,
  claudePathIn,
  sessionContainerName,
  type SessionContainerSpec,
} from "../src/core/session-container.js";

/**
 * 会话容器的隔离闸门。
 *
 * 与 `cron-docker.test.ts` 同一条理由:这串 `docker run` 参数里有一半是防护,
 * 而防护出错的方式是"照跑不误,只是没有防护" —— 没有任何症状,只能靠断言钉住。
 * 少一个 `--memory` 就等于这整个 feature 白做,而你要等到下一次路由器被搞挂
 * 才会发现。
 */

const spec: SessionContainerSpec = {
  container: "catman-session-test",
  image: "catman-env:1",
  claudePath: "/rel/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
  limits: DEFAULT_SESSION_LIMITS,
  mounts: [
    { host: "/mnt/usb/catman_data/releases/abc", at: "/rel", ro: true },
    { host: "/mnt/usb/catman_data/workspace/u1", at: "/data/workspace/u1" },
  ],
  cwd: "/data/workspace/u1",
  passEnv: [...PASS_THROUGH_ENV],
  tz: "Asia/Shanghai",
  user: "10001:10001",
  groupAdd: [32768],
  addHosts: ["host.docker.internal:host-gateway"],
};

const argsOf = (s = spec) => buildSessionRunArgs(s);
/** 取某个 flag 紧跟着的那个值。 */
const valueAfter = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

test("三个资源上限一个都不能少", () => {
  const a = argsOf();
  assert.equal(valueAfter(a, "--memory"), "700m");
  assert.equal(valueAfter(a, "--cpus"), "1.5");
  assert.equal(valueAfter(a, "--pids-limit"), "256");
});

test("--memory-swap 必须等于 --memory", () => {
  // 宿主没有 swap。不给 --memory-swap 的话 docker 允许它用等量的 swap,
  // 而"没有 swap"这件事让这个限制看起来生效、实际上边界模糊。
  const a = argsOf();
  assert.equal(valueAfter(a, "--memory-swap"), valueAfter(a, "--memory"));
});

test("默认上限是 700m —— 改它要连着改这条用例", () => {
  // 这个数是管理员按"claude 常态 RSS 约 293MB + 留 400MB 干活"拍的,
  // 而且所有并发会话的上限之和必须小于宿主内存。不是随手可调的旋钮。
  assert.equal(DEFAULT_SESSION_LIMITS.memory, "700m");
});

test("cwd 在容器内外是同一个路径", () => {
  // SDK 用 cwd 决定会话 JSONL 写进哪个 project 目录。两边不一致的话 resume
  // 找不到上一段 —— 表现为"助手失忆",而且没有任何报错。
  const a = argsOf();
  assert.equal(valueAfter(a, "-w"), spec.cwd);
  assert.ok(a.includes(`-v`) && a.some((x) => x.endsWith(`:${spec.cwd}`)));
});

test("透传环境变量用 `-e NAME` 而不是 `-e NAME=值`", () => {
  // 值写进 argv 的话,OAuth token 会出现在 `docker inspect` 和宿主的 ps 里。
  // 不带 = 时 docker 从当前进程环境取值,argv 里只有名字。
  const a = argsOf();
  for (const name of PASS_THROUGH_ENV) {
    assert.ok(a.includes(name), `缺少透传 ${name}`);
    assert.ok(!a.some((x) => x.startsWith(`${name}=`)), `${name} 的值不该进 argv`);
  }
});

test("SDK 对表要用的那几个变量都在名单里", () => {
  // 这份名单是拿探针从真实调用里抄的。少一个就是"大脑起不来"而且报错含糊,
  // 排查起来要从 SDK 内部往回追。
  for (const must of [
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CONFIG_DIR",
  ]) {
    assert.ok((PASS_THROUGH_ENV as readonly string[]).includes(must), `名单缺 ${must}`);
  }
});

test("带 --rm 和 -i,不带 -t", () => {
  const a = argsOf();
  assert.ok(a.includes("--rm"));
  assert.ok(a.includes("-i")); // stream-json 走 stdin,没有它整条管道是死的
  assert.ok(!a.includes("-t")); // 分配 tty 会把 stream-json 弄脏
});

test("--init 与 TINI_SUBREAPER 必须成对出现", () => {
  // catman-env 的 ENTRYPOINT 本身就是 tini,加了 --init 就有两个。里面那个发现
  // 自己不是 PID 1 会往 stderr 打三行告警 —— 而 stderr 是 SDK 报错的唯一去处,
  // 那三行会把真正的错误淹掉。(cron 那边真机踩过。)
  const a = argsOf();
  assert.ok(a.includes("--init"));
  assert.ok(a.includes("TINI_SUBREAPER=1"));
});

test("带标签,好让孤儿容器认得回来", () => {
  const a = argsOf();
  assert.ok(a.some((x) => x === `${SESSION_LABEL}=1`));
});

test("容器日志有上限", () => {
  // 话痨的大脑能把宿主磁盘写满,而磁盘满会让 dockerd 全面异常 ——
  // 那时候连回滚都做不了。
  const a = argsOf();
  assert.ok(a.includes("max-size=8m"));
});

test("只读挂载带 :ro,可写的不带", () => {
  const a = argsOf();
  assert.ok(a.includes("/mnt/usb/catman_data/releases/abc:/rel:ro"));
  assert.ok(a.includes("/mnt/usb/catman_data/workspace/u1:/data/workspace/u1"));
});

test("最后两项是镜像和大脑二进制的路径", () => {
  const a = argsOf();
  assert.equal(a[a.length - 2], spec.image);
  assert.equal(a[a.length - 1], spec.claudePath);
});

test("包装脚本用 exec,并把 SDK 的参数原样转发", () => {
  // 必须 exec:中间多一层 shell 的话,SDK 的 abort 杀掉的是 shell,
  // docker 客户端会留下来。而客户端死掉也不会带走容器(实测),
  // 这正是 95% 那一级必须用 cgroup.kill 的原因。
  const s = buildWrapperScript(["run", "--rm", "img"]);
  assert.match(s, /^#!\/bin\/sh/);
  assert.match(s, /^exec docker /m);
  assert.match(s, /"\$@"/); // 七个 flag 原样转发
});

test("包装脚本对带单引号的参数做转义", () => {
  const s = buildWrapperScript(["-e", "X=it's"]);
  assert.ok(!/[^\\]'[^\\']*'[^\\']*'\s*$/.test(s.split("\n")[3] ?? ""));
  assert.match(s, /it/);
});

test("容器名对付得了 userKey 里的特殊字符", () => {
  // 真实 userKey 长这样:wechat:bc8a2ed2:o9cq…@im.wechat —— 冒号和 @ 都不是
  // 合法容器名字符,不处理的话 docker run 直接失败,而症状是"助手不回话"。
  const n = sessionContainerName("wechat:bc8a2ed2:o9cq80yCc7@im.wechat", "t1");
  assert.match(n, /^[a-z0-9][a-z0-9_.-]*$/);
  assert.ok(n.startsWith("catman-session-"));
});

test("大脑二进制的路径形状 —— 拼错的症状是「容器起来又立刻退出」", () => {
  // 上一版在这条链上栽过一次(依赖了一个不存在的环境变量),所以路径这一段
  // 单独钉住。`linux-x64` 是 glibc 那个变体,与 catman-env 的 Debian 底配套;
  // 哪天镜像换成 musl 底,这条用例会提醒你这里也要跟着改。
  assert.equal(
    claudePathIn("/data/releases/abc"),
    "/data/releases/abc/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
  );
});

test("必须带 --user —— 不给就是 root,建出来的文件 catman 改不动", () => {
  // 漏掉它的症状极其安静:回合照跑、结果照出,只是工作区里慢慢积满 root 属主的
  // 文件,直到某天助手说"改不了这个文件"而没人知道为什么。
  const a = argsOf();
  assert.equal(valueAfter(a, "--user"), "10001:10001");
});

test("必须带 --group-add —— 少了它容器里的 docker 全是 permission denied", () => {
  // docker.sock 在这台机器上是 root:32768 权限 660。助手日常就在用 docker,
  // 少这一个组等于把它的手绑上,而报错只有一句 permission denied。
  const a = argsOf();
  const i = a.indexOf("--group-add");
  assert.ok(i >= 0, "缺 --group-add");
  assert.equal(a[i + 1], "32768");
});

test("六个代理变量一个都不能少 —— 少了每个回合都会失败", () => {
  // 这是漏掉代价最大的一组:实测不带代理直连 api.anthropic.com 是 403,
  // 于是整个助手停摆。而且 NO_PROXY 也必须在,少了它打内网会收到代理发的 503,
  // 看起来完全像目标服务坏了。
  for (const v of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
    assert.ok((PASS_THROUGH_ENV as readonly string[]).includes(v), `代理变量名单缺 ${v}`);
  }
});

test("host.docker.internal 的映射跟 catman 自己保持一致", () => {
  const a = argsOf();
  assert.ok(a.includes("host.docker.internal:host-gateway"));
});
