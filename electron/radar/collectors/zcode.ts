import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteReadonly } from '../sqlite-open';
import type { HubCollector, SerializedMessage, SessionInfo } from '../types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-ZCODE]', msg, ...args);

function zcodeDbPath(): string {
  return path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}

interface ZcodePartData {
  type: string;
  text?: string;
  tool?: string;
  state?: { status?: string; input?: unknown; output?: unknown };
}

interface ZcodeMessageData {
  role?: string;
  time?: { created?: number };
  metadata?: { visibility?: string };
}

/** ZCode 只读采集：~/.zcode/cli/db/db.sqlite（session / message / part 三层） */
export class ZcodeCollector implements HubCollector {
  readonly tool = 'zcode';
  private db: DatabaseSync | null = null;

  async ensureDb(): Promise<DatabaseSync | null> {
    if (!this.db) this.db = openSqliteReadonly(zcodeDbPath(), 'RADAR-ZCODE');
    if (!this.db) LOG('db.sqlite 未找到，会话列表将为空');
    return this.db;
  }

  async listAll(): Promise<SessionInfo[]> {
    const db = await this.ensureDb();
    if (!db) return [];
    try {
      const rows = db.prepare(
        `SELECT id, directory, title, time_created, time_updated
         FROM session WHERE time_deleted IS NULL ORDER BY time_updated DESC`,
      ).all() as any[];
      const counts = db.prepare(
        `SELECT session_id, count(*) AS c FROM message GROUP BY session_id`,
      ).all() as any[];
      const countMap = new Map(counts.map((r) => [r.session_id, Number(r.c)]));
      return rows.map((r) => ({
        id: r.id,
        label: r.title || '',
        file: r.id,
        messageCount: countMap.get(r.id) || 0,
        createdAt: new Date(Number(r.time_created)).toISOString(),
        updatedAt: new Date(Number(r.time_updated)).toISOString(),
        projectDir: r.directory || '',
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
      const msgs = db.prepare(
        `SELECT id, data, time_created FROM message
         WHERE session_id = ? ORDER BY COALESCE(sequence, time_created), id`,
      ).all(session.id) as any[];
      const parts = db.prepare(
        `SELECT message_id, data FROM part WHERE session_id = ? ORDER BY sequence, id`,
      ).all(session.id) as any[];

      const partsByMessage = new Map<string, ZcodePartData[]>();
      for (const p of parts) {
        let data: ZcodePartData;
        try { data = JSON.parse(p.data); } catch { continue; }
        const list = partsByMessage.get(p.message_id) || [];
        list.push(data);
        partsByMessage.set(p.message_id, list);
      }

      const out: SerializedMessage[] = [];
      for (const m of msgs) {
        let data: ZcodeMessageData;
        try { data = JSON.parse(m.data); } catch { continue; }
        const role = data.role === 'user' ? 'user' : 'assistant';
        // model-only 的内部消息（todo 提醒等）不采集
        if (role === 'user' && data.metadata?.visibility === 'model-only') continue;

        const list = partsByMessage.get(m.id) || [];
        const content: string[] = [];
        let thinking = '';
        const tools: SerializedMessage['tools'] = [];
        for (const part of list) {
          switch (part.type) {
            case 'text':
              if (part.text) content.push(part.text);
              break;
            case 'reasoning':
              if (part.text) thinking += (thinking ? '\n' : '') + part.text;
              break;
            case 'tool':
              if (part.tool) {
                const output = part.state?.output;
                tools.push({
                  name: part.tool,
                  args: JSON.stringify(part.state?.input ?? {}),
                  result: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
                  status: part.state?.status || 'done',
                });
              }
              break;
            default:
              break; // step-start/step-finish/file/timeline 不采集
          }
        }
        if (!content.length && !thinking && !tools.length) continue;
        out.push({
          role,
          content: content.join('\n'),
          thinking: thinking || undefined,
          tools: tools.length ? tools : undefined,
          timestamp: Number(data.time?.created ?? m.time_created),
        });
      }
      return out;
    } catch (e) {
      LOG('loadMessages error:', e);
      return [];
    }
  }

  /** 轻探针：最近 10 分钟有动静的会话（单查询，毫秒级） */
  async probe(): Promise<Map<string, number>> {
    const db = await this.ensureDb();
    const out = new Map<string, number>();
    if (!db) return out;
    try {
      const cutoff = Date.now() - 10 * 60_000;
      const rows = db.prepare(
        `SELECT id, time_updated FROM session
         WHERE time_deleted IS NULL AND time_updated > ?`,
      ).all(cutoff) as any[];
      for (const r of rows) out.set(String(r.id), Number(r.time_updated));
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
