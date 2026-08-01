/**
 * iLink 扫码登录脚本(命令行版)。
 *
 * 正常路径是在 dashboard 的「账号」页扫码 —— 那里能直接看到二维码图片,而且
 * 登录成功后连接会立刻拉起,不用重启进程。本脚本是 dashboard 打不开时的退路,
 * 与 dashboard 共用同一套流程(channels/ilink-login.ts),凭据也写同一个
 * accounts.json,因此两条路径不会产生格式分歧。
 *
 * ⚠️ QR 端点(get_bot_qrcode / get_qrcode_status)至今未经真机验证,
 * 字段名可能需要按实际响应微调。
 *
 * 用法:
 *   CATMAN_DATA_DIR=/data node dist/src/scripts/ilink-login.js ["备注名"]
 * 备注名可选,留空则用「微信账号 <id>」;事后可在 dashboard 的账号页改。
 * 凭据写入 $CATMAN_DATA_DIR/accounts.json(0600)。
 */
import { loadConfig } from "../config.js";
import { AccountStore } from "../core/accounts.js";
import { ILinkLogin } from "../channels/ilink-login.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const accounts = new AccountStore(config.accountsPath);
  const login = new ILinkLogin(accounts);

  // 备注名在扫码前定下:多账号时二维码之间没有任何区别,扫完再回头认最容易配错人。
  const displayName = process.argv[2] ?? "";
  const session = await login.start(displayName);
  console.log("\n请用微信扫描二维码并确认授权:");
  if (session.qrcodeImage) {
    console.log("(接口返回的是图片,终端里显示不了。请改用 dashboard 的「账号」页扫码。)");
  }
  console.log(`二维码 key: ${session.qrcode}`);
  console.log("等待扫码…");

  for (;;) {
    // poll() 内部是长轮询(无人扫码时阻塞约 30 秒),这里只留很短的间隔。
    await sleep(500);
    const result = await login.poll(session.loginId);
    if (result.status === "confirmed") {
      console.log(`\n✅ 登录成功,账号 ${result.accountId} 已写入 ${config.accountsPath}`);
      console.log("提示:该账号收到的第一条消息,其发送者会成为它的主人(之后其他人的来信会被拒绝)。");
      return;
    }
    if (result.status === "expired") {
      throw new Error("二维码已过期或超时,请重新运行登录");
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("登录失败:", err);
  process.exit(1);
});
