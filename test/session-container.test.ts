import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SESSION_LIMITS,
  SESSION_LABEL,
  buildSessionImageArgs,
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

test("镜像与大脑路径由单独的函数给,不混在 flag 里", () => {
  // 拆开是因为环境变量要在运行时才拼得出来,而它们必须排在镜像**之前**。
  // 混在一起的话,包装脚本没法在中间插入 -e 参数。
  assert.deepEqual(buildSessionImageArgs(spec), [spec.image, spec.claudePath]);
  const a = argsOf();
  assert.ok(!a.includes(spec.image), "镜像不该出现在 flag 段里");
});

test("包装脚本用 exec,并把 SDK 的参数原样转发", () => {
  // 必须 exec:中间多一层 shell 的话,SDK 的 abort 杀掉的是 shell,
  // docker 客户端会留下来。而客户端死掉也不会带走容器(实测),
  // 这正是 95% 那一级必须用 cgroup.kill 的原因。
  const s = buildWrapperScript(["run", "--rm"], ["img", "/claude"]);
  assert.match(s, /^#!\/bin\/sh/);
  assert.match(s, /^exec docker /m);
  assert.match(s, /"\$@"/); // 七个 flag 原样转发
});

test("包装脚本对带单引号的参数做转义", () => {
  const s = buildWrapperScript(["-e", "X=it's"], ["img", "/claude"]);
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

test("host.docker.internal 的映射跟 catman 自己保持一致", () => {
  const a = argsOf();
  assert.ok(a.includes("host.docker.internal:host-gateway"));
});

test("包装脚本在运行时转发**全部**环境变量,而不是照白名单挑", () => {
  // 白名单栽过一次:网关的契约是「把 process.env 整个传下去,只剔两个密钥」,
  // 而照名单挑会让容器里悄悄少 12 个变量(PATH 少了 /data/bin → catman-notify
  // 直接 command not found;管理员少了 CATMAN_ADMIN_TOKEN)。每一个都是
  // 「能跑,只是某个功能没了」,要等踩到才知道。
  const s = buildWrapperScript(["run"], ["img", "/claude"]);
  assert.match(s, /for _k in \$\(env /); // 运行时枚举,不是编译期名单
  assert.match(s, /_e="\$_e -e \$_k"/); // 只传名字,值由 docker 从环境取
});

test("转发时挡掉 IPC 密钥 —— turn-env 刻意剔掉的,别在这里漏回去", () => {
  const s = buildWrapperScript(["run"], ["img", "/claude"]);
  assert.match(s, /CATMAN_IPC_SECRET\|/);
});

test("镜像与命令排在所有 flag 之后", () => {
  // docker run 的语法要求。顺序错了 docker 会把镜像名当成 flag 的值,
  // 报错含糊得很。
  const s = buildWrapperScript(["run", "--rm"], ["img", "/claude"]);
  const envLoop = s.indexOf("for _k in");
  const image = s.lastIndexOf("'img'");
  assert.ok(envLoop < image, "镜像必须排在环境变量转发之后");
});

test("SDK 传进来的 flag 必须活到最后 —— 别被攒参数的写法覆盖掉", () => {
  // 真机上写错过一次:用 `set --` 攒环境变量参数,把位置参数(也就是 SDK 的
  // 那七个 flag)整个覆盖了,症状是大脑拿不到 --output-format 直接起不来。
  // 所以脚本里不能出现 `set --`,而且 "$@" 必须排在镜像和命令**之后**。
  const s = buildWrapperScript(["run"], ["img", "/claude"]);
  assert.doesNotMatch(s, /^set -- /m, "不能用 set -- 攒参数,它会吃掉 SDK 的 flag");
  assert.match(s, /exec docker .*'img' '\/claude' "\$@"$/m);
});
