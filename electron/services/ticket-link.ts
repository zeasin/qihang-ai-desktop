/**
 * 工单联动（ticket-link）
 *
 * 把「工单」数据集里的承诺时间派生成系统提醒，让工单成为唯一事实源、
 * 提醒由扫描兜底派生 —— 不依赖建单时的 AI 自觉。
 *
 * 设计要点（2026-11-20 定稿）：
 *   1. 工单 = 通用数据集 + 三个保留字段：标题 / 状态 / 承诺时间。
 *      动态字段（客户、来源、金额…）完全交给用户自定义，系统不干预。
 *   2. 承诺时间字段的识别是宽容的：优先认「承诺时间」，退而认「下次跟进/截止时间」等
 *      同义字段（复用 dataset-normalize 的同义词思路），认不到就不联动，绝不打扰。
 *   3. 24 小时内的承诺 → 当场建一次性提醒（建单当天/次日能被接住）；
 *      超过 24 小时的承诺 → 交给每日扫描任务兜底补建，避免提醒列表被远期噪音填满。
 *   4. 状态为终态（已关闭 / 已完成 / 用户自定义终态）→ 关联提醒自动禁用并清除关联；状态中途改了承诺时间 → 顺延提醒。
 *   5. 谁都能触发：IPC 建单、AI 工具建单、飞书工单指令 —— 因为 hook 挂在 db.ds.insert /
 *      updateRecord 上（database 层），所有写入路径都经过。
 *
 * 不做的：反向流转（待办勾掉 → 关工单）一期不做，避免双向同步打架；工单状态由人/AI 在
 * 工单上操作，提醒只是它的投影。
 */
import * as db from './database';
import logger from './logger';
import * as scheduler from './scheduler';
import * as cron from 'node-cron';

/** 一次性提醒的时间默认值：当天承诺若已过早间时段，提醒仍会响（cron 用 HH:MM + date） */
const DEFAULT_ONCE_TIME = '09:00';

/** 承诺时间字段候选（按优先级取第一个存在于 schema 的） */
const PROMISE_FIELD_CANDIDATES = ['承诺时间', '下次跟进', '下次跟进时间', '跟进时间', '截止时间', '期限', '预计完成时间', '预计成交日期', '回复时间', '答复时间'];
/** 标题字段候选（用于提醒文案，认不到就用首列非空值） */
const TITLE_FIELD_CANDIDATES = ['标题', '事项', '名称', '需求', '内容', '详细', '描述', '备注', '问题', '项目'];
/** 状态字段候选（认「已关闭」类终态用） */
const STATUS_FIELD_CANDIDATES = ['状态', '阶段'];

/**
 * 终态关键字（与前端 useTickets 的 TERMINAL_KEYWORDS 保持一致）。
 * 宽容匹配：自定义的「已作废 / 已终止」这类状态名也算终态，不用用户手动标记。
 */
const TERMINAL_KEYWORD_RE = /已关闭|已完结|已完成|已解决|已取消|已终止|已作废|已失效|已废弃|已退单|已拒绝|已放弃/;

/**
 * 判定状态是否为终态（宽容匹配，不要求用户必须用某个枚举值）。
 * extraTerminals = schema 里用户自定义的终态集合。
 */
function isClosedStatus(v: string, extraTerminals?: string[]): boolean {
  if (!v) return false;
  const s = v.trim();
  if (extraTerminals && extraTerminals.indexOf(s) >= 0) return true;
  if (s === '已发布') return true;
  return TERMINAL_KEYWORD_RE.test(s);
}

/** 从 schema 找第一个存在的候选字段名 */
function pickField(fields: any[], candidates: string[]): string | null {
  const names = fields.map((f: any) => f && f.name).filter(Boolean);
  for (const c of candidates) if (names.includes(c)) return c;
  return null;
}

/** 解析数据集 schema_json，失败返回 null */
function parseSchema(datasetId: string): { fields: any[]; terminalStatuses: string[] } | null {
  const dsRow = db.qOne<{ schema_json: string }>('SELECT schema_json FROM data_center_datasets WHERE id = ? OR dataset_id = ?', datasetId, datasetId);
  if (!dsRow || !dsRow.schema_json) return null;
  try {
    const parsed = JSON.parse(dsRow.schema_json);
    return {
      fields: (parsed && parsed.fields) || [],
      terminalStatuses: Array.isArray(parsed && parsed.terminalStatuses) ? parsed.terminalStatuses : [],
    };
  } catch { return null; }
}

/** 提醒名 = 标题摘要（让提醒列表一眼看得出是哪件事） */
function buildReminderTitle(datasetId: string, data: any): string {
  const schema = parseSchema(datasetId);
  const fields = (schema && schema.fields) || [];
  const titleField = pickField(fields, TITLE_FIELD_CANDIDATES);
  let title = titleField ? data[titleField] : '';
  if (!title || String(title).trim() === '') {
    // 退而取第一个非空的短字符串值
    for (const v of Object.values(data)) {
      const s = String(v || '').trim();
      if (s && s.length <= 80) { title = s; break; }
    }
  }
  title = String(title || '').trim().split('\n')[0];
  return title.slice(0, 40) || '工单跟进';
}

/** 把各种时间写法归一到 { date: 'YYYY-MM-DD', time: 'HH:MM' }；认不出返回 null */
function parsePromiseTime(raw: any): { date: string; time: string } | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // 日期时间：2026-11-21 15:30 / 2026-11-21T15:30:00
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})[T\s]+(\d{1,2}):(\d{2})/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4].padStart(2, '0')}:${m[5]}` };
  // 纯日期：2026-11-21 或 2026/11/21
  m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return { date: `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`, time: DEFAULT_ONCE_TIME };
  // 纯时间（当天）：15:30
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { date: today, time: `${m[1].padStart(2, '0')}:${m[2]}` };
  }
  // 中文「明天/后天 + 可选时间」
  m = s.match(/(今天|明天|后天)(\s*(\d{1,2}):(\d{2}))?/);
  if (m) {
    const offset = m[1] === '今天' ? 0 : m[1] === '明天' ? 1 : 2;
    const d = new Date(); d.setDate(d.getDate() + offset);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { date, time: m[3] ? `${m[3].padStart(2, '0')}:${m[4]}` : DEFAULT_ONCE_TIME };
  }
  return null;
}

/** date+time 是否在 now 起 24 小时内（含已过期——过期也算近期，当场建提醒比漏掉强） */
function within24h(date: string, time: string): boolean {
  const t = Date.parse(`${date}T${time}:00`);
  if (isNaN(t)) return false;
  const now = Date.now();
  return t - now <= 24 * 3600 * 1000;
}

/** 查找某条工单已关联的、由联动创建的一次性提醒 */
function findLinkedReminder(datasetId: string, recordId: number): { id: string; enabled: number } | null {
  return db.qOne<{ id: string; enabled: number }>(
    "SELECT id, enabled FROM plan_reminders WHERE ticket_dataset_id = ? AND source_record_id = ? AND type = 'once' ORDER BY created_at DESC LIMIT 1",
    String(datasetId), String(recordId)
  );
}

/** 创建或顺延关联提醒（幂等：同一工单只保留一条联动提醒） */
function upsertReminder(datasetId: string, recordId: number, data: any, date: string, time: string): void {
  const dsName = (db.qOne<{ name: string }>('SELECT name FROM data_center_datasets WHERE id = ? OR dataset_id = ?', datasetId, datasetId) || {}).name || '工单';
  const title = buildReminderTitle(datasetId, data);
  const existing = findLinkedReminder(datasetId, recordId);
  const remData: any = {
    name: `[${dsName}] ${title}`,
    message: `工单承诺时间到：${title}`,
    type: 'once', date, time, enabled: true,
    ticket_dataset_id: String(datasetId), source_record_id: String(recordId),
  };
  if (existing) {
    db.reminder.update(existing.id, remData);
    db.reminder.setEnabled(existing.id, true);
    // 重新调度（改期后旧 cron 失效）
    const full = db.reminder.get(existing.id);
    if (full) { scheduler.removeReminder(existing.id); scheduler.addReminder(full); }
  } else {
    const r = db.reminder.add(remData);
    if (r && r.id) {
      const full = db.reminder.get(r.id);
      if (full) scheduler.addReminder(full);
      logger.info(`[TicketLink] 已为工单记录 #${recordId} 建提醒 ${r.id} (${date} ${time})`);
    }
  }
}

/** 关闭工单时清理关联提醒 */
function clearReminder(datasetId: string, recordId: number): void {
  const existing = findLinkedReminder(datasetId, recordId);
  if (existing && existing.enabled) {
    db.reminder.setEnabled(existing.id, false);
    scheduler.removeReminder(existing.id);
    logger.info(`[TicketLink] 工单记录 #${recordId} 已关闭，禁用提醒 ${existing.id}`);
  }
}

/** 记录保存回调：主流程入口，绝不抛错（联动失败不能影响工单本身落库）
 *  签名与 db.ds.onRecordSave 对齐（含 delete / prev；本钩子只关心 insert/update）。 */
function onTicketRecordSave(kind: 'insert' | 'update' | 'delete', datasetId: string, recordId: number | null, data: any, _prev?: any): void {
  if (kind === 'delete') return; // 删除不联动：工单没了，提醒留着无害（历史留痕）
  try {
    if (!datasetId || recordId == null || !data || typeof data !== 'object') return;
    const schema = parseSchema(datasetId);
    if (!schema) return;
    const fields = (schema.fields || []);
    const promiseField = pickField(fields, PROMISE_FIELD_CANDIDATES);
    const statusField = pickField(fields, STATUS_FIELD_CANDIDATES);
    // 已关闭 → 清提醒
    if (statusField && isClosedStatus(String(data[statusField] || ''), schema.terminalStatuses)) {
      clearReminder(datasetId, recordId);
      return;
    }
    // 无承诺字段或值为空 → 不联动（不删已有提醒，保留历史）
    if (!promiseField) return;
    const parsed = parsePromiseTime(data[promiseField]);
    if (!parsed) return;
    // 仅对 24 小时内承诺当场建提醒；远期交给每日扫描兜底
    if (!within24h(parsed.date, parsed.time)) return;
    upsertReminder(datasetId, recordId, data, parsed.date, parsed.time);
  } catch (e: any) {
    logger.warn('[TicketLink] 联动处理失败（不影响工单落库）: ' + (e && e.message));
  }
}

/** 启动时注册到 db.ds（幂等：调用一次即可，重复调用会重复注册所以内部去重） */
let registered = false;
export function registerTicketLink(): void {
  if (registered) return;
  registered = true;
  db.ds.onRecordSave(onTicketRecordSave);
  startDailyScan();
  logger.info('[TicketLink] 工单联动已注册：承诺时间→提醒 + 每日扫描兜底');
}

// ==================== 每日扫描兜底 ====================
// hook 只在保存时触发：远期承诺的工单建单当时不会建提醒，日期临近时也没有东西再触发它。
// 每日扫描补这个缺口：把「承诺时间在今天/已超时、未关闭、但还没有有效提醒」的工单补建提醒，
// 并把超时清单推飞书（有配置 webhook 才推）。

/** 找到「工单」数据集（找不到返回 null，扫描静默跳过——用户可能根本没用工单） */
function findTicketDataset(): { id: string | number; name: string } | null {
  const all = db.ds.list() as any[];
  return (Array.isArray(all) ? all.find(d => d.name === '工单') : null) || null;
}

/** cron：每天 09:05 扫描（避开整点提醒高峰） */
function startDailyScan(): void {
  try {
    cron.schedule('5 9 * * *', () => { void scanTicketsDaily(); });
    logger.info('[TicketLink] 每日扫描已排程：09:05');
  } catch (e: any) {
    logger.warn('[TicketLink] 每日扫描排程失败: ' + (e && e.message));
  }
}

/**
 * 扫描「工单」数据集：
 *   1. 补建提醒——承诺时间在今天或已超时、未关闭、且没有有效一次性提醒的工单。
 *   2. 汇总超时/今日到期清单，推飞书（未配置 webhook 则只记日志）。
 * 返回 { scanned, backfilled, dueList } 供诊断。
 */
export async function scanTicketsDaily(): Promise<{ scanned: number; backfilled: number; dueList: string[] }> {
  const ds = findTicketDataset();
  if (!ds) return { scanned: 0, backfilled: 0, dueList: [] };
  const schema = parseSchema(String(ds.id));
  const fields = (schema && schema.fields) || [];
  const promiseField = pickField(fields, PROMISE_FIELD_CANDIDATES);
  const statusField = pickField(fields, STATUS_FIELD_CANDIDATES);
  const titleField = pickField(fields, TITLE_FIELD_CANDIDATES);
  if (!promiseField) return { scanned: 0, backfilled: 0, dueList: [] };

  const { rows } = db.ds.listRecords(String(ds.id), { limit: 500 });
  const today = localDateStr(new Date());
  const backfilled: string[] = [];
  const dueList: string[] = [];

  for (const r of rows) {
    if (r.id == null) continue;
    const raw = r[promiseField];
    if (!raw) continue;
    const parsed = parsePromiseTime(raw);
    if (!parsed) continue;
    const closed = statusField ? isClosedStatus(String(r[statusField] || ''), schema ? schema.terminalStatuses : undefined) : false;
    if (closed) continue;
    const title = titleField ? String(r[titleField] || '(无标题)').split('\n')[0].slice(0, 30) : '(无标题)';
    // 今天到期或已超时 → 进清单
    if (parsed.date <= today) {
      dueList.push(parsed.date < today ? `${title}（超时 ${parsed.date}）` : `${title}（今天 ${parsed.time}）`);
    }
    // 补建提醒：没有有效提醒的都建上（扫描是兜底，覆盖 hook 没接住的远期单）
    const existing = findLinkedReminder(String(ds.id), r.id);
    if (!existing || !existing.enabled) {
      upsertReminder(String(ds.id), r.id, r, parsed.date, parsed.time);
      backfilled.push(title);
    }
  }

  // 推飞书超时清单（配置了 webhook 才推）
  if (dueList.length) {
    const msg = `📋 工单跟进提醒：${dueList.length} 件承诺事项需处理\n\n` +
      dueList.slice(0, 20).map((s, i) => `${i + 1}. ${s}`).join('\n') +
      (dueList.length > 20 ? `\n…另有 ${dueList.length - 20} 件` : '');
    try {
      const { getWebhook, sendViaWebhook } = await import('./feishu');
      const url = getWebhook();
      if (url) await sendViaWebhook(url, msg);
    } catch (e: any) {
      logger.warn('[TicketLink] 超时清单推飞书失败: ' + (e && e.message));
    }
  }
  if (backfilled.length) logger.info(`[TicketLink] 每日扫描补建 ${backfilled.length} 条提醒`);
  return { scanned: rows.length, backfilled: backfilled.length, dueList };
}

/** 本地日期字符串 YYYY-MM-DD（+8 时区） */
function localDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
