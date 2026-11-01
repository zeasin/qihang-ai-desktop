import { RadarDb } from './radar-db';
import type { RadarConfig } from './radar-config';
import type { HubCollector, ProbeSignal } from './types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-MONITOR]', msg, ...args);

export interface StateEvent {
  tool: string;
  sessionId: string;
  state: 'running' | 'idle';
  ts: number;
}

interface RunningSession {
  tool: string;
  sessionId: string;
  lastActivity: number;
  /** 探针实报的精确运行中（running=true）。collector 保证僵死回合会在有限时间内翻转为 false */
  exact?: boolean;
  /** 精确运行期间最后一次源库写入（监控侧兜底判定用） */
  lastWrite?: number;
}

/** 精确运行的监控侧兜底：collector 30 分钟翻转，这里 45 分钟纯保险（探针持续报错等异常场景） */
const EXACT_BACKSTOP_MS = 45 * 60_000;

/**
 * 实时监控通道：每 monitorIntervalMs（默认 3s）跑一轮轻探针，
 * diff 出会话状态跃迁（running/idle）→ 订阅者扇出（渲染层推送等）+ 落本地 radar_state_event + 会话 state 投影。
 * 探针只读元数据（mtime/回合状态），不解析消息正文——这是实时性与成本的全部保障。
 * 有精确信号的会话（如 ZCode turn_usage）秒级跃迁；没有的退回「activeWindow 内有写入=运行，超时归位」推断。
 */
export class RadarMonitorLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = new Map<string, RunningSession>();
  private ticking = false;
  private startedAt = Date.now();
  private readonly subs = new Set<(events: StateEvent[]) => void>();

  constructor(
    private readonly db: RadarDb,
    private readonly collectors: HubCollector[],
    private readonly cfg: RadarConfig,
    private readonly onDirty: (tool: string) => void,
  ) {}

  /** 订阅状态跃迁（外部监听：渲染层推送等） */
  onStateEvents(fn: (events: StateEvent[]) => void): void {
    this.subs.add(fn);
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    // 先清扫上次运行留下的僵尸 running（worker 中途挂掉没来得及转 idle 的），再预置本次 running：
    try {
      const swept = this.db.sweepStaleRunning(this.cfg.idleTimeoutMs);
      if (swept) LOG(`swept ${swept} stale running session(s) to idle`);
    } catch (e: any) {
      LOG('sweep stale running failed:', String(e?.message || e).slice(0, 120));
    }
    // 预置上次运行留下的 running 会话：重启不重复发「开始运行」；
    // 若 3 分钟内探针见不到新活动，会自然转入空闲
    try {
      for (const s of this.db.runningSessionIds()) {
        this.running.set(`${s.tool}/${s.sessionId}`, { tool: s.tool, sessionId: s.sessionId, lastActivity: this.startedAt });
      }
      if (this.running.size) LOG(`seeded ${this.running.size} running session(s) from previous run`);
    } catch (e: any) {
      LOG('seed running sessions failed:', String(e?.message || e).slice(0, 120));
    }
    this.timer = setInterval(() => { void this.tick(); }, this.cfg.monitorIntervalMs);
    void this.tick();
    LOG(`monitor started (probe every ${this.cfg.monitorIntervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 当前运行中的会话（诊断用） */
  get runningSessions(): RunningSession[] {
    return [...this.running.values()];
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const events: StateEvent[] = [];
      const maxActivity = new Map<string, number>();

      for (const collector of this.collectors) {
        let activity: Map<string, ProbeSignal>;
        try {
          activity = await collector.probe();
        } catch (e: any) {
          LOG(`${collector.tool} probe error:`, String(e?.message || e).slice(0, 120));
          continue;
        }
        for (const [id, sig] of activity) {
          const ts = sig?.ts || 0;
          if (!ts) continue;
          const key = `${collector.tool}/${id}`;
          const prev = this.running.get(key);

          if (sig.running === false) {
            // 精确空闲：最新回合已结束（完成/出错/被打断）→ 立即归位，不等多分钟超时
            if (prev) {
              this.running.delete(key);
              events.push({
                tool: collector.tool, sessionId: id, state: 'idle',
                ts: now - ts <= this.cfg.activeWindowMs ? ts : now,
              });
            }
            continue;
          }

          if (sig.running === true) {
            // 精确运行中：直接信任探针（僵死由 collector 兜底窗口翻转为 false）
            if (!prev) {
              this.running.set(key, { tool: collector.tool, sessionId: id, lastActivity: now, exact: true, lastWrite: ts });
              events.push({ tool: collector.tool, sessionId: id, state: 'running', ts: Math.max(ts, now - 1000) });
            } else {
              prev.lastActivity = now;
              prev.exact = true;
              if (ts > (prev.lastWrite ?? 0)) prev.lastWrite = ts;
            }
            // 源库确有新写入才提示 ingest 提前跑（长工具静默期不刷采集轮）
            if (now - ts <= this.cfg.activeWindowMs) {
              const prevMax = maxActivity.get(collector.tool) || 0;
              if (ts > prevMax) maxActivity.set(collector.tool, ts);
            }
            continue;
          }

          // 无精确信号：时间窗口推断（原逻辑）
          if (now - ts > this.cfg.activeWindowMs) continue;
          const prevMax = maxActivity.get(collector.tool) || 0;
          if (ts > prevMax) maxActivity.set(collector.tool, ts);
          if (!prev) {
            this.running.set(key, { tool: collector.tool, sessionId: id, lastActivity: ts, lastWrite: ts });
            events.push({ tool: collector.tool, sessionId: id, state: 'running', ts: Math.max(ts, now - 1000) });
          } else {
            if (ts > prev.lastActivity) prev.lastActivity = ts;
            prev.exact = false;
          }
        }
      }

      // 超时归位 idle（精确运行中见上，由 collector 翻转；此处兜底探针异常导致的滞留）
      for (const [key, r] of [...this.running]) {
        const deadline = r.exact
          ? Math.max(r.lastWrite ?? 0, this.startedAt) + EXACT_BACKSTOP_MS
          : Math.max(r.lastActivity, this.startedAt) + this.cfg.idleTimeoutMs;
        if (now > deadline) {
          this.running.delete(key);
          events.push({ tool: r.tool, sessionId: r.sessionId, state: 'idle', ts: now });
        }
      }

      if (events.length) {
        try {
          this.db.applyStateEvents(events);
          for (const fn of this.subs) fn(events);
        } catch (e: any) {
          LOG('write state events failed:', String(e?.message || e).slice(0, 120));
        }
      }

      // 源库有新动静 → 提示 ingest 引擎可以提前跑一轮（防抖在 ingest 侧，不阻塞监控）
      for (const [tool] of maxActivity) {
        this.onDirty(tool);
      }
    } finally {
      this.ticking = false;
    }
  }
}
