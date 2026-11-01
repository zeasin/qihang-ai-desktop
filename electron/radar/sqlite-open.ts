import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * 只读打开外部工具的 SQLite 库（多为 WAL 模式）：
 * 先 readOnly，失败（WAL 需要恢复且没有写入方持有 -shm）退回普通打开让 SQLite 完成恢复。
 * 库不存在返回 null（工具未安装），调用方按空列表处理。
 */
export function openSqliteReadonly(dbPath: string, logTag: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    console.log(`[${logTag}] readOnly open failed (${String(e).slice(0, 120)}), retrying read-write for WAL recovery`);
    return new DatabaseSync(dbPath);
  }
}

/** 目录等价判断：归一化后忽略大小写与分隔符风格（各工具对盘符大小写不统一） */
export function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}
