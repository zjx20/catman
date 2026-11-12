# 公众号日报的个人 cron 工作流

这组脚本在 Git 中维护，建议安装到个人项目中，供聊天和同一用户的 cron 共用。它们不在服务启动时覆盖用户文件，也不包含凭证或用户专属写作规则。安装时复制 `collect.cjs`、`publish.sh`、`package.mjs`，并给 shell 脚本执行权限。长提示词也保存在项目内，cron 的短指令只引用这份权威配置。

聊天按 session 分配 workspace；同一 cron 多次运行复用其 workspace，包括 `fresh` 模式。`/user` 是同一用户共享的持久目录。下面是建议布局，项目可以采用其他名称和结构，通过参数或环境变量配置路径：

```text
<cron-workspace>/
  collection.json                      # 本期日期、jobKey、相对 articleDir
  articles/tech-daily-YYYY-MM-DD-v1/
    source-news.json, materials.txt
    article.json, preview.html
    images/                            # 仅本篇的候选素材
/user/projects/wechat-daily/
  prompt.md
  scripts/collect.cjs, publish.sh, package.mjs
  assets/cover.png, cover-media-id.txt   # 项目复用的封面配置
  outputs/tech-daily-YYYY-MM-DD-v1/
    article.json, preview.html, manifest.json
    images/                            # 仅文章实际引用的图片
    assets/cover.png
  outputs/latest -> tech-daily-YYYY-MM-DD-v1
```

在 workspace 中运行项目脚本。取材输入必须通过 `--source` 或 `WECHAT_DAILY_NEWS_SOURCE` 指定；缺少时直接失败。默认在当前工作目录生成 `collection.json` 和 `articles/`，也可用 `--output-root` / `WECHAT_DAILY_ARTICLE_ROOT` 和 `--collection` / `WECHAT_DAILY_COLLECTION` 自定义。`collection.json` 中的 `articleDir`、`materials` 均相对于执行时的工作目录，与脚本或指针文件的安装位置无关。

过期数据退出码为 2，不生成新文章目录。同日已有文章和材料时复用，不覆盖其图片。随后读取 `collection.json`，在其 `articleDir` 内撰写文章；图片路径相对于 `article.json`。不要修改其他任务的 workspace。

```sh
export WECHAT_DAILY_ARCHIVE_ROOT=/user/projects/wechat-daily/outputs
export WECHAT_DAILY_COVER=/user/projects/wechat-daily/assets/cover.png
node /user/projects/wechat-daily/scripts/collect.cjs --source /user/projects/newsdaily/outputs/latest.json
# 从 collection.json 读取 ARTICLE_DIR、JOB_KEY 后：
/user/projects/wechat-daily/scripts/publish.sh render "$ARTICLE_DIR/article.json" --output "$ARTICLE_DIR/preview.html"
/user/projects/wechat-daily/scripts/publish.sh draft "$ARTICLE_DIR/article.json" --job-key "$JOB_KEY"
```

包装器使用 `CLAUDE_CONFIG_DIR/skills/wechat-article`，凭证由原 skill 从个人 `/user/wechat` 读取。`draft` / `update` 必须设置 `WECHAT_DAILY_ARCHIVE_ROOT`，缺少时会在调用微信前失败；其他子命令不需要它。封面可通过 `WECHAT_DAILY_COVER` 指定，默认查找脚本旁的 `assets/cover.png`。写入微信前预检引用路径并刷新预览；确认草稿成功后，只归档引用素材及复用封面。更新按 media_id 保留原目录，`latest` 指向最近处理的文章。每篇目录有文件 SHA-256 清单。

API 失败不会归档，也不会自动重试。API 已成功但本地归档失败时返回原结果并以 74 退出：修复原因后只运行 `node /user/projects/wechat-daily/scripts/package.mjs pack --article ... --root "$WECHAT_DAILY_ARCHIVE_ROOT" --result '<已确认结果 JSON>' --job-key ... --cover "$WECHAT_DAILY_COVER"`，不要再次创建草稿。此命令不调用微信 API。

清理旧文章时可整体删除其工作目录和对应归档目录；如果删除 `latest` 所指目录，需先调整或移除该链接。封面配置、草稿幂等状态和凭证不属于文章目录，不随文章清理。
