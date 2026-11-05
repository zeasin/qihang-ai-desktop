import { readClaudeTaskTail } from './local-sessions';
import type { AgentKind } from './types';

/** 一条「任务回合结束」的归一化描述（从 qihang-code-approver 移植）：托管会话与外部 agent 钩子共用 */
export interface TaskReport {
  agent: AgentKind;
  /** 会话展示名；外部会话用「外部会话」 */
  label: string;
  cwd: string;
  task: string;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** 收尾正文摘要（claude Stop 的 last_assistant_message） */
  result?: string;
  /** 会话标识：托管会话是本进程 id；外部会话是 agent 侧原生 id（供「接着问」卡片 resume） */
  sessionId?: string;
}

const TASK_CAP = 120;
const RESULT_CAP = 300;

function oneLine(text: string, cap: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, cap);
}

export function buildTaskBody(r: TaskReport, resultCap: number): string {
  const lines = [
    r.ok ? '✅ 任务完成' : '❌ 任务失败',
    `会话：${r.label || '外部会话'}（${r.agent}）`,
    `目录：${r.cwd || '?'}`,
  ];
  if (r.durationMs > 0) lines.push(`耗时：${Math.max(1, Math.round(r.durationMs / 1000))}秒`);
  // DSH 的会话标题就是首条任务改写，重复一行没信息量
  const taskLine = oneLine(r.task, TASK_CAP);
  if (taskLine && taskLine !== oneLine(r.label, TASK_CAP)) lines.push(`任务：${taskLine}`);
  if (!r.ok && r.error) lines.push(`错误：${oneLine(r.error, 200)}`);
  if (r.ok && r.result) lines.push(`\n${r.result.slice(0, resultCap)}${r.result.length > resultCap ? `\n…（正文超 ${resultCap} 字已截断）` : ''}`);
  return lines.join('\n');
}

/** 纯文本通知（降级用）：正文只留摘要 */
export function buildTaskNotify(r: TaskReport): string {
  return buildTaskBody(r, RESULT_CAP);
}

function str(v: any): string {
  return typeof v === 'string' ? v : '';
}

/** DSH 会话 id 形如 session-<uuid>，直接 slice(0,8) 只剩前缀 */
function shortId(id: string): string {
  return id.replace(/^(session|dsh)-/, '').slice(0, 8);
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** DSH 插件 turn/end 上报（camelCase）；aborted/interrupted 属用户主动中止，不通知 */
function fromDshHook(body: any): TaskReport | null {
  const kind = str(body?.reason);
  if (!kind) return null;
  if (kind === 'aborted' || kind === 'interrupted' || kind === 'cancelled' || kind === 'forked') return null;
  const sessionId = str(body?.sessionId);
  if (!sessionId) return null;
  // 子代理会话 id 是纯 UUID（无 session- 前缀），只在主回合收口时通知
  if (!sessionId.startsWith('session-')) return null;
  return {
    agent: 'dsh',
    sessionId,
    label: str(body?.title) || `DSH 外部会话 ${shortId(sessionId)}`,
    cwd: str(body?.cwd),
    task: str(body?.task),
    ok: kind === 'completed',
    durationMs: num(body?.durationMs),
    result: str(body?.result) || undefined,
    error: kind === 'completed' ? undefined : `${kind}${str(body?.errorMessage) ? `：${body.errorMessage}` : ''}`,
  };
}

/** Claude Code Stop 钩子（snake_case 原生载荷）：任务文本与耗时从转录尾部还原 */
async function fromClaudeStop(body: any): Promise<TaskReport | null> {
  const sessionId = str(body?.session_id);
  if (!sessionId) return null;
  const transcriptPath = str(body?.transcript_path);
  const tail = await readClaudeTaskTail(transcriptPath);
  return {
    agent: 'claude',
    sessionId,
    label: `Claude 外部会话 ${shortId(sessionId)}`,
    cwd: str(body?.cwd) || tail.cwd,
    task: tail.task,
    ok: true,
    durationMs: tail.durationMs,
    result: str(body?.last_assistant_message),
  };
}

/**
 * pi CLI 终端 task-done 上报（pi-approver-gate 扩展在 agent_end 时 POST）：
 * camelCase，sessionId/cwd/task/result 由扩展从 agent_end 的 messages 提取。
 * aborted 属用户主动中止，不通知（与 DSH 一致）。
 */
function fromPiHook(body: any): TaskReport | null {
  const sessionId = str(body?.sessionId);
  if (!sessionId) return null;
  const ok = body?.ok !== false;
  if (!ok && str(body?.reason) === 'aborted') return null;
  return {
    agent: 'pi',
    sessionId,
    label: `Pi 外部会话 ${shortId(sessionId)}`,
    cwd: str(body?.cwd),
    task: str(body?.task),
    ok,
    durationMs: num(body?.durationMs),
    result: str(body?.result) || undefined,
    error: ok ? undefined : `${str(body?.reason) || 'error'}${str(body?.errorMessage) ? `：${body.errorMessage}` : ''}`,
  };
}

/**
 * 钩子请求体归一化：外部 agent 自己跑完一回合后 POST 过来。
 * 字段缺失/来源不认识返回 null，路由按无操作响应，不打断 agent。
 */
export async function normalizeTaskDone(body: any): Promise<TaskReport | null> {
  if (!body || typeof body !== 'object') return null;
  if (str(body.source).toLowerCase() === 'dsh') return fromDshHook(body);
  if (str(body.source).toLowerCase() === 'pi') return fromPiHook(body);
  if (str(body.hook_event_name) === 'Stop') return fromClaudeStop(body);
  return null;
}

// ========== 「接着问」追问暂存（外部 DSH 会话） ==========
// 本进程无法 resume 被 DSH 桌面端占用的会话（active write handle），
// 追问文本按 sessionId 暂存，由 DSH 应用内的 dsh-approver 插件长轮询取走、注入原会话执行。
const FOLLOWUP_TTL = 10 * 60_000;
const pendingFollowups = new Map<string, { text: string; at: number }>();

export function stashFollowup(sessionId: string, text: string): void {
  if (!sessionId || !text) return;
  const now = Date.now();
  for (const [k, v] of pendingFollowups) if (now - v.at > FOLLOWUP_TTL) pendingFollowups.delete(k);
  pendingFollowups.set(sessionId, { text, at: now });
}

/** 取走并清除某会话的追问；waitMs>0 时长轮询（每 500ms 查一次） */
export async function takeFollowup(sessionId: string, waitMs = 0): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const v = pendingFollowups.get(sessionId);
    if (v) {
      pendingFollowups.delete(sessionId);
      return Date.now() - v.at <= FOLLOWUP_TTL ? v.text : null;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}
