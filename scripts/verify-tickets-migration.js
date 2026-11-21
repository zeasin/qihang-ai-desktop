/**
 * 工单存储迁移探针：预建一个含旧结构的库文件（data_center 三层 + 旧形状 side 表 + plan_todos），
 * 再加载编译产物 database.js（拦截 os.homedir 指向临时目录），断言 initSchema 内的迁移：
 *   ① 「工单」数据集记录迁入 tickets 且保留原 id（side 表关联因此不用重映射）
 *   ② schema_json 携带进 ticket_settings（用户自定义枚举不丢）
 *   ③ ticket_logs/ticket_todos/ticket_flow_nodes 重建为无 dataset_id
 *   ④ plan_todos 待办并入 tickets（类型='待办'，新 id，ticket_todos.todo_id 重映射，旧表删除）
 *   ⑤ plan_reminders.ticket_dataset_id 改写 'tickets'
 *   ⑥ 无节点账的工单补初始节点；二次打开幂等不重复迁移
 * 运行：npm run compile:electron && ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/verify-tickets-migration.js
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const DIST = path.join(__dirname, '..', 'dist-electron', 'electron', 'services');
if (!fs.existsSync(path.join(DIST, 'database.js'))) {
  console.error('缺少编译产物，请先运行 npm run compile:electron');
  process.exit(2);
}

const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } console.log('ok  ' + msg); };

// 临时「用户目录」：拦截 os.homedir 让 database.js 在这里开库，绝不碰真实用户数据
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qihang-mig-'));
const DB_DIR = path.join(TMP, '.qihang-ai-desktop');
fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, 'qihang-ai-desktop.db');

// —— 1) 预建旧结构库（模拟 2026-11-21 之前的存量数据） ——
{
  const legacy = new Database(DB_PATH);
  legacy.exec(`
    CREATE TABLE data_center_datasets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT, name TEXT,
      description TEXT DEFAULT '', schema_json TEXT DEFAULT '{}', module_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','+8 hours')), updated_at TEXT
    );
    CREATE TABLE data_center_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT, data_json TEXT,
      record_type TEXT, record_status TEXT, source TEXT,
      created_at TEXT DEFAULT (datetime('now','+8 hours')), updated_at TEXT
    );
    CREATE TABLE data_center_modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, module_id TEXT, name TEXT, description TEXT,
      icon TEXT, sort_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE ticket_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT DEFAULT '', record_id INTEGER,
      action TEXT DEFAULT '', field TEXT DEFAULT '', from_value TEXT DEFAULT '',
      to_value TEXT DEFAULT '', note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','+8 hours'))
    );
    CREATE TABLE ticket_todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT DEFAULT '', record_id INTEGER,
      todo_id INTEGER, created_at TEXT DEFAULT (datetime('now','+8 hours'))
    );
    CREATE TABLE ticket_flow_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT DEFAULT '', record_id INTEGER NOT NULL,
      node_index INTEGER NOT NULL DEFAULT 1, status TEXT DEFAULT '', handler_name TEXT DEFAULT '',
      handler_id INTEGER, entered_at TEXT, exited_at TEXT, duration_minutes INTEGER,
      result TEXT DEFAULT '', result_kind TEXT DEFAULT '', trigger TEXT DEFAULT '',
      notified INTEGER DEFAULT 0, notify_error TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','+8 hours'))
    );
    CREATE TABLE ticket_handlers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      webhook_url TEXT DEFAULT '', enabled INTEGER DEFAULT 1, remark TEXT DEFAULT '',
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE plan_todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '',
      priority TEXT DEFAULT 'mid', status TEXT DEFAULT 'pending', scheduled_start TEXT DEFAULT '',
      project_id INTEGER, source TEXT DEFAULT '', created_at TEXT, updated_at TEXT
    );
    CREATE TABLE plan_reminders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, message TEXT DEFAULT '', type TEXT NOT NULL,
      time TEXT DEFAULT '09:00', date TEXT DEFAULT '', enabled INTEGER DEFAULT 1,
      ticket_dataset_id TEXT DEFAULT '', source_record_id TEXT DEFAULT '', created_at TEXT
    );
    CREATE TABLE plan_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT DEFAULT '', status TEXT DEFAULT 'pending',
      trigger_type TEXT DEFAULT 'manual', task_type TEXT DEFAULT ''
    );
    CREATE TABLE plan_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, task_title TEXT, status TEXT,
      trigger_type TEXT, start_time TEXT, end_time TEXT, log_text TEXT, result_text TEXT, error_message TEXT
    );
    CREATE TABLE ai_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, module_id TEXT, type TEXT,
      content TEXT, prompt TEXT, dir_path TEXT, report_date TEXT, created_at TEXT, updated_at TEXT
    );
  `);
  // 「工单」数据集（记录 5、7 两条；id 故意不连续，验证 id 保留）
  legacy.prepare(`INSERT INTO data_center_datasets (dataset_id, name, schema_json) VALUES ('ds_1000', '工单', ?)`)
    .run(JSON.stringify({
      fields: [
        { name: '标题', type: 'string' }, { name: '类型', type: 'string' }, { name: '来源', type: 'string' },
        { name: '新建人', type: 'string' }, { name: '处理人', type: 'string' }, { name: '内容', type: 'text' },
        { name: '备注', type: 'text' }, { name: '承诺时间', type: 'datetime' }, { name: '处理时间', type: 'datetime' },
        { name: '完结时间', type: 'datetime' }, { name: '客户', type: 'string' },
      ],
      statusOptions: ['待处理', '处理中', '已解决', '已完成', '已关闭'],
      terminalStatuses: ['已完成', '已关闭', '已解决'],
      typeOptions: ['需求', '问题', '咨询', '跟进'],
      sourceOptions: ['微信', '电话'],
    }));
  const insRec = legacy.prepare('INSERT INTO data_center_records (id, dataset_id, data_json, created_at) VALUES (?, ?, ?, ?)');
  insRec.run(5, '1', JSON.stringify({
    '标题': '金箔雲需求-按月统计销售员提成', '类型': '需求', '状态': '处理中', '处理人': '老齐',
    '承诺时间': '2026-12-01 18:00', '客户': '金箔雲', type: '需求', status: '处理中',
  }), '2026-11-20 09:00:00');
  insRec.run(7, '1', JSON.stringify({ '标题': '打印机无法连接', '类型': '问题', '状态': '待处理' }), '2026-11-19 15:00:00');
  // 旧形状 side 表（关联 record 5/7；dataset_id 指向数据集行 id=1）
  legacy.prepare("INSERT INTO ticket_logs (dataset_id, record_id, action, field, from_value, to_value, note) VALUES ('1', 5, 'create', '', '', '', '新建工单')").run();
  legacy.prepare("INSERT INTO ticket_todos (dataset_id, record_id, todo_id) VALUES ('1', 5, 31)").run();
  legacy.prepare("INSERT INTO ticket_flow_nodes (dataset_id, record_id, node_index, status, handler_name, entered_at) VALUES ('1', 5, 1, '处理中', '老齐', '2026-11-20 09:00:00')").run();
  // 待办（todo 31 关联到工单 5；scheduled_start 纯日期）
  legacy.prepare("INSERT INTO plan_todos (id, title, description, status, scheduled_start, created_at) VALUES (31, '整理提成规则清单', '按商品分类列一遍', 'pending', '2026-11-22', '2026-11-20 10:00:00')").run();
  legacy.prepare("INSERT INTO plan_todos (id, title, status, created_at) VALUES (32, '已完成旧待办', 'done', '2026-11-18 10:00:00')").run();
  // 提醒绑定（旧 dataset key '1' = 工单数据集行 id）
  legacy.prepare("INSERT INTO plan_reminders (id, name, type, time, enabled, ticket_dataset_id, source_record_id) VALUES ('R1', '[工单] 金箔雲', 'once', '18:00', 1, '1', '5')").run();
  legacy.close();
}

// —— 2) require 拦截：database.js 的 os.homedir 指向临时目录；logger 换成安静实现 ——
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && parent.filename.startsWith(DIST)) {
    if (request === 'os') return { homedir: () => TMP, tmpdir: os.tmpdir, EOL: '\n' };
    if (request === './logger') return { info: (...a) => console.log('[db]', ...a), warn: (...a) => console.log('[db-warn]', ...a), error: (...a) => console.log('[db-err]', ...a) };
  }
  return origLoad.apply(this, arguments);
};

// —— 3) 触发迁移：首次 getDb() 跑 initSchema ——
const db = require(path.join(DIST, 'database.js'));
db.getDb();
const q = (sql, ...p) => db.q(sql, ...p);
const qOne = (sql, ...p) => db.qOne(sql, ...p);

// ① 工单迁移：id 保留
const t5 = qOne('SELECT * FROM tickets WHERE id = 5');
assert(!!t5 && t5['标题'] === '金箔雲需求-按月统计销售员提成', '工单记录迁入 tickets 且原 id 保留（#5）');
assert(t5['状态'] === '处理中' && t5['处理人'] === '老齐', '核心字段拆列（状态/处理人）');
assert(t5['承诺时间'] === '2026-12-01 18:00', '承诺时间原样迁入');
assert(JSON.parse(t5.extra_json)['客户'] === '金箔雲', '非核心字段进 extra_json（客户）');
const t7 = qOne('SELECT * FROM tickets WHERE id = 7');
assert(!!t7 && t7['状态'] === '待处理', '第二条工单迁入（#7，英文镜像键 type/status 不入 extra）');
assert(t7.extra_json === '{}' || !JSON.parse(t7.extra_json)['客户'], '镜像键不入 extra_json');
assert((qOne(`SELECT COUNT(*) c FROM tickets WHERE "类型" != '待办'`) || {}).c === 2, '工单迁移总量正确（无重复，待办另计）');

// ② 设置携带
const settings = JSON.parse((qOne('SELECT schema_json FROM ticket_settings WHERE id = 1') || {}).schema_json || '{}');
assert((settings.terminalStatuses || []).includes('已解决'), 'ticket_settings 携带用户自定义终态（已解决）');
assert((settings.fields || []).some(f => f.name === '客户'), 'ticket_settings 携带自定义字段（客户）');

// ③ side 表重建（无 dataset_id）
for (const tbl of ['ticket_logs', 'ticket_todos', 'ticket_flow_nodes']) {
  const cols = q(`PRAGMA table_info(${tbl})`).map(c => c.name);
  assert(!cols.includes('dataset_id'), tbl + ' 已去掉 dataset_id 列');
}
assert((qOne('SELECT COUNT(*) c FROM ticket_logs WHERE record_id = 5') || {}).c === 1, 'ticket_logs 数据随重建保留');
assert((qOne('SELECT COUNT(*) c FROM ticket_flow_nodes WHERE record_id = 5') || {}).c === 1, '节点账随重建保留');

// ④ 待办并入
assert(!qOne("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_todos'"), 'plan_todos 旧表已删除');
const todoRow = qOne(`SELECT * FROM tickets WHERE "标题" = '整理提成规则清单'`);
assert(!!todoRow && todoRow['类型'] === '待办' && todoRow['状态'] === '待处理', '待办迁入 tickets（类型=待办/待处理）');
assert(todoRow['承诺时间'] === '2026-11-22 18:00', '待办纯日期 scheduled_start 补 18:00');
assert(JSON.parse(todoRow.extra_json).description === '按商品分类列一遍' || todoRow['内容'] === '按商品分类列一遍', '待办描述迁入内容');
const doneTodo = qOne(`SELECT * FROM tickets WHERE "标题" = '已完成旧待办'`);
assert(!!doneTodo && doneTodo['状态'] === '已完成', '已完成待办状态映射正确');
const link = qOne('SELECT l.todo_id FROM ticket_todos l WHERE l.record_id = 5');
assert(!!link && link.todo_id === todoRow.id, 'ticket_todos.todo_id 已重映射到新待办 id');

// ⑤ 提醒绑定改写
const rem = qOne("SELECT ticket_dataset_id, source_record_id FROM plan_reminders WHERE id = 'R1'");
assert(rem.ticket_dataset_id === 'tickets' && rem.source_record_id === '5', 'plan_reminders 绑定改写为 tickets + 原 record id');

// ⑥ 节点账回填（待办工单无节点 → 补初始节点）
const todoNode = qOne('SELECT COUNT(*) c FROM ticket_flow_nodes WHERE record_id = ?', todoRow.id);
assert((todoNode || {}).c === 1, '迁入的待办工单补了初始节点');
assert((qOne('SELECT COUNT(*) c FROM ticket_flow_nodes WHERE record_id = 7') || {}).c === 1, '工单 #7 补了初始节点');

// ⑦ 幂等：关库重开，数量不变
db.close();
{
  const legacy = new Database(DB_PATH);
  legacy.prepare(`INSERT INTO data_center_records (id, dataset_id, data_json) VALUES (99, '1', '{"标题":"迁移后混入的脏行"}')`).run();
  legacy.close();
}
db.getDb();
assert((qOne(`SELECT COUNT(*) c FROM tickets WHERE "类型" != '待办'`) || {}).c === 2, '二次打开幂等：tickets 不重复迁移');
assert(!!qOne('SELECT id FROM tickets WHERE id = 5'), '二次打开后原数据完好');

// —— 清理临时目录 ——
db.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('\n全部通过 ✅');
