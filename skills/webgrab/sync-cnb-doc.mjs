#!/usr/bin/env node
// 上游动作参考先同步到 owner 的 notes；检查后由管理员更新公共资料。
import fs from 'node:fs'
import path from 'node:path'
const input = process.argv[2] || '/user/notes/CNB_BROWSER_SKILL.md'
const output = process.argv[3] || '/user/notes/cnb-browser.md'
const source = fs.readFileSync(input, 'utf8')
if (!/^---\r?\n/.test(source)) throw new Error('上游格式变了：没有 frontmatter')
const start = source.indexOf('## 调用约定\n')
if (start < 0) throw new Error('上游格式变了：没有调用约定')
let body = source.slice(start)
// 保留动作协议，把直接携带凭据的 curl 示例改走本地入口。
body = body.replace(/curl -s -H "\$AUTH" -H 'content-type: application\/json' \\\n\s*-X POST "\$CNB_BROWSER_URL\/" \\\n\s*-d /g, 'P ')
body = body.replace(/curl -s -H "\$AUTH" -H 'content-type: application\/json' -X POST "\$CNB_BROWSER_URL\/" -d /g, 'P ')
body = body.replace(/P\(\) \{[^\n]*; \}/g, 'P() { "$WG" cnb do "$1" --timeout 45; }')
body = body.replaceAll('curl -s -H "$AUTH" "$CNB_BROWSER_URL/screenshot/browser?whLargest=512" -o page.png', '"$WG" cnb shot --out page.png')
body = body.replaceAll('curl -s -H "$AUTH" "$CNB_BROWSER_URL/screenshot/desktop?whLargest=512" -o desktop.png', '"$WG" cnb shot --desktop --out desktop.png')
body = body.replaceAll('curl -s -H "$AUTH" "$CNB_BROWSER_URL/gw/status"', '"$WG" cnb status --timeout 15')
body = body.replaceAll('curl -s -H "$AUTH" "$CNB_BROWSER_URL/state"', '"$WG" cnb do \'{"action":"get_page_info"}\' --timeout 15')
body = body.replaceAll('检查 `$AUTH` 拼写；`/healthz` 之外都要带', '检查 owner 的 `/user/cnb/browser.env`；入口自动带 token')
body = body.replace(/"wait_until":\s*"networkidle"/g, '"wait_until":"domcontentloaded"')
if (body.includes('$AUTH')) throw new Error('上游出现新的凭据使用方式，请人工检查')
const header = `> webgrab 的 cnb 动作参考。通道选择、超时与停止条件以 SKILL.md 为准。

凭据放 /user/cnb/browser.env（chmod 600），由入口读取。动作 timeout 使用秒，导航默认 30 秒、不重试。
冷启动也受命令总超时约束，不无限循环直到 ready。

\`\`\`bash
WG=/runtime/bin/skills/webgrab/webgrab
P() { "$WG" cnb do "$1" --timeout 45; }
"$WG" cnb status --timeout 15
\`\`\`

`
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, header + body)
console.log('写好', output)
