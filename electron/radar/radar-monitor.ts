import { RadarDb } from './radar-db';
import type { RadarConfig } from './radar-config';
import type { HubCollector } from './types';

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
}

/**
 * 实时监控通道：每 monitorIntervalMs（默认 3s）跑一轮轻探针，
 * diff 出会话状态跃迁（running/idle）→ 订阅者扇出（渲染层推送等）+ 落本地 radar_state_event + 会话 state 投影。
 * 探针绝不解析消息内容——这是实时性与成本的全部保障。
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
    // 预置上次运行留下的 running 会话：重启不重复发「开始运行」；
    // 若 3 分钟内探针见不到新活动，会自然转入空闲（对卡在 running 的陈旧会话同样生效）
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
        let activity: Map<string, number>;
        try {
          activity = await collector.probe();
        } catch (e: any) {
          LOG(`${collector.tool} probe error:`, String(e?.message || e).slice(0, 120));
          continue;
        }
        for (const [id, ts] of activity) {
          if (!ts || now - ts > this.cfg.activeWindowMs) continue;
          const prevMax = maxActivity.get(collector.tool) || 0;
          if (ts > prevMax) maxActivity.set(collector.tool, ts);

          const key = `${collector.tool}/${id}`;
          const prev = this.running.get(key);
          if (!prev) {
            this.running.set(key, { tool: collector.tool, sessionId: id, lastActivity: ts });
            events.push({ tool: collector.tool, sessionId: id, state: 'running', ts: Math.max(ts, now - 1000) });
          } else if (ts > prev.lastActivity) {
            prev.lastActivity = ts;
          }
        }
      }

      // 超时归位 idle
      for (const [key, r] of [...this.running]) {
        if (now - Math.max(r.lastActivity, this.startedAt) > this.cfg.idleTimeoutMs) {
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
