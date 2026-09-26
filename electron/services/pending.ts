/**
 * 暂存区：飞书即时派活的产物先落盘暂存（跨重启有效），
 * 用户回复「确认」后才写入笔记库，「放弃」则丢弃；未确认的暂存 7 天后自动清理。
 *
 * 目录结构：~/.qihang-ai-desktop/pending/task-<任务id>/
 *   manifest.json   暂存元信息与待应用的操作清单
 *   files/          待写入笔记库的文件（相对路径与笔记库一致）
 *
 * 定时任务与桌面对话不经过暂存（定时=事先授权，桌面=人在场），保持直写。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import logger from './logger';

export interface StageOp {
  path: string;
  op: 'write' | 'delete';
  at: string;
}

export interface StageManifest {
  taskId: number;
  taskTitle: string;
  createdAt: string;
  updatedAt: string;
  status: 'pending' | 'confirmed' | 'discarded';
  ops: StageOp[];
}

const PENDING_ROOT = path.join(os.homedir(), '.qihang-ai-desktop', 'pending');
const MAX_AGE_DAYS = 7;

function nowString(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function stageDirOf(taskId: number): string {
  return path.join(PENDING_ROOT, 'task-' + taskId);
}

export function filesDirOf(taskId: number): string {
  return path.join(stageDirOf(taskId), 'files');
}

function manifestPathOf(taskId: number): string {
  return path.join(stageDirOf(taskId), 'manifest.json');
}

export function readManifest(taskId: number): StageManifest | null {
  try {
    const p = manifestPathOf(taskId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e: any) {
    logger.warn('[Pending] read manifest failed: %s', e.message);
    return null;
  }
}

function writeManifest(m: StageManifest) {
  fs.mkdirSync(stageDirOf(m.taskId), { recursive: true });
  fs.writeFileSync(manifestPathOf(m.taskId), JSON.stringify(m, null, 2), 'utf-8');
}

/** 创建或复用任务的暂存区；已有未确认暂存则沿用（追问在原暂存上追加产物） */
export function ensureStage(taskId: number, taskTitle: string): StageManifest {
  const existing = readManifest(taskId);
  if (existing && existing.status === 'pending') {
    existing.taskTitle = taskTitle || existing.taskTitle;
    existing.updatedAt = nowString();
    writeManifest(existing);
    return existing;
  }
  const m: StageManifest = {
    taskId,
    taskTitle: taskTitle || '',
    createdAt: nowString(),
    updatedAt: nowString(),
    status: 'pending',
    ops: [],
  };
  fs.rmSync(stageDirOf(taskId), { recursive: true, force: true });
  fs.mkdirSync(filesDirOf(taskId), { recursive: true });
  writeManifest(m);
  return m;
}

/** 记录一次待应用操作；同一路径后写覆盖先写 */
export function recordOp(taskId: number, relPath: string, op: 'write' | 'delete') {
  const m = readManifest(taskId);
  if (!m || m.status !== 'pending') return;
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!rel) return;
  m.ops = m.ops.filter(o => o.path !== rel);
  m.ops.push({ path: rel, op, at: nowString() });
  m.updatedAt = nowString();
  writeManifest(m);
}

export function listOps(taskId: number): StageOp[] {
  const m = readManifest(taskId);
  return m && m.status === 'pending' ? m.ops : [];
}

/** 最近的未确认暂存（按更新时间倒序），供「确认 / 放弃」指令定位 */
export function latestPendingStage(): StageManifest | null {
  try {
    if (!fs.existsSync(PENDING_ROOT)) return null;
    let latest: StageManifest | null = null;
    for (const name of fs.readdirSync(PENDING_ROOT)) {
      const id = Number(name.replace(/^task-/, ''));
      if (!Number.isFinite(id) || id <= 0) continue;
      const m = readManifest(id);
      if (!m || m.status !== 'pending' || !m.ops.length) continue;
      if (!latest || m.updatedAt > latest.updatedAt) latest = m;
    }
    return latest;
  } catch (e: any) {
    logger.warn('[Pending] scan failed: %s', e.message);
    return null;
  }
}

/** 将暂存产物写入笔记库（写入 + 删除），成功后清理暂存目录 */
export function applyStage(taskId: number, notesDir: string): { ok: boolean; written: string[]; deleted: string[]; error?: string } {
  const m = readManifest(taskId);
  if (!m || m.status !== 'pending') return { ok: false, written: [], deleted: [], error: '没有待确认的暂存产物' };
  if (!notesDir || !fs.existsSync(notesDir)) return { ok: false, written: [], deleted: [], error: '笔记库目录不存在，请先配置笔记库' };
  const root = path.resolve(notesDir);
  const written: string[] = [];
  const deleted: string[] = [];
  try {
    for (const op of m.ops) {
      const dst = path.resolve(root, op.path);
      if (!dst.startsWith(root)) {
        logger.warn('[Pending] skip out-of-root path: %s', op.path);
        continue;
      }
      if (op.op === 'write') {
        const src = path.join(filesDirOf(taskId), op.path);
        if (!fs.existsSync(src)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        written.push(op.path);
      } else if (fs.existsSync(dst)) {
        fs.unlinkSync(dst);
        deleted.push(op.path);
      }
    }
    m.status = 'confirmed';
    m.updatedAt = nowString();
    writeManifest(m);
    fs.rmSync(stageDirOf(taskId), { recursive: true, force: true });
    return { ok: true, written, deleted };
  } catch (e: any) {
    logger.error('[Pending] apply failed: %s', e.message);
    return { ok: false, written, deleted, error: e.message };
  }
}

/** 放弃暂存：删除整个暂存目录，笔记库不受影响 */
export function discardStage(taskId: number): number {
  const m = readManifest(taskId);
  const count = m ? m.ops.length : 0;
  try {
    fs.rmSync(stageDirOf(taskId), { recursive: true, force: true });
  } catch (e: any) {
    logger.error('[Pending] discard failed: %s', e.message);
    return 0;
  }
  return count;
}

/** 清理超过 maxAgeDays 天未确认的暂存目录 */
export function cleanupStages(maxAgeDays = MAX_AGE_DAYS): number {
  let removed = 0;
  try {
    if (!fs.existsSync(PENDING_ROOT)) return 0;
    const cutoff = Date.now() - maxAgeDays * 86400 * 1000;
    for (const name of fs.readdirSync(PENDING_ROOT)) {
      const dir = path.join(PENDING_ROOT, name);
      const id = Number(name.replace(/^task-/, ''));
      const m = Number.isFinite(id) && id > 0 ? readManifest(id) : null;
      const parsed = m ? new Date(m.updatedAt.replace(' ', 'T') + '+08:00').getTime() : 0;
      const ts = Number.isFinite(parsed) && parsed > 0 ? parsed : fs.statSync(dir).mtimeMs;
      if (ts < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    }
  } catch (e: any) {
    logger.warn('[Pending] cleanup failed: %s', e.message);
  }
  return removed;
}
