/**
 * opencode serve 进程托管
 *
 * - 二进制解析：打包 resources/opencode/opencode.exe → 项目 node_modules → 全局 npm → PATH
 * - 显式 --port（v1 默认随机端口，SDK 需要知道确切地址）+ /global/health 就绪探测
 * - 懒启动：首次对话才拉起；崩溃后下次调用自动重启（连续失败进入降级计数）
 * - 退出：taskkill /T 兜底清理子进程树
 */
import { spawn, execSync, ChildProcess } from 'child_process';
import * as path from 'path';
import { createServer } from 'net';
import * as fs from 'fs';
import { app } from 'electron';
import logger from './logger';
import { ocConfigFile, ocWorkspaceDir, writeOpencodeConfig } from './opencode-config';

let proc: ChildProcess | null = null;
let baseUrl = '';
let starting: Promise<string> | null = null;
let intentionalStop = false;

export function ocBinaryPath(): string {
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath || '', 'opencode', 'opencode.exe');
    if (fs.existsSync(p)) return p;
  }
  const dev = path.join(app.getAppPath(), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  if (fs.existsSync(dev)) return dev;
  try {
    const g = path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'opencode-ai', 'bin', 'opencode.exe');
    if (fs.existsSync(g)) return g;
  } catch { /* npm 不可用时忽略 */ }
  return 'opencode';
}

let ocAvailableCache: boolean | null = null;

/** opencode 可用性检测（结果缓存）：捆绑/解析到真实路径 → 文件存在；裸命令名 → where/which 验证 */
export function isOcAvailable(): boolean {
  if (ocAvailableCache !== null) return ocAvailableCache;
  const bin = ocBinaryPath();
  if (bin !== 'opencode') {
    ocAvailableCache = fs.existsSync(bin);
  } else {
    try {
      execSync(process.platform === 'win32' ? 'where opencode' : 'which opencode', { stdio: 'ignore' });
      ocAvailableCache = true;
    } catch {
      ocAvailableCache = false;
    }
  }
  logger.info('[OcProcess] availability=%s (bin=%s)', ocAvailableCache, bin);
  return ocAvailableCache;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address();
      if (p && typeof p === 'object') { const port = p.port; s.close(() => resolve(port)); }
      else { s.close(() => reject(new Error('获取端口失败'))); }
    });
    s.on('error', reject);
  });
}

async function waitForHealth(url: string, timeoutMs = 20000): Promise<void> {
  const t0 = Date.now();
  let attempts = 0;
  while (Date.now() - t0 < timeoutMs) {
    if (proc && proc.exitCode !== null) throw new Error(`opencode serve 进程提前退出（code=${proc.exitCode}）`);
    attempts++;
    try {
      // 每次尝试必须带超时：Node fetch 默认无超时，一旦挂起循环将永远停摆
      const r = await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        logger.info('[OcProcess] health OK after %dms (%d attempts)', Date.now() - t0, attempts);
        return;
      }
      logger.warn('[OcProcess] health attempt #%d -> HTTP %d', attempts, r.status);
    } catch (e: any) {
      if (attempts % 5 === 0) logger.warn('[OcProcess] health attempt #%d failed: %s', attempts, e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`opencode serve 启动超时（health 探测 ${Math.round(timeoutMs / 1000)}s，共 ${attempts} 次尝试）`);
}

/** 懒启动 serve，返回 baseUrl（已运行则直接返回） */
export async function ensureOcServer(): Promise<string> {
  if (proc && proc.exitCode === null && baseUrl) return baseUrl;
  if (starting) return starting;
  intentionalStop = false;
  starting = (async () => {
    writeOpencodeConfig();
    const port = await freePort();
    const bin = ocBinaryPath();
    logger.info('[OcProcess] spawn %s serve --port %d', bin, port);
    const child = spawn(bin, ['serve', '--port', String(port)], {
      cwd: ocWorkspaceDir(), // 不指向项目根：避免合并根目录 .opencode/
      env: { ...process.env, OPENCODE_CONFIG: ocConfigFile() },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc = child;
    child.stdout?.on('data', (d) => logger.info('[OcServe] %s', String(d).trim()));
    child.stderr?.on('data', (d) => logger.warn('[OcServe:err] %s', String(d).trim()));
    child.on('exit', (code) => {
      logger.warn('[OcProcess] serve exited code=%s', code);
      if (proc === child) { proc = null; baseUrl = ''; }
    });
    const url = `http://127.0.0.1:${port}`;
    await waitForHealth(url);
    baseUrl = url;
    logger.info('[OcProcess] serve ready: %s', url);
    return url;
  })();
  try {
    return await withTimeout(starting, 60000, 'opencode serve 启动失败');
  } catch (e: any) {
    try { stopOcServer(); } catch { /* 忽略 */ }
    throw e;
  } finally {
    starting = null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}（${Math.round(ms / 1000)}s 超时）`)), ms))]);
}

export async function restartOcServer(): Promise<string> {
  stopOcServer();
  return ensureOcServer();
}

export function stopOcServer(): void {
  intentionalStop = true;
  baseUrl = '';
  if (proc && proc.pid) {
    if (process.platform === 'win32') {
      try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 忽略 */ }
    } else {
      try { proc.kill(); } catch { /* 忽略 */ }
    }
  }
  proc = null;
}

export function ocServerStatus(): { running: boolean; baseUrl: string } {
  return { running: !!(proc && proc.exitCode === null && baseUrl), baseUrl };
}
