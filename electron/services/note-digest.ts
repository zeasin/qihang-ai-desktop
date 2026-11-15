// 笔记提炼（规则层）：扫描各项目 .md，粗提待办/跟进/工作日志并带出处；勾选项单向回写任务状态
// 扫描器与概览页看板共用（见 project-scan.ts），保证两处口径一致。
import * as fs from 'fs';
import * as path from 'path';
import * as db from './database';
import { walkMd, splitIgnore } from './project-scan';
import logger from './logger';

const MAX_FILES_PER_PROJECT = 300;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
// 锚点文件（TODO 清单、日期命名的日志）无条件扫描，但日志文件按最新 N 个截断防膨胀
const MAX_ANCHOR_FILES = 60;

// mtime：条目所在文件的最后修改时间（判断条目新鲜度）；section：条目所属的最近标题（判断条目属于哪个主题块）
export interface DigestTodo { project_id: number; project: string; file: string; line: number; text: string; done: boolean; mtime: number; section: string; }
// resolvable=true 表示来自专门的跟进清单（跟进.md），可在今天页一键结清（回写 [x]）
export interface DigestFollowup { project_id: number; project: string; file: string; line: number; text: string; resolvable?: boolean; mtime: number; section: string; }
export interface DigestLogSection { project_id: number; project: string; file: string; line: number; date: string; heading: string; preview: string; kind?: 'log' | 'doc'; }
export interface DigestResult { todos: DigestTodo[]; followups: DigestFollowup[]; logs: DigestLogSection[]; doneItems: Array<{ project_id: number; project: string; file: string; line: number; text: string; mtime: number }>; scannedFiles: number; generated_at: string; }

interface Candidate { full: string; rel: string; size: number; m: number; anchor: boolean; }

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
// 已勾选项保留窗口（天）：更早的勾选不会影响任何条目的新旧判定
const DONE_ITEMS_WINDOW_DAYS = 45;

/** 日期命名文件的内容日期（时间戳），非日期文件返回 0 */
function fileDateTs(rel: string): number {
  const m = path.basename(rel).match(DATE_FILE_RE);
  if (!m) return 0;
  const d = new Date(Number(m[1].slice(0, 4)), Number(m[1].slice(5, 7)) - 1, Number(m[1].slice(8, 10)), 0, 0, 0, 0);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function stripFrontmatter(lines: string[]): string[] {
  if (!lines.length || lines[0].trim() !== '---') return lines;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') return lines.slice(i + 1);
  return lines;
}

/** 条目行归一成纯文本（去掉 bullet/复选框记号），勾选回写时按文本匹配用 */
function normItemText(raw: string): string {
  return cleanText(String(raw).replace(TODO_RE, '$2').replace(/^\s*[-*+]\s+(\[[ xX]\]\s*)?/, '')).toLowerCase();
}

function pushLog(logs: DigestLogSection[], proj: any, rel: string, lines: string[], date: string, line: number, kind: 'log' | 'doc' = 'log') {
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
  logs.push({ project_id: proj.id, project: proj.name, file: rel, line, date, heading: '', preview: preview || title, kind });
}

export function extractDigest(): DigestResult {
  const todos: DigestTodo[] = [];
  const followups: DigestFollowup[] = [];
  const logs: DigestLogSection[] = [];
  // 已勾选项全量（不去重）：同一件事常常「老文件里还没勾、新文件里已勾」，
  // 日报模块靠它识别旧账——去重会把「已勾的那一份」吞掉。
  const doneItems: DigestResult['doneItems'] = [];
  const nowTs = Date.now();
  const doneWindowMs = DONE_ITEMS_WINDOW_DAYS * 86_400_000;
  let scannedFiles = 0;
  // 近 N 天更新过的文档都算进工作日志（含非日期命名的普通笔记）
  const RECENT_DOC_DAYS = 7;
  const recentDocsSince = Date.now() - RECENT_DOC_DAYS * 86_400_000;

  for (const proj of db.project.list() as any[]) {
    // 笔记提炼只认笔记库：代码仓库（type=code）里的 CONTRIBUTING 检查清单这类文档
    // 不是用户的待办，混进概览「等你处理」会误导出处（那边标的是「来自笔记」）
    if (proj.type === 'code') continue;
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
      // 跟进.md 是专门的跟进清单（锚点文件）：每条 bullet 即一个跟进项，`[x]` 视为已解决不展示；
      // 整文件只走跟进口径，不再进待办/模糊匹配，避免一稿两投
      const isFollowupFile = /(^|\/)(跟进|跟进事项)\.md$/i.test(rel);
      // 工作日志（日期命名文件、文件内纯日期标题分节）是历史记录：不参与跟进提炼，
      // 否则日志里出现过的「待跟进」会每次扫描都重新挂上，永远没有结清入口；
      // 勾选待办不受影响（复选框本身有勾掉的能力）
      const isLogFile = DATE_FILE_RE.test(path.basename(rel));
      let inTodoSection = false;
      let currentSection = '';   // 最近一个标题，作为条目的上下文
      let datedLevel = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // 标题行：记住最近标题，条目的「所属小节」后面用来判断主题块的新旧
        if (/^#{1,6}\s/.test(line)) currentSection = cleanText(line.replace(/^#{1,6}\s*/, ''));

        if (isFollowupFile) {
          if (/^\s*[-*+]\s+\S/.test(line) && !/^\s*[-*+]\s*\[[xX]\]/.test(line)) {
            followups.push({ project_id: proj.id, project: proj.name, file: rel, line: i + 1, text: cleanText(line.replace(/^\s*[-*+]\s*(\[[ xX]\]\s*)?/, '')), resolvable: true, mtime: cand.m, section: currentSection });
          }
          continue;
        }
        const todoMatch = line.match(TODO_RE);
        if (todoMatch) {
          const text = cleanText(todoMatch[2]);
          if (text) {
            const done = todoMatch[1] !== ' ';
            todos.push({ project_id: proj.id, project: proj.name, file: rel, line: i + 1, text, done, mtime: cand.m, section: currentSection });
            // 只留近期的已勾项：更早的勾选不可能把任何条目判成「旧账」，留着只会撑大 IPC 载荷
            if (done && nowTs - Math.max(cand.m, fileDateTs(rel)) <= doneWindowMs) {
              doneItems.push({ project_id: proj.id, project: proj.name, file: rel, line: i + 1, text, mtime: cand.m });
            }
          }
          continue;
        }
        if (isTodoFile) {
          if (/^#{1,4}\s/.test(line)) { inTodoSection = true; continue; }
          if (inTodoSection && /^[-*]\s+\S/.test(line) && !NOISE_LINE_RE.test(line) && line.length > 6) {
            todos.push({ project_id: proj.id, project: proj.name, file: rel, line: i + 1, text: cleanText(line.replace(/^[-*]\s+/, '')), done: false, mtime: cand.m, section: currentSection });
          }
        }
        // 日期分节跟踪：同级或更高级的标题结束该日期段，更深的日期标题接续该段
        if (/^#{1,6}\s/.test(line)) {
          const level = (line.match(/^#+/) || [''])[0].length;
          if (datedLevel && level <= datedLevel) { datedLevel = 0; }
        }
        const dh = !isLogFile ? line.match(BARE_DATE_HEADING_RE) : null;
        if (dh) datedLevel = (line.match(/^#+/) || [''])[0].length;
        if (isLogFile || datedLevel) continue;
        // 非清单文件的跟进口径：必须是 bullet 行，且不是统计字段/空标签
        // （「后续跟进：0」「记录跟进：」是 label: value 写法，冒号后只有数字或为空，不是待办）
        const isStatLabel = /跟进[:：]\s*\d*\s*$/.test(line);
        if (FOLLOWUP_RE.test(line) && !isStatLabel && !NOISE_LINE_RE.test(line) && !/\.md/.test(line) && /^[-*+]\s+\S/.test(line)) {
          followups.push({ project_id: proj.id, project: proj.name, file: rel, line: i + 1, text: cleanText(line.replace(/^[-*]\s+/, '')), mtime: cand.m, section: currentSection });
        }
      }

      // 工作日志：日期命名的文件优先，其次文件内的纯日期标题
      const dm = path.basename(rel).match(DATE_FILE_RE);
      if (dm) pushLog(logs, proj, rel, lines, dm[1], 1, 'log');
      else {
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].trim().match(BARE_DATE_HEADING_RE);
          if (!m) continue;
          const y = m[1].length === 2 ? '20' + m[1] : m[1];
          pushLog(logs, proj, rel, lines.slice(i + 1), `${y}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`, i + 1, 'log');
        }
        // 最近更新过的普通文档也进工作日志（按文件 mtime 计日期），不再是纯"日期命名"口径
        if (cand.m >= recentDocsSince) {
          const d = new Date(cand.m);
          const pad = (n: number) => String(n).padStart(2, '0');
          pushLog(logs, proj, rel, lines, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, 1, 'doc');
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
  // 同一文件同一天只留一条（日期标题条目与"最近更新"条目可能重叠）；总量截断防膨胀
  const seenLogs = new Set<string>();
  const uniqLogs = logs.filter((l) => {
    const k = `${l.project_id}|${l.file}|${l.date}`;
    if (seenLogs.has(k)) return false;
    seenLogs.add(k);
    return true;
  });
  uniqLogs.sort((a, b) => b.date.localeCompare(a.date));
  return { todos: uniqTodos, followups, logs: uniqLogs.slice(0, 60), doneItems, scannedFiles, generated_at: new Date().toISOString() };
}

/** 勾选/取消勾选笔记待办：把状态回写到笔记文件里的复选框；行号漂移时按文本全文兜底查找 */
export function checkDigestTodo(projectId: number, rel: string, line: number, text: string, done: boolean): { ok: boolean; error?: string; line?: number } {
  const proj = (db.project.list() as any[]).find(p => p.id === projectId);
  if (!proj?.dir) return { ok: false, error: '找不到来源笔记库' };
  const full = path.join(proj.dir, rel);
  if (!fs.existsSync(full)) return { ok: false, error: '笔记文件不存在：' + rel };
  let content = '';
  try { content = fs.readFileSync(full, 'utf-8'); } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  const lines = content.split(/\r?\n/);
  const want = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const isItem = (raw: string) => TODO_RE.test(raw) || /^\s*[-*+]\s+\S/.test(raw);

  // 先信 digest 记录的行号，对不上（文件已被编辑）再全文找同文本的行
  let idx = line - 1;
  if (!(idx >= 0 && idx < lines.length && isItem(lines[idx]) && normItemText(lines[idx]).includes(want))) {
    idx = lines.findIndex(raw => isItem(raw) && normItemText(raw).includes(want));
    if (idx < 0) return { ok: false, error: '笔记里没找到对应的待办行（可能已被修改），请重新扫描' };
  }

  const raw = lines[idx];
  const cm = raw.match(/^(\s*[-*+]\s*\[)( |x|X)(\]\s*)(.*)$/);
  if (cm) {
    lines[idx] = cm[1] + (done ? 'x' : ' ') + cm[3] + cm[4];
  } else {
    // TODO.md 人工清单的普通条目没有复选框：勾选时补上
    const bm = raw.match(/^(\s*[-*+]\s+)(.*)$/);
    if (!bm) return { ok: false, error: '该行不是待办条目' };
    lines[idx] = bm[1] + (done ? '[x] ' : '[ ] ') + bm[2];
  }
  try { fs.writeFileSync(full, lines.join('\n'), 'utf-8'); } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  logger.info(`[NoteDigest] 待办勾选回写：${rel}:${idx + 1} → ${done ? '[x]' : '[ ]'}`);
  return { ok: true, line: idx + 1 };
}

/** 结清跟进清单里的一条跟进：在跟进.md / 跟进事项.md 的 bullet 前回写 [x]；行号漂移时按文本全文兜底 */
export function checkDigestFollowup(projectId: number, rel: string, line: number, text: string): { ok: boolean; error?: string; line?: number } {
  if (!/(^|\/)(跟进|跟进事项)\.md$/i.test(rel)) return { ok: false, error: '只有跟进清单（跟进.md / 跟进事项.md）里的条目支持勾选结清' };
  const proj = (db.project.list() as any[]).find(p => p.id === projectId);
  if (!proj?.dir) return { ok: false, error: '找不到来源笔记库' };
  const full = path.join(proj.dir, rel);
  if (!fs.existsSync(full)) return { ok: false, error: '笔记文件不存在：' + rel };
  let content = '';
  try { content = fs.readFileSync(full, 'utf-8'); } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  const lines = content.split(/\r?\n/);
  const want = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const isItem = (raw: string) => /^\s*[-*+]\s+\S/.test(raw);

  // 先信 digest 记录的行号，对不上（文件已被编辑）再全文找同文本的行
  let idx = line - 1;
  if (!(idx >= 0 && idx < lines.length && isItem(lines[idx]) && normItemText(lines[idx]).includes(want))) {
    idx = lines.findIndex(raw => isItem(raw) && normItemText(raw).includes(want));
    if (idx < 0) return { ok: false, error: '跟进清单里没找到对应的条目（可能已被修改），请重新扫描' };
  }
  if (/^\s*[-*+]\s*\[[xX]\]/.test(lines[idx])) return { ok: true, line: idx + 1 }; // 已是结清状态

  const bm = lines[idx].match(/^(\s*[-*+]\s+)(\[[ xX]\]\s*)?(.*)$/);
  if (!bm) return { ok: false, error: '该行不是跟进条目' };
  lines[idx] = bm[1] + '[x] ' + bm[3];
  try { fs.writeFileSync(full, lines.join('\n'), 'utf-8'); } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  logger.info(`[NoteDigest] 跟进结清回写：${rel}:${idx + 1} → [x]`);
  return { ok: true, line: idx + 1 };
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
