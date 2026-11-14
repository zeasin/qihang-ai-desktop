import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteReadonly } from '../sqlite-open';
import type { HubCollector, ProbeSignal, SerializedMessage, SessionInfo } from '../types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-QODER]', msg, ...args);

/** Qoder 主库候选：CN 版 com.qodercn.app.stable，国际版 com.qoder.app.stable */
function qoderDbCandidates(): string[] {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [
    path.join(roaming, 'com.qodercn.app.stable', 'main.sqlite'),
    path.join(roaming, 'com.qoder.app.stable', 'main.sqlite'),
  ];
}

interface QoderPart {
  type: string;
  text?: string;
  thinking?: string;
  tool?: { name?: string; input?: unknown; response?: string; result?: string; status?: string };
}

interface QoderPayload {
  parts?: QoderPart[];
}

/** Qoder 只读采集：main.sqlite（chat_sessions / chat_session_messages） */
export class QoderCollector implements HubCollector {
  readonly tool = 'qoder';
  private db: DatabaseSync | null = null;

  async ensureDb(): Promise<DatabaseSync | null> {
    if (!this.db) {
      for (const candidate of qoderDbCandidates()) {
        const db = openSqliteReadonly(candidate, 'RADAR-QODER');
        if (db) {
          this.db = db;
          LOG('using db:', candidate);
          break;
        }
      }
      if (!this.db) LOG('Qoder main.sqlite 未找到，会话列表将为空');
    }
    return this.db;
  }

  async listAll(): Promise<SessionInfo[]> {
    const db = await this.ensureDb();
    if (!db) return [];
    try {
      // Qoder 的会话行 updated_at 只在提问时更新，助手回合完成时只改消息行——
      // 必须取「会话 updated_at 与消息最大 updated_at 的较大者」，否则指纹永远不变、AI 回复采不到
      const rows = db.prepare(
        `SELECT s.session_id, s.title, s.cwd, s.created_at, s.updated_at, s.archived,
                MAX(COALESCE(lm.last_msg_at, 0), s.updated_at) AS effective_at
         FROM chat_sessions s
         LEFT JOIN (SELECT session_id, MAX(updated_at) AS last_msg_at FROM chat_session_messages GROUP BY session_id) lm
           ON lm.session_id = s.session_id
         WHERE s.deleted_at IS NULL
         ORDER BY effective_at DESC`,
      ).all() as any[];
      const counts = db.prepare(
        `SELECT session_id, count(*) AS c FROM chat_session_messages GROUP BY session_id`,
      ).all() as any[];
      const countMap = new Map(counts.map((r) => [r.session_id, Number(r.c)]));
      return rows.map((r) => ({
        id: r.session_id,
        label: r.title || '',
        file: r.session_id,
        messageCount: countMap.get(r.session_id) || 0,
        createdAt: new Date(Number(r.created_at)).toISOString(),
        updatedAt: new Date(Number(r.effective_at)).toISOString(),
        projectDir: r.cwd || '',
        archived: !!r.archived,
      }));
    } catch (e) {
      LOG('listAll error:', e);
      return [];
    }
  }

  async loadMessages(session: SessionInfo): Promise<SerializedMessage[]> {
    const db = await this.ensureDb();
    if (!db || !session.id) return [];
    try {
      const rows = db.prepare(
        `SELECT role, payload_json, created_at FROM chat_session_messages
         WHERE session_id = ? ORDER BY sequence`,
      ).all(session.id) as any[];
      const out: SerializedMessage[] = [];
      for (const row of rows) {
        let payload: QoderPayload;
        try { payload = JSON.parse(row.payload_json); } catch { continue; }
        const role = row.role === 'user' ? 'user' : 'assistant';
        const content: string[] = [];
        let thinking = '';
        const tools: SerializedMessage['tools'] = [];
        for (const part of payload.parts || []) {
          switch (part.type) {
            case 'text':
              if (part.text) content.push(part.text);
              break;
            case 'thinking':
              if (part.thinking || part.text) thinking += (thinking ? '\n' : '') + (part.thinking || part.text || '');
              break;
            case 'tool':
              if (part.tool?.name) {
                tools.push({
                  name: part.tool.name,
                  args: JSON.stringify(part.tool.input ?? {}),
                  result: part.tool.response ?? part.tool.result ?? '',
                  status: part.tool.status || 'done',
                });
              }
              break;
            default:
              break;
          }
        }
        if (!content.length && !thinking && !tools.length) continue;
        out.push({
          role,
          content: content.join('\n'),
          thinking: thinking || undefined,
          tools: tools.length ? tools : undefined,
          timestamp: Number(row.created_at),
        });
      }
      return out;
    } catch (e) {
      LOG('loadMessages error:', e);
      return [];
    }
  }

  async probe(): Promise<Map<string, ProbeSignal>> {
    const db = await this.ensureDb();
    const out = new Map<string, ProbeSignal>();
    if (!db) return out;
    try {
      const cutoff = Date.now() - 10 * 60_000;
      // 与 listAll 同理：以消息行最大 updated_at 为准，回合结束就能被探到
      const rows = db.prepare(
        `SELECT s.session_id, MAX(COALESCE(lm.last_msg_at, 0), s.updated_at) AS ts
         FROM chat_sessions s
         LEFT JOIN (SELECT session_id, MAX(updated_at) AS last_msg_at FROM chat_session_messages GROUP BY session_id) lm
           ON lm.session_id = s.session_id
         WHERE s.deleted_at IS NULL AND MAX(COALESCE(lm.last_msg_at, 0), s.updated_at) > ?`,
      ).all(cutoff) as any[];
      for (const r of rows) out.set(String(r.session_id), { ts: Number(r.ts) });
    } catch (e) {
      LOG('probe error:', e);
    }
    return out;
  }

  async dispose(): Promise<void> {
    try { this.db?.close(); } catch {}
    this.db = null;
  }
}
