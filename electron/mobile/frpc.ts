/**
 * frpc 内网穿透托管
 *
 * 由 App 启动/停止 frpc（用户自备 frpc 程序与配置），异常退出自动重连。
 * 只托管一个 frpc 进程；配置用于把本机移动端网关（默认 127.0.0.1:8791）
 * 暴露到 VPS 的远程端口，再由 nginx / 域名对外提供服务。
 */
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import logger from '../services/logger';
import { getConfig } from '../services/app-config';

const DEFAULT_BIN = path.join(os.homedir(), '.qihang-ai-desktop', 'frp', 'frpc.exe');
const RESTART_BASE_MS = 3000;
const RESTART_MAX_MS = 60000;

export interface FrpcPaths {
  binPath: string;
  configPath: string;
}

let child: ChildProcess | null = null;
let current: FrpcPaths | null = null;
let stopRequested = false;
let restartTimer: NodeJS.Timeout | null = null;
let restartDelay = RESTART_BASE_MS;
let restarts = 0;
let lastError = '';
let lastExit = '';
let startedAt = 0;

/** 配置里的 frpc 路径；未配置时退回用户目录 frp 文件夹，并从程序目录推断配置名 */
export function resolveFrpcPaths(): FrpcPaths {
  const binPath = getConfig('frpcPath') || DEFAULT_BIN;
  let configPath = getConfig('frpcConfigPath');
  if (!configPath) {
    const dir = path.dirname(binPath);
    for (const name of ['frpc.toml', 'frpc.ini']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        configPath = candidate;
        break;
      }
    }
    if (!configPath) configPath = path.join(dir, 'frpc.toml');
  }
  return { binPath, configPath };
}

export function frpcStatus() {
  return {
    running: !!child,
    pid: child && child.pid ? child.pid : null,
    binPath: current?.binPath || resolveFrpcPaths().binPath,
    configPath: current?.configPath || resolveFrpcPaths().configPath,
    startedAt,
    restarts,
    lastError,
    lastExit,
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function logOutput(level: 'info' | 'warn', buf: Buffer): void {
  const text = stripAnsi(String(buf)).trim();
  if (!text) return;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (level === 'warn') logger.warn('[Frpc] %s', trimmed);
    else logger.info('[Frpc] %s', trimmed);
  }
}

function scheduleRestart(): void {
  if (stopRequested || restartTimer || !current) return;
  const delay = restartDelay;
  restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS);
  restarts += 1;
  logger.warn('[Frpc] %d 毫秒后自动重连（第 %d 次）', delay, restarts);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (current && !stopRequested) void startFrpc(current);
  }, delay);
}

export async function startFrpc(paths: FrpcPaths): Promise<{ ok: boolean; error?: string }> {
  if (child) return { ok: true };
  if (!paths.binPath || !fs.existsSync(paths.binPath)) {
    return { ok: false, error: 'frpc 程序不存在：' + (paths.binPath || '未配置') };
  }
  if (!paths.configPath || !fs.existsSync(paths.configPath)) {
    return { ok: false, error: 'frpc 配置文件不存在：' + (paths.configPath || '未配置') };
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  stopRequested = false;
  current = paths;
  lastError = '';

  let proc: ChildProcess;
  try {
    proc = spawn(paths.binPath, ['-c', paths.configPath], {
      cwd: path.dirname(paths.configPath),
      windowsHide: true,
    });
  } catch (e: any) {
    lastError = e?.message || String(e);
    current = null;
    return { ok: false, error: lastError };
  }

  child = proc;
  startedAt = Date.now();
  proc.stdout?.on('data', (buf: Buffer) => logOutput('info', buf));
  proc.stderr?.on('data', (buf: Buffer) => logOutput('warn', buf));

  const started = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    proc.once('spawn', () => finish({ ok: true }));
    proc.once('error', (err: any) => {
      lastError = err?.message || String(err);
      child = null;
      current = null;
      finish({ ok: false, error: lastError });
    });
    // 极端情况：spawn 事件迟迟不来，1.5s 内直接当成功（后续异常由 exit 处理）
    setTimeout(() => finish({ ok: true }), 1500);
  });

  proc.on('exit', (code, signal) => {
    const uptime = startedAt ? Date.now() - startedAt : 0;
    lastExit = `code=${code === null ? '-' : code}${signal ? ' signal=' + signal : ''}`;
    child = null;
    startedAt = 0;
    if (stopRequested) return;
    if (uptime > 60000) restartDelay = RESTART_BASE_MS; // 稳定运行过一段时间后重置退避
    lastError = 'frpc 已退出（' + lastExit + '），将自动重连';
    scheduleRestart();
  });

  return started;
}

export async function stopFrpc(): Promise<void> {
  stopRequested = true;
  current = null;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const proc = child;
  child = null;
  startedAt = 0;
  if (!proc) return;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    proc.once('exit', finish);
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (!done && proc.pid) {
        try {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
        } catch {
          /* ignore */
        }
      }
      finish();
    }, 3000);
  });

  logger.info('[Frpc] 已停止');
}

export async function restartFrpc(paths: FrpcPaths): Promise<{ ok: boolean; error?: string }> {
  await stopFrpc();
  return startFrpc(paths);
}
