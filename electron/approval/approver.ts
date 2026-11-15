/**
 * 审批通道服务（qihang-code-approver 能力移植进雷达生态的装配层）。
 *
 * 分工：
 *   - 雷达（electron/radar/）保持只读观测，一个字不改；
 *   - 本模块是独立的「拦截通道」：托管 Claude Code（SDK canUseTool）与 DSH（ACP 反向请求）会话，
 *     同时接收外部会话的 hook 审批（Claude Code PermissionRequest hook / DSH dsh-approver 插件；
 *     pi 已于 2026-11-15 拍板删除审批拦截，外部 pi 终端只走回合上报/接着问，不经本通道审批）；
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
import { deployPiGate, piGateTargetDir, PI_GATE_FILENAME } from './pi-gate-deploy';
import type { PiGateDeployResult } from './pi-gate-deploy';
import { deployOpenCodeGate, openCodeGateTargetDir, OPENCODE_GATE_FILENAME } from './opencode-gate-deploy';
import type { OpenCodeGateDeployResult } from './opencode-gate-deploy';
import { deployClaudeHooks } from './claude-hook-deploy';
import type { ClaudeHookDeployResult } from './claude-hook-deploy';
import * as feishu from '../services/feishu';
import * as appConfig from '../services/app-config';
import { notify } from '../services/notify';
import logger from '../services/logger';

/** 外部会话 hook 等待上限：hook 客户端默认超时 600s，必须在它超时前给出响应；超限返回空决策回落正常权限提示 */
const HOOK_WAIT_MS = 540_000;

/**
 * 「继续」快速通道窗口（秒，config: approverQuickWindowSec）：Claude Code Stop hook 挂起等追问的时长。
 * 窗口内点卡片「▶️ 继续」/「接着问」→ 追问注回终端原会话执行（decision:block），不接管不 fork；
 * 超窗无人取走 → 「接着问」自动降级 SDK resume 接管续跑。窗口期间终端提示符不返回，别配太大；
 * 需同步把 ~/.claude/settings.json 的 Stop hook 指向 /api/hooks/claude-stop 且 timeout（秒）大于本值。
 * 0 = 关闭快速通道，claude-stop 退化为纯 task-done。
 */
const DEFAULT_QUICK_WINDOW_SEC = 30;

/**
 * 「继续」快速通道窗口（秒）：claudeStop 每轮调用读一次，启动时的 hook 自愈部署也用它
 * 生成 Stop hook timeout。注意：getConfig 对缺失键返回 ''，Number('') = 0 会被 isFinite
 * 判为合法值，把「未配置」误当成「显式 0=关闭」。必须用 raw 非空判断区分两者。
 */
function quickWindowSec(): number {
  const raw = String(appConfig.getConfig('approverQuickWindowSec') || '').trim();
  const cfg = Number(raw);
  return raw !== '' && Number.isFinite(cfg) && cfg >= 0 ? cfg : DEFAULT_QUICK_WINDOW_SEC;
}

/** DSH 桌面端默认安装路径（可被 config.dshPath 覆盖） */
const DEFAULT_DSH_PATH = 'C:/Users/ASUS/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd';

function approvalDataDir(): string {
  return path.join(os.homedir(), '.qihang-ai-desktop', 'approval');
}

/**
 * 等一次审批决策，最多 waitMs 毫秒。
 * 超时返回 null（调用方返回空结果，客户端下一轮再来）——
 * 不能一直挂住：插件侧的 HTTP 客户端有响应体超时（5 分钟），
 * 人若在飞书上隔几分钟才点「允许」，长连接会被掐断，决策就送不回终端。
 */
function waitForDecision(promise: Promise<Decision>, waitMs: number): Promise<Decision | null> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<Decision | null>;
}

function hookDetail(toolName: string, input: any): string {  if (toolName === 'Bash' && typeof input?.command === 'string') return String(input.command).slice(0, 2000);
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
  /** 最近一次 pi-approver-gate 扩展部署结果（status() 暴露给 UI） */
  private lastPiGateDeploy: PiGateDeployResult | null = null;
  /** 最近一次 qihang-gate（OpenCode 插件）部署结果 */
  private lastOpenCodeGateDeploy: OpenCodeGateDeployResult | null = null;
  /** 渲染层事件订阅（桌面审批面板）：审批挂起/决策时扇出 */
  private readonly approvalSubs = new Set<(e: any) => void>();
  /**
   * opencode 权限镜像卡登记：key = `${sessionId}::${requestId}` → 工作台侧审批 id + 决策 promise。
   * opencode 终端先答复时据此找到卡片并作废（避免飞书上重复决策）。
   */
  private readonly opencodeMirrors = new Map<
    string,
    { approvalId: string; promise: Promise<Decision>; createdAt: number }
  >();
  /** 已被终端作废的镜像 key：用于区分「用户点了拒绝」和「终端先答了」 */
  private readonly opencodeCancelled = new Set<string>();
  /** 最近一次 Claude Code hooks 自动部署结果 */
  private lastClaudeHookDeploy: ClaudeHookDeployResult | null = null;
  /**
   * 正挂在 /api/hooks/claude-stop 上等追问的外部 claude 会话 id。
   * 「接着问」据此分流：在册 → stash 交给终端原会话（快速通道）；
   * 不在册 → SDK resume 接管。单线程事件循环下 stash 与轮询原子交接：
   * stash 落在轮询循环睡眠期会被下一轮检查取走（取数先于超时判断），不存在孤儿。
   */
  private readonly quickPollers = new Set<string>();

  isRunning(): boolean {
    return this.runningFlag;
  }

  /** 外部 claude 会话是否正挂在 claude-stop 上等追问（快速通道窗口内）——雷达端继续对话的准入校验 */
  isQuickPoller(sessionId: string): boolean {
    return this.quickPollers.has(String(sessionId || ''));
  }

  /**
   * 受管会话直接续跑（雷达通知详情弹层用）：命中受管会话返回 true 并触发 prompt；
   * 外部会话返回 { managed: false }，由调用方走 stash 由扩展/插件长轮询取走。
   */
  managedSessionPrompt(sessionId: string, text: string): { managed: boolean; ok?: boolean; error?: string } {
    const s = this.manager?.get(String(sessionId || ''));
    if (!s) return { managed: false };
    if (s.status === 'running') return { managed: true, ok: false, error: '该会话正在执行，等完成后再追问' };
    void this.manager!.prompt(s.id, text).catch((e: any) => {
      logger.error('[Approver] 受管会话续跑失败: %s', e?.message || e);
    });
    return { managed: true, ok: true };
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
    const port = Number(appConfig.getConfig('approverPort')) || 8790;
    return {
      enabled: this.isEnabled(),
      running: this.runningFlag,
      port,
      pending: this.center ? this.center.pendingCount() : 0,
      sessions: this.manager ? this.manager.list().length : 0,
      lastError: this.lastError,
      piGate: {
        targetDir: piGateTargetDir(),
        file: PI_GATE_FILENAME,
        // 未启动时 lastPiGateDeploy 为 null：UI 据此提示"未检测"
        installed: !!this.lastPiGateDeploy && this.lastPiGateDeploy.ok,
        action: this.lastPiGateDeploy?.action || 'none',
        target: this.lastPiGateDeploy?.target || path.join(piGateTargetDir(), PI_GATE_FILENAME),
        error: this.lastPiGateDeploy?.error,
      },
      opencodeGate: {
        targetDir: openCodeGateTargetDir(),
        file: OPENCODE_GATE_FILENAME,
        installed: !!this.lastOpenCodeGateDeploy && this.lastOpenCodeGateDeploy.ok,
        action: this.lastOpenCodeGateDeploy?.action || 'none',
        target: this.lastOpenCodeGateDeploy?.target || path.join(openCodeGateTargetDir(), OPENCODE_GATE_FILENAME),
        error: this.lastOpenCodeGateDeploy?.error,
      },
    };
  }

  /** 手动重新部署 pi 扩展 + OpenCode 插件 + Claude hooks（UI「重新部署」按钮）；端口取当前配置 */
  deployGate(): PiGateDeployResult & { opencode: OpenCodeGateDeployResult; claude: ClaudeHookDeployResult } {
    const port = Number(appConfig.getConfig('approverPort')) || 8790;
    this.lastPiGateDeploy = deployPiGate(port);
    this.lastOpenCodeGateDeploy = deployOpenCodeGate(port);
    this.lastClaudeHookDeploy = deployClaudeHooks(port, quickWindowSec());
    return { ...this.lastPiGateDeploy, opencode: this.lastOpenCodeGateDeploy, claude: this.lastClaudeHookDeploy };
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
      // 桌面面板推送：回合收口也扇出给渲染层（雷达页通知用），与审批事件共用 approver:event 通道
      for (const fn of this.approvalSubs) {
        try { fn({ type: 'task-done', report }); } catch { /* 订阅者异常不影响总线 */ }
      }
      // 桌面系统通知：回合完成/失败本机也同步提醒（飞书之外的兜底，人在电脑前也能第一时间知道）
      const dir = (report.cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || report.cwd || '?';
      const brief = String(report.ok ? report.task : report.error || report.task || '')
        .replace(/\s+/g, ' ').trim().slice(0, 120);
      notify(
        `${report.ok ? '✅ 任务完成' : '❌ 任务失败'} · ${dir}`,
        brief || `${report.label || report.agent} 回合${report.ok ? '完成' : '失败'}`,
      );
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
    /**
     * Claude Code 回合收口处理（Stop 事件）：
     * 1) 按 task-done 上报（完成/失败都出卡，失败带 error 正文），不等飞书；
     * 2) 挂起快速通道等「继续」追问：decision:block + reason → 终端把 reason 当新指令在**原会话**续跑。
     *
     * 这是把追问注回 Claude Code 终端的唯一通道：CLI 只在 Stop 时会等 hook 返回。
     * 回合因 API 错误结束时 Claude Code 只发 StopFailure、不发 Stop（且不等 hook），
     * 那种情况注入不了，用户回终端自己输入即可——所以这里不做任何后台接管。
     * @param tag 日志标签（排查时区分来源）
     */
    const claudeTurnEnded = async (body: any, tag: string): Promise<any> => {
      try {
        notifyTask(await normalizeTaskDone(body));
      } catch (e: any) {
        logger.error('[Approver] 外部回合上报处理失败: %s', e?.message || e);
      }
      const sessionId = String(body?.session_id || '');
      const windowSec = quickWindowSec();
      if (!sessionId || windowSec <= 0) return {};
      logger.info('[Approver] %s 快速通道挂起: session=%s window=%ss', tag, sessionId.slice(0, 24), windowSec);
      this.quickPollers.add(sessionId);
      try {
        const text = await takeFollowup(sessionId, windowSec * 1000);
        // decision:block + reason → Claude Code 拿 reason 当指令在终端继续跑；
        // 跑完再次 Stop 会重新进来，多轮追问天然成环，每轮都要人拍板不会失控
        return text ? { decision: 'block', reason: text } : {};
      } finally {
        this.quickPollers.delete(sessionId);
      }
    };
    // autoAllowed 目前只有 dsh 会用（claude 的会话级放行走 SDK suggestions）
    /**
     * Claude Code StopFailure（回合异常终止：429/模型不可用/网络错误等）：
     * 只上报失败通知，立即返回。**不挂起、不接管、不返回 block**。
     *
     * 原因（实测 + 日志实证）：StopFailure 在 CLI / app 里都**不等待 hook 返回、不读取 stdout**，
     * decision:block 对它完全无效；若照 Stop 那样挂起等「继续」，追问暂存后 CLI 根本不会来取，
     * 反而会**阻塞同一会话后续的正常 Stop**（失败回合的挂起没超时，堵住下一次完成事件的收口）。
     * 所以这里只发卡，用户回终端自己输入即可。
     */
    const claudeStopFailureNotifyOnly = async (body: any): Promise<any> => {
      try {
        notifyTask(await normalizeTaskDone(body));
      } catch (e: any) {
        logger.error('[Approver] StopFailure 失败通知上报处理失败: %s', e?.message || e);
      }
      return {};
    };
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
    // 自动部署 pi-approver-gate 扩展到 ~/.pi/agent/extensions/：外部 pi 终端的回合上报/接着问依赖它。
    // 失败不阻断启动，下次启动重试。
    this.lastPiGateDeploy = deployPiGate(port);
    // 自动部署 qihang-gate 插件到 ~/.config/opencode/plugins/：外部 opencode 会话的
    // 回合上报/审批/接着问依赖它。失败不阻断启动，下次启动重试。
    this.lastOpenCodeGateDeploy = deployOpenCodeGate(port);
    // 自愈部署 Claude Code hooks 到 ~/.claude/settings.json：外部 claude 会话的
    // 审批/完成通知/继续对话依赖它；settings.json 被整体替换（切模型）后 hooks 会丢。
    // 只合并我们的条目、不动其余字段；失败不阻断启动，下次启动重试。
    this.lastClaudeHookDeploy = deployClaudeHooks(port, quickWindowSec());
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
      opencodePolicy: () => ({
        // 额外加严的动作名（逗号分隔，如 shell,edit）。
        // 默认空 = 不加严：只有 opencode 自己判为 ask 的动作才进飞书审批。
        escalate: String(appConfig.getConfig('opencodeEscalateActions') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }),
      opencodeApprovalRequest: async (body) => {
        // 只处理 opencode 真的发起权限请求（permission.asked）的镜像。
        // 非法/不完整输入：返回空对象（无决策），opencode 终端照常弹原生提示。
        const tool = String(body?.tool || '');
        if (!body || !tool) return {};
        const sessionId = String(body?.sessionId || '');
        const requestId = String(body?.requestId || '');
        const resources: string[] = Array.isArray(body?.resources)
          ? body.resources.map((r: any) => String(r))
          : [];
        const save: string[] = Array.isArray(body?.save) ? body.save.map((r: any) => String(r)) : [];
        const key = `${sessionId}::${requestId}`;
        const detail = [
          `动作：${tool}`,
          `资源：${resources.join(', ') || '-'}`,
          save.length ? `「允许并记住」将保存：${save.join(', ')}` : '',
          body?.summary ? `摘要：${String(body.summary)}` : '',
        ].filter(Boolean).join('\n').slice(0, 2000);
        let approvalId = '';
        // 注意：不 await —— 审批卡先发出去，决策由 /api/hooks/opencode-decision 端点等。
        // 这里如果一直挂住不返回，插件侧长连接会被 Node 的响应体超时（5 分钟）掐断，
        // 人在飞书上想几分钟再点「允许」就送不回终端了。
        const promise = center.request({
          agent: 'opencode',
          sessionId: `oc-ext-${sessionId.slice(0, 40) || 'unknown'}`,
          cwd: String(body?.cwd || ''),
          tool,
          inputSummary: String(body?.summary || tool).slice(0, 200),
          detail,
        }, (id) => {
          approvalId = id;
        });
        if (requestId && approvalId) {
          // 清扫过期镜像登记（插件放弃等待后不会再轮询，这里兜底防泄漏）
          const stale = Date.now() - 65 * 60_000;
          for (const [k, v] of this.opencodeMirrors) {
            if (v.createdAt < stale) this.opencodeMirrors.delete(k);
          }
          this.opencodeMirrors.set(key, { approvalId, promise, createdAt: Date.now() });
        }
        return { approvalId };
      },
      opencodeDecisionPoll: async (body) => {
        // 插件轮询取决策：最多等 waitMs（超过就返回空，插件下一轮再来）
        const sessionId = String(body?.sessionId || '');
        const requestId = String(body?.requestId || '');
        const key = `${sessionId}::${requestId}`;
        const entry = this.opencodeMirrors.get(key);
        if (!entry) return {};
        const waitMs = Math.min(Math.max(Number(body?.waitMs) || 25_000, 1000), 60_000);
        const decision = await waitForDecision(entry.promise, waitMs);
        if (!decision) return {}; // 还没人拍板：插件继续轮询
        this.opencodeMirrors.delete(key);
        // 终端先答了 → 这张卡已被作废，不能当成「拒绝」回灌给 opencode
        if (this.opencodeCancelled.has(key)) {
          this.opencodeCancelled.delete(key);
          return { cancelled: true };
        }
        return { decision };
      },
      opencodeApprovalCancel: async (body) => {
        // opencode 终端自己答复了 → 把飞书那张镜像卡撤掉（避免重复决策）
        const sessionId = String(body?.sessionId || '');
        const requestId = String(body?.requestId || '');
        const key = `${sessionId}::${requestId}`;
        const entry = this.opencodeMirrors.get(key);
        if (!entry) return { ok: true };
        this.opencodeMirrors.delete(key);
        this.opencodeCancelled.add(key);
        this.center?.cancelExternal(entry.approvalId, 'terminal-answered');
        logger.info('[Approver] opencode 终端已答复，飞书镜像卡作废：session=%s request=%s',
          sessionId.slice(0, 24), requestId.slice(0, 12));
        return { ok: true };
      },
      taskDone: async (body) => {
        try {
          notifyTask(await normalizeTaskDone(body));
        } catch (e: any) {
          logger.error('[Approver] 外部回合上报处理失败: %s', e?.message || e);
        }
      },
      claudeStop: async (body) => {
        return claudeTurnEnded(body, 'claude-stop');
      },
      claudeStopFailure: async (body) => {
        // 回合异常终止：只通知，立即返回。详见 claudeStopFailureNotifyOnly 的注释。
        return claudeStopFailureNotifyOnly(body);
      },
      dshFollowupPoll: async (sessionId) => {
        const text = await takeFollowup(sessionId, 25_000);
        // 取走留痕：排查「追问提交了但终端没收到」时的关键证据（扩展侧是否还在轮询）
        if (text) logger.info('[Approver] 追问已取走: session=%s %s字', String(sessionId || '').slice(0, 24), text.length);
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
      agent: value.agent === 'dsh' ? 'dsh' : value.agent === 'pi' ? 'pi' : value.agent === 'opencode' ? 'opencode' : 'claude',
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
    // pi 外部会话：追问暂存，由 pi-approver-gate 扩展在终端原会话长轮询取走注入执行（与 DSH 同模式）。
    // 不接管不 fork：用户拍板不要工作台续跑（新建会话会丢原终端上下文）；终端已关时追问按 TTL 过期
    if (ref.resume && ref.agent === 'pi') {
      stashFollowup(ref.sessionId || '', text.slice(0, 4000));
      logger.info('[Approver] pi 追问已暂存(终端原会话取走): session=%s', ref.sessionId || '(无)');
      return { toast: { type: 'success', content: '已提交追问，pi 终端原会话将取走执行（终端需保持打开）' } };
    }
    // OpenCode 外部会话：追问暂存，由 qihang-gate 插件长轮询取走后 ctx.session.prompt() 注入原会话，
    // 回答回到用户开着的那扇 opencode 窗口（不接管不 fork）
    if (ref.resume && ref.agent === 'opencode') {
      stashFollowup(ref.sessionId || '', text.slice(0, 4000));
      logger.info('[Approver] opencode 追问已暂存(插件注入原会话): session=%s', ref.sessionId || '(无)');
      return { toast: { type: 'success', content: '已提交追问，opencode 原会话将取走执行（窗口需保持打开）' } };
    }
    // 外部 DSH 会话：本进程无法 resume 被桌面端占用的会话，追问暂存由插件长轮询取走
    if (ref.resume && ref.agent === 'dsh') {
      stashFollowup(ref.sessionId || '', text.slice(0, 4000));
      return { toast: { type: 'success', content: '已提交追问，DSH 插件会取走并在原会话执行' } };
    }
    if (ref.resume) {
      // 快速通道：终端会话正挂在 claude-stop 上等追问 → stash 交给原会话取走执行，不接管不 fork
      if (ref.agent === 'claude' && ref.sessionId && this.quickPollers.has(ref.sessionId)) {
        stashFollowup(ref.sessionId, text.slice(0, 4000));
        logger.info('[Approver] 追问走快速通道(终端原会话): session=%s', ref.sessionId.slice(0, 24));
        return { toast: { type: 'success', content: '已提交，终端会话正在等待，将取走继续执行' } };
      }
      // 外部 claude 会话兜底：不在快速通道窗口内（超窗/终端已关）→ **不接管、不新建会话**。
      // 工作台接管会在后台另起一份会话，与「在原 Claude Code 窗口继续」的预期相反，
      // 所以这里只提示回终端；真正的注入只走上面的快速通道（decision:block 注回原会话）。
      return { toast: { type: 'info', content: '终端会话已不在等待窗口，请回到原 Claude Code 窗口继续输入' } };
    }
    const s = ref.sessionId ? this.manager.get(ref.sessionId) : undefined;
    if (!s) return { toast: { type: 'error', content: '原会话已不存在，请重新发起' } };
    if (s.status === 'running') return { toast: { type: 'info', content: '该会话正在执行，等完成后再追问' } };
    void this.manager.prompt(s.id, text.slice(0, 4000)).catch(fail);
    return { toast: { type: 'success', content: '已提交追问，完成后回新卡片' } };
  }
}

export const approver = new ApproverService();
