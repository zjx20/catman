import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../scripts/wechat-daily/", import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "catman-wechat-")), articleDir = join(root, "article with spaces"), artifacts = join(root, "home/artifacts/wechat-daily");
  mkdirSync(join(articleDir, "images"), { recursive: true });
  writeFileSync(join(articleDir, "images/selected.jpg"), "selected");
  writeFileSync(join(articleDir, "images/unused.jpg"), "unused");
  writeFileSync(join(articleDir, "preview.html"), "preview");
  const article = join(articleDir, "article.json");
  const save = (image = "images/selected.jpg") => writeFileSync(article, JSON.stringify({ title: "测试文章", sections: [{ items: [{ image: { path: image } }] }] }));
  save();
  const pack = (...args: string[]) => execFileSync(process.execPath, [join(scripts, "package.mjs"), "pack", "--article", article, "--root", artifacts, "--result", JSON.stringify({ status: "created", media_id: "confirmed-draft" }), ...args], { encoding: "utf8" });
  return { root, articleDir, article, artifacts, save, pack, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("每篇文章独立归档，只复制引用素材；更新保留目录并清掉不再引用的图片", () => {
  const f = fixture();
  try {
    f.pack("--job-key", "tech-daily-2026-11-11-v1");
    const dir = join(f.artifacts, "tech-daily-2026-11-11-v1");
    assert.deepEqual(readdirSync(join(dir, "images")), ["selected.jpg"]);
    assert.equal(readlinkSync(join(f.artifacts, "latest")), "tech-daily-2026-11-11-v1");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.mediaId, "confirmed-draft");
    assert.equal(manifest.files["images/selected.jpg"].length, 64);
    f.save("images/unused.jpg"); f.pack();
    assert.deepEqual(readdirSync(join(dir, "images")), ["unused.jpg"]);
    assert.deepEqual(readdirSync(f.artifacts).sort(), ["latest", "tech-daily-2026-11-11-v1"]);
  } finally { f.cleanup(); }
});

test("归档拒绝目录逃逸、符号链接与未确认的草稿结果", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "outside.jpg"), "private");
    f.save("../outside.jpg");
    assert.throws(() => f.pack(), /escapes article directory/);
    f.save("images/link.jpg"); symlinkSync(join(f.root, "outside.jpg"), join(f.articleDir, "images/link.jpg"));
    assert.throws(() => f.pack(), /escapes article directory/);
    f.save();
    const result = spawnSync(process.execPath, [join(scripts, "package.mjs"), "pack", "--article", f.article, "--root", f.artifacts, "--result", '{"status":"failed"}'], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.equal(existsSync(f.artifacts), false);
  } finally { f.cleanup(); }
});

test("发布包装器预检在云端调用前完成，成功只创建一次并归档，失败不归档", () => {
  const f = fixture();
  try {
    const work = join(f.root, "workflow"), skill = join(f.root, "config/skills/wechat-article/scripts"), calls = join(f.root, "calls");
    cpSync(scripts, work, { recursive: true }); mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "publish.sh"), `#!/bin/sh\nset -eu\nprintf '%s\\n' "$1" >> "$CALLS"\ncase "$1" in\nrender) printf preview > "$4" ;;\ndraft|update) [ "\${FAIL_API:-}" != 1 ] || exit 1; printf '%s\\n' '{"status":"created","media_id":"confirmed-draft"}' ;;\nesac\n`, { mode: 0o700 });
    const env = { ...process.env, CLAUDE_CONFIG_DIR: join(f.root, "config"), CATMAN_USER_PRIVATE_DIR: join(f.root, "home"), CALLS: calls };
    const run = (key: string, extra = {}) => spawnSync("sh", [join(work, "publish.sh"), "draft", f.article, "--job-key", key], { env: { ...env, ...extra }, encoding: "utf8" });
    assert.notEqual(run("../bad").status, 0); assert.equal(existsSync(calls), false);
    f.save("images/missing.jpg"); assert.notEqual(run("article-1").status, 0); assert.equal(existsSync(calls), false);
    f.save(); const failure = run("article-1", { FAIL_API: "1" });
    assert.notEqual(failure.status, 0); assert.equal(existsSync(f.artifacts), false);
    writeFileSync(calls, ""); const result = run("article-1");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).media_id, "confirmed-draft");
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["render", "draft"]);
    assert.deepEqual(readdirSync(join(f.artifacts, "article-1/images")), ["selected.jpg"]);
    // A successful cloud write must remain visible even when the local archive fails.
    rmSync(f.artifacts, { recursive: true }); writeFileSync(f.artifacts, "blocked"); writeFileSync(calls, "");
    const archiveFailure = run("article-1");
    assert.equal(archiveFailure.status, 74);
    assert.equal(JSON.parse(archiveFailure.stdout).media_id, "confirmed-draft");
    assert.match(archiveFailure.stderr, /不要再次创建草稿/);
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["render", "draft"], "归档失败不会重复调用云端");
  } finally { f.cleanup(); }
});

test("取材按日期创建独立目录，重复运行保留已有文章，过期数据不创建新产物", () => {
  const root = mkdtempSync(join(tmpdir(), "catman-wechat-collect-"));
  try {
    const source = join(root, "latest.json"), articles = join(root, "work/articles");
    const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
    writeFileSync(source, JSON.stringify({ date, sections: [] }));
    const run = () => spawnSync(process.execPath, [join(scripts, "collect.cjs"), "--source", source, "--output-root", articles], { encoding: "utf8" });
    assert.equal(run().status, 0);
    const dir = join(articles, `tech-daily-${date}-v1`);
    assert.equal(JSON.parse(readFileSync(join(dirname(articles), "collection.json"), "utf8")).jobKey, `tech-daily-${date}-v1`);
    assert.equal(existsSync(join(dir, "source-news.json")), true);
    writeFileSync(join(dir, "article.json"), "keep"); writeFileSync(join(dir, "images/keep.jpg"), "keep");
    assert.equal(run().status, 0); assert.equal(readFileSync(join(dir, "images/keep.jpg"), "utf8"), "keep");
    writeFileSync(source, JSON.stringify({ date: "2000-01-01", sections: [] }));
    assert.equal(run().status, 2); assert.equal(existsSync(join(articles, "tech-daily-2000-01-01-v1")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
