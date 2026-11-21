/**
 * 工单对话工具探针（tickets 专表版）：拦截 require 注入内存库，驱动 dist-electron 编译产物里的
 * 真实代码（tools.js 三件套 + tickets.js 服务 + ticket-link/tracker/flow 钩子链），断言
 * AI/飞书建单的完整链路：
 *   建单 → 落库+节点账+处理人指派通知+承诺时间提醒 → 状态流转关旧开新 →
 *   处理人未匹配走兜底 → 关联待办（待办=待办工单）终态联动 → 查询过滤。
 * 运行：npm run compile:electron && ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/verify-ticket-tools.js
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DIST = path.join(__dirname, '..', 'dist-electron', 'electron', 'services');
if (!fs.existsSync(path.join(DIST, 'tools.js'))) {
  console.error('缺少编译产物，请先运行 npm run compile:electron');
  process.exit(2);
}

const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } console.log('ok  ' + msg); };

// —— 内存库：新架构的表（tickets/ticket_settings/side 表/handlers/reminders） ——
const sqlite = new Database(':memory:');
sqlite.exec(`
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  "标题" TEXT DEFAULT '', "类型" TEXT DEFAULT '', "来源" TEXT DEFAULT '', "项目" TEXT DEFAULT '',
  "新建人" TEXT DEFAULT '', "处理人" TEXT DEFAULT '', "内容" TEXT DEFAULT '', "备注" TEXT DEFAULT '',
  "状态" TEXT DEFAULT '待处理',
  "承诺时间" TEXT DEFAULT '', "处理时间" TEXT DEFAULT '', "完结时间" TEXT DEFAULT '',
  extra_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now','+8 hours')), updated_at TEXT
);
CREATE TABLE ticket_settings (id INTEGER PRIMARY KEY CHECK (id = 1), schema_json TEXT DEFAULT '{}', updated_at TEXT);
CREATE TABLE ticket_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, record_id INTEGER, action TEXT DEFAULT '',
  field TEXT DEFAULT '', from_value TEXT DEFAULT '', to_value TEXT DEFAULT '', note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE ticket_todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, record_id INTEGER, todo_id INTEGER,
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE ticket_flow_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, record_id INTEGER NOT NULL, node_index INTEGER NOT NULL DEFAULT 1,
  status TEXT DEFAULT '', handler_name TEXT DEFAULT '', handler_id INTEGER,
  entered_at TEXT DEFAULT (datetime('now','+8 hours')), exited_at TEXT, duration_minutes INTEGER,
  result TEXT DEFAULT '', result_kind TEXT DEFAULT '', trigger TEXT DEFAULT '',
  notified INTEGER DEFAULT 0, notify_error TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE ticket_handlers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
  webhook_url TEXT DEFAULT '', enabled INTEGER DEFAULT 1, remark TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT
);
CREATE TABLE plan_reminders (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, message TEXT DEFAULT '', type TEXT NOT NULL,
  time TEXT DEFAULT '09:00', date TEXT DEFAULT '', day_of_week INTEGER DEFAULT 0, day_of_month INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1, ticket_dataset_id TEXT DEFAULT '', source_record_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','+8 hours')), updated_at TEXT
);
`);

// 通知 mock：feishu.sendViaWebhook 记录调用并模拟成功（不真发请求）
const notifyCalls = [];

const fakeDb = {
  q: (sql, ...p) => sqlite.prepare(sql).all(...p),
  qOne: (sql, ...p) => sqlite.prepare(sql).get(...p),
  run: (sql, ...p) => { sqlite.prepare(sql).run(...p); },
  runInsertId: (sql, ...p) => Number(sqlite.prepare(sql).run(...p).lastInsertRowid),
  reminder: {
    add: (data) => {
      const id = data.id || 'R' + Date.now() + Math.floor(Math.random() * 1000);
      sqlite.prepare(`INSERT INTO plan_reminders (id, name, message, type, time, date, enabled, ticket_dataset_id, source_record_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, data.name || '', data.message || '', data.type || 'daily', data.time || '09:00', data.date || '',
             data.enabled ? 1 : 0, data.ticket_dataset_id || '', data.source_record_id || '');
      return { id };
    },
    get: (id) => sqlite.prepare('SELECT * FROM plan_reminders WHERE id = ?').get(id),
    update: (id, data) => {
      const fields = []; const p = [];
      for (const k of ['name', 'message', 'type', 'time', 'date']) if (data[k] !== undefined) { fields.push(`${k} = ?`); p.push(data[k]); }
      if (data.ticket_dataset_id !== undefined) { fields.push('ticket_dataset_id = ?'); p.push(data.ticket_dataset_id); }
      if (data.source_record_id !== undefined) { fields.push('source_record_id = ?'); p.push(data.source_record_id); }
      if (fields.length) sqlite.prepare(`UPDATE plan_reminders SET ${fields.join(', ')} WHERE id = ?`).run(...p, id);
    },
    setEnabled: (id, enabled) => sqlite.prepare('UPDATE plan_reminders SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id),
  },
};

// —— require 拦截：dist-electron 模块里的相对依赖换成内存实现 ——
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && parent.filename.startsWith(DIST)) {
    if (request === './database') return fakeDb;
    if (request === './logger') return { info: () => {}, warn: () => {}, error: () => {} };
    if (request === './feishu') return {
      sendViaWebhook: async (url, text) => { notifyCalls.push({ url: String(url), body: String(text || '') }); return { ok: true }; },
      getWebhook: () => '',
    };
    if (request === './app-config') return { getConfig: () => '' };   // 全局兜底 webhook 置空，验证「未配置不炸」
    if (request === './scheduler') return { addReminder: () => {}, removeReminder: () => {}, reloadTasks: () => {}, reload: () => {}, executeTaskNow: () => {} };
    if (request === 'node-cron') return { schedule: () => ({}), validate: () => true };
    if (request === './agent-radar') return { agentRadar: { listSessions: () => ({ rows: [] }) } };
    if (request === './project-scan') return { collectPerProject: () => [], collectStats: () => ({}) };
    if (request === './search') return { webSearch: async () => '', fetchPage: async () => '', getSearchConfig: () => ({}) };
  }
  return origLoad.apply(this, arguments);
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const tools = require(path.join(DIST, 'tools.js'));
  const ticketStore = require(path.join(DIST, 'tickets.js'));
  const ticketFlow = require(path.join(DIST, 'ticket-flow.js'));
  const tracker = require(path.join(DIST, 'ticket-tracker.js'));
  const ticketLink = require(path.join(DIST, 'ticket-link.js'));

  // 0) 注册钩子链（link → tracker → flow），与 main.ts 启动顺序一致
  ticketLink.registerTicketLink();
  tracker.registerTicketTracker();
  ticketFlow.registerTicketFlow();

  // 1) 设置 bootstrap + 工具注册面
  const settings = ticketStore.getSettings();
  assert((settings.typeOptions || []).includes('待办'), 'settings bootstrap 默认枚举含 待办（待办并入工单）');
  const reportNames = (await tools.buildReportToolDefs(undefined)).map(d => d.name);
  assert(reportNames.includes('create_ticket') && reportNames.includes('query_tickets') && reportNames.includes('update_ticket'),
    'buildReportToolDefs 含工单三件套（飞书/定时任务/日报通道共用）');

  // 预置处理人节点（老齐，配了 webhook）
  sqlite.prepare("INSERT INTO ticket_handlers (name, webhook_url, enabled) VALUES ('老齐', 'https://feishu.example/hook/laoqi', 1)").run();

  const defs = await tools.buildTicketToolDefs();
  const call = async (name, params) => {
    const def = defs.find(d => d.name === name);
    const res = await def.execute('probe', params);
    return res.content[0].text;
  };

  // 2) create_ticket：用户给的测试用例（承诺时间远期 → 只有节点+通知，不建提醒）
  const created = await call('create_ticket', {
    title: '金箔雲需求-按月统计销售员提成',
    content: '按月统计销售员提成，提成比例按商品分类设置',
    handler: '老齐', type: '需求', project: '金箔雲', promise_time: '2026-12-01', creator: '飞书-测试',
  });
  assert(/已创建工单 #\d+/.test(created), 'create_ticket 返回工单 id');
  assert(/承诺时间：2026-12-01 18:00/.test(created), '纯日期承诺时间补齐为 YYYY-MM-DD 18:00');
  assert(/已按处理人触发飞书指派通知/.test(created), '处理人匹配节点档案 → 提示定向通知');

  const rec = fakeDb.qOne(`SELECT * FROM tickets WHERE "标题" = '金箔雲需求-按月统计销售员提成'`);
  assert(!!rec && rec['状态'] === '待处理' && rec['处理人'] === '老齐', '工单落库（专表列 + 初始状态待处理）');
  assert(rec['项目'] === '金箔雲', '项目字段落库（固定列）');
  assert((fakeDb.qOne('SELECT COUNT(*) c FROM ticket_logs WHERE record_id = ? AND action = ?', rec.id, 'create') || {}).c === 1,
    'tracker 留痕：create 流水');
  await sleep(120);
  let nodes = fakeDb.q('SELECT * FROM ticket_flow_nodes WHERE record_id = ? ORDER BY node_index', rec.id);
  assert(nodes.length === 1 && nodes[0].status === '待处理' && nodes[0].handler_name === '老齐', '建单即开首节点（待处理/老齐）');
  assert(notifyCalls.length === 1 && notifyCalls[0].url === 'https://feishu.example/hook/laoqi' && notifyCalls[0].body.includes('金箔雲'),
    '指派通知发到老齐节点的 webhook，文案带标题');
  assert(nodes[0].notified === 1, '节点账回写 notified=1');

  // 3) 24h 内承诺 → link 钩子当场建一次性提醒（绑定 tickets + record id）
  const soon = new Date(Date.now() + 8 * 3600 * 1000 + 3 * 3600 * 1000);
  const soonStr = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')} 09:30`;
  const id2 = ticketStore.create({ '标题': '今天要回访客户', '承诺时间': soonStr });
  const rem = fakeDb.qOne("SELECT * FROM plan_reminders WHERE source_record_id = ? AND type = 'once'", String(id2));
  assert(!!rem && rem.ticket_dataset_id === 'tickets' && rem.enabled === 1, '24h 内承诺 → 承诺时间提醒当场建立（绑定 tickets）');
  assert(/\[工单\]/.test(rem.name), '提醒名带 [工单] 前缀');

  // 4) update_ticket：状态流转 → 关旧节点 + 开新节点；处理人没变 → 不重复通知
  const updated = await call('update_ticket', { id: rec.id, status: '处理中', remark: '方案评审通过' });
  assert(/状态 → 处理中/.test(updated), 'update_ticket 改状态');
  nodes = fakeDb.q('SELECT * FROM ticket_flow_nodes WHERE record_id = ? ORDER BY node_index', rec.id);
  assert(nodes.length === 2 && nodes[0].exited_at && nodes[0].result.includes('方案评审通过'), '旧节点关闭并写入处理结果');
  assert(!nodes[1].exited_at && nodes[1].status === '处理中', '新节点（处理中）开放');
  assert(notifyCalls.length === 1, '只改状态不改处理人 → 不触发通知（v3 口径）');
  const closed = fakeDb.qOne(`SELECT "备注" FROM tickets WHERE id = ?`, rec.id);
  assert(closed['备注'].includes('方案评审通过'), '备注追加写入（处理结果留痕）');

  // 5) 只换处理人 → 节点就地换人；通知未匹配节点 → 走全局兜底（未配置 → 不炸）
  await call('update_ticket', { id: rec.id, handler: '老王' });
  nodes = fakeDb.q('SELECT * FROM ticket_flow_nodes WHERE record_id = ? ORDER BY node_index', rec.id);
  const open = nodes.find(n => !n.exited_at);
  assert(nodes.length === 2 && open.handler_name === '老王', '同状态换手：开放节点就地更新处理人');
  assert(open.notified === -1 && open.notify_error.includes('处理人未建节点档案'), '未匹配节点且无兜底 → notified=-1 留痕不炸');

  // 6) 工单拆待办（待办=待办工单）+ 关联
  const created2 = tracker.createTodoForTicket(rec.id, { title: '整理提成规则清单', scheduled_start: '2026-11-25' });
  assert(!!created2 && created2.id > 0, 'createTodoForTicket 创建待办工单');
  const todoRow = ticketStore.get(created2.id);
  assert(todoRow['类型'] === '待办' && todoRow['状态'] === '待处理', '待办工单：类型=待办/状态=待处理');
  let linked = tracker.listLinkedTodos(rec.id);
  assert(linked.length === 1 && linked[0].title === '整理提成规则清单' && linked[0].status === 'pending', 'listLinkedTodos 返回关联待办（pending）');

  // 7) 勾选待办 → 待办工单状态流转
  tracker.toggleLinkedTodo(created2.id, true);
  linked = tracker.listLinkedTodos(rec.id);
  assert(linked[0].status === 'done', '勾选待办 → 状态映射为 done（已完成）');

  // 8) 工单进终态 → 关联待办自动收尾（tracker 终态联动）
  await call('update_ticket', { id: rec.id, status: '已完成' });
  const afterClose = ticketStore.get(created2.id);
  assert(afterClose['状态'] === '已完成', '主工单进终态 → 关联待办自动已完成');
  nodes = fakeDb.q('SELECT * FROM ticket_flow_nodes WHERE record_id = ? ORDER BY node_index', rec.id);
  assert(nodes.length === 3 && !nodes[2].exited_at && nodes[2].status === '已完成', '终态节点开放（账本完整）');
  const finalRow = ticketStore.get(rec.id);
  assert(finalRow['完结时间'] !== '', '进终态自动盖完结时间（服务层盖章）');

  // 9) query_tickets：关键词/状态/项目过滤
  const listed = await call('query_tickets', { keyword: '金箔雲' });
  assert(listed.includes('#' + rec.id) && listed.includes('已完成'), 'query_tickets 关键词命中');
  const byStatus = await call('query_tickets', { status: '待处理' });
  assert(byStatus.includes('今天要回访客户'), 'query_tickets 状态过滤命中');
  const byProject = await call('query_tickets', { project: '金箔雲' });
  assert(byProject.includes('#' + rec.id), 'query_tickets 项目过滤命中');
  const empty = await call('query_tickets', { status: '已关闭' });
  assert(empty.includes('没有匹配'), 'query_tickets 无命中时给总数提示');

  // 10) 非法状态 → 枚举校验拦截
  const bad = await call('create_ticket', { title: 'x', status: '不存在的状态' });
  assert(bad.includes('不在工单状态枚举'), 'create_ticket 状态枚举校验');
  const badUpd = await call('update_ticket', { id: rec.id, status: '不存在的状态' });
  assert(badUpd.includes('不在工单状态枚举'), 'update_ticket 状态枚举校验');
  const noId = await call('update_ticket', { id: 99999, status: '已完成' });
  assert(noId.includes('不存在'), 'update_ticket 指向不存在的工单 → 引导先查询');

  console.log('\n全部通过 ✅');
})().catch(e => { console.error('PROBE ERROR: ' + (e && e.stack || e)); process.exit(1); });
