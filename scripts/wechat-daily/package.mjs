#!/usr/bin/env node
// Standalone: installed beside a personal cron's publish.sh, without release dependencies.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const [command, ...args] = process.argv.slice(2);
function option(name, required = false) {
  const at = args.indexOf(name), value = at < 0 ? undefined : args[at + 1];
  if ((at >= 0 || required) && (!value || value.startsWith("--"))) throw new Error(`Missing ${name}`);
  return value;
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50 * 1024 * 1024) throw new Error(`Not a regular bounded file: ${file}`);
}
function inputs() {
  const key = option("--job-key");
  if (key !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key)) throw new Error("Invalid job key");
  const article = path.resolve(option("--article", true)); regular(article);
  const dir = fs.realpathSync(path.dirname(article));
  const data = JSON.parse(fs.readFileSync(article, "utf8"));
  const images = [...(data.sections ?? [])].flatMap(section => (section.items ?? []).flatMap(item => item.image?.path ? [item.image.path] : []));
  if (data.cover?.path) images.push(data.cover.path);
  const files = new Map();
  for (const name of new Set(images)) {
    if (typeof name !== "string" || path.isAbsolute(name) || name.includes("\\") || !/\.(png|jpe?g|webp|gif)$/i.test(name)) throw new Error(`Invalid image path: ${name}`);
    const source = path.resolve(dir, name);
    if (!inside(dir, source) || !inside(dir, fs.realpathSync(source))) throw new Error(`Image escapes article directory: ${name}`);
    regular(source); files.set(path.relative(dir, source), source);
  }
  const preview = path.join(dir, "preview.html");
  if (fs.existsSync(preview)) { regular(preview); files.set("preview.html", preview); }
  const cover = option("--cover");
  if (cover && fs.existsSync(cover) && !files.has("assets/cover.png")) { regular(cover); files.set("assets/cover.png", path.resolve(cover)); }
  return { article, data, files };
}
function pack(input) {
  const result = JSON.parse(option("--result", true));
  if (!["created", "reused", "updated"].includes(result.status) || typeof result.media_id !== "string" || !result.media_id) throw new Error("No confirmed draft result; refuse to archive");
  const root = path.resolve(option("--root", true));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Artifact root must not be a symlink");
  const validKey = key => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key);
  let key = option("--job-key");
  if (key !== undefined && !validKey(key)) throw new Error("Invalid job key");
  // Updates retain the article's original directory even if no job-key is supplied.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !validKey(entry.name)) continue;
    const file = path.join(root, entry.name, "manifest.json");
    if (!fs.existsSync(file)) continue;
    regular(file); const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    if (manifest.mediaId === result.media_id) { key = entry.name; break; }
  }
  key ??= `draft-${createHash("sha256").update(result.media_id).digest("hex").slice(0, 16)}`;
  const target = path.join(root, key), latest = path.join(root, "latest");
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error("Article directory must not be a symlink");
    const manifest = JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8"));
    if (manifest.schema !== 1 || manifest.mediaId !== result.media_id) throw new Error("Refuse to replace another article");
  }
  const linkExists = fs.existsSync(latest) || fs.lstatSync(latest, { throwIfNoEntry: false });
  if (linkExists && !fs.lstatSync(latest).isSymbolicLink()) throw new Error("latest must be a managed symlink");
  const stage = path.join(root, `.${key}.stage-${randomUUID()}`), old = `${stage}.old`, link = `${stage}.link`;
  fs.mkdirSync(stage, { mode: 0o700 });
  let moved = false;
  try {
    const files = new Map([["article.json", input.article], ...input.files]);
    const hashes = {};
    for (const [name, source] of files) {
      const dest = path.join(stage, name); fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, dest); fs.chmodSync(dest, 0o600);
      hashes[name] = createHash("sha256").update(fs.readFileSync(dest)).digest("hex");
    }
    fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify({ schema: 1, key, title: input.data.title, mediaId: result.media_id, archivedAt: new Date().toISOString(), files: hashes }, null, 2) + "\n", { mode: 0o600 });
    if (fs.existsSync(target)) { fs.renameSync(target, old); moved = true; }
    try { fs.renameSync(stage, target); }
    catch (error) { if (moved) { fs.renameSync(old, target); moved = false; } throw error; }
    fs.symlinkSync(key, link); fs.renameSync(link, latest);
    if (moved) { fs.rmSync(old, { recursive: true }); moved = false; }
    console.log(JSON.stringify({ archived: true, key, directory: target, files: [...files.keys()] }));
  } finally {
    fs.rmSync(stage, { recursive: true, force: true }); fs.rmSync(link, { force: true });
    // If updating latest failed, retain the previous bundle for recovery.
  }
}
try {
  if (!["check", "pack"].includes(command)) throw new Error("Usage: package.mjs check|pack --article file [--root directory --result json --job-key key --cover image]");
  const input = inputs();
  if (command === "pack") pack(input);
} catch (error) { console.error(`Article archive failed: ${error.message}`); process.exitCode = 1; }
