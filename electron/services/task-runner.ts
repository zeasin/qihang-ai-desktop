/**
 * 飞书任务执行：任务记录 + 追问续跑。
 *
 * 飞书消息落库为 plan_tasks（task_type 'note'），追问复用原 pi 会话在笔记库中
 * 继续执行，流式进度以 task:followup:* 事件回传桌面端。
 */
import { runPi } from './pi-agent';
import logger from './logger';
import * as appConfig from './app-config';

function nowString(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function notifyTaskChanged() {
  try {
    const { BrowserWindow } = require('electron') as typeof import('electron');
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('task:changed');
    }
  } catch {}
}

/** 创建任务记录（挂到项目下），返回 { 任务id, 执行记录id } */
export function recordFeishuTask(db: any, project: any, text: string, sessionId?: string, taskType = 'note'): { taskId: number | null; execId: number | null } {
  try {
    const r = db.task.add({
      title: text.slice(0, 100),
      prompt: text,
      task_type: taskType,
      project_id: project && project.id && Number.isFinite(Number(project.id)) ? Number(project.id) : null,
      source: 'feishu',
      trigger_type: 'now',
      status: 'in_progress',
      session_id: sessionId || '',
    });
    const execId = db.taskExecution.add({
      task_id: r.id, task_title: r.title, status: 'RUNNING',
      trigger_type: 'manual', start_time: nowString(),
    });
    notifyTaskChanged();
    return { taskId: r.id, execId };
  } catch (e) {
    logger.error('[TaskRunner] record task failed: %s', e.message);
    return { taskId: null, execId: null };
  }
}

// ========== 任务追问（复用原 session，流式回传） ==========

function emitFollowup(type: string, payload: any) {
  try {
    const { BrowserWindow } = require('electron') as typeof import('electron');
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('task:followup:' + type, payload);
    }
  } catch {}
}

/**
 * 任务追问：复用任务的原始会话，在笔记库中继续对话。
 * 结果以 task:followup:delta / done / error 事件流式回传。
 * opts.stage：传入后笔记写入类工具（写/编辑/删除）改为落暂存区，等待用户确认落地。
 */
export async function followUpTask(
  taskId: number, question: string, db: any,
  opts: { stage?: { taskId: number }; onDone?: (text: string) => void; onError?: (err: string) => void } = {},
): Promise<boolean> {
  const task = db.task.get(taskId);
  if (!task) return false;
  if (task.status === 'in_progress') return false;
  const project: any = task.project_id && Number.isFinite(Number(task.project_id)) ? db.project.get(Number(task.project_id)) : null;

  let sessionId = task.session_id || '';
  if (!sessionId) {
    sessionId = 'task_' + taskId;
    db.chat.createSession(sessionId, project ? project.id : null, (task.title || '').slice(0, 30), 'kb', 'pi', 'ui');
    db.task.update(taskId, { session_id: sessionId });
  }
  db.chat.addMessage(sessionId, 'user', question, 'general');
  db.task.update(taskId, { status: 'in_progress' });
  const execId = db.taskExecution.add({
    task_id: taskId, task_title: task.title, status: 'RUNNING',
    trigger_type: 'followup', start_time: nowString(),
  });
  notifyTaskChanged();

  const finish = (status: string, extra: { error?: string; result?: string } = {}) => {
    const end = nowString();
    if (execId != null) db.taskExecution.update(execId, { status, end_time: end, ...(extra.error ? { error_message: extra.error } : {}), ...(extra.result ? { result_text: extra.result } : {}) });
    db.task.update(taskId, {
      last_status: status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
      last_run_at: end,
      status: status === 'SUCCESS' ? 'done' : 'pending',
      ...(extra.result ? { last_result: extra.result.slice(0, 3000) } : {}),
    });
    notifyTaskChanged();
  };

  (async () => {
    try {
      const { buildReportToolDefs, buildDataToolDefs, buildNoteToolDefs } = require('./tools');
      const notesDir = appConfig.getConfig('notesDir') || (project ? project.dir : '') || '';
      const customTools: any[] = [];
      customTools.push(...(await buildReportToolDefs(undefined)));
      if (notesDir) customTools.push(...(await buildDataToolDefs(notesDir)));
      const noteProj: any = project || db.qOne("SELECT * FROM prj_projects WHERE type = 'note' ORDER BY is_default DESC, id ASC LIMIT 1");
      if (noteProj) customTools.push(...(await buildNoteToolDefs(noteProj.id, { stage: opts.stage })));
      const prompt = `以下是笔记库目录，请用笔记工具自行搜索相关文件后回答：\n笔记库路径：${notesDir || '（未配置）'}\n\n原始任务：${task.prompt || task.title || ''}\n用户追问：${question}`;

      let reply = '';
      await runPi({
        prompt,
        sessionId,
        cwd: notesDir || undefined,
        customTools,
        onDelta: (delta) => {
          reply += delta;
          emitFollowup('delta', { taskId, delta });
        },
        onTool: (t: any) => logger.info('[Followup] tool %s %s', t.name, t.type),
        onDone: (finalText) => {
          if (finalText) reply = finalText;
          db.chat.addMessage(sessionId, 'assistant', reply, 'general');
          finish('SUCCESS', { result: reply });
          emitFollowup('done', { taskId, text: reply });
          try { opts.onDone && opts.onDone(reply); } catch (e: any) { logger.warn('[Followup] onDone callback failed: %s', e?.message); }
        },
        onError: (err) => {
          db.chat.addMessage(sessionId, 'assistant', `❌ ${err}`, 'general');
          finish('FAILED', { error: String(err) });
          emitFollowup('error', { taskId, error: String(err) });
          try { opts.onError && opts.onError(String(err)); } catch (e: any) { logger.warn('[Followup] onError callback failed: %s', e?.message); }
        },
      });
    } catch (e: any) {
      logger.error('[Followup] execution failed: %s', e?.message);
      finish('FAILED', { error: (e && e.message) || String(e) });
      emitFollowup('error', { taskId, error: (e && e.message) || String(e) });
      try { opts.onError && opts.onError((e && e.message) || String(e)); } catch (e2: any) { logger.warn('[Followup] onError callback failed: %s', e2?.message); }
    }
  })();

  return true;
}
