/**
 * 工单存储（tickets.ts）
 *
 * 事项体系唯一实体表（2026-11-21「所有事项都放进工单」）：
 *   - 工单从 data_center_datasets/records 通用层迁入 tickets 专表（中文列名 + extra_json 自定义字段）
 *   - 待办并入为 类型='待办' 的工单（状态 待处理/已完成 即 pending/done）
 *   - 枚举/字段定义存 ticket_settings 单行（schema_json 结构与旧 datasets.schema_json 相同）
 *
 * 写路径拆列（核心字段→列，其余键→extra_json），读路径合并回中文键对象——
 * 消费方（事项页 / 钩子链 / AI 工具）看到的仍是熟悉的中文键形状。
 *
 * 状态流转时间戳（处理时间/完结时间）在这里统一盖章，页面/AI/飞书所有写入路径口径一致
 * （此前只在渲染层 save 里盖，AI 建单漏盖，这里顺手收口）。
 *
 * 钩子链挂在本模块 onSave 上（承诺时间提醒 → 流水日志/待办联动 → 流转节点账），
 * main.ts 启动时按 link → tracker → flow 顺序注册。
 */
import { q, qOne, run, runInsertId } from './database';
import logger from './logger';

/** 核心字段 = tickets 表的中文列（其余键进 extra_json） */
export const CORE_FIELDS = ['标题', '类型', '来源', '新建人', '处理人', '内容', '备注', '状态', '承诺时间', '处理时间', '完结时间'];

/** 终态关键字兜底：状态名含这些词即视为终态（与渲染层 TERMINAL_KEYWORDS 同口径） */
const TERMINAL_KEYWORDS = ['已关闭', '已完结', '已完成', '已解决', '已取消', '已终止', '已作废', '已失效', '已废弃', '已退单', '已拒绝', '已放弃'];

/** 默认枚举（新装库 bootstrap；老库由迁移从旧 schema_json 携带） */
const DEFAULT_SCHEMA = {
  fields: [
    { name: '标题', type: 'string' }, { name: '类型', type: 'string' }, { name: '来源', type: 'string' },
    { name: '新建人', type: 'string' }, { name: '处理人', type: 'string' }, { name: '内容', type: 'text' },
    { name: '备注', type: 'text' }, { name: '状态', type: 'string' }, { name: '承诺时间', type: 'datetime' },
    { name: '处理时间', type: 'datetime' }, { name: '完结时间', type: 'datetime' },
  ],
  statusOptions: ['待处理', '处理中', '已完成', '已关闭'],
  terminalStatuses: ['已完成', '已关闭'],
  typeOptions: ['待办', '需求', '问题', '咨询', '跟进'],
  sourceOptions: ['微信', '电话', '官网', '邮件', '会议', '其他'],
};

/** 本地时间串（与库内 datetime('now','+8 hours') 同口径） */
function nowLocal(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 状态是否终态：枚举命中或关键字命中 */
function isTerminalStatus(status: string, terminals: string[]): boolean {
  const st = String(status || '').trim();
  if (!st) return false;
  return terminals.includes(st) || TERMINAL_KEYWORDS.some(k => st.includes(k));
}

/** 承诺时间统一成联动层认的 "YYYY-MM-DD HH:MM"（纯日期补当天 18:00） */
function normalizePromiseTime(v: any): string {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + ' 18:00';
  return s.slice(0, 16);
}

// ========== 枚举/字段定义（ticket_settings 单行） ==========

/** 取枚举定义（不存在则 bootstrap 默认值） */
export function getSettings(): any {
  try {
    const row = qOne<{ schema_json: string }>('SELECT schema_json FROM ticket_settings WHERE id = 1');
    if (row && row.schema_json) {
      try { return JSON.parse(row.schema_json); } catch {}
    }
    saveSettings(DEFAULT_SCHEMA);
    return DEFAULT_SCHEMA;
  } catch (e: any) {
    logger.warn('[Tickets] 读工单设置失败: ' + (e && e.message));
    return DEFAULT_SCHEMA;
  }
}

/** 保存枚举/字段定义（事项页「工单设置」写入） */
export function saveSettings(schema: any): void {
  const json = typeof schema === 'string' ? schema : JSON.stringify(schema || DEFAULT_SCHEMA);
  run(`INSERT INTO ticket_settings (id, schema_json, updated_at) VALUES (1, ?, datetime('now', '+8 hours'))
       ON CONFLICT(id) DO UPDATE SET schema_json = excluded.schema_json, updated_at = excluded.updated_at`, json);
}

// ========== 读写路径（列 ↔ 中文键对象） ==========

/** 行 → 消费方熟悉的中文键对象（extra_json 合并，extra_json 键本身剥掉） */
function rowToRecord(r: any): any {
  const rec: any = { ...r };
  try {
    const extra = JSON.parse(r.extra_json || '{}');
    for (const [k, v] of Object.entries(extra || {})) rec[k] = v;
  } catch {}
  delete rec.extra_json;
  rec._created_at = r.created_at;
  return rec;
}

/** 中文键对象 → 列值（核心字段取值，其余键进 extra_json） */
function splitRecord(form: any): { cols: Record<string, string>; extra: Record<string, any> } {
  const cols: Record<string, string> = {};
  const extra: Record<string, any> = {};
  for (const [k, v] of Object.entries(form || {})) {
    if (k === 'id' || k === '_created_at' || k === 'created_at' || k === 'updated_at') continue;
    if (CORE_FIELDS.includes(k)) { cols[k] = v == null ? '' : String(v); continue; }
    if (v !== undefined && v !== null) extra[k] = v;   // 空串也存：自定义字段清空要能落库
  }
  return { cols, extra };
}

/** 状态流转时间戳盖章（口径同旧渲染层 save：非终态流转态盖处理时间，终态盖完结时间） */
function stampTimestamps(cols: Record<string, string>, terminals: string[], prev?: any): void {
  const st = String(cols['状态'] || '').trim();
  const terminal = isTerminalStatus(st, terminals);
  const had = (k: string) => (prev && prev[k] ? true : !!cols[k]);
  if (!terminal && st && st !== '待处理' && !had('处理时间')) cols['处理时间'] = nowLocal();
  if (terminal) { if (!had('完结时间')) cols['完结时间'] = nowLocal(); }
  else if (prev && prev['完结时间']) cols['完结时间'] = '';   // 离开终态 → 清空完结时间
}

// ========== 钩子链（承诺时间提醒 → 流水 → 节点账） ==========

type TicketHook = (kind: 'insert' | 'update' | 'delete', recordId: number | null, data: any, prev?: any) => void;
const saveHooks: TicketHook[] = [];

/** main.ts 启动时按顺序注册（link → tracker → flow）；注册即触发设置 bootstrap */
export function onSave(fn: TicketHook): void {
  saveHooks.push(fn);
}

function fireHooks(kind: 'insert' | 'update' | 'delete', recordId: number | null, data: any, prev?: any): void {
  for (const h of saveHooks) {
    try { h(kind, recordId, data, prev); } catch (e: any) { logger.warn('[Tickets] 钩子处理失败（不影响落库）: ' + (e && e.message)); }
  }
}

// ========== CRUD ==========

/**
 * 工单列表（合并 extra 后返回）。opts.type 过滤类型（'待办' 供今天页/侧栏用），
 * opts.all=false 时不含已关闭/终态。默认按创建时间倒序（事项页时间线口径）。
 */
export function list(opts: { type?: string; openOnly?: boolean; limit?: number } = {}): any[] {
  const settings = getSettings();
  const terminals: string[] = Array.isArray(settings.terminalStatuses) ? settings.terminalStatuses : ['已完成', '已关闭'];
  const limit = Math.max(1, Math.min(500, opts.limit || 500));
  const rows = q<any>(`SELECT * FROM tickets ORDER BY created_at DESC, id DESC LIMIT ?`, limit);
  let out = rows.map(rowToRecord);
  if (opts.type) out = out.filter(t => String(t['类型'] || '') === opts.type);
  if (opts.openOnly) out = out.filter(t => !isTerminalStatus(String(t['状态'] || ''), terminals));
  return out;
}

export function get(id: number): any | null {
  const r = qOne<any>('SELECT * FROM tickets WHERE id = ?', id);
  return r ? rowToRecord(r) : null;
}

/** 新建工单。返回新 id。 */
export function create(form: any): number {
  const settings = getSettings();
  const terminals: string[] = Array.isArray(settings.terminalStatuses) ? settings.terminalStatuses : ['已完成', '已关闭'];
  const { cols, extra } = splitRecord(form);
  if (!cols['状态']) cols['状态'] = '待处理';
  if (cols['承诺时间']) cols['承诺时间'] = normalizePromiseTime(cols['承诺时间']);
  stampTimestamps(cols, terminals);
  const id = runInsertId(`INSERT INTO tickets ("标题", "类型", "来源", "新建人", "处理人", "内容", "备注", "状态", "承诺时间", "处理时间", "完结时间", extra_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    cols['标题'] || '', cols['类型'] || '', cols['来源'] || '', cols['新建人'] || '', cols['处理人'] || '',
    cols['内容'] || '', cols['备注'] || '', cols['状态'] || '待处理', cols['承诺时间'] || '',
    cols['处理时间'] || '', cols['完结时间'] || '', JSON.stringify(extra));
  const merged = get(id);
  logger.info('[Tickets] create #%s「%s」', id, cols['标题'] || '');
  fireHooks('insert', id, merged);
  return id;
}

/** 更新工单（form 为完整字段对象）。返回是否落库。 */
export function update(id: number, form: any): boolean {
  const prev = get(id);
  if (!prev) return false;
  const settings = getSettings();
  const terminals: string[] = Array.isArray(settings.terminalStatuses) ? settings.terminalStatuses : ['已完成', '已关闭'];
  const { cols, extra } = splitRecord(form);
  if (cols['承诺时间']) cols['承诺时间'] = normalizePromiseTime(cols['承诺时间']);
  stampTimestamps(cols, terminals, prev);
  run(`UPDATE tickets SET "标题" = ?, "类型" = ?, "来源" = ?, "新建人" = ?, "处理人" = ?, "内容" = ?, "备注" = ?,
        "状态" = ?, "承诺时间" = ?, "处理时间" = ?, "完结时间" = ?, extra_json = ?,
        updated_at = datetime('now', '+8 hours') WHERE id = ?`,
    cols['标题'] ?? prev['标题'] ?? '', cols['类型'] ?? prev['类型'] ?? '', cols['来源'] ?? prev['来源'] ?? '',
    cols['新建人'] ?? prev['新建人'] ?? '', cols['处理人'] ?? prev['处理人'] ?? '', cols['内容'] ?? prev['内容'] ?? '',
    cols['备注'] ?? prev['备注'] ?? '', cols['状态'] ?? prev['状态'] ?? '待处理', cols['承诺时间'] ?? prev['承诺时间'] ?? '',
    cols['处理时间'] ?? prev['处理时间'] ?? '', cols['完结时间'] ?? prev['完结时间'] ?? '',
    JSON.stringify(extra), id);
  const merged = get(id);
  logger.info('[Tickets] update #%s fields=%j', id, Object.keys(cols));
  fireHooks('update', id, merged, prev);
  return true;
}

/** 删除工单（顺带清掉双向关联待办，别留悬空行）。 */
export function remove(id: number): boolean {
  const prev = get(id);
  if (!prev) return false;
  run('DELETE FROM tickets WHERE id = ?', id);
  try { run('DELETE FROM ticket_todos WHERE record_id = ? OR todo_id = ?', id, id); } catch (e: any) { logger.warn('[Tickets] 清理关联失败: ' + (e && e.message)); }
  logger.info('[Tickets] remove #%s「%s」', id, prev['标题'] || '');
  fireHooks('delete', id, prev);
  return true;
}

/** 状态是否终态（供 IPC 层/AI 工具判定，枚举从 ticket_settings 来） */
export function isClosed(status: string): boolean {
  const terminals: string[] = Array.isArray(getSettings().terminalStatuses) ? getSettings().terminalStatuses : ['已完成', '已关闭'];
  return isTerminalStatus(status, terminals);
}
