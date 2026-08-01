import type { Attachment } from "../core/attachments.js";

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

export interface Channel {
  /** 渠道名,用于日志与 dashboard 展示。 */
  readonly name: string;

  /** 注册收到消息时的回调。 */
  onMessage(handler: MessageHandler): void;

  /**
   * 主动向用户发送文本。实现方负责必要的分段。
   * 支持撤回的渠道应返回可传给 recall() 的消息 id;其余渠道返回 void 即可。
   * 注意:某些渠道(如微信 iLink)可能不支持"用户未先发消息时"的主动推送,
   * 这种情况下应 reject 或返回失败,由上层决定降级策略。
   */
  send(userKey: string, text: string): Promise<string | void>;

  /**
   * 可选:撤回本渠道之前 send() 返回过 id 的消息。
   * 不支持撤回的渠道不实现该方法;上层须在调用前判断其存在,失败也应容忍。
   */
  recall?(userKey: string, messageId: string): Promise<void>;

  /** 启动渠道(建立连接/开始轮询)。 */
  start(): Promise<void>;

  /** 优雅关闭。 */
  stop(): Promise<void>;
}
