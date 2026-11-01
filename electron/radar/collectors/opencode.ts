import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteReadonly } from '../sqlite-open';
import type { HubCollector, SerializedMessage, SessionInfo } from '../types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-OPENCODE]', msg, ...args);

function opencodeDbPath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/**
 * OpenCode 只读采集（2.x 库）：session_v2 会话 + session_message 消息，纯 db 直读。
 * 不做 SDK/HTTP 兜底——库不存在说明 opencode 未安装或太老，会话列表为空即可。
 */
export class OpenCodeCollector implements HubCollector {
  readonly tool = 'opencode';

  private openDb(): DatabaseSync | null {
    const dbPath = opencodeDbPath();
    if (!existsSync(dbPath)) return null;
    return openSqliteReadonly(dbPath, 'RADAR-OPENCODE');
  }

  private hasTable(db: DatabaseSync, table: string): boolean {
    return db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;
  }

  async listAll(): Promise<SessionInfo[]> {
    const db = this.openDb();
    if (!db) return [];
    try {
      if (!this.hasTable(db, 'session_v2')) return [];
      const rows = db.prepare(
        `SELECT id, directory, title, time_created, time_updated, tokens_input
         FROM session_v2 WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 5000`,
      ).all() as any[];
      return rows.map((r) => ({
        id: r.id,
        label: r.title || '',
        file: r.id,
        // OpenCode 没有 messageCount，用 tokens.input > 0 判断是否有消息
        messageCount: Number(r.tokens_input) > 0 ? 1 : 0,
        createdAt: new Date(Number(r.time_created)).toISOString(),
        updatedAt: new Date(Number(r.time_updated)).toISOString(),
        // 库里存正斜杠路径：归一成反斜杠，目录过滤按 Windows 风格匹配
        projectDir: String(r.directory || '').replace(/\//g, '\\'),
      }));
    } catch (e) {
      LOG('listAll error:', e);
      return [];
    } finally {
      try { db.close(); } catch {}
    }
  }

  async loadMessages(session: SessionInfo): Promise<SerializedMessage[]> {
    const db = this.openDb();
    if (!db) return [];
    try {
      if (!this.hasTable(db, 'session_message')) return [];
      const rows = db.prepare(
        `SELECT type, time_created, data FROM session_message
         WHERE session_id = ? AND type IN ('user', 'assistant') ORDER BY seq ASC`,
      ).all(session.id) as { type: string; time_created: number; data: string }[];
      const out: SerializedMessage[] = [];
      for (const row of rows) {
        let d: any;
        try { d = JSON.parse(row.data); } catch { continue; }
        const timestamp = Number(d?.time?.created || row.time_created) || Date.now();
        if (row.type === 'user') {
          const text = String(d?.text || '');
          if (!text) continue;
          out.push({ role: 'user', content: text, timestamp });
          continue;
        }
        const blocks: any[] = Array.isArray(d?.content) ? d.content : [];
        const textParts = blocks.filter((b) => b?.type === 'text' && b.text).map((b) => String(b.text));
        const thinking = blocks.filter((b) => b?.type === 'reasoning' && b.text).map((b) => String(b.text)).join('\n');
        const tools = blocks.filter((b) => b?.type === 'tool').map((b) => {
          const st = b.state || {};
          return {
            name: b.name || '',
            args: typeof st.input === 'string' ? st.input : JSON.stringify(st.input || {}),
            result: Array.isArray(st.content) ? st.content.map((c: any) => c?.text ?? '').join('\n') : '',
            status: st.status === 'completed' ? 'done' : st.status === 'error' ? 'error' : 'running',
          };
        });
        if (!textParts.length && !thinking && !tools.length) continue;
        out.push({
          role: 'assistant',
          content: textParts.join('\n'),
          thinking: thinking || undefined,
          tools: tools.length ? tools : undefined,
          timestamp,
        });
      }
      return out;
    } catch (e) {
      LOG('loadMessages error:', e);
      return [];
    } finally {
      try { db.close(); } catch {}
    }
  }

  async probe(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const db = this.openDb();
    if (!db) return out;
    try {
      if (!this.hasTable(db, 'session_v2')) return out;
      const cutoff = Date.now() - 10 * 60_000;
      const rows = db.prepare(
        `SELECT id, time_updated FROM session_v2 WHERE parent_id IS NULL AND time_updated > ?`,
      ).all(cutoff) as any[];
      for (const r of rows) out.set(String(r.id), Number(r.time_updated));
    } catch (e) {
      LOG('probe error:', e);
    } finally {
      try { db.close(); } catch {}
    }
    return out;
  }

  async dispose(): Promise<void> {}
}
