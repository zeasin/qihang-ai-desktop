/**
 * 雷达本地正本库（radar.db，WAL）。
 * 从 qihangagenthub v2 hub-db 移植：指纹增量正本 + FTS5 trigram 全文检索。
 * 表结构与 hub-schema.sql 对齐（去 ENGINE/COMMENT/ngram，加 FTS5 虚表 + 触发器），
 * 表前缀 radar_。时间戳一律毫秒 epoch。tool 枚举：qoder/zcode/trae/dsh/claude-code/opencode/codex/pi。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { radarDataDir } from './radar-config';

export interface MessageRow {
  tool: string;
  sessionId: string;
  seq: number;
  role: string;
  content: string;
  thinking: string;
  toolsJson: string;
  ts: number;
}

export interface SessionRow {
  tool: string;
  sessionId: string;
  projectDir: string;
  title: string;
  messageCount: number;
  sourceUpdatedAt: number;
  sourceCreatedAt: number;
  capturedAt: number;
  syncedAt: number;
  lastSyncedSeq: number;
  state: string;
  stateChangedAt: number;
  frozen: number;
  frozenReason: string;
  missingSince: number;
}

export function dbPath(root: string): string {
  return path.join(root, 'radar.db');
}

export class RadarDb {
  private db: DatabaseSync;
  readonly root: string;

  constructor(root: string, opts?: { readonly?: boolean }) {
    this.root = root;
    if (opts?.readonly) {
      // 只读查询连接（WAL 允许与写入端并发读）：不迁移、不设 journal_mode。
      // readOnly 打开失败（WAL 需恢复）退回普通打开让 SQLite 完成恢复。
      try {
        this.db = new DatabaseSync(dbPath(root), { readOnly: true });
      } catch {
        this.db = new DatabaseSync(dbPath(root));
      }
      this.db.exec('PRAGMA busy_timeout = 5000;');
      return;
    }
    fs.mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(dbPath(root));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS radar_session (
        tool            TEXT NOT NULL,
        session_id      TEXT NOT NULL,
        project_dir     TEXT NOT NULL DEFAULT '',
        title           TEXT NOT NULL DEFAULT '',
        message_count   INTEGER NOT NULL DEFAULT 0,
        source_updated_at INTEGER NOT NULL DEFAULT 0,
        source_created_at INTEGER NOT NULL DEFAULT 0,
        captured_at     INTEGER NOT NULL DEFAULT 0,
        synced_at       INTEGER NOT NULL DEFAULT 0,
        last_synced_seq INTEGER NOT NULL DEFAULT 0,
        state           TEXT NOT NULL DEFAULT 'idle',
        state_changed_at INTEGER NOT NULL DEFAULT 0,
        frozen          INTEGER NOT NULL DEFAULT 0,
        frozen_reason   TEXT NOT NULL DEFAULT '',
        missing_since   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tool, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_radar_session_updated ON radar_session(source_updated_at);
      CREATE INDEX IF NOT EXISTS idx_radar_session_state   ON radar_session(state);
      CREATE INDEX IF NOT EXISTS idx_radar_session_frozen  ON radar_session(frozen);
      CREATE INDEX IF NOT EXISTS idx_radar_session_project ON radar_session(project_dir);

      CREATE TABLE IF NOT EXISTS radar_message (
        tool        TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        role        TEXT NOT NULL DEFAULT '',
        content     TEXT NOT NULL DEFAULT '',
        thinking    TEXT NOT NULL DEFAULT '',
        tools_json  TEXT NOT NULL DEFAULT '',
        ts          INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tool, session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_radar_message_ts ON radar_message(ts);

      CREATE TABLE IF NOT EXISTS radar_state_event (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        tool       TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state      TEXT NOT NULL,
        ts         INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_radar_state_event_ts ON radar_state_event(ts);
      CREATE INDEX IF NOT EXISTS idx_radar_state_event_ss ON radar_state_event(tool, session_id);

      -- FTS5 外部内容表 + 触发器（trigram 分词：CJK 按三gram，中文可全文检索）
      CREATE VIRTUAL TABLE IF NOT EXISTS radar_message_fts USING fts5(
        content, thinking, content='radar_message', content_rowid='rowid', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS radar_message_ai AFTER INSERT ON radar_message BEGIN
        INSERT INTO radar_message_fts(rowid, content, thinking)
        VALUES (new.rowid, new.content, new.thinking);
      END;
      CREATE TRIGGER IF NOT EXISTS radar_message_ad AFTER DELETE ON radar_message BEGIN
        INSERT INTO radar_message_fts(radar_message_fts, rowid, content, thinking)
        VALUES ('delete', old.rowid, old.content, old.thinking);
      END;
      CREATE TRIGGER IF NOT EXISTS radar_message_au AFTER UPDATE ON radar_message BEGIN
        INSERT INTO radar_message_fts(radar_message_fts, rowid, content, thinking)
        VALUES ('delete', old.rowid, old.content, old.thinking);
        INSERT INTO radar_message_fts(rowid, content, thinking)
        VALUES (new.rowid, new.content, new.thinking);
      END;
    `);
  }

  get conn(): DatabaseSync { return this.db; }

  /**
   * 项目路径归一化：Windows 路径不区分大小写，但 SQLite 默认区分，
   * 同一目录会被存成 `D:\x` 和 `d:\x` 两条，下拉框里显示完全一样却只能选中其中一条。
   * 统一小写入库，保证同一目录只有一个分组。
   */
  static normProject(p: string): string {
    return String(p || '').toLowerCase();
  }

  /** 会话 upsert（meta 批量；SQLite 版） */
  upsertSessionMeta(rows: { tool: string; sessionId: string; projectDir: string; title: string; messageCount: number;
      sourceUpdatedAt: number; sourceCreatedAt: number }[]): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO radar_session
        (tool, session_id, project_dir, title, message_count, source_updated_at,
         source_created_at, captured_at, synced_at, missing_since)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(tool, session_id) DO UPDATE SET
        project_dir     = excluded.project_dir,
        title           = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END,
        message_count   = MAX(message_count, excluded.message_count),
        source_updated_at = MAX(source_updated_at, excluded.source_updated_at),
        source_created_at = CASE WHEN source_created_at = 0 THEN excluded.source_created_at ELSE source_created_at END,
        synced_at       = excluded.synced_at,
        missing_since   = 0
    `);
    let n = 0;
    this.withTx(() => {
      for (const r of rows) {
        n += Number(stmt.run(r.tool, r.sessionId, RadarDb.normProject(r.projectDir), r.title || '', r.messageCount || 0,
          r.sourceUpdatedAt || now, r.sourceCreatedAt || 0, now, now).changes);
      }
    });
    return n;
  }

  /** 消息 upsert（delta/full 两态；事务内 update session 游标） */
  applyMessages(u: { tool: string; sessionId: string; projectDir: string; title: string; mode: 'delta'|'full';
      lastSyncedSeq: number; messageCount: number; sourceUpdatedAt: number; sourceCreatedAt: number;
      messages: { seq: number; role: string; content: string; thinking: string; toolsJson: string; ts: number }[] }): void {
    const now = Date.now();
    this.withTx(() => {
      if (u.mode === 'full') {
        this.db.prepare('DELETE FROM radar_message WHERE tool = ? AND session_id = ?').run(u.tool, u.sessionId);
      }
      const ups = this.db.prepare(`
        INSERT INTO radar_message (tool, session_id, seq, role, content, thinking, tools_json, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tool, session_id, seq) DO UPDATE SET
          role = excluded.role, content = excluded.content,
          thinking = excluded.thinking, tools_json = excluded.tools_json, ts = excluded.ts
      `);
      for (const m of u.messages) {
        ups.run(u.tool, u.sessionId, m.seq, m.role || '', m.content || '', m.thinking || '', m.toolsJson || '', m.ts || 0);
      }
      const total = u.messageCount > 0 ? u.messageCount : (u.lastSyncedSeq > 0 ? u.lastSyncedSeq : 0);
      this.db.prepare(`
        INSERT INTO radar_session
          (tool, session_id, project_dir, title, message_count, last_synced_seq,
           source_updated_at, source_created_at, captured_at, synced_at, missing_since)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(tool, session_id) DO UPDATE SET
          project_dir     = excluded.project_dir,
          title           = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END,
          message_count   = CASE WHEN ${u.mode === 'full' ? '1' : '0'} = 1
                             THEN excluded.message_count ELSE MAX(message_count, excluded.message_count) END,
          last_synced_seq = CASE WHEN ${u.mode === 'full' ? '1' : '0'} = 1
                             THEN excluded.last_synced_seq ELSE MAX(last_synced_seq, excluded.last_synced_seq) END,
          source_updated_at = MAX(source_updated_at, excluded.source_updated_at),
          source_created_at = CASE WHEN source_created_at = 0 THEN excluded.source_created_at ELSE source_created_at END,
          synced_at       = excluded.synced_at,
          missing_since   = 0
      `).run(u.tool, u.sessionId, RadarDb.normProject(u.projectDir), u.title || '', total, u.lastSyncedSeq || 0,
        u.sourceUpdatedAt || now, u.sourceCreatedAt || 0, now, now);
    });
  }

  /** 本地权威游标（ingest 续传） */
  sessionState(tool: string, sessionId: string): { lastSyncedSeq: number; messageCount: number; sourceUpdatedAt: number } | null {
    const r = this.db.prepare(
      'SELECT last_synced_seq, message_count, source_updated_at FROM radar_session WHERE tool = ? AND session_id = ?',
    ).get(tool, sessionId) as any;
    return r ? { lastSyncedSeq: r.last_synced_seq, messageCount: r.message_count, sourceUpdatedAt: r.source_updated_at } : null;
  }

  /** 本地冻结集合（ingest 跳过） */
  frozenIds(): Set<string> {
    const rows = this.db.prepare('SELECT tool, session_id FROM radar_session WHERE frozen = 1').all() as any[];
    return new Set(rows.map((r) => `${r.tool}/${r.session_id}`));
  }

  /** 源库消失：打标（防丢） */
  markMissing(tool: string, sessionIds: string[]): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      'UPDATE radar_session SET missing_since = ? WHERE tool = ? AND session_id = ? AND missing_since = 0',
    );
    this.withTx(() => { for (const id of sessionIds) stmt.run(now, tool, id); });
  }

  /** 冻结/解冻 */
  setFrozen(tool: string, sessionIds: string[], frozen: boolean, reason: string): void {
    const stmt = this.db.prepare(
      'UPDATE radar_session SET frozen = ?, frozen_reason = ? WHERE tool = ? AND session_id = ?',
    );
    this.withTx(() => { for (const id of sessionIds) stmt.run(frozen ? 1 : 0, frozen ? reason : '', tool, id); });
  }

  /** 所有已采集会话 id（缺失判定） */
  sessionIds(): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    const rows = this.db.prepare('SELECT tool, session_id FROM radar_session').all() as any[];
    for (const r of rows) {
      if (!map.has(r.tool)) map.set(r.tool, new Set());
      map.get(r.tool)!.add(r.session_id);
    }
    return map;
  }

  /** 会话行（检索/展示） */
  getSession(tool: string, sessionId: string): SessionRow | null {
    const r = this.db.prepare('SELECT * FROM radar_session WHERE tool = ? AND session_id = ?').get(tool, sessionId) as any;
    return r ? rowToSession(r) : null;
  }

  /** 状态投影：running 超 15 分钟无心跳归 idle（防僵尸） */
  effectiveState(tool: string, sessionId: string): { state: string; stateChangedAt: number } {
    const s = this.getSession(tool, sessionId);
    if (!s) return { state: 'idle', stateChangedAt: 0 };
    let state = s.state;
    let changed = s.stateChangedAt;
    if (state === 'running' && Date.now() - Math.max(changed, s.syncedAt) > 15 * 60_000) {
      state = 'idle';
      this.db.prepare('UPDATE radar_session SET state = ?, state_changed_at = ? WHERE tool = ? AND session_id = ?')
        .run('idle', Date.now(), tool, sessionId);
      changed = Date.now();
    }
    return { state, stateChangedAt: changed };
  }

  /** 当前标记为 running 的会话（worker 启动时预置监控表，防重启后重复发 running 事件） */
  runningSessionIds(): { tool: string; sessionId: string }[] {
    const rows = this.db.prepare(
      "SELECT tool, session_id FROM radar_session WHERE state = 'running'",
    ).all() as any[];
    return rows.map((r) => ({ tool: r.tool, sessionId: r.session_id }));
  }

  /** 状态跃迁写入 + 会话 state 投影（monitor 落点） */
  applyStateEvents(events: { tool: string; sessionId: string; state: string; ts: number }[]): void {
    const now = Date.now();
    this.withTx(() => {
      const ins = this.db.prepare(
        'INSERT INTO radar_state_event (tool, session_id, state, ts) VALUES (?, ?, ?, ?)');
      const upd = this.db.prepare(`
        INSERT INTO radar_session (tool, session_id, state, state_changed_at, synced_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tool, session_id) DO UPDATE SET
          state = excluded.state, state_changed_at = excluded.state_changed_at, synced_at = excluded.synced_at
      `);
      for (const e of events) {
        ins.run(e.tool, e.sessionId, e.state, e.ts || now);
        upd.run(e.tool, e.sessionId, e.state, e.ts || now, now);
      }
    });
  }

  /** 会话分页列表（按工具筛选 + 最近更新排序） */
  listSessions(opts: { tool?: string; limit?: number; offset?: number }): { total: number; rows: SessionRow[] } {
    const limit = Math.min(Math.max(opts.limit || 50, 1), 200);
    const offset = Math.max(opts.offset || 0, 0);
    const where = opts.tool ? 'WHERE tool = ?' : '';
    const params: any[] = opts.tool ? [opts.tool] : [];
    const total = (this.db.prepare(`SELECT count(*) c FROM radar_session ${where}`).get(...params) as any).c;
    const rows = this.db.prepare(`
      SELECT s.*, (
        SELECT count(*) FROM radar_message m WHERE m.tool = s.tool AND m.session_id = s.session_id
      ) AS actual_count
      FROM radar_session s ${where}
      ORDER BY s.state = 'running' DESC, s.source_updated_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];
    return { total, rows: rows.map(rowToSession) };
  }

  /** 某会话的消息（时间升序） */
  getMessages(tool: string, sessionId: string, limit = 2000): any[] {
    return this.db.prepare(`
      SELECT seq, role, content, thinking, tools_json AS toolsJson, ts
      FROM radar_message WHERE tool = ? AND session_id = ? ORDER BY seq ASC LIMIT ?
    `).all(tool, sessionId, limit) as any[];
  }

  /** 某会话的状态时间线 */
  stateEvents(tool: string, sessionId: string, limit = 200): any[] {
    return this.db.prepare(`
      SELECT state, ts FROM radar_state_event
      WHERE tool = ? AND session_id = ? ORDER BY ts DESC LIMIT ?
    `).all(tool, sessionId, limit) as any[];
  }

  /** 全文检索（消息级）。≥3 连续字符走 FTS5 trigram；更短的关键词回退 LIKE（中文 2 字词常见） */
  searchMessages(q: string, limit = 50, offset = 0): any[] {
    const term = this.ftsTerm(q);
    if (!term) {
      const rows = this.db.prepare(`
        SELECT m.tool, m.session_id AS sessionId, m.seq, m.role, m.content, m.thinking,
               m.ts, s.title, s.project_dir AS projectDir, s.state
        FROM radar_message m
        LEFT JOIN radar_session s ON s.tool = m.tool AND s.session_id = m.session_id
        WHERE m.content LIKE ? ESCAPE '!' AND m.content <> ''
        ORDER BY m.ts DESC LIMIT ? OFFSET ?
      `).all(`%${this.likeEscape(String(q || ''))}%`, limit, offset) as any[];
      return rows;
    }
    const rows = this.db.prepare(`
      SELECT m.tool, m.session_id AS sessionId, m.seq, m.role, m.content, m.thinking,
             m.ts, s.title, s.project_dir AS projectDir, s.state,
             bm25(radar_message_fts, 6.0, 1.0) AS score
      FROM radar_message_fts f
      JOIN radar_message m ON m.rowid = f.rowid
      LEFT JOIN radar_session s ON s.tool = m.tool AND s.session_id = m.session_id
      WHERE radar_message_fts MATCH ? AND m.content <> ''
      ORDER BY score ASC, m.ts DESC LIMIT ? OFFSET ?
    `).all(term, limit, offset);
    return rows as any[];
  }

  /** ≥3 连续字符 → 安全的 FTS5 trigram 查询；不足 → null（调用方走 LIKE）
   *  注意 trigram 分词器最短 3 字符，2 字中文词（折扣）必须走 LIKE，
   *  否则 MATCH 恒为 0 行，且 null 塞进 MATCH 会抛 fts5 语法错误。
   *  多词用 OR：用户搜「POS 折扣」时两个词不必相邻出现。 */
  private ftsTerm(q: string): string | null {
    const cleaned = String(q || '').replace(/["'():\\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    const toks = cleaned.split(' ').filter((t) => t.length >= 3);
    if (!toks.length) return null;
    if (toks.length === 1) return `"${toks[0]}"`;
    return toks.map((t) => `"${t}"`).join(' OR ');
  }

  private likeEscape(s: string): string {
    return s.replace(/[!%_]/g, (c) => '!' + c);
  }

  /** 会话聚合检索（find：项目/标题/消息命中）。命中消息的按 BM25 相关度排在前面 */
  findSessions(q: string, limit = 50): any[] {
    const term = this.ftsTerm(q);
    const like = `%${this.likeEscape(String(q || ''))}%`;
    const rows = term
      ? this.db.prepare(`
      WITH ms AS (
        SELECT m.tool AS tool, m.session_id AS sid, MIN(bm25(radar_message_fts, 6.0, 1.0)) AS score
        FROM radar_message_fts f
        JOIN radar_message m ON m.rowid = f.rowid
        WHERE radar_message_fts MATCH ?
        GROUP BY m.tool, m.session_id
      )
      SELECT s.*, (
        SELECT count(*) FROM radar_message m WHERE m.tool = s.tool AND m.session_id = s.session_id
      ) AS actual_count
      FROM radar_session s
      LEFT JOIN ms ON ms.tool = s.tool AND ms.sid = s.session_id
      WHERE (s.title LIKE ? OR LOWER(s.project_dir) = LOWER(?) OR s.session_id LIKE ?)
         OR ms.tool IS NOT NULL
      ORDER BY ms.score ASC, s.synced_at DESC LIMIT ? OFFSET 0
    `).all(term, like, String(q || ''), like, limit)
      // term 为 null（2 字中文词）时 trigram 无从匹配，只走标题/路径/会话id 的 LIKE
      : this.db.prepare(`
      SELECT s.*, (
        SELECT count(*) FROM radar_message m WHERE m.tool = s.tool AND m.session_id = s.session_id
      ) AS actual_count
      FROM radar_session s
      WHERE s.title LIKE ? OR LOWER(s.project_dir) = LOWER(?) OR s.session_id LIKE ?
      ORDER BY s.synced_at DESC LIMIT ? OFFSET 0
    `).all(like, String(q || ''), like, limit);
    return (rows as any[]).map(rowToSession);
  }

  /** 时间线（按天） */
  timeline(dayStart: number, dayEnd: number, limit = 500): any[] {
    return this.db.prepare(`
      SELECT tool, session_id AS sessionId, seq, role, content, ts
      FROM radar_message WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT ?
    `).all(dayStart, dayEnd, limit) as any[];
  }

  /** 统计总览 */
  stats(): { sessions: number; messages: number; running: number; activeToday: number } {
    const dayStart = new Date().setHours(0, 0, 0, 0);
    const s = this.db.prepare('SELECT count(*) c FROM radar_session').get() as any;
    const m = this.db.prepare('SELECT count(*) c FROM radar_message').get() as any;
    const r = this.db.prepare("SELECT count(*) c FROM radar_session WHERE state = 'running'").get() as any;
    const a = this.db.prepare('SELECT count(*) c FROM radar_session WHERE synced_at >= ?').get(dayStart) as any;
    return { sessions: s.c, messages: m.c, running: r.c, activeToday: a.c };
  }

  /** 各工具统计（雷达页工具卡片用） */
  toolStats(): { tool: string; sessions: number; running: number; lastActivity: number }[] {
    const rows = this.db.prepare(`
      SELECT tool,
             count(*) AS sessions,
             SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running,
             MAX(source_updated_at) AS lastActivity
      FROM radar_session GROUP BY tool
    `).all() as any[];
    return rows.map((r) => ({
      tool: r.tool, sessions: Number(r.sessions), running: Number(r.running) || 0,
      lastActivity: Number(r.lastActivity) || 0,
    }));
  }

  /** 工具卡片概览：每工具的运行数 + 最近一次活跃的会话（标题/项目/时间） */
  overviewCards(): { tool: string; sessions: number; running: number; lastActivity: number;
      lastSessionTitle: string; lastSessionProject: string; lastSessionState: string }[] {
    const stats = this.db.prepare(`
      SELECT tool, count(*) AS sessions,
             SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running,
             MAX(source_updated_at) AS lastActivity
      FROM radar_session GROUP BY tool
    `).all() as any[];
    const lastRows = this.db.prepare(`
      SELECT tool, session_id, title, project_dir, source_updated_at, state
      FROM radar_session
      WHERE source_updated_at = (SELECT MAX(x.source_updated_at) FROM radar_session x WHERE x.tool = radar_session.tool)
    `).all() as any[];
    const lastByTool = new Map(lastRows.map((r) => [r.tool, r]));
    return stats.map((r) => {
      const last = lastByTool.get(r.tool);
      return {
        tool: r.tool,
        sessions: Number(r.sessions),
        running: Number(r.running) || 0,
        lastActivity: Number(r.lastActivity) || 0,
        lastSessionTitle: last?.title || '',
        lastSessionProject: last?.project_dir || '',
        lastSessionState: last?.state || 'idle',
      };
    });
  }

  /** 最近状态跃迁（跨工具，带会话标题） */
  recentEvents(limit = 20): any[] {
    return this.db.prepare(`
      SELECT e.tool, e.session_id AS sessionId, e.state, e.ts,
             s.title, s.project_dir AS projectDir
      FROM radar_state_event e
      LEFT JOIN radar_session s ON s.tool = e.tool AND s.session_id = e.session_id
      ORDER BY e.ts DESC LIMIT ?
    `).all(Math.min(limit, 100)) as any[];
  }

  /** 最近活跃会话（运行中优先，按最近更新排序） */
  recentSessions(limit = 15): any[] {
    const rows = this.db.prepare(`
      SELECT s.*, (
        SELECT count(*) FROM radar_message m WHERE m.tool = s.tool AND m.session_id = s.session_id
      ) AS actual_count
      FROM radar_session s
      ORDER BY s.state = 'running' DESC, s.source_updated_at DESC LIMIT ?
    `).all(Math.min(limit, 100)) as any[];
    return rows.map((r) => ({ ...rowToSession(r), actual_count: r.actual_count }));
  }

  private withTx(fn: () => void): void {
    this.db.exec('BEGIN');
    try { fn(); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

function rowToSession(r: any): SessionRow {
  return {
    tool: r.tool, sessionId: r.session_id, projectDir: r.project_dir, title: r.title,
    messageCount: r.message_count, sourceUpdatedAt: r.source_updated_at, sourceCreatedAt: r.source_created_at,
    capturedAt: r.captured_at, syncedAt: r.synced_at, lastSyncedSeq: r.last_synced_seq,
    state: r.state, stateChangedAt: r.state_changed_at, frozen: r.frozen,
    frozenReason: r.frozen_reason, missingSince: r.missing_since,
  };
}
