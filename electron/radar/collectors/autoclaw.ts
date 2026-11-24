import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteReadonly } from '../sqlite-open';
import type { HubCollector, ProbeSignal, SerializedMessage, SessionInfo } from '../types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-AUTOCLAW]', msg, ...args);

/** 实报 running 的僵死兜底：status='running' 但 updated_at 超过该时长即视为已死（崩溃残留） */
const RUNNING_STALE_MS = 20 * 60_000;

interface ToolItem { name: string; args: string; result: string; status: string; }

interface TurnGroup {
  thinking: string[];
  content: string[];
  tools: Map<string, ToolItem>;
  order: string[];
  ts: number;
}

/** AutoClaw 运行库候选：Windows %APPDATA%（显式 home 回退，防环境变量被重定向）优先，再 macOS */
function autoclawDbCandidates(): string[] {
  const bases = new Set<string>([
    path.join(os.homedir(), 'AppData', 'Roaming'),
    process.env.APPDATA || '',
    path.join(os.homedir(), 'Library', 'Application Support'),
  ]);
  bases.delete('');
  const out: string[] = [];
  for (const base of bases) {
    const accountsDir = path.join(base, 'AutoClaw-official', 'accounts');
    let accounts: string[];
    try {
      accounts = fs.readdirSync(accountsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { continue; }
    for (const acc of accounts) out.push(path.join(accountsDir, acc, 'runtime', 'runtime.sqlite'));
  }
  return out;
}

/**
 * AutoClaw 采集器（tool = 'autoclaw'）：监控本机 AutoClaw 桌面端的会话。
 * 数据源 = 账户运行库 runtime.sqlite（WAL，只读打开）。schema：
 *   - work_sessions            会话元数据（标题/时间/删除/归档/workspace_id）
 *   - neutral_session_heads    会话游标（entry_count / updated_at —— heads 常比会话行新，增量指纹必须取 MAX）
 *   - neutral_session_entries  消息条目（entry_type: request/answer/assistant/reasoning/tool_call/tool_result/resource/attachment）
 *   - work_runs                运行记录（status='running' 为精确运行态；workspace_root 为真实项目目录）
 * 消息按 turn 分组：request 之后的 reasoning/assistant/tool_call/tool_result/answer 合成一条 assistant，
 * 工具结果按 toolCallId 跨条目配对（与 mcode 同款）；resource/attachment 为运行时登记噪声，不采。
 */
export class AutoclawCollector implements HubCollector {
  readonly tool = 'autoclaw';

  private db: DatabaseSync | null = null;

  private getDb(): DatabaseSync | null {
    if (this.db) return this.db;
    for (const p of autoclawDbCandidates()) {
      if (!fs.existsSync(p)) continue;
      const db = openSqliteReadonly(p, 'RADAR-AUTOCLAW');
      if (db) { this.db = db; return db; }
    }
    return null;
  }

  /** 连接出错时丢弃缓存句柄，下次 getDb 重新打开（库可能被源应用替换） */
  private dropDb(): void {
    if (this.db) { try { this.db.close(); } catch {} this.db = null; }
  }

  private hasTable(db: DatabaseSync, table: string): boolean {
    return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;
  }

  async listAll(): Promise<SessionInfo[]> {
    const db = this.getDb();
    if (!db) return [];
    try {
      if (!this.hasTable(db, 'work_sessions')) return [];
      // schema 容错：heads/runs/workspaces 任一缺失都退化为只用 work_sessions
      const hasHeads = this.hasTable(db, 'neutral_session_heads');
      const hasRuns = this.hasTable(db, 'work_runs');
      const hasWs = this.hasTable(db, 'work_workspaces');
      // updatedAt 取 MAX(会话行, heads)——AutoClaw 会话行 updated_at 滞后于消息写入（qoder 同款坑）；
      // ISO 字符串字典序即时间序，标量 MAX 直接可比
      const updatedExpr = hasHeads
        ? `MAX(COALESCE(s.updated_at, ''), COALESCE(h.updated_at, '')) AS effective_at`
        : `COALESCE(s.updated_at, '') AS effective_at`;
      const sql = [
        'SELECT s.session_id, s.title, s.created_at, s.archived_at,',
        `  ${updatedExpr},`,
        `  ${hasHeads ? 'COALESCE(h.entry_count, 0)' : '0'} AS message_count,`,
        hasRuns ? 'r.workspace_root AS run_root,' : 'NULL AS run_root,',
        hasWs ? 'w.root_path AS ws_root' : 'NULL AS ws_root',
        'FROM work_sessions s',
        hasHeads ? 'LEFT JOIN neutral_session_heads h ON h.session_id = s.session_id' : '',
        hasRuns ? 'LEFT JOIN (SELECT session_id, workspace_root, MAX(created_at) FROM work_runs GROUP BY session_id) r ON r.session_id = s.session_id' : '',
        hasWs ? 'LEFT JOIN work_workspaces w ON w.workspace_id = s.workspace_id' : '',
        'WHERE s.deleted_at IS NULL',
        'ORDER BY effective_at DESC LIMIT 5000',
      ].filter(Boolean).join(' ');
      const rows = db.prepare(sql).all() as any[];
      const out: SessionInfo[] = [];
      for (const r of rows) {
        const id = String(r.session_id || '');
        if (!id) continue;
        const updatedAtMs = Date.parse(r.effective_at) || 0;
        out.push({
          id,
          label: String(r.title || ''),
          file: id,
          messageCount: Number(r.message_count) || 0,
          createdAt: new Date(Date.parse(r.created_at) || updatedAtMs || Date.now()).toISOString(),
          updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : undefined,
          // 运行轮的真实项目目录优先（如 D:\projects\xxx），回退 workspace 根目录
          projectDir: String(r.run_root || r.ws_root || ''),
          archived: !!r.archived_at,
        });
      }
      return out;
    } catch (e) {
      LOG('listAll error:', e);
      this.dropDb();
      return [];
    }
  }

  async loadMessages(session: SessionInfo): Promise<SerializedMessage[]> {
    const db = this.getDb();
    if (!db) return [];
    try {
      if (!this.hasTable(db, 'neutral_session_entries')) return [];
      const rows = db.prepare(
        'SELECT entry_type, payload, committed_at FROM neutral_session_entries WHERE session_id = ? ORDER BY session_seq ASC',
      ).all(session.id) as { entry_type: string; payload: string; committed_at: string }[];
      const out: SerializedMessage[] = [];
      let cur: TurnGroup | null = null;

      const ensure = (): TurnGroup => {
        if (!cur) cur = { thinking: [], content: [], tools: new Map(), order: [], ts: 0 };
        return cur;
      };
      const flush = () => {
        if (!cur) return;
        const tools = cur.order.map((id) => cur!.tools.get(id)!).filter(Boolean);
        // 始终没等到结果的工具调用保持 running 会误导，统一翻 done（mcode 同款收尾）
        for (const t of tools) if (t.status === 'running') t.status = 'done';
        if (cur.content.length || cur.thinking.length || tools.length) {
          out.push({
            role: 'assistant',
            content: cur.content.join('\n\n'),
            thinking: cur.thinking.length ? cur.thinking.join('\n\n') : undefined,
            tools: tools.length ? tools : undefined,
            timestamp: cur.ts || Date.now(),
          });
        }
        cur = null;
      };

      for (const row of rows) {
        const tsMs = Date.parse(row.committed_at) || 0;
        let data: any = {};
        try { data = JSON.parse(row.payload)?.data || {}; } catch { data = {}; }
        switch (String(row.entry_type || '')) {
          case 'request': {
            flush();
            const text = String(data.text ?? data.effectivePrompt ?? '').trim();
            if (text) out.push({ role: 'user', content: text, timestamp: tsMs });
            break;
          }
          case 'reasoning': {
            const g = ensure();
            if (data.text) g.thinking.push(String(data.text));
            if (tsMs > g.ts) g.ts = tsMs;
            break;
          }
          case 'assistant': {
            const g = ensure();
            const blocks = Array.isArray(data.content) ? data.content : [];
            for (const b of blocks) {
              if (!b || typeof b.text !== 'string' || !b.text) continue;
              if (b.signature === 'reasoning_content' || b.type === 'reasoning_content') g.thinking.push(b.text);
              else g.content.push(b.text);
            }
            if (tsMs > g.ts) g.ts = tsMs;
            break;
          }
          case 'answer': {
            const g = ensure();
            if (data.text) g.content.push(String(data.text));
            if (tsMs > g.ts) g.ts = tsMs;
            break;
          }
          case 'tool_call': {
            const g = ensure();
            const id = String(data.toolCallId || '');
            if (id) {
              g.tools.set(id, { name: String(data.toolName || ''), args: JSON.stringify(data.input ?? {}), result: '', status: 'running' });
              g.order.push(id);
            }
            if (tsMs > g.ts) g.ts = tsMs;
            break;
          }
          case 'tool_result': {
            const g = ensure();
            const id = String(data.toolCallId || '');
            const item = id ? g.tools.get(id) : undefined;
            if (item) {
              item.result = String(data.content ?? '');
              item.status = data.status === 'error' ? 'error' : 'done';
            }
            if (tsMs > g.ts) g.ts = tsMs;
            break;
          }
          default:
            break; // resource / attachment 等运行时登记条目不采
        }
      }
      flush();
      return out;
    } catch (e) {
      LOG('loadMessages error:', e);
      this.dropDb();
      return [];
    }
  }

  async probe(): Promise<Map<string, ProbeSignal>> {
    const out = new Map<string, ProbeSignal>();
    const db = this.getDb();
    if (!db) return out;
    try {
      if (!this.hasTable(db, 'work_sessions')) return out;
      const hasHeads = this.hasTable(db, 'neutral_session_heads');
      const hasRuns = this.hasTable(db, 'work_runs');
      // 精确空闲先全覆盖（running:false，监控层立即归位），再由 running 中的 work_runs 翻 true（mcode 同款）
      const sql = `SELECT s.session_id AS sid,
          ${hasHeads ? `MAX(COALESCE(s.updated_at, ''), COALESCE(h.updated_at, ''))` : `COALESCE(s.updated_at, '')`} AS touched
        FROM work_sessions s
        ${hasHeads ? 'LEFT JOIN neutral_session_heads h ON h.session_id = s.session_id' : ''}
        WHERE s.deleted_at IS NULL LIMIT 5000`;
      for (const r of db.prepare(sql).all() as any[]) {
        const id = String(r.sid || '');
        if (!id) continue;
        out.set(id, { ts: Date.parse(r.touched) || 0, running: false });
      }
      if (hasRuns) {
        const now = Date.now();
        for (const r of db.prepare("SELECT session_id AS sid, updated_at FROM work_runs WHERE status = 'running'").all() as any[]) {
          const id = String(r.sid || '');
          if (!id) continue;
          const updatedMs = Date.parse(r.updated_at) || 0;
          const alive = updatedMs > 0 && now - updatedMs <= RUNNING_STALE_MS;
          const prev = out.get(id);
          if (prev) prev.running = alive;
          else out.set(id, { ts: updatedMs, running: alive });
        }
      }
      return out;
    } catch (e) {
      LOG('probe error:', e);
      this.dropDb();
      return out;
    }
  }

  async dispose(): Promise<void> {
    this.dropDb();
  }
}
