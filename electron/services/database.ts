/**
 * 数据库服务（database.ts）
 *
 * 双存储架构：
 *  - 本地 SQLite（better-sqlite3）：知识库索引 kb_documents / kb_chunks（体积大、含向量，不上云）
 *  - 云端 MySQL（mysql2 + worker 同步桥）：会话、项目、待办、提醒、数据中心、AI 分析、工具历史
 *
 * 为了保持既有同步调用风格（better-sqlite3 同步 API），云端查询通过
 * worker 线程 + SharedArrayBuffer + Atomics.wait 实现"同步桥"，所有既有调用点无需改动。
 * 云端连接配置见 config.json：dbHost / dbPort / dbUser / dbPassword / dbName / dbSsl。
 */
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { Worker } from 'worker_threads';
import logger from './logger';
import { getCloudDbConfig, CloudDbConfig, isCloudEnabled, hasCloudCredentials } from './cloud-db';

const DB_DIR = path.join(require('os').homedir(), '.qihang-ai-desktop');
const DB_PATH = path.join(DB_DIR, 'qihang-ai-desktop.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  initSchema();
  return db;
}

/**
 * 本地 SQLite 表结构（与云端 MySQL 表结构一致）。
 * 未配置云 MySQL 时作为默认存储使用；配置云 MySQL 后业务表只使用云端，
 * 本地仅读写 kb_* 知识库表。
 */
function initSchema() {
  getDb().exec(`

    CREATE TABLE IF NOT EXISTS prj_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      source TEXT DEFAULT 'ui',
      title TEXT,
      chat_id TEXT,
      chat_type TEXT,
      mode TEXT DEFAULT 'general',
      project_id INTEGER,
      active_agent TEXT DEFAULT 'pi',
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS prj_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      source TEXT DEFAULT 'ui',
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      mode TEXT DEFAULT 'general',
      images TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS prj_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'note',
      dir TEXT,
      description TEXT DEFAULT '',
      default_branch TEXT DEFAULT '',
      labels TEXT,
      sort_order INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      auto_report INTEGER DEFAULT 0,
      feishu_push INTEGER DEFAULT 0,
      dir_settings TEXT,
      ignore_dirs TEXT,
      ignore_files TEXT,
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS kb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      indexed_at TEXT,
      file_mtime INTEGER,
      title TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL REFERENCES kb_documents(id),
      content TEXT NOT NULL,
      embedding TEXT
    );

    CREATE TABLE IF NOT EXISTS data_center_datasets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_id TEXT,
      name TEXT,
      description TEXT,
      type TEXT,
      status TEXT,
      schema_json TEXT,
      import_configs_json TEXT,
      module_id TEXT,
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS data_center_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT,
      dataset_id TEXT,
      data_json TEXT,
      source TEXT,
      content_hash TEXT,
      record_num TEXT,
      record_type TEXT,
      record_status TEXT,
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS data_center_modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_id TEXT,
      name TEXT,
      description TEXT,
      icon TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS ai_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES prj_projects(id),
      module_id TEXT,
      type TEXT,
      content TEXT,
      prompt TEXT,
      dir_path TEXT,
      report_date TEXT,
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS plan_reminders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      message TEXT DEFAULT '',
      type TEXT NOT NULL,
      time TEXT DEFAULT '09:00',
      date TEXT DEFAULT '',
      day_of_week INTEGER DEFAULT 0,
      day_of_month INTEGER DEFAULT 1,
      month_day TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      last_triggered TEXT DEFAULT '',
      project_id INTEGER DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      prompt TEXT DEFAULT '',
      description TEXT DEFAULT '',
      priority TEXT DEFAULT 'mid',
      status TEXT DEFAULT 'pending',
      task_type TEXT DEFAULT '',
      project_id INTEGER DEFAULT NULL,
      trigger_type TEXT DEFAULT '',
      scheduled_start TEXT DEFAULT '',
      cycle_type TEXT DEFAULT '',
      cycle_value TEXT DEFAULT '',
      cycle_time TEXT DEFAULT '',
      cycle_end TEXT DEFAULT '',
      last_cycle_run TEXT DEFAULT '',
      output_type TEXT DEFAULT '',
      output_target TEXT DEFAULT '',
      notify_feishu INTEGER DEFAULT 0,
      session_id TEXT DEFAULT '',
      source TEXT DEFAULT '',
      dataset_id TEXT DEFAULT '',
      record_id TEXT DEFAULT '',
      last_result TEXT DEFAULT '',
      last_run_at TEXT DEFAULT '',
      last_status TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS task_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      task_title TEXT DEFAULT '',
      status TEXT DEFAULT 'QUEUED',
      trigger_type TEXT DEFAULT '',
      start_time TEXT DEFAULT '',
      end_time TEXT DEFAULT '',
      log_text TEXT DEFAULT '',
      result_text TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS ai_tools_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool TEXT NOT NULL,
      name TEXT DEFAULT '',
      params TEXT DEFAULT '',
      result TEXT DEFAULT '',
      result_type TEXT DEFAULT 'text',
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

  `);
  try { getDb().exec("ALTER TABLE ai_analysis ADD COLUMN module_id TEXT"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN task_type TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN output_type TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN dataset_id TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN record_id TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN project_id INTEGER DEFAULT NULL"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN scheduled_start TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN cycle_type TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN cycle_value TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN cycle_time TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN cycle_end TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN last_cycle_run TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN output_target TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN notify_feishu INTEGER DEFAULT 0"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN last_result TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN last_run_at TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN last_status TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN session_id TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_tasks ADD COLUMN source TEXT DEFAULT ''"); } catch (e) {}
  // prj_sessions 旧版迁移：id TEXT → id INTEGER AUTOINCREMENT + session_id TEXT
  try {
    const cols = getDb().prepare("PRAGMA table_info(prj_sessions)").all() as any[];
    if (!cols.some((c: any) => c.name === 'session_id')) {
      getDb().exec("ALTER TABLE prj_sessions ADD COLUMN session_id TEXT");
      getDb().exec("UPDATE prj_sessions SET session_id = id");
      getDb().exec(`
        CREATE TABLE prj_sessions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          source TEXT DEFAULT 'ui',
          title TEXT,
          chat_id TEXT,
          chat_type TEXT,
          mode TEXT DEFAULT 'general',
          project_id INTEGER,
          active_agent TEXT DEFAULT 'pi',
          created_at TEXT DEFAULT (datetime('now', '+8 hours')),
          updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
        );
        INSERT INTO prj_sessions_new (session_id, source, title, chat_id, chat_type, mode, project_id, active_agent, created_at, updated_at)
        SELECT session_id, source, title, chat_id, chat_type, mode, project_id, active_agent, created_at, updated_at FROM prj_sessions;
        DROP TABLE prj_sessions;
        ALTER TABLE prj_sessions_new RENAME TO prj_sessions;
      `);
    }
  } catch (e) {}
}

// ==================== 云端 MySQL 同步桥 ====================

const CLOUD_TIMEOUT_MS = 20000;
const SAB_SIZE = 64 * 1024 * 1024; // 64MB 结果缓冲
const HEADER_BYTES = 8;            // flag Int32Array(0..2) 占用 8 字节

let _worker: Worker | null = null;
let _workerState: 'starting' | 'ready' | 'failed' = 'starting';
let _workerError = '';
let _sab: SharedArrayBuffer | null = null;
let _flag: Int32Array | null = null;
let _reqSeq = 0;

/** 当前存储模式：配置了云 MySQL 时为 cloud，否则本地 SQLite 兜底 */
export function getDbMode(): 'cloud' | 'local' {
  return getCloudDbConfig() ? 'cloud' : 'local';
}

/**
 * 判断 SQL 归属：
 *  - kb_* 知识库表：永远走本地 SQLite
 *  - 其余业务表：配置了云 MySQL 时走云端；未配置时回退本地 SQLite
 */
function routeTarget(sql: string): 'local' | 'cloud' {
  if (/\bkb_documents\b|\bkb_chunks\b/i.test(sql)) return 'local';
  return getDbMode() === 'cloud' ? 'cloud' : 'local';
}

function resolveWorkerPath(): string {
  let p = path.join(__dirname, '..', 'worker', 'db-worker.js');
  const unpacked = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  if (p !== unpacked && fs.existsSync(unpacked)) p = unpacked;
  return p;
}

function ensureWorker(): Worker {
  if (_worker) return _worker;
  const cfg = getCloudDbConfig();
  if (!cfg) {
    throw new Error('未配置云端数据库：请在设置页填写 MySQL 主机/账号/密码/库名（config.json 的 dbHost/dbUser/dbPassword/dbName）');
  }
  _sab = new SharedArrayBuffer(SAB_SIZE);
  _flag = new Int32Array(_sab, 0, 2);
  _workerState = 'starting';
  _workerError = '';
  _worker = new Worker(resolveWorkerPath(), { workerData: { config: cfg } });
  _worker.on('message', (msg: any) => {
    if (msg && msg.type === 'ready') _workerState = 'ready';
    else if (msg && msg.type === 'error') { _workerState = 'failed'; _workerError = msg.message || '未知错误'; }
  });
  _worker.on('error', (e: any) => { _workerState = 'failed'; _workerError = (e && e.message) || String(e); });
  _worker.on('exit', () => { _worker = null; });
  return _worker;
}

/** 当前中国时区时间字符串 YYYY-MM-DD HH:MM:SS */
function nowChinaString(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 将 SQLite 方言转换为 MySQL 可执行 SQL（所有云端语句统一经过此转换） */
function rewriteCloudSql(sql: string): string {
  const now = nowChinaString();
  const today = now.slice(0, 10);
  let s = sql.replace(/datetime\('now',\s*'\+8 hours',\s*'start of day'\)/gi, `'${today} 00:00:00'`);
  s = s.replace(/datetime\('now',\s*'\+8 hours'\)/gi, `'${now}'`);
  s = s.replace(/date\('now',\s*'\+8 hours'\)/gi, `'${today}'`);
  s = s.replace(/date\('now'\)/gi, `'${today}'`);
  s = s.replace(/\bINSERT OR REPLACE INTO\b/gi, 'REPLACE INTO');
  s = s.replace(/\bINSERT OR IGNORE INTO\b/gi, 'INSERT IGNORE INTO');
  return s;
}

/** 同步桥：阻塞等待云端查询结果（单飞模式；worker 初始化期间查询会被暂存，等待覆盖初始化耗时） */
function cloudSync(sql: string, params: any[]): any[] {
  const w = ensureWorker();
  if (_workerState === 'failed') {
    throw new Error('云端数据库连接异常：' + _workerError);
  }
  const id = ++_reqSeq;
  const safeParams = params.map(p => (p === undefined ? null : p));
  w.postMessage({ type: 'query', id, sql: rewriteCloudSql(sql), params: safeParams, sab: _sab });
  while (true) {
    const r = Atomics.wait(_flag!, 0, 0, CLOUD_TIMEOUT_MS);
    if (r !== 'ok') {
      // 超时：不复位 flag（防止 worker 迟到写入被下一轮误读），直接抛错
      throw new Error('云端数据库请求超时（' + CLOUD_TIMEOUT_MS / 1000 + ' 秒）');
    }
    const state = Atomics.load(_flag!, 0);
    const len = Atomics.load(_flag!, 1);
    Atomics.store(_flag!, 0, 0);
    Atomics.store(_flag!, 1, 0);
    const json = new TextDecoder().decode(new Uint8Array(_sab!, HEADER_BYTES, len));
    let res: any;
    try { res = JSON.parse(json); } catch { continue; }
    if (res.id !== id) continue; // 上一轮超时残留的过期结果，忽略并继续等待
    if (!res.ok) throw new Error(res.error || '云端数据库查询失败');
    return res.rows || [];
  }
}

/** 云端连接健康检查（应用启动 / 设置页测试用）。未配置云 MySQL 时返回 local 模式。 */
export async function checkCloud(): Promise<{ ok: boolean; mode: 'cloud' | 'local'; error?: string; latencyMs?: number }> {
  try {
    const cfg = getCloudDbConfig();
    if (!cfg) {
      return { ok: true, mode: 'local', error: '未配置云端数据库（当前使用本地 SQLite）' };
    }
    const w = ensureWorker();
    if (_workerState === 'ready') {
      const t0 = Date.now();
      cloudSync('SELECT 1', []);
      return { ok: true, mode: 'cloud', latencyMs: Date.now() - t0 };
    }
    if (_workerState === 'failed') {
      return { ok: false, mode: 'cloud', error: _workerError || '连接失败' };
    }
    return await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => finish({ ok: false, error: '连接超时（25 秒），请检查网络与云 MySQL 白名单' }), 25000);
      function finish(r: { ok: boolean; error?: string }) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        w.removeListener('message', onMsg);
        w.removeListener('error', onErr);
        resolve({ ...r, mode: 'cloud' as const });
      }
      const onMsg = (msg: any) => {
        if (msg && msg.type === 'ready') finish({ ok: true });
        else if (msg && msg.type === 'error') finish({ ok: false, error: msg.message || '连接失败' });
      };
      const onErr = (e: any) => finish({ ok: false, error: (e && e.message) || String(e) });
      w.on('message', onMsg);
      w.on('error', onErr);
    });
  } catch (e: any) {
    return { ok: false, mode: 'cloud', error: (e && e.message) || String(e) };
  }
}

/** 云端连接状态（设置页展示用） */
export function getCloudStatus(): { enabled: boolean; configured: boolean; state: string; error: string } {
  return { enabled: isCloudEnabled(), configured: hasCloudCredentials(), state: _workerState, error: _workerError };
}

/** 修改云端配置后调用：终止旧连接，下次查询自动按新配置重连 */
export function reloadCloud(): void {
  if (_worker) {
    try { _worker.terminate(); } catch {}
    _worker = null;
  }
  _workerState = 'starting';
  _workerError = '';
}

// ========== Helpers ==========

function q<T = any>(sql: string, ...params: any[]): T[] {
  try {
    if (routeTarget(sql) === 'local') {
      const stmt = getDb().prepare(sql);
      return (params.length ? stmt.all(...params) : stmt.all()) as T[];
    }
    return cloudSync(sql, params) as T[];
  } catch (e: any) {
    logger.error('[DB] SQL error: %s | SQL: %s', e.message, sql.slice(0, 200));
    throw e;
  }
}

function qOne<T = any>(sql: string, ...params: any[]): T | null {
  const rows = q<T>(sql, ...params);
  return rows.length ? rows[0] : null;
}

function run(sql: string, ...params: any[]) {
  if (routeTarget(sql) === 'local') {
    try { getDb().prepare(sql).run(...params); return; }
    catch (e: any) { logger.error('[DB] SQL error: %s | SQL: %s', e.message, sql.slice(0, 200)); throw e; }
  }
  q(sql, ...params);
}

function runRaw(sql: string, params: any[]) {
  run(sql, ...(params || []));
}

function save() {}

function close() {
  if (_worker) {
    try { _worker.terminate(); } catch {}
    _worker = null;
  }
  if (db) { try { db.close(); } catch {} db = null; }
}

// ========== Projects (unified: note + code) ==========
const project = {
  list: (type?) => {
    if (type) return q('SELECT * FROM prj_projects WHERE type = ? ORDER BY sort_order ASC, created_at DESC', type);
    return q("SELECT * FROM prj_projects ORDER BY CASE WHEN type = 'note' THEN 0 ELSE 1 END, sort_order ASC, created_at DESC");
  },
  get: (id) => qOne('SELECT * FROM prj_projects WHERE id = ?', id),
  getDefault: () => qOne('SELECT * FROM prj_projects WHERE is_default = 1'),
  setDefault: (id) => {
    run('UPDATE prj_projects SET is_default = 0 WHERE is_default = 1');
    if (id) run('UPDATE prj_projects SET is_default = 1 WHERE id = ?', id);
  },
  add: (name, type, dir, description, defaultBranch) => {
    const t = type || 'code';
    run('INSERT INTO prj_projects (name, type, dir, description, default_branch) VALUES (?, ?, ?, ?, ?)',
      name, t, dir || '', description || '', defaultBranch || '');
    const r = qOne('SELECT id FROM prj_projects WHERE name = ? AND type = ?', name, t);
    return { id: r!.id, name, type: t };
  },
  update: (id, data) => {
    const fields: any[] = []; const params: any[] = [];
    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name); }
    if (data.type !== undefined) { fields.push('type = ?'); params.push(data.type); }
    if (data.dir !== undefined) { fields.push('dir = ?'); params.push(data.dir); }
    if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description); }
    if (data.default_branch !== undefined) { fields.push('default_branch = ?'); params.push(data.default_branch); }
    if (data.is_default !== undefined) { fields.push('is_default = ?'); params.push(data.is_default ? 1 : 0); }
    if (data.sort_order !== undefined) { fields.push('sort_order = ?'); params.push(data.sort_order); }
    if (data.auto_report !== undefined) { fields.push('auto_report = ?'); params.push(data.auto_report ? 1 : 0); }
    if (data.labels !== undefined) { fields.push('labels = ?'); params.push(data.labels); }
    if (data.dir_settings !== undefined) { fields.push('dir_settings = ?'); params.push(data.dir_settings); }
    if (data.ignore_dirs !== undefined) { fields.push('ignore_dirs = ?'); params.push(data.ignore_dirs); }
    if (data.ignore_files !== undefined) { fields.push('ignore_files = ?'); params.push(data.ignore_files); }
    if (fields.length) {
      fields.push("updated_at = datetime('now', '+8 hours')");
      params.push(id);
      run(`UPDATE prj_projects SET ${fields.join(', ')} WHERE id = ?`, ...params);
    }
  },
  remove: (id) => {
    run('DELETE FROM ai_analysis WHERE project_id = ?', id);
    let sessions: any[] = [];
    try { sessions = q('SELECT session_id FROM prj_sessions WHERE project_id = ?', id); } catch {}
    for (const s of sessions) {
      run('DELETE FROM prj_messages WHERE session_id = ?', s.session_id);
    }
    run('DELETE FROM prj_sessions WHERE project_id = ?', id);
    run('DELETE FROM prj_projects WHERE id = ?', id);
  },
  docCount: () => {
    try { const r = qOne<{c: number}>("SELECT COUNT(*) as c FROM kb_documents"); return r ? r.c : 0; } catch { return 0; }
  },
  insertDoc: (pathVal, content, fileMtime, title) => {
    run("INSERT OR REPLACE INTO kb_documents (path, content, indexed_at, file_mtime, title) VALUES (?, ?, datetime('now', '+8 hours'), ?, ?)", pathVal, content, fileMtime || null, title || '');
    const r = qOne<{id: number}>('SELECT id FROM kb_documents WHERE path = ?', pathVal);
    return r!.id;
  },
  insertChunk: (docId, content, embedding) => {
    if (embedding) {
      run('INSERT INTO kb_chunks (doc_id, content, embedding) VALUES (?, ?, ?)', docId, content, JSON.stringify(embedding));
    } else {
      run('INSERT INTO kb_chunks (doc_id, content) VALUES (?, ?)', docId, content);
    }
  },
  getChunks: () => q<{content: string}>('SELECT c.content FROM kb_chunks c JOIN kb_documents d ON c.doc_id = d.id').map(r => r.content),
  deleteDocs: () => {
    run('DELETE FROM kb_chunks');
    run('DELETE FROM kb_documents');
  },
};

// ========== Sessions & Messages (unified: chat + coding) ==========
const chat = {
  sessions: (projectId) => {
    try {
      const pid = (projectId !== null && projectId !== undefined && projectId !== '') ? Number(projectId) : NaN;
      if (Number.isFinite(pid)) return q("SELECT s.*, (SELECT content FROM prj_messages WHERE session_id = s.session_id ORDER BY id DESC LIMIT 1) as last_message FROM prj_sessions s WHERE s.project_id = ? ORDER BY s.updated_at DESC", Math.trunc(pid));
      return q("SELECT s.*, (SELECT content FROM prj_messages WHERE session_id = s.session_id ORDER BY id DESC LIMIT 1) as last_message FROM prj_sessions s ORDER BY s.updated_at DESC");
    } catch { return []; }
  },
  sessionsBySource: (source, projectId) => {
    try {
      const pid = (projectId !== null && projectId !== undefined && projectId !== '') ? Number(projectId) : NaN;
      if (Number.isFinite(pid)) return q(`SELECT s.*, (SELECT COUNT(*) FROM prj_messages WHERE session_id = s.session_id) as msg_count, (SELECT content FROM prj_messages WHERE session_id = s.session_id ORDER BY id DESC LIMIT 1) as last_message FROM prj_sessions s WHERE s.source = ? AND s.project_id = ? ORDER BY updated_at DESC`, source, Math.trunc(pid));
      return q(`SELECT s.*, (SELECT COUNT(*) FROM prj_messages WHERE session_id = s.session_id) as msg_count, (SELECT content FROM prj_messages WHERE session_id = s.session_id ORDER BY id DESC LIMIT 1) as last_message FROM prj_sessions s WHERE s.source = ? ORDER BY updated_at DESC`, source);
    } catch { return []; }
  },
  createSession: (id, projectId, title, mode, agent, source) => {
    // project_id 可能传入 'notesdir' 等字符串哨兵值（飞书场景），INT 列只存合法数字
    const n = (projectId === null || projectId === undefined) ? NaN : Number(projectId);
    const pid = Number.isFinite(n) ? Math.trunc(n) : null;
    const existing = qOne('SELECT * FROM prj_sessions WHERE session_id = ?', id);
    if (existing) return existing;
    run("INSERT INTO prj_sessions (session_id, source, title, mode, project_id, active_agent) VALUES (?, ?, ?, ?, ?, ?)",
      id, source || 'ui', title || '新对话', mode || 'general', pid, agent || 'pi');
    return qOne('SELECT * FROM prj_sessions WHERE session_id = ?', id);
  },
  getSession: (id) => qOne('SELECT * FROM prj_sessions WHERE session_id = ?', id),
  deleteSession: (sessionId) => {
    run('DELETE FROM prj_messages WHERE session_id = ?', sessionId);
    run('DELETE FROM prj_sessions WHERE session_id = ?', sessionId);
  },
  updateSessionTitle: (id, title) => {
    run("UPDATE prj_sessions SET title = ?, updated_at = datetime('now', '+8 hours') WHERE session_id = ?", title, id);
  },
  updateSessionAgent: (id, agent) => {
    run("UPDATE prj_sessions SET active_agent = ?, updated_at = datetime('now', '+8 hours') WHERE session_id = ?", agent, id);
  },
  messages: (sessionId) => {
    const rows = q("SELECT * FROM prj_messages WHERE session_id = ? ORDER BY id", sessionId);
    return rows.map(r => ({ ...r, images: r.images ? JSON.parse(r.images) : null }));
  },
  addMessage: (sessionId, role, content, mode?, images?) => {
    const imagesJson = images?.length ? JSON.stringify(images) : null;
    run("INSERT INTO prj_messages (session_id, role, content, mode, images) VALUES (?, ?, ?, ?, ?)", sessionId, role, content, mode || 'general', imagesJson);
    run("UPDATE prj_sessions SET updated_at = datetime('now', '+8 hours') WHERE session_id = ?", sessionId);
  },
};

// ========== Modules ==========

/** id 可能是自增数字 id，也可能是 module_id UUID 字符串；按类型生成 WHERE 子句 */
function dmWhere(id: any): { where: string; params: any[] } {
  const s = String(id == null ? '' : id).trim();
  const isNumeric = /^\d+$/.test(s);
  return isNumeric
    ? { where: 'id = ? OR module_id = ?', params: [s, s] }
    : { where: 'module_id = ?', params: [s] };
}

const dm = {
  list: () => q('SELECT * FROM data_center_modules ORDER BY sort_order ASC, created_at DESC'),
  get: (id) => {
    const w = dmWhere(id);
    return qOne(`SELECT * FROM data_center_modules WHERE ${w.where}`, ...w.params);
  },
  add: (name, description, icon) => {
    const id = 'm_' + Date.now();
    run('INSERT INTO data_center_modules (module_id, name, description, icon) VALUES (?, ?, ?, ?, ?)', id, name, description || '', icon || '📁');
    return { id };
  },
  update: (id, data) => {
    const fields: any[] = []; const params: any[] = [];
    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name); }
    if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description); }
    if (data.icon !== undefined) { fields.push('icon = ?'); params.push(data.icon); }
    if (data.sort_order !== undefined) { fields.push('sort_order = ?'); params.push(data.sort_order); }
    if (fields.length) {
      const w = dmWhere(id);
      fields.push("updated_at = datetime('now', '+8 hours')");
      params.push(...w.params);
      run(`UPDATE data_center_modules SET ${fields.join(', ')} WHERE ${w.where}`, ...params);
    }
  },
  remove: (id) => {
    const mod = dm.get(id);
    const moduleId = mod && mod.module_id ? String(mod.module_id) : String(id);
    const dsList = q<{id: number}>('SELECT id FROM data_center_datasets WHERE module_id = ?', moduleId);
    for (const d of dsList) { run('DELETE FROM data_center_records WHERE dataset_id = ?', d.id); }
    run('DELETE FROM data_center_datasets WHERE module_id = ?', moduleId);
    const w = dmWhere(id);
    run(`DELETE FROM data_center_modules WHERE ${w.where}`, ...w.params);
  },
};

// ========== Datasets ==========

/** id 可能是自增数字 id，也可能是 dataset_id UUID 字符串；按类型生成 WHERE 子句 */
function dsWhere(id: any): { where: string; params: any[] } {
  const s = String(id == null ? '' : id).trim();
  const isNumeric = /^\d+$/.test(s);
  return isNumeric
    ? { where: 'id = ? OR dataset_id = ?', params: [s, s] }
    : { where: 'dataset_id = ?', params: [s] };
}

const ds = {
  list: () => {
    const rows = q('SELECT d.*, (SELECT COUNT(*) FROM data_center_records WHERE dataset_id = d.id) as record_count FROM data_center_datasets d ORDER BY d.created_at DESC');
    return rows.map(r => ({ ...r, recordCount: r.record_count, schema: r.schema_json ? JSON.parse(r.schema_json) : null }));
  },
  get: (id) => {
    const w = dsWhere(id);
    const r = qOne(`SELECT d.*, (SELECT COUNT(*) FROM data_center_records WHERE dataset_id = d.id) as record_count FROM data_center_datasets d WHERE ${w.where}`, ...w.params);
    return r ? { ...r, recordCount: r.record_count, schema: r.schema_json ? JSON.parse(r.schema_json) : null } : null;
  },
  add: (params) => {
    const id = params.dataset_id || 'ds_' + Date.now();
    run('INSERT INTO data_center_datasets (dataset_id, name, description, type, status, schema_json, module_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, params.name, params.description || '', params.type || '', params.status || '', params.schemaJson || '{}', params.module_id || '');
    return { id };
  },
  updateMeta: (id, data) => {
    const fields: any[] = []; const params: any[] = [];
    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name); }
    if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description); }
    if (data.type !== undefined) { fields.push('type = ?'); params.push(data.type); }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status); }
    if (data.schema_json !== undefined) { fields.push('schema_json = ?'); params.push(data.schema_json); }
    if (data.module_id !== undefined) { fields.push('module_id = ?'); params.push(data.module_id); }
    if (fields.length) {
      const w = dsWhere(id);
      fields.push("updated_at = datetime('now', '+8 hours')");
      params.push(...w.params);
      run(`UPDATE data_center_datasets SET ${fields.join(', ')} WHERE ${w.where}`, ...params);
    }
  },
  remove: (id) => {
    const w = dsWhere(id);
    const dsRow = qOne<{id: number}>(`SELECT id FROM data_center_datasets WHERE ${w.where}`, ...w.params);
    if (dsRow) { run('DELETE FROM data_center_records WHERE dataset_id = ?', dsRow.id); }
    run(`DELETE FROM data_center_datasets WHERE ${w.where}`, ...w.params);
  },
  query: (datasetId, conditions) => {
    let sql = "SELECT * FROM data_center_records WHERE dataset_id = ?";
    const params = [datasetId];
    if (conditions) { sql += ' AND data_json LIKE ?'; params.push(`%${conditions}%`); }
    sql += ' ORDER BY created_at DESC LIMIT 50';
    return q(sql, ...params).map(r => ({ id: r.id, ...JSON.parse(r.data_json || '{}'), _created_at: r.created_at }));
  },
  insert: (datasetId, dataObj) => run("INSERT INTO data_center_records (dataset_id, data_json) VALUES (?, ?)", datasetId, JSON.stringify(dataObj)),
  updateRecord: (id, dataObj) => run('UPDATE data_center_records SET data_json = ? WHERE id = ?', JSON.stringify(dataObj), id),
  deleteRecord: (id) => run('DELETE FROM data_center_records WHERE id = ?', id),
};

// ========== AI Analysis ==========
const aa = {
  listByModule: (moduleId) => q("SELECT * FROM ai_analysis WHERE module_id = ? AND type = 'module_analysis' ORDER BY created_at DESC LIMIT 5", moduleId),
  latestByModule: (moduleId) => qOne("SELECT * FROM ai_analysis WHERE module_id = ? AND type = 'module_analysis' ORDER BY created_at DESC LIMIT 1", moduleId),
  save: (moduleId, type, content, prompt, reportDate) => {
    run("INSERT INTO ai_analysis (module_id, type, content, prompt, report_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))",
      moduleId, type, content, prompt || '', reportDate || '');
    const r = qOne<{id: number}>("SELECT id FROM ai_analysis WHERE module_id = ? AND type = ? ORDER BY id DESC LIMIT 1", moduleId, type);
    return r ? r.id : null;
  },
  get: (id) => qOne('SELECT * FROM ai_analysis WHERE id = ?', id),
  remove: (id) => run('DELETE FROM ai_analysis WHERE id = ?', id),
};

// ========== Reminders ==========
const reminder = {
  list: () => q('SELECT * FROM plan_reminders ORDER BY created_at DESC'),
  get: (id) => qOne('SELECT * FROM plan_reminders WHERE id = ?', id),
  add: (data) => {
    const id = data.id || 'R' + Date.now();
    run('INSERT OR IGNORE INTO plan_reminders (id, name, message, type, time, date, day_of_week, day_of_month, month_day, enabled, created_at, last_triggered, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, data.name, data.message || '', data.type, data.time || '09:00', data.date || '',
      data.day_of_week || 0, data.day_of_month || 1, data.month_day || '',
      data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
      data.created_at || new Date().toISOString().slice(0, 19).replace('T', ' '),
      data.last_triggered || '', data.project_id || null);
    return { id };
  },
  update: (id, data) => {
    const fields: any[] = []; const params: any[] = [];
    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name); }
    if (data.message !== undefined) { fields.push('message = ?'); params.push(data.message); }
    if (data.type !== undefined) { fields.push('type = ?'); params.push(data.type); }
    if (data.time !== undefined) { fields.push('time = ?'); params.push(data.time); }
    if (data.enabled !== undefined) { fields.push('enabled = ?'); params.push(data.enabled ? 1 : 0); }
    if (fields.length) { params.push(id); run(`UPDATE plan_reminders SET ${fields.join(', ')} WHERE id = ?`, ...params); }
  },
  remove: (id) => run('DELETE FROM plan_reminders WHERE id = ?', id),
  setEnabled: (id, enabled) => run('UPDATE plan_reminders SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id),
  getActive: () => q("SELECT * FROM plan_reminders WHERE enabled = 1"),
};

// ========== AI 任务（挂在项目下：代码项目 / 笔记库） ==========
const task = {
  list: (status?: string) => {
    if (status) return q('SELECT * FROM plan_tasks WHERE status = ? ORDER BY created_at DESC', status);
    return q('SELECT * FROM plan_tasks ORDER BY created_at DESC');
  },
  get: (id: number) => qOne('SELECT * FROM plan_tasks WHERE id = ?', id),
  add: (data: any) => {
    const pid = (data.project_id !== null && data.project_id !== undefined && data.project_id !== '') ? (Number.isFinite(Number(data.project_id)) ? Math.trunc(Number(data.project_id)) : null) : null;
    run('INSERT INTO plan_tasks (title, prompt, description, priority, status, task_type, project_id, trigger_type, scheduled_start, cycle_type, cycle_value, cycle_time, cycle_end, output_type, output_target, notify_feishu, session_id, source, dataset_id, record_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      data.title, data.prompt || '', data.description || '', data.priority || 'mid', data.status || 'pending',
      data.task_type || '', pid,
      data.trigger_type || '', data.scheduled_start || '', data.cycle_type || '', data.cycle_value || '',
      data.cycle_time || '', data.cycle_end || '', data.output_type || '', data.output_target || '',
      data.notify_feishu ? 1 : 0, data.session_id || '', data.source || '', data.dataset_id || '', data.record_id || '');
    const r = qOne<{id: number}>('SELECT id FROM plan_tasks ORDER BY id DESC LIMIT 1');
    return { id: r!.id };
  },
  update: (id: number, data: any) => {
    const fields: any[] = []; const params: any[] = [];
    if (data.title !== undefined) { fields.push('title = ?'); params.push(data.title); }
    if (data.prompt !== undefined) { fields.push('prompt = ?'); params.push(data.prompt); }
    if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description); }
    if (data.priority !== undefined) { fields.push('priority = ?'); params.push(data.priority); }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status); }
    if (data.task_type !== undefined) { fields.push('task_type = ?'); params.push(data.task_type); }
    if (data.project_id !== undefined) {
        const v = (data.project_id === null || data.project_id === undefined || data.project_id === '') ? null : (Number.isFinite(Number(data.project_id)) ? Math.trunc(Number(data.project_id)) : null);
        fields.push('project_id = ?'); params.push(v);
      }
    if (data.trigger_type !== undefined) { fields.push('trigger_type = ?'); params.push(data.trigger_type); }
    if (data.scheduled_start !== undefined) { fields.push('scheduled_start = ?'); params.push(data.scheduled_start); }
    if (data.cycle_type !== undefined) { fields.push('cycle_type = ?'); params.push(data.cycle_type); }
    if (data.cycle_value !== undefined) { fields.push('cycle_value = ?'); params.push(data.cycle_value); }
    if (data.cycle_time !== undefined) { fields.push('cycle_time = ?'); params.push(data.cycle_time); }
    if (data.cycle_end !== undefined) { fields.push('cycle_end = ?'); params.push(data.cycle_end); }
    if (data.output_type !== undefined) { fields.push('output_type = ?'); params.push(data.output_type); }
    if (data.output_target !== undefined) { fields.push('output_target = ?'); params.push(data.output_target); }
    if (data.notify_feishu !== undefined) { fields.push('notify_feishu = ?'); params.push(data.notify_feishu ? 1 : 0); }
    if (data.session_id !== undefined) { fields.push('session_id = ?'); params.push(data.session_id); }
    if (data.source !== undefined) { fields.push('source = ?'); params.push(data.source); }
    if (data.dataset_id !== undefined) { fields.push('dataset_id = ?'); params.push(data.dataset_id); }
    if (data.record_id !== undefined) { fields.push('record_id = ?'); params.push(data.record_id); }
    if (data.last_result !== undefined) { fields.push('last_result = ?'); params.push(data.last_result); }
    if (data.last_run_at !== undefined) { fields.push('last_run_at = ?'); params.push(data.last_run_at); }
    if (data.last_status !== undefined) { fields.push('last_status = ?'); params.push(data.last_status); }
    if (data.last_cycle_run !== undefined) { fields.push('last_cycle_run = ?'); params.push(data.last_cycle_run); }
    if (fields.length) { fields.push("updated_at = datetime('now', '+8 hours')"); params.push(id); run(`UPDATE plan_tasks SET ${fields.join(', ')} WHERE id = ?`, ...params); }
  },
  remove: (id: number) => {
    const t = qOne<{session_id: string}>('SELECT session_id FROM plan_tasks WHERE id = ?', id);
    if (t && t.session_id) {
      run('DELETE FROM prj_messages WHERE session_id = ?', t.session_id);
      run('DELETE FROM prj_sessions WHERE session_id = ?', t.session_id);
    }
    run('DELETE FROM task_executions WHERE task_id = ?', id);
    run('DELETE FROM plan_tasks WHERE id = ?', id);
  },
  // 可调度的任务（定时 + 循环），用于恢复调度
  schedulable: () => q("SELECT * FROM plan_tasks WHERE status IN ('pending', 'in_progress')"),
  listByProject: (projectId: number) => q('SELECT * FROM plan_tasks WHERE project_id = ? ORDER BY created_at DESC', projectId),
};

const taskExecution = {
  add: (data: any) => {
    run('INSERT INTO task_executions (task_id, task_title, status, trigger_type, start_time, end_time, log_text, result_text, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      data.task_id || null, data.task_title || '', data.status || 'QUEUED', data.trigger_type || '',
      data.start_time || '', data.end_time || '', data.log_text || '', data.result_text || '', data.error_message || '');
    const r = qOne<{id: number}>('SELECT id FROM task_executions ORDER BY id DESC LIMIT 1');
    return r ? r.id : null;
  },
  update: (id: number, data: any) => {
    const fields: any[] = []; const params: any[] = [];
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status); }
    if (data.start_time !== undefined) { fields.push('start_time = ?'); params.push(data.start_time); }
    if (data.end_time !== undefined) { fields.push('end_time = ?'); params.push(data.end_time); }
    if (data.log_text !== undefined) { fields.push('log_text = ?'); params.push(data.log_text); }
    if (data.result_text !== undefined) { fields.push('result_text = ?'); params.push(data.result_text); }
    if (data.error_message !== undefined) { fields.push('error_message = ?'); params.push(data.error_message); }
    if (fields.length) { params.push(id); run(`UPDATE task_executions SET ${fields.join(', ')} WHERE id = ?`, ...params); }
  },
  list: (page = 1, pageSize = 20) => {
    const offset = Math.max(0, (page - 1) * pageSize);
    const total = (qOne<{c: number}>('SELECT COUNT(*) as c FROM task_executions') || {}).c || 0;
    const rows = q('SELECT * FROM task_executions ORDER BY id DESC LIMIT ? OFFSET ?', pageSize, offset);
    return { total, rows };
  },
  listByTask: (taskId: number, limit = 20) => q('SELECT * FROM task_executions WHERE task_id = ? ORDER BY id DESC LIMIT ?', taskId, limit),
  get: (id: number) => qOne('SELECT * FROM task_executions WHERE id = ?', id),
};

// ========== AI 工具箱历史 ==========
const aitoolHistory = {
  add: (tool, name, params, result, resultType = 'text') => {
    run("INSERT INTO ai_tools_history (tool, name, params, result, result_type, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'))",
      tool, name || '', params || '', result || '', resultType);
    const r = qOne<{id: number}>('SELECT id FROM ai_tools_history ORDER BY id DESC LIMIT 1');
    return r ? r.id : null;
  },
  list: (tool?: string, limit = 100) => {
    const sql = tool ? 'SELECT id, tool, name, result_type, created_at FROM ai_tools_history WHERE tool = ? ORDER BY id DESC LIMIT ?'
      : 'SELECT id, tool, name, result_type, created_at FROM ai_tools_history ORDER BY id DESC LIMIT ?';
    return tool ? q(sql, tool, limit) : q(sql, limit);
  },
  get: (id) => qOne('SELECT * FROM ai_tools_history WHERE id = ?', id),
  remove: (id) => run('DELETE FROM ai_tools_history WHERE id = ?', id),
  clear: (tool?: string) => {
    if (tool) run('DELETE FROM ai_tools_history WHERE tool = ?', tool);
    else run('DELETE FROM ai_tools_history');
  },
};

export { getDb, close, q, qOne, run, runRaw, save, project, chat, dm, ds, aa, reminder, task, taskExecution, aitoolHistory };
