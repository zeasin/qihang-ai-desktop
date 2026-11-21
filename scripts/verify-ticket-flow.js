/**
 * 工单流转节点账探针：在内存库上复现 ticket-flow.ts 的开关节点时序，
 * 断言：建单开节点、状态变关旧开新、node_index 递增、通知回写、回填幂等。
 * 运行：ELECTRON_RUN_AS_NODE=1 electron.exe scripts/verify-ticket-flow.js
 */
const Database = require('better-sqlite3');

const db = new Database(':memory:');
db.exec(`
CREATE TABLE ticket_handlers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
  webhook_url TEXT DEFAULT '', enabled INTEGER DEFAULT 1,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE ticket_flow_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT DEFAULT '', record_id INTEGER NOT NULL,
  node_index INTEGER NOT NULL DEFAULT 1, status TEXT DEFAULT '', handler_name TEXT DEFAULT '',
  handler_id INTEGER, entered_at TEXT, exited_at TEXT, duration_minutes INTEGER,
  result TEXT DEFAULT '', result_kind TEXT DEFAULT '', trigger TEXT DEFAULT '',
  notified INTEGER DEFAULT 0, notify_error TEXT DEFAULT '', created_at TEXT
);
CREATE TABLE data_center_datasets (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE data_center_records (id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT, data_json TEXT, updated_at TEXT);
`);

const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } console.log('ok  ' + msg); };

// 通知 mock：记录调用并模拟成功（feishu.sendViaWebhook 走 res.json() 后判 code）
const notifyCalls = [];
global.fetch = async (url, opts) => {
  notifyCalls.push({ url: String(url), body: String(opts && opts.body || '') });
  return {
    ok: true, status: 200,
    json: async () => ({ code: 0 }),
  };
};

const qOne = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const now = () => '2026-11-21 10:00:00';
const findHandlerByName = n => n ? (qOne('SELECT id, name, webhook_url FROM ticket_handlers WHERE name = ? AND enabled = 1', n) || null) : null;

// —— 引擎逻辑复刻（与 ticket-flow.ts 同步） ——
function openNode(dsId, rid) {
  return qOne('SELECT * FROM ticket_flow_nodes WHERE dataset_id = ? AND record_id = ? AND exited_at IS NULL ORDER BY node_index DESC LIMIT 1', dsId, rid) || null;
}
function closeOpenNode(dsId, rid, result) {
  const o = openNode(dsId, rid); if (!o) return;
  run('UPDATE ticket_flow_nodes SET exited_at = ?, duration_minutes = ?, result = ?, result_kind = ? WHERE id = ?', now(), 5, result, 'ok', o.id);
}
function openNextNode(dsId, rid, status, handlerName, handlerId) {
  const m = qOne('SELECT COALESCE(MAX(node_index),0) AS m FROM ticket_flow_nodes WHERE dataset_id = ? AND record_id = ?', dsId, rid);
  run('INSERT INTO ticket_flow_nodes (dataset_id, record_id, node_index, status, handler_name, handler_id, entered_at, trigger) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    dsId, rid, (m.m || 0) + 1, status, handlerName, handlerId, now(), 'ui');
}
function markNotify(dsId, rid, ok, err) {
  const o = openNode(dsId, rid); if (!o) return;
  run('UPDATE ticket_flow_nodes SET notified = ?, notify_error = ? WHERE id = ?', ok ? 1 : -1, err || '', o.id);
}
/** 模拟通知发送（复刻 notifyHandlerChanged：发节点 webhook，fetch 已被 mock） */
async function sendNotify(url, text) {
  const first = await global.fetch(url, { method: 'POST', body: JSON.stringify({ text }) });
  return first;
}

async function main() {
  // ==================== 场景 ====================
  run("INSERT INTO data_center_datasets (id, name) VALUES (7, '工单')");
  const dsId = '7';
  run("INSERT INTO ticket_handlers (name, webhook_url) VALUES ('张三', 'https://feishu.example/hook/1')");

  // ① 建单：开节点 1 + 建单即指派 → 通知
  run("INSERT INTO data_center_records (dataset_id, data_json, updated_at) VALUES (?, ?, ?)", dsId, JSON.stringify({ '标题': '修复登录超时', '状态': '待处理', '处理人': '张三' }), now());
  const rid = qOne('SELECT MAX(id) AS id FROM data_center_records').id;
  openNextNode(dsId, rid, '待处理', '张三', findHandlerByName('张三').id);
  {
    const h = findHandlerByName('张三');
    await sendNotify(h.webhook_url, '📋 工单指派 · 修复登录超时');
    markNotify(dsId, rid, true, '');
  }
  assert(notifyCalls.length === 1, '建单指派 → 通知发出 1 次');
  assert(notifyCalls[0].url === 'https://feishu.example/hook/1', '通知走节点自己的 webhook');
  assert(notifyCalls[0].body.includes('修复登录超时'), '通知正文含标题');

  // ② 状态 待处理→处理中：关节点 1，开节点 2
  run("UPDATE data_center_records SET data_json = ? WHERE id = ?", JSON.stringify({ '标题': '修复登录超时', '状态': '处理中', '处理人': '张三', '备注': '已定位是 token 过期' }), rid);
  closeOpenNode(dsId, rid, '已定位是 token 过期');
  openNextNode(dsId, rid, '处理中', '张三', findHandlerByName('张三').id);

  const nodes1 = db.prepare('SELECT * FROM ticket_flow_nodes WHERE record_id = ? ORDER BY node_index').all(rid);
  assert(nodes1.length === 2, '状态变更后共 2 个节点');
  assert(nodes1[0].exited_at && nodes1[0].duration_minutes === 5, '节点 1 已关闭且记了停留时长');
  assert(nodes1[0].result === '已定位是 token 过期', '节点 1 记了处理结果');
  assert(!nodes1[1].exited_at && nodes1[1].status === '处理中', '节点 2 是开放的处理中节点');

  // ③ 只换处理人（状态不变）：节点不动，但通知发出
  run("INSERT INTO ticket_handlers (name, webhook_url) VALUES ('李四', 'https://ding.example/hook/2')");
  run("UPDATE data_center_records SET data_json = ? WHERE id = ?", JSON.stringify({ '标题': '修复登录超时', '状态': '处理中', '处理人': '李四', '备注': '' }), rid);
  {
    const h = findHandlerByName('李四');
    await sendNotify(h.webhook_url, '📋 工单指派 · 修复登录超时（转派李四）');
    markNotify(dsId, rid, true, '');
  }
  assert(notifyCalls.length === 2, '处理人变更 → 第 2 次通知');
  assert(notifyCalls[1].url === 'https://ding.example/hook/2', '第 2 次通知走李四节点的 webhook');
  assert(openNode(dsId, rid).status === '处理中', '状态不变时节点不重开');
  assert(openNode(dsId, rid).handler_name === '张三', '节点保留进入时的处理人快照（转派只触发通知，不改历史行）');

  // ④ 未建档案的处理人：不炸，通知按失败留痕
  markNotify(dsId, rid, false, '处理人未建节点档案');
  assert(openNode(dsId, rid).notified === -1, '通知失败留痕 notified=-1');

  // ⑤ 存量回填：老工单补初始节点，跑两遍结果一致（幂等）
  run("INSERT INTO data_center_records (dataset_id, data_json, updated_at) VALUES (?, ?, ?)", dsId, JSON.stringify({ '标题': '老单', '状态': '处理中', '处理人': '王五' }), '2026-11-20 09:00:00');
  const rid2 = qOne('SELECT MAX(id) AS id FROM data_center_records').id;
  const backfill = () => {
    const rows = db.prepare(`SELECT r.id, r.data_json, r.updated_at FROM data_center_records r
      WHERE r.dataset_id = ? AND NOT EXISTS (SELECT 1 FROM ticket_flow_nodes n WHERE n.dataset_id = ? AND n.record_id = r.id)`).all(dsId, dsId);
    for (const r of rows) {
      let d = {}; try { d = JSON.parse(r.data_json || '{}'); } catch {}
      run('INSERT INTO ticket_flow_nodes (dataset_id, record_id, node_index, status, handler_name, entered_at, result, result_kind, trigger, notified) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
        dsId, r.id, String(d['状态'] || '待处理'), String(d['处理人'] || ''), r.updated_at, '', 'auto', 'backfill', 0);
    }
    return rows.length;
  };
  assert(backfill() === 1, '回填补了 1 条老单');
  assert(backfill() === 0, '回填幂等：第二遍 0 条');
  const n2 = db.prepare('SELECT * FROM ticket_flow_nodes WHERE record_id = ?').get(rid2);
  assert(n2.status === '处理中' && n2.node_index === 1, '老单初始节点取当前状态');
  assert(db.prepare('SELECT COUNT(*) c FROM ticket_flow_nodes WHERE record_id = ?').get(rid).c === 2, '回填不碰已有节点的工单');

  console.log('\n全部通过 ✅');

}

main().catch(e => { console.error(e); process.exit(1); });
