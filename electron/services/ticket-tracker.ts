/**
 * 工单追踪（ticket-tracker）
 *
 * 两件事，都挂在 db.ds.onRecordSave 钩子上，因此**所有写入路径都留痕**——
 * 事项页新建、AI 工具建单、飞书指令建单，一个不落：
 *
 *   1. 处理记录（ticket_logs）：新建工单 / 状态变化 / 关键字段流转，逐条流水。
 *      记录存的是「工单数据集」里的记录（工单 = data_center_datasets 的一个数据集）。
 *
 *   2. 工单 ↔ 待办联动（ticket_todos）：一张工单可拆出多条待办；
 *      工单进入终态（已完成/已关闭）→ 关联待办自动收尾；工单退回流转态 → 待办自动复活。
 *
 * 刻意不做反向联动（待办勾掉 → 自动关工单）：双向同步容易打架，
 * 与 ticket-link.ts 里「不做反向流转」的既有原则一致。
 */
import * as db from './database';
import logger from './logger';

/** 工单数据集名（与前端 useTickets 的 TICKET_DS_NAME 对齐） */
const TICKET_DS_NAME = '工单';

/** 终态关键字（与前端 useTickets 的 TERMINAL_KEYWORDS 对齐） */
const TERMINAL_KEYWORDS = ['已关闭', '已完结', '已完成', '已解决', '已取消', '已终止', '已作废', '已失效', '已废弃', '已退单', '已拒绝', '已放弃'];

/** 记流水时要盯的字段（其余字段变化不记，避免刷屏） */
const TRACKED_FIELDS: Array<{ field: string; label: string }> = [
  { field: '状态', label: '状态' },
  { field: '标题', label: '标题' },
  { field: '处理人', label: '处理人' },
  { field: '承诺时间', label: '承诺时间' },
  { field: '备注', label: '备注' },
  { field: '类型', label: '类型' },
  { field: '来源', label: '来源' },
];

/** 工单数据集 id（启动时查一次缓存） */
let ticketDatasetId: string | null = null;

function resolveTicketDatasetId(): string | null {
  if (ticketDatasetId) return ticketDatasetId;
  try {
    const list = db.ds.list() as any[];
    const found = (Array.isArray(list) ? list : []).find((d: any) => d && d.name === TICKET_DS_NAME);
    ticketDatasetId = found ? String(found.id) : null;
  } catch (e) { ticketDatasetId = null; }
  return ticketDatasetId;
}

/** 状态是否终态（与前端 isClosed 同口径） */
function isTerminalStatus(v: any): boolean {
  const s = String(v || '').trim();
  if (!s) return false;
  return TERMINAL_KEYWORDS.some(k => s.includes(k));
}

/** 写一条处理记录 */
function addLog(datasetId: string, recordId: number | null, action: string, opts?: { field?: string; from?: string; to?: string; note?: string }): void {
  if (!datasetId || recordId == null) return;
  try {
    db.run(
      'INSERT INTO ticket_logs (dataset_id, record_id, action, field, from_value, to_value, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      datasetId, recordId, action, (opts && opts.field) || '', (opts && opts.from) || '', (opts && opts.to) || '', (opts && opts.note) || ''
    );
  } catch (e) { logger.warn('[TicketTracker] 写处理记录失败: ' + (e && e.message)); }
}

/** 读某工单的处理记录（最新在前） */
export function listLogs(datasetId: string, recordId: number): any[] {
  try {
    return db.q(
      'SELECT id, action, field, from_value, to_value, note, created_at FROM ticket_logs WHERE dataset_id = ? AND record_id = ? ORDER BY id DESC LIMIT 200',
      String(datasetId), recordId
    );
  } catch (e) {
    logger.warn('[TicketTracker] 读处理记录失败: ' + (e && e.message));
    return [];
  }
}

/** 手工补一条处理记录（表单里「添加处理记录」） */
export function addManualLog(datasetId: string, recordId: number, note: string): boolean {
  const text = String(note || '').trim();
  if (!text) return false;
  addLog(String(datasetId), recordId, 'note', { note: text });
  return true;
}

// ==================== 工单 ↔ 待办 ====================

/** 工单关联的待办 */
export function listLinkedTodos(datasetId: string, recordId: number): any[] {
  try {
    return db.q(
      `SELECT t.id, t.title, t.status, t.priority, t.scheduled_start, t.due_date, t.created_at
         FROM plan_todos t JOIN ticket_todos l ON l.todo_id = t.id
        WHERE l.dataset_id = ? AND l.record_id = ? ORDER BY t.id DESC`,
      String(datasetId), recordId
    );
  } catch (e) {
    logger.warn('[TicketTracker] 读关联待办失败: ' + (e && e.message));
    return [];
  }
}

/** 各工单关联的待办数量（卡片上显示 🔗 N 用） */
export function linkedCounts(datasetId: string): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const rows = db.q<{ record_id: number; c: number }>(
      'SELECT record_id, COUNT(*) c FROM ticket_todos WHERE dataset_id = ? GROUP BY record_id',
      String(datasetId)
    );
    for (const r of rows) out[String(r.record_id)] = r.c;
  } catch (e) { logger.warn('[TicketTracker] 读关联数量失败: ' + (e && e.message)); }
  return out;
}

/** 关联一条已有待办 */
export function linkTodo(datasetId: string, recordId: number, todoId: number): boolean {
  try {
    const exists = db.qOne<{ c: number }>(
      'SELECT COUNT(*) c FROM ticket_todos WHERE dataset_id = ? AND record_id = ? AND todo_id = ?',
      String(datasetId), recordId, todoId
    );
    if (exists && exists.c > 0) return false;
    db.run('INSERT INTO ticket_todos (dataset_id, record_id, todo_id) VALUES (?, ?, ?)', String(datasetId), recordId, todoId);
    const todo = db.todo.get(todoId) as any;
    addLog(datasetId, recordId, 'link_todo', { to: todo ? String(todo.title || '') : String(todoId), note: '关联待办' });
    return true;
  } catch (e) {
    logger.warn('[TicketTracker] 关联待办失败: ' + (e && e.message));
    return false;
  }
}

/** 解除关联 */
export function unlinkTodo(datasetId: string, recordId: number, todoId: number): boolean {
  try {
    const todo = db.todo.get(todoId) as any;
    db.run('DELETE FROM ticket_todos WHERE dataset_id = ? AND record_id = ? AND todo_id = ?', String(datasetId), recordId, todoId);
    addLog(datasetId, recordId, 'unlink_todo', { from: todo ? String(todo.title || '') : String(todoId), note: '解除关联待办' });
    return true;
  } catch (e) {
    logger.warn('[TicketTracker] 解除关联待办失败: ' + (e && e.message));
    return false;
  }
}

/** 由工单拆出一条待办并关联 */
export function createTodoForTicket(datasetId: string, recordId: number, data: { title: string; priority?: string; scheduled_start?: string }): any {
  const title = String(data.title || '').trim();
  if (!title) return null;
  const created = db.todo.add({
    title,
    description: '',
    priority: data.priority || 'mid',
    status: 'pending',
    scheduled_start: data.scheduled_start || '',
    source: 'ticket',
  });
  const todoId = created && created.id;
  if (!todoId) return null;
  linkTodo(datasetId, recordId, todoId);
  return { id: todoId, title };
}

/** 切换关联待办的完成状态（手工勾选） */
export function toggleLinkedTodo(todoId: number, done: boolean): boolean {
  try {
    db.todo.update(todoId, { status: done ? 'done' : 'pending' });
    return true;
  } catch (e) {
    logger.warn('[TicketTracker] 切换待办状态失败: ' + (e && e.message));
    return false;
  }
}

/**
 * 终态联动：工单进终态 → 关联待办自动收尾；工单退回流转态 → 待办复活。
 * 只在状态真的变了的时候动待办，避免重复保存时来回翻。
 */
function syncLinkedTodosOnStatusChange(datasetId: string, recordId: number, fromStatus: string, toStatus: string): void {
  const fromTerm = isTerminalStatus(fromStatus);
  const toTerm = isTerminalStatus(toStatus);
  if (fromTerm === toTerm) return;
  const links = db.q<{ todo_id: number }>(
    'SELECT todo_id FROM ticket_todos WHERE dataset_id = ? AND record_id = ?',
    String(datasetId), recordId
  );
  for (const l of links) {
    try {
      const todo = db.todo.get(l.todo_id) as any;
      if (!todo) continue;
      // 已经处于目标状态就别动
      const cur = String(todo.status || 'pending');
      const want = toTerm ? 'done' : 'pending';
      if (cur === want) continue;
      db.todo.update(l.todo_id, { status: want });
    } catch (e) { logger.warn('[TicketTracker] 待办联动失败: ' + (e && e.message)); }
  }
}

// ==================== 记录钩子 ====================

/**
 * 记录保存回调：新建 / 状态变化 / 关键字段流转，全部落 ticket_logs。
 * 同时驱动工单↔待办的终态联动。
 */
function onRecordSave(kind: 'insert' | 'update' | 'delete', datasetId: string, recordId: number | null, data: any, prev?: any): void {
  const dsId = resolveTicketDatasetId();
  if (!dsId || String(datasetId) !== dsId) return;   // 只管工单数据集
  if (recordId == null) return;

  if (kind === 'insert') {
    addLog(dsId, recordId, 'create', { to: String((data && data['标题']) || '') , note: '新建工单' });
    return;
  }
  if (kind === 'delete') {
    addLog(dsId, recordId, 'delete', { from: String((prev && prev['标题']) || ''), note: '删除工单' });
    return;
  }
  // update：比对新旧，记录变化
  const before = prev || {};
  const after = data || {};
  for (const f of TRACKED_FIELDS) {
    const from = String(before[f.field] == null ? '' : before[f.field]);
    const to = String(after[f.field] == null ? '' : after[f.field]);
    if (from === to) continue;
    if (f.field === '状态') {
      addLog(dsId, recordId, 'status', { field: f.label, from, to, note: '状态变化' });
      syncLinkedTodosOnStatusChange(dsId, recordId, from, to);
    } else {
      addLog(dsId, recordId, 'update', { field: f.label, from, to, note: f.label + '变更' });
    }
  }
}

let registered = false;
/** 启动时注册（幂等） */
export function registerTicketTracker(): void {
  if (registered) return;
  registered = true;
  resolveTicketDatasetId();
  db.ds.onRecordSave(onRecordSave);
  logger.info('[TicketTracker] 已注册：处理记录 + 工单↔待办联动');
}
