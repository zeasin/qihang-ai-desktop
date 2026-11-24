import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteReadonly } from '../sqlite-open';
import type { HubCollector, ProbeSignal, SerializedMessage, SessionInfo } from '../types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-MCODE]', msg, ...args);

/**
 * MiniMax Code（mcode）采集器：双源读取。
 *
 * - 元数据与运行态：~/.minimax/v2/sqlite/runtime-state.sqlite 的 local_runtime_sessions
 *   （title / project_workspace_dir / updated_at_ms / status 全在这里）
 * - 会话正文：~/.minimax/v2/sessions/<history_relative_dir>/messages.jsonl
 *   （与 pi 的 jsonl 同构：thinking / text / toolCall / toolResult）
 *
 * 两点必须注意：
 * 1. mcode 把运行时提示（system-reminder 等）塞进 user 消息，实测占 user 文本 79.7%，
 *    不过滤会污染关键词检索，也会让简报复读提示词 → 只剥离已知标签白名单，
 *    不做通用 XML 正则（用户正文里可能合法包含 <svg>/<path> 等标签）。
 * 2. status='started' 是 mcode 自己的回合状态机，但进程崩溃时会永远停在 started，
 *    必须加超时兜底，否则雷达会一直显示「运行中」。
 */

/** 运行时根目录（MiniMax Code 的 activeDataDir） */
function mcodeRoot(): string {
  return path.join(os.homedir(), '.minimax');
}

/** 会话状态库（元数据 + 运行态） */
function stateDbPath(): string {
  return path.join(mcodeRoot(), 'v2', 'sqlite', 'runtime-state.sqlite');
}

/** 会话文件根目录（v2 dated 布局：YYYY/MM/DD/<时间戳>-session_<base64(sessionId)>） */
function sessionsRoot(): string {
  return path.join(mcodeRoot(), 'v2', 'sessions');
}

/** status='started' 且长时间没有写入 → 视为回合已死（进程崩溃残留），不再报运行中 */
const RUNNING_STALE_MS = 20 * 60_000;

/**
 * 系统提示噪声标签白名单。
 * 实测分布：system-reminder 107 / background-task-finished 58 / agent-context 46 /
 * mcode-tools-master-reminder 46 / async-audit 20 / media-output-reminder 14 / ask-user-guidance 11。
 * 全部为成对闭合标签（实测 246 对、0 个未闭合）。
 */
const NOISE_TAGS = [
  'system-reminder',
  'agent-context',
  'async-audit',
  'media-output-reminder',
  'mcode-tools-master-reminder',
  'ask-user-guidance',
  'background-task-finished',
  'bootstrap_check',
  'available_skills',
  'permissions',
  'env',
];

const NOISE_PAIR_RE = new RegExp(`<(${NOISE_TAGS.join('|')})>[\\s\\S]*?</\\1>`, 'g');

/** 剥离系统提示噪声；未闭合的噪声块按「起点在文首则截断到文末」处理 */
export function stripNoise(text: string): string {
  if (!text) return '';
  let out = text.replace(NOISE_PAIR_RE, '');
  for (const tag of NOISE_TAGS) {
    const open = `<${tag}>`;
    const idx = out.indexOf(open);
    if (idx < 0) continue;
    if (out.slice(0, idx).trim() === '') out = out.slice(0, idx);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** content 可能是字符串，也可能是内容块数组；统一取纯文本 */
function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === 'string') { parts.push(c); continue; }
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join('\n');
}

/** content 统一成内容块数组 */
function blocksOf(content: any): any[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? content.filter((c: any) => c && typeof c === 'object') : [];
}

export class McodeCollector implements HubCollector {
  readonly tool = 'mcode';

  /** sessionId → 会话目录（sqlite 缺 history_relative_dir 时的兜底索引） */
  private dirIndex: Map<string, string> | null = null;

  // ---------- 元数据 ----------

  /** 打开状态库；表不存在/打开失败返回 null（降级到文件层） */
  private openStateDb(): DatabaseSync | null {
    const dbPath = stateDbPath();
    if (!existsSync(dbPath)) return null;
    try {
      return openSqliteReadonly(dbPath, 'RADAR-MCODE');
    } catch (e: any) {
      LOG('state db open failed:', String(e?.message || e).slice(0, 160));
      return null;
    }
  }

  /** 读会话元数据行；表结构变化时返回 null 而不是抛错 */
  private readSessionRows(): any[] | null {
    const db = this.openStateDb();
    if (!db) return null;
    try {
      const hasTable = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_runtime_sessions'`,
      ).get();
      if (!hasTable) {
        LOG('local_runtime_sessions not found, fall back to file layer');
        return null;
      }
      return db.prepare(
        `SELECT session_id, title, project_workspace_dir, workspace_dir,
                created_at_ms, updated_at_ms, status, history_relative_dir
         FROM local_runtime_sessions
         WHERE IFNULL(archived, 0) = 0 AND IFNULL(visibility, 'visible') = 'visible'
         ORDER BY updated_at_ms DESC LIMIT 5000`,
      ).all() as any[];
    } catch (e: any) {
      LOG('readSessionRows failed:', String(e?.message || e).slice(0, 200));
      return null;
    } finally {
      try { db.close(); } catch {}
    }
  }

  /** 会话目录索引：扫描 sessions 根目录，用 manifest.json 的 sessionId 建索引 */
  private ensureDirIndex(): Map<string, string> {
    if (this.dirIndex) return this.dirIndex;
    const idx = new Map<string, string>();
    const root = sessionsRoot();
    const visit = (dir: string, depth: number) => {
      if (depth > 5) return;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      let isSessionDir = false;
      for (const e of entries) {
        if (e.isDirectory()) {
          visit(path.join(dir, e.name), depth + 1);
        } else if (e.name === 'manifest.json') {
          isSessionDir = true;
        }
      }
      if (!isSessionDir) return;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
        const sid = String(manifest.sessionId || '');
        if (sid) idx.set(sid, dir);
      } catch { /* manifest 损坏：跳过该目录 */ }
    };
    visit(root, 0);
    this.dirIndex = idx;
    return idx;
  }

  /** 定位会话目录：优先用库里的 history_relative_dir，其次查索引 */
  private sessionDir(sessionId: string, historyRelativeDir: any): string {
    const rel = String(historyRelativeDir || '');
    if (rel) {
      const dir = path.join(sessionsRoot(), rel);
      try { if (fs.existsSync(dir)) return dir; } catch {}
    }
    const hit = this.ensureDirIndex().get(sessionId);
    if (hit) return hit;
    // 索引可能是旧的（会话刚建），重建一次再试
    this.dirIndex = null;
    return this.ensureDirIndex().get(sessionId) || '';
  }

  private rowToSession(r: any): SessionInfo {
    const id = String(r.session_id || '');
    const dir = this.sessionDir(id, r.history_relative_dir);
    const createdMs = Number(r.created_at_ms) || 0;
    const updatedMs = Number(r.updated_at_ms) || 0;
    return {
      id,
      label: String(r.title || ''),
      file: dir ? path.join(dir, 'messages.jsonl') : '',
      messageCount: 0,
      createdAt: createdMs ? new Date(createdMs).toISOString() : new Date().toISOString(),
      updatedAt: updatedMs ? new Date(updatedMs).toISOString() : new Date().toISOString(),
      projectDir: String(r.project_workspace_dir || r.workspace_dir || ''),
    };
  }

  /** 兜底：库不可用时从文件层枚举（只有时间戳，没有标题与项目目录） */
  private listFromFiles(): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const [sid, dir] of this.ensureDirIndex()) {
      let manifest: any = {};
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
      } catch { continue; }
      const createdMs = Number(manifest.createdAtMs) || 0;
      const updatedMs = Number(manifest.updatedAtMs) || createdMs;
      out.push({
        id: sid,
        label: '',
        file: path.join(dir, 'messages.jsonl'),
        messageCount: 0,
        createdAt: createdMs ? new Date(createdMs).toISOString() : new Date().toISOString(),
        updatedAt: updatedMs ? new Date(updatedMs).toISOString() : new Date().toISOString(),
        projectDir: '',
      });
    }
    return out;
  }

  async listAll(): Promise<SessionInfo[]> {
    const rows = this.readSessionRows();
    if (!rows) return this.listFromFiles();
    return rows.map((r) => this.rowToSession(r));
  }

  // ---------- 正文 ----------

  async loadMessages(session: SessionInfo): Promise<SerializedMessage[]> {
    const file = session.file;
    if (!file || !existsSync(file)) return [];
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (e: any) {
      LOG('loadMessages read failed:', String(e?.message || e).slice(0, 160));
      return [];
    }

    const out: SerializedMessage[] = [];
    /** toolCallId → { 消息下标, 工具下标 }：工具结果可能出现在后续消息里 */
    const pending = new Map<string, { msg: number; tool: number }>();

    for (const line of raw.split('\n')) {
      if (!line) continue;
      let evt: any;
      try { evt = JSON.parse(line); } catch { continue; }
      const m = evt?.message;
      if (!m || typeof m !== 'object') continue;
      const role = String(m.role || '');
      const ts = Number(m.timestamp) || Date.now();

      if (role === 'user') {
        const text = stripNoise(textOf(m.content));
        if (!text) continue;
        out.push({ role: 'user', content: text, timestamp: ts });
        continue;
      }

      if (role === 'assistant') {
        const blocks = blocksOf(m.content);
        const texts: string[] = [];
        const thinkingParts: string[] = [];
        const toolCalls: any[] = [];
        for (const b of blocks) {
          if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
          else if (b.type === 'thinking' && typeof b.thinking === 'string') thinkingParts.push(b.thinking);
          else if (b.type === 'toolCall') toolCalls.push(b);
        }
        const tools: NonNullable<SerializedMessage['tools']> = toolCalls.map((tc) => ({
          name: String(tc.name || ''),
          args: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
          result: '',
          status: 'running',
        }));
        const msgIdx = out.length;
        toolCalls.forEach((tc, i) => {
          const id = String(tc.id || '');
          if (id) pending.set(id, { msg: msgIdx, tool: i });
        });
        const thinking = thinkingParts.join('\n');
        const content = texts.join('\n');
        if (!content && !thinking && !tools.length) continue;
        out.push({
          role: 'assistant',
          content,
          thinking: thinking || undefined,
          tools: tools.length ? tools : undefined,
          timestamp: ts,
        });
        continue;
      }

      if (role === 'toolResult') {
        const id = String(m.toolCallId || '');
        const hit = id ? pending.get(id) : undefined;
        if (!hit) continue;
        const target = out[hit.msg];
        if (!target || !target.tools) continue;
        const tool = target.tools[hit.tool];
        if (!tool) continue;
        tool.result = textOf(m.content);
        tool.status = m.isError ? 'error' : 'done';
        pending.delete(id);
        continue;
      }

      if (role === 'compactionSummary') {
        // 上下文压缩摘要：模型当时看到的真实内容，值得进雷达
        const summary = String(m.summary || '').trim();
        if (!summary) continue;
        out.push({ role: 'assistant', content: summary, timestamp: ts });
        continue;
      }

      if (role === 'custom') {
        // 运行时自定义提醒（todo 节奏提醒等）：剥掉噪声后还有内容才留
        const text = stripNoise(textOf(m.content));
        if (!text) continue;
        out.push({ role: 'assistant', content: text, timestamp: ts });
        continue;
      }
    }

    // 未收到结果的工具调用保持 running 会误导，改为 done 并注明未回填
    for (const [, hit] of pending) {
      const target = out[hit.msg];
      const tool = target?.tools?.[hit.tool];
      if (tool && tool.status === 'running') tool.status = 'done';
    }

    return out;
  }

  // ---------- 探针 ----------

  /**
   * 轻探针：只读元数据（不解析正文）。
   * mcode 的 status 是源工具自己的回合状态机 → 可精确报 running/idle；
   * 但进程崩溃时 status 会残留为 started，用写入时间超时兜底翻转。
   */
  async probe(): Promise<Map<string, ProbeSignal>> {
    const out = new Map<string, ProbeSignal>();
    const db = this.openStateDb();
    if (db) {
      try {
        const hasTable = db.prepare(
          `SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_runtime_sessions'`,
        ).get();
        if (hasTable) {
          const rows = db.prepare(
            `SELECT session_id, updated_at_ms, status FROM local_runtime_sessions
             WHERE IFNULL(archived, 0) = 0 AND IFNULL(visibility, 'visible') = 'visible'
             ORDER BY updated_at_ms DESC LIMIT 5000`,
          ).all() as any[];
          const now = Date.now();
          for (const r of rows) {
            const id = String(r.session_id || '');
            if (!id) continue;
            const ts = Number(r.updated_at_ms) || 0;
            const started = String(r.status || '') === 'started';
            const alive = ts > 0 && now - ts <= RUNNING_STALE_MS;
            out.set(id, { ts, running: started && alive });
          }
          return out;
        }
      } catch (e: any) {
        LOG('probe failed:', String(e?.message || e).slice(0, 160));
      } finally {
        try { db.close(); } catch {}
      }
    }

    // 兜底：文件 mtime 推断（没有精确状态）
    const cutoff = Date.now() - 10 * 60_000;
    for (const [sid, dir] of this.ensureDirIndex()) {
      const file = path.join(dir, 'messages.jsonl');
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs <= cutoff) continue;
        out.set(sid, { ts: st.mtimeMs });
      } catch { /* 文件可能正被写或已删 */ }
    }
    return out;
  }

  async dispose(): Promise<void> {
    this.dirIndex = null;
  }
}
