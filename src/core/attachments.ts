/**
 * 随消息带进来的二进制附件(目前只有图片)。
 *
 * 这一层刻意**不认识任何渠道、也不认识 Anthropic 的类型**:渠道负责把自家协议
 * 的媒体消息还原成字节交到这里,`core/agent.ts` 负责把它翻译成 SDK 的 content
 * block。中间隔着这个中立表示,新增渠道时不必知道 LLM 那侧长什么样。
 *
 * 校验放在这里而不是渠道里,是因为约束来自模型侧而非某个渠道 —— 每个渠道各写
 * 一份迟早会写歪。
 */

/**
 * 模型能接的图片格式。这四种是 `@anthropic-ai/sdk` 的 `Base64ImageSource.media_type`
 * 联合类型的全部取值 —— 改动前先去那个类型上确认,别照着记忆加。
 */
export const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type ImageMediaType = (typeof SUPPORTED_IMAGE_TYPES)[number];

export interface ImageAttachment {
  kind: "image";
  mediaType: ImageMediaType;
  /** 图片字节的 base64(不含 data: 前缀)。 */
  data: string;
  /** 原始字节数,用于日志与配额判断。 */
  bytes: number;
}

export type Attachment = ImageAttachment;

/**
 * 图片的两条闸门。**由调用方注入而不是写死在这里** —— 它们直接决定内存峰值
 * (base64 在内存里驻留整个回合)与图片 token 开销,软路由和 x86 主机的余量差得远,
 * 必须能按机器调。真相源是 `SETTING_SCHEMA` 的 maxImageBytes / maxImagesPerTurn。
 *
 * 关于 maxImageBytes 的量级:模型侧限制的是 **base64 之后**的大小(约 5MB),
 * base64 把体积放大到 4/3,所以原始字节的等效上限约 3.75MB —— schema 的默认值
 * 3.5MB 是在此之下留的余量。超限**直接拒收而不缩图**:本项目运行时零依赖
 * (见 CLAUDE.md),没有图像库可用,与其写个半吊子缩放不如把失败明确告诉用户。
 */
export interface AttachmentLimits {
  /** 单张图片的原始字节上限。 */
  maxImageBytes: number;
  /** 一条消息最多内联几张图,多的跳过。 */
  maxImagesPerTurn: number;
}

/**
 * 从字节的 magic number 判断图片格式,认不出来返回 undefined。
 *
 * 不信任渠道给的 MIME:iLink 的图片是从 CDN 解密出来的裸字节,协议里并没有
 * 可靠的格式声明。嗅探是唯一能保证 media_type 与实际内容一致的办法,而两者
 * 不一致时模型侧会直接报错。
 */
export function sniffImageMediaType(buf: Uint8Array): ImageMediaType | undefined {
  const at = (i: number) => buf[i];

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    at(0) === 0x89 &&
    at(1) === 0x50 &&
    at(2) === 0x4e &&
    at(3) === 0x47 &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (buf.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return "image/jpeg";
  }

  // GIF: "GIF8"
  if (
    buf.length >= 6 &&
    at(0) === 0x47 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x38
  ) {
    return "image/gif";
  }

  // WebP: "RIFF" ....(4 字节长度) "WEBP"
  if (
    buf.length >= 12 &&
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "image/webp";
  }

  return undefined;
}

/** 造附件失败的原因。渠道据此给用户一句人话,而不是静默丢弃。 */
export type AttachmentReject =
  | { reason: "too-large"; bytes: number; limit: number }
  | { reason: "unsupported-format" };

export type AttachmentResult =
  | { ok: true; attachment: ImageAttachment }
  | { ok: false; reject: AttachmentReject };

/** 把一段图片字节变成附件。格式与大小任一不过关就拒收。 */
export function toImageAttachment(buf: Uint8Array, limits: AttachmentLimits): AttachmentResult {
  if (buf.length > limits.maxImageBytes) {
    return {
      ok: false,
      reject: { reason: "too-large", bytes: buf.length, limit: limits.maxImageBytes },
    };
  }
  const mediaType = sniffImageMediaType(buf);
  if (!mediaType) {
    return { ok: false, reject: { reason: "unsupported-format" } };
  }
  return {
    ok: true,
    attachment: {
      kind: "image",
      mediaType,
      data: Buffer.from(buf).toString("base64"),
      bytes: buf.length,
    },
  };
}

/** 把拒收原因说成给用户看的一句话。 */
export function describeReject(reject: AttachmentReject): string {
  switch (reject.reason) {
    case "too-large":
      return `图片太大了(${(reject.bytes / 1_000_000).toFixed(1)}MB,上限 ${(
        reject.limit / 1_000_000
      ).toFixed(1)}MB),我没法看。压缩一下再发吧。`;
    case "unsupported-format":
      return `这个图片格式我认不出来,只能看 ${SUPPORTED_IMAGE_TYPES.map((t) =>
        t.replace("image/", ""),
      ).join(" / ")}。`;
  }
}
