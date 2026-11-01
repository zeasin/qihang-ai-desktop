import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteReadonly } from '../sqlite-open';
import type { HubCollector, ProbeSignal, SerializedMessage, SessionInfo } from '../types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-ZCODE]', msg, ...args);

/** 僵死回合兜底：硬运行（有 running part）超过该时长无任何写入视为已死（ZCode 硬崩来不及写 cancelled） */
const RUNNING_BACKSTOP_MS = 30 * 60_000;
/** 模糊运行兜底：T_write > 回合结束时间但没有 running part（新回合刚开始，或回合结束后的 title 异步写入），
 *  写入冻结超过该时长按空闲处理。真回合的写入（reasoning/工具流式落库）远比这频繁。 */
const AMBIGUOUS_STALE_MS = 90_000;

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
  /** 模糊态记忆：T_write > 回合结束时间但没有 running part 的会话，记录写入冻结起点（90s 判定用） */
  private probeMemo = new Map<string, { tWrite: number; ambSince: number }>();

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

  /** 轻探针 v2：会话心跳 + 精确回合状态。
   *  turn_usage 由 ZCode 在回合结束时落库（running/completed/error/cancelled），是权威的「回合已结束」信号：
   *  - time_updated ≤ 最近回合结束时间 → 回合已结束，实报 idle（秒级，短任务不再挂 3 分钟）
   *  - time_updated > 回合结束时间 → 有新回合在进行，实报 running：
   *    · 存在 time_created > 回合结束时间的 running 状态 tool part → 长工具执行中，任意时长都可信（30 分钟兜底）
   *    · 否则为模糊态（新回合刚开始 / 回合结束后的 title 异步写入）→ 写入冻结超 90s 按空闲处理
   *  仅当会话完全没有回合行（老版本库）时退回时间窗口推断。 */
  async probe(): Promise<Map<string, ProbeSignal>> {
    const db = await this.ensureDb();
    const out = new Map<string, ProbeSignal>();
    if (!db) return out;
    try {
      const now = Date.now();
      const cutoff = now - 30 * 60_000; // 覆盖长工具静默期（配合僵死兜底，探针窗口放宽到 30 分钟）
      const rows = db.prepare(
        `SELECT s.id, s.time_updated,
                (SELECT t.status       FROM turn_usage t WHERE t.session_id = s.id ORDER BY t.started_at DESC, t.rowid DESC LIMIT 1) AS turn_status,
                (SELECT t.completed_at FROM turn_usage t WHERE t.session_id = s.id ORDER BY t.started_at DESC, t.rowid DESC LIMIT 1) AS turn_completed_at
         FROM session s
         WHERE s.time_deleted IS NULL AND s.time_updated > ?`,
      ).all(cutoff) as any[];
      const seen = new Set<string>();
      for (const r of rows) {
        const id = String(r.id);
        const ts = Number(r.time_updated) || 0;
        seen.add(id);
        if (r.turn_status == null) {
          // 无回合数据：老版本库，退回时间窗口推断
          if (ts > now - 10 * 60_000) out.set(id, { ts });
          continue;
        }
        const turnEnd = Math.max(Number(r.turn_completed_at) || 0, 0);
        if (r.turn_status === 'running') {
          // 未来兼容：若 ZCode 改为回合开始即落库，直接信任（同样受 30 分钟兜底）
          out.set(id, { ts, running: now - ts <= RUNNING_BACKSTOP_MS });
          this.probeMemo.delete(id);
          continue;
        }
        if (ts <= turnEnd) {
          // 所有写入都属于已结束的回合 → 精确空闲
          out.set(id, { ts, running: false });
          this.probeMemo.delete(id);
          continue;
        }
        // 有晚于回合结束的写入：新回合进行中，或回合结束后的尾部写入（title 生成等）
        let running: boolean;
        if (now - ts > RUNNING_BACKSTOP_MS) {
          running = false; // 僵死兜底
        } else if (this.hasRunningPart(db, id, turnEnd)) {
          running = true; // 长工具执行中（running part 存在即硬证据）
          this.probeMemo.delete(id);
        } else {
          const memo = this.probeMemo.get(id);
          if (memo && memo.tWrite === ts) {
            running = now - memo.ambSince <= AMBIGUOUS_STALE_MS; // 写入冻结 → 90s 后按空闲
          } else {
            this.probeMemo.set(id, { tWrite: ts, ambSince: now });
            running = true; // 写入在推进 → 活跃
          }
        }
        out.set(id, { ts, running });
      }
      // 清理不再活跃的会话 memo，防泄漏
      for (const id of this.probeMemo.keys()) {
        if (!seen.has(id)) this.probeMemo.delete(id);
      }
    } catch (e) {
      LOG('probe error:', e);
    }
    return out;
  }

  /** 是否存在「晚于上一回合结束时间」创建、仍是 running 状态的 tool part（长工具执行的硬证据） */
  private hasRunningPart(db: DatabaseSync, sessionId: string, turnEnd: number): boolean {
    try {
      const row = db.prepare(
        `SELECT EXISTS(
           SELECT 1 FROM part p
           WHERE p.session_id = ? AND p.time_created > ?
             AND json_extract(p.data, '$.type') = 'tool'
             AND json_extract(p.data, '$.state.status') = 'running'
         ) AS alive`,
      ).get(sessionId, turnEnd) as any;
      return !!row?.alive;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    try { this.db?.close(); } catch {}
    this.db = null;
  }
}
