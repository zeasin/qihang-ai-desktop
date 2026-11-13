import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { HubCollector, ProbeSignal, SerializedMessage, SessionInfo } from '../types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-TRAE]', msg, ...args);

/** Trae 会话库候选路径：CN 版为 "Trae CN"，国际版为 "Trae" */
function traeDbCandidates(): string[] {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [
    path.join(roaming, 'Trae CN', 'ModularData', 'ai-agent', 'database.db'),
    path.join(roaming, 'Trae', 'ModularData', 'ai-agent', 'database.db'),
  ];
}

/** 解密缓存放系统临时目录（源库变了会自动重解） */
function traeCacheBasePath(srcPath: string): string {
  const name = `qihang-radar-trae-plain-${Buffer.from(srcPath).toString('base64url').slice(0, 12)}.sqlite`;
  return path.join(os.tmpdir(), name);
}

/**
 * worker 编译产物路径。打包后主进程代码在 app.asar 内，而 worker 文件已配置
 * asarUnpack 落在 app.asar.unpacked（Node 的 worker 线程读 asar 内文件不可靠），这里做路径替换。
 */
function workerJsPath(): string {
  return path.join(__dirname, 'trae-db-worker.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

/**
 * Trae 只读采集：SQLCipher 加密库，worker 里按页解密成明文临时文件再查（重活不堵主线程）。
 * 探针复用明文缓存查 chat_session.updated_at（源库没动时只是一次 stat + 小查询，
 * 变了才重解且有 8s 节流），运行状态走时间窗口推断。
 */
export class TraeCollector implements HubCollector {
  readonly tool = 'trae';
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private srcPath: string | null = null;
  private initPromise: Promise<void> | null = null;

  private init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.srcPath = traeDbCandidates().find((p) => existsSync(p)) || null;
        if (!this.srcPath) {
          LOG('database.db 未找到，会话列表将为空');
          return;
        }
        try {
          await this.rpc('init', { srcPath: this.srcPath, cachePath: traeCacheBasePath(this.srcPath) });
          LOG('decrypt cache ready for', this.srcPath);
        } catch (e: any) {
          LOG('init error:', e?.message || e);
          this.srcPath = null;
        }
      })();
    }
    return this.initPromise;
  }

  private rpc<T>(op: string, args?: unknown): Promise<T> {
    if (!this.srcPath) return Promise.reject(new Error('Trae 数据库不可用'));
    if (!this.worker) {
      const jsPath = workerJsPath();
      if (!existsSync(jsPath)) {
        return Promise.reject(new Error(`Trae worker 不存在: ${jsPath}`));
      }
      this.worker = new Worker(jsPath, { stdout: true, stderr: true });
      this.worker.on('message', (msg: { id: number; result?: unknown; error?: string }) => {
        const call = this.pending.get(msg.id);
        if (!call) return;
        this.pending.delete(msg.id);
        if (msg.error) call.reject(new Error(msg.error));
        else call.resolve(msg.result);
      });
      this.worker.on('exit', () => {
        this.worker = null;
        for (const [, call] of this.pending) call.reject(new Error('Trae worker 已退出'));
        this.pending.clear();
      });
      this.worker.on('error', (e) => console.error('[RADAR-TRAE] worker error:', e));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, op, args });
    });
  }

  async listAll(): Promise<SessionInfo[]> {
    try {
      await this.init();
      if (!this.srcPath) return [];
      return await this.rpc<SessionInfo[]>('list', { projectDir: '' });
    } catch (e: any) {
      LOG('listAll error:', e?.message || e);
      return [];
    }
  }

  async loadMessages(session: SessionInfo): Promise<SerializedMessage[]> {
    try {
      await this.init();
      if (!this.srcPath || !session.id) return [];
      return await this.rpc<SerializedMessage[]>('load', { sessionId: session.id });
    } catch (e: any) {
      LOG('loadMessages error:', e?.message || e);
      return [];
    }
  }

  async probe(): Promise<Map<string, ProbeSignal>> {
    try {
      await this.init();
      if (!this.srcPath) return new Map<string, ProbeSignal>();
      const cutoffSec = Math.floor((Date.now() - 10 * 60_000) / 1000);
      const rows = await this.rpc<Array<{ id: string; ts: number }>>('probe', { cutoffSec });
      const out = new Map<string, ProbeSignal>();
      for (const r of rows || []) out.set(r.id, { ts: r.ts });
      return out;
    } catch (e: any) {
      LOG('probe error:', e?.message || e);
      return new Map<string, ProbeSignal>();
    }
  }

  async dispose(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.pending.clear();
    try { await w?.terminate(); } catch {}
    this.initPromise = null;
  }
}
