import * as fs from 'node:fs';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { AgentAdapter, AgentDeps } from './base';
import type { AgentKind, AgentSession, Decision } from '../types';
import logger from '../../services/logger';

/**
 * Claude Code 适配器（从 qihang-code-approver 移植）：进程内 SDK query() + canUseTool 承接审批。
 * - 空闲看门狗 5 分钟：长命令空窗正常，但挂起中的审批只续期不强杀；
 * - 必须 settings.disableAllHooks=true，否则用户级 PermissionRequest hook 会抢先拒绝；
 * - allow_session 用 SDK suggestions 落成会话级规则，daemon 不自维护白名单。
 */

const IDLE_TIMEOUT_MS = 5 * 60_000;

interface PendingPermission {
  resolve: (result: any) => void;
  input: any;
  suggestions?: any[];
  toolUseID: string;
}

interface ClaudeSession {
  s: AgentSession;
  sdkSessionId: string | null;
  abortController: AbortController | null;
  query: any;
  aborted: boolean;
  /** 看门狗硬中止标记：按失败收口而非用户中止 */
  hardKilled: boolean;
  pending: Map<string, PendingPermission>;
  idleTimer: NodeJS.Timeout | null;
}

function summarizeClaudeInput(toolName: string, input: any): { summary: string; detail: string } {
  let json = '';
  try { json = JSON.stringify(input) ?? ''; } catch { json = String(input); }
  let detail = json;
  if (toolName === 'Bash' && typeof input?.command === 'string') {
    detail = input.command;
  } else if (toolName === 'Write' && typeof input?.file_path === 'string') {
    detail = `${input.file_path}\n${String(input.content ?? '').slice(0, 1500)}`;
  } else if (toolName === 'Edit' && typeof input?.file_path === 'string') {
    detail = `${input.file_path}\n- ${String(input.old_string ?? '').slice(0, 600)}\n+ ${String(input.new_string ?? '').slice(0, 1200)}`;
  }
  return { summary: json.slice(0, 200), detail: detail.slice(0, 2000) };
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind: AgentKind = 'claude';
  private sessions = new Map<string, ClaudeSession>();

  constructor(private deps: AgentDeps, private opts?: { claudePath?: string }) {}

  async createSession(opts: { cwd: string; title?: string; resume?: string }): Promise<AgentSession> {
    if (!fs.existsSync(opts.cwd)) throw new Error(`项目目录不存在: ${opts.cwd}`);
    const s: AgentSession = {
      id: `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agent: this.kind,
      cwd: opts.cwd,
      title: opts.title || 'Claude 会话',
      status: 'starting',
      createdAt: new Date().toISOString(),
      externalId: opts.resume || undefined,
    };
    const cs: ClaudeSession = {
      s,
      sdkSessionId: opts.resume || null,
      abortController: null,
      query: null,
      aborted: false,
      hardKilled: false,
      pending: new Map(),
      idleTimer: null,
    };
    this.sessions.set(s.id, cs);
    s.status = 'idle';
    this.deps.onSessionUpdate(s);
    return s;
  }

  private entry(sessionId: string): ClaudeSession {
    const cs = this.sessions.get(sessionId);
    if (!cs) throw new Error(`claude 会话不存在: ${sessionId}`);
    return cs;
  }

  private transcribe(cs: ClaudeSession, kind: 'text' | 'thinking' | 'tool' | 'system', text: string): void {
    if (!text) return;
    this.deps.onTranscript(cs.s.id, { ts: new Date().toISOString(), kind, text });
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const cs = this.entry(sessionId);
    if (cs.query) throw new Error('该会话已有任务在跑，先等完成或中止');

    cs.abortController = new AbortController();
    cs.aborted = false;
    let turnSettled = false;
    cs.s.status = 'running';
    cs.s.lastError = undefined;
    this.deps.onSessionUpdate(cs.s);

    try {
      const options: Record<string, any> = {
        cwd: cs.s.cwd,
        abortController: cs.abortController,
        includePartialMessages: true,
        persistSession: true,
        permissionMode: 'default',
        canUseTool: this.handleCanUseTool(cs),
        // 审批由本进程 canUseTool 承接；用户 settings 里的 PermissionRequest 钩子
        // （如 agenthub，onFailure:block）会在 CLI 侧抢先拒绝并取消请求，导致审批秒拒
        settings: { disableAllHooks: true },
      };
      if (this.opts?.claudePath) options.pathToClaudeCodeExecutable = this.opts.claudePath;
      if (cs.sdkSessionId) options.resume = cs.sdkSessionId;

      cs.query = sdkQuery({ prompt: text, options } as any);

      let idleTimedOut = false;
      const armIdleTimer = () => {
        if (cs.idleTimer) clearTimeout(cs.idleTimer);
        cs.idleTimer = setTimeout(() => {
          // 等手机审批是合法长空窗：续期而不是杀会话
          if (cs.pending.size > 0) { armIdleTimer(); return; }
          logger.warn('[Approver][claude] %s 超过 5 分钟无消息，判定卡死并中断', cs.s.id);
          idleTimedOut = true;
          this.rejectPending(cs, 'Claude 空闲超时');
          cs.query?.interrupt().catch(() => {});
          // interrupt() 对挂死的流可能无效（如 DeepSeek API 不回包）：
          // 60s 仍未收口就硬中止，按失败收口让追问回合能正常结束
          setTimeout(() => {
            if (!turnSettled) {
              logger.warn('[Approver][claude] %s interrupt 60s 未收口，硬中止', cs.s.id);
              cs.hardKilled = true;
              cs.abortController?.abort();
            }
          }, 60_000).unref?.();
        }, IDLE_TIMEOUT_MS);
      };
      armIdleTimer();

      let turnComplete = false;
      let sawStreamEvent = false;
      let seenEndTurn = false;
      let toolAccu: { name: string; args: string } | null = null;
      // 流式 delta 很碎（1-2 字/条），按块累积、块结束时整块入转录
      let textAccu = '';
      let thinkAccu = '';

      try {
        for await (const msg of cs.query) {
          armIdleTimer();
          if (cs.aborted) break;

          switch (msg?.type) {
            case 'stream_event': {
              sawStreamEvent = true;
              const ev = (msg as any).event || {};
              if (msg.session_id) { cs.sdkSessionId = msg.session_id; cs.s.externalId = msg.session_id || undefined; }
              switch (ev.type) {
                case 'message_delta':
                  if (ev.delta?.stop_reason === 'end_turn') seenEndTurn = true;
                  break;
                case 'content_block_start': {
                  const block = ev.content_block || ev.contentBlock || {};
                  if (block.type === 'text') textAccu = '';
                  else if (block.type === 'thinking') thinkAccu = block.thinking || '';
                  if (block.type === 'tool_use') {
                    toolAccu = { name: block.name || '', args: JSON.stringify(block.input ?? {}) };
                    this.transcribe(cs, 'tool', `▶ ${block.name} ${JSON.stringify(block.input ?? {}).slice(0, 300)}`);
                  }
                  break;
                }
                case 'content_block_delta': {
                  const delta = ev.delta || {};
                  if (delta.type === 'text_delta' && delta.text) textAccu += delta.text;
                  else if (delta.type === 'thinking_delta' && delta.thinking) thinkAccu += delta.thinking;
                  else if (delta.type === 'input_json_delta' && toolAccu && delta.partial_json) {
                    try { toolAccu.args = JSON.stringify(JSON.parse(delta.partial_json)); } catch { /* 分片 JSON 不完整 */ }
                  }
                  break;
                }
                case 'content_block_stop':
                  if (textAccu) { this.transcribe(cs, 'text', textAccu); textAccu = ''; }
                  if (thinkAccu) { this.transcribe(cs, 'thinking', thinkAccu); thinkAccu = ''; }
                  if (toolAccu) { this.transcribe(cs, 'tool', `✔ ${toolAccu.name}`); toolAccu = null; }
                  break;
                case 'message_stop':
                  if (seenEndTurn) { turnComplete = true; seenEndTurn = false; }
                  break;
              }
              break;
            }

            case 'assistant': {
              if ((msg as any).session_id) {
                cs.sdkSessionId = (msg as any).session_id;
                cs.s.externalId = cs.sdkSessionId || undefined;
              }
              if (!sawStreamEvent) {
                // 有的 SDK 构建不吐流式事件，文本/工具只在完整消息里，补发防丢
                const content: any = (msg as any).message?.content;
                const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
                for (const block of blocks) {
                  if (block.type === 'text' && block.text) this.transcribe(cs, 'text', block.text);
                  else if (block.type === 'thinking' && block.thinking) this.transcribe(cs, 'thinking', block.thinking);
                  else if (block.type === 'tool_use') this.transcribe(cs, 'tool', `▶ ${block.name} ${JSON.stringify(block.input ?? {}).slice(0, 300)}`);
                }
              }
              break;
            }

            case 'result':
              // SDK 一轮对话的权威结束信号；一轮可能多条 assistant，不能提前退
              turnComplete = true;
              break;

            case 'user':
              if ((msg as any).session_id) {
                cs.sdkSessionId = (msg as any).session_id;
                cs.s.externalId = cs.sdkSessionId || undefined;
              }
              break;
          }

          if (turnComplete) break;
        }
      } finally {
        if (cs.idleTimer) { clearTimeout(cs.idleTimer); cs.idleTimer = null; }
      }

      if (idleTimedOut) {
        cs.s.status = 'failed';
        cs.s.lastError = '超过 5 分钟无响应，已自动中断';
      } else if (cs.aborted) {
        cs.s.status = 'aborted';
      } else {
        cs.s.status = 'idle';
      }
    } catch (err: any) {
      if (cs.hardKilled) {
        cs.s.status = 'failed';
        cs.s.lastError = '超过 5 分钟无响应，已强制中断';
      } else if (cs.aborted || err?.name === 'AbortError' || String(err?.message || '').includes('abort')) {
        cs.s.status = 'aborted';
      } else {
        logger.error('[Approver][claude] prompt error: %s', err?.message || err);
        cs.s.status = 'failed';
        cs.s.lastError = String(err?.message || err).slice(0, 500);
        this.transcribe(cs, 'system', `出错: ${cs.s.lastError}`);
      }
    } finally {
      turnSettled = true;
      const q = cs.query;
      cs.query = null;
      cs.abortController = null;
      this.rejectPending(cs, '回合已结束');
      this.deps.cancelApprovals(cs.s.id);
      // break 会让生成器停在半路：不调 return() 就不触发 SDK 拆除逻辑，claude 子进程泄漏
      await q?.return(undefined as any).catch(() => {});
      this.deps.onSessionUpdate(cs.s);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const cs = this.entry(sessionId);
    cs.aborted = true;
    try { await cs.query?.interrupt(); } catch { /* ignore */ }
    cs.abortController?.abort();
    this.rejectPending(cs, '任务被中止');
  }

  async disposeAll(): Promise<void> {
    for (const cs of this.sessions.values()) {
      cs.aborted = true;
      try { await cs.query?.interrupt(); } catch { /* ignore */ }
      cs.abortController?.abort();
      if (cs.idleTimer) clearTimeout(cs.idleTimer);
    }
    this.sessions.clear();
  }

  private rejectPending(cs: ClaudeSession, message: string): void {
    for (const p of cs.pending.values()) {
      p.resolve({ behavior: 'deny', message, interrupt: true, toolUseID: p.toolUseID });
    }
    cs.pending.clear();
  }

  private handleCanUseTool(cs: ClaudeSession) {
    return (toolName: string, input: any, options: any): Promise<any> => {
      const { summary, detail } = summarizeClaudeInput(toolName, input);
      return new Promise((resolve) => {
        // 注册挂起句柄：看门狗看 pending 续期；abort/超时由 rejectPending 统一 deny 收口
        cs.pending.set(options.toolUseID, { resolve, input, suggestions: options.suggestions, toolUseID: options.toolUseID });

        // SDK 中断时 must resolve：挂着的 canUseTool 不释放会拖死整轮收尾
        options.signal?.addEventListener('abort', () => {
          this.deps.cancelApprovals(cs.s.id);
        }, { once: true });

        this.deps.requestApproval({
          agent: 'claude',
          sessionId: cs.s.id,
          cwd: cs.s.cwd,
          tool: toolName,
          inputSummary: summary,
          detail,
        }).then((decision: Decision) => {
          if (!cs.pending.has(options.toolUseID)) return; // 已被 rejectPending 收口
          cs.pending.delete(options.toolUseID);
          if (decision === 'deny') {
            resolve({
              behavior: 'deny',
              message: '已在启航AI工作台（飞书）拒绝',
              interrupt: false,
              toolUseID: options.toolUseID,
            });
            return;
          }
          resolve({
            behavior: 'allow',
            updatedInput: input,
            // allow_session 用 SDK 的 suggestions 落成会话级规则
            updatedPermissions: decision === 'allow_session' ? options.suggestions : undefined,
            toolUseID: options.toolUseID,
          });
        });
      });
    };
  }
}
