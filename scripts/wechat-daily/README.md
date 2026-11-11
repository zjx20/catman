# 公众号日报的个人 cron 工作流

这组脚本在 Git 中维护，安装到该任务的持久 workspace 使用。它们不在服务启动时覆盖用户文件，也不包含凭证或用户专属写作规则。安装时复制 `collect.cjs`、`publish.sh`、`package.mjs`，并给 shell 脚本执行权限；原有写作规则保存在任务自己的 `prompt.txt`。

聊天按 session 分配 workspace；同一 cron 多次运行复用其 workspace，包括 `fresh` 模式。因此工作目录需要显式按文章再分层：

```text
<cron-workspace>/
  collect.cjs, publish.sh, package.mjs, prompt.txt
  assets/cover.png, cover-media-id.txt   # 本任务复用的封面配置
  collection.json                      # 本期日期、jobKey、相对 articleDir
  articles/tech-daily-YYYY-MM-DD-v1/
    source-news.json, materials.txt
    article.json, preview.html
    images/                            # 仅本篇的候选素材
/user/artifacts/wechat-daily/
  tech-daily-YYYY-MM-DD-v1/
    article.json, preview.html, manifest.json
    images/                            # 仅文章实际引用的图片
    assets/cover.png
  latest -> tech-daily-YYYY-MM-DD-v1
```

在 workspace 中运行 `node collect.cjs`，读取 `/user/artifacts/newsdaily/latest.json`。过期数据退出码为 2，不生成新文章目录。同日已有文章和材料时复用，不覆盖其图片。随后读取 `collection.json`，在其 `articleDir` 内撰写文章；图片路径相对于 `article.json`。不要修改其他任务的 workspace。

```sh
./publish.sh render "$ARTICLE_DIR/article.json" --output "$ARTICLE_DIR/preview.html"
./publish.sh draft "$ARTICLE_DIR/article.json" --job-key "$JOB_KEY"
```

包装器使用 `CLAUDE_CONFIG_DIR/skills/wechat-article`，凭证由原 skill 从个人 `/user/wechat` 读取。写入微信前预检引用路径并刷新预览；确认草稿成功后，只归档引用素材及复用封面。更新按 media_id 保留原目录，`latest` 指向最近处理的文章。每篇目录有文件 SHA-256 清单。

API 失败不会归档，也不会自动重试。API 已成功但本地归档失败时返回原结果并以 74 退出：修复原因后只运行 `node package.mjs pack --article ... --root ... --result '<已确认结果 JSON>' --job-key ... --cover assets/cover.png`，不要再次创建草稿。此命令不调用微信 API。

清理旧文章时可整体删除其工作目录和对应归档目录；如果删除 `latest` 所指目录，需先调整或移除该链接。封面配置、草稿幂等状态和凭证不属于文章目录，不随文章清理。
