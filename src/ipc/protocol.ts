import { SUPPORTED_IMAGE_TYPES, type ImageMediaType } from "../core/attachments.js";

/**
 * 信使 ⇄ 人格之间的 IPC 契约。
 *
 * ## 为什么它必须是契约
 *
 * 写它的两端**版本可以差几十个**:信使跑人工钦定的 pinned release(改它属 Tier 3),
 * 人格跑 `releases/current`、每周被自动进化改一遍。所以与部署报告同一条纪律 ——
 * **字段只增不改**,读取端一律防御式解析,读不懂就当没有。
 *
 * 但这里比部署报告还要紧一层:报告读不懂只是少播一条,**IPC 读不懂等于聋**。
 * 所以多两条规矩:
 *
 * 1. **解析失败要 NACK,不能静默丢。** 人格对读不懂的入站消息回 NACK,信使计入投递
 *    失败并亮红灯 —— 契约漂移的表现必须是"红灯",而不是"消息神秘消失"。
 * 2. **golden 字面样例测试。** 仓内两端的单测会跟着改动一起改,同步改完照样全绿,
 *    唯有钉死字面 JSON 的用例挡得住 —— 它是"我改的是不是破坏性变更"的唯一提问者。
 *
 * ## 传输
 *
 * HTTP over unix socket。零依赖(`node:http` 原生支持 `listen(path)` 与
 * `request({socketPath})`),而且**不占端口、不暴露给 compose 网络** —— 部署环境里
 * 常有别的服务接在同一个 docker 网络上,起 TCP 就等于把信使的控制面递给它们。
 *
 * ## 身份
 *
 * **由凭据推出,不读请求体里声称的身份。** 每个人格一份 secret,信使按 secret 反查
 * 它是谁 —— 于是"伪造 /send 冒充守护人格"和"伪造 ack 吞掉别人的消息"两条路都被封死。
 *
 * 设计原文说的是"按连接来源判定"。落地时做不到:两个人格以**同一个 uid** 跑,
 * socket 文件在共享卷上,文件权限区分不了它们。如实记为偏差 —— 换来的保证略弱
 * (secret 泄漏即可冒充),所以 secret 照搬 `CATMAN_ADMIN_TOKEN` 的 childEnv 剔除
 * 不变量:任何用户回合的子进程都拿不到它,含 admin 回合。
 */

/** 契约版本。字段只增不改;真要改语义就升它,并同步 bless 一份新信使。 */
export const IPC_SCHEMA = 1;

/** 人格标识。信使给每个人格一个独立的 inbox 与一份 secret。 */
export const PERSONA_IDS = ["primary", "rescue"] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];

export function parsePersonaId(v: unknown): PersonaId | undefined {
  return typeof v === "string" && (PERSONA_IDS as readonly string[]).includes(v)
    ? (v as PersonaId)
    : undefined;
}

/**
 * 出站消息的类别。**发送预算按类别预留**,所以这不是装饰性的标签 ——
 * 见 courier/reply-store.ts 那笔账。
 */
export const SEND_KINDS = [
  /** "收到,正在处理中…" 的回执。 */
  "ack",
  /** 回合中途的进度。**唯一会被预算挤掉的一类**。 */
  "progress",
  /** 模型的答复正文。永远走保留额。 */
  "body",
  /** 会话空闲提醒。永远走保留额。 */
  "reminder",
  /** 人格不可达时由信使自己回的那句话。走保留额。 */
  "fallback",
  /** 部署结果播报。走保留额。 */
  "announce",
] as const;
export type SendKind = (typeof SEND_KINDS)[number];

export function parseSendKind(v: unknown): SendKind | undefined {
  return typeof v === "string" && (SEND_KINDS as readonly string[]).includes(v)
    ? (v as SendKind)
    : undefined;
}

/**
 * 附件引用。**IPC 里只传引用,字节落盘。**
 *
 * 一张图 base64 之后好几 MB,而部署窗口里可能积压着全体用户的消息 —— 让那些字节
 * 驻留在信使的内存队列里,等于让**最不该 OOM 的那个进程**去扛峰值。信使把解密后的
 * 字节写进 spool 目录(0600),人格按 id 去读,信使在 ack 之后清理。
 */
export interface AttachmentRef {
  /** spool 目录下的文件名。人格只读,清理由信使做。 */
  readonly id: string;
  readonly mediaType: ImageMediaType;
  readonly bytes: number;
}

/** 一条待处理的入站消息。 */
export interface InboundEnvelope {
  readonly schema: number;
  /** 幂等去重键。at-least-once 投递下,人格靠它认出"这条我处理过了"。 */
  readonly msgId: string;
  readonly userKey: string;
  readonly text: string;
  readonly attachmentRefs: readonly AttachmentRef[];
  /**
   * 这个 userKey 之前收过使用指引没有。
   *
   * **判定权在信使**:它是唯一见过该 userKey 全部历史的进程。放在人格里的话,
   * 用户第一次 `/救援` 会收到守护人格的整份欢迎语 —— 而那份预算本该留给正事。
   */
  readonly greeted: boolean;
  /** 信使收到这条消息的时刻(ms)。 */
  readonly ts: number;
}

/** 控制帧:信使让人格做一件与消息无关的事。 */
export interface ControlEnvelope {
  readonly schema: number;
  /** `detach`:这个用户被切到别的人格了,把他的在飞回合转后台。 */
  readonly type: "detach";
  readonly userKey: string;
}

/** 一次拉取的结果。控制帧与消息同批返回,**控制帧先应用**。 */
export interface PullResponse {
  readonly schema: number;
  readonly controls: readonly ControlEnvelope[];
  readonly messages: readonly InboundEnvelope[];
}

/** 人格要求信使发一条消息。 */
export interface OutboundEnvelope {
  readonly schema: number;
  readonly userKey: string;
  readonly kind: SendKind;
  readonly text: string;
}

/** 发送结果。 */
export interface SendResult {
  readonly schema: number;
  readonly ok: boolean;
  /** 支持撤回的渠道会给一个 id。 */
  readonly messageId?: string;
  /**
   * 这条来信的 `context_token` 还能再发几条**进度**。
   *
   * 人格的 `ProgressThrottle` 据此收缩 —— 它不再假设自己独占整份预算,
   * 因为守护人格可能也在往同一个 token 发东西。
   */
  readonly remainingProgress: number;
  /** 失败时给人看的原因。 */
  readonly reason?: string;
}

// ── 防御式解析 ────────────────────────────────────────────────────
// 一律"读不懂返回 undefined",由调用方决定是 NACK 还是丢弃。
// 与 settings.ts 的 `parse()`、deploy-report.ts 的 `parseDeployReport` 同一纪律。

function str(r: Record<string, unknown>, k: string): string | undefined {
  const v = r[k];
  return typeof v === "string" && v ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function parseAttachmentRef(v: unknown): AttachmentRef | undefined {
  const r = obj(v);
  if (!r) return undefined;
  const id = str(r, "id");
  const mediaType = r["mediaType"];
  const bytes = r["bytes"];
  if (!id) return undefined;
  // **id 必须是安全的文件名**:它会被拼进 spool 路径去读文件,`../` 就能读到
  // spool 之外。这一层是解析器,越界的引用在这里就该消失,而不是指望调用方记得校验。
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return undefined;
  if (typeof mediaType !== "string") return undefined;
  if (!(SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mediaType)) return undefined;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return undefined;
  return { id, mediaType: mediaType as ImageMediaType, bytes: Math.floor(bytes) };
}

export function parseInbound(v: unknown): InboundEnvelope | undefined {
  const r = obj(v);
  if (!r) return undefined;
  const msgId = str(r, "msgId");
  const userKey = str(r, "userKey");
  if (!msgId || !userKey) return undefined;

  const text = typeof r["text"] === "string" ? r["text"] : "";
  const rawRefs = Array.isArray(r["attachmentRefs"]) ? (r["attachmentRefs"] as unknown[]) : [];
  // **单个坏引用只丢它自己**,不丢整条消息:文字与其余图片照常送达。整条消息因为
  // 一张图挂掉,在用户那边就是"发了没反应"—— 与渠道侧那条纪律完全一致。
  const attachmentRefs = rawRefs
    .map(parseAttachmentRef)
    .filter((x): x is AttachmentRef => x !== undefined);
  if (!text && !attachmentRefs.length) return undefined;

  const ts = r["ts"];
  return {
    schema: typeof r["schema"] === "number" ? r["schema"] : IPC_SCHEMA,
    msgId,
    userKey,
    text,
    attachmentRefs,
    greeted: r["greeted"] === true,
    ts: typeof ts === "number" && Number.isFinite(ts) ? ts : 0,
  };
}

export function parseControl(v: unknown): ControlEnvelope | undefined {
  const r = obj(v);
  if (!r) return undefined;
  const userKey = str(r, "userKey");
  if (!userKey) return undefined;
  // 未来版本可能加别的控制帧类型;**认不出的一律丢弃而不是报错** ——
  // 旧人格遇到新控制帧应当"不做这件事",而不是把整批拉取判成解析失败。
  if (r["type"] !== "detach") return undefined;
  return {
    schema: typeof r["schema"] === "number" ? r["schema"] : IPC_SCHEMA,
    type: "detach",
    userKey,
  };
}

/**
 * 解析一次拉取的结果。
 *
 * 与单条消息不同,这里**整体读不懂才返回 undefined**;单条坏消息由调用方按
 * NACK 处理。所以返回值里额外带上"有几条没解析出来",让 bridge 能把它们 NACK 掉 ——
 * 静默丢弃会让契约漂移表现为"消息神秘消失",而那是最难查的一种。
 */
export interface ParsedPull {
  readonly controls: readonly ControlEnvelope[];
  readonly messages: readonly InboundEnvelope[];
  /** 解析失败的条目里能认出 msgId 的那些,交给调用方 NACK。 */
  readonly badMsgIds: readonly string[];
  /** 解析失败但连 msgId 都认不出的条数 —— 只能计数告警。 */
  readonly unparsable: number;
}

export function parsePull(v: unknown): ParsedPull | undefined {
  const r = obj(v);
  if (!r) return undefined;
  const rawMsgs = Array.isArray(r["messages"]) ? (r["messages"] as unknown[]) : [];
  const rawCtrls = Array.isArray(r["controls"]) ? (r["controls"] as unknown[]) : [];

  const messages: InboundEnvelope[] = [];
  const badMsgIds: string[] = [];
  let unparsable = 0;
  for (const raw of rawMsgs) {
    const parsed = parseInbound(raw);
    if (parsed) {
      messages.push(parsed);
      continue;
    }
    const id = obj(raw) ? str(obj(raw)!, "msgId") : undefined;
    if (id) badMsgIds.push(id);
    else unparsable += 1;
  }
  const controls = rawCtrls
    .map(parseControl)
    .filter((x): x is ControlEnvelope => x !== undefined);
  return { controls, messages, badMsgIds, unparsable };
}

export function parseOutbound(v: unknown): OutboundEnvelope | undefined {
  const r = obj(v);
  if (!r) return undefined;
  const userKey = str(r, "userKey");
  const kind = parseSendKind(r["kind"]);
  const text = r["text"];
  if (!userKey || !kind) return undefined;
  if (typeof text !== "string" || !text) return undefined;
  return {
    schema: typeof r["schema"] === "number" ? r["schema"] : IPC_SCHEMA,
    userKey,
    kind,
    text,
  };
}

export function parseSendResult(v: unknown): SendResult | undefined {
  const r = obj(v);
  if (!r) return undefined;
  if (typeof r["ok"] !== "boolean") return undefined;
  const rem = r["remainingProgress"];
  return {
    schema: typeof r["schema"] === "number" ? r["schema"] : IPC_SCHEMA,
    ok: r["ok"],
    ...(str(r, "messageId") ? { messageId: str(r, "messageId")! } : {}),
    // 读不出剩余额度时按 0 处理:**宁可不发进度,也不能超发**。超发的后果是
    // `ret=-2 prepare failed` 且永不恢复 —— 连正文都发不出去,用户彻底静默。
    remainingProgress: typeof rem === "number" && Number.isFinite(rem) ? Math.max(0, rem) : 0,
    ...(str(r, "reason") ? { reason: str(r, "reason")! } : {}),
  };
}

/** ack / nack 的请求体。 */
export interface AckEnvelope {
  readonly schema: number;
  readonly msgIds: readonly string[];
  /** nack 才有:为什么没消化掉。 */
  readonly reason?: string;
}

export function parseAck(v: unknown): AckEnvelope | undefined {
  const r = obj(v);
  if (!r) return undefined;
  const raw = r["msgIds"];
  if (!Array.isArray(raw)) return undefined;
  const msgIds = raw.filter((x): x is string => typeof x === "string" && !!x);
  return {
    schema: typeof r["schema"] === "number" ? r["schema"] : IPC_SCHEMA,
    msgIds,
    ...(str(r, "reason") ? { reason: str(r, "reason")! } : {}),
  };
}

/**
 * 按 secret 反查人格身份。
 *
 * 纯函数,所以"伪造身份"这条路能被单测直接钉住。**空 secret 一律拒绝** ——
 * 否则一个忘了配 env 的人格会以空串匹配上另一个忘了配的,两个 inbox 就串了。
 */
export function resolvePersona(
  secret: string | undefined,
  secrets: ReadonlyMap<string, PersonaId>,
): PersonaId | undefined {
  if (!secret) return undefined;
  return secrets.get(secret);
}

/** secret 的最短长度。不是密码学要求,是挡住 `IPC_SECRET=1` 这种随手值。 */
export const MIN_IPC_SECRET_LEN = 8;

/**
 * secret 能不能用。
 *
 * **必须是可打印 ASCII 且不含空白** —— 它要进 HTTP 请求头,而头只能是 latin-1:
 * 一个中文 secret 会让客户端在**发出请求之前**就抛 `ERR_INVALID_CHAR`,症状是
 * 人格每次 IPC 都崩,而报错跟"你在 .env 里写了中文"隔着好几层。
 *
 * 所以这道检查放在**装配时**:起不来好过起来了每次调用都炸,而且那时人正看着日志。
 */
export function checkIpcSecret(secret: string | undefined): string | undefined {
  if (!secret) return "没有配置(空)";
  if (secret.length < MIN_IPC_SECRET_LEN) {
    return `太短(${secret.length} 字符,至少 ${MIN_IPC_SECRET_LEN})`;
  }
  // eslint-disable-next-line no-control-regex
  if (!/^[\x21-\x7e]+$/.test(secret)) {
    return "只能用可打印的 ASCII 字符且不含空格 —— 它要进 HTTP 请求头,非 ASCII 会让客户端直接抛错";
  }
  return undefined;
}
