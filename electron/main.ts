import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// Suppress EPIPE errors from console (harmless when console pipe closes)
import { Console } from 'console';
(['log', 'warn', 'error', 'info', 'debug'] as Array<keyof Console>).forEach(method => {
  const orig = Console.prototype[method];
  (Console.prototype as any)[method] = function(...args: any[]) {
    try { return (orig as any).apply(this, args); } catch (e: any) { if (e && e.code !== 'EPIPE') throw e; }
  };
});
process.on('uncaughtException', (err: any) => {
  if (err && err.code === 'EPIPE') return;
});
process.on('unhandledRejection', (err: any) => {
  if (err && err.code === 'EPIPE') return;
});
// 流层面的 EPIPE 不会被 uncaughtException 捕获，需要直接绑定 error listener
for (const s of [process.stdout, process.stderr]) {
  if (s && typeof (s as any).on === 'function') {
    (s as any).on('error', (err: any) => { if (err && err.code === 'EPIPE') {} });
  }
}

// Polyfill for Electron: some deps expect worker_threads.markAsUncloneable.
// Must patch the REAL module exports object — `import * as wt` compiles to
// __importStar(require(...)) which wraps the exports and would hide the patch.
const wt = require('worker_threads') as any;
try {
  if (typeof wt.markAsUncloneable !== 'function') {
    wt.markAsUncloneable = () => {};
  }
} catch {} // worker_threads not available
import * as db from './services/database';
import { normalizeDatasetRecord } from './services/dataset-normalize';
import * as appConfig from './services/app-config';
import { runPi, listPiModels, generateDailyReport as piGenerateDailyReport, listBuiltinModelConfigs, saveBuiltinModelConfigs, testBuiltinModelConnection, syncDefaultModelSettings, abortSession, resetPiSession } from './services/pi-agent';
import { agentVersions } from './services/agent-versions';
import { buildDataToolDefs, appendTodoNote } from './services/tools';
import { followUpTask, followUpFeishuSession, buildKbPrompt } from './services/task-runner';
import * as aitool from './services/ai-tools';
import { listBuiltinSuites, applyBuiltinSuites, upgradeBuiltinSchemas } from './services/builtin-datasets';
import { getSearchConfig, saveSearchConfig, webSearch } from './services/search';
import * as backup from './services/backup';
import * as feishu from './services/feishu';
import { resolveFeishuTarget, bindChatToProject, buildProjectChoiceText, stashPendingBody, takePendingBody, markAskedChoice, isAwaitingChoice, clearAskedChoice, buildProjectButtons, boundProjectId, needsProjectChoice, stashPendingFollowup, peekPendingFollowup, clearPendingFollowup } from './services/feishu-router';
import * as scheduler from './services/scheduler';
import * as projectScan from './services/project-scan';
import logger from './services/logger';
import { relayClient, probeRelayHealth } from './services/relay-client';
import { extractDigest, syncCheckedDone } from './services/note-digest';
import * as relayDevice from './services/relay-device';
import { notify } from './services/notify';
import { createTrayIcon, getWindowIcon } from './icon';

const START_UPTIME = process.uptime();
function startupElapsed(label: string) {
  logger.info('[Startup] ' + label + ': +' + Math.round((process.uptime() - START_UPTIME) * 1000) + 'ms');
}

let mainWindow: Electron.BrowserWindow | null = null;
let tray: Electron.Tray | null = null;
let backgroundReady = false;

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

// ========== System Tray ==========

function createTray() {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('启航AI工作台 - 运行中');
  updateTrayMenu();
  tray.on('double-click', () => showWindow());
}

function updateTrayMenu(servicesStatus?) {
  const s = servicesStatus || {};
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => showWindow(),
    },
    { type: 'separator' },
    {
      label: `飞书机器人: ${s.feishu ? '● 运行中' : '○ 已停止'}`,
      click: () => mainWindow?.webContents.send('service:toggle', 'feishu'),
    },
    {
      label: `定时任务: ${s.scheduler ? '● 运行中' : '○ 已停止'}`,
      click: () => mainWindow?.webContents.send('service:toggle', 'scheduler'),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        stopAllServices();
        app.quit();
      },
    },
  ]);
  tray?.setContextMenu(contextMenu);
}

function showWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

// ========== Window ==========

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: '启航AI工作台',
    icon: getWindowIcon(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: 'hiddenInset',
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    show: false,
  });

  const isDev = process.argv.includes('--dev');
  if (isDev) {
    mainWindow!.loadURL('http://localhost:15174');
    mainWindow!.webContents.once('did-finish-load', () => {
      mainWindow!.webContents.openDevTools({ mode: 'detach' });
    });
  } else {
    // dist-electron/electron -> 项目根目录 dist/，需要向上两级
    mainWindow!.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  mainWindow!.once('ready-to-show', () => mainWindow!.show());
  mainWindow!.on('close', (event) => {
    if (!(app as any).isQuitting) {
      event.preventDefault();
      mainWindow!.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function stopAllServices() {
  feishu.stop();
  scheduler.stop();
}

function getServicesStatus() {
  return {
    feishu: feishu.isRunning(),
    scheduler: scheduler.isRunning(),
  };
}

function listDir(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const items: any[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      items.push({ name: entry.name, path: full, type: 'folder' });
    } else if (entry.isFile()) {
      items.push({ name: entry.name, path: full, type: 'file' });
    }
  }
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return items;
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ========== 飞书消息 → 项目路由 ==========
// 统一走 services/feishu-router.ts 的 resolveFeishuTarget：
// 显式指令 > 行内标记 > 开头项目名 > 会话绑定 > 单一项目 > 询问用户。
// 多项目且无线索时返回 needChoice，绝不静默落到默认项目。

/** 工单记录指令 → 确定性写入"项目工单"数据集（不经过 AI，保证落库） */
function parseWorkOrderRecord(text: string) {
  const m = text.match(/帮我记录\s*[：:]\s*([^\s，。；;]+?)(?:项目)?(工单|需求|BUG|bug)/)
    || text.match(/(?:帮我|请)记录\s*([^\s，。；;]+?)项目(工单|需求)/);
  if (!m) return null;
  const projectRaw = m[1].replace(/项目$/, '').trim();
  const content = text.slice((m.index || 0) + m[0].length).trim();
  if (!projectRaw || !content) return null;
  if (/^(这|那|一|该|把|给|一个|一条|一下)/.test(projectRaw)) return null;
  if (projectRaw === '项目' || projectRaw === m[2] || projectRaw === '无') return null;
  return { project: projectRaw, kind: m[2], content };
}

/** 按 "1、" "2、" 编号切分为多条工单；无编号则整段为一条 */
function splitWorkOrderItems(content: string): string[] {
  const segs = content.split(/(?=\d+\s*[、.．])/).map(s => s.trim()).filter(Boolean);
  return segs.length ? segs : [content];
}

/** 从工单文本中识别端（总部/商户/门店），未识别默认总部 */
function detectWorkOrderEnd(text: string): string {
  const found: string[] = [];
  for (const kw of ['总部', '商户', '门店']) {
    if (text.includes(kw) && !found.includes(kw)) found.push(kw);
  }
  return found.length ? found.join('、') : '总部';
}

// ========== 飞书卡片按钮回调 ==========
// 卡片回调事件里只有 chatId，没有 chatType；这里记住每个会话的类型，
// 供回调时构造伪消息走既有派活流程（/项目 N）。
const feishuChatTypes = new Map<string, string>();

// 飞书侧正在执行的会话（内存防重入）：飞书消息会话化后（2026-10-31）没有任务行可挂
// status，改用进程内集合——「继续」命中执行中的会话时直接婉拒。
const feishuRunningSessions = new Set<string>();

/** 发送飞书结果卡片：底部标注归属项目 + 「💬 接着问」按钮（点后直接回复即可续聊这条对话） */
function sendFeishuResultCard(msg: any, text: string, opts: { incomplete?: boolean; sid?: string; projectName?: string } = {}) {
  const prefix = opts.incomplete ? '⚠️ 任务被中止，以下为中断前的部分输出\n\n' : '';
  feishu.replyCard(msg, prefix + convertMarkdownForFeishu(text || '（无输出）'), opts.incomplete ? '⏱ 已中止（部分输出）' : '🤖 启航AI', {
    note: opts.projectName ? `本条已发到「${opts.projectName}」；点「接着问」后直接回复，可继续这条对话` : '',
    buttons: opts.sid
      ? [{ text: '💬 接着问', type: 'primary', value: { act: 'continue_task', sid: opts.sid } }]
      : [],
  });
}

// 卡片按钮点击 → 两种动作：选择项目（转「/项目#<id>」伪消息走派活链路）、
// 「接着问」（本会话进入该对话的续聊模式）。
// ⚠️ 飞书要求卡片回调 3 秒内响应，超时客户端弹「目标回调服务超时未响应」：
// 所以这里只做快速校验并返回 toast（点击即刻有反馈），真正的派活用 void 丢到
// 后台执行，绝不 await —— AI 任务以分钟计，回调响应等不起。
// 按钮不可用时（飞书后台未订阅卡片回调事件）用户仍可回复「/项目 N」，功能不丢。
feishu.setCardActionHandler(async (action: any) => {
  try {
    const v = action?.value;
    if (!v || typeof v !== 'object') return;
    const chatId = String(action.chatId || '');
    if (!chatId) return;

    // 「1. 项目名」/「就用当前项目」按钮：按项目 id 派活
    if (v.act === 'pick_project') {
      const pid = Number(v.pid);
      const proj = Number.isFinite(pid) ? db.project.get(pid) : null;
      if (!proj) {
        logger.warn('[Feishu] Card action: unknown project id %s', v.pid);
        return { toast: { type: 'error', content: '该项目不存在或已删除，请重新选择' } };
      }
      // 显式选项目 = 开始新话题，退出「接着问」模式
      clearPendingFollowup(chatId);
      const chatType = feishuChatTypes.get(chatId) || 'p2p';
      logger.info('[Feishu] Card action → 派活到项目「%s」(id=%s), chatType=%s', proj.name, proj.id, chatType);
      // 用「/项目#<id>」而不是「/项目 <id>」：后者序号优先，项目数 ≥ id 时会落到别的项目
      void feishuMessageHandler({
        text: `/项目#${proj.id}`,
        sender: action.operatorOpenId || '',
        chatId,
        chatType,
        messageId: action.messageId || '',
      }).catch((e: any) => logger.error('[Feishu] Card dispatch failed: %s', e?.message));
      return { toast: { type: 'success', content: `已派活到「${proj.name}」，执行中…` } };
    }

    // 「💬 接着问」按钮：本会话进入该对话的续聊模式，下一条普通消息接在其会话后面
    if (v.act === 'continue_task') {
      const sid = String(v.sid || '');
      const session = sid ? db.chat.getSession(sid) : null;
      if (!session) return { toast: { type: 'error', content: '原对话不存在，请重新发送消息' } };
      stashPendingFollowup(chatId, sid);
      return { toast: { type: 'info', content: '好的，直接回复你的追问，会接在这条对话后面（30 分钟内有效）' } };
    }
    return;
  } catch (e: any) {
    logger.error('[Feishu] Card action failed: %s', e?.message);
    return { toast: { type: 'error', content: '处理点击失败，请回复「/项目 名称」重试' } };
  }
});

const feishuMessageHandler = async (msg) => {
  logger.info('═══════════════════════════════════════');
  logger.info(' 飞书消息已接收');
  logger.info(' 发送者: %s', msg.sender);
  logger.info(' 内容: %s', msg.text);
  logger.info(' ChatId: %s', msg.chatId);
  logger.info('═══════════════════════════════════════');
  if (msg.chatId) feishuChatTypes.set(msg.chatId, msg.chatType || 'p2p');

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('feishu:message', msg);
  }

  // ===== 工作流指令：继续追问 =====
  const cmd = String(msg.text || '').trim();

  // 「继续 <内容>」：对最近的飞书对话追问（会话化后不再查任务表，
  // 按 source='feishu' 的最近会话定位；本飞书会话（群/私聊）优先、旧会话全局兜底）
  const cont = cmd.match(/^继续\s*[:：]?\s*([\s\S]*)$/);
  if (cont) {
    const question = (cont[1] || '').trim();
    if (!question) {
      feishu.replyCard(msg, '请在「继续」后写上你的要求，例如：继续 把刚才的报告补充一段风险说明', '💡 用法');
      return;
    }
    const lastSession: any = db.chat.latestBySource('feishu', msg.chatId);
    if (!lastSession) {
      feishu.replyCard(msg, '还没有可继续的飞书对话，请先发一条消息。', '⚠️ 无对话');
      return;
    }
    const sid = String(lastSession.session_id || '');
    if (feishuRunningSessions.has(sid)) {
      feishu.replyCard(msg, '该对话正在执行中，请稍候再试。', '⚠️ 执行中');
      return;
    }
    try {
      // 先入集合再发起：后台 IIFE 在微任务里启动，onDone/onError 都会移除；
      // 若会话不存在（返回 false）则立刻移除，保证集合状态与真实执行一致
      feishuRunningSessions.add(sid);
      // 飞书续聊的问题也要在桌面正在看的会话里即时出气泡（chat:done 会整段重拉兜底）
      sendToRenderer('chat:remote', { sessionId: sid, title: lastSession.title || '', text: question });
      const ok = await followUpFeishuSession(sid, question, db, {
        onDelta: (delta: string) => emitChatEvent('chat:delta', { sessionId: sid, text: delta }),
        onDone: (text, meta) => {
          feishuRunningSessions.delete(sid);
          emitChatEvent('chat:done', { sessionId: sid });
          sendFeishuResultCard(msg, text || '', { incomplete: meta?.incomplete, sid });
        },
        onError: (err) => {
          feishuRunningSessions.delete(sid);
          emitChatEvent('chat:error', { sessionId: sid, text: String(err) });
          feishu.replyCard(msg, `处理出错: ${err}`, '❌ 错误');
        },
      });
      if (ok) {
        feishu.replyCard(msg, '已接单，执行中…', '🤖 启航AI');
      } else {
        feishuRunningSessions.delete(sid);
        feishu.replyCard(msg, '找不到可继续的对话，请重新发一条消息。', '⚠️ 无对话');
      }
    } catch (e) {
      logger.error('[Feishu] Continue command error: %s', e.message);
      feishu.replyCard(msg, `处理出错: ${e.message}`, '❌ 错误');
    }
    return;
  }

  // 工单记录指令 → 确定性写入"项目工单"数据集（不经过 AI，保证落库）
  try {
    const wo = parseWorkOrderRecord(msg.text);
    if (wo) {
      let ds = db.ds.list().find(d => d.name === '项目工单') || null;
      if (!ds) {
        db.ds.add({
          name: '项目工单',
          description: '项目需求、BUG、优化跟踪',
          schemaJson: JSON.stringify({
            fields: [
              { name: '项目', type: 'string' }, { name: '端', type: 'string' },
              { name: '详细', type: 'string' }, { name: '优先级', type: 'string' },
            ],
            typeOptions: ['需求', 'BUG', '优化'],
            statusOptions: ['待处理', '已修复', '已发布', '已取消'],
          }),
        });
        ds = db.ds.list().find(d => d.name === '项目工单') || null;
      }
      if (ds) {
        const items = splitWorkOrderItems(wo.content);
        const inserted: number[] = [];
        for (const it of items) {
          db.ds.insert(ds.id, { 项目: wo.project, 端: detectWorkOrderEnd(it), 详细: it, 优先级: '中' });
          const r = db.qOne('SELECT id FROM data_center_records WHERE dataset_id = ? ORDER BY id DESC LIMIT 1', String(ds.id));
          if (r) inserted.push(r.id);
        }
        const summary = `✅ 已向「${ds.name}」数据集写入 ${inserted.length} 条工单（项目：${wo.project}）\n\n${items.map((it, i) => `${i + 1}. ${it.slice(0, 60)}${it.length > 60 ? '…' : ''}`).join('\n')}\n\n可在「数据中心 → 项目工单」中查看与编辑。`;
        // 工单本身点名了项目（「…金箔雲项目工单…」）→ 落到该项目；
        // 认不出来时退回默认项目，不阻断工单记录（工单里已单独存了项目字段）。
        const woTarget = resolveFeishuTarget({ text: `项目：${wo.project}`, chatId: msg.chatId, chatType: msg.chatType, db });
        const noteProj = woTarget.project
          || db.project.list().find(p => p.dir === (appConfig.getConfig('notesDir') || ''))
          || db.project.list()[0] || null;
        // 会话化（2026-10-31）：工单记录也是纯会话，不落 plan_tasks
        const sessionId = 'feishu_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        try { db.chat.createSession(sessionId, noteProj ? noteProj.id : null, msg.text.slice(0, 30), 'kb', 'pi', 'feishu', msg.chatId || ''); } catch {}
        db.chat.addMessage(sessionId, 'user', msg.text, 'general');
        db.chat.addMessage(sessionId, 'assistant', summary, 'general');
        feishu.replyCard(msg, convertMarkdownForFeishu(summary), '📋 工单已记录');
        return;
      }
    }
  } catch (e) {
    logger.error('[Feishu] Work order record error: %s', e.message);
    feishu.replyCard(msg, `❌ 工单记录失败：${e.message}`, '❌ 执行失败');
  }

  // 派活流程里已创建的会话 id：catch 里据它判断是否要把失败同步给对话页
  let activeSessionId: string | null = null;

  try {
    // ===== 「接着问」续聊：点过结果卡片「💬 接着问」后，本会话的普通消息接在那条对话的
    // 会话后面继续，不再每条新开会话。命令（/ 开头）与工单指令不在此列，仍走正常路由。
    if (msg.chatId && !cmd.startsWith('/')) {
      const followupSid = peekPendingFollowup(msg.chatId);
      if (followupSid) {
        if (feishuRunningSessions.has(followupSid)) {
          feishu.replyCard(msg, '该对话正在执行中，请等这轮回答完再发。', '⚠️ 执行中');
          return;
        }
        const followSession: any = db.chat.getSession(followupSid);
        if (!followSession) {
          clearPendingFollowup(msg.chatId);
          feishu.replyCard(msg, '原对话已不存在，请重新发送你的问题。', '⚠️ 无法接着问');
          return;
        }
        feishuRunningSessions.add(followupSid);
        // 飞书续聊的问题也要在桌面正在看的会话里即时出气泡（chat:done 会整段重拉兜底）
        sendToRenderer('chat:remote', { sessionId: followupSid, title: followSession.title || '', text: cmd });
        emitChatEvent('chat:status', { sessionId: followupSid, text: '飞书追加追问' });
        const ok = await followUpFeishuSession(followupSid, cmd, db, {
          onDelta: (delta: string) => emitChatEvent('chat:delta', { sessionId: followupSid, text: delta }),
          onTool: (toolEvent: any) => emitChatEvent('chat:tool', { sessionId: followupSid, ...toolEvent }),
          onDone: (text, meta) => {
            feishuRunningSessions.delete(followupSid);
            emitChatEvent('chat:done', { sessionId: followupSid });
            const followProj: any = followSession.project_id ? db.project.get(Number(followSession.project_id)) : null;
            sendFeishuResultCard(msg, text || '', { incomplete: meta?.incomplete, sid: followupSid, projectName: followProj ? followProj.name : '' });
          },
          onError: (err) => {
            feishuRunningSessions.delete(followupSid);
            emitChatEvent('chat:error', { sessionId: followupSid, text: String(err) });
            feishu.replyCard(msg, `处理出错: ${err}`, '❌ 错误');
          },
        });
        if (!ok) {
          feishuRunningSessions.delete(followupSid);
          clearPendingFollowup(msg.chatId);
          feishu.replyCard(msg, '原对话已不存在，请重新发送你的问题。', '⚠️ 无法接着问');
          return;
        }
        // 续聊成功 → 刷新滑动的 30 分钟窗口，接下来这条会话里可以继续直接追问
        stashPendingFollowup(msg.chatId, followupSid);
        feishu.replyCard(msg, '已接上原对话，执行中…', '🤖 启航AI');
        return;
      }
    }

    // ===== 项目路由：统一走 feishu-router；多项目且无线索时先问，绝不静默落默认项目 =====
    // awaitingChoice：机器人刚问过「落哪个项目」→ 允许只回一个裸数字
    const awaitingChoice = isAwaitingChoice(msg.chatId);
    const target = resolveFeishuTarget({ text: msg.text, chatId: msg.chatId, chatType: msg.chatType, db, awaitingChoice });
    const allProjects = db.project.list();

    if (!allProjects.length) {
      feishu.replyCard(msg, '⚠️ 请先在「设置 → 项目」中添加项目目录，配置完成后即可通过飞书派活。', '⚠️ 项目未配置');
      return;
    }

    if (needsProjectChoice(target, allProjects.length)) {
      // 统一先问：正文暂存 → 用户点按钮或回序号 → 自动执行挂起的那条消息。
      // 会话绑定不再静默执行，而是变成卡片上的默认选项「就用当前项目」。
      // 注意措辞不是「继续对话」：点它只是沿用绑定的项目执行本条消息，仍会新开会话；
      // 真正接着原会话聊的是结果卡片的「💬 接着问」按钮（continue_task）。
      const pendingBody = String(target.cleanText || '').trim();
      if (pendingBody && !/^\d{1,4}$/.test(pendingBody)) stashPendingBody(msg.chatId, pendingBody);
      markAskedChoice(msg.chatId);
      const boundId = boundProjectId(db, msg.chatId);
      const boundProj = boundId ? db.project.get(boundId) : null;
      const hint = boundProj
        ? `继续用当前会话的项目「${boundProj.name}」，还是换一个？`
        : (target.isCommand ? '' : '这条消息里没有识别出项目，为避免落错地方，需要你指定一下：');
      feishu.replyCard(msg, buildProjectChoiceText(allProjects, hint), '📂 请选择项目', {
        buttons: buildProjectButtons(allProjects, {
          keepLabel: boundProj ? `就用当前项目「${boundProj.name}」` : '',
          keepId: boundProj ? boundProj.id : null,
        }),
        note: '点按钮直接选中；也可回复序号或「/项目 名称」',
      });
      return;
    }

    const feishuProject = target.project;
    const feishuProjectId = feishuProject.id;
    const projectDir = String(feishuProject.dir || '');
    clearAskedChoice(msg.chatId);   // 项目已确定，不再处于「等待选择」状态

    // 正文：命令里带了正文就用它；只给了「/项目 N」则执行上一条被挂起的消息
    const stashedBody = msg.chatId ? takePendingBody(msg.chatId) : null;
    let bodyText = String(target.cleanText || '').trim();
    if (!bodyText) bodyText = stashedBody || '';
    if (!bodyText) {
      // 纯项目切换命令且没有待执行正文 → 回一句确认绑定结果即可
      feishu.replyCard(
        msg,
        `✅ 当前会话的默认上下文已切换为项目「${feishuProject.name}」，下一条消息会默认带出它（仍会再让你确认一次）。`,
        '📂 项目已切换'
      );
      return;
    }

    // 显式选定项目 → 写入会话绑定，作为本会话的默认上下文（下一条消息默认带出它，仍会确认一次）
    if (target.explicit && target.isCommand && msg.chatId) {
      bindChatToProject(db, msg.chatId, msg.chatType, feishuProjectId);
      logger.info('[Feishu] session bound: chatId=%s project=%s', msg.chatId, feishuProject.name);
    }

    feishu.replyMessage(msg, `已接单（项目：${feishuProject.name}），执行中…`);

    // 会话化（2026-10-31）：飞书消息不再落 plan_tasks，直接落纯会话（source='feishu'），
    // 对话页合并展示并带「飞书」徽标；任务页从此只保留后台调度任务。
    const sessionId = 'feishu_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    db.chat.createSession(sessionId, feishuProjectId, bodyText.slice(0, 30), 'kb', 'pi', 'feishu', msg.chatId || '');
    db.chat.addMessage(sessionId, 'user', bodyText, 'general');
    feishuRunningSessions.add(sessionId);
    activeSessionId = sessionId;
    logger.info(' SessionId: %s | project: %s (%s)', sessionId, feishuProject.name, feishuProjectId);

    const recordHint = /(记录|登记|新建).{0,16}(工单|需求|BUG)/.test(bodyText)
      ? '\n\n【记录要求】用户要求"记录/登记/新建 工单/需求/BUG"时，必须调用 insert_dataset_record 工具写入"项目工单"数据集（字段：项目、端、详细、优先级；一条工单一条记录），不要只写入笔记文件。'
      : '';
    // 检索由 agent 自己跑：用 bash（rg/find/grep）搜、用 read 读，直接对着项目目录操作。
    // 提示词骨架与「继续」/后台任务追问共用一份口径（task-runner.buildKbPrompt）。
    const prompt = buildKbPrompt(feishuProject.name, projectDir, bodyText) + recordHint;
    const toolDefs: any[] = [];
    // 数据集工具按目标项目目录绑定、cwd 也用目标项目目录，两者必须与落库的 project_id 同源，
    // 否则会出现「会话记在项目 B、AI 却读写项目 A 目录」的跨项目错位。
    toolDefs.push(...(await buildDataToolDefs(projectDir)));
    // 同步广播 chat:* 事件：对话页按 sessionId 消费这组事件，
    // 飞书轮次在软件内实时流式可见（列表 ⏳、气泡滚动），无需任何 UI 专项代码。
    emitChatEvent('chat:status', { sessionId, text: `已接单（项目：${feishuProject.name}）` });
    await runPi({
      prompt,
      sessionId,
      cwd: projectDir || undefined,
      customTools: toolDefs,
      // 不设超时（2026-10-31 用户决策）：300 秒硬超时会掐断活跃的长任务——
      // 曾把「查 4 个数据集 + 读笔记」任务干到一半的旁白当结果发出（[PiAgent] timeout 300000ms）。
      // 代价：模型限流(429)无限退避时会一直挂着，飞书端等不到回应；对话页列表会一直显示 ⏳。
      onDelta: (delta: string) => emitChatEvent('chat:delta', { sessionId, text: delta }),
      onTool: (toolEvent: any) => emitChatEvent('chat:tool', { sessionId, ...toolEvent }),
      onDone: (text, meta) => {
        logger.info('[Feishu] Sending card reply: "%s"', (text || '').slice(0, 200));
        feishuRunningSessions.delete(sessionId);
        if (text) {
          db.chat.addMessage(sessionId, 'assistant', text || '', 'general');
          // 底部标注归属项目 + 「💬 接着问」按钮：点后直接回复即可续聊这条对话，不再每条新开会话
          sendFeishuResultCard(msg, text || '', { incomplete: meta?.incomplete, sid: sessionId, projectName: feishuProject.name });
        }
        emitChatEvent('chat:done', { sessionId });
      },
      onError: (e) => {
        logger.error('[Feishu] Chat error: %s', e);
        feishuRunningSessions.delete(sessionId);
        feishu.replyCard(msg, `处理出错: ${e}`, '❌ 错误');
        emitChatEvent('chat:error', { sessionId, text: String(e) });
      },
    });
  } catch (e) {
    logger.error('[Feishu] Handler exception: %s', e.message);
    feishu.replyCard(msg, `处理出错: ${e.message}`, '❌ 错误');
    // 会话创建之后才可能走到执行异常：把失败同步给对话页，别让气泡一直转
    if (activeSessionId) {
      feishuRunningSessions.delete(activeSessionId);
      emitChatEvent('chat:error', { sessionId: activeSessionId, text: String(e?.message || e) });
    }
  }
};

function startFeishu(configData) {
  appConfig.saveConfig({ feishuAppId: configData.app_id || '', feishuAppSecret: configData.app_secret || '' });
  feishu.start(configData, feishuMessageHandler);
  updateTrayMenu(getServicesStatus());
}

// ========== IPC Handlers ==========

// --- Knowledge Base（多笔记库；config.notesDir = 默认库目录指针） ---

/** 维持不变量：config.notesDir ≡ 默认项目 dir；无项目则清空 */
function syncDefaultNotesDir() {
  const projects = db.project.list();
  const d = db.project.getDefault() || projects[0] || null;
  if (d) {
    db.project.setDefault(d.id);
    appConfig.setNotesDir(d.dir || '');
  } else {
    db.project.setDefault(0);
    appConfig.setNotesDir('');
  }
}

/** 启动迁移：旧版单库（config.notesDir）转正为默认项目；缺默认指针则补齐 */
function ensureNotesLibraryMigration() {
  const projects = db.project.list();
  const cfgDir = appConfig.getNotesDir();
  if (!projects.length && cfgDir) {
    db.project.add(path.basename(cfgDir) || '项目', 'note', cfgDir, '', '');
  }
  syncDefaultNotesDir();
}

/** 项目目录变更后无需重建索引 —— 概览看板改为实时扫盘，索引路线已整体下线 */

ipcMain.handle('kb:getDir', () => appConfig.getNotesDir());

ipcMain.handle('kb:list', () => {
  const defaultId = (db.project.getDefault() || {}).id;
  return db.project.list().map((p: any) => ({
    ...p,
    // 实时文件数（原先读索引表 kb_documents，索引路线已下线）
    docCount: projectScan.scanProject(p).length,
    isDefault: p.id === defaultId,
  }));
});

ipcMain.handle('kb:add', (_, { name, path: dirPath }) => {
  if (!dirPath) return { error: '请选择目录' };
  if (!fs.existsSync(dirPath)) return { error: '目录不存在' };
  const abs = path.resolve(dirPath);
  if (db.project.list().some((p: any) => p.dir && path.resolve(p.dir) === abs)) return { error: '该目录已在项目列表中' };
  const isFirst = !db.project.list().length;
  const r = db.project.add((name || '').trim() || path.basename(abs), 'note', abs, '', '');
  if (isFirst) db.project.setDefault(r.id);
  syncDefaultNotesDir();
  return db.project.get(r.id);
});

ipcMain.handle('kb:update', (_, { id, name, dir }) => {
  const p = db.project.get(id);
  if (!p) return { error: '项目不存在' };
  const patch: any = {};
  if (name !== undefined && String(name).trim()) patch.name = String(name).trim();
  if (dir !== undefined && dir) {
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs)) return { error: '目录不存在' };
    if (db.project.list().some((x: any) => x.id !== id && x.dir && path.resolve(x.dir) === abs)) return { error: '该目录已被其他项目使用' };
    patch.dir = abs;
  }
  if (!Object.keys(patch).length) return p;
  db.project.update(id, patch);
  if (patch.dir) {
    syncDefaultNotesDir();
  }
  return db.project.get(id);
});

ipcMain.handle('kb:setDir', (_, { dir }) => {
  // 兼容旧入口（首次配置门禁 NotesGate/WelcomeGuide）：无项目则建默认项目；有默认项目则改其目录
  if (!dir) return null;
  const projects = db.project.list();
  const abs = path.resolve(dir);
  if (!projects.length) {
    const p = db.project.add(path.basename(abs) || '项目', 'note', abs, '', '');
    db.project.setDefault(p.id);
    syncDefaultNotesDir();
    return db.project.get(p.id);
  }
  const d = db.project.getDefault() || projects[0];
  if (d.dir && path.resolve(d.dir) === abs) return db.project.get(d.id);
  db.project.update(d.id, { dir: abs });
  syncDefaultNotesDir();
  return db.project.get(d.id);
});

ipcMain.handle('kb:remove', (_, { id }) => {
  if (db.project.get(id)) {
    db.project.remove(id);
    syncDefaultNotesDir();
  }
  return { ok: true };
});

ipcMain.handle('kb:setDefault', (_, { id }) => {
  if (!db.project.get(id)) return { error: '项目不存在' };
  db.project.setDefault(id);
  syncDefaultNotesDir();
  return { ok: true };
});

ipcMain.handle('kb:getDefault', () => db.project.getDefault() || db.project.list()[0] || null);
ipcMain.handle('notes:tree', (_, { dir }) => {
  if (!dir || !fs.existsSync(dir)) return [];
  return listDir(dir);
});
ipcMain.handle('notes:treeChildren', (_, { dirPath }) => {
  return listDir(dirPath);
});
ipcMain.handle('notes:read', (_, { dir, filePath }) => {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: '项目目录不存在' };
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(dir, filePath);
  if (!fullPath.startsWith(dir)) return { ok: false, error: '路径越权' };
  if (!fs.existsSync(fullPath)) return { ok: false, error: '文件不存在' };
  try {
    const buf = fs.readFileSync(fullPath);
    const header = buf.slice(0, 2048);
    if (header.includes(0)) return { ok: false, error: '二进制文件无法预览' };
    const content = buf.toString('utf-8');
    return { ok: true, content, filePath: fullPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});



ipcMain.handle('kb:search', async (_, { dir, query }) => {
  try {
    if (!query || !dir || !fs.existsSync(dir)) return [];

    const exts = new Set(['.md','.txt','.json','.csv','.js','.ts','.vue','.css','.py','.sh','.yml','.yaml','.toml']);
    const results: any[] = [];
    const maxResults = 10;

    function walk(dirPath) {
      if (results.length >= maxResults) return;
      try {
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
          if (results.length >= maxResults) return;
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '.git') {
            walk(path.join(dirPath, entry.name));
          } else if (entry.isFile() && exts.has(path.extname(entry.name).toLowerCase())) {
            const fullPath = path.join(dirPath, entry.name);
            const relPath = path.relative(dir, fullPath);
            const content = fs.readFileSync(fullPath, 'utf-8');
            const lower = content.toLowerCase();
            const qLower = query.toLowerCase();
            if (lower.includes(qLower)) {
              const lines = content.split('\n');
              const matchLines: string[] = [];
              for (const line of lines) {
                if (matchLines.length >= 3) break;
                if (line.toLowerCase().includes(qLower)) {
                  matchLines.push(line);
                }
              }
              if (matchLines.length > 0) {
                results.push({
                  source: fullPath,
                  title: entry.name,
                  score: 1,
                  text: matchLines.join('\n'),
                  fullText: content,
                });
              }
            }
          }
        }
      } catch {}
    }
    walk(dir);
    return results.slice(0, maxResults);
  } catch {
    return [];
  }
});
// --- Module ---
ipcMain.handle('module:list', () => db.dm.list());
ipcMain.handle('module:get', (_, { id }) => db.dm.get(id));
ipcMain.handle('module:add', (_, { name, description, icon }) => db.dm.add(name, description, icon));
ipcMain.handle('module:update', (_, { id, data }) => db.dm.update(id, data));
ipcMain.handle('module:remove', (_, { id }) => db.dm.remove(id));

// --- Dataset ---
ipcMain.handle('ds:list', () => db.ds.list());
ipcMain.handle('ds:get', (_, { id }) => db.ds.get(id));
ipcMain.handle('ds:query', (_, { datasetId, conditions }) => db.ds.query(datasetId, conditions));
ipcMain.handle('ds:add', (_, params) => db.ds.add(params));
ipcMain.handle('ds:updateMeta', (_, { id, data }) => db.ds.updateMeta(id, data));

/** 按数据集 schema 的字段类型对记录值做校验与归一化（非法值抛错，由前端提示） */
function normalizeRecordBySchema(datasetId: string | number, record: any): any {
  if (!record) return record;
  const dsRow = db.qOne('SELECT schema_json FROM data_center_datasets WHERE id = ? OR dataset_id = ?', datasetId, datasetId);
  if (!dsRow || !dsRow.schema_json) return record;
  let schema: any = null;
  try { schema = JSON.parse(dsRow.schema_json); } catch { return record; }
  const fields = (schema && schema.fields) || [];
  const out: any = { ...record };
  for (const f of fields) {
    if (!f || !f.name || !f.type) continue;
    const raw = out[f.name];
    if (raw === undefined || raw === null || raw === '') continue;
    const label = f.displayName || f.name;
    const v = String(raw).trim();
    if (f.type === 'number' || f.type === 'money') {
      if (v === '') { delete out[f.name]; continue; }
      const n = Number(v);
      if (isNaN(n)) throw new Error(`字段「${label}」必须是数字，当前值: ${v}`);
      out[f.name] = n;
    } else if (f.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) && isNaN(Date.parse(v))) {
        throw new Error(`字段「${label}」必须是日期（如 2026-08-04），当前值: ${v}`);
      }
      out[f.name] = v.slice(0, 10);
    } else if (f.type === 'datetime') {
      if (isNaN(Date.parse(v))) {
        throw new Error(`字段「${label}」必须是日期时间，当前值: ${v}`);
      }
    } else if (f.type === 'select' && Array.isArray(f.options) && f.options.length) {
      if (!f.options.includes(v)) {
        throw new Error(`字段「${label}」的值不在选项列表中: ${v}`);
      }
    }
  }
  return out;
}

ipcMain.handle('ds:insert', (_, { datasetId, data }) => {
  const record = normalizeRecordBySchema(datasetId, normalizeDatasetRecord(datasetId, data || {}));
  return db.ds.insert(datasetId, record);
});
ipcMain.handle('ds:updateRecord', (_, { id, data }) => {
  const dsRow = db.qOne('SELECT dataset_id FROM data_center_records WHERE id = ?', id);
  const record = dsRow
    ? normalizeRecordBySchema(dsRow.dataset_id, normalizeDatasetRecord(dsRow.dataset_id, data || {}))
    : data;
  return db.ds.updateRecord(id, record);
});
ipcMain.handle('ds:deleteRecord', (_, { id }) => db.ds.deleteRecord(id));
ipcMain.handle('ds:remove', (_, { datasetId }) => db.ds.remove(datasetId));
ipcMain.handle('ds:suites:list', () => listBuiltinSuites());
ipcMain.handle('ds:suites:apply', (_, { ids }) => {
  try {
    return applyBuiltinSuites(ids || []);
  } catch (e: any) {
    return { applied: [], skipped: [], failed: [], error: (e && e.message) || String(e) };
  }
});

// --- Backup / Restore ---
ipcMain.handle('backup:create', async (_, { dir }) => {
  try { return { ok: true, ...(await backup.createBackup(dir || undefined)) }; }
  catch (e: any) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
});
ipcMain.handle('backup:list', () => backup.listBackups());
ipcMain.handle('backup:restore', async (_, { file }) => backup.restoreFromBackup(file || ''));
ipcMain.handle('backup:prune', async (_, { retention }) => {
  try { return { ok: true, removed: backup.pruneBackups(retention || 30) }; }
  catch (e: any) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
});
ipcMain.handle('backup:auto:set', (_, { enabled }) => {
  appConfig.saveConfig({ autoBackupEnabled: enabled ? '1' : '0' });
  if (enabled) backup.startAutoBackup(); else backup.stopAutoBackup();
  return { ok: true, enabled: !!enabled };
});
ipcMain.handle('backup:auto:status', () => ({
  enabled: backup.isAutoBackupEnabled(),
  retention: backup.getAutoRetention(),
  dir: backup.getBackupDir(),
}));
ipcMain.handle('backup:setDir', (_, { dir }) => {
  try {
    backup.setBackupDir(dir || '');
    return { ok: true, dir: backup.getBackupDir() };
  } catch (e: any) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
});
ipcMain.handle('backup:pickDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow!, {
    title: '选择备份目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});
ipcMain.handle('backup:pickFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow!, {
    title: '选择备份文件',
    properties: ['openFile'],
    filters: [{ name: '备份文件', extensions: ['db'] }],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});
ipcMain.handle('backup:deleteFile', async (_, { file }) => {
  try {
    const homeBackupDir = backup.getBackupDir();
    const normalized = path.resolve(file || '');
    if (!normalized.startsWith(homeBackupDir)) return { ok: false, error: '只允许删除备份目录内的文件' };
    if (fs.existsSync(normalized)) fs.unlinkSync(normalized);
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
});
ipcMain.handle('backup:openDir', async (_, { dir }) => {
  try {
    const d = dir || backup.getBackupDir();
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    const { shell } = require('electron');
    shell.openPath(d);
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
});

ipcMain.handle('ds:pendingRecords', () => {
  const datasets = db.q("SELECT id, name FROM data_center_datasets ORDER BY name");
  const result: any[] = [];
  for (const ds of datasets) {
    const records = db.q("SELECT id, data_json, created_at FROM data_center_records WHERE dataset_id = ? AND (record_status IS NULL OR record_status = '' OR record_status = 'pending') ORDER BY created_at DESC LIMIT 5", String(ds.id));
    if (records.length) {
      result.push({
        datasetName: ds.name,
        datasetId: ds.id,
        records: records.map(r => ({ id: r.id, ...JSON.parse(r.data_json || '{}'), _created_at: r.created_at })),
      });
    }
  }
  return result;
});

// --- Chat / Orchestrator ---
/**
 * 一轮对话的执行核心。
 * emit 决定这轮的增量事件播给谁：桌面走 sendToRenderer，
 * 移动端发起的轮次双播（既回中继，也让桌面窗口当场演出来）。
 */
async function runChatTurn(
  { question, sessionId, projectDir, images, agent, modelName }:
    { question: string; sessionId?: string; projectDir?: string; images?: any[]; agent?: string; modelName?: string },
  emit: (channel: string, data: any) => void,
) {
  const sid = sessionId || 'session_' + Date.now();
  const activeAgent = agent || 'general';
  try {
    db.chat.createSession(sid, null, null, 'general', activeAgent, 'ui');
    // 已存在会话幂等返回，这里补读一次拿到真实 mode / project（飞书会话为 kb）
    const sessionRow = db.chat.getSession(sid);

    const existing = db.chat.messages(sid);
    if (existing.length === 0) {
      const title = question.length > 30 ? question.slice(0, 30) + '...' : question;
      db.chat.updateSessionTitle(sid, title);
    }

    db.chat.addMessage(sid, 'user', question, activeAgent, images);

    // 移动端实时补上这条问题气泡 + 立刻同步镜像；等 chat.done 才推的话，
    // AI 工作期间移动端只能看到流式回答、看不到问的是什么
    relayClient.pushEvent('chat.user', { sessionId: sid, text: question });
    relayClient.syncSession(sid);
    relayClient.syncRecentMessages(sid, 1);

    // ===== 项目前置检查 =====
    // 查询事务/笔记/记录等本地知识类问题，若未添加项目则先引导用户配置，不再调用 AI
    if (isKBQuery(question) && !db.project.list().length) {
      emit('chat:status', { sessionId: sid, text: '需要项目支持...' });
      const guide = [
        '🤖 我需要先添加一个本地项目目录，才能查询这类本地知识/事务类内容。',
        '',
        '当前尚未添加任何项目，请先完成以下设置：',
        '',
        '1️⃣ 点击左侧「⚙️ 设置」进入设置页',
        '2️⃣ 在「📁 项目」中添加目录并保存',
        '',
        '配置完成后，再问我一次相同的问题就能正常查询啦。',
      ].join('\n');
      emit('chat:delta', { sessionId: sid, text: guide });
      emit('chat:done', { sessionId: sid });
      db.chat.addMessage(sid, 'assistant', guide, activeAgent);
      return;
    }

    // ===== AI 引擎 =====
    emit('chat:status', { sessionId: sid, text: 'AI 正在分析问题...' });
    let reply = '';
    let thinking = '';
    const turnStart = Date.now();

    // 收尾落库：思考过程与正文一起入库并随 chat:done 通告，移动端历史/实时才都有；
    // 推理型模型（如 sensenova flash-lite）偶尔把结论全写进思考、正文只吐换行，
    // 空白回复不落库，改成一条可操作的提示，桌面/移动端/库里三处看到的才一致
    const settleReply = () => {
      if (reply.trim()) {
        db.chat.addMessage(sid, 'assistant', reply, activeAgent, undefined, thinking, Date.now() - turnStart);
        return;
      }
      reply = '⚠️ 模型这一轮没有输出正文（结论都留在了思考过程里）。请重试一次，或在输入框下方换一个模型。';
      db.chat.addMessage(sid, 'assistant', reply, activeAgent, undefined, thinking, Date.now() - turnStart);
      emit('chat:delta', { sessionId: sid, text: reply });
    };

    // pi agent 引擎
    // 注入本地工具：数据集查询/项目文件读取/外网搜索（按会话上下文）
    const toolDefs: any[] = [];
    if (projectDir) {
      toolDefs.push(...(await buildDataToolDefs(projectDir)));
    }

    // 项目库会话（mode='kb'，飞书来源）在软件内续聊时，与飞书侧同一份提示词骨架：
    // pi 会话文件每轮只带本轮 prompt，上一轮的项目路径/AGENTS.md 约束不会自动延续
    let turnPrompt = question;
    if (sessionRow && sessionRow.mode === 'kb' && projectDir) {
      const proj = Number.isFinite(Number(sessionRow.project_id)) ? db.project.get(Number(sessionRow.project_id)) : null;
      turnPrompt = buildKbPrompt((proj && proj.name) || '', projectDir, question);
    }

    const modelPattern = piModelPattern(modelName);
    await runPi({
      prompt: turnPrompt,
      sessionId: sid,
      cwd: projectDir || undefined,
      modelPattern,
      images,
      customTools: toolDefs,
      onDelta: (delta) => {
        reply += delta;
        emit('chat:delta', { sessionId: sid, text: delta });
      },
      onThinking: (t) => {
        thinking += t;
        emit('chat:thinking', { sessionId: sid, text: t });
      },
      onTool: (toolEvent) => emit('chat:tool', { sessionId: sid, ...toolEvent }),
      onDone: () => {
        settleReply();
        emit('chat:done', { sessionId: sid, durationMs: Date.now() - turnStart });
      },
      onError: (err) => emit('chat:error', { sessionId: sid, text: err }),
    });
  } catch (err: any) {
    emit('chat:error', { sessionId: sid, text: err.message });
  }
}
ipcMain.handle('chat:send', (_, payload) => runChatTurn(payload, emitChatEvent));
ipcMain.handle('chat:session:create', (_, { id, projectId, title, mode, source, agent }) => {
  const sid = id || 'chat_' + Date.now();
  const row = db.chat.createSession(sid, projectId, title, mode || 'general', agent, source || 'ui');
  relayClient.syncSession(sid);
  return row;
});
ipcMain.handle('chat:session:list', (_, { projectId } = {}) => db.chat.sessions(projectId));
ipcMain.handle('chat:session:listByProject', (_, { projectId }) => db.chat.sessions(projectId));
ipcMain.handle('chat:session:listBySource', (_, { source, projectId }) => db.chat.sessionsBySource(source, projectId));
ipcMain.handle('chat:session:updateAgent', (_, { sessionId, agent }) => {
  db.chat.updateSessionAgent(sessionId, agent);
  relayClient.syncSession(sessionId);
});
ipcMain.handle('chat:session:updateProject', (_, { sessionId, projectId }) => {
  const n = (projectId === null || projectId === undefined || projectId === '') ? NaN : Number(projectId);
  if (!Number.isFinite(n) && projectId !== null && projectId !== undefined && projectId !== '') {
    return { ok: false, error: '无效的项目 ID' };
  }
  db.chat.updateSessionProject(sessionId, Number.isFinite(n) ? Math.trunc(n) : null);
  // 工作目录换了：丢掉缓存的 pi 会话，下一轮按新目录重建（历史仍从 jsonl 续上）
  resetPiSession(sessionId);
  relayClient.syncSession(sessionId);
  return { ok: true };
});
ipcMain.handle('chat:session:messages', (_, { sessionId }) => db.chat.messages(sessionId));
ipcMain.handle('chat:session:delete', (_, { sessionId }) => {
  db.chat.deleteSession(sessionId);
  relayClient.syncSessionDeleted(sessionId);
});
ipcMain.handle('chat:session:updateTitle', (_, { sessionId, title }) => {
  db.chat.updateSessionTitle(sessionId, title);
  relayClient.syncSession(sessionId);
});

// ========== 移动端远程连接（中继） ==========

/** 一轮对话的广播：桌面窗口演一遍，同时把事件推给中继转移动端并刷新服务端镜像 */
function emitChatEvent(channel: string, data: any): void {
  sendToRenderer(channel, data);
  relayClient.mirrorRendererEvent(channel, data);
}

/** 会话的真实工作目录：只认桌面这台机器上的项目记录，绝不用移动端传来的 projectDir */
function sessionProjectDir(row: any): string {
  if (!row || row.project_id === null || row.project_id === undefined) return '';
  const p: any = db.project.get(row.project_id);
  return p && p.dir ? p.dir : '';
}

/** 中继/移动端的会话形状（字段名沿用三端约定：sessionId/adapterId） */
function toMobileSession(row: any) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    title: row.title || '新对话',
    adapterId: row.active_agent || 'pi',
    modelId: row.model_id || null,
    status: 'active',
    kind: 'chat',
    ended: 0,
  };
}

/** 点通知：把窗口捞回前台并跳到那条会话 */
function openSessionFromRemote(sessionId: string): void {
  showWindow();
  sendToRenderer('nav:open-session', { sessionId });
}

/** 移动端发来的一条消息：桌面窗口即时补上这条气泡，并弹系统通知 */
function announceMobileMessage(sessionId: string, title: string, text: string): void {
  sendToRenderer('chat:remote', { sessionId, title, text });
  const preview = String(text || '').replace(/\s+/g, ' ').trim();
  notify(
    `📱 移动端消息 · ${title || '新对话'}`,
    preview.length > 60 ? preview.slice(0, 60) + '…' : preview,
    () => { openSessionFromRemote(sessionId); },
  );
}

/**
 * 移动端会经中继打过来的 RPC。
 * 只实现本仓库真正具备的能力；没有对等机制的方法明确拒绝，不静默返回成功。
 */
function registerRelayRpc(): void {
  relayClient.registerHandler('chat.create', (p: any) => {
    const sid = 'chat_' + Date.now();
    const row = db.chat.createSession(sid, p?.projectId, p?.title || '新对话', 'general', p?.agent || 'pi', 'ui');
    relayClient.syncSession(sid);
    sendToRenderer('chat:created', { sessionId: sid });
    return toMobileSession(row);
  });

  relayClient.registerHandler('chat.send', (p: any) => {
    const text = String(p?.text || '').trim();
    if (!text) throw new Error('消息内容为空');
    let row: any = db.chat.getSession(String(p.sessionId));
    if (!row) {
      // 桌面删掉的会话在中继是残留的，移动端仍能点进来：按原 id 在桌面重建，用桌面自己的项目目录
      const proj: any = p?.projectId ? db.project.get(Number(p.projectId)) : null;
      if (!proj) throw new Error('会话在桌面端已删除，且桌面端已无该项目，无法重建');
      row = db.chat.createSession(String(p.sessionId), proj.id, p?.title || '新对话', 'general', p?.agent || 'pi', 'ui');
      relayClient.syncSession(String(p.sessionId));
      sendToRenderer('chat:created', { sessionId: String(p.sessionId) });
    }
    announceMobileMessage(String(p.sessionId), row.title || '新对话', text);
    void runChatTurn({
      question: text,
      sessionId: String(p.sessionId),
      projectDir: sessionProjectDir(row),
      images: Array.isArray(p?.images) ? p.images : undefined,
      agent: p?.agent || row.active_agent || 'pi',
      modelName: row.model_id || undefined,
    }, emitChatEvent).finally(() => {
      // 这一轮跑完（含出错）：让渲染层重拉该会话，桌面才补得上移动端的问答
      sendToRenderer('chat:remote-settled', { sessionId: String(p.sessionId) });
    });
    // 立即回执：内容经 chat.delta/status/done 事件流回传，避免移动端 RPC 超时
    return { ok: true };
  });

  relayClient.registerHandler('chat.switch-agent', (p: any) => {
    db.chat.updateSessionAgent(String(p.sessionId), String(p.agent || 'pi'));
    relayClient.syncSession(String(p.sessionId));
    return { ok: true };
  });

  relayClient.registerHandler('chat.select-model', (p: any) => {
    const modelId = String(p.modelId || '');
    db.chat.updateSessionModel(String(p.sessionId), modelId === 'auto' ? '' : modelId);
    relayClient.syncSession(String(p.sessionId));
    return { ok: true };
  });

  relayClient.registerHandler('chat.list-models', async () => {
    const res = await listPiModels();
    return res.models || [];
  });

  relayClient.registerHandler('chat.stop', async (p: any) => {
    const sid = String(p?.sessionId || '');
    await abortSession(sid);
    return { ok: true };
  });

  // 本仓库的对话内核不向用户反问（工具自动放行），没有待答交互
  relayClient.registerHandler('chat.interactions', () => []);
  relayClient.registerHandler('chat.answer', () => {
    throw new Error('桌面端当前没有待回答的 AI 反问');
  });
}

// 启动接线：注册 RPC + 中继事件旁路 + 按已保存的中继地址建连
function startRelay(): void {
  registerRelayRpc();
  // 移动端「发测试消息给桌面端」走的是中继事件帧，不是 RPC：只弹系统通知。
  // 渲染层只有停在设置页时才挂着，不弹系统通知的话离开那页就毫无线索。
  relayClient.onRelayEvent((event, data) => {
    if (event !== 'test:message') return;
    const sentAt = Number(data?.ts) || Date.now();
    notify(
      '📲 收到移动端测试消息',
      `${data?.name || '移动端'} · ${new Date(sentAt).toLocaleTimeString('zh-CN', { hour12: false })}`,
    );
  });
  const saved = relayDevice.load();
  // 从没配过中继地址就不建设备文件、不发起任何外连
  if (!saved || !saved.relayUrl) return;
  void relayClient.start(saved.relayUrl);
}

ipcMain.handle('relay:status', () => relayClient.status());
ipcMain.handle('relay:probe', (_, { url }) => probeRelayHealth(String(url || '')));
ipcMain.handle('relay:set-url', async (_, { url }) => {
  try {
    const device = await relayClient.setRelayUrl(String(url || ''));
    const probed = await relayClient.waitForConnected(8000);
    return { ok: true, device, connected: probed.connected, error: probed.error };
  } catch (e: any) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
/** 设置/修改连接密码并开启：密码由中继判全库唯一，被拒时本机不改任何状态 */
ipcMain.handle('relay:enable', async (_, { password, url }) => {
  try {
    const device = await relayClient.enableWithPassword(String(password || ''), String(url || ''));
    const probed = await relayClient.waitForConnected(8000);
    return { ok: true, device, connected: probed.connected, error: probed.error };
  } catch (e: any) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle('relay:disable', async () => {
  try {
    return { ok: true, device: await relayClient.setRemoteEnabled(false) };
  } catch (e: any) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle('relay:clients', () => relayClient.listMobileClients());
ipcMain.handle('relay:kick', (_, { sessionId }) => relayClient.kickMobileClient(String(sessionId || '')));

// 判断是否为「查询本地知识」类问题（如事务/笔记/待办/记录/知识检索）。
// 这类问题依赖笔记库，若未配置笔记库则先引导用户去设置。
function isKBQuery(text) {
  const t = String(text || '');
  if (t.length < 3) return false;
  // 含查询动作 且 主题与本地知识/事务相关
  const action = /(查|查询|查一下|查看|找|找找|看看|搜索|搜|回顾|找一下|查看|了解|翻翻|搜一搜|查一下)/;
  const subject = /(事务|笔记|记录|待办|日程|计划|资料|文档|文件|目录|安排|总结|周报|项目|会议|事项|知识|数据记录)/;
  return action.test(t) && subject.test(t);
}

// 模型映射：pi 原生 pattern 直传，其余用 pi 默认模型
function piModelPattern(modelName) {
  if (modelName && modelName.includes('/')) return modelName;
  return undefined;
}

// --- AI 引擎模型列表 ---
ipcMain.handle('pi:models', async () => listPiModels());

// --- AI 引擎版本检测 ---
ipcMain.handle('agent:versions', () => agentVersions());

// 对话模型配置（应用内配置，读写 ~/.pi/agent/models.json，支持多条 provider）
ipcMain.handle('pi:config:get', () => {
  return listBuiltinModelConfigs();
});
ipcMain.handle('pi:config:set', async (_, { providers }) => {
  if (!Array.isArray(providers)) {
    return { ok: false, error: '参数错误' };
  }
  await saveBuiltinModelConfigs(providers);
  return { ok: true };
});
ipcMain.handle('pi:config:test', async (_, { baseUrl, apiKey, modelName }) => {
  return testBuiltinModelConnection({ baseUrl: String(baseUrl || ''), apiKey: String(apiKey || ''), modelName: String(modelName || '') });
});

// --- 网络搜索配置（免费多引擎默认可用，可选配博查/Serper API Key 增强） ---
ipcMain.handle('search:config:get', () => getSearchConfig());
ipcMain.handle('search:config:set', async (_, { provider, apiKey }) => {
  try {
    saveSearchConfig({ provider: String(provider || 'auto'), apiKey: String(apiKey || '') });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle('search:test', async () => {
  try {
    const cfg = getSearchConfig();
    const text = await webSearch('启航 AI 工作台', 3);
    return { ok: !text.startsWith('搜索失败') && !text.includes('未找到'), source: cfg.apiKey ? cfg.provider : '免费引擎', text: text.slice(0, 200) };
  } catch (e: any) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

// --- Projects ---
ipcMain.handle('project:list', (_, { type } = {}) => db.project.list(type));
ipcMain.handle('project:get', (_, { id }) => db.project.get(id));
ipcMain.handle('project:add', (_, { name, type, dir, description, defaultBranch }) => {
  const result = db.project.add(name, type || 'note', dir, description, defaultBranch);
  relayClient.syncProject(result.id);
  return result;
});
ipcMain.handle('project:update', (_, { id, data }) => {
  db.project.update(id, data);
  relayClient.syncProject(id);
});
ipcMain.handle('project:delete', (_, { id }) => {
  db.project.remove(id);
  relayClient.syncProjectDeleted(id);
});

// --- Agent Status ---
ipcMain.handle('agent:status', async () => {
  const models = await listPiModels();
  return { pi: { configured: models.models && models.models.length > 0, models: models.models } };
});

// --- Service Management ---
ipcMain.handle('service:status', () => getServicesStatus());
ipcMain.handle('service:startFeishu', async (_, configData) => {
  startFeishu(configData);
  return true;
});
ipcMain.handle('service:stopFeishu', () => {
  feishu.stop();
  updateTrayMenu(getServicesStatus());
  return true;
});
ipcMain.handle('service:startScheduler', () => {
  scheduler.start();
  updateTrayMenu(getServicesStatus());
  return true;
});
ipcMain.handle('service:stopScheduler', () => {
  scheduler.stop();
  updateTrayMenu(getServicesStatus());
  return true;
});
ipcMain.handle('service:reloadScheduler', () => {
  scheduler.reload();
  return true;
});

ipcMain.handle('reminder:list', () => db.reminder.list());
ipcMain.handle('reminder:add', (_, data) => {
  const r = db.reminder.add(data);
  const rem = db.reminder.get(r.id);
  if (rem && rem.enabled) scheduler.addReminder(rem);
  return r;
});
ipcMain.handle('reminder:update', (_, id, data) => {
  db.reminder.update(id, data);
  scheduler.removeReminder(id);
  const rem = db.reminder.get(id);
  if (rem && rem.enabled) scheduler.addReminder(rem);
  return true;
});
ipcMain.handle('reminder:remove', (_, id) => {
  db.reminder.remove(id);
  scheduler.removeReminder(id);
  return true;
});
ipcMain.handle('reminder:setEnabled', (_, id, enabled) => {
  db.reminder.setEnabled(id, enabled);
  scheduler.reload();
  return true;
});
ipcMain.handle('todo:list', () => db.task.list());
ipcMain.handle('todo:add', (_, data) => {
  const r = db.task.add({ ...data, trigger_type: 'manual', source: 'ui' });
  const note = appendTodoNote(data?.project_id ?? null, data?.title || '');
  if (!note.ok) logger.warn('[todo:add] 待办落笔记失败: ' + note.error);
  return r;
});
ipcMain.handle('todo:update', (_, id, data) => { db.task.update(id, data); return true; });
ipcMain.handle('todo:remove', (_, id) => { db.task.remove(id); return true; });

// --- 笔记提炼（概览「来自笔记」） ---
ipcMain.handle('noteDigest:extract', () => extractDigest());
ipcMain.handle('noteDigest:syncDone', () => {
  const touched = syncCheckedDone();
  if (touched.length) {
    scheduler.reloadTasks();
    for (const id of touched) relayClient.syncTask(id);
  }
  return { touched: touched.length };
});

// --- AI 自执行任务 ---
ipcMain.handle('task:list', () => db.task.list());
ipcMain.handle('task:add', (_, data) => {
  const r = db.task.add({ ...data, source: data.source || 'ui' });
  const note = appendTodoNote(data?.project_id ?? null, data?.title || '');
  if (!note.ok) logger.warn('[task:add] 待办落笔记失败: ' + note.error);
  scheduler.reloadTasks();
  relayClient.syncTask(r.id);
  return r;
});
ipcMain.handle('task:update', (_, id, data) => {
  db.task.update(id, data);
  scheduler.reloadTasks();
  relayClient.syncTask(id);
  return true;
});
ipcMain.handle('task:remove', (_, id) => {
  const t = db.task.get(id);
  if (t && t.task_type === 'daily_report') throw new Error('内置的「生成综合日报」任务不可删除，可在任务页暂停它');
  db.task.remove(id);
  scheduler.removeTask(id);
  return true;
});
ipcMain.handle('task:execute', (_, id) => scheduler.executeTaskNow(id));
ipcMain.handle('task:followup', (_, { taskId, question, model }) => followUpTask(taskId, question, db, { model }));
ipcMain.handle('task:executions', (_, taskId) => db.taskExecution.listByTask(taskId));
ipcMain.handle('task:execution:list', (_, page, pageSize) => db.taskExecution.list(page, pageSize));
ipcMain.handle('task:execution:get', (_, id) => db.taskExecution.get(id));
ipcMain.handle('reminder:test', (_, id) => scheduler.triggerReminderNow(id));

// --- 内置日报任务 ---
/**
 * 确保存在内置的「生成综合日报」任务（task_type='daily_report'，source='system'）。
 * 初始为 paused 且未绑定笔记库（用户绑定笔记库并开启后才参与调度）；
 * 老用户此前在设置页保存的日报提示词（daily_report_prompt）在此一次性迁入任务 prompt。
 */
function ensureDailyReportTask() {
  try {
    const existing = db.qOne("SELECT id FROM plan_tasks WHERE task_type = 'daily_report' LIMIT 1");
    if (existing) return;
    const migratedPrompt = appConfig.getConfig('daily_report_prompt') || '';
    db.task.add({
      title: '生成综合日报',
      prompt: migratedPrompt,
      description: '内置任务：每天定时聚合所有笔记库与数据集生成综合日报，展示在「今天」页，可推送飞书。绑定笔记库并开启后生效。',
      task_type: 'daily_report',
      source: 'system',
      status: 'paused',
      project_id: null,
      trigger_type: 'cycle',
      cycle_type: 'daily',
      cycle_time: '22:00',
      notify_feishu: 1,
    });
    logger.info('[Startup] Seeded built-in daily report task (paused, unbound)');
  } catch (e: any) {
    logger.error('[Startup] ensureDailyReportTask failed: ' + (e.message || e));
  }
}

// --- Archive ---

// 生成模块级业务分析报告（基于模块下所有数据集的业务内容）— 保留旧接口兼容
ipcMain.handle('archive:report', async (_, { moduleId }) => {
  const mod = db.dm.get(moduleId);
  if (!mod) return { ok: false, error: '模块不存在' };
  const dsRows = db.q('SELECT id, name, description FROM data_center_datasets WHERE module_id = ?', moduleId);
  if (!dsRows.length) return { ok: false, error: '该模块下无数据集' };
  let businessData = '';
  let totalRecords = 0;
  for (const dsRow of dsRows) {
    const rows = db.ds.query(dsRow.id, null);
    totalRecords += rows.length;
    if (rows.length > 0) {
      businessData += `\n\n### 数据集：${dsRow.name}${dsRow.description ? '（' + dsRow.description + '）' : ''}\n\n`;
      for (const r of rows) {
        const data = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : r;
        const fields = Object.entries(data)
          .filter(([k, v]) => v !== null && v !== '' && typeof v === 'string')
          .map(([k, v]) => `${k}: ${v}`)
          .join('；') || JSON.stringify(data);
        businessData += `- ${fields}\n`;
      }
    }
  }
  if (!businessData.trim()) businessData = '该模块下所有数据集暂无记录';
  const dsNames = dsRows.map(d => d.name).join('、');
  const prompt = `你是一位业务分析专家。以下是业务模块「${mod.name}」中的业务数据，请从**业务运营角度**进行深度分析：\n\n日期：${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)}\n\n模块：${mod.name}\n包含数据项：${dsNames}\n\n业务数据：\n${businessData}\n\n请生成一份面向业务管理者的分析报告，包含：\n1. 业务整体概况 — 当前业务状态与关键指标\n2. 核心业务洞察 — 从数据中发现的业务趋势、问题和机会\n3. 关键事件与进展 — 值得关注的业务动态\n4. 风险与预警 — 潜在风险点及需关注的事项\n5. 行动建议 — 可落地的业务优化建议`;
  try {
    const content = await piGenerateDailyReport('archive_' + Date.now(), prompt);
    return { ok: true, content };
  } catch (e: any) {
    return { ok: false, error: e.message || '生成失败' };
  }
});

// 生成模块级 AI 业务分析并保存到 ai_analysis（新版）
ipcMain.handle('archive:moduleAnalysis', async (_, { moduleId, force }) => {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const mod = db.dm.get(moduleId);
  if (!mod) return { ok: false, error: '模块不存在' };

  if (!force) {
    const existing = db.qOne("SELECT * FROM ai_analysis WHERE module_id = ? AND type = 'module_analysis' AND report_date = ? ORDER BY created_at DESC LIMIT 1", moduleId, today);
    if (existing) {
      return { ok: true, content: existing.content, moduleId, date: today, fromCache: true, analysisId: existing.id };
    }
  }

  const dsRows = db.q('SELECT id, name, description, schema_json FROM data_center_datasets WHERE module_id = ?', moduleId);
  if (!dsRows.length) return { ok: false, error: '该模块下无数据集' };

  let businessData = '';
  let totalRecords = 0;
  let dsSummary: any[] = [];

  for (const dsRow of dsRows) {
    const rows = db.ds.query(dsRow.id, null);
    const count = (db.qOne("SELECT COUNT(*) as c FROM data_center_records WHERE dataset_id = ?", String(dsRow.id)) || {}).c || 0;
    totalRecords += count;
    dsSummary.push({ name: dsRow.name, count, description: dsRow.description });

    if (rows.length > 0) {
      businessData += `\n### 数据集：${dsRow.name}（共${count}条记录）\n`;
      for (const r of rows) {
        const data = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : r;
        const fields = Object.entries(data)
          .filter(([k, v]) => v !== null && v !== '' && typeof v === 'string')
          .map(([k, v]) => `${k}: ${v}`)
          .join('；') || JSON.stringify(data);
        businessData += `- ${fields}\n`;
      }
    } else {
      businessData += `\n### 数据集：${dsRow.name}（暂无记录）\n`;
    }
  }

  const dsNames = dsSummary.map(d => d.name).join('、');
  const prompt = `你是一位深谙业务运营的资深分析师。请对以下业务模块进行深度分析，要求从业务规律、运营健康度、增长机会等角度出发，给出有洞察力的分析：

模块名称：${mod.name}
模块描述：${mod.description || '无'}
分析日期：${today}
包含数据集：${dsNames}
数据总量：${totalRecords}条

业务数据详情：
${businessData}

请生成一份业务分析报告，要求：
1. **业务整体概况** — 当前业务状态、关键指标、数据量级
2. **业务规律与趋势** — 从数据中发现业务规律，例如：更新频率如何、多久没有更新了、哪些类型的数据最多、数据分布有何特点
3. **运营健康度评估** — 数据完整性、时效性、活跃度评估
4. **关键发现** — 值得关注的业务动态、异常或潜在问题
5. **业务建议** — 可落地的具体行动建议，例如：建议补充哪些数据、如何优化业务流程、下一步可以关注什么

注意：语言要专业务实，用中文，避免空泛套话，基于实际数据说话。`;

  try {
    const content = await piGenerateDailyReport('module_' + Date.now(), prompt);
    if (content) {
      const analysisId = db.aa.save(moduleId, 'module_analysis', content, prompt, today);
      return { ok: true, content, moduleId, date: today, fromCache: false, analysisId };
    }
    return { ok: false, error: '生成内容为空' };
  } catch (e: any) {
    return { ok: false, error: e.message || '生成失败' };
  }
});

// 获取模块最新分析
ipcMain.handle('archive:moduleAnalysisLatest', async (_, { moduleId }) => {
  const analysis = db.aa.latestByModule(moduleId);
  return { ok: true, analysis };
});

// 获取模块分析历史
ipcMain.handle('archive:moduleAnalysisList', async (_, { moduleId }) => {
  const list = db.aa.listByModule(moduleId);
  return { ok: true, list };
});

// 将分析结果存档到默认项目目录
ipcMain.handle('archive:saveAnalysisToNotes', async (_, { moduleId, analysisId }) => {
  const analysis = db.aa.get(analysisId);
  if (!analysis) return { ok: false, error: '分析记录不存在' };
  const mod = db.dm.get(moduleId);
  if (!mod) return { ok: false, error: '模块不存在' };

  const notesDir = appConfig.getNotesDir() || ((db.project.getDefault() || db.project.list()[0] || {}) as any).dir || '';
  if (!notesDir) return { ok: false, error: '尚未添加任何项目' };

  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const fileName = `数据模块分析-${mod.name}-${today}.md`;
  const filePath = path.join(notesDir, fileName);
  const content = `# 数据模块业务分析报告\n\n**模块**: ${mod.name}\n**日期**: ${today}\n\n---\n\n${analysis.content}\n`;

  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { ok: true, filePath };
  } catch (e: any) {
    return { ok: false, error: '保存失败: ' + e.message };
  }
});

// 获取模块概览数据（含数据集、最近记录、分析摘要）
ipcMain.handle('archive:moduleOverview', async (_, { moduleId }) => {
  const mod = db.dm.get(moduleId);
  if (!mod) return { ok: false, error: '模块不存在' };
  const dsRows = db.q('SELECT id, name, description, schema_json, created_at FROM data_center_datasets WHERE module_id = ? ORDER BY created_at DESC', moduleId);
  const datasets = dsRows.map(dsRow => {
    const count = (db.qOne("SELECT COUNT(*) as c FROM data_center_records WHERE dataset_id = ?", String(dsRow.id)) || {}).c || 0;
    const recentRows = db.q("SELECT id, data_json, created_at FROM data_center_records WHERE dataset_id = ? ORDER BY created_at DESC LIMIT 5", String(dsRow.id));
    const recentRecords = recentRows.map(r => ({ id: r.id, ...JSON.parse(r.data_json || '{}'), _created_at: r.created_at }));
    return {
      datasetId: dsRow.id,
      name: dsRow.name,
      description: dsRow.description,
      schema: dsRow.schema_json ? JSON.parse(dsRow.schema_json) : null,
      recordCount: count,
      recentRecords,
    };
  });
  const analysis = db.aa.latestByModule(moduleId);
  return { ok: true, module: mod, datasets, analysis };
});

ipcMain.handle('insights:stats', () => {
  // 文件相关数字改为实时扫盘（索引路线已下线，kb_documents / kb_chunks 不再是数据源）
  const scan = projectScan.collectStats();
  const totalChats = (db.qOne("SELECT COUNT(*) as c FROM prj_messages") || {}).c || 0;
  const projectCount = (db.qOne("SELECT COUNT(*) as c FROM prj_projects") || {}).c || 0;
  const todoPending = (db.qOne("SELECT COUNT(*) as c FROM plan_tasks WHERE status IN ('pending','in_progress') AND IFNULL(task_type, '') != 'coding'") || {}).c || 0;
  const todoOverdue = (db.qOne("SELECT COUNT(*) as c FROM plan_tasks WHERE scheduled_start != '' AND scheduled_start < datetime('now', '+8 hours') AND status IN ('pending','in_progress') AND IFNULL(task_type, '') != 'coding'") || {}).c || 0;
  const remindersActive = (db.qOne("SELECT COUNT(*) as c FROM plan_reminders WHERE enabled = 1") || {}).c || 0;
  const todayDataRecords = (db.qOne("SELECT COUNT(*) as c FROM data_center_records WHERE created_at >= datetime('now', '+8 hours', 'start of day')") || {}).c || 0;
  return {
    fileCount: scan.fileCount,
    notesFileCount: scan.fileCount,
    todayModified: scan.todayModified,
    totalChats, projectCount, todoPending, todoOverdue, remindersActive, todayDataRecords,
  };
});
ipcMain.handle('insights:reports', () => {
  return db.q("SELECT id, type, report_date, content, substr(content, 1, 100) as summary, created_at FROM ai_analysis WHERE type = 'daily_report' ORDER BY created_at DESC LIMIT 10");
});
ipcMain.handle('insights:reportGenerating', () => {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const existing = db.qOne("SELECT id FROM ai_analysis WHERE type = 'daily_report' AND report_date = ?", today);
  return { generating: !existing };
});
ipcMain.handle('insights:weeklyReports', () => {
  return db.q("SELECT id, type, report_date, content, substr(content, 1, 100) as summary, created_at FROM ai_analysis WHERE type = 'weekly_report' ORDER BY created_at DESC LIMIT 10");
});
ipcMain.handle('insights:subProjects', () => {
  // 实时扫盘：按项目根下的一级子目录归类（原先读索引表 kb_documents）
  return projectScan.collectSubProjects();
});
ipcMain.handle('insights:tags', () => {
  // 实时扫盘：frontmatter tags + 正文 #话题（原先读索引表内容副本）
  return projectScan.collectTags();
});
ipcMain.handle('insights:heatmap', () => {
  // 实时扫盘：按文件修改时间统计（原先读索引表 file_mtime）
  return projectScan.collectHeatmap();
});

// 索引服务已整体下线：kb:scan / service:indexAll / insights:clearIndex / insights:indexerInfo
// 连同 kb_documents / kb_chunks 表、rag.ts、indexer.ts、index-worker.ts 一并删除。
// 概览看板的文件数字改由 project-scan.ts 实时扫盘提供。
ipcMain.handle('insights:libraryStats', () => {
  // 实时扫盘：每个项目的 .md 文件数与今日修改数
  return projectScan.collectPerProject();
});

// --- Dialog ---
ipcMain.handle('dialog:openDirectory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// --- App ---
ipcMain.handle('app:version', () => app.getVersion());
/** 用系统默认浏览器打开外部链接；只放行 http(s)，防止渲染层借道打开任意协议 */
ipcMain.handle('app:openExternal', (_, url: string) => {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { error: '仅支持 http(s) 链接' };
  return shell.openExternal(u).then(() => ({ ok: true }), (e: any) => ({ error: e?.message || String(e) }));
});
ipcMain.handle('app:firstRun', () => {
  return { firstRun: !appConfig.hasConfigKey('firstRunWelcomeSeen') };
});
ipcMain.handle('app:firstRun:done', () => {
  appConfig.saveConfig({ firstRunWelcomeSeen: true });
  return true;
});

// --- Feishu ---
ipcMain.handle('feishu:testBot', async (_, { app_id, app_secret }) => {
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id, app_secret }),
    });
    const data: any = await res.json();
    if (data.code === 0 && data.tenant_access_token) {
      return { ok: true, botName: '' };
    }
    return { ok: false, error: data.msg || '获取 token 失败' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('feishu:webhook:set', (_, { url }) => {
  feishu.setWebhook(url);
  appConfig.saveConfig({ feishuWebhookUrl: url || '' });
  logger.info('[Feishu] Webhook saved: %s', url);
  return { ok: true };
});
ipcMain.handle('feishu:webhook:test', async (_, { url }) => {
  const result = await feishu.sendViaWebhook(url, '🔔 启航AI工作台 桌面端连接测试成功！');
  return result;
});
ipcMain.handle('feishu:bot:save', (_, { app_id, app_secret }) => {
  appConfig.saveConfig({ feishuAppId: app_id || '', feishuAppSecret: app_secret || '' });
  logger.info('[Feishu] Bot credentials saved');
  return { ok: true };
});
ipcMain.handle('feishu:send', async (_, { message }) => {
  const url = appConfig.getConfig('feishuWebhookUrl');
  if (!url) return { ok: false, error: 'Webhook URL 未配置' };
  return await feishu.sendViaWebhook(url, message);
});

// --- Logs ---
ipcMain.handle('log:lines', (_, options) => {
  return logger.readLines(options || {});
});
ipcMain.handle('log:files', () => {
  return logger.listFiles();
});
ipcMain.handle('log:readFile', (_, { fileName, options }) => {
  return logger.readFile(fileName, options || {});
});
ipcMain.handle('log:clear', () => {
  logger.clearLog();
  return true;
});
ipcMain.handle('log:dir', () => {
  return logger.getLogDir();
});

// --- Config ---
// 配置统一保存在 config.json（config:get 读取，config:set 写入）。
ipcMain.handle('config:get', () => {
  return {
    llmProvider: appConfig.getConfig('llmProvider') || 'deepseek',
    llmModel: appConfig.getConfig('llmModel') || '',
    llmApiKey: appConfig.getConfig('llmApiKey') || '',
    llmBaseUrl: appConfig.getConfig('llmBaseUrl') || '',
    feishuWebhookUrl: appConfig.getConfig('feishuWebhookUrl') || '',
    feishuAppId: appConfig.getConfig('feishuAppId') || '',
    feishuAppSecret: appConfig.getConfig('feishuAppSecret') || '',
    dailyReportRetentionDays: appConfig.getConfig('daily_report_retention_days') || '30',
    dailyReportPrompt: appConfig.getConfig('daily_report_prompt') || '',
    dailyReportTemplate: appConfig.getConfig('daily_report_template') || scheduler.DEFAULT_REPORT_TEMPLATE || '',
  };
});
ipcMain.handle('config:set', (_, cfg) => {
  appConfig.saveConfig(cfg || {});
  return true;
});

// ========== AI 工具箱（aitool:*） ==========

ipcMain.handle('aitool:generate', async (event, { tool, prompt, sessionId, name, params }) => {
  try {
    const { buildReportToolDefs, buildDataToolDefs } = require('./services/tools');
    let customTools: any[] | undefined;

    // 笔记库工具：PPT / 周报日报 基于所有项目内容（后端直接读取笔记内容注入 prompt，AI 有真实素材）
    let kbPrompt = prompt;
    if (tool === 'ppt' || tool === 'report') {
      const libs = db.project.list().filter((p: any) => p.dir && fs.existsSync(p.dir));
      if (libs.length) {
        const notesText = aitool.collectNotesTextAll(libs.map((p: any) => p.dir), 25000);
        const fileCount = notesText ? (notesText.match(/【/g) || []).length : 0;
        const notesBlock = notesText
          ? `以下是 ${libs.length} 个项目中的文件内容（共 ${fileCount} 个文件，内容来自你的真实笔记，创作时请引用其中具体的项目、数据、名称）：\n\n${notesText}\n\n`
          : '';
        const kbTools: any[] = [];
        kbTools.push(...(await buildDataToolDefs(appConfig.getNotesDir() || libs[0].dir, { noWeb: true })));
        if (tool === 'report') kbTools.unshift(...(await buildReportToolDefs(undefined)));
        customTools = kbTools;
        kbPrompt = `${notesBlock}${prompt}`;
      } else if (tool === 'report') {
        customTools = await buildReportToolDefs(undefined);
      }
    }

    const text = await aitool.generateWithPi({
      prompt: kbPrompt,
      sessionId: `${tool}_${sessionId || Date.now()}`,
      customTools,
      onDelta: (delta) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('aitool:delta', { sessionId, text: delta });
        }
      },
    });
    try { db.aitoolHistory.add(tool, name || '', params || '', text, 'text'); } catch {}
    return { ok: true, text };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }
});

async function saveWithDialog(defaultName: string, filters: Electron.FileFilter[], writeFn: (path: string) => void | Promise<void>) {
  if (!mainWindow) return { ok: false, error: '窗口未就绪' };
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出文件',
    defaultPath: path.join(aitool.defaultExportDir(), defaultName),
    filters,
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    await writeFn(result.filePath);
    return { ok: true, path: result.filePath };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }
}

ipcMain.handle('aitool:exportPptx', async (_, { md, defaultName }) => {
  const name = aitool.safeFileName(defaultName || '演示文稿') + '.pptx';
  return saveWithDialog(name, [{ name: 'PPT', extensions: ['pptx'] }], (p) => aitool.exportPptx(md, p));
});

ipcMain.handle('aitool:exportHtml', async (_, { md, defaultName }) => {
  const name = aitool.safeFileName(defaultName || '演示文稿') + '.html';
  return saveWithDialog(name, [{ name: 'HTML 演示', extensions: ['html'] }], (p) => aitool.exportHtml(md, p));
});

ipcMain.handle('aitool:exportMindmap', async (_, { md, defaultName }) => {
  const name = aitool.safeFileName(defaultName || '思维导图') + '.mm';
  return saveWithDialog(name, [{ name: 'FreeMind', extensions: ['mm'] }], (p) => aitool.exportMindmap(md, p));
});

ipcMain.handle('aitool:exportText', async (_, { text, defaultName, ext }) => {
  const e = ext || '.md';
  const name = aitool.safeFileName(defaultName || '文档') + e;
  return saveWithDialog(name, [{ name: '文档', extensions: [e.replace('.', '')] }], (p) => aitool.exportText(text, p, e));
});

ipcMain.handle('aitool:fetch', async (_, { url }) => {
  return await aitool.fetchUrl(url);
});

ipcMain.handle('aitool:image:generate', async (_, { prompt, width, height, name }) => {
  const res = await aitool.generateImage(prompt, { width, height });
  if (res.ok) {
    try {
      const imgDir = path.join(aitool.defaultExportDir(), '历史图片');
      fs.mkdirSync(imgDir, { recursive: true });
      const fileName = aitool.safeFileName(name || prompt.slice(0, 20)) + '_' + Date.now() + '.png';
      const filePath = path.join(imgDir, fileName);
      fs.writeFileSync(filePath, Buffer.from(res.b64!, 'base64'));
      db.aitoolHistory.add('image', name || prompt.slice(0, 30), prompt, filePath, 'image');
    } catch (e) {
      logger.warn('[AI-Tool] image history save failed: %s', (e as any).message);
    }
  }
  return res;
});

ipcMain.handle('aitool:image:save', async (_, { b64, mimeType, defaultName }) => {
  if (!mainWindow) return { ok: false, error: '窗口未就绪' };
  const name = aitool.safeFileName(defaultName || '图片') + '.png';
  return saveWithDialog(name, [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }], (p) => { aitool.saveBase64Image(b64, p, mimeType); });
});

ipcMain.handle('aitool:history:list', (_, { tool } = {}) => {
  return db.aitoolHistory.list(tool || undefined, 100);
});
ipcMain.handle('aitool:history:get', (_, { id }) => {
  return db.aitoolHistory.get(id);
});
ipcMain.handle('aitool:history:remove', (_, { id }) => {
  db.aitoolHistory.remove(id);
  return { ok: true };
});
ipcMain.handle('aitool:history:clear', (_, { tool } = {}) => {
  db.aitoolHistory.clear(tool || undefined);
  return { ok: true };
});

ipcMain.handle('aitool:history:image', (_, { filePath }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '图片文件不存在' };
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  } catch (e) {
    return { ok: false, error: (e as any).message };
  }
});

ipcMain.handle('aitool:image:config', () => {
  const cfg = aitool.getImageGenConfig();
  return {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
  };
});

ipcMain.handle('aitool:image:setConfig', (_, { baseUrl, apiKey, model }) => {
  appConfig.saveConfig({
    imageGenBaseUrl: (baseUrl || '').trim(),
    imageGenApiKey: (apiKey || '').trim(),
    imageGenModel: (model || '').trim(),
  });
  return { ok: true };
});

// ========== App Lifecycle ==========

(app as any).isQuitting = false;

app.whenReady().then(async () => {
  startupElapsed('whenReady fired');
  if (process.platform === 'darwin') {
    app.setName('启航AI工作台');
    try { app.dock?.setIcon(getWindowIcon()); } catch {}
  } else {
    Menu.setApplicationMenu(null);
  }
  // Windows 的系统通知按 AppUserModelID 归属，不设时 toast 可能整条不弹（dev 模式尤其明显）
  if (process.platform === 'win32') app.setAppUserModelId('com.qihang.qihang-ai-desktop');
  try {
    await db.getDb();
    logger.info('Database mode: local (SQLite)');
  } catch (e) {
    logger.error('DB init error: %s', e);
  }
  startupElapsed('db loaded');
  createTray();

  // 旧版内置数据集 schema 升级：补齐字段类型/必填/选项（幂等）
  try {
    const n = upgradeBuiltinSchemas();
    if (n > 0) logger.info('[Builtin] 已升级 %d 个内置数据集 schema', n);
  } catch (e) {
    logger.error('upgradeBuiltinSchemas error: %s', e);
  }

  // 旧版飞书写入暂存区（~/.qihang-ai-desktop/pending）已随笔记工具下线而废弃：
  // 写入不再需要「确认后落盘」，残留目录直接清掉，避免留下永远无法落地的产物。
  try {
    const legacyPending = path.join(require('os').homedir(), '.qihang-ai-desktop', 'pending');
    if (fs.existsSync(legacyPending)) {
      fs.rmSync(legacyPending, { recursive: true, force: true });
      logger.info('[Pending] 已清理废弃的飞书暂存区目录');
    }
  } catch (e) {
    logger.error('cleanup legacy pending dir error: %s', e);
  }

  // 默认模型自愈：settings.json 的默认模型若指向已删除的接入点（或缺失），
  // 同步为应用内配置的第一个模型，避免日报/定时任务/飞书选中无 API Key 的旧模型
  try {
    await syncDefaultModelSettings();
  } catch (e) {
    logger.error('syncDefaultModelSettings error: %s', e);
  }

  // 数据中心记录迁移：data_center_records.dataset_id 改为关联 data_center_datasets 主键 id（幂等）
  // 历史数据中 records.dataset_id 可能存的是旧 dataset_id 字符串，这里统一改为主键 id。
  try {
    const r = db.q("SELECT COUNT(*) as c FROM data_center_records WHERE dataset_id IN (SELECT dataset_id FROM data_center_datasets)");
    const n = (r[0] || {}).c || 0;
    if (n > 0) {
      db.run("UPDATE data_center_records SET dataset_id = (SELECT id FROM data_center_datasets WHERE dataset_id = data_center_records.dataset_id) WHERE dataset_id IN (SELECT dataset_id FROM data_center_datasets)");
      logger.info('[Migrate] 已迁移 %d 条数据中心记录的 dataset_id 为主键 id', n);
    }
  } catch (e) {
    logger.error('migrate data_center_records.dataset_id error: %s', e);
  }

  // 多笔记库迁移：旧版单库（config.notesDir）转正为默认笔记库，并维持指针不变量（幂等）
  try {
    ensureNotesLibraryMigration();
  } catch (e) {
    logger.error('ensureNotesLibraryMigration error: %s', e);
  }

  // 飞书一次性消息不再算任务（2026-10-31 会话化）：任务页只保留后台调度任务，
  // 存量 source='feishu' 且 trigger_type='now' 的任务行转为纯会话——
  // 只删任务/执行记录，会话与消息保留（source='feishu' 的会话会在对话页合并展示）。
  // ⚠️ 不能走 db.task.remove()，它会连会话一起删。
  try {
    const feishuOneShotIds: number[] = db.q("SELECT id FROM plan_tasks WHERE source = 'feishu' AND trigger_type = 'now'").map((r: any) => Number(r.id));
    if (feishuOneShotIds.length) {
      for (const id of feishuOneShotIds) db.run('DELETE FROM task_executions WHERE task_id = ?', id);
      db.run("DELETE FROM plan_tasks WHERE source = 'feishu' AND trigger_type = 'now'");
      logger.info('[Migrate] 已将 %d 条飞书一次性任务转为纯会话（任务行已删，会话保留）', feishuOneShotIds.length);
    }
  } catch (e) {
    logger.error('migrate feishu one-shot tasks error: %s', e);
  }

  // 注：嵌入模型配置（embeddingModel / embeddingBaseUrl / embeddingApiKey）原先只服务于向量索引，
  // 索引路线已整体下线，这些配置项不再被读取，留在 config.json 里也不生效。

  createWindow();
  startupElapsed('window created');

  const savedAppId = appConfig.getConfig('feishuAppId');
  const savedAppSecret = appConfig.getConfig('feishuAppSecret');
  if (savedAppId && savedAppSecret) {
    logger.info('Auto-starting Feishu bot from saved config...');
    startFeishu({ app_id: savedAppId, app_secret: savedAppSecret });
  }

  ensureDailyReportTask();
  scheduler.start();
  backup.startAutoBackup();
  startRelay();
  startupElapsed('services started');

  updateTrayMenu(getServicesStatus());

  backgroundReady = true;

  // 内置日报任务错过补跑：任务已开启（pending 且已绑定笔记库）且当天已过计划时间但尚未生成时，启动即补跑一次；
  // 未开启或未到计划时间则交给任务调度器，不再无条件启动生成
  (async () => {
    try {
      const t = db.qOne("SELECT * FROM plan_tasks WHERE task_type = 'daily_report' LIMIT 1");
      if (!t || t.status !== 'pending' || !t.project_id) return;
      if (!db.project.list().length) return;
      const now = new Date(Date.now() + 8 * 3600 * 1000);
      const today = now.toISOString().slice(0, 10);
      const existing = db.qOne("SELECT id FROM ai_analysis WHERE type = 'daily_report' AND report_date = ?", today);
      if (existing) return;
      const parts = String(t.cycle_time || '22:00').split(':');
      const planMin = (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
      const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
      if (nowMin < planMin) return; // 未到计划时间，等调度器触发
      const modelResult = await listPiModels();
      if (!modelResult.models?.some((m) => m.configured)) {
        logger.warn('[Startup] Skip daily report catch-up: 未配置可用模型，请在「设置 → 对话模型配置」中配置后重试');
        return;
      }
      logger.info('[Startup] Daily report task enabled but past schedule, catch-up run...');
      await scheduler.runDailyReportTask(t, 'scheduled');
      if (mainWindow) mainWindow.webContents.send('report:generated');
    } catch (e: any) {
      logger.error('[Startup] daily report catch-up failed: ' + (e.message || e));
    }
  })();
});

app.on('before-quit', () => {
  (app as any).isQuitting = true;
  backup.stopAutoBackup();
  stopAllServices();
  db.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit - keep running in tray
  }
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
  else showWindow();
});
