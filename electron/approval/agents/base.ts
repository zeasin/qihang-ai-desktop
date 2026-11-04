import type { AgentKind, AgentSession, Decision, TranscriptEntry } from '../types';

/** adapter 与审批中心之间的接缝（从 qihang-code-approver 移植）：adapter 只负责「问要决策」，不认识飞书/HTTP */
export interface AgentDeps {
  requestApproval(input: {
    agent: AgentKind;
    sessionId: string;
    cwd: string;
    tool: string;
    inputSummary: string;
    detail: string;
  }): Promise<Decision>;

  /** dsh allowlist 自动放行时用于审计落账 */
  autoAllowed(input: { sessionId: string; cwd: string; tool: string; inputSummary: string; detail: string }): void;

  onTranscript(sessionId: string, entry: TranscriptEntry): void;

  /** adapter 改了 session 状态/externalId/model 后调用 */
  onSessionUpdate(session: AgentSession): void;

  /** 进程死亡/会话中止时，把该会话挂起中的审批按拒绝收口（卡片也要原位更新） */
  cancelApprovals(sessionId: string): void;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  createSession(opts: { cwd: string; title?: string; resume?: string }): Promise<AgentSession>;
  prompt(sessionId: string, text: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  disposeAll(): Promise<void>;
}
