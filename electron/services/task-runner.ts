/**
 * 对话/任务 执行核心：一轮追问的公共逻辑 + 入口。
 *
 * 2026-10-31 起：飞书消息不再落 plan_tasks（任务页只保留后台调度任务），
 * 直接落 prj_sessions（source='feishu'）为纯会话，对话页合并展示并带「飞书」徽标。
 * 本模块因此收敛为：
 *
 *   - buildKbPrompt        项目库会话的提示词骨架（飞书首条 / 飞书「继续」 /
 *                          软件内续聊 kb 会话，共用一份口径）
 *   - runFollowupTurn      一轮追问的公共执行核心（加消息 → runPi → 回复落库）
 *   - followUpFeishuSession 飞书「继续」的追问入口（纯会话，无任务簿记）
 *
 * 事件回调由调用方（main.ts）接入：飞书追问同时走 chat:*（桌面对话页实时可见）。
 * 任务不再支持追问（2026-10-31 用户决策）：followUpTask 已随 task:followup IPC 一并移除。
 */
import { runPi } from './pi-agent';
import logger from './logger';
import * as appConfig from './app-config';
import { projectDirOf } from './feishu-router';

// ========== 提示词骨架 ==========

/**
 * 项目库会话的提示词骨架。
 * originLabel：后台任务追问时带上原始任务，帮助模型对齐上下文；普通续聊不传。
 */
export function buildKbPrompt(projectName: string, projectDir: string, question: string, originLabel?: string): string {
  const lines = [
    `以下是项目「${projectName || '默认项目'}」的项目库目录，请直接检索该目录下的文件后回答：`,
    `项目路径：${projectDir || '（未配置）'}`,
    '',
    '检索方式：用 bash 在该目录下自行搜索定位文件（如 rg --glob "*.md" "关键词"），再用 read 读取完整内容；需要目录结构时用 ls 或 find。',
    '该项目根目录的 AGENTS.md 已随会话一并加载，其中的规则（只以 .md 为内容源、目录结构、记忆契约与启动协议等）必须遵守；若 AGENTS.md 要求先读取用户记忆或项目进度，请先调用相应工具再作答。',
    '需要往项目库写内容时，直接用 write / edit 工具写进项目目录。',
  ];
  if (originLabel) lines.push('', `原始任务：${originLabel}`);
  lines.push(`${originLabel ? '用户追问' : '用户问题'}：${question}`);
  return lines.join('\n');
}

// ========== 一轮追问的公共核心 ==========

export interface FollowupTurnOptions {
  /** 提示词里的「原始任务」行（后台任务追问用） */
  originLabel?: string;
  /** 显式模型 pattern */
  model?: string;
  onDelta?: (delta: string) => void;
  onTool?: (t: any) => void;
  onDone?: (text: string, meta?: { incomplete?: boolean }) => void;
  onError?: (err: string) => void;
}

/**
 * 在既有会话上执行一轮「项目库追问」：加 user 消息 → 组装 kb 提示词 → runPi → 回复落库。
 * 项目口径：会话已记录的 project_id 优先（避免「首条跑 A、追问跑 B」），
 * 无项目会话（含旧数据）回落默认项目。
 */
export async function runFollowupTurn(db: any, sessionId: string, question: string, opts: FollowupTurnOptions = {}): Promise<void> {
  const session = db.chat.getSession(sessionId);
  const project: any = session && session.project_id && Number.isFinite(Number(session.project_id))
    ? db.project.get(Number(session.project_id)) : null;
  const noteProj: any = project || db.qOne("SELECT * FROM prj_projects ORDER BY is_default DESC, id ASC LIMIT 1");
  const notesDir = projectDirOf(project) || (noteProj && noteProj.dir) || appConfig.getConfig('notesDir') || '';

  db.chat.addMessage(sessionId, 'user', question, 'general');

  let reply = '';
  const onDelta = (delta: string) => {
    reply += delta;
    try { opts.onDelta && opts.onDelta(delta); } catch (e: any) { logger.warn('[Followup] onDelta callback failed: %s', e?.message); }
  };
  const onTool = (t: any) => {
    try { opts.onTool && opts.onTool(t); } catch (e: any) { logger.warn('[Followup] onTool callback failed: %s', e?.message); }
  };
  const onDone = (finalText: string, meta?: { incomplete?: boolean }) => {
    if (finalText) reply = finalText;
    db.chat.addMessage(sessionId, 'assistant', reply, 'general');
    try { opts.onDone && opts.onDone(reply, meta); } catch (e: any) { logger.warn('[Followup] onDone callback failed: %s', e?.message); }
  };
  const onError = (err: string) => {
    db.chat.addMessage(sessionId, 'assistant', `❌ ${err}`, 'general');
    try { opts.onError && opts.onError(String(err)); } catch (e: any) { logger.warn('[Followup] onError callback failed: %s', e?.message); }
  };

  const { buildReportToolDefs, buildDataToolDefs } = require('./tools');
  const customTools: any[] = [];
  customTools.push(...(await buildReportToolDefs(undefined)));
  if (notesDir) customTools.push(...(await buildDataToolDefs(notesDir)));

  await runPi({
    prompt: buildKbPrompt((noteProj && noteProj.name) || '', notesDir, question, opts.originLabel),
    sessionId,
    cwd: notesDir || undefined,
    modelPattern: opts.model || undefined,
    customTools,
    // 不设超时（2026-10-31 用户决策）：300 秒硬超时会掐断活跃的长任务——
    // 曾把「查 4 个数据集 + 读笔记」任务干到一半的旁白当结果发出。
    // 代价：模型限流(429)无限退避时会一直挂着，需用户在界面主动停止。
    onDelta, onTool, onDone, onError,
  });
}

// ========== 飞书「继续」（纯会话，无任务簿记） ==========

/**
 * 飞书「继续」：复用最近一条飞书会话继续对话。
 * 会话化后（2026-10-31）没有任务行可挂状态，防重入由调用方（main.ts）用内存集合负责；
 * 结果经回调交调用方接入 chat:* 事件（桌面实时可见）与飞书回包。
 * 返回 false 表示会话不存在。
 */
export async function followUpFeishuSession(
  sessionId: string, question: string, db: any,
  opts: FollowupTurnOptions = {},
): Promise<boolean> {
  const session = db.chat.getSession(sessionId);
  if (!session) return false;
  (async () => {
    try {
      await runFollowupTurn(db, sessionId, question, opts);
    } catch (e: any) {
      logger.error('[Followup] feishu session execution failed: %s', e?.message);
      try { opts.onError && opts.onError((e && e.message) || String(e)); } catch (e2: any) { logger.warn('[Followup] onError callback failed: %s', e2?.message); }
    }
  })();
  return true;
}
