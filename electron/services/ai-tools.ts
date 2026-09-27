/**
 * 工具箱 AI 工具集
 *
 * 复用 pi-agent 通道生成内容（PPT 大纲/周报/思维导图/文案），
 * 并提供文件导出（.pptx / .mm / .md）、网络抓取、图片生成能力。
 */
import * as path from 'path';
import * as fs from 'fs';
import logger from './logger';
import { runPi } from './pi-agent';
import * as appConfig from './app-config';

// ========== AI 生成（复用 pi agent 通道） ==========

export interface AiToolGenerateOptions {
  prompt: string;
  sessionId: string;
  onDelta?: (text: string) => void;
  customTools?: any[];
}

/**
 * 用 pi agent 生成内容（非流式返回完整文本）。
 * 使用独立 session（前缀 aitool_），默认不注入本地工具；可传 customTools（如周报查询工具）。
 */
export async function generateWithPi(opts: AiToolGenerateOptions): Promise<string> {
  const { prompt, sessionId, onDelta, customTools } = opts;
  return new Promise((resolve, reject) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) { done = true; reject(new Error('生成超时（5分钟），请重试')); }
    }, 300000);

    runPi({
      prompt,
      sessionId: 'aitool_' + sessionId,
      customTools,
      onDelta,
      onDone: (finalText) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        resolve((finalText || '').trim());
      },
      onError: (err) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        reject(new Error(err));
      },
    });
  });
}

// ========== Markdown 解析（PPT / 思维导图共用大纲） ==========

interface OutlineItem {
  level: number;
  text: string;
}

/** 把 markdown 文本解析为大纲条目（# ## ### - 等） */
export function parseOutline(md: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      items.push({ level: m[1].length, text: cleanInline(m[2]) });
      continue;
    }
    m = line.match(/^[-*]\s+(.*)$/);
    if (m) {
      items.push({ level: 2, text: cleanInline(m[1]) });
      continue;
    }
    m = line.match(/^\d+[.、)]\s+(.*)$/);
    if (m) {
      items.push({ level: 2, text: cleanInline(m[1]) });
      continue;
    }
    m = line.match(/^>\s+(.*)$/);
    if (m) {
      items.push({ level: 1, text: cleanInline(m[1]) });
    }
  }
  return items;
}

/** 剥离行内 markdown 语法（粗体/斜体/链接/行内代码） */
function cleanInline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/[:：]\s*$/g, '')
    .trim();
}

// ========== PPT / 演示导出 ==========

/** 递归收集笔记库文件内容（.md/.txt/.markdown），限制总量防止超出上下文 */
export function collectNotesText(dir: string, maxChars = 25000): string {  const EXTS = new Set(['.md', '.txt', '.markdown']);
  const parts: string[] = [];
  let total = 0;
  const walk = (d: string) => {
    if (total >= maxChars) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (total >= maxChars) break;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '.git') walk(fp);
      } else if (EXTS.has(path.extname(e.name).toLowerCase())) {
        try {
          const c = fs.readFileSync(fp, 'utf-8').trim();
          if (c) {
            const rel = path.relative(dir, fp).replace(/\\/g, '/');
            parts.push(`【${rel}】\n${c.slice(0, 10000)}`);
            total += c.length;
          }
        } catch {}
      }
    }
  };
  walk(dir);
  return parts.join('\n\n---\n\n');
}

/** 多笔记库聚合采集：按库分配字符预算，段落标题带库名前缀，供日报/周报等全局分析使用 */
export function collectNotesTextAll(dirs: string[], maxChars = 25000): string {
  const valid = (dirs || []).filter(d => d && fs.existsSync(d));
  if (!valid.length) return '';
  const per = Math.max(4000, Math.floor(maxChars / valid.length));
  return valid.map(d => {
    const t = collectNotesText(d, per);
    return t ? `━━ 笔记库「${path.basename(d) || d}」━━\n${t}` : '';
  }).filter(Boolean).join('\n\n');
}

interface Slide {
  title: string;
  bullets: string[];
  paras: string[];
}

/** 解析 markdown 大纲为幻灯片结构：首个 # 为封面；## / ### 各为一张幻灯片；列表为要点；裸段落为正文。支持 JSON 结构输入。 */
export function parseSlides(md: string): { coverTitle: string; slides: Slide[] } {
  const trimmed = md.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const obj = JSON.parse(trimmed);
      const title = typeof obj === 'object' && obj !== null ? (obj.title || '') : '';
      const pages: any[] = Array.isArray(obj) ? obj : (Array.isArray(obj.pages) ? obj.pages : []);
      const slides: Slide[] = [];
      for (const p of pages) {
        const points = Array.isArray(p.points) ? p.points : (Array.isArray(p.items) ? p.items : []);
        const paras = Array.isArray(p.paras) ? p.paras : [];
        const s: Slide = {
          title: cleanInline(String(p.title || p.name || '')).trim() || '内容',
          bullets: points.map(x => cleanInline(String(x))).filter(Boolean),
          paras: paras.map(x => cleanInline(String(x))).filter(Boolean),
        };
        if (s.title || s.bullets.length || s.paras.length) slides.push(s);
      }
      return { coverTitle: title || 'AI 生成的演示文稿', slides };
    } catch {}
  }
  return parseSlidesMarkdown(md);
}

function parseSlidesMarkdown(md: string): { coverTitle: string; slides: Slide[] } {
  const slides: Slide[] = [];
  let coverTitle = '';
  const pushSlide = (title: string) => slides.push({ title, bullets: [], paras: [] });
  const cur = () => slides[slides.length - 1];

  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      const t = cleanInline(h1[1]);
      if (!coverTitle) coverTitle = t;
      else pushSlide(t);
      continue;
    }
    const h2 = line.match(/^##+\s+(.*)$/);
    if (h2) {
      const t = cleanInline(h2[1]);
      if (slides.length === 0 && !coverTitle) coverTitle = t;
      else pushSlide(t);
      continue;
    }
    if (slides.length === 0) pushSlide('内容');
    const list = line.match(/^[-*]\s+(.*)$/) || line.match(/^\d+[.、)]\s+(.*)$/);
    if (list) {
      cur().bullets.push(cleanInline(list[1]));
      continue;
    }
    if (line.startsWith('```')) {
      cur().paras.push(line);
      continue;
    }
    if (!line.startsWith('|') && !/^[-=: ]{3,}$/.test(line)) {
      cur().paras.push(cleanInline(line));
    }
  }
  if (!coverTitle) coverTitle = 'AI 生成的演示文稿';
  return { coverTitle, slides };
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 将 markdown 大纲生成自包含 HTML 演示文稿（单文件，方向键翻页，可离线打开）。
 */
export function exportHtml(md: string, savePath: string): void {
  const { coverTitle, slides } = parseSlides(md);

  const slidesHtml: string[] = [];
  slidesHtml.push(`<section class="slide cover">
  <div class="cover-title">${htmlEscape(coverTitle)}</div>
  <div class="cover-sub">AI 生成 · 启航AI工作台</div>
</section>`);
  for (const s of slides) {
    const paras = s.paras.map(p => `<p>${htmlEscape(p)}</p>`).join('');
    const bullets = s.bullets.map(b => `<li>${htmlEscape(b)}</li>`).join('');
    slidesHtml.push(`<section class="slide">
  <div class="slide-body">
    <h2>${htmlEscape(s.title)}</h2>
    ${paras}
    ${bullets ? `<ul>${bullets}</ul>` : ''}
  </div>
</section>`);
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(coverTitle)}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; background: #0f172a; overflow: hidden; }
.deck { height: 100vh; }
.slide { display: none; width: 100vw; height: 100vh; padding: 8vh 10vw; background: #ffffff; color: #1e293b; position: relative; overflow: hidden; }
.slide.active { display: flex; }
.cover { background: linear-gradient(135deg, #1f4e79, #3b6ea5); color: #fff; align-items: center; justify-content: center; flex-direction: column; text-align: center; }
.cover-title { font-size: clamp(28px, 5vw, 56px); font-weight: 700; max-width: 80%; line-height: 1.4; }
.cover-sub { margin-top: 24px; font-size: 16px; color: #a8c6e5; }
.slide-body { width: 100%; }
.slide-body h2 { font-size: clamp(22px, 3.5vw, 36px); color: #1f4e79; margin-bottom: 4vh; padding-bottom: 12px; border-bottom: 3px solid #1f4e79; }
.slide-body p { font-size: clamp(16px, 2.2vw, 22px); line-height: 1.8; margin-bottom: 2vh; color: #334155; }
.slide-body ul { list-style: none; margin-top: 2vh; }
.slide-body li { font-size: clamp(15px, 2vw, 20px); line-height: 1.7; padding: 8px 0 8px 34px; position: relative; color: #334155; }
.slide-body li::before { content: "▸"; position: absolute; left: 8px; color: #3b82f6; font-weight: 700; }
.pager { position: fixed; right: 18px; bottom: 14px; color: rgba(255,255,255,.75); font-size: 13px; z-index: 10; text-shadow: 0 1px 3px rgba(0,0,0,.5); }
.hint { position: fixed; left: 18px; bottom: 14px; color: rgba(255,255,255,.5); font-size: 12px; z-index: 10; }
</style>
</head>
<body>
<div class="deck">
${slidesHtml.join('\n')}
</div>
<div class="hint">← → 方向键翻页</div>
<div class="pager" id="pager">1 / ${slides.length + 1}</div>
<script>
(function () {
  var slides = document.querySelectorAll('.slide');
  var idx = 0;
  var pager = document.getElementById('pager');
  function show() {
    for (var i = 0; i < slides.length; i++) slides[i].classList.toggle('active', i === idx);
    pager.textContent = (idx + 1) + ' / ' + slides.length;
  }
  function next() { if (idx < slides.length - 1) { idx++; show(); } }
  function prev() { if (idx > 0) { idx--; show(); } }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prev(); }
  });
  slides[0].classList.add('active');
  show();
})();
</script>
</body>
</html>`;
  fs.writeFileSync(savePath, html, 'utf-8');
}

/**
 * 将 markdown 大纲生成 .pptx 文件。
 * 规则：首个 # 为封面标题；## / ### 各为一张幻灯片；- / 数字列表为当前页要点；裸段落为当前页正文。
 */
export async function exportPptx(md: string, savePath: string): Promise<void> {
  // pptxgenjs 是 CJS 包，编译后 require 即可
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDE';
  pptx.author = '启航AI工作台';
  pptx.company = '启航AI工作台';
  pptx.subject = 'AI 生成演示文稿';

  const { coverTitle, slides } = parseSlides(md);

  // 封面
  const cover = pptx.addSlide();
  cover.background = { color: '1F4E79' };
  cover.addText(coverTitle, { x: 0.8, y: 2.2, w: 11.7, h: 1.6, fontSize: 34, bold: true, color: 'FFFFFF', align: 'center' });
  cover.addText('AI 生成 · 启航AI工作台', { x: 0.8, y: 4.0, w: 11.7, h: 0.5, fontSize: 14, color: 'A8C6E5', align: 'center' });

  // 内容页
  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addText(s.title, { x: 0.6, y: 0.4, w: 12.1, h: 0.7, fontSize: 26, bold: true, color: '1F4E79' });
    slide.addShape('line', { x: 0.6, y: 1.15, w: 12.1, h: 0.02, fill: { color: '1F4E79' } });
    const lines: any[] = [];
    if (s.paras.length) lines.push({ text: s.paras.join('\n'), options: { breakLine: false, fontSize: 15, color: '444444' } });
    for (const b of s.bullets) lines.push({ text: b, options: { bullet: { type: 'bullet' }, fontSize: 16, color: '333333' } });
    if (lines.length === 0) lines.push({ text: '（本节内容请参考演示）', options: { fontSize: 15, color: '999999' } });
    slide.addText(lines, { x: 0.6, y: 1.4, w: 12.1, h: 5.5, valign: 'top', lineSpacing: 18 });
  }

  await pptx.writeFile({ fileName: savePath });
}

// ========== 思维导图导出（FreeMind .mm） ==========

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 将大纲导出为 FreeMind .mm 文件 */
export function exportMindmap(md: string, savePath: string): void {
  const items = parseOutline(md);
  const root = (items.find(i => i.level === 1) && items.find(i => i.level === 1)!.text) || '主题';
  const branches: { title: string; subs: string[] }[] = [];
  let cur: { title: string; subs: string[] } | null = null;
  for (const item of items) {
    if (item.level === 1) continue;
    if (item.level === 2) {
      cur = { title: item.text, subs: [] };
      branches.push(cur);
    } else if (cur) {
      cur.subs.push(item.text);
    } else if (item.level === 3) {
      cur = { title: item.text, subs: [] };
      branches.push(cur);
    }
  }
  const out: string[] = ['<map version="1.0.1">'];
  if (branches.length === 0) {
    out.push(`  <node TEXT="${xmlEscape(root)}"/>`);
  } else {
    out.push(`  <node TEXT="${xmlEscape(root)}">`);
    for (const b of branches) {
      if (b.subs.length === 0) {
        out.push(`    <node TEXT="${xmlEscape(b.title)}"/>`);
      } else {
        out.push(`    <node TEXT="${xmlEscape(b.title)}">`);
        for (const s of b.subs) out.push(`      <node TEXT="${xmlEscape(s)}"/>`);
        out.push('    </node>');
      }
    }
    out.push('  </node>');
  }
  out.push('</map>');
  fs.writeFileSync(savePath, out.join('\n'), 'utf-8');
}

// ========== 文本导出 ==========

export function exportText(text: string, savePath: string, ext = '.md'): void {
  const finalPath = savePath.endsWith(ext) ? savePath : savePath + ext;
  fs.writeFileSync(finalPath, text, 'utf-8');
}

// ========== 网络抓取 ==========

export interface FetchResult {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  contentType?: string;
  error?: string;
}

/** 抓取 URL 内容（HTML 剥标签取正文文本） */
export async function fetchUrl(url: string): Promise<FetchResult> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: '仅支持 http/https 链接' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
    const contentType = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return { ok: false, error: '内容超过 5MB，暂不支持' };

    if (contentType.includes('application/json') || url.match(/\.json($|\?)/)) {
      return { ok: true, url, title: url.split('/').pop(), text: buf.toString('utf-8'), contentType };
    }

    const html = buf.toString('utf-8');
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ')
      .trim();
    const text = body.slice(0, 30000);
    return {
      ok: true,
      url,
      title: titleMatch ? titleMatch[1].trim() : url.split('/').pop(),
      text,
      contentType,
    };
  } catch (e: any) {
    const msg = e && e.name === 'AbortError' ? '抓取超时（30秒）' : (e.message || String(e));
    return { ok: false, error: msg };
  }
}

// ========== 图片生成 ==========

export interface ImageGenConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function getImageGenConfig(): ImageGenConfig {
  return {
    baseUrl: appConfig.getConfig('imageGenBaseUrl') || 'https://api.openai.com/v1',
    apiKey: appConfig.getConfig('imageGenApiKey') || '',
    model: appConfig.getConfig('imageGenModel') || 'dall-e-3',
  };
}

export interface ImageGenResult {
  ok: boolean;
  dataUrl?: string;
  b64?: string;
  mimeType?: string;
  error?: string;
}

/**
 * 生成图片。支持 OpenAI 兼容 /images/generations（返回 b64_json 或 url），
 * 以及 Stable Diffusion WebUI /sdapi/v1/txt2img。
 */
export async function generateImage(prompt: string, opts: { width?: number; height?: number; model?: string } = {}): Promise<ImageGenResult> {
  const cfg = getImageGenConfig();
  if (!cfg.apiKey && !cfg.baseUrl.includes('127.0.0.1') && !cfg.baseUrl.includes('localhost')) {
    return { ok: false, error: '未配置图像服务 API Key，请在「设置」→ AI 服务中配置' };
  }
  const base = cfg.baseUrl.replace(/\/+$/, '');
  try {
    // SD WebUI 风格地址（/sdapi/v1/txt2img）
    if (base.includes('sdapi') || /\/sdapi\/v1$/.test(base)) {
      const res = await fetch(base + '/txt2img', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          width: opts.width || 1024,
          height: opts.height || 1024,
          steps: 28,
          cfg_scale: 7,
          negative_prompt: 'lowres, bad anatomy, watermark, text',
        }),
      });
      if (!res.ok) return { ok: false, error: `SD WebUI HTTP ${res.status}` };
      const data: any = await res.json();
      if (data && data.images && data.images.length) {
        return { ok: true, b64: data.images[0], mimeType: 'image/png' };
      }
      return { ok: false, error: 'SD WebUI 未返回图片' };
    }

    // OpenAI 兼容 /images/generations
    const res = await fetch(base + '/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model || cfg.model,
        prompt,
        n: 1,
        size: opts.width ? `${opts.width}x${opts.height || opts.width}` : '1024x1024',
        response_format: 'b64_json',
      }),
    });
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 300);
      return { ok: false, error: `图像服务 HTTP ${res.status}: ${errText}` };
    }
    const data: any = await res.json();
    const item = data && data.data && data.data[0];
    if (item && item.b64_json) {
      return { ok: true, b64: item.b64_json, mimeType: 'image/png' };
    }
    if (item && item.url) {
      const imgRes = await fetch(item.url);
      const imgBuf = Buffer.from(await imgRes.arrayBuffer());
      return { ok: true, b64: imgBuf.toString('base64'), mimeType: 'image/png' };
    }
    return { ok: false, error: '图像服务未返回图片数据' };
  } catch (e: any) {
    return { ok: false, error: '图片生成失败: ' + (e.message || String(e)) };
  }
}

/** 保存图片（base64）到指定路径 */
export function saveBase64Image(b64: string, savePath: string, mimeType = 'image/png'): string {
  const ext = mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png';
  const finalPath = savePath.endsWith(ext) ? savePath : savePath + ext;
  fs.writeFileSync(finalPath, Buffer.from(b64, 'base64'));
  return finalPath;
}

/** 默认导出目录（用户文档/启航AI工作台/导出） */
export function defaultExportDir(): string {
  const base = process.env.USERPROFILE || process.env.HOME || '';
  const dir = path.join(base, 'Documents', '启航AI工作台', '导出');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '未命名';
}
