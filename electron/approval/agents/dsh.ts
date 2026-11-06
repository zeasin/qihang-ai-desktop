import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { AgentAdapter, AgentDeps } from './base';
import type { AgentKind, AgentSession, Decision } from '../types';
import logger from '../../services/logger';

/** 账号路由模型：--patch 改默认模型在运行时不生效，用 session/set_config_option 显式切换 */
const ACCOUNT_MODEL = '["deepseek-account","deepseek-flash"]';

/**
 * DSH（DeepSeek Harness）ACP 适配器（从 qihang-code-approver 移植）：
 * spawn `dsh --profile acp`，newline-delimited JSON-RPC over stdio。
 * 一会话一进程（ACP 单进程同时只允许一个 prompt），权限走 session/request_permission 反向请求。
 * DSH 是 RC 版，协议可能漂移：字段全 ?. 可选解析、未知通知忽略、一切反向请求必应答防 prompt 挂死。
 */

interface DshSession {
  s: AgentSession;
  proc: any;
  rl: readline.Interface | null;
  acpSessionId: string;
  model?: string;
  nextId: number;
  pending: Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>;
  /** allow_session 落的工具名：后续同工具请求自动放行 */
  allowlist: Set<string>;
  activePrompt: boolean;
  shuttingDown: boolean;
  abortDeadline: NodeJS.Timeout | null;
}

export interface DshConfig {
  dshPath: string;
  dshArgs: string[];
}

export class DshAdapter implements AgentAdapter {
  readonly kind: AgentKind = 'dsh';
  private sessions = new Map<string, DshSession>();

  constructor(private deps: AgentDeps, private cfg: DshConfig) {}

  async createSession(opts: { cwd: string; title?: string; resume?: string }): Promise<AgentSession> {
    if (!fs.existsSync(opts.cwd)) throw new Error(`项目目录不存在: ${opts.cwd}`);
    const s: AgentSession = {
      id: `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agent: this.kind,
      cwd: opts.cwd,
      title: opts.title || 'DSH 会话',
      status: 'starting',
      createdAt: new Date().toISOString(),
    };
    const ds: DshSession = {
      s,
      proc: null,
      rl: null,
      acpSessionId: '',
      nextId: 1,
      pending: new Map(),
      allowlist: new Set(),
      activePrompt: false,
      shuttingDown: false,
      abortDeadline: null,
    };
    this.sessions.set(s.id, ds);
    try {
      await this.startProc(ds, opts.resume);
    } catch (e: any) {
      s.status = 'failed';
      s.lastError = String(e?.message || e);
      this.deps.onSessionUpdate(s);
      throw e;
    }
    s.status = 'idle';
    s.externalId = ds.acpSessionId;
    if (ds.model) s.model = ds.model;
    this.deps.onSessionUpdate(s);
    return s;
  }

  private entry(sessionId: string): DshSession {
    const ds = this.sessions.get(sessionId);
    if (!ds) throw new Error(`dsh 会话不存在: ${sessionId}`);
    return ds;
  }

  private transcribe(ds: DshSession, kind: 'text' | 'thinking' | 'tool' | 'system', text: string): void {
    if (!text) return;
    this.deps.onTranscript(ds.s.id, { ts: new Date().toISOString(), kind, text });
  }

  /** Windows .cmd 垫片必须 shell:true 才能起；路径含空格交给 shell 时要整体引起来 */
  private startProc(ds: DshSession, resume?: string): Promise<void> {
    const cmd = this.cfg.dshPath;
    const args = [...this.cfg.dshArgs];
    if (!fs.existsSync(cmd)) {
      throw new Error(`dsh 不存在: ${cmd}（设置里配置 dshPath 指向 dsh.cmd 绝对路径）`);
    }
    logger.info('[Approver][dsh] spawn: %s %s (cwd=%s)', cmd, args.join(' '), ds.s.cwd);
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    const quoted = useShell && /\s/.test(cmd) ? `"${cmd}"` : cmd;
    const proc = spawn(quoted, args, {
      cwd: ds.s.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useShell,
      // 本进程驱动的 dsh 里，dsh-approver 插件靠这个标记退避：
      // 审批走 ACP 反向请求，完成通知走 SessionManager，否则同一回合会报两遍
      env: { ...process.env, QIHANG_APPROVER_CHILD: '1' },
    });
    ds.proc = proc;

    proc.on('error', (e: any) => {
      logger.error('[Approver][dsh] process error: %s', e?.message);
      this.rejectAllPending(ds, `dsh 进程启动失败：${e?.message}`);
    });
    proc.stderr?.on('data', (c: any) => {
      const line = String(c).trim();
      if (line) logger.warn('[Approver][dsh] stderr: %s', line.slice(0, 300));
    });
    proc.on('exit', (code: any, signal: any) => {
      logger.info('[Approver][dsh] process exited code=%s signal=%s', code, signal);
      this.rejectAllPending(ds, `dsh 进程已退出（code=${code} signal=${signal}）`);
      if (!ds.shuttingDown) {
        ds.s.status = 'failed';
        ds.s.lastError = `dsh 进程退出 code=${code}`;
        this.deps.onSessionUpdate(ds.s);
      }
    });

    ds.rl = readline.createInterface({ input: proc.stdout });
    ds.rl.on('line', (line: string) => {
      const t = line.trim();
      if (!t) return;
      let msg: any;
      try { msg = JSON.parse(t); } catch { logger.warn('[Approver][dsh] non-JSON stdout: %s', t.slice(0, 200)); return; }
      this.onMessage(ds, msg);
    });

    return this.handshake(ds, resume);
  }

  /** 显式把会话模型切到账号路由（api-key 路由本机 key 无效，会 401） */
  private async applyAccountModel(ds: DshSession): Promise<void> {
    try {
      await this.request(ds, 'session/set_config_option', { sessionId: ds.acpSessionId, configId: 'model', value: ACCOUNT_MODEL });
      ds.model = ACCOUNT_MODEL;
      ds.s.model = ACCOUNT_MODEL;
    } catch (e: any) {
      logger.warn('[Approver][dsh] set_config_option(model) 失败: %s', e?.message);
    }
  }

  /** resume：acp 无 CLI 恢复参数，用 session/resume 按持久化 id 恢复（不支持时退回新建会话） */
  private async handshake(ds: DshSession, resume?: string): Promise<void> {
    const init: any = await this.request(ds, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'qihang-ai-desktop', title: '启航AI工作台', version: '0.13.0' },
    });
    if (init?.protocolVersion && Number(init.protocolVersion) !== 1) {
      logger.warn('[Approver][dsh] ACP protocolVersion=%s（按 v1 兼容处理）', init.protocolVersion);
    }
    if (resume) {
      try {
        await this.request(ds, 'session/resume', { sessionId: resume, cwd: ds.s.cwd });
        ds.acpSessionId = resume;
        await this.applyAccountModel(ds);
        logger.info('[Approver][dsh] session resumed: %s model=%s', resume, ds.model || '?');
        return;
      } catch (e: any) {
        logger.warn('[Approver][dsh] session/resume 失败（%s），退回新建会话', e?.message);
        this.transcribe(ds, 'system', `原会话无法恢复（${e?.message}），本次追问在新会话中执行，不带原上下文`);
      }
    }
    const res: any = await this.request(ds, 'session/new', { cwd: ds.s.cwd, mcpServers: [] });
    ds.acpSessionId = String(res?.sessionId || '');
    if (!ds.acpSessionId) throw new Error('session/new 未返回 sessionId');
    ds.model = (res?.configOptions || []).find((o: any) => /model/i.test(String(o?.id || '')))?.currentValue;
    await this.applyAccountModel(ds);
    logger.info('[Approver][dsh] session ready: %s model=%s', ds.acpSessionId, ds.model || '?');
  }

  // ---- JSON-RPC 传输 ----

  /** timeoutMs=0 表示不限时（session/prompt 可跑很久）；其余默认 30s */
  private request(ds: DshSession, method: string, params: any, timeoutMs = 30_000): Promise<any> {
    if (!ds.proc) return Promise.reject(new Error('dsh 进程未运行'));
    const id = ds.nextId++;
    return new Promise((resolve, reject) => {
      ds.pending.set(String(id), { resolve, reject });
      this.write(ds, { jsonrpc: '2.0', id, method, params });
      if (timeoutMs > 0) {
        setTimeout(() => {
          const waiter = ds.pending.get(String(id));
          if (!waiter) return;
          ds.pending.delete(String(id));
          waiter.reject(new Error(`${method} 超时 ${timeoutMs}ms 无响应`));
        }, timeoutMs).unref?.();
      }
    });
  }

  private rejectAllPending(ds: DshSession, reason: string): void {
    for (const { reject } of ds.pending.values()) reject(new Error(reason));
    ds.pending.clear();
    this.deps.cancelApprovals(ds.s.id);
  }

  private write(ds: DshSession, msg: any): void {
    try {
      ds.proc?.stdin?.write(JSON.stringify(msg) + '\n');
    } catch (e: any) {
      logger.error('[Approver][dsh] stdin write failed: %s', e?.message);
    }
  }

  private onMessage(ds: DshSession, m: any): void {
    // 响应
    if (m.id !== undefined && m.method === undefined) {
      const waiter = ds.pending.get(String(m.id));
      if (!waiter) return;
      ds.pending.delete(String(m.id));
      if (m.error) waiter.reject(new Error(`${m.error.code} ${m.error.message}`));
      else waiter.resolve(m.result);
      return;
    }
    // 通知
    if (m.id === undefined && m.method) return this.onNotification(ds, m.method, m.params || {});
    // 服务端反向请求
    if (m.id !== undefined && m.method) return this.onServerRequest(ds, m.id, m.method, m.params || {});
  }

  private onNotification(ds: DshSession, method: string, p: any): void {
    if (method !== 'session/update') return;
    const update = p.update || {};
    switch (update.sessionUpdate) {
      case 'tool_call':
        this.transcribe(ds, 'tool', `▶ ${update.name || update.title || 'tool'} ${JSON.stringify(update.rawInput ?? {}).slice(0, 300)}`);
        break;
      case 'tool_call_update': {
        const status = String(update.status || '');
        if (status === 'completed' || status === 'failed') {
          this.transcribe(ds, 'tool', `✔ ${update.name || 'tool'}${status === 'failed' ? ' (失败)' : ''}`);
        }
        break;
      }
      case 'agent_message_chunk': {
        const text = update.content?.type === 'text' ? String(update.content.text || '') : '';
        this.transcribe(ds, 'text', text);
        break;
      }
      case 'agent_thought_chunk': {
        const text = update.content?.type === 'text' ? String(update.content.text || '') : '';
        this.transcribe(ds, 'thinking', text);
        break;
      }
      case 'config_option_update': {
        const model = (p.configOptions || update.configOptions || [])
          .find((o: any) => o?.id === 'model' || /model/i.test(String(o?.id || '')))?.currentValue;
        if (model && model !== ds.model) {
          ds.model = String(model);
          ds.s.model = ds.model;
          this.deps.onSessionUpdate(ds.s);
        }
        break;
      }
      default:
        // available_commands_update / current_mode_update / plan / 未知类型：忽略
        break;
    }
  }

  private onServerRequest(ds: DshSession, id: number | string, method: string, p: any): void {
    if (method === 'session/request_permission') {
      void this.handlePermissionRequest(ds, id, p);
      return;
    }
    // ACP 之外的反向请求：明确拒绝，避免 agent 挂死
    this.write(ds, { jsonrpc: '2.0', id, error: { code: -32601, message: `method not supported: ${method}` } });
  }

  private async handlePermissionRequest(ds: DshSession, id: number | string, p: any): Promise<void> {
    const callId = String(id);
    const toolCall = p.toolCall || {};
    const options: any[] = p.options || [];
    const toolName = String(toolCall.name || toolCall.title || 'tool');
    const rawInput = toolCall.rawInput ?? {};
    const command = typeof rawInput?.command === 'string' ? rawInput.command : JSON.stringify(rawInput).slice(0, 200);

    const pickAllow = (): string | null => {
      const pick = options.find((o: any) => o?.kind === 'allow_once')
        || options.find((o: any) => String(o?.kind || '').startsWith('allow'));
      return pick ? String(pick.optionId) : null;
    };
    const pickReject = (): string | null => {
      const pick = options.find((o: any) => o?.kind === 'reject_once' || o?.kind === 'reject_always');
      return pick ? String(pick.optionId) : null;
    };
    const answer = (optionId: string | null): void => {
      this.write(ds, {
        jsonrpc: '2.0',
        id,
        result: optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } },
      });
    };

    try {
      // 会话级放行命中：自动应答 + 审计落账
      if (ds.allowlist.has(toolName)) {
        answer(pickAllow());
        this.deps.autoAllowed({
          sessionId: ds.s.id,
          cwd: ds.s.cwd,
          tool: toolName,
          inputSummary: String(command).slice(0, 200),
          detail: String(command).slice(0, 2000),
        });
        return;
      }

      const decision: Decision = await this.deps.requestApproval({
        agent: 'dsh',
        sessionId: ds.s.id,
        cwd: ds.s.cwd,
        tool: toolName,
        inputSummary: String(command).slice(0, 200),
        detail: String(command).slice(0, 2000),
      });

      // 进程已死：不再应答（挂起审批已由 cancelApprovals 收口）
      if (!ds.proc) return;

      if (decision === 'deny') {
        answer(pickReject());
        return;
      }
      if (decision === 'allow_session') {
        ds.allowlist.add(toolName);
        answer(pickAllow());
        return;
      }
      answer(pickAllow());
    } catch (e: any) {
      // 等决策期间进程死亡/应用关停：按取消应答
      logger.warn('[Approver][dsh] permission %s 决策失败: %s', callId, e?.message);
      answer(null);
    }
  }

  // ---- AgentAdapter 接口 ----

  async prompt(sessionId: string, text: string): Promise<void> {
    const ds = this.entry(sessionId);
    if (!ds.proc || !ds.acpSessionId) throw new Error('dsh 会话未就绪');
    if (ds.activePrompt) throw new Error('该会话已有任务在跑（ACP 单进程串行）');

    ds.activePrompt = true;
    ds.s.status = 'running';
    ds.s.lastError = undefined;
    this.deps.onSessionUpdate(ds.s);

    try {
      const res: any = await this.request(ds, 'session/prompt', {
        sessionId: ds.acpSessionId,
        prompt: [{ type: 'text', text }],
      }, 0);
      const stopReason = String(res?.stopReason || 'end_turn');
      ds.s.status = stopReason === 'cancelled' ? 'aborted' : 'idle';
      if (stopReason !== 'end_turn' && stopReason !== 'cancelled') {
        ds.s.lastError = `stop_reason=${stopReason}`;
      }
    } catch (e: any) {
      ds.s.status = ds.shuttingDown ? 'aborted' : 'failed';
      ds.s.lastError = String(e?.message || e).slice(0, 500);
      this.transcribe(ds, 'system', `出错: ${ds.s.lastError}`);
    } finally {
      ds.activePrompt = false;
      if (ds.abortDeadline) { clearTimeout(ds.abortDeadline); ds.abortDeadline = null; }
      this.deps.onSessionUpdate(ds.s);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const ds = this.entry(sessionId);
    if (!ds.proc || !ds.acpSessionId) return;
    // session/cancel 是通知：不等响应；15s 内 prompt 没收口就杀进程兜底
    this.write(ds, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: ds.acpSessionId } });
    ds.abortDeadline = setTimeout(() => {
      if (ds.activePrompt && ds.proc) {
        logger.warn('[Approver][dsh] %s cancel 15s 未收口，杀进程', ds.s.id);
        ds.proc.kill();
      }
    }, 15_000);
    ds.abortDeadline.unref?.();
  }

  async disposeAll(): Promise<void> {
    for (const ds of this.sessions.values()) {
      ds.shuttingDown = true;
      if (ds.abortDeadline) clearTimeout(ds.abortDeadline);
      if (ds.proc) {
        if (ds.acpSessionId) {
          try {
            await Promise.race([
              this.request(ds, 'session/close', { sessionId: ds.acpSessionId }),
              new Promise((r) => setTimeout(r, 2000)),
            ]);
          } catch { /* ignore */ }
        }
        try { ds.proc.stdin?.end(); } catch { /* ignore */ }
        ds.proc.kill();
      }
      ds.rl?.close();
    }
    this.sessions.clear();
  }
}
