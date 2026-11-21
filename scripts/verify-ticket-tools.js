/**
 * 工单对话工具探针：拦截 require 注入内存库，驱动 dist-electron 编译产物里的
 * 真实工具代码（tools.js 的 create/query/update_ticket + ticket-flow.js 钩子链 +
 * dataset-normalize.js 归一化），断言 AI/飞书建单的完整链路：
 *   建单 → 落库+首节点+指派通知 → 状态流转关旧开新 → 处理人未匹配走兜底 → 查询过滤。
 * 运行：npm run compile:electron && node scripts/verify-ticket-tools.js
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

// —— 内存库：复刻 database.ts 里工具链路用到的 ds 子集 + 钩子链 ——
const sqlite = new Database(':memory:');
sqlite.exec(`
CREATE TABLE data_center_datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT, name TEXT,
  description TEXT DEFAULT '', type TEXT DEFAULT '', status TEXT DEFAULT '',
  schema_json TEXT DEFAULT '{}', module_id TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE data_center_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT, data_json TEXT,
  record_type TEXT, record_status TEXT, source TEXT,
  created_at TEXT DEFAULT (datetime('now','+8 hours')), updated_at TEXT
);
CREATE TABLE ticket_handlers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
  webhook_url TEXT DEFAULT '', enabled INTEGER DEFAULT 1,
  remark TEXT DEFAULT '', created_at TEXT, updated_at TEXT
);
CREATE TABLE ticket_flow_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT DEFAULT '', record_id INTEGER NOT NULL,
  node_index INTEGER NOT NULL DEFAULT 1, status TEXT DEFAULT '', handler_name TEXT DEFAULT '',
  handler_id INTEGER, entered_at TEXT, exited_at TEXT, duration_minutes INTEGER,
  result TEXT DEFAULT '', result_kind TEXT DEFAULT '', trigger TEXT DEFAULT '',
  notified INTEGER DEFAULT 0, notify_error TEXT DEFAULT '', created_at TEXT
);
`);

// 通知 mock：feishu.sendViaWebhook 记录调用并模拟成功（不真发请求）
const notifyCalls = [];

const recordKey = (id) => String(id == null ? '' : id).trim();
const mirror = (d) => {
  const pick = (k) => { const s = d[k] == null ? '' : String(d[k]).trim(); return s || null; };
  return { record_type: pick('类型') || pick('type'), record_status: pick('状态') || pick('status'), source: pick('来源') || pick('source') };
};
const hooks = [];
const fakeDb = {
  q: (sql, ...p) => sqlite.prepare(sql).all(...p),
  qOne: (sql, ...p) => sqlite.prepare(sql).get(...p),
  run: (sql, ...p) => sqlite.prepare(sql).run(...p),
  onRecordSave: (fn) => hooks.push(fn),
  ds: {
    list: () => sqlite.prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM data_center_records WHERE dataset_id = CAST(d.id AS TEXT)) AS record_count
       FROM data_center_datasets d ORDER BY d.created_at DESC`
    ).all().map(r => ({ ...r, recordCount: r.record_count, schema: r.schema_json ? JSON.parse(r.schema_json) : null })),
    get: (id) => {
      const k = recordKey(id);
      const r = sqlite.prepare('SELECT * FROM data_center_datasets WHERE CAST(id AS TEXT) = ? OR dataset_id = ?').get(k, k);
      return r ? { ...r, schema: r.schema_json ? JSON.parse(r.schema_json) : null } : null;
    },
    add: (params) => {
      const dsKey = params.dataset_id || 'ds_' + Date.now();
      sqlite.prepare('INSERT INTO data_center_datasets (dataset_id, name, description, schema_json) VALUES (?, ?, ?, ?)')
        .run(dsKey, params.name, params.description || '', params.schemaJson || '{}');
      const row = sqlite.prepare('SELECT id FROM data_center_datasets WHERE dataset_id = ? ORDER BY id DESC LIMIT 1').get(dsKey);
      return { id: row.id, dataset_id: dsKey };
    },
    insert: (datasetId, dataObj) => {
      const key = recordKey(datasetId);
      const m = mirror(dataObj);
      sqlite.prepare('INSERT INTO data_center_records (dataset_id, data_json, record_type, record_status, source) VALUES (?, ?, ?, ?, ?)')
        .run(key, JSON.stringify(dataObj), m.record_type, m.record_status, m.source);
      const rec = sqlite.prepare('SELECT id FROM data_center_records WHERE dataset_id = ? ORDER BY id DESC LIMIT 1').get(key);
      for (const h of hooks) { try { h('insert', key, rec.id, dataObj); } catch (e) { console.error('hook error: ' + e.message); } }
      return rec.id;
    },
    updateRecord: (id, dataObj) => {
      const prevRow = sqlite.prepare('SELECT data_json, dataset_id FROM data_center_records WHERE id = ?').get(id);
      let prev = null; try { prev = prevRow ? JSON.parse(prevRow.data_json || '{}') : null; } catch {}
      const m = mirror(dataObj);
      sqlite.prepare('UPDATE data_center_records SET data_json = ?, record_type = ?, record_status = ?, source = ? WHERE id = ?')
        .run(JSON.stringify(dataObj), m.record_type, m.record_status, m.source, id);
      for (const h of hooks) { try { h('update', prevRow ? String(prevRow.dataset_id) : '', id, dataObj, prev); } catch (e) { console.error('hook error: ' + e.message); } }
    },
    listRecords: (datasetId, opts = {}) => {
      const key = recordKey(datasetId);
      let sql = 'SELECT * FROM data_center_records WHERE dataset_id = ?';
      const p = [key];
      if (opts.search) { sql += ' AND data_json LIKE ?'; p.push('%' + opts.search + '%'); }
      sql += ' ORDER BY created_at DESC LIMIT ?'; p.push(Math.max(1, Math.min(200, opts.limit || 100)));
      const rows = sqlite.prepare(sql).all(...p).map(r => ({ id: r.id, ...JSON.parse(r.data_json || '{}'), _created_at: r.created_at }));
      const total = sqlite.prepare('SELECT COUNT(*) AS c FROM data_center_records WHERE dataset_id = ?').get(key).c;
      return { rows, total };
    },
    onRecordSave: (fn) => hooks.push(fn),
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
    };
    if (request === './app-config') return { getConfig: () => '' };   // 全局兜底 webhook 置空，验证「未配置不炸」
    if (request === './agent-radar') return { agentRadar: { listSessions: () => ({ rows: [] }) } };
    if (request === './project-scan') return { collectPerProject: () => [], collectStats: () => ({}) };
    if (request === './search') return { webSearch: async () => '', fetchPage: async () => '', getSearchConfig: () => ({}) };
  }
  return origLoad.apply(this, arguments);
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const tools = require(path.join(DIST, 'tools.js'));
  const ticketFlow = require(path.join(DIST, 'ticket-flow.js'));

  // 0) 工具注册面：三件套进了共用工具集（飞书/定时任务/日报通道）
  const reportNames = (await tools.buildReportToolDefs(undefined)).map(d => d.name);
  assert(reportNames.includes('create_ticket') && reportNames.includes('query_tickets') && reportNames.includes('update_ticket'),
    'buildReportToolDefs 含工单三件套（飞书/定时任务/日报通道共用）');
  const ticketNames = (await tools.buildTicketToolDefs()).map(d => d.name);
  assert(ticketNames.length === 3, 'buildTicketToolDefs 独立暴露（桌面对话通道注入）');

  // 1) 建单工具：数据集还没建过 → 兜底创建
  ticketFlow.registerTicketFlow();
  const dsId = ticketFlow.ensureTicketDataset();
  assert(!!dsId, 'ensureTicketDataset 兜底创建「工单」数据集');
  const dsRow = fakeDb.ds.get(dsId);
  assert(dsRow && JSON.parse(dsRow.schema_json).fields.length === 10, '兜底 schema 含 10 个核心字段');
  assert(ticketFlow.ensureTicketDataset() === dsId, 'ensureTicketDataset 幂等复用');

  // 预置处理人节点（老齐，配了 webhook）
  sqlite.prepare("INSERT INTO ticket_handlers (name, webhook_url, enabled) VALUES ('老齐', 'https://feishu.example/hook/laoqi', 1)").run();

  const defs = await tools.buildTicketToolDefs();
  const call = async (name, params) => {
    const def = defs.find(d => d.name === name);
    const res = await def.execute('probe', params);
    return res.content[0].text;
  };

  // 2) create_ticket：用户给的测试用例
  const created = await call('create_ticket', {
    title: '金箔雲需求-按月统计销售员提成',
    content: '按月统计销售员提成，提成比例按商品分类设置',
    handler: '老齐', type: '需求', promise_time: '2026-12-01', creator: '飞书-测试',
  });
  assert(/已创建工单 #\d+/.test(created), 'create_ticket 返回工单 id');
  assert(/承诺时间：2026-12-01 18:00/.test(created), '纯日期承诺时间补齐为 YYYY-MM-DD 18:00');
  assert(/已按处理人触发飞书指派通知/.test(created), '处理人匹配节点档案 → 提示定向通知');

  const rec = sqlite.prepare("SELECT * FROM data_center_records WHERE data_json LIKE '%金箔雲%'").get();
  assert(!!rec, '工单记录已落库');
  const data = JSON.parse(rec.data_json);
  assert(data['标题'] === '金箔雲需求-按月统计销售员提成' && data['状态'] === '待处理', '落库字段：标题/初始状态待处理');
  assert(data['承诺时间'] === '2026-12-01 18:00' && data['处理人'] === '老齐', '落库字段：承诺时间/处理人');

  await sleep(120);   // 指派通知是异步的，留出发送窗口
  let nodes = fakeDb.q('SELECT * FROM ticket_flow_nodes WHERE record_id = ? ORDER BY node_index', rec.id);
  assert(nodes.length === 1 && nodes[0].status === '待处理' && nodes[0].handler_name === '老齐' && nodes[0].trigger === 'insert',
    '建单即开首节点（待处理/老齐/trigger=insert）');
  assert(notifyCalls.length === 1 && notifyCalls[0].url === 'https://feishu.example/hook/laoqi' && notifyCalls[0].body.includes('金箔雲'),
    '指派通知发到老齐节点的 webhook，文案带标题');
  assert(nodes[0].notified === 1, '节点账回写 notified=1');

  // 3) update_ticket：状态流转 → 关旧节点 + 开新节点；处理人没变 → 不重复通知
  const updated = await call('update_ticket', { id: rec.id, status: '处理中', remark: '方案评审通过' });
  assert(/状态 → 处理中/.test(updated), 'update_ticket 改状态');
  nodes = fakeDb.q('SELECT * FROM ticket_flow_nodes WHERE record_id = ? ORDER BY node_index', rec.id);
  assert(nodes.length === 2 && nodes[0].exited_at && nodes[0].result.includes('方案评审通过'), '旧节点关闭并写入处理结果');
  assert(!nodes[1].exited_at && nodes[1].status === '处理中', '新节点（处理中）开放');
  assert(notifyCalls.length === 1, '只改状态不改处理人 → 不触发通知（v3 口径）');
  const closed = JSON.parse(sqlite.prepare('SELECT data_json FROM data_center_records WHERE id = ?').get(rec.id).data_json);
  assert(closed['备注'].includes('方案评审通过'), '备注追加写入（处理结果留痕）');

  // 4) 只换处理人 → 不开新节点（状态没变），通知未匹配节点 → 走全局兜底（未配置 → 不炸）
  await call('update_ticket', { id: rec.id, handler: '老王' });
  nodes = fakeDb.q('SELECT * FROM ticket_flow_nodes WHERE record_id = ? ORDER BY node_index', rec.id);
  assert(nodes.length === 2, '只改处理人不开新节点');
  assert(notifyCalls.length === 1, '处理人未匹配节点档案且全局 webhook 未配置 → 不发（不炸）');
  const open = nodes.find(n => !n.exited_at);
  assert(open && open.notified === -1 && open.notify_error.includes('处理人未建节点档案'),
    '开放节点留痕 notified=-1（通知失败原因已记）');
  assert(open && open.handler_name === '老王', '新节点账记了新处理人名字');

  // 5) query_tickets：关键词/状态过滤
  const listed = await call('query_tickets', { keyword: '金箔雲' });
  assert(listed.includes('#' + rec.id) && listed.includes('处理中'), 'query_tickets 关键词命中');
  const byStatus = await call('query_tickets', { status: '处理中' });
  assert(byStatus.includes('金箔雲'), 'query_tickets 状态过滤命中');
  const empty = await call('query_tickets', { status: '已完成' });
  assert(empty.includes('没有匹配'), 'query_tickets 无命中时给总数提示');

  // 6) 非法状态 → 枚举校验拦截
  const bad = await call('create_ticket', { title: 'x', status: '不存在的状态' });
  assert(bad.includes('不在工单状态枚举'), 'create_ticket 状态枚举校验');
  const badUpd = await call('update_ticket', { id: rec.id, status: '不存在的状态' });
  assert(badUpd.includes('不在工单状态枚举'), 'update_ticket 状态枚举校验');
  const noId = await call('update_ticket', { id: 99999, status: '已完成' });
  assert(noId.includes('不存在'), 'update_ticket 指向不存在的工单 → 引导先查询');

  console.log('\n全部通过 ✅');
})().catch(e => { console.error('PROBE ERROR: ' + (e && e.stack || e)); process.exit(1); });
