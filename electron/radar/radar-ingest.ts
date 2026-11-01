/**
 * 雷达 ingest 引擎：源 → 本地 SQLite 正本。
 * 语义与 v2 HubSync 一致（指纹对比 + seq 增量 + delta/full 两态 + 冻结/排除成本开关）。
 * 本地库是唯一正本、唯一权威游标（同事务随数据前进，崩溃安全）。
 * 与实时监控通道完全独立（monitor loop 不依赖本引擎节奏）。
 */
import fs from 'node:fs';
import { RadarDb } from './radar-db';
import { FingerprintStore } from './fingerprint-store';
import { isExcluded, radarStatusFile, type RadarConfig } from './radar-config';
import type { HubCollector, SerializedMessage, SessionInfo } from './types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-INGEST]', msg, ...args);
const MAX_CONTENT = 200 * 1024;
const MAX_TOOL_FIELD = 2 * 1024;

export interface ToolStat {
  tool: string;
  listed: number;
  excluded: number;
  written: number;
  missing: number;
  autoFrozen: number;
  error: string;
}

export interface RoundStat {
  startedAt: number;
  finishedAt: number;
  reason: string;
  tools: ToolStat[];
}

/**
 * ingest loop（默认 60s；monitor 探到 dirty 可提前触发）。
 * 每轮：全量列举 → 元数据 upsert → 指纹对比变更的会话按 seq 增量写本地
 * → 源库消失打标 → 自动老化冻结。指纹只在本地写入成功后前进。
 */
export class RadarIngestLoop {
  private running = false;
  private started = false;
  private roundTimer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private lastRound: RoundStat | null = null;
  private lastRoundEnd = 0;
  private dirtyTimer: NodeJS.Timeout | null = null;
  /** 每轮结束回调（工作线程上报用） */
  onRound: ((stat: RoundStat) => void) | null = null;

  constructor(
    private readonly db: RadarDb,
    private readonly fingerprints: FingerprintStore,
    private readonly collectors: HubCollector[],
    private readonly cfg: RadarConfig,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.firstTimer = setTimeout(() => { void this.syncNow('first'); }, 15_000);
    this.roundTimer = setInterval(() => { void this.syncNow('interval'); }, this.cfg.syncIntervalMs);
    LOG(`scheduler started (first round in 15s, then every ${this.cfg.syncIntervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.roundTimer) clearInterval(this.roundTimer);
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.firstTimer = this.roundTimer = this.dirtyTimer = null;
    this.started = false;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** monitor 探到源库变化时提前触发（防抖：15s 内不重复），不阻塞监控 */
  markDirty(tool: string): void {
    if (!this.started || this.running) return;
    if (Date.now() - this.lastRoundEnd < 15_000) return;
    if (this.dirtyTimer) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      void this.syncNow(`dirty:${tool}`);
    }, 2_000);
  }

  /** 手动触发一轮 */
  async syncNow(reason = 'manual'): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await this.runRound(reason);
    } catch (e: any) {
      LOG('round error:', String(e?.message || e));
    } finally {
      this.running = false;
      this.lastRoundEnd = Date.now();
    }
    return true;
  }

  get lastRoundStat(): RoundStat | null {
    return this.lastRound;
  }

  private async runRound(reason: string): Promise<void> {
    const startedAt = Date.now();
    const stats: ToolStat[] = [];
    this.lastRound = { startedAt, finishedAt: startedAt, reason, tools: stats };

    const frozenSet = this.db.frozenIds();

    for (const collector of this.collectors) {
      const stat: ToolStat = { tool: collector.tool, listed: 0, excluded: 0, written: 0, missing: 0, autoFrozen: 0, error: '' };
      stats.push(stat);
      try {
        const listed = await collector.listAll();
        const sessions = listed
          .filter((s) => !!s.id)
          .map((info) => ({
            info,
            updatedAtMs: Date.parse(info.updatedAt || info.createdAt) || 0,
            excluded: isExcluded(info.projectDir || '', this.cfg.excludeProjects),
          }));
        stat.listed = sessions.length;
        stat.excluded = sessions.filter((s) => s.excluded).length;

        // 1) 元数据 upsert（排除的目录不采集）
        const metas = sessions
          .filter((s) => !s.excluded)
          .map((s) => ({
            tool: collector.tool,
            sessionId: s.info.id,
            projectDir: s.info.projectDir || '',
            title: s.info.label || '',
            messageCount: s.info.messageCount || 0,
            sourceUpdatedAt: s.updatedAtMs,
            sourceCreatedAt: Date.parse(s.info.createdAt) || 0,
          }));
        this.db.upsertSessionMeta(metas);

        // 2) 变更检测 → delta/full 写本地（冻结/排除的跳过）；会话间让出事件循环，避免长同步解析饿死同线程的探针/消息
        let writeErrors = 0;
        let firstError = '';
        for (const s of sessions) {
          if (s.excluded || frozenSet.has(`${collector.tool}/${s.info.id}`)) continue;
          try {
            const outcome = await this.syncSession(collector, s.info, s.updatedAtMs);
            if (outcome === 'written') stat.written += 1;
          } catch (e: any) {
            writeErrors += 1;
            if (!firstError) firstError = `${s.info.id.slice(0, 24)}: ${String(e?.message || e).slice(0, 160)}`;
            LOG(`${collector.tool}/${s.info.id} ingest failed:`, String(e?.message || e).slice(0, 120));
          }
          await new Promise((r) => setImmediate(r));
        }
        if (writeErrors) stat.error = `${writeErrors} 个会话写库失败; 首个: ${firstError}`;

        // 3) 源库消失检测：采集过但本轮没列到的（排除的也参与消失判定）
        const listedIds = new Set(sessions.map((s) => s.info.id));
        const missing = [...this.fingerprints.ids(collector.tool)].filter((id) => !listedIds.has(id));
        if (missing.length) {
          this.db.markMissing(collector.tool, missing);
          stat.missing = missing.length;
        }

        // 4) 自动老化：已采集、非冻结、超过 N 天没动静 → 冻结（0 = 关闭）
        if (this.cfg.autoFreezeDays > 0) {
          const cutoff = Date.now() - this.cfg.autoFreezeDays * 86_400_000;
          const stale = sessions
            .filter((s) => !s.excluded
              && s.updatedAtMs > 0
              && s.updatedAtMs < cutoff
              && !frozenSet.has(`${collector.tool}/${s.info.id}`)
              && this.fingerprints.get(collector.tool, s.info.id))
            .map((s) => s.info.id);
          if (stale.length) {
            this.db.setFrozen(collector.tool, stale, true, 'auto-age');
            stat.autoFrozen = stale.length;
          }
        }
      } catch (e: any) {
        stat.error = String(e?.message || e).slice(0, 200);
        LOG(`${collector.tool} round error:`, stat.error);
      }
    }

    this.finishRound();
    LOG(`round(${reason}) done:`, JSON.stringify(stats));
  }

  private finishRound(): void {
    if (this.lastRound) {
      this.lastRound.finishedAt = Date.now();
      try {
        fs.writeFileSync(radarStatusFile(), JSON.stringify(this.lastRound, null, 2), 'utf-8');
      } catch { /* 状态文件写失败无所谓 */ }
      try { this.onRound?.(this.lastRound); } catch { /* 回调异常不影响采集 */ }
    }
  }

  /** 单会话增量决策与写库，返回写入结果 */
  private async syncSession(
    collector: HubCollector,
    info: SessionInfo,
    updatedAtMs: number,
  ): Promise<'written' | 'skipped'> {
    const tool = collector.tool;
    const sessionId = info.id;

    // 本地指纹优先；指纹丢失时凭本地权威游标续传
    let fp = this.fingerprints.get(tool, sessionId);
    if (!fp) {
      const local = this.db.sessionState(tool, sessionId);
      if (local && local.lastSyncedSeq > 0) {
        fp = { sourceUpdatedAt: local.sourceUpdatedAt, messageCount: local.messageCount, lastSyncedSeq: local.lastSyncedSeq };
      }
    }

    let messages: SerializedMessage[] | null = null;
    const load = async (): Promise<SerializedMessage[]> => {
      if (!messages) messages = await collector.loadMessages(info);
      return messages!;
    };

    const advance = (syncedSeq: number, totalCount: number) => {
      this.fingerprints.set(tool, sessionId, {
        sourceUpdatedAt: updatedAtMs, messageCount: totalCount, lastSyncedSeq: syncedSeq,
      });
    };

    // 源更新时间没变（且已有指纹）→ 跳过；本地指纹丢失时用本地游标兜底续传
    if (fp && updatedAtMs === fp.sourceUpdatedAt) return 'skipped';

    let mode: 'delta' | 'full';
    let fromSeq = 0;
    if (!fp) {
      mode = 'full';
    } else if (fp.lastSyncedSeq > 0 && fp.messageCount > 0) {
      const localSeq = this.db.sessionState(tool, sessionId)?.lastSyncedSeq ?? fp.lastSyncedSeq;
      const loaded = await load();
      const totalCount = normalizedCount(loaded);
      if (totalCount < fp.messageCount) {
        mode = 'full';
      } else if (totalCount > Math.max(fp.messageCount, localSeq)) {
        mode = 'delta';
        fromSeq = localSeq;
      } else {
        mode = 'full';
      }
    } else {
      mode = 'full';
    }

    const loaded = await load();
    const pack = buildPack(info, loaded, updatedAtMs, mode, fromSeq);
    this.db.applyMessages({
      tool,
      sessionId: pack.sessionId,
      projectDir: pack.projectDir,
      title: pack.title,
      mode: pack.mode,
      lastSyncedSeq: pack.lastSyncedSeq ?? 0,
      messageCount: pack.messageCount ?? 0,
      sourceUpdatedAt: pack.sourceUpdatedAt ?? 0,
      sourceCreatedAt: pack.sourceCreatedAt ?? 0,
      messages: pack.messages,
    });
    advance(pack.lastSyncedSeq ?? 0, pack.messageCount ?? 0);
    return 'written';
  }
}

function normalizedCount(messages: SerializedMessage[]): number {
  return messages.filter((m) => m.content || m.thinking || m.tools?.length).length;
}

/** 截断后组装写库包；seq 在过滤空消息后按序编号（与全部解析结果一致，delta 靠它对齐） */
function buildPack(
  s: SessionInfo,
  messages: SerializedMessage[],
  updatedAtMs: number,
  mode: 'delta' | 'full',
  fromSeq: number,
) {
  const all = messages
    .map((m, i) => ({
      seq: i + 1,
      role: m.role,
      content: truncate(m.content, MAX_CONTENT),
      thinking: truncate(m.thinking, MAX_CONTENT),
      toolsJson: m.tools?.length
        ? JSON.stringify(m.tools.map((t) => ({
            name: t.name || '',
            args: truncate(t.args, MAX_TOOL_FIELD),
            result: truncate(t.result, MAX_TOOL_FIELD),
            status: t.status || '',
          })))
        : '',
      ts: m.timestamp,
    }))
    .filter((m) => m.content || m.thinking || m.toolsJson);
  const selected = mode === 'delta' ? all.filter((m) => m.seq > fromSeq) : all;
  const maxSeq = all.length ? all[all.length - 1].seq : 0;
  return {
    sessionId: s.id,
    projectDir: s.projectDir || '',
    title: s.label || '',
    messageCount: all.length,
    sourceUpdatedAt: updatedAtMs,
    sourceCreatedAt: Date.parse(s.createdAt) || 0,
    mode,
    lastSyncedSeq: maxSeq,
    messages: selected,
  };
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max);
}
