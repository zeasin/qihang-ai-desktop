/**
 * 审批通道服务（qihang-code-approver 能力移植进雷达生态的装配层）。
 *
 * 分工：
 *   - 雷达（electron/radar/）保持只读观测，一个字不改；
 *   - 本模块是独立的「拦截通道」：托管 Claude Code（SDK canUseTool）与 DSH（ACP 反向请求）会话，
 *     同时接收外部会话的 hook 审批（Claude Code PermissionRequest hook / DSH dsh-approver 插件）；
 *   - 决策面走飞书（审批卡 + 原位更新 + 接着问表单），飞书不可用时 REST 兜底。
 * 按拍板：不设审批超时——挂起一直等，直到有人决策或会话死亡按拒绝收口。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { Bus } from './bus';
import { History } from './history';
import { ApprovalCenter } from './approval-center';
import { SessionManager } from './session-manager';
import { buildTaskBody, buildTaskNotify, normalizeTaskDone, stashFollowup, takeFollowup } from './task-notify';
import type { TaskReport } from './task-notify';
import type { AgentDeps } from './agents/base';
import { ClaudeAdapter } from './agents/claude';
import { DshAdapter } from './agents/dsh';
import { buildApprovalCard, buildDecidedCard, buildTaskCard, DECISION_LABEL } from './card';
import type { TaskFollowupRef } from './card';
import { startApproverServer } from './server';
import { scanLocalSessions, readLocalTranscript } from './local-sessions';
import { DECISIONS } from './types';
import type { Decision } from './types';
import * as feishu from '../services/feishu';
import * as appConfig from '../services/app-config';
import logger from '../services/logger';

/** 外部会话 hook 等待上限：hook 客户端默认超时 600s，必须在它超时前给出响应；超限返回空决策回落正常权限提示 */
const HOOK_WAIT_MS = 540_000;

/** DSH 桌面端默认安装路径（可被 config.dshPath 覆盖） */
const DEFAULT_DSH_PATH = 'C:/Users/ASUS/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd';

function approvalDataDir(): string {
  return path.join(os.homedir(), '.qihang-ai-desktop', 'approval');
}

function hookDetail(toolName: string, input: any): string {
  if (toolName === 'Bash' && typeof input?.command === 'string') return String(input.command).slice(0, 2000);
  if ((toolName === 'Write' || toolName === 'Edit') && typeof input?.file_path === 'string') {
    const body = toolName === 'Write' ? String(input.content ?? '').slice(0, 1500)
      : `- ${String(input.old_string ?? '').slice(0, 600)}\n+ ${String(input.new_string ?? '').slice(0, 1200)}`;
    return `${input.file_path}\n${body}`;
  }
  let json = '';
  try { json = JSON.stringify(input) ?? ''; } catch { json = String(input); }
  return json.slice(0, 2000);
}

class ApproverService {
  private bus: Bus | null = null;
  private center: ApprovalCenter | null = null;
  private manager: SessionManager | null = null;
  private server: http.Server | null = null;
  private runningFlag = false;
  private lastError = '';
  /** 渲染层事件订阅（桌面审批面板）：审批挂起/决策时扇出 */
  private readonly approvalSubs = new Set<(e: any) => void>();

  isRunning(): boolean {
    return this.runningFlag;
  }

  /**
   * 订阅审批事件（桌面面板用）：只转 approval.required / approval.decided，
   * 会话输出类事件量大且面板用不着，不进这条通道。
   * @returns 取消订阅函数
   */
  onApprovalEvent(fn: (e: any) => void): () => void {
    this.approvalSubs.add(fn);
    return () => { this.approvalSubs.delete(fn); };
  }

  /** 当前挂起的审批（桌面面板列表；飞书不可用时的兜底决策口径） */
  listPending(): any[] {
    return this.center ? this.center.listPending() : [];
  }

  /** 最近已决审批（新→旧，默认 20 条；审计追溯用） */
  history(limit = 20): any[] {
    if (!this.center) return [];
    return this.center.list({ status: 'decided' }).slice(0, limit);
  }

  /** 桌面端决策入口：by 固定 desktop:local，与飞书的 feishu:<openId> 在审计里可区分 */
  decide(id: string, decision: string, by = 'desktop:local'): { ok: boolean; error?: string } {
    if (!this.center) return { ok: false, error: '审批通道未启动' };
    const d = decision as Decision;
    if (!DECISIONS.includes(d)) return { ok: false, error: `无效的决策值：${decision}` };
    const result = this.center.resolve(String(id || ''), d, by);
    if (result === 'not_pending') return { ok: false, error: '该审批已处理或已过期' };
    return { ok: true };
  }

  isEnabled(): boolean {
    return String(appConfig.getConfig('approverEnabled') || '') === '1';
  }

  status(): any {
    return {
      enabled: this.isEnabled(),
      running: this.runningFlag,
      port: Number(appConfig.getConfig('approverPort')) || 8790,
      pending: this.center ? this.center.pendingCount() : 0,
      sessions: this.manager ? this.manager.list().length : 0,
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    if (this.runningFlag) return;
    const dir = approvalDataDir();
    const bus = new Bus();
    const history = new History(path.join(dir, 'history.jsonl'));
    this.bus = bus;

    // 审批事件转发给桌面面板订阅者（approval.required / approval.decided 两类）
    bus.subscribe((e) => {
      if (e.type !== 'approval.required' && e.type !== 'approval.decided') return;
      for (const fn of this.approvalSubs) {
        try { fn({ type: e.type, request: e.request }); } catch { /* 订阅者异常不影响总线 */ }
      }
    });

    const chatId = appConfig.getConfig('feishuChatId') || '';
    const center: ApprovalCenter = new ApprovalCenter({
      bus,
      history,
      sendCard: async (req) => {
        if (!feishu.isRunning() || !chatId) return undefined;
        return feishu.sendCardToChat(chatId, buildApprovalCard(req));
      },
      patchCard: async (req) => {
        if (!req.feishuMessageId) return;
        await feishu.patchCard(req.feishuMessageId, buildDecidedCard(req));
      },
    });
    this.center = center;

    let manager!: SessionManager;
    /** managed 会话直接接着聊；外部会话按原生 id resume */
    const followupRefOf = (r: TaskReport): TaskFollowupRef => {
      const managed = r.sessionId ? manager.get(r.sessionId) : undefined;
      return managed
        ? { agent: managed.agent, cwd: managed.cwd, sessionId: managed.id, resume: false }
        : { agent: r.agent, cwd: r.cwd, sessionId: r.sessionId, resume: true };
    };
    /** 落一行日志再发：飞书未启用/发送失败时日志是唯一线索 */
    const notifyTask = (report: TaskReport | null): void => {
      if (!report) return;
      // 卡片正文带 AI 回复全文：卡片 JSON 总限 30KB，中文按 3 字节算，8000 字兜底；纯文本降级只留摘要
      const body = buildTaskBody(report, 8000);
      const text = buildTaskNotify(report);
      logger.info('[Approver] %s 回合收口（%s）：%s | 会话 %s',
        report.agent, report.ok ? '完成' : '失败', report.cwd, report.sessionId || '(无)');
      if (!feishu.isRunning() || !chatId) {
        logger.warn('[Approver] 飞书未启用或未配 feishuChatId，通知未发送');
        return;
      }
      feishu.sendCardToChat(chatId, buildTaskCard(body, report, followupRefOf(report)))
        .catch(async (e: any) => {
          logger.error('[Approver] 任务卡片发送失败，降级纯文本: %s', e?.message || e);
          await feishu.sendTextToChat(chatId, text);
        });
    };
    // autoAllowed 目前只有 dsh 会用（claude 的会话级放行走 SDK suggestions）
    const deps: AgentDeps = {
      requestApproval: (input) => center.request(input),
      autoAllowed: (input) => center.recordAutoAllowed({ agent: 'dsh', ...input }),
      onTranscript: (sessionId, entry) => manager.addTranscript(sessionId, entry),
      onSessionUpdate: (session) => manager.updateSession(session),
      cancelApprovals: (sessionId) => center.cancelBySession(sessionId),
    };

    const claudeAdapter = new ClaudeAdapter(deps, {
      claudePath: appConfig.getConfig('claudePath') || undefined,
    });
    const dshAdapter = new DshAdapter(deps, {
      dshPath: appConfig.getConfig('dshPath') || DEFAULT_DSH_PATH,
      dshArgs: ['--profile', 'acp'],
    });
    manager = new SessionManager(bus, { claude: claudeAdapter, dsh: dshAdapter }, (session, task, ok, durationMs, result) => {
      notifyTask({
        agent: session.agent,
        sessionId: session.id,
        label: session.title,
        cwd: session.cwd,
        task,
        ok,
        durationMs,
        error: session.lastError,
        result,
      });
    });
    this.manager = manager;

    const port = Number(appConfig.getConfig('approverPort')) || 8790;
    this.server = await startApproverServer({
      port,
      health: () => ({
        ok: true,
        app: 'qihang-ai-desktop',
        port,
        feishu: { running: feishu.isRunning(), chatId: chatId || null },
        sessions: manager.list().length,
        pendingApprovals: center.pendingCount(),
      }),
      listSessions: () => manager.list(),
      createSession: async (body) => {
        const agent = body?.agent === 'dsh' ? 'dsh' : 'claude';
        if (!body?.cwd || typeof body.cwd !== 'string') throw new Error('缺少 cwd');
        return manager.createSession(
          agent,
          body.cwd,
          body.title ? String(body.title) : undefined,
          body.resume ? String(body.resume) : undefined,
        );
      },
      prompt: (id, text) => manager.prompt(id, text),
      abortSession: (id) => manager.abort(id),
      transcript: (id) => manager.transcript(id),
      approvals: () => center.list(),
      decide: (id, decision, by) => center.resolve(id, decision as Decision, by),
      listChats: () => feishu.listChats(),
      listLocalSessions: () => scanLocalSessions(),
      localTranscript: (id) => readLocalTranscript(id),
      hookPermissionRequest: async (body) => {
        // 非法/不完整输入：返回空对象（2xx 无决策），Claude Code 回落正常权限提示
        const toolName = body?.tool_name;
        if (!body || typeof toolName !== 'string' || !toolName) return {};
        const decisionPromise = center.request({
          agent: 'claude',
          sessionId: `ext-${String(body.session_id || 'unknown').slice(0, 40)}`,
          cwd: String(body.cwd || ''),
          tool: toolName,
          inputSummary: (() => { try { return (JSON.stringify(body.tool_input ?? {}) ?? '').slice(0, 200); } catch { return String(body.tool_input).slice(0, 200); } })(),
          detail: hookDetail(toolName, body.tool_input),
        });
        const decision = await Promise.race([
          decisionPromise,
          new Promise<null>((r) => setTimeout(() => r(null), HOOK_WAIT_MS).unref?.()),
        ]);
        if (decision === null) return {};
        if (decision === 'deny') {
          return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: '已在启航AI工作台（飞书）拒绝', interrupt: false } } };
        }
        const out: any = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: body.tool_input ?? {} } } };
        if (decision === 'allow_session' && Array.isArray(body.permission_suggestions) && body.permission_suggestions.length) {
          out.hookSpecificOutput.decision.updatedPermissions = body.permission_suggestions;
        }
        return out;
      },
      dshApprovalRequest: async (body) => {
        // 非法/不完整输入：返回空对象（2xx 无决策），DSH 插件回落原生 terminal 审批
        const toolName = body?.toolName;
        if (!body || typeof toolName !== 'string' || !toolName) return {};
        const detail = [
          String(body.reason || ''),
          body.displayReason?.zh || '',
          body.displayReason?.en || '',
        ].filter(Boolean).join('\n').slice(0, 2000);
        const decision: Decision = await center.request({
          agent: 'dsh',
          sessionId: `dsh-ext-${String(body.sessionId || 'unknown').slice(0, 40)}`,
          cwd: String(body.cwd || ''),
          tool: toolName,
          inputSummary: String(body.reason || '').slice(0, 200) || toolName,
          detail,
        });
        return { decision };
      },
      taskDone: async (body) => {
        try {
          notifyTask(await normalizeTaskDone(body));
        } catch (e: any) {
          logger.error('[Approver] 外部回合上报处理失败: %s', e?.message || e);
        }
      },
      dshFollowupPoll: async (sessionId) => {
        const text = await takeFollowup(sessionId, 25_000);
        return text ? { text } : {};
      },
      stashDshFollowup: (sessionId, text) => stashFollowup(sessionId, text),
      subscribe: (fn) => bus.subscribe(fn),
    });
    this.runningFlag = true;
    this.lastError = '';
    logger.info('[Approver] 审批通道已启动（port=%s，feishuChatId=%s）', port, chatId || '(未配置)');
  }

  async stop(): Promise<void> {
    if (!this.runningFlag) return;
    this.runningFlag = false;
    try { await this.manager?.disposeAll(); } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const s = this.server;
      if (!s) return resolve();
      s.close(() => resolve());
      setTimeout(() => { try { s.closeAllConnections?.(); } catch { /* ignore */ } resolve(); }, 2000).unref?.();
    });
    this.server = null;
    this.manager = null;
    this.center = null;
    this.bus = null;
    logger.info('[Approver] 审批通道已停止');
  }

  // ---- 飞书卡片回调入口（main.ts 的 card.action.trigger 路由到这里） ----

  /** 审批按钮：同步幂等判定（3 秒回调窗口内安全），返回 toast 文案；卡片更新在 resolve 内部异步做 */
  handleApprovalAction(value: any, operator: string): { toast: { type: string; content: string } } | null {
    if (!this.center || !value || value.act !== 'approval') return null;
    const approvalId = String(value.approvalId || '');
    const decision = String(value.decision || '') as Decision;
    if (!approvalId || !['allow_once', 'allow_session', 'deny'].includes(decision)) {
      return { toast: { type: 'error', content: '无效的审批按钮' } };
    }
    const result = this.center.resolve(approvalId, decision, `feishu:${operator.slice(0, 20)}`);
    if (result === 'not_pending') {
      return { toast: { type: 'info', content: '该审批已处理或已过期' } };
    }
    return { toast: { type: 'success', content: `已受理：${DECISION_LABEL[decision]}` } };
  }

  /** 「接着问」表单提交：同步快速判定，实际续跑异步启动（不 await） */
  handleTaskFollowup(value: any, formText: string, operator: string): { toast: { type: string; content: string } } | null {
    if (!this.manager || !value || value.act !== 'task_followup') return null;
    const text = String(formText || '').trim();
    if (!text) {
      return { toast: { type: 'error', content: '请先在输入框填写追问内容' } };
    }
    const ref: TaskFollowupRef = {
      agent: value.agent === 'dsh' ? 'dsh' : 'claude',
      cwd: String(value.cwd || ''),
      sessionId: value.sessionId ? String(value.sessionId) : undefined,
      resume: value.resume === '1',
    };
    logger.info('[Approver] 追问提交: agent=%s session=%s resume=%s %s字',
      ref.agent, ref.sessionId || '(无)', ref.resume, text.length);
    const fail = (e: any): void => {
      logger.error('[Approver] 接着问执行失败: %s', e?.message || e);
      const chatId = appConfig.getConfig('feishuChatId') || '';
      if (chatId && feishu.isRunning()) {
        void feishu.sendTextToChat(chatId, `⚠️ 接着问执行失败：${String(e?.message || e).slice(0, 200)}`);
      }
    };
    // 外部 DSH 会话：本进程无法 resume 被桌面端占用的会话，追问暂存由插件长轮询取走
    if (ref.resume && ref.agent === 'dsh') {
      stashFollowup(ref.sessionId || '', text.slice(0, 4000));
      return { toast: { type: 'success', content: '已提交追问，DSH 插件会取走并在原会话执行' } };
    }
    if (ref.resume) {
      // 外部 claude 会话：按 SDK resume 恢复续跑
      void (async () => {
        const s = await this.manager!.createSession(ref.agent, ref.cwd, `飞书续聊 ${ref.sessionId?.slice(0, 8) || ''}`.trim(), ref.sessionId);
        await this.manager!.prompt(s.id, text.slice(0, 4000));
      })().catch(fail);
      return { toast: { type: 'success', content: '已提交追问，完成后回新卡片' } };
    }
    const s = ref.sessionId ? this.manager.get(ref.sessionId) : undefined;
    if (!s) return { toast: { type: 'error', content: '原会话已不存在，请重新发起' } };
    if (s.status === 'running') return { toast: { type: 'info', content: '该会话正在执行，等完成后再追问' } };
    void this.manager.prompt(s.id, text.slice(0, 4000)).catch(fail);
    return { toast: { type: 'success', content: '已提交追问，完成后回新卡片' } };
  }
}

export const approver = new ApproverService();
