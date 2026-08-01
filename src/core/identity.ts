import { createHash } from "node:crypto";

/**
 * 身份模型:全局唯一的 userKey。
 *
 *   userKey = <channel>:<accountId>:<userId>
 *
 * 三段各自的来源与约束:
 *   - channel   渠道名,由本仓库定义("wechat" / "stdin"),保证不含 ':'
 *   - accountId 一份凭据/连接实例的 id,由 newAccountId() 生成,保证是 [0-9a-f]{8}
 *   - userId    账号内的对端标识(iLink 的 from_user_id),**内容不受我们控制**
 *
 * 因为只有 userId 可能含任意字符(包括 ':'),解析时只 split 前两个 ':',
 * 余下全部归 userId —— 这样编解码在任何 userId 取值下都是无歧义的往返。
 *
 * 为什么必须带 accountId:两份 iLink 凭据下可能出现相同的 from_user_id,
 * 只按 userId 分会话就会让两个人共用同一段上下文和同一个工作目录。
 */

/** userKey 里我们自己生成的两段所禁止出现的字符。 */
const SEP = ":";

export interface UserKeyParts {
  channel: string;
  accountId: string;
  userId: string;
}

/** 生成一个账号 id(8 位十六进制)。 */
export function newAccountId(): string {
  return createHash("sha256")
    .update(`${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 8);
}

/**
 * 拼 userKey。channel / accountId 含 ':' 会破坏解析的无歧义性,直接抛错 ——
 * 这两段都由本仓库生成,出现 ':' 说明调用方用错了,应当立刻暴露而不是产生一个
 * 能往返失败的 key。
 */
export function makeUserKey(channel: string, accountId: string, userId: string): string {
  if (channel.includes(SEP) || accountId.includes(SEP)) {
    throw new Error(`channel/accountId 不允许含 '${SEP}': ${channel}/${accountId}`);
  }
  if (!channel || !accountId || !userId) {
    throw new Error(`userKey 三段都不能为空: ${channel}/${accountId}/${userId}`);
  }
  return `${channel}${SEP}${accountId}${SEP}${userId}`;
}

/**
 * 解析 userKey。不合法(段数不足或有空段)返回 null。
 *
 * 返回 null 而非抛错,是为了让持久化状态里的脏数据能被安全丢弃:
 * 旧版本 state.json 的 key 是裸 userId(不含 ':'),读到时应当跳过并告警,
 * 而不是让整个进程起不来。
 */
export function parseUserKey(key: string): UserKeyParts | null {
  const first = key.indexOf(SEP);
  if (first <= 0) return null;
  const second = key.indexOf(SEP, first + 1);
  if (second <= first + 1) return null;
  const userId = key.slice(second + 1);
  if (!userId) return null;
  return {
    channel: key.slice(0, first),
    accountId: key.slice(first + 1, second),
    userId,
  };
}

/**
 * dashboard 聊天界面对应的内置管理员身份。
 *
 * 它**永远是管理员且不可撤销** —— 不进 settings 的 adminUserKeys 列表,因此
 * 把那个列表清空也影响不到它。这是刻意留的恢复通道:管理员权限如果能被全部
 * 收走,配置一旦改坏就只能进容器改文件了。
 */
export const BUILTIN_ADMIN_USER_KEY = "dashboard:admin:admin";

/** 目录名里可读前缀的最大长度。见 userDirName 的路径长度约束。 */
const READABLE_MAX = 40;
/** 单射保证靠的哈希后缀长度。 */
const HASH_LEN = 8;

/**
 * userKey → 工作目录名。**必须是单射**:两个不同的 userKey 绝不能得到同一个目录名,
 * 否则两个用户共用一个 cwd,文件与会话隔离直接失效。
 *
 * 做法是「可读前缀(有损、会截断) + userKey 全文的 sha256 前 8 位(无损、保证单射)」。
 * 只靠归一化后的可读部分是不够的 —— 'a:b:x/y' 与 'a:b:x-y' 归一化后完全相同。
 *
 * 长度上限是载荷性的,不是美观问题:Agent SDK 从 cwd 派生会话存储目录时,
 * 对超过 200 字符的路径会截断并追加 djb2 哈希,而本仓库 transcript.ts 的
 * encodeProjectDir() 是朴素的字符替换 —— 一旦 cwd 超过 200 字符,两者算出的
 * 目录名就会分叉,dashboard 读不到会话、清理也删不掉它。截断到
 * READABLE_MAX + 1 + HASH_LEN = 49 字符,使 <workspaceDir>/<dirName> 有充裕余量。
 * 有测试守护该上限。
 */
export function userDirName(userKey: string): string {
  const hash = createHash("sha256").update(userKey).digest("hex").slice(0, HASH_LEN);
  const readable = userKey
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, READABLE_MAX)
    .replace(/-+$/g, "");
  return readable ? `${readable}-${hash}` : hash;
}

/** userDirName 的长度上限(含哈希后缀)。供测试与路径预算使用。 */
export const USER_DIR_NAME_MAX = READABLE_MAX + 1 + HASH_LEN;

/**
 * SDK 在 cwd 超过此长度时会改用「截断 + djb2 哈希」的编码,与 encodeProjectDir()
 * 的朴素替换不一致。工作目录全路径必须始终短于它。
 */
export const SDK_PROJECT_PATH_LIMIT = 200;
