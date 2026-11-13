/**
 * 智能体雷达服务：监控本机其他 AI 编码工具的运行状态，并把会话对话增量采集到本地 SQLite。
 * 架构（防卡死）：
 *   - 采集内核（collectors + ingest + monitor）整体跑在独立工作线程（electron/radar/radar-worker.js），
 *     重 IO/CPU（整文件解析、zstd 解压、SQLCipher 解密、批量入库）不堵主进程事件循环；
 *   - 主进程持有 radar.db 的只读连接（WAL 并发读）负责 UI 查询，与线程内写入端互不阻塞；
 *   - 线程内状态跃迁经 postMessage 回主进程，转发给渲染层（radar:event）；
 *   - 自愈：worker 意外退出自动按指数退避重启；monitor 启动时清扫僵尸 running；
 *     读路径按同步心跳归位僵尸 running（worker 停摆期间 UI 也不会永远显示「运行中」）。
 * 数据全部落 ~/.qihang-ai-desktop/radar/，不出机器。
 */
import { Worker } from 'node:worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import * as appConfig from './app-config';
import logger from './logger';
import { ALL_TOOLS, ensureDataDir, radarDataDir, type RadarConfig } from '../radar/radar-config';
import { RadarDb, dbPath } from '../radar/radar-db';
import type { RoundStat } from '../radar/radar-ingest';
import type { StateEvent } from '../radar/radar-monitor';

function boolOn(key: string): boolean {
  return String(appConfig.getConfig(key) || '') === '1';
}

function numCfg(key: string, dflt: number): number {
  const n = Number(appConfig.getConfig(key));
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function buildConfig(): RadarConfig {
  const tools = String(appConfig.getConfig('agentRadarTools') || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .filter((t) => (ALL_TOOLS as readonly string[]).includes(t));
  const exclude = String(appConfig.getConfig('agentRadarExclude') || '')
    .split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  return {
    tools,
    excludeProjects: exclude,
    autoFreezeDays: 30,
    syncIntervalMs: numCfg('agentRadarIntervalMs', 60_000),
    monitorIntervalMs: numCfg('agentRadarMonitorMs', 3_000),
    activeWindowMs: 3 * 60_000,
    idleTimeoutMs: 3 * 60_000,
  };
}

/** 打包后 worker 文件在 asar 外（asarUnpack），开发态直接在编译目录 */
function workerJsPath(): string {
  return path.join(__dirname, '..', 'radar', 'radar-worker.js')
    .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

class AgentRadarService {
  private worker: Worker | null = null;
  private queryConn: RadarDb | null = null;
  private runningFlag = false;
  private workerCollectors: string[] = [];
  private lastRound: RoundStat | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartAttempts = 0;
  private readonly subs = new Set<(events: StateEvent[]) => void>();

  onStateEvents(fn: (events: StateEvent[]) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  isRunning(): boolean {
    return this.runningFlag;
  }

  isEnabled(): boolean {
    return boolOn('agentRadarEnabled');
  }

  async start(): Promise<void> {
    if (this.runningFlag || this.worker) return;
    this.stopping = false;
    this.clearRestartTimer();
    const cfg = buildConfig();
    const root = ensureDataDir();
    const jsPath = workerJsPath();
    if (!fs.existsSync(jsPath)) {
      throw new Error(`雷达工作线程不存在: ${jsPath}`);
    }
    const worker = new Worker(jsPath, { workerData: { cfg, root } });
    this.worker = worker;
    worker.on('message', (msg: any) => {
      if (msg?.type === 'ready') {
        this.workerCollectors = Array.isArray(msg.collectors) ? msg.collectors : [];
        this.runningFlag = true;
        this.restartAttempts = 0;
        logger.info('[Radar] worker ready (tools=%s)', this.workerCollectors.join(',') || 'none');
      } else if (msg?.type === 'state') {
        const events: StateEvent[] = Array.isArray(msg.events) ? msg.events : [];
        for (const fn of this.subs) {
          try { fn(events); } catch { /* 订阅者异常不影响采集 */ }
        }
      } else if (msg?.type === 'round') {
        this.lastRound = msg.stat || null;
      } else if (msg?.type === 'error') {
        logger.error('[Radar] worker error: %s', msg.message);
      }
    });
    worker.on('error', (e: any) => {
      logger.error('[Radar] worker crashed: %s', e?.message || e);
      this.runningFlag = false;
    });
    worker.on('exit', (code) => {
      if (code !== 0) logger.info('[Radar] worker exited (code=%s)', code);
      if (this.worker === worker) {
        this.worker = null;
        this.runningFlag = false;
        this.workerCollectors = [];
      }
      // 意外退出（崩溃/异常）→ 指数退避自动重启；此前卡在 running 的会话
      // 由 monitor 启动清扫 + 读路径防僵尸投影归位，不再依赖用户重启应用
      this.scheduleRestart();
    });
  }

  /** worker 意外退出后的自动重启：5s 起指数退避，上限 60s，ready 后清零 */
  private scheduleRestart(): void {
    if (this.stopping || this.worker || this.restartTimer) return;
    if (!this.isEnabled()) return;
    this.restartAttempts += 1;
    const delay = Math.min(5_000 * 2 ** (this.restartAttempts - 1), 60_000);
    logger.info('[Radar] worker restart in %ss (attempt %s)', Math.round(delay / 1000), this.restartAttempts);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || this.worker) return;
      this.start().catch((e: any) => {
        logger.error('[Radar] worker restart failed: %s', e?.message || e);
        this.scheduleRestart();
      });
    }, delay);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRestartTimer();
    const worker = this.worker;
    if (!worker) {
      this.runningFlag = false;
      return;
    }
    this.worker = null;
    this.runningFlag = false;
    this.workerCollectors = [];
    try { worker.postMessage({ type: 'stop' }); } catch { /* 已退出 */ }
    // 给线程 2.5s 优雅收尾（关库/清缓存），超时强杀（WAL 保证不脏库）
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { worker.terminate(); } catch {}
        resolve();
      }, 2500);
      worker.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  /** 手动触发一轮增量采集 */
  scanNow(): boolean {
    if (!this.worker) return false;
    try {
      this.worker.postMessage({ type: 'scan-now' });
      return true;
    } catch {
      return false;
    }
  }

  /** 解冻会话并强制重采（清指纹，下一轮 full 重建） */
  unfreeze(tool: string, sessionId: string): boolean {
    if (!this.worker) return false;
    try {
      this.worker.postMessage({ type: 'unfreeze', tool, sessionId });
      return true;
    } catch {
      return false;
    }
  }

  /** AI 摘要写回（转交 worker 写入端；worker 未运行时静默丢弃，下次收口会重新提炼） */
  saveSummary(tool: string, sessionId: string, summary: string, msgCount: number): boolean {
    if (!this.worker) return false;
    try {
      this.worker.postMessage({ type: 'save-summary', tool, sessionId, summary, msgCount });
      return true;
    } catch {
      return false;
    }
  }

  status(): any {
    const enabled = this.isEnabled();
    const db = this.queryDb();
    return {
      enabled,
      running: this.runningFlag,
      dataDir: radarDataDir(),
      collectors: this.workerCollectors,
      allTools: [...ALL_TOOLS],
      lastRound: this.lastRound,
      stats: db ? db.stats() : null,
    };
  }

  roundStat(): RoundStat | null {
    return this.lastRound;
  }

  toolStats(): { tool: string; sessions: number; running: number; lastActivity: number }[] {
    const db = this.queryDb();
    return db ? db.toolStats() : [];
  }

  /** 雷达页仪表盘一次取全：工具卡片 + 最近跃迁 + 最近活跃会话 */
  dashboard(): any {
    const db = this.queryDb();
    return {
      cards: db ? db.overviewCards() : [],
      events: db ? db.recentEvents(20) : [],
      sessions: db ? db.recentSessions(15) : [],
      stats: db ? db.stats() : null,
      lastRound: this.lastRound,
    };
  }

  listSessions(opts: { tool?: string; page?: number; pageSize?: number }): any {
    const db = this.queryDb();
    if (!db) return { total: 0, rows: [] };
    const pageSize = Math.min(Math.max(opts.pageSize || 50, 1), 200);
    const page = Math.max(opts.page || 1, 1);
    return db.listSessions({ tool: opts.tool || undefined, limit: pageSize, offset: (page - 1) * pageSize });
  }

  findSessions(q: string): any[] {
    const db = this.queryDb();
    return db ? db.findSessions(q) : [];
  }

  searchMessages(q: string, limit = 50): any[] {
    const db = this.queryDb();
    return db ? db.searchMessages(q, limit) : [];
  }

  getMessages(tool: string, sessionId: string): any[] {
    const db = this.queryDb();
    return db ? db.getMessages(tool, sessionId) : [];
  }

  /** 单个会话元信息（会话详情页头部用） */
  sessionInfo(tool: string, sessionId: string): any {
    const db = this.queryDb();
    return db ? db.getSession(tool, sessionId) : null;
  }

  /** 高价值但还没摘要的会话（存量补摘要用） */
  sessionsNeedingSummary(minScore = 3, limit = 200): any[] {
    const db = this.queryDb();
    return db ? db.sessionsNeedingSummary(minScore, limit) : [];
  }

  stateEvents(tool: string, sessionId: string): any[] {
    const db = this.queryDb();
    return db ? db.stateEvents(tool, sessionId) : [];
  }

  /** UI 查询专用只读连接：库文件出现后才建立（首次开启时线程先建库） */
  private queryDb(): RadarDb | null {
    if (this.queryConn) return this.queryConn;
    if (!fs.existsSync(dbPath(radarDataDir()))) return null;
    try {
      this.queryConn = new RadarDb(radarDataDir(), { readonly: true });
    } catch (e: any) {
      logger.error('[Radar] open readonly query db failed: %s', e?.message || e);
      return null;
    }
    return this.queryConn;
  }
}

export const agentRadar = new AgentRadarService();
