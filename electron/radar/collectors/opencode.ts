import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteReadonly } from '../sqlite-open';
import type { HubCollector, ProbeSignal, SerializedMessage, SessionInfo } from '../types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-OPENCODE]', msg, ...args);

function opencodeDbPath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

/**
 * OpenCode 只读采集，纯 db 直读，兼容两代库结构：
 *  - v1（session 表 + message/part 内容块表）
 *  - 2.x（session_v2 会话 + session_message 消息）
 * 不做 SDK/HTTP 兜底——库不存在说明 opencode 未安装或太老，会话列表为空即可。
 */
export class OpenCodeCollector implements HubCollector {
  readonly tool = 'opencode';

  /** 常驻只读连接（与 zcode/qoder 同款，省掉探针每 3s 一次的 open/close） */
  private db: DatabaseSync | null = null;

  private getDb(): DatabaseSync | null {
    if (this.db) return this.db;
    const dbPath = opencodeDbPath();
    if (!existsSync(dbPath)) return null;
    this.db = openSqliteReadonly(dbPath, 'RADAR-OPENCODE');
    return this.db;
  }

  /** 连接出错时关闭并丢弃缓存句柄，下次 getDb 重新打开（库可能被源工具替换） */
  private dropDb(): void {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }

  private hasTable(db: DatabaseSync, table: string): boolean {
    return db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;
  }

  /** 会话表名：2.x 为 session_v2，v1 为 session；都没有则不支持 */
  private sessionTable(db: DatabaseSync): string | null {
    if (this.hasTable(db, 'session_v2')) return 'session_v2';
    if (this.hasTable(db, 'session')) return 'session';
    return null;
  }

  private rowToSession(r: any): SessionInfo {
    return {
      id: r.id,
      label: r.title || '',
      file: r.id,
      // OpenCode 没有 messageCount，用 tokens.input > 0 判断是否有消息
      messageCount: Number(r.tokens_input) > 0 ? 1 : 0,
      createdAt: new Date(Number(r.time_created)).toISOString(),
      updatedAt: new Date(Number(r.time_updated)).toISOString(),
      // 库里存正斜杠路径：归一成反斜杠，目录过滤按 Windows 风格匹配
      projectDir: String(r.directory || '').replace(/\//g, '\\'),
    };
  }

  async listAll(): Promise<SessionInfo[]> {
    const db = this.getDb();
    if (!db) return [];
    try {
      const table = this.sessionTable(db);
      if (!table) return [];
      const rows = db.prepare(
        `SELECT id, directory, title, time_created, time_updated, tokens_input
         FROM ${table} WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 5000`,
      ).all() as any[];
      return rows.map((r) => this.rowToSession(r));
    } catch (e) {
      LOG('listAll error:', e);
      this.dropDb();
      return [];
    }
  }

  /** v1：message 骨架（role/time）+ part 内容块（text/reasoning/tool） */
  private loadMessagesV1(db: DatabaseSync, sessionId: string): SerializedMessage[] {
    const msgs = db.prepare(
      `SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY rowid ASC`,
    ).all(sessionId) as { id: string; data: string; time_created: number }[];
    const parts = db.prepare(
      `SELECT message_id, data FROM part WHERE session_id = ? ORDER BY rowid ASC`,
    ).all(sessionId) as { message_id: string; data: string }[];

    const byMessage = new Map<string, any[]>();
    for (const p of parts) {
      let d: any;
      try { d = JSON.parse(p.data); } catch { continue; }
      const list = byMessage.get(p.message_id) || [];
      list.push(d);
      byMessage.set(p.message_id, list);
    }

    const out: SerializedMessage[] = [];
    for (const row of msgs) {
      let d: any;
      try { d = JSON.parse(row.data); } catch { continue; }
      const role = d?.role === 'user' ? 'user' : 'assistant';
      const timestamp = Number(d?.time?.created || row.time_created) || Date.now();
      const blocks = byMessage.get(row.id) || [];
      const texts = blocks.filter((b) => b?.type === 'text' && b.text && !b.synthetic).map((b) => String(b.text));
      if (role === 'user') {
        const text = texts.join('\n').trim();
        if (!text) continue;
        out.push({ role, content: text, timestamp });
        continue;
      }
      const thinking = blocks.filter((b) => b?.type === 'reasoning' && b.text).map((b) => String(b.text)).join('\n');
      const tools = blocks.filter((b) => b?.type === 'tool').map((b) => {
        const st = b.state || {};
        return {
          name: String(b.tool || ''),
          args: typeof st.input === 'string' ? st.input : JSON.stringify(st.input || {}),
          result: typeof st.output === 'string' ? st.output : JSON.stringify(st.output || ''),
          status: st.status === 'completed' ? 'done' : st.status === 'error' ? 'error' : 'running',
        };
      });
      if (!texts.length && !thinking && !tools.length) continue;
      out.push({
        role,
        content: texts.join('\n'),
        thinking: thinking || undefined,
        tools: tools.length ? tools : undefined,
        timestamp,
      });
    }
    return out;
  }

  /** 2.x：session_message 单表（type user/assistant，data 内含 text/content 块） */
  private loadMessagesV2(db: DatabaseSync, sessionId: string): SerializedMessage[] {
    const rows = db.prepare(
      `SELECT type, time_created, data FROM session_message
       WHERE session_id = ? AND type IN ('user', 'assistant') ORDER BY seq ASC`,
    ).all(sessionId) as { type: string; time_created: number; data: string }[];
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
  }

  async loadMessages(session: SessionInfo): Promise<SerializedMessage[]> {
    const db = this.getDb();
    if (!db) return [];
    try {
      if (this.hasTable(db, 'message') && this.hasTable(db, 'part')) {
        return this.loadMessagesV1(db, session.id);
      }
      if (!this.hasTable(db, 'session_message')) return [];
      return this.loadMessagesV2(db, session.id);
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
      const table = this.sessionTable(db);
      if (!table) return out;
      const cutoff = Date.now() - 10 * 60_000;
      const rows = db.prepare(
        `SELECT id, time_updated FROM ${table} WHERE parent_id IS NULL AND time_updated > ?`,
      ).all(cutoff) as any[];
      for (const r of rows) out.set(String(r.id), { ts: Number(r.time_updated) });
    } catch (e) {
      LOG('probe error:', e);
      this.dropDb();
    }
    return out;
  }

  async dispose(): Promise<void> {
    this.dropDb();
  }
}
