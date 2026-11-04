import type { AgentAdapter } from './agents/base';
import type { AgentKind, AgentSession, TranscriptEntry } from './types';
import type { Bus } from './bus';

const TRANSCRIPT_CAP = 500;

/** 托管会话管理（从 qihang-code-approver 移植）：会话表 + 转录环形缓冲 + 回合收口通知 */
export class SessionManager {
  private sessions = new Map<string, AgentSession>();
  private transcripts = new Map<string, TranscriptEntry[]>();

  constructor(
    private bus: Bus,
    private adapters: Record<AgentKind, AgentAdapter>,
    /** 任务回合结束（prompt 收口）时回调；aborted 不回调。result 为本轮 AI 回复正文拼接，用于飞书完成卡片 */
    private onTaskDone?: (session: AgentSession, task: string, ok: boolean, durationMs: number, result?: string) => void,
  ) {}

  list(): AgentSession[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  transcript(id: string): TranscriptEntry[] {
    return this.transcripts.get(id) || [];
  }

  addTranscript(sessionId: string, entry: TranscriptEntry): void {
    let list = this.transcripts.get(sessionId);
    if (!list) {
      list = [];
      this.transcripts.set(sessionId, list);
    }
    list.push(entry);
    if (list.length > TRANSCRIPT_CAP) list.splice(0, list.length - TRANSCRIPT_CAP);
    this.bus.emit({ type: 'output.delta', sessionId, entry });
  }

  /** adapter 直接持有 session 对象引用并原地改字段，改完回调这里同步总线 */
  updateSession(session: AgentSession): void {
    if (!this.sessions.has(session.id)) this.sessions.set(session.id, session);
    this.bus.emit({ type: 'session.updated', session });
  }

  async createSession(kind: AgentKind, cwd: string, title?: string, resume?: string): Promise<AgentSession> {
    const session = await this.adapters[kind].createSession({ cwd, title, resume });
    this.sessions.set(session.id, session);
    this.transcripts.set(session.id, []);
    this.bus.emit({ type: 'session.started', session });
    return session;
  }

  async prompt(id: string, text: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`会话不存在: ${id}`);
    if (!text.trim()) throw new Error('任务内容为空');
    this.addTranscript(id, { ts: new Date().toISOString(), kind: 'system', text: `任务：${text}` });
    // 本轮起点：之后新增的 text 转录就是这轮的 AI 回复正文
    const turnStart = this.transcripts.get(id)?.length ?? 0;
    const startedAt = Date.now();
    try {
      await this.adapters[session.agent].prompt(id, text);
    } finally {
      // aborted 是用户主动中止，不通知；idle/failed 都通知
      if (session.status === 'idle' || session.status === 'failed') {
        const result = (this.transcripts.get(id) || [])
          .slice(turnStart)
          .filter((e) => e.kind === 'text')
          .map((e) => e.text)
          .join('\n')
          .trim();
        this.onTaskDone?.(session, text, session.status === 'idle', Date.now() - startedAt, result || undefined);
      }
    }
  }

  async abort(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`会话不存在: ${id}`);
    await this.adapters[session.agent].abort(id);
  }

  async disposeAll(): Promise<void> {
    for (const adapter of Object.values(this.adapters)) {
      await adapter.disposeAll();
    }
  }
}
