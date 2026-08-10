import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } from 'electron';
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
import * as appConfig from './services/app-config';
import { runPi, listPiModels, generateDailyReport as piGenerateDailyReport, listBuiltinModelConfigs, saveBuiltinModelConfigs, testBuiltinModelConnection } from './services/pi-agent';
import { buildNoteToolDefs, buildDataToolDefs, buildCodingToolDefs } from './services/tools';
import { initCodingTasks, isCodingMessage, handleFeishuCodingMessage, getWorktreeService, listCodingProjects, collectSessionChanges, applySessionChanges, commitSessionChanges, abortSessionChanges, discardSessionChanges, latestCodingSessions, recordFeishuTask, followUpTask } from './services/coding-task';
import * as aitool from './services/ai-tools';
import { listBuiltinSuites, applyBuiltinSuites, upgradeBuiltinSchemas } from './services/builtin-datasets';
import { getSearchConfig, saveSearchConfig, webSearch } from './services/search';
import * as backup from './services/backup';
import { migrateLocalToCloud } from './services/migrate-cloud';
import * as feishu from './services/feishu';
import * as scheduler from './services/scheduler';
import * as indexer from './services/indexer';
import logger from './services/logger';
import { createTrayIcon, getWindowIcon } from './icon';
import * as rag from './services/rag';

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
  indexer.stop();
}

function getServicesStatus() {
  return {
    feishu: feishu.isRunning(),
    scheduler: scheduler.isRunning(),
    indexer: indexer.isRunning(),
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

// ========== Feishu message handler (shared) ==========

function parseFeishuContext(text, db) {
  const projects = db.project.list();
  const noteProjects = projects.filter(p => p.type === 'note');
  let cleanText = text;
  let projectDir = '';
  const projectIds: any[] = [];
  let explicit = false;

  const projectMatch = text.match(/\/code\s*[：:]\s*(\S+)/);
  if (projectMatch) {
    const projectName = projectMatch[1];
    const found = projects.find(p => p.name.includes(projectName));
    if (found) { projectDir = found.dir; explicit = true; }
    cleanText = cleanText.replace(projectMatch[0], '').trim();
  }

  const bracketMatch = text.match(/\[笔记库\s*[：:]\s*([^\]]+)\]/);
  if (bracketMatch) {
    const projectName = bracketMatch[1].trim();
    const found = noteProjects.find(p => p.name.includes(projectName) || projectName.includes(p.name));
    if (found) { projectIds.push(found.id); explicit = true; }
    cleanText = cleanText.replace(bracketMatch[0], '').trim();
  }

  const colonMatch = cleanText.match(/笔记库\s*[：:]\s*(\S+)/);
  if (colonMatch && projectIds.length === 0) {
    const projectName = colonMatch[1];
    const found = noteProjects.find(p => p.name.includes(projectName) || projectName.includes(p.name));
    if (found) { projectIds.push(found.id); explicit = true; }
    cleanText = cleanText.replace(colonMatch[0], '').trim();
  }

  if (!explicit) {
    const idMatch = text.match(/^(\d+)\b/);
    if (idMatch) {
      const numId = parseInt(idMatch[1], 10);
      const found = projects.find(p => p.id === numId);
      if (found) {
        if (found.type === 'code') projectDir = found.dir;
        else projectIds.push(found.id);
        explicit = true;
        cleanText = cleanText.replace(idMatch[1], '').trim();
      }
    }
  }

  if (!explicit) {
    for (const p of projects) {
      if (text.startsWith(p.name)) {
        if (p.type === 'code') projectDir = p.dir;
        else projectIds.push(p.id);
        explicit = true;
        cleanText = cleanText.replace(p.name, '').trim();
        break;
      }
    }
  }

  return { projectDir, projectIds, cleanText: cleanText || text, explicit };
}

// ========== 工单记录路由（确定性落库，不依赖 AI 自主行为） ==========

/** 识别 "帮我记录：金箔雲项目工单 1、... / 帮我记录：金箔雲项目需求 ..." 等指令 */
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

const feishuMessageHandler = async (msg) => {
  logger.info('═══════════════════════════════════════');
  logger.info(' 飞书消息已接收');
  logger.info(' 发送者: %s', msg.sender);
  logger.info(' 内容: %s', msg.text);
  logger.info(' ChatId: %s', msg.chatId);
  logger.info('═══════════════════════════════════════');

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('feishu:message', msg);
  }

  // 编程消息（识别到代码项目 或 命中编程关键词）→ 走 worktree 隔离任务
  try {
    if (isCodingMessage(msg.text, db)) {
      const result = await handleFeishuCodingMessage(msg, { db, feishu, appConfig });
      if (result.handled) {
        if (result.reply) feishu.replyCard(msg, convertMarkdownForFeishu(result.reply), '🤖 启航AI·编程');
        return;
      }
    }
  } catch (e) {
    logger.error('[Feishu] Coding task error: %s', e.message);
    feishu.replyCard(msg, `编程任务出错: ${e.message}`, '❌ 错误');
    return;
  }

  const fTs = () => { const d = new Date(Date.now() + 8 * 3600 * 1000); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; };
  const fNotifyUI = () => { try { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('task:changed'); } catch {} };

  let feishuTaskId: any = null;
  let feishuExecId: any = null;

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
          const r = db.qOne('SELECT id FROM data_center_records WHERE dataset_id = ? ORDER BY id DESC LIMIT 1', ds.id);
          if (r) inserted.push(r.id);
        }
        const summary = `✅ 已向「${ds.name}」数据集写入 ${inserted.length} 条工单（项目：${wo.project}）\n\n${items.map((it, i) => `${i + 1}. ${it.slice(0, 60)}${it.length > 60 ? '…' : ''}`).join('\n')}\n\n可在「数据中心 → 项目工单」中查看与编辑。`;
        const noteProj = db.project.list('note').find(p => p.dir === (appConfig.getConfig('notesDir') || '')) || db.project.list('note')[0] || null;
        const r2 = recordFeishuTask(db, noteProj, msg.text, '', 'note');
        feishuTaskId = r2.taskId;
        feishuExecId = r2.execId;
        const sessionId = 'task_' + (r2.taskId ?? '');
        if (r2.taskId != null) db.task.update(r2.taskId, { session_id: sessionId });
        try { db.chat.createSession(sessionId, noteProj ? noteProj.id : null, msg.text.slice(0, 30), 'feishu', 'pi', 'feishu'); } catch {}
        db.chat.addMessage(sessionId, 'user', msg.text, 'general');
        db.chat.addMessage(sessionId, 'assistant', summary, 'general');
        const end = fTs();
        if (feishuExecId != null) db.taskExecution.update(feishuExecId, { status: 'SUCCESS', end_time: end, result_text: summary });
        if (feishuTaskId != null) db.task.update(feishuTaskId, { last_result: summary, last_status: 'SUCCESS', last_run_at: end, status: 'done' });
        fNotifyUI();
        feishu.replyCard(msg, convertMarkdownForFeishu(summary), '📋 工单已记录');
        return;
      }
    }
  } catch (e) {
    logger.error('[Feishu] Work order record error: %s', e.message);
  }

  try {
    const context = parseFeishuContext(msg.text, db);

    let feishuProjectId: any = null;
    if (context.projectIds.length > 0) {
      feishuProjectId = context.projectIds[0];
    } else if (context.projectDir) {
      const allProjects = db.project.list();
      const byDir = allProjects.find(p => p.dir === context.projectDir);
      if (byDir) feishuProjectId = byDir.id;
    }
    if (!feishuProjectId) {
      const notesDir = appConfig.getConfig('notesDir') || '';
      if (notesDir) {
        const noteProjects = db.project.list('note');
        const byDir = noteProjects.find(p => p.dir === notesDir);
        if (byDir) {
          feishuProjectId = byDir.id;
          context.projectIds = [byDir.id];
          context.projectDir = byDir.dir;
        } else {
          feishuProjectId = 'notesdir';
          context.projectDir = notesDir;
        }
      } else {
        const noteProjects = db.project.list('note');
        if (noteProjects.length > 0) {
          feishuProjectId = noteProjects[0].id;
          context.projectIds = [feishuProjectId];
          context.projectDir = noteProjects[0].dir;
        }
      }
    }

    if (!feishuProjectId) {
      feishu.replyCard(msg, '⚠️ 请先在「设置」中配置笔记库目录，或添加笔记类型项目后再使用。', '⚠️ 配置缺失');
      return;
    }

    feishu.replyMessage(msg, '🤔 AI 正在思考，请稍后...');

    // 先落任务记录，再按任务 id 创建独立 session
    const feishuProject = feishuProjectId !== 'notesdir' && Number.isFinite(Number(feishuProjectId))
      ? db.project.get(Number(feishuProjectId)) : null;
    const r = recordFeishuTask(db, feishuProject, msg.text, '', 'note');
    feishuTaskId = r.taskId;
    feishuExecId = r.execId;

    const sessionId = 'task_' + feishuTaskId;
    if (feishuTaskId != null) db.task.update(feishuTaskId, { session_id: sessionId });
    db.chat.createSession(sessionId, feishuProjectId, msg.text.slice(0, 30), 'feishu', 'pi', 'feishu');
    db.chat.addMessage(sessionId, 'user', msg.text, 'general');
    logger.info(' SessionId: %s', sessionId);

    const setMode = (mode) => { try { db.run("UPDATE prj_sessions SET mode = ?, updated_at = datetime('now', '+8 hours') WHERE session_id = ?", mode,sessionId); } catch {} };
    const updateTaskFailed = (err: string) => {
      if (feishuExecId != null) db.taskExecution.update(feishuExecId, { status: 'FAILED', end_time: fTs(), error_message: err });
      if (feishuTaskId != null) db.task.update(feishuTaskId, { last_status: 'FAILED', last_run_at: fTs(), status: 'pending' });
    };

    const notesDir = appConfig.getConfig('notesDir') || context.projectDir || '';
    const recordHint = /(记录|登记|新建).{0,16}(工单|需求|BUG)/.test(context.cleanText)
      ? '\n\n【记录要求】用户要求"记录/登记/新建 工单/需求/BUG"时，必须调用 insert_dataset_record 工具写入"项目工单"数据集（字段：项目、端、详细、优先级；一条工单一条记录），不要只写入笔记文件。'
      : '';
    const prompt = notesDir
      ? `以下是笔记库目录，请用 grep/find 等工具自行搜索相关文件后回答：\n笔记库路径：${notesDir}\n\n用户问题：${context.cleanText}` + recordHint
      : context.cleanText + recordHint;
    setMode('kb');
    const toolDefs: any[] = [];
    if (notesDir) {
      const noteProj = db.project.list('note').find(p => p.dir === notesDir);
      if (noteProj) toolDefs.push(...(await buildNoteToolDefs(noteProj.id)));
      toolDefs.push(...(await buildDataToolDefs(notesDir)));
    }
    await runPi({
      prompt,
      sessionId,
      cwd: notesDir || undefined,
      customTools: toolDefs,
      onDone: (text) => {
        logger.info('[Feishu] Sending card reply: "%s"', (text || '').slice(0, 200));
        if (text) {
          db.chat.addMessage(sessionId, 'assistant', text, 'general');
          feishu.replyCard(msg, convertMarkdownForFeishu(text), '🤖 启航AI');
        }
        const end = fTs();
        if (feishuExecId != null) db.taskExecution.update(feishuExecId, { status: 'SUCCESS', end_time: end, result_text: text || '' });
        if (feishuTaskId != null) db.task.update(feishuTaskId, { last_result: (text || '').slice(0, 3000), last_status: 'SUCCESS', last_run_at: end, status: 'done' });
        fNotifyUI();
      },
      onError: (e) => {
        logger.error('[Feishu] Chat error: %s', e);
        feishu.replyCard(msg, `处理出错: ${e}`, '❌ 错误');
        updateTaskFailed(String(e));
        fNotifyUI();
      },
    });
  } catch (e) {
    logger.error('[Feishu] Handler exception: %s', e.message);
    feishu.replyCard(msg, `处理出错: ${e.message}`, '❌ 错误');
    if (feishuExecId != null) db.taskExecution.update(feishuExecId, { status: 'FAILED', end_time: fTs(), error_message: e.message });
    if (feishuTaskId != null) db.task.update(feishuTaskId, { last_status: 'FAILED', last_run_at: fTs(), status: 'pending' });
    fNotifyUI();
  }
};

function startFeishu(configData) {
  appConfig.saveConfig({ feishuAppId: configData.app_id || '', feishuAppSecret: configData.app_secret || '' });
  feishu.start(configData, feishuMessageHandler);
  updateTrayMenu(getServicesStatus());
}

// ========== IPC Handlers ==========

// --- Knowledge Base (config.json 驱动) ---
function ensureNoteProject(dir: string) {
  const notes = db.project.list('note');
  let p = notes[0] || null;
  if (!p) {
    p = db.project.add('笔记库', 'note', dir, '', '');
  } else if (p.dir !== dir) {
    db.project.update(p.id, { dir });
  }
  return p;
}

ipcMain.handle('kb:getDir', () => appConfig.getNotesDir());

ipcMain.handle('kb:list', () => {
  const dir = appConfig.getNotesDir();
  if (!dir) return [];
  return [{ id: 0, name: '笔记库', dir, totalDocs: 0 }];
});
ipcMain.handle('notes:tree', (_, { dir }) => {
  if (!dir || !fs.existsSync(dir)) return [];
  return listDir(dir);
});
ipcMain.handle('notes:treeChildren', (_, { dirPath }) => {
  return listDir(dirPath);
});
ipcMain.handle('notes:read', (_, { dir, filePath }) => {
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: '笔记库不存在' };
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



ipcMain.handle('code:search', (_, { projectId, query }) => {
  try {
    if (!query || !projectId) return [];
    const project = db.project.get(projectId);
    if (!project || !project.dir) return [];

    const q = query.toLowerCase();
    const results: any[] = [];
    const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache', 'dist', 'build', 'target', '.idea', '.vscode']);
    const walkDir = (dir) => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
            walkDir(full);
          } else {
            if (e.name.startsWith('.')) continue;
            if (e.name.toLowerCase().includes(q) || full.toLowerCase().includes(q)) {
              results.push({ path: full, name: e.name, score: 1, match: '' });
            }
          }
        }
      } catch {}
    };
    walkDir(project.dir);
    return results.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 50);
  } catch { return []; }
});

ipcMain.handle('kb:add', (_, { name, path: dirPath }) => {
  if (!dirPath) return null;
  appConfig.setNotesDir(dirPath);
  const p = ensureNoteProject(dirPath);
  return db.project.get(p.id);
});
ipcMain.handle('kb:setDir', (_, { dir }) => {
  if (!dir) return null;
  appConfig.setNotesDir(dir);
  const p = ensureNoteProject(dir);
  return db.project.get(p.id);
});
ipcMain.handle('kb:remove', () => {
  appConfig.setNotesDir('');
  return { ok: true };
});
let _indexingLock = false;

let _docBatchCount = 0;

function handleWorkerMessages(worker, sendProgress, resolve, track) {
  _docBatchCount = 0;
  worker.on('message', (msg) => {
    try {
      if (msg.type === 'progress') {
        sendProgress(msg);
      } else if (msg.type === 'deleteOld') {
        db.runRaw('DELETE FROM kb_chunks', []);
        db.runRaw('DELETE FROM kb_documents', []);
        db.save();
      } else if (msg.type === 'doc') {
        db.runRaw("INSERT INTO kb_documents (path, content, indexed_at, file_mtime, title) VALUES (?, ?, datetime('now', '+8 hours'), ?, ?)", [msg.path, msg.content, msg.fileMtime || null, msg.title || '']);
        const docRow = db.qOne('SELECT id FROM kb_documents WHERE path = ?', msg.path);
        if (docRow) {
          for (const c of msg.chunks) {
            db.runRaw('INSERT INTO kb_chunks (doc_id, content) VALUES (?, ?)', [docRow.id, c.content]);
          }
        }
        if (track) { track.fileCount++; track.chunkCount += msg.chunks.length; }
        if (++_docBatchCount % 10 === 0) db.save();
      } else if (msg.type === 'scanDone') {
        db.save();
        const embedConfig = {
model: appConfig.getConfig('embeddingModel') || '',
          host: appConfig.getConfig('embeddingBaseUrl') || 'http://127.0.0.1:11434',
          apiKey: appConfig.getConfig('embeddingApiKey') || '',
        };
        const rows = db.q(`SELECT c.id, c.content FROM kb_chunks c WHERE c.embedding IS NULL`);
        worker.send({ type: 'embed', chunks: rows, config: embedConfig });
      } else if (msg.type === 'embedding') {
        db.runRaw('UPDATE kb_chunks SET embedding = ? WHERE id = ?', [JSON.stringify(msg.vector), msg.chunkId]);
        if (++_docBatchCount % 10 === 0) db.save();
      } else if (msg.type === 'embedDone') {
        db.save();
        if (track) track.embedded = msg.embedded;
      } else if (msg.type === 'done') {
        sendProgress({ phase: 'done', current: 0, total: 0, file: '' });
        worker.kill();
        _indexingLock = false;
        resolve(track ? { files: track.fileCount, totalChunks: track.chunkCount } : true);
      } else if (msg.type === 'error') {
        sendProgress({ phase: 'done', current: 0, total: 0, file: '' });
        worker.kill();
        _indexingLock = false;
        resolve({ error: msg.message });
      }
    } catch (e) {
      logger.error(`[IndexWorker] handler error: ${e.message}`);
    }
  });
  worker.on('error', () => { sendProgress({ phase: 'done' }); _indexingLock = false; resolve({ error: 'worker error' }); });
  worker.on('exit', () => { _indexingLock = false; resolve({}); });
}

ipcMain.handle('kb:scan', async (_, { dir }) => {
  if (!dir) return { error: '笔记库目录未配置' };
  if (_indexingLock) return { error: '正在索引中，请稍后再试' };
  try {
    _indexingLock = true;
    const sendProgress = (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('kb:scan-progress', { id: 0, ...data });
      }
    };
    sendProgress({ phase: 'scan', current: 0, total: 0, file: '' });

    const { fork } = require('child_process');
    const worker = fork(path.join(__dirname, 'services', 'index-worker.js'));

    return new Promise((resolve) => {
      const track = { fileCount: 0, chunkCount: 0, embedded: 0 };
      handleWorkerMessages(worker, sendProgress, resolve, track);
      worker.send({ type: 'start', projects: [{ name: '笔记库', dir, ignore_dirs: '', ignore_files: '' }] });
    });
  } catch (e) {
    _indexingLock = false;
    return { error: e.message };
  }
});
ipcMain.handle('kb:setDefault', () => ({ ok: true }));
ipcMain.handle('kb:getDefault', () => {
  const dir = appConfig.getNotesDir();
  if (!dir) return null;
  return { id: 0, name: '笔记库', dir };
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
ipcMain.handle('kb:status', () => {
  const total = (db.qOne("SELECT COUNT(*) as c FROM kb_chunks") || {}).c || 0;
  const embedded = (db.qOne("SELECT COUNT(*) as c FROM kb_chunks WHERE embedding IS NOT NULL") || {}).c || 0;
  return { indexed: total > 0, chunks: total, embedded };
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
  const record = normalizeRecordBySchema(datasetId, data || {});
  return db.ds.insert(datasetId, record);
});
ipcMain.handle('ds:updateRecord', (_, { id, data }) => {
  const dsRow = db.qOne('SELECT dataset_id FROM data_center_records WHERE id = ?', id);
  const record = dsRow ? normalizeRecordBySchema(dsRow.dataset_id, data || {}) : data;
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

// --- 云端数据库（MySQL） ---
ipcMain.handle('db:status', () => {
  const s = db.getCloudStatus();
  return {
    enabled: s.enabled,
    configured: s.configured,
    state: s.state,
    error: s.error,
    mode: db.getDbMode(),
    host: appConfig.getConfig('dbHost'),
    port: appConfig.getConfig('dbPort') || '3306',
    dbName: appConfig.getConfig('dbName'),
    dbSsl: appConfig.getConfig('dbSsl'),
  };
});
ipcMain.handle('db:test', async () => db.checkCloud());
ipcMain.handle('db:reload', () => {
  db.reloadCloud();
  return { ok: true };
});
ipcMain.handle('db:migrate', async () => migrateLocalToCloud());


ipcMain.handle('ds:pendingRecords', () => {
  const datasets = db.q("SELECT id, name FROM data_center_datasets ORDER BY name");
  const result: any[] = [];
  for (const ds of datasets) {
    const records = db.q("SELECT id, data_json, created_at FROM data_center_records WHERE dataset_id = ? AND (record_status IS NULL OR record_status = '' OR record_status = 'pending') ORDER BY created_at DESC LIMIT 5", ds.id);
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
ipcMain.handle('chat:send', async (event, { question, sessionId, projectDir, kbIds, images, agent, modelName }) => {
  const sid = sessionId || 'session_' + Date.now();
  const activeAgent = agent || 'general';
  try {
    db.chat.createSession(sid, null, null, 'general', activeAgent, 'ui');

    const existing = db.chat.messages(sid);
    if (existing.length === 0) {
      const title = question.length > 30 ? question.slice(0, 30) + '...' : question;
      db.chat.updateSessionTitle(sid, title);
    }

    db.chat.addMessage(sid, 'user', question, activeAgent, images);

    // ===== 笔记库前置检查 =====
    // 查询事务/笔记/记录等本地知识类问题，若未配置笔记库则先引导用户配置，不再调用 AI
    if (isKBQuery(question) && !appConfig.getNotesDir()) {
      sendToRenderer('chat:status', { sessionId: sid, text: '需要笔记库支持...' });
      const guide = [
        '🤖 我需要先「📚 笔记库」来查询这类本地知识/事务类内容。',
        '',
        '当前尚未配置笔记库，请先完成以下设置：',
        '',
        '1️⃣ 点击左侧「⚙️ 设置」进入设置页',
        '2️⃣ 在「📚 笔记库设置」中选择你的笔记目录并保存',
        '',
        '配置完成后，再问我一次相同的问题就能正常查询啦。',
      ].join('\n');
      sendToRenderer('chat:delta', { sessionId: sid, text: guide });
      sendToRenderer('chat:done', { sessionId: sid });
      db.chat.addMessage(sid, 'assistant', guide, activeAgent);
      return;
    }

    // ===== pi agent 引擎（与工作台一致） =====
    sendToRenderer('chat:status', { sessionId: sid, text: 'AI 正在分析问题...' });

    // 注入本地工具：数据集查询/项目文件读取/外网搜索（按会话上下文），笔记库读写（关联的 note 项目）
    const toolDefs: any[] = [];
    if (projectDir) {
      toolDefs.push(...(await buildDataToolDefs(projectDir)));
      const noteProjByDir = db.project.list('note').find(p => p.dir === projectDir);
      if (noteProjByDir) toolDefs.push(...(await buildNoteToolDefs(noteProjByDir.id)));
    }
    if (kbIds && kbIds.length) {
      for (const kid of kbIds) {
        const p = kid ? db.project.get(kid) : null;
        if (p && p.type === 'note' && p.dir) toolDefs.push(...(await buildNoteToolDefs(p.id)));
      }
    }

    let reply = '';
    const modelPattern = piModelPattern(modelName);
    await runPi({
      prompt: question,
      sessionId: sid,
      cwd: projectDir || undefined,
      modelPattern,
      images,
      customTools: toolDefs,
      onDelta: (delta) => {
        reply += delta;
        sendToRenderer('chat:delta', { sessionId: sid, text: delta });
      },
      onTool: (toolEvent) => sendToRenderer('chat:tool', { sessionId: sid, ...toolEvent }),
      onDone: () => {
        if (reply) db.chat.addMessage(sid, 'assistant', reply, activeAgent);
        sendToRenderer('chat:done', { sessionId: sid });
      },
      onError: (err) => sendToRenderer('chat:error', { sessionId: sid, text: err }),
    });
  } catch (err) {
    sendToRenderer('chat:error', { sessionId: sid, text: err.message });
  }
});
ipcMain.handle('chat:session:create', (_, { id, projectId, title, mode, source, agent }) => {
  const sid = id || 'chat_' + Date.now();
  return db.chat.createSession(sid, projectId, title, mode || 'general', agent, source || 'ui');
});
ipcMain.handle('chat:session:list', (_, { projectId } = {}) => db.chat.sessions(projectId));
ipcMain.handle('chat:session:listByProject', (_, { projectId }) => db.chat.sessions(projectId));
ipcMain.handle('chat:session:listBySource', (_, { source, projectId }) => db.chat.sessionsBySource(source, projectId));
ipcMain.handle('chat:session:updateAgent', (_, { sessionId, agent }) => db.chat.updateSessionAgent(sessionId, agent));
ipcMain.handle('chat:session:messages', (_, { sessionId }) => db.chat.messages(sessionId));
ipcMain.handle('chat:session:delete', (_, { sessionId }) => db.chat.deleteSession(sessionId));
ipcMain.handle('chat:session:updateTitle', (_, { sessionId, title }) => db.chat.updateSessionTitle(sessionId, title));

// ========== Coding Workbench ==========
ipcMain.handle('coding:session:create', (_, { id, projectId, title, agent }) => {
  return db.chat.createSession(id || ('coding_' + Date.now()), projectId, title, 'coding', agent, 'ui');
});
ipcMain.handle('coding:session:listByProject', (_, { projectId }) => {
  const all = db.chat.sessions(projectId);
  return (all || []).filter((s: any) => s.source !== 'feishu');
});
ipcMain.handle('coding:session:messages', (_, { sessionId }) => db.chat.messages(sessionId));
ipcMain.handle('coding:session:delete', (_, { sessionId }) => db.chat.deleteSession(sessionId));
ipcMain.handle('coding:session:updateTitle', (_, { sessionId, title }) => db.chat.updateSessionTitle(sessionId, title));
ipcMain.handle('coding:switchAgent', (_, { sessionId, agent }) => {
  db.chat.updateSessionAgent(sessionId, agent);
  return db.chat.getSession(sessionId);
});

ipcMain.handle('coding:send', async (event, { question, sessionId, projectDir, agent, images, modelName }) => {
  const sid = sessionId || ('coding_' + Date.now());
  try {
    let session = db.chat.getSession(sid);
    if (!session) {
      session = db.chat.createSession(sid, null, null, 'coding', 'general', 'ui');
    }

    // 首条消息自动设置标题
    const existing = db.chat.messages(sid);
    if (existing.length === 0) {
      const title = question.length > 30 ? question.slice(0, 30) + '...' : question;
      db.chat.updateSessionTitle(sid, title);
    }

    // 保存用户消息（含图片）
    db.chat.addMessage(sid, 'user', question, 'general', images);

    let reply = '';
    sendToRenderer('coding:status', { sessionId: sid, text: 'AI 正在处理...' });

    const onDelta = (delta) => {
      reply += delta;
      sendToRenderer('coding:delta', { sessionId: sid, text: delta });
    };
    const onDone = () => {
      if (reply) db.chat.addMessage(sid, 'assistant', reply, 'general');
      sendToRenderer('coding:done', { sessionId: sid });
    };
    const onError = (err) => {
      sendToRenderer('coding:error', { sessionId: sid, text: err });
    };
    const onTool = (toolEvent) => {
      sendToRenderer('coding:tool', { sessionId: sid, ...toolEvent });
    };

    // pi agent 引擎（官方 SDK，进程内运行）
    const modelPattern = piModelPattern(modelName);
    await runPi({
      prompt: question,
      sessionId: sid,
      cwd: projectDir || undefined,
      modelPattern,
      images,
      customTools: projectDir ? await buildCodingToolDefs(projectDir) : [],
      onDelta,
      onThinking: (t) => sendToRenderer('coding:tool', { sessionId: sid, type: 'thinking', text: t }),
      onTool,
      onDone,
      onError,
    });
  } catch (err) {
    sendToRenderer('coding:error', { sessionId: sid, text: err.message });
  }
});

// --- 编程变更审查（worktree 隔离） ---
ipcMain.handle('coding:changes', async (_, { sessionId, projectId }) => {
  try {
    const project = db.project.get(projectId);
    if (!project) return { ok: false, error: '项目不存在' };
    const changes = await collectSessionChanges(sessionId, project);
    return { ok: true, changes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('coding:changes:apply', async (_, { sessionId, projectId }) => {
  try {
    const project = db.project.get(projectId);
    if (!project) return { ok: false, error: '项目不存在' };
    const result = await applySessionChanges(sessionId, project);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('coding:changes:commit', async (_, { sessionId, projectId, message, push }) => {
  try {
    const project = db.project.get(projectId);
    if (!project) return { ok: false, error: '项目不存在' };
    const result = await commitSessionChanges(sessionId, project, message, push);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('coding:changes:abort', async (_, { sessionId, projectId }) => {
  try {
    const project = db.project.get(projectId);
    if (!project) return { ok: false, error: '项目不存在' };
    const result = await abortSessionChanges(sessionId, project);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('coding:changes:discard', async (_, { sessionId, projectId }) => {
  try {
    const project = db.project.get(projectId);
    if (!project) return { ok: false, error: '项目不存在' };
    const result = await discardSessionChanges(sessionId, project);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('coding:projects', () => listCodingProjects(db));
ipcMain.handle('coding:sessions', (_, { limit } = {}) => latestCodingSessions(db, limit));

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

// --- pi agent 模型列表 ---
ipcMain.handle('pi:models', async () => listPiModels());

// 对话模型配置（应用内配置，读写 ~/.pi/agent/models.json，支持多条 provider）
ipcMain.handle('pi:config:get', () => {
  return listBuiltinModelConfigs();
});
ipcMain.handle('pi:config:set', async (_, { providers }) => {
  if (!Array.isArray(providers) || !providers.length) {
    return { ok: false, error: '至少需要一条接入配置' };
  }
  for (const p of providers) {
    if (!p.baseUrl || !String(p.baseUrl).trim()) return { ok: false, error: `服务地址不能为空（${p.name || '未命名'}）` };
    if (!Array.isArray(p.modelNames) || p.modelNames.filter((n: string) => n && String(n).trim()).length === 0) {
      return { ok: false, error: `模型名称不能为空（${p.name || '未命名'}）` };
    }
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
  const result = db.project.add(name, type || 'code', dir, description, defaultBranch);
  return result;
});
ipcMain.handle('project:update', (_, { id, data }) => db.project.update(id, data));
ipcMain.handle('project:delete', (_, { id }) => db.project.remove(id));

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
ipcMain.handle('todo:add', (_, data) => db.task.add({ ...data, trigger_type: 'manual', source: 'ui' }));
ipcMain.handle('todo:update', (_, id, data) => { db.task.update(id, data); return true; });
ipcMain.handle('todo:remove', (_, id) => { db.task.remove(id); return true; });

// --- AI 自执行任务 ---
ipcMain.handle('task:list', () => db.task.list());
ipcMain.handle('task:add', (_, data) => {
  const r = db.task.add({ ...data, source: data.source || 'ui' });
  scheduler.reloadTasks();
  return r;
});
ipcMain.handle('task:update', (_, id, data) => {
  db.task.update(id, data);
  scheduler.reloadTasks();
  return true;
});
ipcMain.handle('task:remove', (_, id) => {
  db.task.remove(id);
  scheduler.removeTask(id);
  return true;
});
ipcMain.handle('task:execute', (_, id) => scheduler.executeTaskNow(id));
ipcMain.handle('task:followup', (_, { taskId, question }) => followUpTask(taskId, question, db));
ipcMain.handle('task:executions', (_, taskId) => db.taskExecution.listByTask(taskId));
ipcMain.handle('task:execution:list', (_, page, pageSize) => db.taskExecution.list(page, pageSize));
ipcMain.handle('task:execution:get', (_, id) => db.taskExecution.get(id));
ipcMain.handle('reminder:test', (_, id) => scheduler.triggerReminderNow(id));

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
    const count = (db.qOne("SELECT COUNT(*) as c FROM data_center_records WHERE dataset_id = ?", dsRow.id) || {}).c || 0;
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

// 将分析结果存档到笔记库
ipcMain.handle('archive:saveAnalysisToNotes', async (_, { moduleId, analysisId }) => {
  const analysis = db.aa.get(analysisId);
  if (!analysis) return { ok: false, error: '分析记录不存在' };
  const mod = db.dm.get(moduleId);
  if (!mod) return { ok: false, error: '模块不存在' };

  const notesDir = appConfig.getNotesDir();
  if (!notesDir) return { ok: false, error: '笔记库未配置' };

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
    const count = (db.qOne("SELECT COUNT(*) as c FROM data_center_records WHERE dataset_id = ?", dsRow.id) || {}).c || 0;
    const recentRows = db.q("SELECT id, data_json, created_at FROM data_center_records WHERE dataset_id = ? ORDER BY created_at DESC LIMIT 5", dsRow.id);
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

/** 递归统计笔记库目录中的 Markdown 文件数（忽略常见非内容目录） */
function countMarkdownFiles(dir: string): number {
  const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache']);
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      count += countMarkdownFiles(path.join(dir, entry.name));
    } else if (entry.name.endsWith('.md')) {
      count++;
    }
  }
  return count;
}

ipcMain.handle('insights:stats', () => {
  const notesDir = appConfig.getNotesDir();
  let notesFileCount = 0;
  if (notesDir && fs.existsSync(notesDir)) {
    try { notesFileCount = countMarkdownFiles(notesDir); } catch {}
  }
  const fileCount = (db.qOne("SELECT COUNT(*) as c FROM kb_documents") || {}).c || 0;
  const chunkCount = (db.qOne("SELECT COUNT(*) as c FROM kb_chunks") || {}).c || 0;
  const totalChats = (db.qOne("SELECT COUNT(*) as c FROM prj_messages") || {}).c || 0;
  const todayModified = (db.qOne("SELECT COUNT(*) as c FROM kb_documents WHERE indexed_at >= date('now')") || {}).c || 0;
  const projectCount = (db.qOne("SELECT COUNT(*) as c FROM prj_projects WHERE type = 'note'") || {}).c || 0;
  const codeProjectCount = (db.qOne("SELECT COUNT(*) as c FROM prj_projects WHERE type = 'code'") || {}).c || 0;
  const todoPending = (db.qOne("SELECT COUNT(*) as c FROM plan_tasks WHERE status IN ('pending','in_progress')") || {}).c || 0;
  const todoOverdue = (db.qOne("SELECT COUNT(*) as c FROM plan_tasks WHERE scheduled_start != '' AND scheduled_start < datetime('now', '+8 hours') AND status IN ('pending','in_progress')") || {}).c || 0;
  const remindersActive = (db.qOne("SELECT COUNT(*) as c FROM plan_reminders WHERE enabled = 1") || {}).c || 0;
  const todayDataRecords = (db.qOne("SELECT COUNT(*) as c FROM data_center_records WHERE created_at >= datetime('now', '+8 hours', 'start of day')") || {}).c || 0;
  return { fileCount, notesFileCount, chunkCount, totalChats, todayModified, projectCount, codeProjectCount, todoPending, todoOverdue, remindersActive, todayDataRecords };
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
  const rows = db.q("SELECT path, content, file_mtime FROM kb_documents");
  const dirMap: any = {};
  for (const row of rows) {
    const dir = row.path ? row.path.split(/[\\/]/).slice(-2, -1)[0] || '根目录' : '根目录';
    if (!dirMap[dir]) dirMap[dir] = { name: dir, fileCount: 0, totalSize: 0, files: [] };
    dirMap[dir].fileCount++;
    dirMap[dir].totalSize += (row.content || '').length;
    dirMap[dir].files.push(row.path);
  }
  const result: any[] = Object.values(dirMap);
  const analyses = db.q("SELECT dir_path, content FROM ai_analysis WHERE type = 'project_analysis'");
  for (const p of result) {
    const a = analyses.find(a => a.dir_path === p.name);
    if (a) p.analysis = a.content;
    p.hasAnalysis = !!a;
  }
  return result;
});
ipcMain.handle('insights:tags', () => {
  const rows = db.q("SELECT content FROM kb_documents");
  const tagCount: any = {};
  for (const row of rows) {
    const content = row.content || '';
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatter) {
      const tagsMatch = frontmatter[1].match(/tags\s*:\s*\[([^\]]*)\]/);
      if (tagsMatch) {
        tagsMatch[1].split(',').forEach(t => {
          const tag = t.trim().replace(/['"]/g, '');
          if (tag) tagCount[tag] = (tagCount[tag] || 0) + 1;
        });
      }
    }
    const hashtags = content.match(/#([\p{L}\p{N}_\-\u4e00-\u9fff]+)/gu);
    if (hashtags) {
      hashtags.forEach(t => {
        const tag = t.slice(1);
        if (tag) tagCount[tag] = (tagCount[tag] || 0) + 1;
      });
    }
  }
  return (Object.entries(tagCount) as any[]).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
});
ipcMain.handle('insights:heatmap', () => {
  const rows = db.q("SELECT file_mtime FROM kb_documents WHERE file_mtime IS NOT NULL");
  const dateCount: any = {};
  const now = Date.now();
  for (const row of rows) {
    const d = new Date(row.file_mtime);
    const key = d.toISOString().slice(0, 10);
    dateCount[key] = (dateCount[key] || 0) + 1;
  }
  const heatmap: any = {};
  for (let i = 364; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    heatmap[key] = dateCount[key] || 0;
  }
  return heatmap;
});

ipcMain.handle('service:startIndexer', () => {
  indexer.start();
  updateTrayMenu(getServicesStatus());
  return true;
});
ipcMain.handle('service:stopIndexer', () => {
  indexer.stop();
  updateTrayMenu(getServicesStatus());
  return true;
});
ipcMain.handle('service:indexAll', async () => {
  if (_indexingLock) return { error: '正在索引中，请稍后再试' };
  _indexingLock = true;
  const sendProgress = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('indexer:progress', data);
    }
  };
  sendProgress({ phase: 'scan', current: 0, total: 0, file: '' });

  const { fork } = require('child_process');
  const worker = fork(path.join(__dirname, 'services', 'index-worker.js'));

  const noteProjects = db.project.list('note');
  const projects = noteProjects.map(p => ({ name: p.name, dir: p.dir, ignore_dirs: p.ignore_dirs, ignore_files: p.ignore_files }));

  return new Promise((resolve) => {
    handleWorkerMessages(worker, sendProgress, resolve, null);
    worker.send({ type: 'start', projects });
  });
});
ipcMain.handle('insights:clearIndex', () => {
  db.run('DELETE FROM kb_chunks');
  db.run('DELETE FROM kb_documents');
  return true;
});

ipcMain.handle('insights:indexerInfo', () => {
  return {
    running: indexer.isRunning(),
    model: appConfig.getConfig('embeddingModel') || '',
    host: appConfig.getConfig('embeddingBaseUrl') || 'http://127.0.0.1:11434',
    docCount: (db.qOne("SELECT COUNT(*) as c FROM kb_documents") || {}).c || 0,
    chunkCount: (db.qOne("SELECT COUNT(*) as c FROM kb_chunks") || {}).c || 0,
    embeddedCount: (db.qOne("SELECT COUNT(*) as c FROM kb_chunks WHERE embedding IS NOT NULL") || {}).c || 0,
  };
});

ipcMain.handle('insights:libraryStats', () => {
  const docCount = (db.qOne("SELECT COUNT(*) as c FROM kb_documents") || {}).c || 0;
  const chunkCount = (db.qOne("SELECT COUNT(*) as c FROM kb_chunks") || {}).c || 0;
  const embeddedCount = (db.qOne("SELECT COUNT(*) as c FROM kb_chunks WHERE embedding IS NOT NULL") || {}).c || 0;
  return [{ projectId: 0, name: '笔记库', docCount, chunkCount, embeddedCount }];
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
    embeddingModel: appConfig.getConfig('embeddingModel') || '',
    embeddingProvider: appConfig.getConfig('embeddingProvider') || 'Ollama',
    embeddingBaseUrl: appConfig.getConfig('embeddingBaseUrl') || 'http://127.0.0.1:11434',
    embeddingApiKey: appConfig.getConfig('embeddingApiKey') || '',
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

ipcMain.handle("embedding:test", async (_, { model, host, apiKey }) => {
  try {
    const result = await rag.testConnection({ model, host, apiKey });
    return result;
  } catch (e) {
    return { ok: false, message: "❌ 测试异常: " + (e.message || e) };
  }
});

// ========== AI 工具箱（aitool:*） ==========

ipcMain.handle('aitool:generate', async (event, { tool, prompt, sessionId, name, params }) => {
  try {
    const { buildReportToolDefs, buildNoteToolDefs, buildDataToolDefs } = require('./services/tools');
    let customTools: any[] | undefined;

    // 笔记库工具：PPT / 周报日报 基于本地笔记库内容（后端直接读取笔记内容注入 prompt，AI 有真实素材）
    let kbPrompt = prompt;
    if (tool === 'ppt' || tool === 'report') {
      const notesDir = appConfig.getNotesDir();
      if (notesDir) {
        const notesText = aitool.collectNotesText(notesDir, 25000);
        const fileCount = notesText ? (notesText.match(/【/g) || []).length : 0;
        const notesBlock = notesText
          ? `以下是笔记库中的文件内容（共 ${fileCount} 个文件，内容来自你的真实笔记，创作时请引用其中具体的项目、数据、名称）：\n\n${notesText}\n\n`
          : '';
        const kbTools: any[] = [];
        const noteProj = db.project.list('note').find(p => p.dir === notesDir);
        if (noteProj) kbTools.push(...(await buildNoteToolDefs(noteProj.id)));
        kbTools.push(...(await buildDataToolDefs(notesDir, { noWeb: true })));
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
  // 命令行迁移模式：electron . --migrate-cloud
  if (process.argv.includes('--migrate-cloud')) {
    logger.info('[Migrate] 命令行迁移模式启动');
    const r = await migrateLocalToCloud((msg, cur, total) => {
      logger.info('[Migrate] %s (%d/%d)', msg, cur, total);
    });
    if (r.ok) {
      logger.info('[Migrate] 迁移完成: %j', r.counts);
      console.log('[Migrate] 迁移完成: ' + JSON.stringify(r.counts));
    } else {
      logger.error('[Migrate] 迁移失败: %s', r.error);
      console.error('[Migrate] 迁移失败: ' + r.error);
    }
    app.exit(r.ok ? 0 : 1);
    return;
  }
  try {
    await db.getDb();
  } catch (e) {
    logger.error('DB init error: %s', e);
  }
  // 云端数据库健康检查（未配置云 MySQL 时为本地模式，不弹窗）
  const cloudHealth = await db.checkCloud();
  if (cloudHealth.ok) {
    logger.info('Database mode: %s%s', cloudHealth.mode === 'cloud' ? 'cloud (MySQL)' : 'local (SQLite)',
      cloudHealth.mode === 'cloud' && cloudHealth.latencyMs !== undefined ? ', latency=' + cloudHealth.latencyMs + 'ms' : '');
  } else {
    logger.error('Cloud DB init error: %s', cloudHealth.error);
    dialog.showErrorBox('云端数据库连接失败',
      '已配置云 MySQL 但连接失败，应用主数据将无法读写。\n\n错误信息：' + (cloudHealth.error || '未知错误') +
      '\n\n请在 设置 → 云端数据库 中检查配置，并确认：\n' +
      '1. 云 MySQL 实例已开启外网访问\n' +
      '2. 本机公网 IP 已加入云 MySQL 白名单\n' +
      '3. 数据库名存在且账号有权限');
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

  // 配置嵌入模型（从 config.json 读取）
  rag.configure({
    model: appConfig.getConfig("embeddingModel") || "",
    host: appConfig.getConfig("embeddingBaseUrl") || "http://127.0.0.1:11434",
    apiKey: appConfig.getConfig("embeddingApiKey") || '',
  });
  createWindow();
  startupElapsed('window created');

  const savedAppId = appConfig.getConfig('feishuAppId');
  const savedAppSecret = appConfig.getConfig('feishuAppSecret');
  initCodingTasks();
  if (savedAppId && savedAppSecret) {
    logger.info('Auto-starting Feishu bot from saved config...');
    startFeishu({ app_id: savedAppId, app_secret: savedAppSecret });
  }

  scheduler.start();
  backup.startAutoBackup();
  startupElapsed('services started');

  updateTrayMenu(getServicesStatus());

  backgroundReady = true;

  // 启动时检测今日日报是否已生成，未生成则异步生成
  (async () => {
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const existing = db.qOne("SELECT id FROM ai_analysis WHERE type = 'daily_report' AND report_date = ?", today);
    if (existing) return;
    const notesDir = appConfig.getConfig('notesDir') || '';
    if (!notesDir) {
      logger.warn('[Startup] Skip daily report: notesDir not configured');
      return;
    }
    const modelResult = await listPiModels();
    if (!modelResult.models || modelResult.models.length === 0) {
      logger.error('[Startup] Cannot generate daily report: pi agent model not configured, run `pi` command to configure');
      return;
    }
    logger.info('[Startup] No daily report for today, generating via pi agent...');
    try {
       const userPart = appConfig.getConfig('daily_report_prompt') || '请按以下格式生成日报：\n\n## 日报格式要求\n使用简化的 Markdown 格式（适配飞书），**不要使用表格**（用 `- key: value` 列表代替）：**\n\n### 1️⃣ 今日概览\n- ✅ 完成任务：数量、📋 待办：数量、💬 对话：次数、📝 笔记：更新数、🗂️ 新增：数量\n\n### 2️⃣ 今日完成\n- 列出今日完成的任务，高优先级的用 ⭐ 标记\n\n### 3️⃣ 待办事项\n- 逾期的用 🔴 标记并注明逾期天数\n- 进行中的用 🔄 标记\n- 高优先级的用 🔴 标记\n\n### 4️⃣ 对话与沟通\n- 今日对话次数和简要摘要\n\n### 5️⃣ 笔记与记录\n- 更新的文档和新增的记录\n\n### 6️⃣ 今日提醒\n- 已启用的提醒（如有）\n\n### 7️⃣ 综合评估\n- 根据完成任务、待办处理、知识沉淀等维度给出今日效率评分（0-100分）\n- 给出具体的改进行动建议\n\n## 格式注意事项\n- **不使用表格**：用 `- 维度 | 说明` 这样的列表代替\n- 数据为空的部分可以略过，不要编造数据\n- 评分要合理，基于实际数据给出\n- 建议要具体、可执行\n- 语言简洁专业，使用中文\n- 只输出日报正文，不要包含任何说明性文字（如"数据来源"、"让我先"、"思考过程"等）';
      const r = await piGenerateDailyReport('startup_' + today, userPart);
      db.run("INSERT INTO ai_analysis (project_id, type, content, report_date, created_at, updated_at) VALUES (NULL, 'daily_report', ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))",
        r, today);
      const retentionDays = parseInt(appConfig.getConfig('daily_report_retention_days') || '30', 10);
      db.run("DELETE FROM ai_analysis WHERE type = 'daily_report' AND report_date < ?", (() => { const d = new Date(Date.now() + 8 * 3600 * 1000 - retentionDays * 86400 * 1000); return d.toISOString().slice(0, 10); })());
      logger.info('[Startup] Daily report generated on startup');
      if (mainWindow) mainWindow.webContents.send('report:generated');
       const feishuWebhook = appConfig.getConfig('feishuWebhookUrl') || '';
       if (feishuWebhook) {
         const feishuText = convertMarkdownForFeishu(r.slice(0, 1800));
          const feishuCard = {
            config: { wide_screen_mode: true },
            elements: [{ tag: 'markdown', content: '📊 AI 综合日报 **' + today + '**\n\n' + feishuText }],
            header: { template: 'blue', title: { tag: 'plain_text', content: '📊 综合日报 ' + today } },
          };
          try {
            await fetch(feishuWebhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                msg_type: 'interactive',
                card: feishuCard,
              })
            });
         } catch (e) {
           logger.warn('[Startup] Feishu notification failed: %s', e.message);
         }
       }
    } catch (e) {
      logger.error('[Startup] Failed to generate daily report: ' + (e.message || e));
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
