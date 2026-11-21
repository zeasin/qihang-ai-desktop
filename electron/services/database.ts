/**
 * 数据库服务（database.ts）
 *
 * 本地 SQLite（better-sqlite3）单存储：会话、项目、提醒、任务、工单（tickets）、
 * AI 分析、工具历史、知识库索引全部保存在用户主目录 .qihang-ai-desktop 下。
 * （2026-11-21：data_center 三层与 plan_todos 退役——工单迁入 tickets 专表、
 * 待办并入 tickets（类型='待办'），见 migrateDataCenterToTickets / migrateTodosIntoTickets）
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

/** 本地 SQLite 表结构 */
function initSchema() {
  // 表改名迁移：统一任务域表名前缀为 plan_（与 prj_ / kb_ 对齐）。
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

    -- 工单（事项体系唯一实体表，2026-11-21 从 data_center_datasets/records 迁入）：
    -- 10 个核心字段用中文列名（SELECT * 出来即消费方熟悉的中文键对象，零映射层），
    -- 用户自定义字段统一进 extra_json（读路径合并、写路径拆分，见 services/tickets.ts）
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      "标题" TEXT DEFAULT '',
      "类型" TEXT DEFAULT '',
      "来源" TEXT DEFAULT '',
      "新建人" TEXT DEFAULT '',
      "处理人" TEXT DEFAULT '',
      "内容" TEXT DEFAULT '',
      "备注" TEXT DEFAULT '',
      "状态" TEXT DEFAULT '待处理',
      "承诺时间" TEXT DEFAULT '',
      "处理时间" TEXT DEFAULT '',
      "完结时间" TEXT DEFAULT '',
      extra_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    -- 工单枚举/字段定义（单行）：schema_json 结构与迁移前的 datasets.schema_json 完全相同
    -- （fields/statusOptions/terminalStatuses/typeOptions/sourceOptions），事项页工单设置读写它
    CREATE TABLE IF NOT EXISTS ticket_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_json TEXT DEFAULT '{}',
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

    -- 工单处理记录：新建/状态变化/流转的流水（工单的记录级日志）
    CREATE TABLE IF NOT EXISTS ticket_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER,
      action TEXT DEFAULT '',
      field TEXT DEFAULT '',
      from_value TEXT DEFAULT '',
      to_value TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_logs_record ON ticket_logs(record_id);

    -- 工单 ↔ 待办工单 关联（一单可拆多条待办；待办本身是 tickets 表里 类型='待办' 的行）
    CREATE TABLE IF NOT EXISTS ticket_todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER,
      todo_id INTEGER,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_todos_record ON ticket_todos(record_id);
    CREATE INDEX IF NOT EXISTS idx_ticket_todos_todo ON ticket_todos(todo_id);

    -- 处理人节点：人=名字+webhook一体；流转/指派到该节点时触发通知到其 url
    CREATE TABLE IF NOT EXISTS ticket_handlers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      webhook_url TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      remark TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    -- 流转节点实例：一次状态变更一行，工单的完整生命周期账本（可回放/审计）
    CREATE TABLE IF NOT EXISTS ticket_flow_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER NOT NULL,
      node_index INTEGER NOT NULL DEFAULT 1,
      status TEXT DEFAULT '',
      handler_name TEXT DEFAULT '',
      handler_id INTEGER,
      entered_at TEXT DEFAULT (datetime('now', '+8 hours')),
      exited_at TEXT,
      duration_minutes INTEGER,
      result TEXT DEFAULT '',
      result_kind TEXT DEFAULT '',
      trigger TEXT DEFAULT '',
      notified INTEGER DEFAULT 0,
      notify_error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );
    CREATE INDEX IF NOT EXISTS idx_flow_nodes_record ON ticket_flow_nodes(record_id, node_index);

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
  // 工单联动：一次性提醒可关联到来源工单（ticket_dataset_id 2026-11-21 起恒为 'tickets'）
  try { getDb().exec("ALTER TABLE plan_reminders ADD COLUMN ticket_dataset_id TEXT DEFAULT ''"); } catch (e) {}
  try { getDb().exec("ALTER TABLE plan_reminders ADD COLUMN source_record_id TEXT DEFAULT ''"); } catch (e) {}
  // 工单存储迁移（2026-11-21 去 data_center 通用层，全部幂等，失败只告警不阻断启动）：
  //   ① side 表去 dataset_id；② 「工单」数据集记录迁入 tickets（保留原 id）；
  //   ③ plan_todos 待办并入 tickets（类型='待办'，迁完删旧表）；④ 无节点账的工单补初始节点
  try { rebuildTicketSideTables(); } catch (e) { logger.warn('[DB] 工单 side 表重建失败: ' + (e && e.message)); }
  try { migrateDataCenterToTickets(); } catch (e) { logger.warn('[DB] 工单迁移失败: ' + (e && e.message)); }
  try { migrateTodosIntoTickets(); } catch (e) { logger.warn('[DB] 待办并入工单迁移失败: ' + (e && e.message)); }
  try { backfillTicketNodes(); } catch (e) { logger.warn('[DB] 节点账回填失败: ' + (e && e.message)); }
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
 * 工单 side 表结构升级：去掉 dataset_id 列（2026-11-21 起 record_id 直接指 tickets.id）。
 * 旧结构（含 dataset_id）按 _new 重建拷贝；新结构或全新库自然跳过。
 * 记录 id 在工单迁移中保留原值，side 表按 record_id 的关联不受重建影响。
 */
function rebuildTicketSideTables(): void {
  const dbi = getDb();
  const defs = [
    {
      table: 'ticket_logs',
      ddl: `CREATE TABLE ticket_logs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id INTEGER,
        action TEXT DEFAULT '', field TEXT DEFAULT '', from_value TEXT DEFAULT '',
        to_value TEXT DEFAULT '', note TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now', '+8 hours'))
      )`,
      copyCols: 'id, record_id, action, field, from_value, to_value, note, created_at',
      indexSql: ['CREATE INDEX IF NOT EXISTS idx_ticket_logs_record ON ticket_logs(record_id)'],
    },
    {
      table: 'ticket_todos',
      ddl: `CREATE TABLE ticket_todos_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id INTEGER,
        todo_id INTEGER,
        created_at TEXT DEFAULT (datetime('now', '+8 hours'))
      )`,
      copyCols: 'id, record_id, todo_id, created_at',
      indexSql: [
        'CREATE INDEX IF NOT EXISTS idx_ticket_todos_record ON ticket_todos(record_id)',
        'CREATE INDEX IF NOT EXISTS idx_ticket_todos_todo ON ticket_todos(todo_id)',
      ],
    },
    {
      table: 'ticket_flow_nodes',
      ddl: `CREATE TABLE ticket_flow_nodes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id INTEGER NOT NULL,
        node_index INTEGER NOT NULL DEFAULT 1,
        status TEXT DEFAULT '', handler_name TEXT DEFAULT '', handler_id INTEGER,
        entered_at TEXT DEFAULT (datetime('now', '+8 hours')), exited_at TEXT,
        duration_minutes INTEGER, result TEXT DEFAULT '', result_kind TEXT DEFAULT '',
        trigger TEXT DEFAULT '', notified INTEGER DEFAULT 0, notify_error TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now', '+8 hours'))
      )`,
      copyCols: `id, record_id, node_index, status, handler_name, handler_id, entered_at,
        exited_at, duration_minutes, result, result_kind, trigger, notified, notify_error, created_at`,
      indexSql: ['CREATE INDEX IF NOT EXISTS idx_flow_nodes_record ON ticket_flow_nodes(record_id, node_index)'],
    },
  ];
  for (const d of defs) {
    const cols = dbi.prepare(`PRAGMA table_info(${d.table})`).all() as any[];
    if (!cols.length) continue;                                              // 全新库：initSchema 已建新结构
    if (!cols.some((c: any) => c.name === 'dataset_id')) continue;           // 已是新结构
    dbi.transaction(() => {
      dbi.exec(`DROP TABLE IF EXISTS ${d.table}_new`);
      dbi.exec(d.ddl);
      dbi.exec(`INSERT INTO ${d.table}_new (${d.copyCols}) SELECT ${d.copyCols} FROM ${d.table}`);
      dbi.exec(`DROP TABLE ${d.table}`);
      dbi.exec(`ALTER TABLE ${d.table}_new RENAME TO ${d.table}`);
      for (const idx of d.indexSql) dbi.exec(idx);
    })();
    logger.info('[DB] 工单 side 表重建（去 dataset_id）：' + d.table);
  }
}

/**
 * 「工单」数据集 → tickets 表迁移（2026-11-21）。
 * 幂等：tickets 已有行即跳过。原记录 id 原样保留（AUTOINCREMENT 序列自动抬到 max），
 * side 表（logs/todos/flow_nodes）与提醒绑定按 record_id 的关联因此无需重映射。
 * 同名「工单」数据集可能不止一个（套件模板 builtin_ticket_tickets 同名）→ 取记录数最多者。
 * 枚举/字段定义（schema_json）携带进 ticket_settings；核心字段进列，其余键进 extra_json；
 * 英文镜像键（type/status/source）不入 extra_json（列里已有中文正名）。
 * 旧 data_center_* 表与数据原地保留（隐藏不删，休眠无入口）。
 */
function migrateDataCenterToTickets(): void {
  const dbi = getDb();
  const hasLegacy = dbi.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='data_center_records'").get();
  if (!hasLegacy) return;
  const cnt = (dbi.prepare('SELECT COUNT(*) AS c FROM tickets').get() as any).c;
  if (cnt > 0) return;
  const dsRows = dbi.prepare("SELECT id, schema_json FROM data_center_datasets WHERE name = '工单'").all() as any[];
  if (!dsRows.length) return;
  // 提醒绑定改写：旧 dataset key → 'tickets'（record id 在迁移中保留，source_record_id 不动）
  for (const ds of dsRows) {
    const upd = dbi.prepare("UPDATE plan_reminders SET ticket_dataset_id = 'tickets' WHERE ticket_dataset_id = ?").run(String(ds.id));
    if (upd.changes) logger.info(`[DB] 提醒绑定改写：${upd.changes} 条（dataset=${ds.id} → tickets）`);
  }
  let best: any = null; let bestCount = -1;
  for (const ds of dsRows) {
    const c = (dbi.prepare('SELECT COUNT(*) AS c FROM data_center_records WHERE dataset_id = ?').get(String(ds.id)) as any).c;
    if (c > bestCount) { bestCount = c; best = ds; }
  }
  if (best && best.schema_json) {
    dbi.prepare('INSERT OR REPLACE INTO ticket_settings (id, schema_json) VALUES (1, ?)').run(String(best.schema_json));
  }
  if (!best || bestCount === 0) { logger.info('[DB] 工单迁移：无存量工单记录，跳过'); return; }
  const CORE = ['标题', '类型', '来源', '新建人', '处理人', '内容', '备注', '状态', '承诺时间', '处理时间', '完结时间'];
  const rows = dbi.prepare('SELECT id, data_json, created_at FROM data_center_records WHERE dataset_id = ? ORDER BY id ASC').all(String(best.id)) as any[];
  const ins = dbi.prepare(`INSERT INTO tickets (id, "标题", "类型", "来源", "新建人", "处理人", "内容", "备注", "状态", "承诺时间", "处理时间", "完结时间", extra_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tx = dbi.transaction((rs: any[]) => {
    for (const r of rs) {
      let d: any = {};
      try { d = JSON.parse(r.data_json || '{}'); } catch {}
      const extra: any = {};
      for (const [k, v] of Object.entries(d)) {
        if (CORE.includes(k) || k === 'type' || k === 'status' || k === 'source') continue;
        extra[k] = v;
      }
      ins.run(r.id,
        String(d['标题'] || ''), String(d['类型'] || ''), String(d['来源'] || ''),
        String(d['新建人'] || ''), String(d['处理人'] || ''), String(d['内容'] || ''), String(d['备注'] || ''),
        String(d['状态'] || '待处理'), String(d['承诺时间'] || ''), String(d['处理时间'] || ''), String(d['完结时间'] || ''),
        JSON.stringify(extra), r.created_at || null);
    }
  });
  tx(rows);
  logger.info(`[DB] 工单迁移：${rows.length} 条从 data_center_records 迁入 tickets（id 保留，源数据集=${best.id}）`);
}

/**
 * plan_todos 待办并入 tickets（2026-11-21「所有事项都放进工单」）。
 * 类型='待办'；status done→已完成、pending→待处理；scheduled_start 纯日期补 18:00。
 * 待办拿到新 id（旧 plan_todos.id 与工单 id 是两个序列，保留会撞），ticket_todos.todo_id 重映射。
 * 迁移成功后删除旧表（数据已全部搬走）；失败保持原样下次再试。
 */
function migrateTodosIntoTickets(): void {
  const dbi = getDb();
  const hasOld = dbi.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_todos'").get();
  if (!hasOld) return;
  const rows = dbi.prepare('SELECT * FROM plan_todos ORDER BY id ASC').all() as any[];
  if (!rows.length) {
    dbi.exec('DROP TABLE plan_todos');
    logger.info('[DB] 待办并入：plan_todos 为空，旧表已删');
    return;
  }
  const idMap = new Map<number, number>();
  const ins = dbi.prepare(`INSERT INTO tickets ("标题", "内容", "类型", "状态", "承诺时间", created_at) VALUES (?, ?, '待办', ?, ?, ?)`);
  dbi.transaction(() => {
    for (const t of rows) {
      const st = String(t.status || 'pending') === 'done' ? '已完成' : '待处理';
      const sched = String(t.scheduled_start || '').trim();
      const promise = /^\d{4}-\d{2}-\d{2}$/.test(sched) ? sched + ' 18:00' : sched;
      const info = ins.run(String(t.title || ''), String(t.description || ''), st, promise, t.created_at || null);
      idMap.set(Number(t.id), Number(info.lastInsertRowid));
    }
    const upd = dbi.prepare('UPDATE ticket_todos SET todo_id = ? WHERE todo_id = ?');
    for (const [oldId, newId] of idMap) upd.run(newId, oldId);
    dbi.exec('DROP TABLE plan_todos');
  })();
  logger.info(`[DB] 待办并入工单：${rows.length} 条迁入 tickets（类型='待办'），ticket_todos 关联已重映射，旧表已删`);
}

/** 节点账回填：给没有节点行的工单补「当前状态」初始节点，账本从启用那天起完整（幂等） */
function backfillTicketNodes(): void {
  const dbi = getDb();
  const rows = dbi.prepare(`
    SELECT t.id, t."状态" AS st, t."处理人" AS hd, t.updated_at
      FROM tickets t
     WHERE NOT EXISTS (SELECT 1 FROM ticket_flow_nodes n WHERE n.record_id = t.id)
  `).all() as any[];
  if (!rows.length) return;
  const ins = dbi.prepare(`INSERT INTO ticket_flow_nodes (record_id, node_index, status, handler_name, handler_id, entered_at, result, result_kind, trigger, notified)
    VALUES (?, 1, ?, ?, NULL, ?, '', 'auto', 'backfill', 0)`);
  dbi.transaction((rs: any[]) => {
    for (const r of rs) ins.run(r.id, String(r.st || '待处理'), String(r.hd || ''), r.updated_at || null);
  })(rows);
  logger.info('[DB] 节点账回填：' + rows.length + ' 单');
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

// ========== 任务执行记录 ==========
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

export { getDb, close, q, qOne, run, runInsertId, runRaw, save, project, chat, aa, reminder, task, taskExecution, aitoolHistory, feishuContext };
