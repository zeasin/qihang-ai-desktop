import * as cron from 'node-cron';
import * as path from 'path';
import * as db from './database';
import * as appConfig from './app-config';
import logger from './logger';
import { Notification } from 'electron';

function convertMarkdownForFeishu(md: string): string {
  const lines = md.trim().split('\n');
  const out: string[] = [];
  let lastBlank = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 连续空行合并为一个
    if (line.trim() === '') {
      if (!lastBlank) { out.push(''); lastBlank = true; }
      i++;
      continue;
    }
    lastBlank = false;
    // 表格：转为 key: value 列表
    if (line.startsWith('|') && line.endsWith('|')) {
      const headerCells = line.split('|').slice(1, -1).map(c => c.trim());
      const isSeparator = headerCells.every(c => /^[-: ]+$/.test(c));
      if (isSeparator) {
        i++;
        continue;
      }
      const dataRows: string[][] = [];
      i++;
      while (i < lines.length && lines[i].startsWith('|') && lines[i].endsWith('|')) {
        const cells = lines[i].split('|').slice(1, -1).map(c => c.trim());
        if (!cells.every(c => /^[-: ]+$/.test(c))) {
          dataRows.push(cells);
        }
        i++;
      }
      if (dataRows.length > 0) {
        const maxCols = Math.max(headerCells.length, ...dataRows.map(r => r.length));
        for (const row of dataRows) {
          const parts: string[] = [];
          for (let c = 0; c < maxCols; c++) {
            const label = headerCells[c] || `字段${c + 1}`;
            const val = row[c] || '';
            parts.push(`**${label}**: ${val}`);
          }
          out.push('- ' + parts.join(' | '));
        }
      }
      continue;
    }
    // 标题：## xxx → **xxx**
    const headingMatch = line.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) {
      out.push('**' + headingMatch[1].trim() + '**');
      i++;
      continue;
    }
    // 分割线：--- / *** → 空行
    if (/^[-*]{3,}\s*$/.test(line.trim())) {
      out.push('');
      i++;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

let jobs = new Map();
let running = false;

// China timezone helper (UTC+8, no DST)
function getChinaDate(offsetDays = 0) {
  const d = new Date();
  // Shift to China time, then toISOString gives the correct date
  const china = new Date(d.getTime() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return china.toISOString().slice(0, 10);
}
// China timezone midnight timestamp (ms since epoch)
function getChinaMidnight() {
  const chinaDate = getChinaDate();
  return new Date(chinaDate + 'T00:00:00+08:00').getTime();
}

let feishu: any = null;
function getFeishu() {
  if (!feishu) feishu = require('./feishu');
  return feishu;
}

function getWebhookUrl() {
  return appConfig.getConfig('feishuWebhookUrl') || '';
}

// ===== Report helpers =====

async function sendFeishu(message) {
  const url = getWebhookUrl();
  if (!url) return;
  try {
    const body = typeof message === 'string'
      ? { msg_type: 'text', content: JSON.stringify({ text: message }) }
      : { msg_type: 'interactive', card: message };
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    logger.warn(`[Scheduler] feishu send failed: ${e.message}`);
  }
}

function sendNotification(title, body) {
  try {
    const n = new Notification({ title, body });
    n.show();
  } catch (e) {
    logger.warn(`[Scheduler] notification failed: ${e.message}`);
  }
}

function getCronFromReminder(r) {
  switch (r.type) {
    case 'daily': return `${r.time.split(':')[1] || '0'} ${r.time.split(':')[0] || '9'} * * *`;
    case 'weekly': return `${r.time.split(':')[1] || '0'} ${r.time.split(':')[0] || '9'} * * ${r.day_of_week || 1}`;
    case 'monthly': return `${r.time.split(':')[1] || '0'} ${r.time.split(':')[0] || '9'} ${r.day_of_month || 1} * *`;
    case 'yearly': {
      const parts = (r.month_day || '1-1').split('-');
      return `${r.time.split(':')[1] || '0'} ${r.time.split(':')[0] || '9'} ${parts[1] || 1} ${parts[0] || 1} *`;
    }
    case 'once': {
      const d = String(r.date || '').split('-');
      if (d.length !== 3) return null;
      return `${r.time.split(':')[1] || '0'} ${r.time.split(':')[0] || '9'} ${d[2] || 1} ${d[1] || 1} *`;
    }
    default: return null;
  }
}

function start() {
  if (running) return;
  running = true;

  const plan_reminders = db.reminder.getActive();
  for (const r of plan_reminders) {
    scheduleReminder(r);
  }

  reloadTasks();

  logger.info(`[Scheduler] started with 0 plan_tasks + ${plan_reminders.length} plan_reminders`);
}



function scheduleReminder(r) {
  const cronExpr = getCronFromReminder(r);
  if (!cronExpr || !cron.validate(cronExpr)) return;
  const job = cron.schedule(cronExpr, async () => {
    try {
      const msg = '⏰ ' + r.name + (r.message ? '\n' + r.message : '');
      sendNotification('⏰ ' + r.name, r.message || '');
      await sendFeishu(msg);
      logger.info(`[Scheduler] reminder triggered: ${r.name}`);
      if (r.type === 'once') {
        // 一次性提醒：触发后自动禁用并停止调度
        db.reminder.setEnabled(r.id, false);
        removeReminder(r.id);
      }
    } catch (e) {
      logger.error(`[Scheduler] reminder ${r.name} error:`, e.message);
    }
  });
  jobs.set('reminder_' + r.id, job);
}

function addReminder(r) {
  scheduleReminder(r);
}

function removeReminder(id) {
  const key = 'reminder_' + id;
  if (jobs.has(key)) { jobs.get(key).stop(); jobs.delete(key); }
}

// ==================== AI 自执行任务调度 ====================

function nowString(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function notifyUI() {
  try {
    const { BrowserWindow } = require('electron') as typeof import('electron');
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('task:changed');
    }
  } catch {}
}

/** 根据任务触发配置生成 cron 表达式（循环任务），无有效配置返回 null */
function getTaskCron(t: any): string | null {
  if (t.cycle_type === 'cron') return t.cycle_value || null;
  if (!t.cycle_time) return null;
  const parts = t.cycle_time.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1] || '0', 10);
  if (isNaN(h) || isNaN(m)) return null;
  if (t.cycle_type === 'daily') return `${m} ${h} * * *`;
  if (t.cycle_type === 'weekly') {
    const days = String(t.cycle_value || '').split(',').filter(Boolean).join(',');
    if (!days) return null;
    return `${m} ${h} * * ${days}`;
  }
  if (t.cycle_type === 'monthly') {
    const days = String(t.cycle_value || '').split(',').filter(Boolean).join(',');
    if (!days) return null;
    return `${m} ${h} ${days} * *`;
  }
  return null;
}

function scheduleTask(t: any) {
  const key = 'task_' + t.id;
  if (jobs.has(key)) { jobs.get(key).stop(); jobs.delete(key); }

  // 一次性定时：setTimeout 到点触发一次
  if (t.trigger_type === 'once' && t.scheduled_start) {
    const target = new Date(String(t.scheduled_start).replace(' ', 'T') + '+08:00').getTime();
    const delay = target - Date.now();
    if (delay <= 0) return; // 已过期，不补跑
    const timer = setTimeout(async () => {
      jobs.delete(key);
      const fresh = db.task.get(t.id);
      if (fresh && fresh.status === 'pending') enqueueTask(fresh, 'scheduled');
    }, delay);
    jobs.set(key, { stop: () => clearTimeout(timer) });
    return;
  }

  // 循环任务
  const cronExpr = getTaskCron(t);
  if (!cronExpr || !cron.validate(cronExpr)) return;
  const job = cron.schedule(cronExpr, async () => {
    const today = getChinaDate();
    if (t.cycle_end && t.cycle_end < today) {
      // 已到循环结束日期：转为已完成并停止调度
      db.task.update(t.id, { status: 'done' });
      removeTask(t.id);
      notifyUI();
      return;
    }
    const fresh = db.task.get(t.id);
    if (fresh && fresh.status === 'pending') {
      db.task.update(t.id, { last_cycle_run: nowString() });
      enqueueTask(fresh, 'scheduled');
    }
  });
  jobs.set(key, job);
}

function reloadTasks() {
  for (const [id, job] of jobs) {
    if (id.startsWith('task_')) { job.stop(); jobs.delete(id); }
  }
  const plan_tasks = db.task.schedulable();
  for (const t of plan_tasks) scheduleTask(t);
  logger.info(`[Scheduler] plan_tasks scheduled: ${plan_tasks.length}`);
}

function removeTask(id: number) {
  const key = 'task_' + id;
  if (jobs.has(key)) { jobs.get(key).stop(); jobs.delete(key); }
}

// ---- 串行执行队列 ----
let execQueue: any[] = [];
let execRunning = false;

async function pumpQueue() {
  if (execRunning) return;
  const item = execQueue.shift();
  if (!item) return;
  execRunning = true;
  try {
    await runTask(item.task, item.triggerType, item.overrideModel);
  } catch (e: any) {
    logger.error(`[Scheduler] task execution error: ${e.message}`);
  }
  execRunning = false;
  pumpQueue();
}

/** 将任务加入执行队列（手动/定时/到期共用）；overrideModel 为本次执行临时指定的模型（重跑时选择） */
function enqueueTask(task: any, triggerType: string, overrideModel?: string) {
  execQueue.push({ task, triggerType, overrideModel });
  notifyUI();
  pumpQueue();
}

/** 保存任务结果到项目目录（任务所属项目优先，回落默认项目） */
function saveTaskResultToNote(task: any, result: string): string {
  try {
    const proj: any = task.project_id && Number.isFinite(Number(task.project_id)) ? db.project.get(Number(task.project_id)) : null;
    const notesDir = (proj && proj.dir) || appConfig.getConfig('notesDir') || '';
    if (!notesDir) return '';
    let relPath = task.output_target || '';
    if (!relPath) {
      const title = String(task.title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 50);
      relPath = `任务输出/${title}_${getChinaDate().replace(/-/g, '')}.md`;
    }
    const full = path.resolve(notesDir, relPath);
    if (!full.startsWith(path.resolve(notesDir))) return '';
    const fs = require('fs') as typeof import('fs');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const header = `# ${task.title}\n\n> 执行时间：${nowString()} · 触发方式：${triggerTypeLabel(task)}\n\n`;
    fs.writeFileSync(full, header + result, 'utf-8');
    return relPath;
  } catch { return ''; }
}

function triggerTypeLabel(task: any): string {
  if (task.trigger_type === 'cycle') {
    if (task.cycle_type === 'cron') return '循环 Cron';
    if (task.cycle_type === 'weekly') return `每周 ${task.cycle_value}`;
    if (task.cycle_type === 'monthly') return `每月 ${task.cycle_value} 号`;
    return `每天 ${task.cycle_time}`;
  }
  if (task.trigger_type === 'once') return `一次性 ${task.scheduled_start}`;
  return '立即执行';
}

async function runTask(task: any, triggerType: string, overrideModel?: string) {
  const start = nowString();
  const project: any = task.project_id ? db.project.get(task.project_id) : null;
  // 项目口径：任务所属项目优先，无项目任务回落默认项目
  const noteProj: any = (project && project.dir ? project : null)
    || db.qOne("SELECT * FROM prj_projects ORDER BY is_default DESC, id ASC LIMIT 1");
  const notesDir = (noteProj && noteProj.dir) || (project && project.dir) || '';

  // ===== 项目前置检查：AI 功能门禁 =====
  // 一个项目都没有时任务不执行（无笔记工具、结果无处保存），记录失败并给出明确提示
  if (!notesDir) {
    const msg = '尚未添加任何项目，任务未执行。请先在「设置 → 项目」中添加项目';
    db.taskExecution.add({
      task_id: task.id, task_title: task.title, status: 'FAILED',
      trigger_type: triggerType, start_time: start, end_time: start, error_message: msg,
    });
    db.task.update(task.id, { last_status: 'FAILED', last_run_at: start, status: 'pending' });
    sendNotification('❌ AI 任务未执行', task.title + '：' + msg);
    if (task.notify_feishu) await sendFeishu(`❌ AI 任务「${task.title}」未执行：${msg}`);
    notifyUI();
    return;
  }

  const execId = db.taskExecution.add({
    task_id: task.id, task_title: task.title, status: 'RUNNING',
    trigger_type: triggerType, start_time: start,
  }) as number | null;
  db.task.update(task.id, { status: 'in_progress', last_run_at: start, last_status: 'RUNNING' });
  notifyUI();
  const sessionId = 'task_' + task.id;
  try {
    const { buildReportToolDefs, buildDataToolDefs } = require('./tools');
    const customTools: any[] = [];

    // 笔记/知识任务：笔记库目录 + 数据集/报告工具集
    customTools.push(...(await buildReportToolDefs(undefined)));
    customTools.push(...(await buildDataToolDefs(notesDir)));

    const piAgent = require('./pi-agent');
    if (!task.session_id) {
      try {
        db.chat.createSession(sessionId, task.project_id && Number.isFinite(Number(task.project_id)) ? Number(task.project_id) : null, task.title.slice(0, 30), 'kb', 'pi', 'ui');
        db.task.update(task.id, { session_id: sessionId });
      } catch {}
    }
    // 对话记录落库：任务诉求作为 user 消息，结果/错误作为 assistant 消息，任务详情可见
    try { db.chat.addMessage(sessionId, 'user', task.prompt || task.title, 'general'); } catch {}
    const contextLine = noteProj ? `\n所属项目：${noteProj.name}（${noteProj.dir}）` : '';
    const prompt = `你正在执行一个 AI 任务「${task.title}」。${contextLine}\n\n${task.prompt || '请根据任务标题自主完成并直接输出结果。'}\n\n执行要求：\n1. 先用可用工具查询所需数据（任务、对话记录、文档、数据集、笔记、外网资料等），再完成任务\n2. 若任务涉及修改文件，直接在目标目录中完成\n3. 直接输出最终成果（Markdown 格式），不要输出过程说明、思考过程或"数据来源"等前缀`;
    // 模型口径：本次指定（重跑时选择）> 任务上保存的模型（创建/编辑时选择）> pi 默认模型
    const result = (await piAgent.generateTaskResult(sessionId, prompt, {
      taskModel: task.model || '',
      overrideModel: overrideModel || '',
    })).trim();
    const end = nowString();

    const savedNote = saveTaskResultToNote(task, result);
    const nextStatus = task.trigger_type === 'cycle' ? 'pending' : 'done';
    if (execId != null) db.taskExecution.update(execId, { status: 'SUCCESS', end_time: end, result_text: result, log_text: savedNote ? `已保存笔记：${savedNote}` : '' });
    db.task.update(task.id, { last_result: result.slice(0, 3000), last_status: 'SUCCESS', last_run_at: end, status: nextStatus });
    try { db.chat.addMessage(sessionId, 'assistant', result, 'general'); } catch {}

    sendNotification('✅ AI 任务完成', task.title);
    if (task.notify_feishu) {
      const feishuText = convertMarkdownForFeishu(result.slice(0, 1800));
      await sendFeishu({
        config: { wide_screen_mode: true },
        header: { template: 'blue', title: { tag: 'plain_text', content: `✅ AI 任务完成：${task.title}` } },
        elements: [
          { tag: 'markdown', content: `${savedNote ? `📝 已保存笔记：\`${savedNote}\`\n\n` : ''}${feishuText}` },
        ],
      });
    }
    notifyUI();
  } catch (e: any) {
    const end = nowString();
    if (execId != null) db.taskExecution.update(execId, { status: 'FAILED', end_time: end, error_message: (e && e.message) || String(e) });
    db.task.update(task.id, { last_status: 'FAILED', last_run_at: end, status: 'pending' });
    try { db.chat.addMessage(sessionId, 'assistant', '❌ ' + ((e && e.message) || String(e)), 'general'); } catch {}
    sendNotification('❌ AI 任务失败', task.title + '：' + ((e && e.message) || String(e)));
    if (task.notify_feishu) await sendFeishu(`❌ AI 任务「${task.title}」执行失败：${(e && e.message) || String(e)}`);
    notifyUI();
  }
}

/** 立即执行任务（手动触发 / 新建即执行 / 重跑）；overrideModel 为本次执行临时指定的模型 */
function executeTaskNow(id: number, overrideModel?: string) {
  const t = db.task.get(id);
  if (!t) return false;
  if (t.status === 'in_progress') return false;
  enqueueTask(t, 'manual', overrideModel);
  return true;
}

/** 手动触发一次提醒（测试用） */
function triggerReminderNow(id: string) {
  const r = db.reminder.get(id);
  if (!r) return false;
  const msg = '⏰ ' + r.name + (r.message ? '\n' + r.message : '');
  sendNotification('⏰ ' + r.name, r.message || '');
  (async () => { await sendFeishu(msg); })();
  return true;
}

function stop() {
  for (const [id, job] of jobs) {
    job.stop();
  }
  jobs.clear();
  running = false;
  execQueue = [];
  logger.info('[Scheduler] stopped');
}

function reload() {
  stop();
  start();
}

function isRunning() { return running; }

export { start, stop, reload, isRunning, addReminder, removeReminder, reloadTasks, removeTask, executeTaskNow, triggerReminderNow };