/**
 * 知识库 MCP —— 笔记索引层（kb-index.ts）
 *
 * 给 MCP 工具（kb-tools.ts）提供笔记库的索引与检索能力：
 *   - 索引表：kb_note_docs（元数据）+ kb_note_fts（FTS5 trigram 全文），建表在 database.ts initSchema
 *   - 同步三保险：启动差量 syncNotes() + fs.watch 增量 ensureWatchers() + 手动重建（reindexNotes）
 *   - 检索：searchNotes（MATCH+bm25，短词降级标题 LIKE）/ getNoteContent / listNoteProjects / listProjectFiles
 *
 * 口径说明：
 *   - 笔记项目 = prj_projects 里 type='note' 的项目（config.notesDir 只是默认库指针，多库都在这里）
 *   - 只收 .md（复用 project-scan.ts 的 walkMd，含 SYSTEM_IGNORED / 点目录 / 项目自定义 ignore 口径）
 *   - 单文件更新 = 删 + 插（个人量级毫秒级），不搞增量管道 —— 上次索引路线作废的教训是维护成本
 */
import * as fs from 'fs';
import * as path from 'path';
import * as db from '../services/database';
import { walkMd, splitIgnore } from '../services/project-scan';
import { RadarDb, dbPath } from '../radar/radar-db';
import { radarDataDir } from '../radar/radar-config';
import logger from '../services/logger';

/** 单文件索引上限：超过不读正文（trigram 索引没必要吃超大文件） */
const MAX_INDEX_BYTES = 5 * 1024 * 1024;
/** get_note 返回正文截断长度 */
export const MAX_NOTE_CONTENT_CHARS = 100_000;
/** fs.watch 变更防抖（ms）：合并 bursts，也给编辑器完成写盘留时间 */
const WATCH_DEBOUNCE_MS = 1500;

interface WalkFile { full: string; rel: string; size: number; m: number; anchor: boolean; }

// ========== 差量同步 ==========

/** 索引单个文件：读正文 → fts 删+插 → docs upsert。返回 false 表示跳过（超大/读失败） */
function indexOne(projectId: number, f: WalkFile): boolean {
  if (f.size > MAX_INDEX_BYTES) {
    logger.warn('[KbIndex] 跳过超大文件(%d MB): %s', Math.round(f.size / 1048576), f.full);
    return false;
  }
  let content = '';
  try { content = fs.readFileSync(f.full, 'utf-8'); } catch (e: any) {
    logger.warn('[KbIndex] 读取失败，跳过: %s (%s)', f.full, e?.message || e);
    return false;
  }
  const title = path.basename(f.rel).replace(/\.md$/i, '');
  db.run('DELETE FROM kb_note_fts WHERE abs_path = ?', f.full);
  db.run('INSERT INTO kb_note_fts (content, abs_path) VALUES (?, ?)', content, f.full);
  db.run(`
    INSERT INTO kb_note_docs (project_id, rel_path, abs_path, size, mtime_ms, title)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(abs_path) DO UPDATE SET
      project_id = excluded.project_id,
      rel_path   = excluded.rel_path,
      size       = excluded.size,
      mtime_ms   = excluded.mtime_ms,
      title      = excluded.title,
      indexed_at = datetime('now', '+8 hours')
  `, projectId, f.rel, f.full, f.size, Math.floor(f.m), title);
  return true;
}

/** 删除一个已索引文档（fts + docs） */
function removeDoc(absPath: string): void {
  db.run('DELETE FROM kb_note_fts WHERE abs_path = ?', absPath);
  db.run('DELETE FROM kb_note_docs WHERE abs_path = ?', absPath);
}

/**
 * 全量差量同步：遍历所有笔记项目，按 (size, mtime) 与 kb_note_docs 比对，只动变化的文件。
 * force=true 时无视比对全部重索引（手动重建按钮用）。
 */
export function syncNotes(force = false): { projects: number; indexed: number; removed: number; total: number } {
  const projects = (db.project.list('note') || []) as any[];
  const existing = db.q('SELECT abs_path, size, mtime_ms FROM kb_note_docs') as any[];
  const byPath = new Map<string, any>(existing.map((r) => [r.abs_path, r]));
  const seen = new Set<string>();
  let indexed = 0;

  for (const proj of projects) {
    if (!proj.dir || !fs.existsSync(proj.dir)) continue;
    const files: WalkFile[] = [];
    walkMd(proj.dir, proj.dir, splitIgnore(proj.ignore_dirs), splitIgnore(proj.ignore_files), files);
    for (const f of files) {
      seen.add(f.full);
      const prev = byPath.get(f.full);
      if (!force && prev && Number(prev.size) === f.size && Number(prev.mtime_ms) === Math.floor(f.m)) continue;
      if (indexOne(proj.id, f)) indexed++;
    }
  }

  // 磁盘上已消失的（含项目被删/目录被移走）一并清掉
  let removed = 0;
  for (const row of existing) {
    if (seen.has(row.abs_path)) continue;
    removeDoc(row.abs_path);
    removed++;
  }

  const total = countNotes();
  if (indexed || removed) logger.info('[KbIndex] 笔记索引同步完成：更新 %d，清理 %d，共 %d 篇（%d 个项目）', indexed, removed, total, projects.length);
  return { projects: projects.length, indexed, removed, total };
}

// ========== fs.watch 增量 ==========

const watchers = new Map<string, fs.FSWatcher>();
const pending = new Map<string, Set<string>>();   // 项目根 -> 待重索引的绝对路径
const timers = new Map<string, NodeJS.Timeout>(); // 项目根 -> 防抖定时器

function findProjectByDir(dir: string): any | null {
  return ((db.project.list('note') || []) as any[]).find((p) => p.dir && path.resolve(p.dir) === path.resolve(dir)) || null;
}

function flushProject(dirKey: string): void {
  const changed = pending.get(dirKey) || new Set<string>();
  pending.delete(dirKey);
  timers.delete(dirKey);
  if (!changed.size) return;
  const proj = findProjectByDir(dirKey);
  let n = 0;
  for (const abs of changed) {
    try {
      if (!fs.existsSync(abs)) { removeDoc(abs); continue; }
      const st = fs.statSync(abs);
      if (!st.isFile() || !abs.toLowerCase().endsWith('.md')) continue;
      const rel = path.relative(dirKey, abs).replace(/\\/g, '/');
      if (indexOne(proj ? proj.id : (db.qOne('SELECT project_id FROM kb_note_docs WHERE abs_path = ?', abs) || {}).project_id, { full: abs, rel, size: st.size, m: st.mtimeMs, anchor: false })) n++;
    } catch (e: any) {
      logger.warn('[KbIndex] 增量索引失败 %s: %s', abs, e?.message || e);
    }
  }
  if (n) logger.info('[KbIndex] 增量索引 %d 个文件（%s）', n, path.basename(dirKey));
}

/** 对所有笔记项目开 fs.watch（recursive，Windows/macOS 支持）。出错只记日志，正确性由启动差量兜底 */
export function ensureWatchers(): void {
  stopWatchers();
  for (const proj of (db.project.list('note') || []) as any[]) {
    if (!proj.dir || !fs.existsSync(proj.dir)) continue;
    const root = path.resolve(proj.dir);
    try {
      const w = fs.watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) { // 拿不到具体文件名（个别平台行为）：整项目标记，flush 时靠 stat 兜底
          // 粗粒度处理：把根记为脏，flush 时只重索引 docs 里该项目缺失的（保守起见不做全扫）
          return;
        }
        const abs = path.join(root, filename);
        if (!abs.toLowerCase().endsWith('.md')) return;
        let set = pending.get(root);
        if (!set) { set = new Set(); pending.set(root, set); }
        set.add(abs);
        const t = timers.get(root);
        if (t) clearTimeout(t);
        timers.set(root, setTimeout(() => flushProject(root), WATCH_DEBOUNCE_MS));
      });
      w.on('error', (e: any) => {
        logger.warn('[KbIndex] fs.watch 失效（%s），后续靠启动/手动同步兜底: %s', proj.name, e?.message || e);
        try { w.close(); } catch {}
        watchers.delete(root);
      });
      watchers.set(root, w);
    } catch (e: any) {
      logger.warn('[KbIndex] 无法监听 %s: %s', root, e?.message || e);
    }
  }
}

export function stopWatchers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  pending.clear();
  for (const w of watchers.values()) { try { w.close(); } catch {} }
  watchers.clear();
}

/** 启动/手动后的常规入口：差量同步 + 确保监听就位 */
export async function refreshIndex(): Promise<{ projects: number; indexed: number; removed: number; total: number }> {
  const r = syncNotes(false);
  ensureWatchers();
  return r;
}

/** 手动重建：无视比对全量重索引 */
export async function reindexNotes(): Promise<{ projects: number; indexed: number; removed: number; total: number }> {
  const r = syncNotes(true);
  ensureWatchers();
  return r;
}

/**
 * 应用内对话索引回填（只做一次，kb_index_meta 标记）。
 * FTS 表建成后新消息由触发器同步，历史消息需 rebuild 一次；放启动后台执行，失败可重跑。
 */
export function ensureChatIndex(): { rebuilt: boolean; rows: number; ms: number } {
  const done = db.qOne("SELECT value FROM kb_index_meta WHERE key = 'chat_backfill_at'");
  if (done) return { rebuilt: false, rows: 0, ms: 0 };
  const t0 = Date.now();
  const rows = Number((db.qOne('SELECT COUNT(*) AS c FROM prj_messages') || {}).c || 0);
  db.run("INSERT INTO chat_message_fts(chat_message_fts) VALUES('rebuild')");
  db.run(
    `INSERT INTO kb_index_meta (key, value) VALUES ('chat_backfill_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    localNow(),
  );
  const ms = Date.now() - t0;
  logger.info('[KbIndex] 应用内对话索引回填完成：%d 条，耗时 %d ms', rows, ms);
  return { rebuilt: true, rows, ms };
}

/** 本地时间 'YYYY-MM-DD HH:mm:ss'（项目约定：持久化时间一律上海本地时间） */
function localNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** N 天前的本地时间字符串（用于按 created_at 过滤） */
function sinceLocal(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ========== 检索 ==========

export function countNotes(): number {
  return Number((db.qOne('SELECT COUNT(*) AS c FROM kb_note_docs') || {}).c || 0);
}

/**
 * 构造 FTS5 MATCH 词：按空白拆词，每词加引号成短语（防 FTS 语法注入），OR 连接。
 * trigram 要求短语 ≥3 字符，过短的词丢弃；全部过短返回空串（调用方降级 LIKE）。
 */
function buildMatchTerms(query: string): string[] {
  return String(query || '').trim().split(/\s+/)
    .filter(Boolean)
    .filter((t) => [...t].length >= 3)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
}

export interface NoteHit { absPath: string; project: string; rel: string; title: string; snippet: string; mtimeMs: number; score: number; }

/**
 * 笔记全文检索。
 * ≥3 字符走 FTS5 trigram MATCH + bm25 排序 + snippet 摘录；过短降级为标题 LIKE（mtime 排序）。
 */
export function searchNotes(query: string, limit = 10): { hits: NoteHit[]; mode: 'fts' | 'title-like' } {
  const queryStr = String(query || '').trim();
  if (!queryStr) return { hits: [], mode: 'fts' };
  const terms = buildMatchTerms(queryStr);
  const sql = `
    SELECT d.abs_path AS absPath, d.rel_path AS rel, d.title AS title, d.mtime_ms AS mtimeMs,
           COALESCE(p.name, '') AS project,
           snippet(kb_note_fts, 0, '『', '』', '…', 14) AS snippet,
           bm25(kb_note_fts) AS score
      FROM kb_note_fts
      JOIN kb_note_docs d ON d.abs_path = kb_note_fts.abs_path
      LEFT JOIN prj_projects p ON p.id = d.project_id
     WHERE kb_note_fts MATCH ?
     ORDER BY score
     LIMIT ?`;
  if (terms.length) {
    const rows = db.q(sql, terms.join(' OR '), limit) as any[];
    return { hits: rows.map((r) => ({ absPath: r.absPath, project: r.project, rel: r.rel, title: r.title, snippet: r.snippet || '', mtimeMs: Number(r.mtimeMs) || 0, score: Number(r.score) || 0 })), mode: 'fts' };
  }
  // 短词（如单字）降级：只匹配标题，正文不搜
  const esc = queryStr.replace(/[\\%_]/g, (c) => '\\' + c);
  const rows = db.q(`
    SELECT d.abs_path AS absPath, d.rel_path AS rel, d.title AS title, d.mtime_ms AS mtimeMs,
           COALESCE(p.name, '') AS project, '' AS snippet, 0 AS score
      FROM kb_note_docs d
      LEFT JOIN prj_projects p ON p.id = d.project_id
     WHERE d.title LIKE ? ESCAPE '\\'
     ORDER BY d.mtime_ms DESC
     LIMIT ?`, `%${esc}%`, limit) as any[];
  return { hits: rows.map((r) => ({ absPath: r.absPath, project: r.project, rel: r.rel, title: r.title, snippet: r.snippet || '', mtimeMs: Number(r.mtimeMs) || 0, score: Number(r.score) || 0 })), mode: 'title-like' };
}

/** 笔记项目列表（带已索引篇数） */
export function listNoteProjects(): Array<{ projectId: number; name: string; dir: string; docCount: number }> {
  const rows = db.q(`
    SELECT p.id AS projectId, p.name AS name, COALESCE(p.dir, '') AS dir, COUNT(d.id) AS docCount
      FROM prj_projects p
      LEFT JOIN kb_note_docs d ON d.project_id = p.id
     WHERE p.type = 'note'
     GROUP BY p.id
     ORDER BY p.sort_order ASC, p.created_at DESC`) as any[];
  return rows.map((r) => ({ projectId: Number(r.projectId), name: r.name, dir: r.dir || '', docCount: Number(r.docCount) || 0 }));
}

/** 单项目的已索引文件清单 */
export function listProjectFiles(projectId: number, limit = 200): { files: Array<{ rel: string; title: string; mtimeMs: number }>; hasMore: boolean } {
  const rows = db.q(`
    SELECT rel_path AS rel, title, mtime_ms AS mtimeMs
      FROM kb_note_docs
     WHERE project_id = ?
     ORDER BY rel_path ASC
     LIMIT ?`, projectId, limit + 1) as any[];
  const hasMore = rows.length > limit;
  const files = rows.slice(0, limit).map((r) => ({ rel: r.rel, title: r.title, mtimeMs: Number(r.mtimeMs) || 0 }));
  return { files, hasMore };
}

/** 把传入 path 解析到某个笔记项目根下；返回 {proj, abs} 或 null（越权/不认识） */
function resolveToProject(p: string): { proj: any; abs: string } | null {
  const candidates = [p];
  // 支持「项目名/相对路径」写法
  const projects = (db.project.list('note') || []) as any[];
  const firstSeg = p.split(/[\\/]/)[0];
  const byName = projects.find((x) => x.name === firstSeg);
  if (byName && byName.dir) candidates.push(path.join(byName.dir, p.slice(firstSeg.length).replace(/^[\\/]+/, '')));
  for (const proj of projects) {
    if (!proj.dir) continue;
    const root = path.resolve(proj.dir);
    for (const cand of candidates) {
      const abs = path.resolve(cand);
      const rel = path.relative(root, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (abs.toLowerCase().endsWith('.md')) return { proj, abs };
    }
  }
  return null;
}

/** 读笔记全文（越权防护 + 二进制检测 + 截断）。供 get_note 工具使用 */
export function getNoteContent(p: string): { ok: true; abs: string; project: string; rel: string; title: string; content: string; truncated: boolean } | { ok: false; error: string } {
  const resolved = resolveToProject(String(p || ''));
  if (!resolved) return { ok: false, error: '路径不在任何笔记库项目下（或不是 .md）：' + p };
  const { proj, abs } = resolved;
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); } catch { return { ok: false, error: '文件不存在：' + abs }; }
  if (!stat.isFile()) return { ok: false, error: '不是文件：' + abs };
  if (stat.size > MAX_INDEX_BYTES) return { ok: false, error: `文件过大（${Math.round(stat.size / 1048576)} MB），不予读取` };
  let content = '';
  try { content = fs.readFileSync(abs, 'utf-8'); } catch (e: any) { return { ok: false, error: '读取失败：' + (e?.message || e) }; }
  if (content.includes('\0')) return { ok: false, error: '疑似二进制文件，不予读取' };
  let truncated = false;
  if (content.length > MAX_NOTE_CONTENT_CHARS) { content = content.slice(0, MAX_NOTE_CONTENT_CHARS); truncated = true; }
  return {
    ok: true,
    abs,
    project: proj.name || '',
    rel: path.relative(path.resolve(proj.dir), abs).replace(/\\/g, '/'),
    title: path.basename(abs).replace(/\.md$/i, ''),
    content,
    truncated,
  };
}

// ========== 会话 / 应用内对话 / 报告检索 ==========

let radarDb: RadarDb | null = null;

/** 惰性只读连接 radar.db；库不存在返回 null（工具侧优雅降级，不影响笔记检索） */
function getRadarDb(): RadarDb | null {
  if (radarDb) return radarDb;
  try {
    const root = radarDataDir();
    if (!fs.existsSync(dbPath(root))) return null;
    radarDb = new RadarDb(root, { readonly: true });
    return radarDb;
  } catch (e: any) {
    logger.warn('[KbIndex] radar.db 只读打开失败（会话检索暂不可用）: %s', e?.message || e);
    return null;
  }
}

export function radarAvailable(): boolean {
  return !!getRadarDb();
}

export interface SessionHit {
  tool: string;
  sessionId: string;
  title: string;
  projectDir: string;
  snippet: string;
  state: string;
  updatedAt: number;
}

/**
 * 外部 AI 会话检索（radar.db）：消息级 FTS 命中给片段，会话级命中（标题/摘要）兜底。
 * agent 参数做 tool 包含匹配（'claude' → 'claude-code'）；同一会话只出一条。
 */
export function searchSessions(q: string, limit = 10, opts: { agent?: string; days?: number } = {}): SessionHit[] {
  const rdb = getRadarDb();
  if (!rdb) return [];
  const queryStr = String(q || '').trim();
  if (!queryStr) return [];
  const lim = Math.min(Math.max(limit, 1), 50);
  const agent = String(opts.agent || '').trim().toLowerCase();
  const since = opts.days && opts.days > 0 ? Date.now() - opts.days * 86400_000 : 0;
  const toolOk = (tool: string) => !agent || String(tool || '').toLowerCase().includes(agent);
  const out = new Map<string, SessionHit>();

  try {
    for (const m of rdb.searchMessages(queryStr, Math.min(Math.max(lim * 5, 20), 120))) {
      if (!toolOk(m.tool)) continue;
      if (since && Number(m.ts) < since) continue;
      const key = `${m.tool}::${m.sessionId}`;
      if (out.has(key)) continue;
      out.set(key, {
        tool: m.tool,
        sessionId: m.sessionId,
        title: m.title || '',
        projectDir: m.projectDir || '',
        snippet: String(m.content || '').replace(/\s+/g, ' ').slice(0, 220),
        state: m.state || '',
        updatedAt: Number(m.ts) || 0,
      });
      if (out.size >= lim * 3) break;
    }
  } catch (e: any) {
    logger.warn('[KbIndex] 会话消息检索失败: %s', e?.message || e);
  }

  try {
    for (const s of rdb.findSessions(queryStr, Math.min(Math.max(lim * 3, 10), 60))) {
      if (!toolOk(s.tool)) continue;
      if (since && Number(s.sourceUpdatedAt) < since) continue;
      const key = `${s.tool}::${s.sessionId}`;
      const existing = out.get(key);
      const snippet = String(s.summary || '').replace(/\s+/g, ' ').slice(0, 300);
      if (existing) {
        if (!existing.snippet && snippet) existing.snippet = snippet;
        if (!existing.title && s.title) existing.title = s.title;
        existing.updatedAt = Math.max(existing.updatedAt, Number(s.sourceUpdatedAt) || 0);
        continue;
      }
      out.set(key, {
        tool: s.tool,
        sessionId: s.sessionId,
        title: s.title || '',
        projectDir: s.projectDir || '',
        snippet,
        state: s.state || '',
        updatedAt: Number(s.sourceUpdatedAt) || 0,
      });
      if (out.size >= lim * 4) break;
    }
  } catch (e: any) {
    logger.warn('[KbIndex] 会话聚合检索失败: %s', e?.message || e);
  }

  return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, lim);
}

export interface ChatHit {
  rowid: number;
  sessionId: string;
  role: string;
  title: string;
  snippet: string;
  createdAt: string;
  score: number;
}

/** 应用内对话检索（chat_message_fts，触发器自动同步）。过短词降级 LIKE */
export function searchChat(q: string, limit = 10, opts: { days?: number } = {}): ChatHit[] {
  const queryStr = String(q || '').trim();
  if (!queryStr) return [];
  const lim = Math.min(Math.max(limit, 1), 50);
  const useDays = !!(opts.days && opts.days > 0);
  const dayCond = useDays ? 'AND m.created_at >= ?' : '';
  const dayParams: any[] = useDays ? [sinceLocal(opts.days!)] : [];
  const terms = buildMatchTerms(queryStr);
  if (terms.length) {
    return db.q(`
      SELECT m.rowid AS rowid, m.session_id AS sessionId, m.role AS role, m.created_at AS createdAt,
             COALESCE(s.title, '') AS title,
             snippet(chat_message_fts, 0, '『', '』', '…', 20) AS snippet,
             bm25(chat_message_fts) AS score
        FROM chat_message_fts
        JOIN prj_messages m ON m.rowid = chat_message_fts.rowid
        LEFT JOIN prj_sessions s ON s.session_id = m.session_id
       WHERE chat_message_fts MATCH ? ${dayCond}
       ORDER BY score LIMIT ?`, terms.join(' OR '), ...dayParams, lim) as ChatHit[];
  }
  // 短词降级：正文 LIKE
  const esc = queryStr.replace(/[\\%_]/g, (c) => '\\' + c);
  return db.q(`
    SELECT m.rowid AS rowid, m.session_id AS sessionId, m.role AS role, m.created_at AS createdAt,
           COALESCE(s.title, '') AS title, substr(m.content, 1, 220) AS snippet, 0 AS score
      FROM prj_messages m
      LEFT JOIN prj_sessions s ON s.session_id = m.session_id
     WHERE m.content LIKE ? ESCAPE '\\' ${dayCond}
     ORDER BY m.rowid DESC LIMIT ?`, `%${esc}%`, ...dayParams, lim) as ChatHit[];
}

export interface ReportHit {
  id: number;
  type: string;
  moduleId: string;
  reportDate: string;
  snippet: string;
}

/** 历史报告/模块分析检索（ai_analysis，个人量级用 LIKE） */
export function searchReports(q: string, limit = 10, opts: { days?: number } = {}): ReportHit[] {
  const queryStr = String(q || '').trim();
  if (!queryStr) return [];
  const lim = Math.min(Math.max(limit, 1), 50);
  const esc = queryStr.replace(/[\\%_]/g, (c) => '\\' + c);
  const params: any[] = [`%${esc}%`];
  let dayCond = '';
  if (opts.days && opts.days > 0) {
    dayCond = 'AND report_date >= ?';
    params.push(sinceLocal(opts.days).slice(0, 10));
  }
  const rows = db.q(`
    SELECT id, type, module_id AS moduleId, report_date AS reportDate, content
      FROM ai_analysis
     WHERE content LIKE ? ESCAPE '\\' ${dayCond}
     ORDER BY report_date DESC, id DESC LIMIT ?`, ...params, lim) as any[];
  return rows.map((r) => ({
    id: Number(r.id),
    type: r.type || '',
    moduleId: r.moduleId || '',
    reportDate: r.reportDate || '',
    snippet: aroundKeyword(String(r.content || ''), queryStr, 200),
  }));
}

/** 取命中词附近片段（避免预览永远只是开头） */
function aroundKeyword(text: string, kw: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const i = flat.indexOf(kw);
  if (i < 0) return flat.slice(0, width);
  const start = Math.max(0, i - Math.floor(width / 3));
  const s = flat.slice(start, start + width);
  return (start > 0 ? '…' : '') + s + (start + width < flat.length ? '…' : '');
}

/** 单个外部会话详情（get_session 工具） */
export function getSessionDetail(sessionId: string, messages = 0):
  | { ok: true; session: any; messages: any[] }
  | { ok: false; error: string } {
  const rdb = getRadarDb();
  if (!rdb) return { ok: false, error: '雷达库不存在（尚未采集过外部 AI 会话）' };
  const s = rdb.getSessionById(String(sessionId || ''));
  if (!s) return { ok: false, error: '会话不存在：' + sessionId };
  const n = Math.min(Math.max(Number(messages) || 0, 0), 200);
  const msgs = n > 0
    ? rdb.getMessages(s.tool, s.sessionId, 2000).slice(-n).map((m: any) => ({
        seq: m.seq,
        role: m.role,
        content: String(m.content || '').slice(0, 8000),
        thinking: String(m.thinking || '').slice(0, 2000),
        tools: m.toolsJson ? (() => { try { return JSON.parse(m.toolsJson); } catch { return m.toolsJson; } })() : undefined,
        ts: m.ts,
      }))
    : [];
  return {
    ok: true,
    session: {
      tool: s.tool,
      sessionId: s.sessionId,
      title: s.title,
      projectDir: s.projectDir,
      state: s.state,
      messageCount: s.messageCount,
      valueScore: s.valueScore || 0,
      startedAt: s.sourceCreatedAt,
      updatedAt: s.sourceUpdatedAt,
      summary: s.summary || '',
    },
    messages: msgs,
  };
}

/** 最近活跃（recent_activity 工具）：外部会话 + 最近报告 */
export function recentActivity(days = 7, limit = 20): { sessions: any[]; reports: any[] } {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const d = Math.min(Math.max(Number(days) || 7, 1), 365);
  const end = Date.now();
  const start = end - d * 86400_000;
  const sessions: any[] = [];
  const rdb = getRadarDb();
  if (rdb) {
    try {
      for (const s of rdb.sessionsByRange(start, end, lim).rows) {
        sessions.push({
          tool: s.tool,
          sessionId: s.sessionId,
          title: s.title,
          projectDir: s.projectDir,
          messageCount: s.messageCount,
          state: s.state,
          updatedAt: s.sourceUpdatedAt,
          summary: String(s.summary || '').slice(0, 500),
        });
      }
    } catch (e: any) {
      logger.warn('[KbIndex] 最近会话查询失败: %s', e?.message || e);
    }
  }
  const reports = db.q(`
    SELECT id, type, module_id AS moduleId, report_date AS reportDate, substr(content, 1, 200) AS preview
      FROM ai_analysis
     WHERE updated_at >= ?
     ORDER BY updated_at DESC LIMIT ?`, sinceLocal(d), lim) as any[];
  return { sessions, reports };
}
