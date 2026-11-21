/**
 * 数据库服务（database.ts）
 *
 * 本地 SQLite（better-sqlite3）单存储：会话、项目、待办、提醒、数据中心、
 * AI 分析、工具历史、知识库索引 kb_documents / kb_chunks 全部保存在
 * 用户主目录 .qihang-ai-desktop 下。
 */
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import logger from './logger';

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

/** 记录保存回调注册点（工单联动用，由 main.ts 在启动时注册） */
const dsRecordHooks: Array<(kind: 'insert' | 'update' | 'delete', datasetId: string, recordId: number | null, data: any, prev?: any) => void> = [];

/** 本地 SQLite 表结构 */
function initSchema() {
  // 表改名迁移：统一任务域表名前缀为 plan_（与 prj_ / kb_ / data_center_ 对齐）。
  // 源名兼容历史版本：老库是 plan_tasks/plan_reminders（目标名相同，自然跳过），
  // 中间版本可能是 tasks/reminders，task_executions 则一直没有前缀。
  // 幂等：仅当旧表存在且新表不存在时执行；必须在下面 CREATE TABLE 之前跑，
  // 否则新表先被空建出来，改名会因名字冲突失败。
  for (const [oldName, newName] of [
    ['tasks', 'plan_tasks'],
    ['reminders', 'plan_reminders'],
    ['task_executions', 'plan_executions'],
  ] as const) {
    try {
      const hasOld = db!.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(oldName);
      const hasNew = db!.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(newName);
      if (hasOld && !hasNew) {
        db!.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
        logger.info(`[DB] 表改名: ${oldName} → ${newName}`);
      }
    } catch (e) {}
  }
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
      thinking TEXT DEFAULT '',
      duration_ms INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS plan_todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority TEXT DEFAULT 'mid',
      status TEXT DEFAULT 'pending',
      scheduled_start TEXT DEFAULT '',
      project_id INTEGER DEFAULT NULL,
      source TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    -- 工单处理记录：新建/状态变化/流转的流水（工单数据集的记录级日志）
    CREATE TABLE IF NOT EXISTS ticket_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_id TEXT DEFAULT '',
      record_id INTEGER,
      action TEXT DEFAULT '',
      field TEXT DEFAULT '',
      from_value TEXT DEFAULT '',
      to_value TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_logs_record ON ticket_logs(dataset_id, record_id);

    -- 工单 ↔ 待办 关联（一单可拆多条待办；待办在 plan_todos）
    CREATE TABLE IF NOT EXISTS ticket_todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_id TEXT DEFAULT '',
      record_id INTEGER,
      todo_id INTEGER,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_todos_record ON ticket_todos(dataset_id, record_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_todos_todo ON ticket_todos(todo_id);

    CREATE TABLE IF NOT EXISTS plan_executions (
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

    -- 飞书会话 → 项目 绑定（粘性上下文：绑定后该群/私聊的消息自动落到该项目）
    CREATE TABLE IF NOT EXISTS feishu_contexts (
      chat_id TEXT PRIMARY KEY,
      chat_type TEXT DEFAULT '',
      project_id INTEGER,
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    -- 知识库 MCP（electron/kb/）：笔记全文索引。
    -- 上次的向量索引路线已作废（kb_documents / kb_chunks 见下方 DROP），
    -- 这次只要全文检索：FTS5 trigram 对中文免分词，radar_message_fts 已验证该口径。
    -- 维护刻意极简：启动差量同步 + fs.watch 增量 + 手动重建（kb-index.ts），单文件更新=删+插。
    CREATE TABLE IF NOT EXISTS kb_note_docs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      rel_path   TEXT,
      abs_path   TEXT UNIQUE,
      size       INTEGER DEFAULT 0,
      mtime_ms   INTEGER DEFAULT 0,
      title      TEXT,
      indexed_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );
    CREATE INDEX IF NOT EXISTS idx_kb_note_docs_project ON kb_note_docs(project_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_note_fts USING fts5(
      content, abs_path UNINDEXED, tokenize='trigram'
    );
    -- 索引状态标记（chat 回填标记等，后续阶段使用）
    CREATE TABLE IF NOT EXISTS kb_index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- 应用内对话全文索引：external content + 触发器自动同步（仿 radar_message_fts 模式）
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_message_fts USING fts5(
      content, content='prj_messages', content_rowid='rowid', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS prj_messages_ai AFTER INSERT ON prj_messages WHEN new.content <> '' BEGIN
      INSERT INTO chat_message_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS prj_messages_ad AFTER DELETE ON prj_messages BEGIN
      INSERT INTO chat_message_fts(chat_message_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS prj_messages_au AFTER UPDATE ON prj_messages BEGIN
      INSERT INTO chat_message_fts(chat_message_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
      INSERT INTO chat_message_fts(rowid, content)
      SELECT new.rowid, new.content WHERE new.content <> '';
    END;

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
  // 待办拆表迁移：历史上待办和定时任务同存 plan_tasks（待办 = trigger_type='manual' 的行）。
  // 现待办独立成 plan_todos。幂等：仅当 plan_todos 为空且 plan_tasks 里存在 manual 行时迁一次，
  // 避免每次启动重复插入。迁完不删 plan_tasks 里的旧行（留作回滚余地，且它们已不再被 listTodos 读取）。
  try { migrateTodosOut(); } catch (e) { logger.warn('[DB] 待办拆表迁移失败: ' + (e && e.message)); }
  // 工单联动：一次性提醒可关联到来源数据集与记录（record_id 为 TEXT，因为 record_id 本身是数字主键存字符串）
  try { getDb().exec("ALTER TABLE plan_reminders ADD COLUMN ticket_dataset_id TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_reminders ADD COLUMN source_record_id TEXT DEFAULT ''"); } catch (e) {}
  // 记录表 dataset_id 归一化：历史上把 JS 数字直接绑进 TEXT 列，存成了 '14.0'，
  // 与 '14' 的记录混在一起，按 '14' 精确匹配的查询查不到 → 工单建了却看不见。统一改回整数文本。
  try {
    const fixed = getDb().prepare("UPDATE data_center_records SET dataset_id = CAST(CAST(dataset_id AS REAL) AS INTEGER) WHERE dataset_id GLOB '[0-9]*.0'").run();
    if (fixed.changes) logger.info('[DB] 归一化记录 dataset_id：' + fixed.changes + ' 条');
  } catch (e) { logger.warn('[DB] dataset_id 归一化失败: ' + (e && e.message)); }
  // 记录表镜像列回填：source/record_type/record_status 建表时预留但从未写入，
  // 语义即 来源/类型/状态（用户明确要求这几列必须有值，状态处理依赖它们）。
  // 从 data_json 里的中文核心字段（兼容英文键）回填；字段本身缺失时存 NULL。
  // WHERE 只挑「列空 且 data_json 里有对应值」的行——列空但字段也缺的行不动，
  // 否则每次启动都会把 NULL 重写成 NULL，回填日志永远刷屏。
  try {
    const backfill = getDb().prepare(`
      UPDATE data_center_records SET
        record_type   = COALESCE(json_extract(data_json, '$."类型"'), json_extract(data_json, '$.type')),
        record_status = COALESCE(json_extract(data_json, '$."状态"'), json_extract(data_json, '$.status')),
        source        = COALESCE(json_extract(data_json, '$."来源"'), json_extract(data_json, '$.source'))
      WHERE ((record_type IS NULL OR record_type = '')
              AND (json_extract(data_json, '$."类型"') IS NOT NULL OR json_extract(data_json, '$.type') IS NOT NULL))
         OR ((record_status IS NULL OR record_status = '')
              AND (json_extract(data_json, '$."状态"') IS NOT NULL OR json_extract(data_json, '$.status') IS NOT NULL))
         OR ((source IS NULL OR source = '')
              AND (json_extract(data_json, '$."来源"') IS NOT NULL OR json_extract(data_json, '$.source') IS NOT NULL))
    `).run();
    if (backfill.changes) logger.info('[DB] 记录镜像列回填：' + backfill.changes + ' 条');
  } catch (e) { logger.warn('[DB] 记录镜像列回填失败: ' + (e && e.message)); }
  // 待办表补列：线上 plan_todos 是旧结构（缺 scheduled_start / project_id / source），
  // 而代码往这三列写 → 「新建待办」直接报 no such column。缺哪补哪，已有列不动。
  try {
    const tcols = getDb().prepare('PRAGMA table_info(plan_todos)').all() as any[];
    const tHas = (n: string) => tcols.some((c: any) => c.name === n);
    for (const [name, ddl] of [['scheduled_start', "TEXT DEFAULT ''"], ['project_id', 'INTEGER DEFAULT NULL'], ['source', "TEXT DEFAULT ''"]] as Array<[string, string]>) {
      if (tHas(name)) continue;
      getDb().exec(`ALTER TABLE plan_todos ADD COLUMN ${name} ${ddl}`);
      logger.info('[DB] plan_todos 补列：' + name);
    }
  } catch (e) { logger.warn('[DB] plan_todos 补列失败: ' + (e && e.message)); }
  // 移动端可逐会话指定模型；桌面 UI 仍用全局默认，空串即跟随全局
  try { getDb().exec("ALTER TABLE prj_sessions ADD COLUMN model_id TEXT DEFAULT ''"); } catch (e) {}
  // 飞书来源会话的锚点（chat_id）：供「继续」按群/私聊定位最近对话，也为回推飞书留映射
  try { getDb().exec("ALTER TABLE prj_sessions ADD COLUMN origin_chat_id TEXT DEFAULT ''"); } catch (e) {}
  // 索引路线已整体下线：向量索引表（kb_documents / kb_chunks）连同 rag.ts、indexer.ts 一并删除。
  // 项目库的检索与读写改由 pi agent 用原生 read/bash/write 直接做；概览看板改为实时扫盘统计。
  try { getDb().exec('DROP TABLE IF EXISTS kb_chunks'); } catch (e) {}
  try { getDb().exec('DROP TABLE IF EXISTS kb_documents'); } catch (e) {}
  // prj_messages 旧库补列：thinking 存思考过程、duration_ms 存该条回答耗时。
  // 必须在主键迁移之前补，那套迁移会整表重建 prj_messages 并按列名逐列 SELECT，缺列会直接失败
  ensureMessageExtraColumns();
  // prj_sessions 旧版迁移：id TEXT → id INTEGER AUTOINCREMENT + session_id TEXT
  migrateSessionKeyTable();
}

/**
 * 待办拆表迁移：把 plan_tasks 里 trigger_type='manual' 的待办行搬到 plan_todos。
 * 幂等——仅当 plan_todos 为空时执行（首次升级），迁过就跳过。
 * 字段映射：待办只带走它用得到的列（title/description/priority/status/scheduled_start/project_id/source/时间戳），
 * 定时任务专属列（cycle_*、output_*、session_id、last_* 等）对待办无意义，丢弃。
 */
function migrateTodosOut(): void {
  const dbi = getDb();
  const todoCount = (dbi.prepare('SELECT COUNT(*) AS c FROM plan_todos').get() as any).c;
  if (todoCount > 0) return; // 已迁过或已有数据，不重复迁
  const manualRows = dbi.prepare("SELECT * FROM plan_tasks WHERE IFNULL(trigger_type, '') = 'manual'").all() as any[];
  if (!manualRows.length) return;
  const ins = dbi.prepare('INSERT INTO plan_todos (title, description, priority, status, scheduled_start, project_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const tx = dbi.transaction((rows: any[]) => {
    for (const r of rows) ins.run(r.title, r.description || '', r.priority || 'mid', r.status || 'pending', r.scheduled_start || '', r.project_id ?? null, r.source || '', r.created_at || null, r.updated_at || null);
  });
  tx(manualRows);
  logger.info(`[DB] 待办拆表迁移：${manualRows.length} 条待办从 plan_tasks 迁入 plan_todos`);
}

function ensureMessageExtraColumns(): void {
  const cols = getDb().prepare('PRAGMA table_info(prj_messages)').all() as any[];
  if (!cols.length) return;
  const has = (name: string) => cols.some((c: any) => c.name === name);
  if (!has('thinking')) {
    getDb().exec("ALTER TABLE prj_messages ADD COLUMN thinking TEXT DEFAULT ''");
    logger.info('[DB] prj_messages 已补 thinking 列（思考过程落库）');
  }
  if (!has('duration_ms')) {
    getDb().exec('ALTER TABLE prj_messages ADD COLUMN duration_ms INTEGER DEFAULT 0');
    logger.info('[DB] prj_messages 已补 duration_ms 列（回答耗时）');
  }
}

/**
 * 上一版这段迁移是坏的：它先 ALTER 加出 session_id，再想 DROP 旧表重建，
 * 但线上 prj_messages 还挂着 `session_id REFERENCES prj_sessions(id)` 这条遗留外键，
 * DROP 被外键挡下，异常又被 catch 吞掉 —— 库就长期停在「有 session_id、id 仍是 TEXT 主键」的半迁移状态。
 * 后果：createSession 的 INSERT 不写 id（新表结构里 id 是自增主键），在这套旧结构上 id 落成 NULL，
 * 于是给新建会话插第一条消息时撞外键，报 FOREIGN KEY constraint failed。桌面新建对话和移动端都一样。
 * 这里把两张表一起重建（消息行 id 原样保留），遗留外键一并去掉。
 */
function migrateSessionKeyTable(): void {
  const cols = getDb().prepare('PRAGMA table_info(prj_sessions)').all() as any[];
  if (!cols.length) return;
  const idType = String((cols.find((c: any) => c.name === 'id') || {}).type || '').toUpperCase();
  const msgDdl = getDb().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='prj_messages'").get() as any;
  const hasStaleFk = !!msgDdl && /REFERENCES\s+prj_sessions\s*\(\s*id\s*\)/i.test(String(msgDdl.sql));
  if (idType === 'INTEGER' && !hasStaleFk) return;

  try {
    getDb().pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(DB_PATH, DB_PATH + '.pre-session-key');
  } catch (e: any) {
    logger.error('[DB] 迁移前备份失败，跳过主键迁移（库保持现状）: %s', e.message);
    return;
  }

  try {
    getDb().exec('PRAGMA foreign_keys=OFF');
    getDb().transaction(() => {
      // 当年那次失败的迁移是逐条 exec 的：CREATE prj_sessions_new 已经提交，DROP 旧表才报错，
      // 于是库里留着一张半成品 prj_sessions_new。先清掉它，否则下面的 CREATE 直接撞名。
      for (const leftover of ['prj_sessions_new', 'prj_messages_new']) {
        const n = (getDb().prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?`).get(leftover) as any).c;
        if (!n) continue;
        const rows = (getDb().prepare(`SELECT COUNT(*) c FROM ${leftover}`).get() as any).c;
        logger.warn('[DB] 清理旧迁移残留表 %s（%d 行，内容已由 %s 承载）', leftover, rows, leftover === 'prj_sessions_new' ? 'prj_sessions' : 'prj_messages');
        getDb().exec(`DROP TABLE ${leftover}`);
      }
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
          updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
          model_id TEXT DEFAULT ''
        );
        INSERT INTO prj_sessions_new (session_id, source, title, chat_id, chat_type, mode, project_id, active_agent, created_at, updated_at, model_id)
          SELECT COALESCE(session_id, id), source, title, chat_id, chat_type, mode, project_id, active_agent, created_at, updated_at, model_id FROM prj_sessions;
        DROP TABLE prj_sessions;
        ALTER TABLE prj_sessions_new RENAME TO prj_sessions;

        CREATE TABLE prj_messages_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          source TEXT DEFAULT 'ui',
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          mode TEXT DEFAULT 'general',
          images TEXT DEFAULT NULL,
          thinking TEXT DEFAULT '',
          duration_ms INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now', '+8 hours'))
        );
        INSERT INTO prj_messages_new (id, session_id, source, role, content, mode, images, thinking, duration_ms, created_at)
          SELECT id, session_id, source, role, content, mode, images, thinking, duration_ms, created_at FROM prj_messages;
        DROP TABLE prj_messages;
        ALTER TABLE prj_messages_new RENAME TO prj_messages;
      `);
    })();
    getDb().exec('PRAGMA foreign_keys=ON');
    const broken = getDb().prepare('PRAGMA foreign_key_check').all() as any[];
    const orphans = (getDb().prepare('SELECT COUNT(*) c FROM prj_messages WHERE session_id NOT IN (SELECT session_id FROM prj_sessions)').get() as any).c;
    logger.info('[DB] prj_sessions 主键迁移完成：外键异常 %d 条，孤儿消息 %d 条（备份在 qihang-ai-desktop.db.pre-session-key）', broken.length, orphans);
  } catch (e: any) {
    try { getDb().exec('PRAGMA foreign_keys=ON'); } catch {}
    logger.error('[DB] prj_sessions 主键迁移失败，库保持原样（备份在 qihang-ai-desktop.db.pre-session-key）: %s', e.message);
  }
}

// ========== Helpers ==========

function q<T = any>(sql: string, ...params: any[]): T[] {
  try {
    const stmt = getDb().prepare(sql);
    return (params.length ? stmt.all(...params) : stmt.all()) as T[];
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
  try { getDb().prepare(sql).run(...params); }
  catch (e: any) { logger.error('[DB] SQL error: %s | SQL: %s', e.message, sql.slice(0, 200)); throw e; }
}

/** 执行 INSERT 并返回自增主键（避免按名字回查撞重名） */
function runInsertId(sql: string, ...params: any[]): number {
  try { return Number(getDb().prepare(sql).run(...params).lastInsertRowid); }
  catch (e: any) { logger.error('[DB] SQL error: %s | SQL: %s', e.message, sql.slice(0, 200)); throw e; }
}

function runRaw(sql: string, params: any[]) {
  run(sql, ...(params || []));
}

function save() {}

function close() {
  if (db) { try { db.close(); } catch {} db = null; }
}

// ========== Projects（项目：本地目录，笔记库也是项目） ==========
const project = {
  list: (type?) => {
    if (type) return q('SELECT * FROM prj_projects WHERE type = ? ORDER BY sort_order ASC, created_at DESC', type);
    return q('SELECT * FROM prj_projects ORDER BY sort_order ASC, created_at DESC');
  },
  get: (id) => qOne('SELECT * FROM prj_projects WHERE id = ?', id),
  getDefault: () => qOne('SELECT * FROM prj_projects WHERE is_default = 1'),
  setDefault: (id) => {
    run('UPDATE prj_projects SET is_default = 0 WHERE is_default = 1');
    if (id) run('UPDATE prj_projects SET is_default = 1 WHERE id = ?', id);
  },
  add: (name, type, dir, description, defaultBranch) => {
    const t = type || 'note';
    const id = runInsertId('INSERT INTO prj_projects (name, type, dir, description, default_branch) VALUES (?, ?, ?, ?, ?)',
      name, t, dir || '', description || '', defaultBranch || '');
    return { id, name, type: t };
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
};

// ========== Sessions & Messages ==========
const chat = {
  sessions: (projectId, limit?, offset?) => {
    try {
      const pid = (projectId !== null && projectId !== undefined && projectId !== '') ? Number(projectId) : NaN;
      const page = (limit !== undefined && Number(limit) > 0)
        ? ` LIMIT ${Math.trunc(Number(limit))} OFFSET ${Math.max(0, Math.trunc(Number(offset) || 0))}`
        : '';
      if (Number.isFinite(pid)) return q(`SELECT s.*, (SELECT content FROM prj_messages WHERE session_id = s.session_id ORDER BY id DESC LIMIT 1) as last_message FROM prj_sessions s WHERE s.project_id = ? ORDER BY s.updated_at DESC${page}`, Math.trunc(pid));
      return q(`SELECT s.*, (SELECT content FROM prj_messages WHERE session_id = s.session_id ORDER BY id DESC LIMIT 1) as last_message FROM prj_sessions s ORDER BY s.updated_at DESC${page}`);
    } catch { return []; }
  },
  sessionsBySource: (source, projectId) => {
    try {
      const pid = (projectId !== null && projectId !== undefined && projectId !== '') ? Number(projectId) : NaN;
      if (Number.isFinite(pid)) return q(`SELECT s.*, (SELECT COUNT(*) FROM prj_messages WHERE session_id = s.session_id) as msg_count, (SELECT content FROM prj_messages WHERE session_id = s.session_id ORDER BY id DESC LIMIT 1) as last_message FROM prj_sessions s WHERE s.source = ? AND s.project_id = ? ORDER BY updated_at DESC`, source, Math.trunc(pid));
      return q(`SELECT s.*, (SELECT COUNT(*) FROM prj_messages WHERE session_id = s.session_id) as msg_count, (SELECT content FROM prj_messages WHERE session_id = s.session_id ORDER BY id DESC LIMIT 1) as last_message FROM prj_sessions s WHERE s.source = ? ORDER BY updated_at DESC`, source);
    } catch { return []; }
  },
  createSession: (id, projectId, title, mode, agent, source, originChatId?) => {
    // project_id 可能传入 'notesdir' 等字符串哨兵值（飞书场景），INT 列只存合法数字
    const n = (projectId === null || projectId === undefined) ? NaN : Number(projectId);
    const pid = Number.isFinite(n) ? Math.trunc(n) : null;
    const existing = qOne('SELECT * FROM prj_sessions WHERE session_id = ?', id);
    if (existing) return existing;
    run("INSERT INTO prj_sessions (session_id, source, title, mode, project_id, active_agent, origin_chat_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, source || 'ui', title || '新对话', mode || 'general', pid, agent || 'pi', originChatId || '');
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
  updateSessionProject: (id, projectId) => {
    const n = (projectId === null || projectId === undefined || projectId === '') ? NaN : Number(projectId);
    const pid = Number.isFinite(n) ? Math.trunc(n) : null;
    run("UPDATE prj_sessions SET project_id = ?, updated_at = datetime('now', '+8 hours') WHERE session_id = ?", pid, id);
  },
  updateSessionModel: (id, modelId) => {
    run("UPDATE prj_sessions SET model_id = ?, updated_at = datetime('now', '+8 hours') WHERE session_id = ?", modelId || '', id);
  },
  /** 某来源的最近一条会话；带 originChatId 时本会话（群/私聊）优先、无锚点的旧会话全局兜底 */
  latestBySource: (source, originChatId?) => {
    try {
      const chatId = String(originChatId || '');
      if (chatId) {
        return qOne(
          `SELECT * FROM prj_sessions
           WHERE source = ? AND (IFNULL(origin_chat_id, '') = '' OR origin_chat_id = ?)
           ORDER BY (CASE WHEN IFNULL(origin_chat_id, '') = ? THEN 0 ELSE 1 END), updated_at DESC
           LIMIT 1`,
          source, chatId, chatId
        );
      }
      return qOne('SELECT * FROM prj_sessions WHERE source = ? ORDER BY updated_at DESC LIMIT 1', source);
    } catch { return null; }
  },
  messages: (sessionId) => {
    const rows = q("SELECT * FROM prj_messages WHERE session_id = ? ORDER BY id", sessionId);
    return rows.map(r => ({ ...r, images: r.images ? JSON.parse(r.images) : null }));
  },
  addMessage: (sessionId, role, content, mode?, images?, thinking?, durationMs?) => {
    const imagesJson = images?.length ? JSON.stringify(images) : null;
    run("INSERT INTO prj_messages (session_id, role, content, mode, images, thinking, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)", sessionId, role, content, mode || 'general', imagesJson, thinking || '', Math.max(0, Math.round(Number(durationMs) || 0)));
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
    run('INSERT INTO data_center_modules (module_id, name, description, icon) VALUES (?, ?, ?, ?)', id, name, description || '', icon || '📁');
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
    for (const d of dsList) {
      const rw = dsRecordWhere(d.id);
      run(`DELETE FROM data_center_records WHERE ${rw.sql}`, ...rw.params);
    }
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

/**
 * 记录表 dataset_id 的规范写法（写入用）：统一存字符串。
 * 必须转字符串 —— better-sqlite3 会把 JS 数字按 REAL 绑定，
 * 存进 TEXT 列就变成 '14.0'，与历史 '14' 的记录混在一起，按 '14' 精确匹配就查不到了。
 */
function dsRecordKey(id: any): string {
  return String(id == null ? '' : id).trim();
}

/**
 * 记录表 dataset_id 的查询条件。
 *
 * 亲和性坑：dataset_id 是 TEXT 列，拿「数字」参数比对时 SQLite 会给参数套上 TEXT 亲和性，
 * 把 14 变成 '14.0' 文本再比，跟存着的 '14' 对不上 —— 所以一律用文本精确匹配。
 * 另给历史的 'N.0' 写法留一个口子（迁移没兜住的旧记录也能查出来），
 * 用 GLOB 限定只处理纯数字开头的值，UUID 型 dataset_id 不受影响。
 */
function dsRecordWhere(id: any): { sql: string; params: any[] } {
  const key = dsRecordKey(id);
  if (!/^\d+$/.test(key)) return { sql: 'dataset_id = ?', params: [key] };
  return {
    sql: "(dataset_id = ? OR (dataset_id GLOB '[0-9]*.0' AND CAST(dataset_id AS REAL) = CAST(? AS REAL)))",
    params: [key, key],
  };
}

/**
 * 回填记录表的镜像列：record_type（类型）/ record_status（状态）/ source（来源）。
 *
 * 这几列建表时预留但一直没写入，真实内容全在 data_json 里（更新日志 v0.18 有说明）。
 * 语义上它们就是 类型/状态/来源，现在按 data_json 里的中文字段回填，
 * 让数据库直接 SELECT 也能看到；找不到对应字段就存 NULL，不影响任何查询路径。
 * 列表与筛选依旧读 data_json —— 镜像列只是给人看和给 SQL 用的。
 */
function fillRecordMirrorColumns(dataObj: any): { record_type: string | null; record_status: string | null; source: string | null } {
  const d = (dataObj && typeof dataObj === 'object') ? dataObj : {};
  const pick = (k: string): string | null => {
    const v = d[k];
    const s = v == null ? '' : String(v).trim();
    return s || null;   // 空值存 NULL：与回填迁移的口径一致（NULL = 该字段没填）
  };
  // 中文核心字段优先，兼容英文键（type/status/source）
  return {
    record_type: pick('类型') || pick('type'),
    record_status: pick('状态') || pick('status'),
    source: pick('来源') || pick('source'),
  };
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
    // 返回真正的自增行 id（记录表按它关联），别把 dataset_id 字符串当成 id 用
    const row = qOne<{ id: number }>('SELECT id FROM data_center_datasets WHERE dataset_id = ? ORDER BY id DESC LIMIT 1', id);
    return { id: row ? row.id : id, dataset_id: id };
  },
  updateMeta: (id, data) => {
    const fields: any[] = []; const params: any[] = [];
    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name); }
    if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description); }
    if (data.type !== undefined) { fields.push('type = ?'); params.push(data.type); }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status); }
    // schema_json 同时兼容 camelCase 传法（渲染层两套写法都出现过，漏一个就静默不生效）
    const schemaJson = data.schema_json !== undefined ? data.schema_json : data.schemaJson;
    if (schemaJson !== undefined) { fields.push('schema_json = ?'); params.push(schemaJson); }
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
    if (dsRow) {
      const rw = dsRecordWhere(dsRow.id);
      run(`DELETE FROM data_center_records WHERE ${rw.sql}`, ...rw.params);
    }
    run(`DELETE FROM data_center_datasets WHERE ${w.where}`, ...w.params);
  },
  query: (datasetId, conditions) => {
    const w = dsRecordWhere(datasetId);
    let sql = "SELECT * FROM data_center_records WHERE " + w.sql;
    const params: any[] = [...w.params];
    if (conditions) { sql += ' AND data_json LIKE ?'; params.push(`%${conditions}%`); }
    sql += ' ORDER BY created_at DESC LIMIT 50';
    return q(sql, ...params).map(r => ({ id: r.id, ...JSON.parse(r.data_json || '{}'), _created_at: r.created_at }));
  },
  /** 工单视图用：分页返回某数据集全部记录（含 id 与 created_at），可按关键词过滤标题 */
  listRecords: (datasetId, opts?: { search?: string; limit?: number; offset?: number }) => {
    const limit = Math.max(1, Math.min(200, (opts && opts.limit) || 100));
    const offset = Math.max(0, (opts && opts.offset) || 0);
    const w = dsRecordWhere(datasetId);
    let sql = "SELECT * FROM data_center_records WHERE " + w.sql;
    const params: any[] = [...w.params];
    if (opts && opts.search) { sql += ' AND data_json LIKE ?'; params.push(`%${opts.search}%`); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'; params.push(limit, offset);
    const rows = q(sql, ...params).map(r => ({ id: r.id, record_id: r.record_id, ...JSON.parse(r.data_json || '{}'), _created_at: r.created_at }));
    const w2 = dsRecordWhere(datasetId);
    let totalSql = "SELECT COUNT(*) AS c FROM data_center_records WHERE " + w2.sql; const totalParams: any[] = [...w2.params];
    if (opts && opts.search) { totalSql += ' AND data_json LIKE ?'; totalParams.push(`%${opts.search}%`); }
    const total = (qOne<{ c: number }>(totalSql, ...totalParams) || { c: 0 }).c;
    return { rows, total };
  },
  insert: (datasetId, dataObj) => {
    // dataset_id 必须按字符串写入（见 dsRecordKey 注释）
    const key = dsRecordKey(datasetId);
    const m = fillRecordMirrorColumns(dataObj);
    run("INSERT INTO data_center_records (dataset_id, data_json, record_type, record_status, source) VALUES (?, ?, ?, ?, ?)",
      key, JSON.stringify(dataObj), m.record_type, m.record_status, m.source);
    // 工单联动 hook：通知外部（main.ts 注册）记录已保存，便于按承诺时间派生提醒等
    const rec = qOne<{ id: number }>('SELECT id FROM data_center_records WHERE dataset_id = ? ORDER BY id DESC LIMIT 1', key);
    try { for (const h of dsRecordHooks) h('insert', key, rec ? rec.id : null, dataObj); } catch (e) { logger.warn('[DB] ds record hook error: ' + (e && e.message)); }
    return rec ? rec.id : null;
  },
  updateRecord: (id, dataObj) => {
    // 取旧值：记录钩子要靠它比对出「状态从 A 变 B」这类流转
    const prevRow = qOne<{ data_json: string }>('SELECT data_json FROM data_center_records WHERE id = ?', id);
    let prev: any = null;
    try { prev = prevRow ? JSON.parse(prevRow.data_json || '{}') : null; } catch { prev = null; }
    const m = fillRecordMirrorColumns(dataObj);
    run('UPDATE data_center_records SET data_json = ?, record_type = ?, record_status = ?, source = ? WHERE id = ?',
      JSON.stringify(dataObj), m.record_type, m.record_status, m.source, id);
    const rec = qOne<{ dataset_id: string | number }>('SELECT dataset_id FROM data_center_records WHERE id = ?', id);
    try { for (const h of dsRecordHooks) h('update', rec ? String(rec.dataset_id) : '', id, dataObj, prev); } catch (e) { logger.warn('[DB] ds record hook error: ' + (e && e.message)); }
  },
  /** 工单联动等外部逻辑注册的记录保存回调（kind: 'insert' | 'update' | 'delete'） */
  onRecordSave: (fn: (kind: 'insert' | 'update' | 'delete', datasetId: string, recordId: number | null, data: any, prev?: any) => void) => {
    dsRecordHooks.push(fn);
  },
  deleteRecord: (id) => {
    const rec = qOne<{ dataset_id: string | number; data_json: string }>('SELECT dataset_id, data_json FROM data_center_records WHERE id = ?', id);
    let prev: any = null;
    try { prev = rec ? JSON.parse(rec.data_json || '{}') : null; } catch { prev = null; }
    run('DELETE FROM data_center_records WHERE id = ?', id);
    try { for (const h of dsRecordHooks) h('delete', rec ? String(rec.dataset_id) : '', id, prev); } catch (e) { logger.warn('[DB] ds record hook error: ' + (e && e.message)); }
  },
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
    run('INSERT OR IGNORE INTO plan_reminders (id, name, message, type, time, date, day_of_week, day_of_month, month_day, enabled, created_at, last_triggered, project_id, ticket_dataset_id, source_record_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, data.name, data.message || '', data.type, data.time || '09:00', data.date || '',
      data.day_of_week || 0, data.day_of_month || 1, data.month_day || '',
      data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
      data.created_at || new Date().toISOString().slice(0, 19).replace('T', ' '),
      data.last_triggered || '', data.project_id || null,
      data.ticket_dataset_id || '', data.source_record_id != null ? String(data.source_record_id) : '');
    return { id };
  },
  update: (id, data) => {
    const fields: any[] = []; const params: any[] = [];
    if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name); }
    if (data.message !== undefined) { fields.push('message = ?'); params.push(data.message); }
    if (data.type !== undefined) { fields.push('type = ?'); params.push(data.type); }
    if (data.time !== undefined) { fields.push('time = ?'); params.push(data.time); }
    if (data.date !== undefined) { fields.push('date = ?'); params.push(data.date); }
    if (data.enabled !== undefined) { fields.push('enabled = ?'); params.push(data.enabled ? 1 : 0); }
    if (data.ticket_dataset_id !== undefined) { fields.push('ticket_dataset_id = ?'); params.push(data.ticket_dataset_id || ''); }
    if (data.source_record_id !== undefined) { fields.push('source_record_id = ?'); params.push(data.source_record_id != null ? String(data.source_record_id) : ''); }
    if (fields.length) { params.push(id); run(`UPDATE plan_reminders SET ${fields.join(', ')} WHERE id = ?`, ...params); }
  },
  remove: (id) => run('DELETE FROM plan_reminders WHERE id = ?', id),
  setEnabled: (id, enabled) => run('UPDATE plan_reminders SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id),
  getActive: () => q("SELECT * FROM plan_reminders WHERE enabled = 1"),
};

// ========== AI 任务（挂在笔记库下） ==========
const task = {
  // 任务列表（仅定时/循环任务）。待办已独立到 plan_todos（见 todo 对象），不再存 plan_tasks；
  // 这里保留 trigger_type != 'manual' 过滤作为防御（历史库若仍有残留 manual 行则排除）。
  list: (status?: string) => {
    if (status) return q("SELECT * FROM plan_tasks WHERE status = ? AND IFNULL(task_type, '') != 'coding' AND IFNULL(trigger_type, '') != 'manual' ORDER BY created_at DESC", status);
    return q("SELECT * FROM plan_tasks WHERE IFNULL(task_type, '') != 'coding' AND IFNULL(trigger_type, '') != 'manual' ORDER BY created_at DESC");
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
    run('DELETE FROM plan_executions WHERE task_id = ?', id);
    run('DELETE FROM plan_tasks WHERE id = ?', id);
  },
  // 可调度的任务（定时 + 循环），用于恢复调度
  schedulable: () => q("SELECT * FROM plan_tasks WHERE status IN ('pending', 'in_progress') AND IFNULL(task_type, '') != 'coding'"),
  listByProject: (projectId: number) => q('SELECT * FROM plan_tasks WHERE project_id = ? ORDER BY created_at DESC', projectId),
};

// ========== 待办（独立表 plan_todos，2026-11-20 从 plan_tasks 拆出） ==========
// 待办是「要动手做的一件事」，只用 title/description/priority/status/scheduled_start/project_id/source；
// 定时任务（plan_tasks）那套 cycle_*/output_*/session_id/last_* 列对待办无意义，故独立成表。
const todo = {
  list: () => q('SELECT * FROM plan_todos ORDER BY created_at DESC'),
  get: (id: number) => qOne('SELECT * FROM plan_todos WHERE id = ?', id),
  add: (data: any) => {
    const pid = (data.project_id !== null && data.project_id !== undefined && data.project_id !== '') ? (Number.isFinite(Number(data.project_id)) ? Math.trunc(Number(data.project_id)) : null) : null;
    run('INSERT INTO plan_todos (title, description, priority, status, scheduled_start, project_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      data.title, data.description || '', data.priority || 'mid', data.status || 'pending', data.scheduled_start || '', pid, data.source || '');
    const r = qOne<{ id: number }>('SELECT id FROM plan_todos ORDER BY id DESC LIMIT 1');
    return { id: r!.id };
  },
  update: (id: number, data: any) => {
    const fields: any[] = []; const params: any[] = [];
    if (data.title !== undefined) { fields.push('title = ?'); params.push(data.title); }
    if (data.description !== undefined) { fields.push('description = ?'); params.push(data.description); }
    if (data.priority !== undefined) { fields.push('priority = ?'); params.push(data.priority); }
    if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status); }
    if (data.scheduled_start !== undefined) { fields.push('scheduled_start = ?'); params.push(data.scheduled_start); }
    if (data.project_id !== undefined) {
      const v = (data.project_id === null || data.project_id === undefined || data.project_id === '') ? null : (Number.isFinite(Number(data.project_id)) ? Math.trunc(Number(data.project_id)) : null);
      fields.push('project_id = ?'); params.push(v);
    }
    if (data.source !== undefined) { fields.push('source = ?'); params.push(data.source); }
    if (fields.length) { fields.push("updated_at = datetime('now', '+8 hours')"); params.push(id); run(`UPDATE plan_todos SET ${fields.join(', ')} WHERE id = ?`, ...params); }
  },
  remove: (id: number) => {
    run('DELETE FROM plan_todos WHERE id = ?', id);
    // 顺带解除工单关联，别留下指向已删待办的悬空关联
    try { run('DELETE FROM ticket_todos WHERE todo_id = ?', id); } catch (e) {}
  },
  // 未完成数（今天页/侧栏徽标用）
  openCount: () => (qOne<{ c: number }>("SELECT COUNT(*) AS c FROM plan_todos WHERE status != 'done'") || { c: 0 }).c,
};

const taskExecution = {
  add: (data: any) => {
    run('INSERT INTO plan_executions (task_id, task_title, status, trigger_type, start_time, end_time, log_text, result_text, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      data.task_id || null, data.task_title || '', data.status || 'QUEUED', data.trigger_type || '',
      data.start_time || '', data.end_time || '', data.log_text || '', data.result_text || '', data.error_message || '');
    const r = qOne<{id: number}>('SELECT id FROM plan_executions ORDER BY id DESC LIMIT 1');
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
    if (fields.length) { params.push(id); run(`UPDATE plan_executions SET ${fields.join(', ')} WHERE id = ?`, ...params); }
  },
  list: (page = 1, pageSize = 20) => {
    const offset = Math.max(0, (page - 1) * pageSize);
    const total = (qOne<{c: number}>('SELECT COUNT(*) as c FROM plan_executions') || {}).c || 0;
    const rows = q('SELECT * FROM plan_executions ORDER BY id DESC LIMIT ? OFFSET ?', pageSize, offset);
    return { total, rows };
  },
  listByTask: (taskId: number, limit = 20) => q('SELECT * FROM plan_executions WHERE task_id = ? ORDER BY id DESC LIMIT ?', taskId, limit),
  get: (id: number) => qOne('SELECT * FROM plan_executions WHERE id = ?', id),
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

// ========== 飞书会话 → 项目 绑定 ==========
const feishuContext = {
  get: (chatId: string) => qOne('SELECT * FROM feishu_contexts WHERE chat_id = ?', chatId),
  set: (chatId: string, chatType: string, projectId: number) => {
    run(
      `INSERT INTO feishu_contexts (chat_id, chat_type, project_id, updated_at)
       VALUES (?, ?, ?, datetime('now', '+8 hours'))
       ON CONFLICT(chat_id) DO UPDATE SET
         chat_type = excluded.chat_type,
         project_id = excluded.project_id,
         updated_at = excluded.updated_at`,
      chatId, chatType || '', projectId
    );
  },
  remove: (chatId: string) => run('DELETE FROM feishu_contexts WHERE chat_id = ?', chatId),
  list: () => q('SELECT * FROM feishu_contexts ORDER BY updated_at DESC'),
};

export { getDb, close, q, qOne, run, runRaw, save, project, chat, dm, ds, aa, reminder, task, todo, taskExecution, aitoolHistory, feishuContext };
