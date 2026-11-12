#!/usr/bin/env node
/**
 * 公众号日报取材:读 newsdaily 的 latest.json,抓每条的原文,汇总成 materials.txt。
 *
 *   node collect.cjs --source file [--max-chars 700] [--output-root directory] [--collection file]
 *
 * 产物(每期独立存于 articles/tech-daily-YYYY-MM-DD-v1):
 *   materials.txt   给成文模型看的材料(分组 / 标题 / 链接 / 已有 detail / 原文摘录)
 *   images/iN.jpg   候选配图(og:image,最多 6 张;不保证可用,由成文模型挑选)
 *
 * 数据新鲜度:latest.json 的 date 必须是北京时间今天,否则退出码 2 ——
 * 宁可今天不做,也不把昨天的新闻排成今天的公众号文章。
 *
 * 网络:国内站直连(--noproxy),境外站走 catwalk;拿不到正文的(InfoQ 等 JS 壳)
 * 标 NEED_WEBFETCH,留给成文模型用 WebFetch 补。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileP = promisify(execFile);

function option(name, fallback) {
  const at = process.argv.indexOf(name);
  const value = at < 0 ? fallback : process.argv[at + 1];
  if (at < 0 && value === undefined) return undefined;
  if (!value || value.startsWith('--')) throw new Error(`缺少 ${name} 的值`);
  return path.resolve(value);
}
const NEWS = option('--source', process.env.WECHAT_DAILY_NEWS_SOURCE || undefined);
if (!NEWS) throw new Error('需要 --source <新闻 JSON> 或 WECHAT_DAILY_NEWS_SOURCE，输入路径由项目配置指定');
const WORK = process.cwd();
const OUTPUT_ROOT = option('--output-root', process.env.WECHAT_DAILY_ARTICLE_ROOT || path.join(WORK, 'articles'));
const POINTER = option('--collection', process.env.WECHAT_DAILY_COLLECTION || path.join(WORK, 'collection.json'));
let DIR, OUT, IMG_DIR;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const PROXY = process.env.NEWS_PROXY_URL || 'http://catwalk:1088';
const CONCURRENCY = 6;
const MAX_IMAGES = 6;

const argMax = process.argv.indexOf('--max-chars');
const MAX_CHARS = argMax > 0 ? Number(process.argv[argMax + 1]) || 700 : 700;
// 仅供人工试跑:允许用非当天数据排版。定时任务永远不带这个参数。
const ALLOW_STALE = process.argv.includes('--allow-stale');

function todayCN() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

const DOMESTIC_SUFFIX = ['.cn', '.com.cn', '.net.cn', '.org.cn'];
const DOMESTIC_HOSTS = new Set([
  'baidu.com', 'qbitai.com', 'infoq.cn', '36kr.com', 'huxiu.com', 'jiqizhixin.com',
]);
const isDomestic = (host) => {
  const h = host.toLowerCase();
  return DOMESTIC_SUFFIX.some((s) => h.endsWith(s)) || DOMESTIC_HOSTS.has(h) ||
    [...DOMESTIC_HOSTS].some((d) => h.endsWith('.' + d));
};

function runCurl(url, useProxy, maxTime = 20) {
  const args = ['-sL', '--max-time', String(maxTime), '-A', UA, '--compressed'];
  if (useProxy) args.push('-x', PROXY);
  else args.push('--noproxy', '*');
  args.push(url);
  return execFileP('curl', args, { maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', timeout: (maxTime + 5) * 1000 })
    .then((r) => r.stdout);
}

const unent = (s) => s
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function extractText(html, max) {
  const cleaned = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '');
  const ps = [...cleaned.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => unent(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 15);
  let text = '';
  for (const p of ps) {
    const room = max - text.length;
    if (room < 80) break;
    text += (p.length > room ? p.slice(0, room) + '…' : p) + '\n';
  }
  text = text.trim();
  if (text) return text;
  // 没有 <p> 的页面:退回 meta description(只够写一句话,聊胜于无)
  const desc = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i);
  return desc ? unent(desc[1]).replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function extractOgImage(html, baseUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      try {
        return new URL(unent(m[1]), baseUrl).toString();
      } catch { /* ignore */ }
    }
  }
  return null;
}

async function downloadImage(url, destBase) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    const useProxy = !isDomestic(parsed.hostname);
    const args = ['-sL', '--max-time', '25', '-A', UA, '--compressed'];
    if (useProxy) args.push('-x', PROXY);
    else args.push('--noproxy', '*');
    args.push(url);
    const { stdout } = await execFileP('curl', args, {
      encoding: 'buffer', maxBuffer: 6 * 1024 * 1024, timeout: 30_000,
    });
    if (!stdout || stdout.length === 0 || stdout.length > 3 * 1024 * 1024) return null;
    const isPng = stdout.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpg = stdout.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    if (!isPng && !isJpg) return null;
    const ext = isPng ? '.png' : '.jpg';
    const dest = destBase + ext;
    fs.writeFileSync(dest, stdout);
    return path.basename(dest);
  } catch {
    return null;
  }
}

/**
 * 来源日期只从 URL 的 /YYYY/MM/DD/ 里取 —— 正文里的日期多半是文章提到的
 * 事件日期(比如某个协议的版本时间),拿来当发布日期会张冠李戴。
 * 取不到就诚实地写“收录”,不要冒充发布日期。
 */
function guessPublished(url, dailyDate) {
  const m = String(url || '').match(/\/(20\d{2})\/(\d{1,2})\/(\d{1,2})(?:\/|$)/);
  if (m) {
    const mm = String(Number(m[2])).padStart(2, '0');
    const dd = String(Number(m[3])).padStart(2, '0');
    return `${m[1]}-${mm}-${dd}`;
  }
  return `${dailyDate}(收录)`;
}

function isMediumOnly(item) {
  const links = Array.isArray(item.links) ? item.links : [];
  if (!links.length) return false;
  return links.every((l) => {
    try { return /(^|\.)medium\.com$/i.test(new URL(l.url).hostname); } catch { return false; }
  });
}

function pickFetchUrl(item) {
  const links = Array.isArray(item.links) ? item.links : [];
  const usable = links.filter((l) => {
    try {
      const h = new URL(l.url).hostname.toLowerCase();
      return h !== 'news.ycombinator.com' && !h.endsWith('medium.com');
    } catch { return false; }
  });
  if (usable.length) return usable[0];
  return links[0] || null;
}

/**
 * uploadimg 要求正文图片 <1MB。og:image 经常一两 MB,统一用 toolbox 里的 ffmpeg
 * 压到宽 1080、JPEG q4。返回 旧名→新名 的映射。
 */
async function shrinkLargeImages() {
  const files = fs.readdirSync(IMG_DIR)
    .filter((f) => fs.statSync(path.join(IMG_DIR, f)).size > 900 * 1024);
  if (!files.length) return new Map();
  const map = new Map();
  for(const f of files){
    const out=f.replace(/\.[^.]+$/,'')+'_c.jpg';
    try{await execFileP('ffmpeg',['-y','-hide_banner','-loglevel','error','-i',path.join(IMG_DIR,f),'-vf','scale=min(1080\\,iw):-2','-q:v','4',path.join(IMG_DIR,out)],{timeout:120000});map.set(f,out);fs.rmSync(path.join(IMG_DIR,f));}
    catch(e){console.error('图片压缩失败，保留原图：'+String(e.message).slice(0,120));}
  }
  return map;
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(NEWS, 'utf8'));
  } catch (e) {
    console.error(`读不到 ${NEWS}:${e.message}`);
    process.exit(1);
  }

  const today = todayCN();
  if (data.date !== today) {
    if (!ALLOW_STALE) {
      console.error(`数据不是今天的:latest.json date=${JSON.stringify(data.date)},今天=${today}`);
      process.exit(2);
    }
    console.warn(`⚠️ --allow-stale:使用 ${data.date} 的数据试跑(不要用于定时任务)`);
  }

  if (typeof data.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error('新闻日期无效');
  const key = `tech-daily-${data.date}-v1`;
  DIR = path.join(OUTPUT_ROOT, key);
  OUT = path.join(DIR, 'materials.txt');
  IMG_DIR = path.join(DIR, 'images');
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const collection = { date: data.date, jobKey: key, articleDir: path.relative(WORK, DIR), materials: path.relative(WORK, OUT) };
  const pointer = POINTER;
  fs.mkdirSync(path.dirname(pointer), { recursive: true, mode: 0o700 });
  if (fs.existsSync(path.join(DIR, 'article.json')) && fs.existsSync(OUT)) {
    fs.writeFileSync(pointer, JSON.stringify(collection, null, 2) + '\n', { mode: 0o600 });
    console.log('已存在本期文章，复用现有材料，不覆盖图片或文章。');
    console.log(JSON.stringify(collection));
    return;
  }
  fs.writeFileSync(path.join(DIR, 'source-news.json'), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(IMG_DIR, { recursive: true, force: true });
  fs.mkdirSync(IMG_DIR, { recursive: true });

  const sections = Array.isArray(data.sections) ? data.sections : [];
  const flat = [];
  let n = 0;
  let skippedMedium = 0;
  for (const section of sections) {
    for (const item of Array.isArray(section.items) ? section.items : []) {
      // Medium 有会员墙,抓不到全文;公众号不排它(每日推送那边照旧)。
      if (isMediumOnly(item)) { skippedMedium += 1; continue; }
      n += 1;
      flat.push({ id: `i${n}`, section: section.name, item, number: n });
    }
  }
  const usedSections = sections.filter((s) => flat.some((e) => e.section === s.name));
  console.log(`条目:${flat.length} 条,分 ${usedSections.length} 组` +
    (skippedMedium ? `(已排除 Medium ${skippedMedium} 条)` : ''));

  let imageCount = 0;
  const done = await pool(flat, CONCURRENCY, async (entry) => {
    const link = pickFetchUrl(entry.item);
    const result = { ...entry, link, text: '', image: null, note: '' };
    if (!link) { result.note = 'NO_LINK'; return result; }

    const isMedium = /medium\.com$/i.test(new URL(link.url).hostname);
    if (isMedium) {
      result.note = 'MEDIUM_SKIP';
      return result;
    }

    const host = new URL(link.url).hostname;
    const useProxy = !isDomestic(host);
    let html = '';
    try {
      html = await runCurl(link.url, useProxy, 20);
    } catch (e) {
      result.note = `FETCH_FAIL${(e.code || e.message) ? ':' + String(e.code || e.message).slice(0, 40) : ''}`;
      return result;
    }

    result.text = extractText(html, MAX_CHARS);
    if (!result.text) result.note = 'NEED_WEBFETCH';

    // 只给前若干条找配图,避免把一屏缩略图全下下来。
    if (imageCount < MAX_IMAGES) {
      const og = extractOgImage(html, link.url);
      if (og) {
        imageCount += 1;
        const name = await downloadImage(og, path.join(IMG_DIR, entry.id));
        if (name) result.image = name;
      }
    }
    return result;
  });

  const shrunk = await shrinkLargeImages();
  if (shrunk.size) {
    for (const r of done) if (r.image && shrunk.has(r.image)) r.image = shrunk.get(r.image);
  }

  const needWebfetch = done.filter((r) => r.note === 'NEED_WEBFETCH').map((r) => `${r.id} ${r.link.url}`);
  const failed = done.filter((r) => r.note.startsWith('FETCH_FAIL')).map((r) => `${r.id} ${r.link.url}`);

  const lines = [`# 科技日报 ${data.date} 取材`, `# 生成时间:${new Date().toISOString()}`, ''];
  if (data.note) lines.push(`> 日报备注:${data.note}`, '');
  if (skippedMedium) lines.push(`> 已排除 Medium 条目 ${skippedMedium} 条(会员墙,不排进公众号;每日推送不受影响)`, '');

  for (const section of usedSections) {
    lines.push(`## ${section.name}`, '');
    for (const entry of done.filter((r) => r.section === section.name)) {
      lines.push(`### [${entry.id}] ${entry.item.line}`);
      if (entry.link) {
        lines.push(`- 链接:${entry.link.label} | ${entry.link.url}`);
        lines.push(`- 来源日期:${guessPublished(entry.link.url, data.date)}`);
      }
      if (entry.item.detail) lines.push(`- 已有摘要:${entry.item.detail}`);
      if (entry.image) lines.push(`- 配图候选:images/${entry.image}`);
      if (entry.note === 'NEED_WEBFETCH') lines.push('- ⚠️ 正文是 JS 壳,需用 WebFetch 补');
      else if (entry.note.startsWith('FETCH_FAIL')) lines.push(`- ⚠️ 抓取失败(${entry.note}),材料只有摘要/标题`);
      else if (entry.note === 'MEDIUM_SKIP') lines.push('- (Medium 不抓正文,用已有摘要)');
      if (entry.text) lines.push('- 原文摘录:', entry.text.replace(/\n/g, ' '), '');
      else lines.push('');
    }
  }

  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  console.log(`已写 ${OUT}(${lines.join('\n').length} 字符)`);
  console.log(`配图候选:${done.filter((r) => r.image).length} 张`);
  if (needWebfetch.length) console.log(`需 WebFetch:${needWebfetch.length} 条\n` + needWebfetch.map((x) => '  ' + x).join('\n'));
  if (failed.length) console.log(`抓取失败:${failed.length} 条\n` + failed.map((x) => '  ' + x).join('\n'));
  fs.writeFileSync(pointer, JSON.stringify(collection, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(collection));
}

main().catch((e) => {
  console.error('collect.cjs 失败:' + (e && e.message ? e.message : e));
  process.exit(1);
});
