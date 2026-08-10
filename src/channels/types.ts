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
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

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
