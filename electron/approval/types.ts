/**
 * 审批通道共享类型（从 qihang-code-approver 移植）。
 * 雷达保持只读观测原则；本模块是独立的「拦截通道」：
 * 托管/附加 Claude Code 与 DSH 会话，承接权限请求并转发飞书审批。
 */

export type AgentKind = 'claude' | 'dsh';

/** 用户决策：允许一次 / 本会话放行 / 拒绝（按拍板：不设超时，无 timeout_allow） */
export type Decision = 'allow_once' | 'allow_session' | 'deny';

export const DECISIONS: Decision[] = ['allow_once', 'allow_session', 'deny'];

export type SessionStatus = 'starting' | 'running' | 'idle' | 'failed' | 'aborted';

export interface ApprovalRequest {
  id: string;
  agent: AgentKind;
  sessionId: string;
  cwd: string;
  tool: string;
  /** 一行摘要（≤200 字符） */
  inputSummary: string;
  /** 正文：命令 / 文件内容 / diff（≤2000 字符） */
  detail: string;
  createdAt: string;
  status: 'pending' | 'decided' | 'expired';
  decision?: Decision;
  decidedAt?: string;
  decidedBy?: string;
  feishuMessageId?: string;
}

export interface AgentSession {
  id: string;
  agent: AgentKind;
  cwd: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  /** claude = SDK session_id；dsh = ACP sessionId */
  externalId?: string;
  model?: string;
  lastError?: string;
}

export interface TranscriptEntry {
  ts: string;
  kind: 'text' | 'thinking' | 'tool' | 'system';
  text: string;
}

export type BusEvent =
  | { type: 'approval.required'; request: ApprovalRequest }
  | { type: 'approval.decided'; request: ApprovalRequest }
  | { type: 'session.started'; session: AgentSession }
  | { type: 'session.updated'; session: AgentSession }
  | { type: 'output.delta'; sessionId: string; entry: TranscriptEntry };
