import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { radarDataDir } from './radar-config';

/**
 * 同步指纹库：记录每个会话上次同步时的源库 updated_at + 条数 + 已同步 seq，
 * 用于增量对比（没变就跳过消息解析）。这是同步器的工作状态（游标），不是聊天数据——
 * 删掉下一轮会凭本地库 last_synced_seq 游标续传或全量重建。
 * 只有本地写入成功后才前进。
 */
export interface Fingerprint {
  sourceUpdatedAt: number;
  messageCount: number;
  lastSyncedSeq: number;
}

export class FingerprintStore {
  private db: DatabaseSync | null = null;
  private readonly file: string;

  constructor(dir?: string) {
    this.file = path.join(dir || radarDataDir(), 'fingerprints.sqlite');
  }

  private ensure(): DatabaseSync {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fp (
        tool TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_updated_at INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_synced_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tool, session_id)
      )
    `);
    return this.db;
  }

  get(tool: string, sessionId: string): Fingerprint | null {
    const row = this.ensure().prepare(
      'SELECT source_updated_at, message_count, last_synced_seq FROM fp WHERE tool = ? AND session_id = ?',
    ).get(tool, sessionId) as any;
    if (!row) return null;
    return {
      sourceUpdatedAt: Number(row.source_updated_at),
      messageCount: Number(row.message_count),
      lastSyncedSeq: Number(row.last_synced_seq),
    };
  }

  set(tool: string, sessionId: string, fp: Fingerprint): void {
    this.ensure().prepare(`
      INSERT INTO fp (tool, session_id, source_updated_at, message_count, last_synced_seq)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tool, session_id) DO UPDATE SET
        source_updated_at = excluded.source_updated_at,
        message_count = excluded.message_count,
        last_synced_seq = excluded.last_synced_seq
    `).run(tool, sessionId, fp.sourceUpdatedAt, fp.messageCount, fp.lastSyncedSeq);
  }

  /** 该工具所有已采集过的会话 id（用于源库消失检测） */
  ids(tool: string): Set<string> {
    const rows = this.ensure().prepare('SELECT session_id FROM fp WHERE tool = ?').all(tool) as any[];
    return new Set(rows.map((r) => String(r.session_id)));
  }

  dispose(): void {
    try { this.db?.close(); } catch {}
    this.db = null;
  }
}
