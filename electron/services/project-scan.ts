// 项目目录实时扫描：取代已作废的向量索引（kb_documents / kb_chunks）。
//
// 为什么是实时扫描：
//   索引路线（切分 → 嵌入 → BM25/hybrid 检索）已经整体作废 —— 现在项目库的检索与读写
//   都由 pi agent 用自己的 read/bash/write 直接做，工作台不再需要维护第二份内容副本。
//   但概览页的看板（文件数、今日修改、标签分布、子目录分布、热力图）本来是读索引表拿到的，
//   索引表一删这些数字就全变 0。改成现扫现算：项目库里有什么，数字就是什么。
//
// 扫描口径：只认 .md 作为内容源（项目根 AGENTS.md 的约定：内容以 .md 为准），
// 排除系统目录与项目自定义的 ignore_dirs / ignore_files。
import * as fs from 'fs';
import * as path from 'path';
import * as db from './database';

export const SYSTEM_IGNORED = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache',
  'dist', 'build', 'target', '.idea', '.vscode', 'release', 'out',
]);

/** 单文件读取上限：标签统计只读文件头，超过这个体积按截断处理 */
const MAX_TAG_READ_BYTES = 256 * 1024;

export interface ScanFile {
  projectId: number;
  projectName: string;
  full: string;      // 绝对路径
  rel: string;       // 相对项目根，正斜杠
  subDir: string;    // 项目根下的一级子目录；根目录下的文件为 '根目录'
  size: number;      // 字节
  mtime: number;     // 修改时间（ms）
}

/** 把「a,b、c;d」这类配置串拆成数组 */
export function splitIgnore(s: string): string[] {
  return String(s || '').split(/[,;、\n]/).map(x => x.trim()).filter(Boolean);
}

/**
 * 递归收集项目目录下的 .md 文件。
 * out 里每项是 { full, rel, size, m, anchor } —— rel 相对 base，正斜杠分隔。
 * anchor 标记「锚点文件」（TODO 清单、日期命名的日志），笔记提炼会无条件纳入它们。
 */
export function walkMd(dir: string, base: string, ignoreDirs: string[], ignoreFiles: string[], out: Array<{ full: string; rel: string; size: number; m: number; anchor: boolean }>): void {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SYSTEM_IGNORED.has(entry.name.toLowerCase())) continue;
      if (ignoreDirs.includes(entry.name)) continue;
      walkMd(full, base, ignoreDirs, ignoreFiles, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      if (ignoreFiles.includes(entry.name)) continue;
      let size = 0;
      let m = 0;
      try { const st = fs.statSync(full); size = st.size; m = st.mtimeMs; } catch { continue; }
      out.push({ full, rel: path.relative(base, full).replace(/\\/g, '/'), size, m, anchor: isAnchorName(entry.name) });
    }
  }
}

/** 锚点文件：TODO 清单、日期命名的日志 */
export function isAnchorName(name: string): boolean {
  return /^TODO\.md$/i.test(name) || /^\d{4}-\d{2}-\d{2}\.md$/i.test(name);
}

/** 扫一个项目的全部 .md */
export function scanProject(proj: any): ScanFile[] {
  const out: ScanFile[] = [];
  if (!proj || !proj.dir) return out;
  try { if (!fs.existsSync(proj.dir)) return out; } catch { return out; }
  const raw: Array<{ full: string; rel: string; size: number; m: number; anchor: boolean }> = [];
  walkMd(proj.dir, proj.dir, splitIgnore(proj.ignore_dirs), splitIgnore(proj.ignore_files), raw);
  for (const f of raw) {
    const seg = f.rel.split('/');
    out.push({
      projectId: proj.id,
      projectName: proj.name,
      full: f.full,
      rel: f.rel,
      subDir: seg.length > 1 ? seg[0] : '根目录',
      size: f.size,
      mtime: f.m,
    });
  }
  return out;
}

/** 扫所有项目 */
export function scanAllProjects(): ScanFile[] {
  const out: ScanFile[] = [];
  for (const proj of db.project.list() as any[]) out.push(...scanProject(proj));
  return out;
}

/** 今日（本地时区）0 点的时间戳 */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 文件总数与今日修改数 */
export function collectStats(): { fileCount: number; todayModified: number } {
  const files = scanAllProjects();
  const t0 = startOfToday();
  let todayModified = 0;
  for (const f of files) if (f.mtime >= t0) todayModified++;
  return { fileCount: files.length, todayModified };
}

/** 按项目分组的文件统计 */
export function collectPerProject(): Array<{ projectId: number; name: string; isDefault: boolean; docCount: number; todayModified: number }> {
  const defaultId = (db.project.getDefault() || {}).id;
  const projects = db.project.list() as any[];
  const files = scanAllProjects();
  const t0 = startOfToday();
  return projects.map(p => {
    const own = files.filter(f => f.projectId === p.id);
    return {
      projectId: p.id,
      name: p.name,
      isDefault: p.id === defaultId,
      docCount: own.length,
      todayModified: own.filter(f => f.mtime >= t0).length,
    };
  });
}

/**
 * 子目录分布：按项目根下的一级子目录归类。
 * 保留 analysis / hasAnalysis 字段 —— 项目分析结果仍存在 ai_analysis 表里，按目录名对齐。
 */
export function collectSubProjects(): Array<{ name: string; fileCount: number; totalSize: number; files: string[]; analysis?: string; hasAnalysis: boolean }> {
  const files = scanAllProjects();
  const dirMap: Record<string, { name: string; fileCount: number; totalSize: number; files: string[]; analysis?: string; hasAnalysis: boolean }> = {};
  for (const f of files) {
    const key = f.subDir;
    if (!dirMap[key]) dirMap[key] = { name: key, fileCount: 0, totalSize: 0, files: [], hasAnalysis: false };
    dirMap[key].fileCount++;
    dirMap[key].totalSize += f.size;
    dirMap[key].files.push(f.rel);
  }
  const result = Object.values(dirMap).sort((a, b) => b.fileCount - a.fileCount);
  let analyses: any[] = [];
  try { analyses = db.q("SELECT dir_path, content FROM ai_analysis WHERE type = 'project_analysis'"); } catch {}
  for (const p of result) {
    const a = analyses.find(x => x.dir_path === p.name);
    if (a) p.analysis = a.content;
    p.hasAnalysis = !!a;
  }
  return result;
}

/**
 * 标签统计：frontmatter 里的 tags + 正文中的 #话题。
 * 与原先基于索引内容的口径一致，但数据源换成实时文件。
 */
export function collectTags(): Array<{ name: string; count: number }> {
  const files = scanAllProjects();
  const tagCount: Record<string, number> = {};
  for (const f of files) {
    let content = '';
    try {
      const fd = fs.openSync(f.full, 'r');
      try {
        const buf = Buffer.alloc(Math.min(MAX_TAG_READ_BYTES, f.size || MAX_TAG_READ_BYTES));
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        content = buf.subarray(0, read).toString('utf-8');
      } finally { fs.closeSync(fd); }
    } catch { continue; }

    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (frontmatter) {
      const tagsMatch = frontmatter[1].match(/tags\s*:\s*\[([^\]]*)\]/);
      if (tagsMatch) {
        tagsMatch[1].split(',').forEach(t => {
          const tag = t.trim().replace(/['"]/g, '');
          if (tag) tagCount[tag] = (tagCount[tag] || 0) + 1;
        });
      }
    }
    const hashtags = content.match(/#([\p{L}\p{N}_\-\u4e00-\u9fff]+)/gu);
    if (hashtags) {
      hashtags.forEach(t => {
        const tag = t.slice(1);
        if (tag) tagCount[tag] = (tagCount[tag] || 0) + 1;
      });
    }
  }
  return Object.entries(tagCount).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/** 最近 365 天的文件修改热力图 */
export function collectHeatmap(): Record<string, number> {
  const files = scanAllProjects();
  const dateCount: Record<string, number> = {};
  for (const f of files) {
    const key = new Date(f.mtime).toISOString().slice(0, 10);
    dateCount[key] = (dateCount[key] || 0) + 1;
  }
  const heatmap: Record<string, number> = {};
  const now = Date.now();
  for (let i = 364; i >= 0; i--) {
    const key = new Date(now - i * 86400000).toISOString().slice(0, 10);
    heatmap[key] = dateCount[key] || 0;
  }
  return heatmap;
}
