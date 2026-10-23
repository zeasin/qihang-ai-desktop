// 笔记提炼（规则层）：扫描各项目 .md，粗提待办/跟进/工作日志并带出处；勾选项单向回写任务状态
import * as fs from 'fs';
import * as path from 'path';
import * as db from './database';
import logger from './logger';

const SYSTEM_IGNORED = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache', 'dist', 'build', 'target', '.idea', '.vscode', 'release', 'out']);

const MAX_FILES_PER_PROJECT = 300;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
// 锚点文件（TODO 清单、日期命名的日志）无条件扫描，但日志文件按最新 N 个截断防膨胀
const MAX_ANCHOR_FILES = 60;

export interface DigestTodo { project_id: number; project: string; file: string; line: number; text: string; done: boolean; }
export interface DigestFollowup { project_id: number; project: string; file: string; line: number; text: string; }
export interface DigestLogSection { project_id: number; project: string; file: string; line: number; date: string; heading: string; preview: string; }
export interface DigestResult { todos: DigestTodo[]; followups: DigestFollowup[]; logs: DigestLogSection[]; scannedFiles: number; generated_at: string; }

interface Candidate { full: string; rel: string; size: number; m: number; anchor: boolean; }

function splitIgnore(s: string): string[] {
  return String(s || '').split(/[,;、\n]/).map(x => x.trim()).filter(Boolean);
}

/** 去掉行内 markdown 记号，只留可读文本；超长截断（出处已带行号，完整原文在笔记里） */
function cleanText(s: string): string {
  const t = String(s || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > 160 ? t.slice(0, 160) + '…' : t;
}

function walkMd(dir: string, base: string, ignoreDirs: string[], ignoreFiles: string[], out: Candidate[]) {
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

function isAnchorName(name: string): boolean {
  return /^TODO\.md$/i.test(name) || /^\d{4}-\d{2}-\d{2}\.md$/i.test(name);
}

/** 取样：锚点文件（待办清单/日期日志）无条件纳入，其余按最近修改填满预算 */
function selectFiles(cands: Candidate[]): Candidate[] {
  const anchors = cands.filter(c => c.anchor).sort((a, b) => b.m - a.m).slice(0, MAX_ANCHOR_FILES);
  const picked = anchors.slice();
  let bytes = anchors.reduce((s, c) => s + c.size, 0);
  const rest = cands.filter(c => !c.anchor).sort((a, b) => b.m - a.m);
  for (const c of rest) {
    if (picked.length - anchors.length >= MAX_FILES_PER_PROJECT || bytes >= MAX_SCAN_BYTES) break;
    picked.push(c);
    bytes += c.size;
  }
  return picked;
}

// 复选框待办
const TODO_RE = /^\s*[-*+]\s*\[( |x|X)\]\s*(.+)$/;
// 日期命名的文件即一篇日志（工作/日报/2026-10-17.md）
const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/i;
// 纯日期标题（后面不带叙述）也算日志锚点；带叙述的多为决策记录，不在此列
const BARE_DATE_HEADING_RE = /^#{1,4}\s*[(（]?((?:20)?\d{2})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})(?:日)?[)）]?\s*$/;
// 跟进：只认状态话术，不认「跟进记录.md」这类文件名
const FOLLOWUP_RE = /(待跟进|需跟进|跟进中|跟进[:：]|跟进一下|跟进安排|跟进进展|跟进结果|跟进情况)/;
// 结构性噪声：表格行、标题、引用、路径引用
const NOISE_LINE_RE = /^[|>#]/;
// 目录/文件噪声：日历、模板、规则说明、AI 元文件
const NOISE_PATH_RE = /日历|calendar|AGENTS\.md|规则|模板|template|README|决策记录/i;
// 日志预览要跳过 frontmatter 与标签行
const SKIP_PREVIEW_RE = /^(---|tags?:|date?:|title?:|\s*$)/i;

function stripFrontmatter(lines: string[]): string[] {
  if (!lines.length || lines[0].trim() !== '---') return lines;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') return lines.slice(i + 1);
  return lines;
}

function pushLog(logs: DigestLogSection[], proj: any, rel: string, lines: string[], date: string, line: number) {
  let preview = '';
  let title = '';
  for (const raw of stripFrontmatter(lines)) {
    const t = raw.trim();
    if (!t || SKIP_PREVIEW_RE.test(t) || /^[-=]{3,}$/.test(t) || /^[|>]/.test(t)) continue;
    if (/^#{1,6}\s/.test(t)) {
      if (!title) title = cleanText(t.replace(/^#{1,6}\s*/, ''));
      continue;
    }
    preview = cleanText(t.replace(/^[-*+]\s+\[[ xX]\]\s*/, '').replace(/^[-*+]\s+/, '')).slice(0, 60);
    if (preview) break;
  }
  logs.push({ project_id: proj.id, project: proj.name, file: rel, line, date, heading: '', preview: preview || title });
}

export function extractDigest(): DigestResult {
  const todos: DigestTodo[] = [];
  const followups: DigestFollowup[] = [];
  const logs: DigestLogSection[] = [];
  let scannedFiles = 0;

  for (const proj of db.project.list() as any[]) {
    if (!proj.dir || !fs.existsSync(proj.dir)) continue;
    const cands: Candidate[] = [];
    walkMd(proj.dir, proj.dir, splitIgnore(proj.ignore_dirs), splitIgnore(proj.ignore_files), cands);
    for (const cand of selectFiles(cands)) {
      let content = '';
      try { content = fs.readFileSync(cand.full, 'utf-8'); } catch { continue; }
      if (!content) continue;
      scannedFiles++;
      const rel = cand.rel;
      const noisyPath = NOISE_PATH_RE.test(rel);
      const lines = content.split(/\r?\n/);

      // 噪声文件（日历、模板、规则、决策记录等）不参与提炼
      if (noisyPath) continue;

      // 待办：复选框全局识别；TODO.md 是人工维护的清单，其 bullet 条目同样视为待办
      const isTodoFile = /(^|\/)TODO\.md$/i.test(rel);
      let inTodoSection = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const todoMatch = line.match(TODO_RE);
        if (todoMatch) {
          const text = cleanText(todoMatch[2]);
          if (text) todos.push({ project_id: proj.id, project: proj.name, file: rel, line: i + 1, text, done: todoMatch[1] !== ' ' });
          continue;
        }
        if (isTodoFile) {
          if (/^#{1,4}\s/.test(line)) { inTodoSection = true; continue; }
          if (inTodoSection && /^[-*]\s+\S/.test(line) && !NOISE_LINE_RE.test(line) && line.length > 6) {
            todos.push({ project_id: proj.id, project: proj.name, file: rel, line: i + 1, text: cleanText(line.replace(/^[-*]\s+/, '')), done: false });
          }
        }
        if (FOLLOWUP_RE.test(line) && !NOISE_LINE_RE.test(line) && !/\.md/.test(line)) {
          followups.push({ project_id: proj.id, project: proj.name, file: rel, line: i + 1, text: cleanText(line.replace(/^[-*]\s+/, '')) });
        }
      }

      // 工作日志：日期命名的文件优先，其次文件内的纯日期标题
      const dm = path.basename(rel).match(DATE_FILE_RE);
      if (dm) pushLog(logs, proj, rel, lines, dm[1], 1);
      else {
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].trim().match(BARE_DATE_HEADING_RE);
          if (!m) continue;
          const y = m[1].length === 2 ? '20' + m[1] : m[1];
          pushLog(logs, proj, rel, lines.slice(i + 1), `${y}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`, i + 1);
        }
      }
    }
  }

  const seen = new Set<string>();
  const uniqTodos = todos.filter(t => {
    const k = `${t.project_id}|${t.text.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  uniqTodos.sort((a, b) => Number(a.done) - Number(b.done));
  logs.sort((a, b) => b.date.localeCompare(a.date));
  return { todos: uniqTodos, followups, logs, scannedFiles, generated_at: new Date().toISOString() };
}

/** 笔记里勾掉的 `- [x] 标题` 单向回写：同名 pending/in_progress 任务标记 done。返回受影响任务 id */
export function syncCheckedDone(digest?: DigestResult): number[] {
  const d = digest || extractDigest();
  const doneTitles = new Set(d.todos.filter(t => t.done).map(t => t.text.toLowerCase()));
  if (!doneTitles.size) return [];
  const touched: number[] = [];
  for (const t of db.task.list('pending').concat(db.task.list('in_progress')) as any[]) {
    const title = String(t.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (title && doneTitles.has(title)) {
      db.task.update(t.id, { status: 'done' });
      touched.push(t.id);
    }
  }
  if (touched.length) logger.info(`[NoteDigest] 勾选项回写 done：${touched.length} 个任务`);
  return touched;
}
