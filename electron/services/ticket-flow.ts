/**
 * 工单流转引擎（ticket-flow）
 *
 * 挂在 tickets.onSave 钩子链上（link → tracker → flow），
 * 因此页面 / AI / 飞书所有写入路径都覆盖。
 *
 * 两件事（docs/工单流转设计方案.md v3）：
 *
 *   1. 节点账（ticket_flow_nodes）：状态变更 A→B 时关闭上一节点（写停留时长+处理结果）
 *      并开启新节点。工单的完整生命周期=这张表的有序行，可回放可审计。
 *
 *   2. 通知：挂在「处理人变更」上，不是「状态变更」——工单「处理人」字段填了/改了谁，
 *      匹配到处理人节点表（ticket_handlers）且有 webhook_url，就通知到该节点的 webhook。
 *      「状态变到处理中」不通知，「这单交给你了」才值得喊。
 *
 * 刻意不做：状态→默认处理人的规则表（v1/v2 曾想加，用户拍板砍掉——
 * 单人/小协作想不出「哪个状态固定归谁」，规则表会沦为摆设）。
 *
 * 2026-11-21 存储专表化：record_id 直接指 tickets.id，dataset_id 层级删除。
 */
import * as db from './database';
import * as tickets from './tickets';
import logger from './logger';
import * as feishu from './feishu';
import * as appConfig from './app-config';

/** 本地时间串（与库内 datetime('now','+8 hours') 同口径） */
function nowLocal(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ==================== 处理人节点 CRUD ====================

export function listHandlers(): any[] {
  try { return db.q('SELECT * FROM ticket_handlers ORDER BY id DESC'); }
  catch (e) { logger.warn('[TicketFlow] 读处理人节点失败: ' + (e && e.message)); return []; }
}

export function addHandler(data: { name: string; webhook_url?: string; remark?: string }): any {
  const name = String(data.name || '').trim();
  if (!name) return { ok: false, error: '节点名不能为空' };
  const exists = db.qOne('SELECT id FROM ticket_handlers WHERE name = ?', name);
  if (exists) return { ok: false, error: '同名节点已存在' };
  db.run('INSERT INTO ticket_handlers (name, webhook_url, remark) VALUES (?, ?, ?)',
    name, String(data.webhook_url || ''), String(data.remark || ''));
  const row = db.qOne('SELECT id FROM ticket_handlers WHERE name = ?', name);
  return { ok: true, id: row && row.id };
}

export function updateHandler(id: number, data: { name?: string; webhook_url?: string; remark?: string; enabled?: boolean }): boolean {
  const fields: string[] = []; const params: any[] = [];
  if (data.name !== undefined) { fields.push('name = ?'); params.push(String(data.name).trim()); }
  if (data.webhook_url !== undefined) { fields.push('webhook_url = ?'); params.push(String(data.webhook_url)); }
  if (data.remark !== undefined) { fields.push('remark = ?'); params.push(String(data.remark)); }
  if (data.enabled !== undefined) { fields.push('enabled = ?'); params.push(data.enabled ? 1 : 0); }
  if (!fields.length) return false;
  fields.push("updated_at = datetime('now', '+8 hours')"); params.push(id);
  db.run(`UPDATE ticket_handlers SET ${fields.join(', ')} WHERE id = ?`, ...params);
  return true;
}

export function removeHandler(id: number): boolean {
  // 只删档案：历史节点靠 handler_name 冗余不受影响
  db.run('DELETE FROM ticket_handlers WHERE id = ?', id);
  return true;
}

/** 按名字查处理人节点（启用中的；名字即节点名） */
function findHandlerByName(name: string): any | null {
  const n = String(name || '').trim();
  if (!n) return null;
  return db.qOne('SELECT id, name, webhook_url, enabled FROM ticket_handlers WHERE name = ? AND enabled = 1', n) || null;
}

// ==================== 流转节点账 ====================

/** 某工单的节点时间轴（按 node_index 正序） */
export function listFlowNodes(recordId: number): any[] {
  try {
    return db.q(
      'SELECT * FROM ticket_flow_nodes WHERE record_id = ? ORDER BY node_index ASC LIMIT 200',
      recordId
    );
  } catch (e) { logger.warn('[TicketFlow] 读流转节点失败: ' + (e && e.message)); return []; }
}

/** 当前开放节点（exited_at IS NULL 的最新一条） */
function openNode(recordId: number): any | null {
  return db.qOne(
    'SELECT * FROM ticket_flow_nodes WHERE record_id = ? AND exited_at IS NULL ORDER BY node_index DESC LIMIT 1',
    recordId
  ) || null;
}

/** 关闭当前开放节点：写 exited_at + duration_minutes + result */
function closeOpenNode(recordId: number, opts: { result?: string; resultKind?: string }): void {
  const open = openNode(recordId);
  if (!open) return;
  const now = nowLocal();
  let minutes = 0;
  try {
    const start = Date.parse(String(open.entered_at || '').replace(' ', 'T'));
    if (!isNaN(start)) minutes = Math.max(0, Math.round((Date.now() - start) / 60000));
  } catch {}
  db.run(
    "UPDATE ticket_flow_nodes SET exited_at = ?, duration_minutes = ?, result = ?, result_kind = ? WHERE id = ?",
    now, minutes, String(opts.result || ''), String(opts.resultKind || 'ok'), open.id
  );
}

/** 开启新节点：node_index 按该工单已有最大值 +1 */
function openNextNode(recordId: number, data: { status: string; handlerName: string; handlerId: number | null; trigger: string }): void {
  const maxRow = db.qOne<{ m: number }>(
    'SELECT COALESCE(MAX(node_index), 0) AS m FROM ticket_flow_nodes WHERE record_id = ?',
    recordId
  );
  const nextIndex = ((maxRow && maxRow.m) || 0) + 1;
  db.run(
    `INSERT INTO ticket_flow_nodes (record_id, node_index, status, handler_name, handler_id, entered_at, trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    recordId, nextIndex,
    String(data.status || ''), String(data.handlerName || ''),
    data.handlerId == null ? null : data.handlerId,
    nowLocal(), String(data.trigger || 'ui')
  );
}

/** 回写当前开放节点的通知结果 */
function markNotify(recordId: number, ok: boolean, error: string): void {
  const open = openNode(recordId);
  if (!open) return;
  db.run('UPDATE ticket_flow_nodes SET notified = ?, notify_error = ? WHERE id = ?', ok ? 1 : -1, String(error || ''), open.id);
}

// ==================== 通知 ====================

/** 处理人变更通知：发到该节点的 webhook；配不上则降级全局兜底 webhook */
async function notifyHandlerChanged(opts: { title: string; fromStatus: string; toStatus: string; handlerName: string; result: string; promise: string }): Promise<{ ok: boolean; error?: string }> {
  const handler = findHandlerByName(opts.handlerName);
  const url = handler && handler.webhook_url ? String(handler.webhook_url) : String(appConfig.getConfig('feishuWebhookUrl') || '');
  if (!url) return { ok: false, error: handler ? '节点未配置 webhook' : '处理人未建节点档案' };
  const lines = [
    '📋 工单指派 · ' + (opts.title || '(无标题)'),
    opts.fromStatus !== opts.toStatus ? `状态：${opts.fromStatus || '（空）'} → ${opts.toStatus || '（空）'}` : `状态：${opts.toStatus || '（空）'}`,
    '处理人：' + (opts.handlerName || '（空）'),
  ];
  if (opts.result) lines.push('结果：' + opts.result);
  if (opts.promise) lines.push('承诺：' + opts.promise);
  lines.push('—— 来自 启航AI工作台');
  const text = lines.join('\n');
  // 重试一次：webhook 网络抖动常见，第二次还失败就留痕
  const first = await feishu.sendViaWebhook(url, text);
  if (first && first.ok) return { ok: true };
  const second = await feishu.sendViaWebhook(url, text);
  if (second && second.ok) return { ok: true };
  return { ok: false, error: String((second && second.error) || (first && first.error) || '发送失败') };
}

/** 60 秒防抖：同键只发一次（同单同目标状态 / 同单同处理人） */
const dedupMap = new Map<string, number>();
function dedupOk(key: string): boolean {
  const last = dedupMap.get(key) || 0;
  const now = Date.now();
  if (now - last < 60 * 1000) return false;
  dedupMap.set(key, now);
  // 顺手清一下旧键，防内存涨
  if (dedupMap.size > 500) for (const [k, t] of dedupMap) if (now - t > 10 * 60 * 1000) dedupMap.delete(k);
  return true;
}

// ==================== 记录钩子 ====================

/**
 * 触发口径：状态 或 处理人 任一变更即进钩子（v3 定稿）。
 * 状态变 → 开关节点；处理人变 → 通知。两件独立的事，能同时发生。
 */
function onRecordSave(kind: 'insert' | 'update' | 'delete', recordId: number | null, data: any, prev?: any): void {
  if (recordId == null) return;

  try {
    if (kind === 'insert') {
      const status = String((data && data['状态']) || '待处理');
      const handlerName = String((data && data['处理人']) || '').trim();
      const handler = findHandlerByName(handlerName);
      openNextNode(recordId, {
        status, handlerName,
        handlerId: handler ? handler.id : null,
        trigger: 'insert',
      });
      // 建单即指派了处理人 → 同样命中通知（AI/飞书建单常见）
      if (handlerName && dedupOk(`handler:${recordId}:${handlerName}`)) {
        void notifyHandlerChanged({
          title: String((data && data['标题']) || ''),
          fromStatus: '', toStatus: status,
          handlerName,
          result: '新建工单',
          promise: String((data && data['承诺时间']) || ''),
        }).then(r => { if (r.ok) markNotify(recordId, true, ''); else markNotify(recordId, false, r.error || ''); });
      }
      return;
    }

    if (kind === 'delete') {
      closeOpenNode(recordId, { result: '工单已删除', resultKind: 'auto' });
      return;
    }

    // update：状态 或 处理人 任一变更
    const before = prev || {};
    const after = data || {};
    const fromStatus = String(before['状态'] == null ? '' : before['状态']).trim();
    const toStatus = String(after['状态'] == null ? '' : after['状态']).trim();
    const fromHandler = String(before['处理人'] == null ? '' : before['处理人']).trim();
    const toHandler = String(after['处理人'] == null ? '' : after['处理人']).trim();
    const statusChanged = fromStatus !== toStatus;
    const handlerChanged = fromHandler !== toHandler;
    if (!statusChanged && !handlerChanged) return;

    // ① 状态变了 → 关旧节点 + 开新节点
    if (statusChanged && dedupOk(`status:${recordId}:${toStatus}`)) {
      const result = String(after['备注'] || '').trim().slice(0, 200);   // 处理结果：暂取备注尾部
      closeOpenNode(recordId, { result, resultKind: 'ok' });
      const handler = findHandlerByName(toHandler);
      openNextNode(recordId, {
        status: toStatus, handlerName: toHandler,
        handlerId: handler ? handler.id : null,
        trigger: 'ui',
      });
    }

    // ② 处理人变了（不管状态变没变）：
    //    状态没变 → 开放节点就地换人——节点账要能回答「这单现在在谁手里」；
    //    节点仍按状态分段，段内交接的细节流水在 ticket_logs，不新开节点（v3 拍板）。
    if (handlerChanged && !statusChanged) {
      const open = openNode(recordId);
      if (open) {
        const handler = findHandlerByName(toHandler);
        db.run('UPDATE ticket_flow_nodes SET handler_name = ?, handler_id = ? WHERE id = ?',
          toHandler, handler ? handler.id : null, open.id);
      }
    }
    // 填了新处理人 → 通知（节点 webhook，或全局兜底）
    if (handlerChanged && toHandler && dedupOk(`handler:${recordId}:${toHandler}`)) {
      void notifyHandlerChanged({
        title: String(after['标题'] || ''),
        fromStatus, toStatus,
        handlerName: toHandler,
        result: String(after['备注'] || '').trim().slice(0, 200),
        promise: String(after['承诺时间'] || ''),
      }).then(r => { if (r.ok) markNotify(recordId, true, ''); else markNotify(recordId, false, r.error || ''); });
    }
  } catch (e: any) {
    logger.warn('[TicketFlow] 钩子处理失败（不影响工单落库）: ' + (e && e.message));
  }
}

let registered = false;
/** 启动时注册（幂等） */
export function registerTicketFlow(): void {
  if (registered) return;
  registered = true;
  tickets.onSave(onRecordSave);
  logger.info('[TicketFlow] 已注册：流转节点账 + 处理人变更通知');
}
