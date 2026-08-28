import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Accepted, Channel, ChannelHealth, MessageHandler } from "./types.js";
import { WECHAT_CHANNEL } from "./ilink-protocol.js";
import type { Attachment } from "../core/attachments.js";
import type { CourierLink } from "../ipc/client.js";
import type { AttachmentRef, InboundEnvelope, SendKind } from "../ipc/protocol.js";

/**
 * 人格这一侧的微信渠道 —— 真正的连接在信使里,这里只是一根管子。
 *
 * ## 为什么 name 仍然是 "wechat"
 *
 * `Channel.name` **必须等于该渠道产出的 userKey 第一段**(真机踩过:两处写岔的话
 * 准入、入队、agent 全都正常,只有最后 send 那一步抛「没有能处理 X 的渠道」,
 * 额度已经花掉而用户那边彻底没反应)。userKey 由信使拼、以 `wechat:` 开头,
 * 所以这里也必须是 `WECHAT_CHANNEL` —— 两处引用同一个常量,使写岔不可能发生。
 *
 * ## 拉取与投递是**两条循环**
 *
 * 一开始它们是一条:拉到消息就 `await handler(...)`,回来再拉下一轮。那是错的 ——
 * `handler` 等的是 `gateway.dispatch`,而它 resolve 的时机是**这批起的回合跑完**。
 * 于是一个长回合期间人格根本不再拉取,三件事同时坏掉,而且全是拆进程之后**新出现**的:
 *
 *   - **detach 在它唯一该起作用的场景里送不到**:主人格正跑一个长回合(或卡死),
 *     用户发 `/救援` —— 路由已经切走,而人格要等那个**本该被 detach 的回合**跑完
 *     才来取控制帧。期间那一轮的正文照发,且没有出处前缀。
 *   - **信使的"不可达"误判会波及所有人**:它判的是 `lastPull`,而长回合期间没人拉。
 *     一个用户的长回合会让**其他每个人**收到一句"主人格没有响应",各吃掉一条保留额。
 *   - `health().live` 在健康回合期间翻假 —— 它替换掉的 `wechat-ilink.health()`
 *     用的是"有没有没失效的连接",不含这个耦合,属于回归。
 *
 * 所以:`pullLoop` 只管拉取、**立刻**应用控制帧、把消息塞进本地队列;
 * `deliverLoop` 串行地投递。顺序仍然严格(本地队列 FIFO + 串行投递),
 * 只是它不再挡着拉取。
 *
 * ## 投递也不等回合 —— 否则中途插话根本无从谈起
 *
 * 拆出 `deliverLoop` 只治好了"拉取"那一半。投递这一半还在 `await handler(...)`,
 * 而它 resolve 的时机同样是**回合跑完**:于是长回合期间消息拉得进本地队列、
 * 投不进网关,和从前一样堵着,只是堵的位置换了个地方。网关备好的追加通道
 * (`AgentFeed`)要求消息在回合还跑着的时候到达,而这道闸保证了它永远不会 ——
 * 真机日志里「追加输入」一行都没有,原因就在这里。
 *
 * 现在 `handler` **同步返回**(见 `Accepted`),含义是"落进网关了",投递链拿到
 * 它就接着投下一条。等回合跑完的那个 promise 交给 ack 去等。
 *
 * ## 另外两条不能改的
 *
 * ① **控制帧先于同一批的消息应用。** `detach` 说的是"这个用户已经不归你了"。
 * ② **同步逐条投递。** 微信的「图 + 文字」是两条相隔约 120ms 的消息,顺序即语义。
 *    信使侧"下载完成才入队"与这里的"串行投递"是同一个保证在新边界上的两半。
 *
 * ## ack 的时机:仍然等回合跑完,但**不占着投递链**
 *
 * 提前 ack 的代价是进程被杀时那条消息真丢(而且现在的窗口不是聚合那 1.5 秒,
 * 是整个回合),所以这条保守的一侧值得留着 —— 只是它不该顺便把投递也钉住。
 * 于是:投递完就往下走,`settled` 兑现时才异步 ack。
 *
 * 在 ack 落地之前 msgId 一直留在 `queuedIds` 里,信使反复送来的同一条会被它
 * 挡掉(而不是走 `seen` 的补 ack —— 那等于替一个还没跑完的回合提前 ack)。
 * ack 失败才把它放回去,让下一次拉取重新走 `seen` 的补 ack 分支。
 */

/** 记住最近见过多少个 msgId 用于去重。够覆盖一次崩溃重放的整批,又不占内存。 */
const SEEN_LIMIT = 500;

/** 拉取失败后的退避。信使可能正在被人工 bless 重启,人格不该跟着崩。 */
const BACKOFF_MS = 3000;

/** 服务端挂起时长。客户端超时由 IpcClient 自己加余量 —— 别在这里各算一份。 */
const PULL_WAIT_MS = 25_000;

/** 空拉取之后的退让。正常情况下长轮询会挂满,立刻回空说明信使那边有状况。 */
const IDLE_MS = 200;

/** 同一条消息连续投递失败几次之后交回信使。够容忍一次抖动,又不至于把队列钉死。 */
const MAX_DELIVER_TRIES = 3;

/**
 * 投递重试的退避。**明显短于拉取的退避**:拉取退避等的是"信使起来",而这里等的是
 * "下一次投递可能就好了";而且**单 inbox** 意味着这条消息堵着的是所有人的后续消息,
 * 撞上限的总时长(次数 × 这个值)就是全体用户的堵塞时长。
 */
const DELIVER_BACKOFF_MS = 400;

/**
 * 关停时最多等多久让在飞的 ack 落地。
 *
 * 等的是"回合已经跑完、只差 ack 那一下"的那些 —— 漏掉它们等于让信使重放,
 * 而重放在用户那边就是同一句话被回答两遍。还没跑完的回合等不到,也不该等:
 * 那种情况下重放正是想要的处置。
 */
const ACK_DRAIN_MS = 2000;

export interface BridgeOptions {
  client: CourierLink;
  /** 附件 spool 目录(信使写、人格只读)。 */
  spoolDir: string;
  /**
   * 收到 detach 控制帧。接到网关的"把这个用户的在飞回合转后台"上。
   *
   * 不做成 `Channel` 接口的一部分:那是这条链路独有的东西,塞进接口会让每个渠道
   * 都要面对一个跟自己无关的概念。
   */
  onDetach?: (userKey: string) => void;
}

export class BridgeChannel implements Channel {
  readonly name = WECHAT_CHANNEL;

  private handler?: MessageHandler;
  private running = false;
  private loop?: Promise<void>;
  /** 见过的 msgId(有界)。at-least-once 投递下靠它把重复变成无害。 */
  private readonly seen = new Set<string>();
  /** 最近一次成功拉取的时刻。`live` 靠它 —— 连不上信使时渠道其实是聋的。 */
  private lastOk = 0;
  /** 等着投递的本地队列(FIFO)。拉取往里塞,投递链往外取。 */
  private readonly pending: InboundEnvelope[] = [];
  /**
   * 已在本地队列、正在投、或**投完还等着 ack** 的 id。未 ack 的消息会被反复
   * 拉到,靠它去重 —— 它覆盖到 ack 落地为止,这样回合跑着的那段时间里
   * 重复拉到的同一条不会走 `seen` 的补 ack(那等于替它提前签收)。
   */
  private readonly queuedIds = new Set<string>();
  /** 在飞的 ack(回合已收下、还没 ack 完)。关停时等它们一小会儿。 */
  private readonly acking = new Set<Promise<void>>();
  /** 每条消息连续投递失败了几次。 */
  private readonly failures = new Map<string, number>();
  /** 投不下去而交回信使的条数。非零就该显眼 —— 静默跳过等于没有隔离。 */
  private poisoned = 0;
  /** 在跑的投递链。 */
  private delivering?: Promise<void>;
  /** stop() 时要唤醒的那些 sleep。 */
  private stopping: Array<() => void> = [];

  constructor(private readonly opts: BridgeOptions) {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loop = this.pullLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    // 先把在退避里睡着的唤醒 —— 否则关闭要等满一个退避周期,而退避恰恰发生在
    // 最可能有人正在重启这个进程的时候。
    const wake = this.stopping;
    this.stopping = [];
    for (const w of wake) w();
    await this.loop?.catch(() => undefined);
    await this.delivering?.catch(() => undefined);
    // 已经跑完的回合把 ack 补上再走。ack 从投递链上摘下来之后就不在
    // `delivering` 里了,而关停时漏掉的那条会被信使重放 —— 用户看到的是
    // 同一句话被回答两遍,正是这个文件开头列为必须避免的那种症状。
    // **有上限**:还在跑的回合等不到,那种情况下重放本来就是对的处置。
    if (this.acking.size) {
      await Promise.race([
        Promise.all([...this.acking]).catch(() => undefined),
        new Promise((r) => setTimeout(r, ACK_DRAIN_MS)),
      ]);
    }
  }

  /** 投不下去而交回信使的条数,供 `/health` 与日志。 */
  get poisonedCount(): number {
    return this.poisoned;
  }

  /**
   * 把一条消息交给信使。
   *
   * **交出去就算数,不再问余量。** 额度是信使那一侧的事:发得出去它就发,
   * 发不出去它排队(courier/outbox.ts),两种都回 ok。这里曾经缓存过
   * `remainingProgress` 转给节流器用,那是"核心也得懂一点预算"的最后一块 ——
   * 现在核心一点都不懂,这块也就没有了。
   *
   * 回 `ok:false` 只剩下真正的坏事:信封读不懂、路由已经切走、信使不可达。
   * 那些是该抛的。
   */
  async send(userKey: string, text: string, kind: SendKind = "body"): Promise<void> {
    const r = await this.opts.client.send(userKey, text, kind);
    if (!r.ok) throw new Error(r.reason ?? "信使拒绝了这条消息");
  }

  /**
   * 「还在动」。转给信使,由它决定多久往微信打一次 —— 频率是渠道知识,
   * 人格这边只管报事实,爱推多密推多密。
   */
  async typing(userKey: string): Promise<void> {
    await this.opts.client.typing?.(userKey);
  }

  /**
   * 健康自述。`live` 要求**最近确实拉取成功过** —— 与 iLink 渠道那条同源:
   * "已启动"不等于"收得到消息",而部署的健康门正是靠这份自述判断新版本真的在服务。
   */
  health(): readonly ChannelHealth[] {
    const live = this.running && Date.now() - this.lastOk < PULL_WAIT_MS * 2;
    return [{ name: this.name, started: this.running, live }];
  }

  // --- 内部 ---

  private async pullLoop(): Promise<void> {
    while (this.running) {
      try {
        const pulled = await this.opts.client.pull(PULL_WAIT_MS);
        if (!pulled) {
          // 整个响应读不懂 —— 契约漂移最粗暴的形态。退避,别打爆信使。
          console.error("[bridge] 信使的拉取响应整体读不懂,退避重试");
          await this.sleep(BACKOFF_MS);
          continue;
        }
        // `lastOk` 只在**真拿到东西**之后刷新。拉取失败(比如 secret 对不上导致的
        // 401)时刷新它,会让 health() 对一个完全聋掉的人格照报 live,
        // 部署的健康门「渠道通不通」这一项就被骗过去了。
        this.lastOk = Date.now();

        // 控制帧立刻应用 —— 不排在投递后面,那正是上面说的那个耦合。
        for (const c of pulled.controls) {
          if (c.type === "detach") this.opts.onDetach?.(c.userKey);
        }

        if (pulled.badMsgIds.length || pulled.unparsable) {
          console.error(
            `[bridge] ${pulled.badMsgIds.length} 条读不懂(另有 ${pulled.unparsable} 条连 id 都认不出)`,
          );
          await this.opts.client
            .nack(pulled.badMsgIds, "人格解析不了这个信封")
            .catch((e) => console.warn(`[bridge] NACK 失败:${String(e)}`));
        }

        // 未 ack 的消息会被反复拉到,所以入本地队列前要同时躲开「已投递过」与
        // 「正排队/正在投」两种情况。
        let added = 0;
        const reAck: string[] = [];
        for (const m of pulled.messages) {
          if (this.queuedIds.has(m.msgId)) continue; // 已经在本地队列里等着
          if (this.seen.has(m.msgId)) {
            // 投过了却又被送来 —— 说明上次的 ack 没生效(信使重启、网络抖动)。
            // **必须再 ack 一次**,不能只是跳过:它是队头,不出队就把所有人的
            // 后续消息全堵在它后面,而且没有任何一轮会再动它。重复 ack 幂等。
            reAck.push(m.msgId);
            continue;
          }
          this.queuedIds.add(m.msgId);
          this.pending.push(m);
          added += 1;
        }
        if (reAck.length) {
          await this.opts.client
            .ack(reAck)
            .catch((e) => console.warn(`[bridge] 补 ack 失败:${String(e)}`));
        }
        if (added) this.startDelivering();
        // 什么都没拿到时退让一下:信使的长轮询正常情况下会挂满 waitMs,
        // 立刻回空只可能是它那边出了状况,紧密重拉只会让状况更糟。
        if (!added && !reAck.length && !pulled.controls.length) await this.sleep(IDLE_MS);
      } catch (err) {
        if (!this.running) break;
        // 信使不可达是**可以容忍**的:它跑 pinned release,人工 bless 时会重启。
        console.warn(`[bridge] 拉取失败,${BACKOFF_MS}ms 后重试:${String(err)}`);
        await this.sleep(BACKOFF_MS);
      }
    }
  }

  /** 起投递链(若还没在跑)。串行 —— 顺序即语义。 */
  private startDelivering(): void {
    if (this.delivering) return;
    this.delivering = this.deliverLoop().finally(() => {
      this.delivering = undefined;
    });
  }

  /**
   * 串行投递本地队列。
   *
   * **投递失败必须有出口。** 原先只是 `break`:不 ack、不 nack、不计数、不退避,
   * 而信使在队列非空时立刻返回 —— 两者相乘就是每秒上万次的热循环(实测两万次/秒),
   * 软路由上 CPU 打满、日志洪水把轮转刷穿,而且**单 inbox** 意味着所有用户的后续
   * 消息全堵在这一条后面。它替换掉的 `ilink-connection.pollLoop` 恰恰有这道闸。
   */
  private async deliverLoop(): Promise<void> {
    while (this.running && this.pending.length) {
      const m = this.pending[0]!;
      try {
        const accepted = this.deliver(m);
        this.pending.shift();
        this.failures.delete(m.msgId);
        // **不 await**:这里等的是回合跑完,而投递链一旦停在这儿,后面那条
        // 本该插进这个回合的话就再也送不到了 —— 那正是这次要修的东西。
        // msgId 留在 `queuedIds` 里直到 ack 落地,期间重复拉到的同一条被它挡掉。
        const acked = this.ackWhenSettled(m.msgId, accepted);
        this.acking.add(acked);
        void acked.finally(() => this.acking.delete(acked));
      } catch (err) {
        const n = (this.failures.get(m.msgId) ?? 0) + 1;
        this.failures.set(m.msgId, n);
        console.error(`[bridge] 投递 ${m.msgId} 第 ${n} 次失败:${String(err)}`);
        if (n >= MAX_DELIVER_TRIES) {
          // 反复投不下去的那条要让出位置,否则它把整条队列钉死。信使那边
          // 「出队 + 亮红灯」的语义本来就有,这里复用它 —— 丢一条并留下痕迹,
          // 好过所有人一起堵着。
          console.error(`[bridge] ${m.msgId} 连续失败 ${n} 次,交回信使记为投递失败`);
          this.pending.shift();
          this.queuedIds.delete(m.msgId);
          this.failures.delete(m.msgId);
          this.poisoned += 1;
          await this.opts.client
            .nack([m.msgId], `人格连续 ${n} 次投递失败`)
            .catch((e) => console.warn(`[bridge] NACK 失败:${String(e)}`));
        }
        await this.sleep(DELIVER_BACKOFF_MS);
      }
    }
  }

  /**
   * ack 排在回合后面,但**不排在投递前面**。
   *
   * 成功之前 msgId 一直占着 `queuedIds`,所以这段时间里信使重复送来的同一条
   * 会在 `pullLoop` 就被挡掉;ack 失败才把它放回去 —— 那时下一次拉取会走
   * `seen` 的补 ack 分支,而那时回合确实已经跑完了,补得心安理得。
   */
  private async ackWhenSettled(msgId: string, accepted: Accepted): Promise<void> {
    await accepted.settled;
    try {
      await this.opts.client.ack([msgId]);
    } catch (err) {
      console.warn(`[bridge] ${msgId} 回合跑完后 ack 失败,等下次拉取补上:${String(err)}`);
    } finally {
      // 成功与失败都要放开:失败那条要靠下一次拉取重新走 `seen` 的补 ack,
      // 一直占着 `queuedIds` 就等于让它永远出不了信使的队列。
      this.queuedIds.delete(msgId);
    }
  }

  /**
   * 把一条消息交给网关。**同步返回** —— 见 `Accepted`:等回合跑完的是 ack,
   * 不是投递链。
   */
  private deliver(m: InboundEnvelope): Accepted {
    if (this.seen.has(m.msgId)) {
      // 重复投递是 at-least-once 的正常代价(信使崩在"已入队、游标未落盘"之间时
      // 整批会重放)。**认出来直接跳过**,否则用户会看到同一句话被回答两次。
      // 照样要 ack —— 不出队的话它会被反复拉到。
      return { settled: Promise.resolve() };
    }
    const attachments = this.loadAttachments(m.attachmentRefs);
    const accepted = this.handler?.({
      userKey: m.userKey,
      msgId: m.msgId,
      text: m.text,
      // 信封里的 `greeted` 一路传到网关 —— 信使算了却没人消费的话,
      // 这个字段就只是协议里一句好看的空话(真机上正是如此:切到守护人格
      // 的第一句话必吃一整份欢迎语)。
      greeted: m.greeted,
      ...(attachments.length ? { attachments } : {}),
    });
    this.remember(m.msgId);
    // 没挂 handler(装配还没接线)时当作已处理:留在队列里也没人会来取。
    return accepted ?? { settled: Promise.resolve() };
  }

  /**
   * 按引用把附件字节读回来。
   *
   * **单张读不到只跳过它自己**,文字与其余图片照常投递 —— 与渠道侧那条纪律一致:
   * 整条消息因为一张图挂掉,在用户那边就是"发了没反应"。
   */
  private loadAttachments(refs: readonly AttachmentRef[]): Attachment[] {
    const out: Attachment[] = [];
    for (const ref of refs) {
      try {
        const bytes = readFileSync(join(this.opts.spoolDir, ref.id));
        out.push({
          kind: "image",
          mediaType: ref.mediaType,
          data: bytes.toString("base64"),
          bytes: bytes.length,
        });
      } catch (err) {
        console.warn(`[bridge] 读不到附件 ${ref.id},跳过这一张:${String(err)}`);
      }
    }
    return out;
  }

  private remember(msgId: string): void {
    this.seen.add(msgId);
    if (this.seen.size > SEEN_LIMIT) {
      // Set 保持插入顺序,删最早的那个。
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  /**
   * 可被 stop() 打断的 sleep。
   *
   * 不可打断的话,关闭会卡在一次退避里 —— 而退避恰恰发生在"信使不可达"或
   * "投递一直失败"的时候,也就是最可能有人正在重启这个进程的时候。
   * 与 ILinkConnection 的那个 sleep 同一个理由、同一种写法。
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.stopping.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
