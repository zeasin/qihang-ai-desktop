/**
 * 雷达本地正本库（radar.db，WAL）。
 * 从 qihangagenthub v2 hub-db 移植：指纹增量正本 + FTS5 trigram 全文检索。
 * 表结构与 hub-schema.sql 对齐（去 ENGINE/COMMENT/ngram，加 FTS5 虚表 + 触发器），
 * 表前缀 radar_。时间戳一律毫秒 epoch。tool 枚举：qoder/zcode/trae/dsh/claude-code/opencode/codex/pi/mcode/autoclaw。
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
  /** 规则价值分 0-5（worker 在会话收口时计算落库）：≥3 视为高价值，作为 AI 摘要门槛 */
  valueScore?: number;
  /** AI 会话摘要（收口后提炼：做了什么/关键决策/涉及文件/结果） */
  summary?: string;
  summaryMsgCount?: number;
  summaryAt?: number;
}

export function dbPath(root: string): string {
  return path.join(root, 'radar.db');
}

/** 僵尸 running 判定窗口：running 超过该时长无同步心跳，读路径一律按 idle 展示 */
const ZOMBIE_MS = 15 * 60_000;

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
    // 增量迁移：提炼层字段（价值分 + AI 摘要）。node:sqlite 无 ALTER IF NOT EXISTS，按表结构判断
    const cols = (this.db.prepare("PRAGMA table_info(radar_session)").all() as any[]).map((c) => c.name);
    if (!cols.includes('value_score')) {
      this.db.exec("ALTER TABLE radar_session ADD COLUMN value_score INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.includes('summary')) {
      this.db.exec("ALTER TABLE radar_session ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
      this.db.exec("ALTER TABLE radar_session ADD COLUMN summary_msg_count INTEGER NOT NULL DEFAULT 0");
      this.db.exec("ALTER TABLE radar_session ADD COLUMN summary_at INTEGER NOT NULL DEFAULT 0");
    }
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
  sessionState(tool: string, sessionId: string): { lastSyncedSeq: number; messageCount: number; sourceUpdatedAt: number; title: string } | null {
    const r = this.db.prepare(
      'SELECT last_synced_seq, message_count, source_updated_at, title FROM radar_session WHERE tool = ? AND session_id = ?',
    ).get(tool, sessionId) as any;
    return r ? { lastSyncedSeq: r.last_synced_seq, messageCount: r.message_count, sourceUpdatedAt: r.source_updated_at, title: r.title || '' } : null;
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
    const r = this.db.prepare(`
      SELECT *, ${this.stateExpr()} AS effective_state
      FROM radar_session WHERE tool = ? AND session_id = ?
    `).get(tool, sessionId) as any;
    return r ? rowToSession(r) : null;
  }

  /** 按 sessionId 查会话（知识库 MCP 用：search 结果的 ref 只带 sid）。
   *  同 id 在不同 tool 下可能有行，取源里最近更新的一条。 */
  getSessionById(sessionId: string): SessionRow | null {
    const r = this.db.prepare(`
      SELECT *, ${this.stateExpr()} AS effective_state
      FROM radar_session WHERE session_id = ?
      ORDER BY source_updated_at DESC LIMIT 1
    `).get(sessionId) as any;
    return r ? rowToSession(r) : null;
  }

  /** 生效状态 SQL 片段：running 且超过 ZOMBIE_MS 无同步心跳 → 读路径视为 idle（只读投影，不落库）。
   *  worker 存活时 ingest 每轮都会刷新在源里仍存在的会话的 synced_at（约 60s 一次），
   *  worker 挂掉/崩溃循环时 synced_at 冻结，靠它保证 UI 不会永远显示「运行中」。 */
  private stateExpr(alias = ''): string {
    const p = alias ? `${alias}.` : '';
    return `CASE WHEN ${p}state = 'running' AND MAX(${p}state_changed_at, ${p}synced_at) < ${Date.now() - ZOMBIE_MS} THEN 'idle' ELSE ${p}state END`;
  }

  /** 当前标记为 running 的会话（worker 启动时预置监控表，防重启后重复发 running 事件） */
  runningSessionIds(): { tool: string; sessionId: string }[] {
    const rows = this.db.prepare(
      "SELECT tool, session_id FROM radar_session WHERE state = 'running'",
    ).all() as any[];
    return rows.map((r) => ({ tool: r.tool, sessionId: r.session_id }));
  }

  /**
   * 启动清扫：上次运行 worker 中途挂掉时来不及转 idle 的僵尸 running 会话，直接归位。
   * 心跳 = MAX(state_changed_at, synced_at)（ingest 每轮都会刷新在源里仍存在的会话的 synced_at），
   * 超过 idleTimeoutMs 没心跳说明 worker 已停摆至少一轮，不可能仍在运行。只改投影，不补发事件。
   */
  sweepStaleRunning(idleTimeoutMs: number): number {
    const info = this.db.prepare(`
      UPDATE radar_session SET state = 'idle', state_changed_at = ?
      WHERE state = 'running' AND MAX(state_changed_at, synced_at) < ?
    `).run(Date.now(), Date.now() - idleTimeoutMs);
    return Number(info.changes);
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

  /**
   * 规则价值分（0-5，越高越重要）。只用库里现成的聚合信号，零 AI 成本：
   *   轮数（用户消息数）、用户输入字数、AI 输出字数、会话时长。
   * ≥3 视为高价值：列表打标 + 作为 AI 摘要的门槛（水会话不调模型）。
   */
  computeValueScore(tool: string, sessionId: string): number {
    const agg = this.db.prepare(`
      SELECT
        SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS rounds,
        SUM(CASE WHEN role = 'user' THEN length(content) ELSE 0 END) AS userChars,
        SUM(CASE WHEN role = 'assistant' THEN length(content) ELSE 0 END) AS aiChars
      FROM radar_message WHERE tool = ? AND session_id = ?
    `).get(tool, sessionId) as any;
    const s = this.db.prepare(
      'SELECT source_created_at, source_updated_at FROM radar_session WHERE tool = ? AND session_id = ?',
    ).get(tool, sessionId) as any;
    if (!s) return 0;
    const rounds = Number(agg?.rounds) || 0;
    const userChars = Number(agg?.userChars) || 0;
    const aiChars = Number(agg?.aiChars) || 0;
    const durationMs = Math.max(0, (s.source_updated_at || 0) - (s.source_created_at || 0));
    let score = 0;
    if (rounds >= 3) score += 1;
    if (rounds >= 10) score += 1;
    if (userChars >= 400) score += 1;
    if (aiChars >= 4000) score += 1;
    if (durationMs >= 10 * 60_000) score += 1;
    return score;
  }

  /** 收口时落价值分（只增不减：会话后续增长只会让分数上升，重复触发无副作用） */
  saveValueScore(tool: string, sessionId: string, score: number): void {
    this.db.prepare(`
      UPDATE radar_session SET value_score = MAX(value_score, ?)
      WHERE tool = ? AND session_id = ?
    `).run(score, tool, sessionId);
  }

  /**
   * 价值分滚动刷新：对全部有内容的会话重算分数，只写变化的行。
   * 价值分是动态的——会话被捡起来续聊后（轮数/字数/时长增长）分数应该跟着涨；
   * 收口时实时算 + 这里定期兜底（启动全量 + 运行中每 10 分钟），三路保证时效。
   * 纯 SQL 聚合，千级会话毫秒级；saveValueScore 用 MAX 保证只增不减。
   */
  refreshValueScores(): number {
    const rows = this.db.prepare(
      'SELECT tool, session_id, value_score, source_created_at, source_updated_at FROM radar_session WHERE message_count > 0',
    ).all() as any[];
    let changed = 0;
    for (const r of rows) {
      try {
        const score = this.computeValueScore(r.tool, r.session_id);
        if (score !== (r.value_score || 0)) { this.saveValueScore(r.tool, r.session_id, score); changed++; }
      } catch { /* 单个失败不影响整体 */ }
    }
    return changed;
  }

  /** AI 摘要写回（worker 写入端专用；summary_msg_count 用于判断会话又长出了多少新内容） */
  saveSummary(tool: string, sessionId: string, summary: string, msgCount: number): void {
    this.db.prepare(`
      UPDATE radar_session SET summary = ?, summary_msg_count = ?, summary_at = ?
      WHERE tool = ? AND session_id = ?
    `).run(summary || '', msgCount || 0, Date.now(), tool, sessionId);
  }

  /** 会话标题写回（worker 写入端专用；摘要驱动的低质标题升级，标题也参与会话级检索） */
  updateTitle(tool: string, sessionId: string, title: string): void {
    this.db.prepare(`UPDATE radar_session SET title = ? WHERE tool = ? AND session_id = ?`)
      .run(String(title || ''), tool, sessionId);
  }

  /**
   * 需要补/重摘的高价值会话（存量补摘要用，最新优先）：没摘要的、
   * 摘要后新内容 ≥4 条的、或源被重采缩水的（摘要比消息还多，摘要是旧素材留底）。
   * 阈值 4 与 radar-digest 的 MIN_NEW_MSGS 对齐；精确过滤在 digestOne 再兜一道。
   * 含冻结会话：冻结只停采集，已采数据摘要照常（否则冻结会话永远补不上摘要）。
   */
  sessionsNeedingSummary(minScore: number, limit = 200): SessionRow[] {
    const rows = this.db.prepare(`
      SELECT *, ${this.stateExpr()} AS effective_state
      FROM radar_session
      WHERE value_score >= ?
        AND (summary = ''
             OR message_count - summary_msg_count >= 4
             OR summary_msg_count > message_count)
      ORDER BY source_updated_at DESC LIMIT ?
    `).all(minScore, Math.min(limit, 500)) as any[];
    return rows.map(rowToSession);
  }

  /** 会话分页列表（按工具筛选 + 最近更新排序） */
  listSessions(opts: { tool?: string; limit?: number; offset?: number }): { total: number; rows: SessionRow[] } {
    const limit = Math.min(Math.max(opts.limit || 50, 1), 200);
    const offset = Math.max(opts.offset || 0, 0);
    const where = opts.tool ? 'WHERE tool = ?' : '';
    const params: any[] = opts.tool ? [opts.tool] : [];
    const total = (this.db.prepare(`SELECT count(*) c FROM radar_session ${where}`).get(...params) as any).c;
    const rows = this.db.prepare(`
      SELECT s.*, ${this.stateExpr('s')} AS effective_state, (
        SELECT count(*) FROM radar_message m WHERE m.tool = s.tool AND m.session_id = s.session_id
      ) AS actual_count
      FROM radar_session s ${where}
      ORDER BY ${this.stateExpr('s')} = 'running' DESC, s.source_updated_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];
    return { total, rows: rows.map(rowToSession) };
  }

  /** 按源会话更新时间范围查询，先过滤再限量；limit=null 返回范围内全部会话 */
  sessionsByRange(start: number, end: number, limit: number | null = 20): { total: number; rows: SessionRow[] } {
    const total = (this.db.prepare(
      'SELECT count(*) c FROM radar_session WHERE source_updated_at >= ? AND source_updated_at < ?',
    ).get(start, end) as any).c;
    const limitClause = limit === null ? '' : 'LIMIT ?';
    const params: any[] = [start, end];
    if (limit !== null) params.push(Math.min(Math.max(limit, 1), 200));
    const rows = this.db.prepare(`
      SELECT s.*, ${this.stateExpr('s')} AS effective_state, (
        SELECT count(*) FROM radar_message m WHERE m.tool = s.tool AND m.session_id = s.session_id
      ) AS actual_count
      FROM radar_session s
      WHERE s.source_updated_at >= ? AND s.source_updated_at < ?
      ORDER BY s.source_updated_at DESC ${limitClause}
    `).all(...params) as any[];
    return { total: Number(total) || 0, rows: rows.map(rowToSession) };
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
               m.ts, s.title, s.project_dir AS projectDir, ${this.stateExpr('s')} AS state
        FROM radar_message m
        LEFT JOIN radar_session s ON s.tool = m.tool AND s.session_id = m.session_id
        WHERE m.content LIKE ? ESCAPE '!' AND m.content <> ''
        ORDER BY m.ts DESC LIMIT ? OFFSET ?
      `).all(`%${this.likeEscape(String(q || ''))}%`, limit, offset) as any[];
      return rows;
    }
    const rows = this.db.prepare(`
      SELECT m.tool, m.session_id AS sessionId, m.seq, m.role, m.content, m.thinking,
             m.ts, s.title, s.project_dir AS projectDir, ${this.stateExpr('s')} AS state,
             bm25(radar_message_fts, 6.0, 1.0) AS score
      FROM radar_message_fts f
      JOIN radar_message m ON m.rowid = f.rowid
      LEFT JOIN radar_session s ON s.tool = m.tool AND s.session_id = m.session_id
      WHERE radar_message_fts MATCH ? AND m.content <> ''
      ORDER BY score ASC, m.ts DESC LIMIT ? OFFSET ?
    `).all(term, limit, offset);
    return rows as any[];
  }

  /**
   * 摘要分页列表（会话档案「摘要」视图）：summary 非空，按提炼时间倒序；
   * 支持工具筛选与「摘要/标题」关键词搜索（LIKE，含 likeEscape 防通配符注入）。
   */
  summariesPage(opts: { tool?: string; q?: string; page?: number; pageSize?: number }): { total: number; rows: SessionRow[] } {
    const page = Math.max(1, Number(opts.page) || 1);
    const pageSize = Math.min(Math.max(Number(opts.pageSize) || 50, 1), 200);
    const conds: string[] = ["summary <> ''"];
    const params: any[] = [];
    if (opts.tool) { conds.push('tool = ?'); params.push(String(opts.tool)); }
    const q = String(opts.q || '').trim();
    if (q) {
      conds.push('(summary LIKE ? OR title LIKE ?)');
      const p = `%${this.likeEscape(q)}%`;
      params.push(p, p);
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    const total = (this.db.prepare(`SELECT count(*) c FROM radar_session ${where}`).get(...params) as any).c;
    const rows = this.db.prepare(`
      SELECT *, ${this.stateExpr()} AS effective_state
      FROM radar_session ${where}
      ORDER BY summary_at DESC, source_updated_at DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as any[];
    return { total: Number(total) || 0, rows: rows.map(rowToSession) };
  }

  /** 会话级检索（摘要注入）：关键词 LIKE 匹配标题/摘要，按命中词数+更新时间排序。
   *  消息级检索的兜底：高频主题词的消息命中被少数会话刷满时，标题/摘要整串命中能直接点名会话。
   *  会话表行数小（千级），LIKE 全表扫描毫秒级，无需 FTS。
   *  含冻结会话：冻结只停采集，已沉淀的标题/摘要照常参与检索。 */
  searchSessionsByText(keywords: string[], limit = 8): any[] {
    const kws = (keywords || []).filter((k) => k && k.length >= 2);
    if (!kws.length) return [];
    const seen = new Map<string, { row: any; hits: number }>();
    for (const kw of kws) {
      const p = `%${this.likeEscape(kw)}%`;
      let rows: any[] = [];
      try {
        rows = this.db.prepare(`
          SELECT tool, session_id AS sessionId, title, project_dir AS projectDir, summary,
                 message_count AS messageCount, source_updated_at AS sourceUpdatedAt
          FROM radar_session WHERE title LIKE ? ESCAPE '!' OR summary LIKE ? ESCAPE '!'
          LIMIT 500
        `).all(p, p) as any[];
      } catch { continue; }
      for (const r of rows) {
        const key = `${r.tool}|${r.sessionId}`;
        const prev = seen.get(key);
        if (prev) prev.hits += 1;
        else seen.set(key, { row: r, hits: 1 });
      }
    }
    return [...seen.values()]
      .sort((a, b) => (b.hits - a.hits) || ((b.row.sourceUpdatedAt || 0) - (a.row.sourceUpdatedAt || 0)))
      .slice(0, limit)
      .map((x) => ({ ...x.row, _hits: x.hits }));
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
    const raw = String(q || '').trim();
    const like = `%${this.likeEscape(raw)}%`;
    // 中文整串往往被拆开使用（搜「打单发货」，正文里是「电子打单」「发货流程」），
    // trigram 短语要求四字连续必然漏检；把 ≥2 字的中文串切成 2 字词，对正文做 LIKE 兜底
    const cjkChars = raw.replace(/[^\u4e00-\u9fa5]/g, '').split('');
    const shingles = new Set<string>();
    if (cjkChars.length >= 2) {
      for (let i = 0; i + 1 < cjkChars.length; i += 2) shingles.add(cjkChars[i] + cjkChars[i + 1]);
      if (cjkChars.length % 2 === 1) shingles.add(cjkChars[cjkChars.length - 2] + cjkChars[cjkChars.length - 1]);
    }
    const likeConds = [like, ...[...shingles].map((s) => `%${this.likeEscape(s)}%`)];

    if (term) {
      const rows = this.db.prepare(`
      WITH hits AS (
        -- 注意：bm25() 在 CTE/子查询里会报 "unable to use function bm25"，
        -- 只能用等价的 rank 隐藏列（SQLite 辅助函数仅允许出现在最外层 MATCH 查询）
        SELECT m.tool AS tool, m.session_id AS sid, rank AS score
        FROM radar_message_fts f
        JOIN radar_message m ON m.rowid = f.rowid
        WHERE radar_message_fts MATCH ?
      ),
      ms AS (
        SELECT tool, sid, MIN(score) AS score FROM hits GROUP BY tool, sid
      ),
      ls AS (
        SELECT tool, session_id AS sid
        FROM radar_message
        WHERE ${likeConds.map(() => 'content LIKE ?').join(' OR ')}
        GROUP BY tool, session_id
      )
      SELECT s.*, ${this.stateExpr('s')} AS effective_state, (
        SELECT count(*) FROM radar_message m WHERE m.tool = s.tool AND m.session_id = s.session_id
      ) AS actual_count
      FROM radar_session s
      LEFT JOIN ms ON ms.tool = s.tool AND ms.sid = s.session_id
      LEFT JOIN ls ON ls.tool = s.tool AND ls.sid = s.session_id
      WHERE (s.title LIKE ? OR LOWER(s.project_dir) = LOWER(?) OR s.session_id LIKE ?)
         OR ms.tool IS NOT NULL
         OR ls.tool IS NOT NULL
      ORDER BY CASE WHEN s.title LIKE ? THEN 0 WHEN ms.score IS NOT NULL THEN 1 WHEN ls.tool IS NOT NULL THEN 2 ELSE 3 END,
               ms.score, s.synced_at DESC LIMIT ? OFFSET 0
    `).all(term, ...likeConds, like, raw, like, like, limit);
      return (rows as any[]).map(rowToSession);
    }
    // 不足 3 字（如 2 字中文词）trigram 无从匹配：标题/路径 LIKE + 正文 2 字词 LIKE
    const rows = this.db.prepare(`
      WITH ls AS (
        SELECT tool, session_id AS sid
        FROM radar_message
        WHERE ${likeConds.map(() => 'content LIKE ?').join(' OR ')}
        GROUP BY tool, session_id
      )
      SELECT s.*, ${this.stateExpr('s')} AS effective_state, (
        SELECT count(*) FROM radar_message m WHERE m.tool = s.tool AND m.session_id = s.session_id
      ) AS actual_count
      FROM radar_session s
      LEFT JOIN ls ON ls.tool = s.tool AND ls.sid = s.session_id
      WHERE s.title LIKE ? OR LOWER(s.project_dir) = LOWER(?) OR s.session_id LIKE ?
         OR ls.tool IS NOT NULL
      ORDER BY CASE WHEN s.title LIKE ? THEN 0 WHEN ls.tool IS NOT NULL THEN 1 ELSE 2 END,
               s.synced_at DESC LIMIT ? OFFSET 0
    `).all(...likeConds, like, raw, like, like, limit);
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
    const r = this.db.prepare(`SELECT count(*) c FROM radar_session WHERE ${this.stateExpr()} = 'running'`).get() as any;
    // 今日活跃按会话在源工具里的最近活动时间算；synced_at 只代表雷达同步过，扫描即刷新，不能反映活跃
    const a = this.db.prepare('SELECT count(*) c FROM radar_session WHERE source_updated_at >= ?').get(dayStart) as any;
    return { sessions: s.c, messages: m.c, running: r.c, activeToday: a.c };
  }

  /** 各工具统计（雷达页工具卡片用） */
  toolStats(): { tool: string; sessions: number; running: number; lastActivity: number }[] {
    const rows = this.db.prepare(`
      SELECT tool,
             count(*) AS sessions,
             SUM(CASE WHEN ${this.stateExpr()} = 'running' THEN 1 ELSE 0 END) AS running,
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
             SUM(CASE WHEN ${this.stateExpr()} = 'running' THEN 1 ELSE 0 END) AS running,
             MAX(source_updated_at) AS lastActivity
      FROM radar_session GROUP BY tool
    `).all() as any[];
    const lastRows = this.db.prepare(`
      SELECT tool, session_id, title, project_dir, source_updated_at, ${this.stateExpr()} AS state
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
      SELECT s.*, ${this.stateExpr('s')} AS effective_state, (
        SELECT count(*) FROM radar_message m WHERE m.tool = s.tool AND m.session_id = s.session_id
      ) AS actual_count
      FROM radar_session s
      ORDER BY ${this.stateExpr('s')} = 'running' DESC, s.source_updated_at DESC LIMIT ?
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
    // 读路径带出防僵尸投影（effective_state）；worker 内部写入路径无该列，回退原始 state
    state: r.effective_state ?? r.state, stateChangedAt: r.state_changed_at, frozen: r.frozen,
    frozenReason: r.frozen_reason, missingSince: r.missing_since,
    valueScore: r.value_score ?? 0, summary: r.summary || '',
    summaryMsgCount: r.summary_msg_count ?? 0, summaryAt: r.summary_at ?? 0,
  };
}
