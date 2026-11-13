/**
 * 雷达工作线程入口：采集内核（collectors + ingest + monitor）整体跑在独立线程，
 * 重 IO/CPU（整文件解析、zstd 解压、SQLCipher 解密、批量入库）不堵 Electron 主进程。
 * 与主进程的协议（postMessage）：
 *   主 → 线程：{ type: 'start', cfg, root } / { type: 'scan-now' } / { type: 'stop' }
 *   线程 → 主：{ type: 'ready', collectors } / { type: 'state', events } / { type: 'round', stat } / { type: 'error', message }
 */
import { parentPort, workerData } from 'node:worker_threads';
import { RadarDb } from './radar-db';
import { FingerprintStore } from './fingerprint-store';
import { RadarIngestLoop } from './radar-ingest';
import { RadarMonitorLoop } from './radar-monitor';
import { defaultCollectors } from './collectors/registry';
import type { HubCollector } from './types';
import type { RadarConfig } from './radar-config';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-WORKER]', msg, ...args);

interface StartPayload {
  type: 'start';
  cfg: RadarConfig;
  root: string;
}

type WorkerInMessage = StartPayload | { type: 'scan-now' } | { type: 'stop' }
  | { type: 'unfreeze'; tool: string; sessionId: string }
  | { type: 'save-summary'; tool: string; sessionId: string; summary: string; msgCount: number };

const post = (msg: any): void => {
  try { parentPort?.postMessage(msg); } catch { /* 主进程已退出等场景 */ }
};

let db: RadarDb | null = null;
let fps: FingerprintStore | null = null;
let ingest: RadarIngestLoop | null = null;
let monitor: RadarMonitorLoop | null = null;
let scoreTimer: NodeJS.Timeout | null = null;
let collectors: HubCollector[] = [];

function start(payload: StartPayload): void {
  const { cfg, root } = payload;
  db = new RadarDb(root);
  fps = new FingerprintStore(root);
  // 价值分动态刷新：启动校准一次 + 运行中每 10 分钟滚动重算（会话续聊长出新内容后分数跟着涨）
  try {
    const n = db.refreshValueScores();
    if (n) LOG(`value scores refreshed for ${n} session(s)`);
  } catch (e: any) {
    LOG('refresh value scores failed:', String(e?.message || e));
  }
  scoreTimer = setInterval(() => {
    try {
      const n = db?.refreshValueScores() || 0;
      if (n) LOG(`value scores refreshed for ${n} session(s)`);
    } catch { /* 下一轮再试 */ }
  }, 10 * 60_000);
  collectors = defaultCollectors(cfg);
  ingest = new RadarIngestLoop(db, fps, collectors, cfg);
  ingest.onRound = (stat) => post({ type: 'round', stat });
  monitor = new RadarMonitorLoop(db, collectors, cfg, (tool) => ingest?.markDirty(tool));
  monitor.onStateEvents((events) => {
    // 会话收口（idle）时落规则价值分：先算分再转发，主进程的摘要门槛读到的就是最新分
    const wdb = db;
    for (const e of events) {
      if (e.state !== 'idle' || !wdb) continue;
      try { wdb.saveValueScore(e.tool, e.sessionId, wdb.computeValueScore(e.tool, e.sessionId)); } catch { /* 打分失败不影响转发 */ }
    }
    post({ type: 'state', events });
  });
  ingest.start();
  monitor.start();
  LOG(`started (tools=${collectors.map((c) => c.tool).join(',') || 'none'})`);
  post({ type: 'ready', collectors: collectors.map((c) => c.tool) });
}

async function stop(): Promise<void> {
  if (scoreTimer) { clearInterval(scoreTimer); scoreTimer = null; }
  try { monitor?.stop(); } catch {}
  try { ingest?.stop(); } catch {}
  for (const c of collectors) {
    try { await c.dispose(); } catch { /* 单个清理失败不影响退出 */ }
  }
  collectors = [];
  monitor = null;
  ingest = null;
  try { fps?.dispose(); } catch {}
  fps = null;
  try { db?.conn.close(); } catch {}
  db = null;
  LOG('stopped');
}

if (parentPort) {
  parentPort.on('message', (msg: WorkerInMessage) => {
    try {
      if (msg.type === 'start') {
        start(msg);
      } else if (msg.type === 'scan-now') {
        void ingest?.syncNow('manual');
      } else if (msg.type === 'unfreeze') {
        // 解冻并强制重采：清冻结标记 + 归零指纹（下一轮按 full 重建），随后立刻触发一轮
        const tool = String(msg.tool || '');
        const sessionId = String(msg.sessionId || '');
        if (db && fps && tool && sessionId) {
          db.setFrozen(tool, [sessionId], false, '');
          fps.set(tool, sessionId, { sourceUpdatedAt: 0, messageCount: 0, lastSyncedSeq: 0 });
          LOG('unfroze', `${tool}/${sessionId.slice(0, 24)}, recollect queued`);
          void ingest?.syncNow('unfreeze');
        }
      } else if (msg.type === 'save-summary') {
        // 主进程 AI 摘要写回（主进程只持只读连接，写操作统一回到 worker 写入端）
        const tool = String(msg.tool || '');
        const sessionId = String(msg.sessionId || '');
        if (db && tool && sessionId) db.saveSummary(tool, sessionId, String(msg.summary || ''), Number(msg.msgCount) || 0);
      } else if (msg.type === 'stop') {
        void stop().then(() => process.exit(0));
      }
    } catch (e: any) {
      LOG('message error:', String(e?.message || e));
      post({ type: 'error', message: String(e?.message || e) });
    }
  });
  // workerData 兜底：worker_threads 构造参数直接带配置，避免主进程错过 start 消息窗口
  if (workerData && workerData.cfg && workerData.root) {
    start({ type: 'start', cfg: workerData.cfg, root: workerData.root });
  }
}
