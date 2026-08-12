import type { Attachment } from "../core/attachments.js";
import type { SendKind } from "../ipc/protocol.js";

/**
 * 聊天渠道抽象。网关只依赖这个接口,微信(iLink)、钉钉、stdin 测试通道
 * 各自实现它,互不影响会话核心逻辑。
 *
 * 渠道对外一律使用 **userKey**(`<channel>:<accountId>:<userId>`,见 core/identity.ts),
 * 而不是渠道内部的裸 userId:同一个 from_user_id 可能出现在两份不同的凭据下,
 * 只按裸 userId 路由会让两个人共用会话与工作目录。渠道实现负责在收消息时拼出
 * userKey、在发消息时按其中的 accountId 把消息投回正确的连接。
 */

export interface IncomingMessage {
  /** 全局唯一用户键 `<channel>:<accountId>:<userId>`。 */
  userKey: string;
  /**
   * 渠道给的**稳定**消息标识,用于跨重启去重。
   *
   * 可选:stdin 与 dashboard 这类渠道没有"同一条消息会被重放"的概念。有它的渠道
   * (iLink、bridge)必须保证**重放时与上一次相同** —— 用自增计数器生成的话,
   * 一次崩溃重放就会让同一句话被回答两次。
   */
  msgId?: string;
  /** 用户发来的文本。只发了图片时为空串。 */
  text: string;
  /**
   * 随消息带来的图片(见 core/attachments.ts)。渠道负责把自家协议的媒体消息
   * 还原成字节并校验;网关只管透传,Agent 层才把它翻成模型认识的格式。
   *
   * **text 与 attachments 可以任一为空,但不能同时为空** —— 网关据此判断这条
   * 消息是否值得处理。
   */
  attachments?: readonly Attachment[];
  /**
   * 渠道知道这个用户**早就收过使用指引**了。
   *
   * 只有 bridge 会给:判定权在信使,它是唯一见过某个 userKey 全部历史的进程。
   * 人格有好几个(主人格 + 守护人格)、各有各的 users.json,各自判断的结果是
   * 用户每切一次人格就收到一整份一模一样的欢迎语 —— 白烧一条发送预算。
   *
   * 缺席**不表示"没收过"**,只表示这个渠道没有这项知识(stdin / dashboard 就是),
   * 那时人格退回自己的记录判断。所以它只能用来**抑制**推送,不能用来触发。
   */
  greeted?: boolean;
}

/**
 * 网关**收下**一条消息之后交回的凭据。
 *
 * ## 为什么"收下"与"处理完"必须分开
 *
 * 它们以前是同一个 promise:`handler()` resolve 的时机是这批起的**回合跑完**。
 * 于是任何"投递完再投下一条"的渠道都被这个 promise 钉在原地 —— bridge 的
 * `deliverLoop` 正是如此,一个三分钟的回合期间它一条消息都投不进网关。
 * 后果不是"慢一点",而是**两个功能整个够不着**:
 *
 *   - **中途插话**:网关备好的追加通道(`AgentFeed`)要求消息在回合还跑着的时候
 *     到达。消息卡在渠道里等那个回合结束,追加窗口只在它够不到的时间里开着,
 *     于是那套机制一次都没被触发过 —— 用户看到的是"说了等于没说,得等它跑完"。
 *   - **消息聚合**:微信的「图 + 文字」是相隔约 120ms 的两条。第一条把渠道钉住,
 *     第二条进不来,1.5 秒的聚合窗口只等到了它自己 —— 攒消息形同虚设。
 *
 * 所以 `handler()` 现在**同步返回**,含义只有一个:这条消息已经落进网关
 * (聚合批 / 分拣链),渠道可以接着投下一条了。想知道"这批真的处理完了"
 * 的渠道去等 `settled`。
 */
export interface Accepted {
  /**
   * 这批消息处理完 —— 含它起的回合跑完。
   *
   * **绝不 reject**:回合内部已把异常都收敛成给用户的回复,而等它的人
   * (bridge 的延后 ack)不该因为一次回合失败就走进重试分支。
   */
  readonly settled: Promise<void>;
}

/**
 * 收到一条消息。**同步返回** —— 见 `Accepted` 上面那段:让渠道等回合跑完
 * 会把中途插话与消息聚合一起废掉。
 */
export type MessageHandler = (msg: IncomingMessage) => Accepted;

/**
 * 渠道的健康自述,供 `/health` 汇报、部署的健康门查验。
 *
 * **`started` 与 `live` 必须分开**:iLink 凭据失效(errcode=-14)的连接是
 * **故意不重启**的(它等的就是重新扫码),此刻渠道"已启动"却一条消息也收不到 ——
 * 只看 started 会把一个已经聋掉的系统报成健康,而部署的健康门正是靠这份自述
 * 判断"新版本真的在服务"。没有连接概念的渠道(stdin / dashboard)两者相等。
 */
export interface ChannelHealth {
  readonly name: string;
  readonly started: boolean;
  readonly live: boolean;
}

export interface Channel {
  /** 渠道名,用于日志与 dashboard 展示。 */
  readonly name: string;

  /** 注册收到消息时的回调。 */
  onMessage(handler: MessageHandler): void;

  /**
   * 这个用户**还能收几条进度**。
   *
   * 发送预算的权威在信使(`courier/reply-store.ts`),不在人格 —— 守护人格可能也在往
   * 同一个 `context_token` 发东西,两边各按自己的常量算就必然对不上。所以网关的
   * 进度节流器不再自带上限,改成每次现问渠道。
   *
   * **没有发送预算这个概念的渠道不要实现它**(stdin / dashboard):返回
   * `undefined` 表示"不设总量上限",那时唯一的节流是间隔阶梯,而那是对的。
   * 实现的渠道给的是**上一次发送响应**里的余量,所以允许落后一条 ——
   * 它只用来把"进度到此为止"这句话说在正确的时刻,真正的闸门在信使那边。
   */
  progressBudget?(userKey: string): number | undefined;

  /**
   * 主动向用户发送文本。实现方负责必要的分段。
   *
   * `kind` 是**发送预算按类别预留**的依据(见 courier/reply-store.ts):一个 iLink
   * context_token 只够发约 10 条,进度必须让位给正文、提醒与部署结果播报。
   * 没有预算概念的渠道(stdin / dashboard)忽略它即可。
   * 支持撤回的渠道应返回可传给 recall() 的消息 id;其余渠道返回 void 即可。
   * 注意:某些渠道(如微信 iLink)可能不支持"用户未先发消息时"的主动推送,
   * 这种情况下应 reject 或返回失败,由上层决定降级策略。
   */
  send(userKey: string, text: string, kind?: SendKind): Promise<string | void>;

  /**
   * 可选:撤回本渠道之前 send() 返回过 id 的消息。
   * 不支持撤回的渠道不实现该方法;上层须在调用前判断其存在,失败也应容忍。
   */
  recall?(userKey: string, messageId: string): Promise<void>;

  /**
   * 可选:自述健康状况(可能多条 —— 复合渠道会把各成员展开)。
   * 不实现的渠道在 `/health` 里不出现,而不是被当成健康。
   */
  health?(): readonly ChannelHealth[];

  /** 启动渠道(建立连接/开始轮询)。 */
  start(): Promise<void>;

  /** 优雅关闭。 */
  stop(): Promise<void>;
}
