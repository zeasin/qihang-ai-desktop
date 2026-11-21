/**
 * 工单联动（ticket-link）
 *
 * 把工单的承诺时间派生成系统提醒，让工单成为唯一事实源、
 * 提醒由扫描兜底派生 —— 不依赖建单时的 AI 自觉。
 *
 * 设计要点（2026-11-20 定稿，2026-11-21 随工单专表化简化）：
 *   1. 工单 = tickets 专表 + 三个保留字段：标题 / 状态 / 承诺时间（列固定存在，不再做字段候选探测）。
 *   2. 24 小时内的承诺 → 当场建一次性提醒（建单当天/次日能被接住）；
 *      超过 24 小时的承诺 → 交给每日扫描任务兜底补建，避免提醒列表被远期噪音填满。
 *   3. 状态为终态（已完成/已关闭/用户自定义终态）→ 关联提醒自动禁用并清除关联；状态中途改了承诺时间 → 顺延提醒。
 *   4. 谁都能触发：IPC 建单、AI 工具建单、飞书指令 —— 钩子挂在 tickets.onSave 上，所有写入路径都经过。
 *
 * 不做的：反向流转（待办勾掉 → 关工单）一期不做，避免双向同步打架；工单状态由人/AI 在
 * 工单上操作，提醒只是它的投影。
 */
import * as db from './database';
import * as tickets from './tickets';
import logger from './logger';
import * as scheduler from './scheduler';
import * as cron from 'node-cron';

/** 一次性提醒的时间默认值：当天承诺若已过早间时段，提醒仍会响（cron 用 HH:MM + date） */
const DEFAULT_ONCE_TIME = '09:00';

/** 提醒关联口径：ticket_dataset_id 恒为 'tickets'（2026-11-21 工单专表化） */
const TICKET_REF = 'tickets';

/**
 * 终态关键字（与前端 useTickets 的 TERMINAL_KEYWORDS 保持一致）。
 * 宽容匹配：自定义的「已作废 / 已终止」这类状态名也算终态，不用用户手动标记。
 */
const TERMINAL_KEYWORD_RE = /已关闭|已完结|已完成|已解决|已取消|已终止|已作废|已失效|已废弃|已退单|已拒绝|已放弃/;

/**
 * 判定状态是否为终态（宽容匹配，不要求用户必须用某个枚举值）。
 * extraTerminals = ticket_settings 里用户自定义的终态集合。
 */
function isClosedStatus(v: string, extraTerminals?: string[]): boolean {
  if (!v) return false;
  const s = v.trim();
  if (extraTerminals && extraTerminals.indexOf(s) >= 0) return true;
  if (s === '已发布') return true;
  return TERMINAL_KEYWORD_RE.test(s);
}

/** 当前工单枚举里的终态集合（ticket_settings 携带用户自定义） */
function terminalStatuses(): string[] | undefined {
  const settings = tickets.getSettings();
  return Array.isArray(settings && settings.terminalStatuses) ? settings.terminalStatuses : undefined;
}

/** 提醒名 = 标题摘要（让提醒列表一眼看得出是哪件事） */
function buildReminderTitle(data: any): string {
  let title = data ? data['标题'] : '';
  if (!title || String(title).trim() === '') {
    // 退而取第一个非空的短字符串值
    for (const v of Object.values(data || {})) {
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
function findLinkedReminder(recordId: number): { id: string; enabled: number } | null {
  return db.qOne<{ id: string; enabled: number }>(
    "SELECT id, enabled FROM plan_reminders WHERE ticket_dataset_id = ? AND source_record_id = ? AND type = 'once' ORDER BY created_at DESC LIMIT 1",
    TICKET_REF, String(recordId)
  );
}

/** 创建或顺延关联提醒（幂等：同一工单只保留一条联动提醒） */
function upsertReminder(recordId: number, data: any, date: string, time: string): void {
  const title = buildReminderTitle(data);
  const existing = findLinkedReminder(recordId);
  const remData: any = {
    name: `[工单] ${title}`,
    message: `工单承诺时间到：${title}`,
    type: 'once', date, time, enabled: true,
    ticket_dataset_id: TICKET_REF, source_record_id: String(recordId),
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
      logger.info(`[TicketLink] 已为工单 #${recordId} 建提醒 ${r.id} (${date} ${time})`);
    }
  }
}

/** 关闭工单时清理关联提醒 */
function clearReminder(recordId: number): void {
  const existing = findLinkedReminder(recordId);
  if (existing && existing.enabled) {
    db.reminder.setEnabled(existing.id, false);
    scheduler.removeReminder(existing.id);
    logger.info(`[TicketLink] 工单 #${recordId} 已关闭，禁用提醒 ${existing.id}`);
  }
}

/** 记录保存回调：主流程入口，绝不抛错（联动失败不能影响工单本身落库）
 *  签名与 tickets.onSave 对齐（含 delete / prev；本钩子只关心 insert/update）。 */
function onTicketRecordSave(kind: 'insert' | 'update' | 'delete', recordId: number | null, data: any, _prev?: any): void {
  if (kind === 'delete') return; // 删除不联动：工单没了，提醒留着无害（历史留痕）
  try {
    if (recordId == null || !data || typeof data !== 'object') return;
    const terminals = terminalStatuses();
    const promiseTime = String(data['承诺时间'] || '').trim();
    // 已关闭 → 清提醒
    if (isClosedStatus(String(data['状态'] || ''), terminals)) {
      clearReminder(recordId);
      return;
    }
    // 无承诺时间 → 不联动（不删已有提醒，保留历史）
    const parsed = parsePromiseTime(promiseTime);
    if (!parsed) return;
    // 仅对 24 小时内承诺当场建提醒；远期交给每日扫描兜底
    if (!within24h(parsed.date, parsed.time)) return;
    upsertReminder(recordId, data, parsed.date, parsed.time);
  } catch (e: any) {
    logger.warn('[TicketLink] 联动处理失败（不影响工单落库）: ' + (e && e.message));
  }
}

/** 启动时注册到 tickets.onSave（幂等） */
let registered = false;
export function registerTicketLink(): void {
  if (registered) return;
  registered = true;
  tickets.onSave(onTicketRecordSave);
  startDailyScan();
  logger.info('[TicketLink] 工单联动已注册：承诺时间→提醒 + 每日扫描兜底');
}

// ==================== 每日扫描兜底 ====================
// hook 只在保存时触发：远期承诺的工单建单当时不会建提醒，日期临近时也没有东西再触发它。
// 每日扫描补这个缺口：把「承诺时间在今天/已超时、未关闭、但还没有有效提醒」的工单补建提醒，
// 并把超时清单推飞书（有配置 webhook 才推）。

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
 * 扫描工单：
 *   1. 补建提醒——承诺时间在今天或已超时、未关闭、且没有有效一次性提醒的工单。
 *   2. 汇总超时/今日到期清单，推飞书（未配置 webhook 则只记日志）。
 * 返回 { scanned, backfilled, dueList } 供诊断。
 */
export async function scanTicketsDaily(): Promise<{ scanned: number; backfilled: number; dueList: string[] }> {
  const rows = tickets.list({ limit: 500 });
  if (!rows.length) return { scanned: 0, backfilled: 0, dueList: [] };
  const terminals = terminalStatuses();
  const today = localDateStr(new Date());
  const backfilled: string[] = [];
  const dueList: string[] = [];
  let scanned = 0;

  for (const r of rows) {
    if (r.id == null) continue;
    const raw = r['承诺时间'];
    if (!raw) continue;
    const parsed = parsePromiseTime(raw);
    if (!parsed) continue;
    const closed = isClosedStatus(String(r['状态'] || ''), terminals);
    if (closed) continue;
    scanned++;
    const title = String(r['标题'] || '(无标题)').split('\n')[0].slice(0, 30);
    // 今天到期或已超时 → 进清单
    if (parsed.date <= today) {
      dueList.push(parsed.date < today ? `${title}（超时 ${parsed.date}）` : `${title}（今天 ${parsed.time}）`);
    }
    // 补建提醒：没有有效提醒的都建上（扫描是兜底，覆盖 hook 没接住的远期单）
    const existing = findLinkedReminder(r.id);
    if (!existing || !existing.enabled) {
      upsertReminder(r.id, r, parsed.date, parsed.time);
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
  return { scanned, backfilled: backfilled.length, dueList };
}

/** 本地日期字符串 YYYY-MM-DD（+8 时区） */
function localDateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
