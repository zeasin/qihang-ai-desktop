/**
 * 只读查看真实用户库的迁移状态（不写任何数据）：
 * 用法：ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/peek-db-state.js
 */
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.qihang-ai-desktop', 'qihang-ai-desktop.db');
console.log('库文件:', DB_PATH);
const db = new Database(DB_PATH, { readonly: true });
const q = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return [{ error: e.message }]; } };
const q1 = (sql, ...p) => q(sql, ...p)[0] || {};

const tables = q("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
console.log('表清单:', tables.join(', '));

if (tables.includes('tickets')) {
  const total = (q1('SELECT COUNT(*) c FROM tickets') || {}).c || 0;
  const byType = q(`SELECT "类型" t, COUNT(*) c FROM tickets GROUP BY "类型"`).map(r => r.t + ':' + r.c).join(', ');
  console.log(`tickets: 已存在，共 ${total} 条（${byType || '空'}）`);
  const hasProj = q('PRAGMA table_info(tickets)').map(c => c.name).includes('项目');
  console.log('tickets.项目 列:', hasProj ? '已有' : '无（补列迁移待跑）');
  const settings = tables.includes('ticket_settings') ? (q1('SELECT schema_json FROM ticket_settings WHERE id = 1') || {}).schema_json : null;
  console.log('ticket_settings:', settings ? '已有（' + settings.length + ' 字节）' : '无');
} else {
  console.log('tickets: 尚未创建（新版本还没启动过）');
}
for (const t of ['data_center_records', 'data_center_datasets', 'data_center_modules']) {
  if (!tables.includes(t)) { console.log(t + ': 不存在'); continue; }
  const c = (q1(`SELECT COUNT(*) c FROM ${t}`) || {}).c || 0;
  console.log(`${t}: ${c} 行`);
  if (t === 'data_center_datasets') {
    const rows = q('SELECT id, name FROM data_center_datasets');
    console.log('  数据集:', rows.map(r => `${r.name}(id=${r.id})`).join(', ') || '（空）');
  }
}
console.log('plan_todos:', tables.includes('plan_todos') ? '仍存在（待办迁移待跑）' : '已删除（待办已并入）');
db.close();
