import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sameDir } from '../sqlite-open';
import type { SerializedMessage, SessionInfo } from '../types';

/**
 * Trae 会话库 worker：SQLCipher 页级解密 + 查询都是 CPU 重活，必须在独立线程跑。
 *
 * Trae 的 database.db 是 SQLCipher 4（AES-256-CBC，页 4096，reserve 80，HMAC-SHA512），
 * 密钥写死在 ai_agent.dll 里、全用户一致，社区已逆向。
 * 做法：把整个库按页解密成明文 SQLite 临时文件（~0.6s/270MB），再用 node:sqlite 查询；
 * 源库 mtime/size 或 WAL mtime/size 变了就重新解密。WAL 帧（SQLCipher 下帧头仍是明文）
 * 会叠加进明文缓存，所以 Trae 未 checkpoint 的最新写入也能看到。
 */

/** SQLCipher 派生密钥（算法逆向自 ai_agent.dll；版本升级失效时需更新） */
const TRAE_DB_KEY_HEX = '3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773';
const PAGE_SIZE = 4096;
const RESERVED = 80; // 每页尾部：IV(16) + HMAC-SHA512(64)
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
/** 距上次整库重解不足此间隔时，允许继续用略旧的缓存（实测一次重解约 3s CPU + 270MB 落盘） */
const MIN_REFRESH_MS = 8_000;

interface WorkerState {
  srcPath: string;
  cachePath: string;
  metaPath: string;
  activePath: string;
  srcMtimeMs: number;
  srcSize: number;
  walMtimeMs: number;
  walSize: number;
  lastDecryptMs: number;
  db: DatabaseSync | null;
}

const state: WorkerState = {
  srcPath: '',
  cachePath: '',
  metaPath: '',
  activePath: '',
  srcMtimeMs: 0,
  srcSize: -1,
  walMtimeMs: 0,
  walSize: -1,
  lastDecryptMs: 0,
  db: null,
};

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-TRAE-WORKER]', msg, ...args);

/** 并发 worker 共享 pid，必须各自取随机后缀 */
const INSTANCE_ID = `${process.pid.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

function decryptPage(page: Buffer, isFirst: boolean): Buffer {
  const key = Buffer.from(TRAE_DB_KEY_HEX, 'hex');
  const iv = page.subarray(PAGE_SIZE - RESERVED, PAGE_SIZE - RESERVED + 16);
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  d.setAutoPadding(false); // SQLCipher 不用 PKCS 填充
  const ct = page.subarray(isFirst ? 16 : 0, PAGE_SIZE - RESERVED);
  return Buffer.concat([d.update(ct), d.final()]);
}

/**
 * 把 WAL 里已提交事务的页叠加到解密缓冲上。SQLCipher 只加密页体，WAL 头与帧头是明文。
 * 帧校验和复现不出来（SQLCipher 在加密前算的），改用「帧 salt 与 WAL 头一致 + 提交帧
 * (size_after>0)」取边界：salt 不符的是 checkpoint 复位后残留的旧代帧，直接跳过；
 * 未到提交帧的页留在 pending 里不落地。WAL 可能带主库还没有的新页，按 size_after 扩容。
 */
function applyWal(out: Buffer, srcPath: string): Buffer {
  let wal: Buffer;
  try { wal = fs.readFileSync(srcPath + '-wal'); } catch { return out; }
  if (wal.length < 32 + 24 + PAGE_SIZE) return out;
  const magic = wal.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return out;
  if (wal.readUInt32BE(8) !== PAGE_SIZE) return out;
  const salt1 = wal.readUInt32BE(16);
  const salt2 = wal.readUInt32BE(20);
  const frameTotal = 24 + PAGE_SIZE;
  const pending = new Map<number, Buffer>();
  for (let off = 32; off + frameTotal <= wal.length; off += frameTotal) {
    if (wal.readUInt32BE(off + 8) !== salt1 || wal.readUInt32BE(off + 12) !== salt2) continue;
    const pgno = wal.readUInt32BE(off);
    const sizeAfter = wal.readUInt32BE(off + 4);
    if (pgno < 1) continue;
    pending.set(pgno, decryptPage(wal.subarray(off + 24, off + frameTotal), pgno === 1));
    if (sizeAfter <= 0) continue;
    const need = sizeAfter * PAGE_SIZE;
    if (need > out.length) {
      const grown = Buffer.alloc(need);
      out.copy(grown, 0);
      out = grown;
    }
    for (const [p, pg] of pending) {
      // page 1 的明文同样少了开头 16 字节 salt，落位要偏 16，魔数单独补
      const base = p === 1 ? 16 : (p - 1) * PAGE_SIZE;
      if (base + pg.length <= out.length) {
        pg.copy(out, base);
        if (p === 1) SQLITE_MAGIC.copy(out, 0);
      }
    }
    pending.clear();
  }
  return out;
}

/** 镜像是否自洽：首页声明的页数不能超过镜像实际长度（防 checkpoint 中途读到坏镜像） */
function isSelfConsistent(buf: Buffer): boolean {
  if (buf.length < PAGE_SIZE) return false;
  if (buf.readUInt16BE(16) !== PAGE_SIZE || buf[20] !== RESERVED) return false;
  const declaredPages = buf.readUInt32BE(28);
  return declaredPages > 0 && declaredPages * PAGE_SIZE <= buf.length;
}

/** 整库解密到全新明文文件；文件名带实例+时间戳后缀，绝不覆盖别人正打开着的缓存 */
function decryptToFile(srcPath: string): string {
  const f = fs.readFileSync(srcPath);
  const pages = Math.floor(f.length / PAGE_SIZE);
  if (pages < 1) throw new Error('Trae 数据库文件为空或损坏');
  const out = Buffer.alloc(f.length);
  SQLITE_MAGIC.copy(out, 0);
  for (let i = 0; i < pages; i++) {
    const page = f.subarray(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
    const plain = decryptPage(page, i === 0);
    plain.copy(out, i * PAGE_SIZE + (i === 0 ? 16 : 0));
  }
  // 密钥不对时解出的首页不会是合法 SQLite 头，用这个判断而不是逐页验 HMAC（快得多）
  if (out.readUInt16BE(16) !== PAGE_SIZE || out[20] !== RESERVED) {
    throw new Error('Trae 数据库解密失败：密钥可能已随 Trae 版本更新而失效');
  }
  const withWal = applyWal(out, srcPath);
  const finalBuf = isSelfConsistent(withWal) ? withWal
    : isSelfConsistent(out) ? out
      : (() => { throw new Error('Trae 数据库镜像不完整（可能正在 checkpoint）'); })();
  const dest = `${state.cachePath}.${INSTANCE_ID}-${Date.now().toString(36)}.sqlite`;
  const tmp = `${dest}.tmp`;
  try {
    fs.writeFileSync(tmp, finalBuf);
    // Windows 上刚写完的文件可能被 Defender 短暂锁住，rename 会 EPERM，重试几次
    let renamed = false;
    for (let attempt = 0; attempt < 5 && !renamed; attempt++) {
      try {
        fs.renameSync(tmp, dest);
        renamed = true;
      } catch (e: any) {
        if (attempt === 4) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
    return dest;
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

interface CacheMeta {
  cache: string;
  srcMtime: number;
  srcSize: number;
  walMtime: number;
  walSize: number;
}

function readMeta(): CacheMeta | null {
  try {
    const m = JSON.parse(fs.readFileSync(state.metaPath, 'utf-8'));
    if (!m || typeof m.cache !== 'string' || !m.cache) return null;
    return { cache: m.cache, srcMtime: Number(m.srcMtime), srcSize: Number(m.srcSize), walMtime: Number(m.walMtime), walSize: Number(m.walSize) };
  } catch {
    return null;
  }
}

/** 缓存新鲜度靠 meta 文件精确判断（Trae 只写 WAL 时主库可以长时间不动） */
function cacheUpToDate(meta: CacheMeta | null, srcStat: fs.Stats, walStat: fs.Stats | null): boolean {
  if (!meta) return false;
  if (meta.srcMtime !== srcStat.mtimeMs) return false;
  if (meta.srcSize !== srcStat.size) return false;
  if (meta.walMtime !== (walStat?.mtimeMs ?? 0)) return false;
  if (meta.walSize !== (walStat?.size ?? 0)) return false;
  try {
    return fs.statSync(meta.cache).size >= Math.floor(srcStat.size / PAGE_SIZE) * PAGE_SIZE;
  } catch {
    return false;
  }
}

function writeMeta(meta: CacheMeta): void {
  const tmp = `${state.metaPath}.${INSTANCE_ID}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(meta));
    fs.renameSync(tmp, state.metaPath);
  } catch (e: any) {
    LOG('写 meta 失败:', String(e?.message || e).slice(0, 100));
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

function unlinkQuiet(p: string): void {
  try { fs.unlinkSync(p); } catch {}
}

function unlinkCacheFiles(p: string): void {
  if (!p) return;
  unlinkQuiet(p);
  unlinkQuiet(`${p}-shm`);
  unlinkQuiet(`${p}-wal`);
}

let lastSweepMs = 0;
function sweepStaleCaches(keep: string[], force = false): void {
  if (!force && Date.now() - lastSweepMs < 10 * 60_000) return;
  lastSweepMs = Date.now();
  const dir = path.dirname(state.cachePath);
  const base = path.basename(state.cachePath);
  const keepSet = new Set(keep.filter(Boolean));
  const now = Date.now();
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(base + '.')) continue;
    const p = path.join(dir, name);
    if (keepSet.has(p)) continue;
    try {
      const st = fs.statSync(p);
      const isTmp = name.endsWith('.tmp');
      if (now - st.mtimeMs > (isTmp ? 5 * 60_000 : 30 * 60_000)) unlinkCacheFiles(p);
    } catch {}
  }
}

function openCache(cachePath: string): DatabaseSync | null {
  if (!cachePath) return null;
  try {
    return new DatabaseSync(cachePath, { readOnly: true });
  } catch (e: any) {
    LOG('打开明文缓存失败，作废重解:', String(e?.message || e).slice(0, 100));
    unlinkCacheFiles(cachePath);
    return null;
  }
}

function ensurePlainDb(): DatabaseSync {
  const stat = fs.statSync(state.srcPath);
  let walStat: fs.Stats | null = null;
  try { walStat = fs.statSync(state.srcPath + '-wal'); } catch { /* 非 wal 模式 */ }
  const wm = walStat?.mtimeMs ?? 0;
  const ws = walStat?.size ?? -1;
  if (state.db && stat.mtimeMs === state.srcMtimeMs && stat.size === state.srcSize && wm === state.walMtimeMs && ws === state.walSize) {
    return state.db;
  }
  state.db?.close();
  state.db = null;
  const meta = readMeta();
  if (cacheUpToDate(meta, stat, walStat)) {
    const reused = openCache(meta!.cache);
    if (reused) {
      state.db = reused;
      state.activePath = meta!.cache;
      state.srcMtimeMs = stat.mtimeMs;
      state.srcSize = stat.size;
      state.walMtimeMs = wm;
      state.walSize = ws;
      return state.db;
    }
  }
  if (Date.now() - state.lastDecryptMs < MIN_REFRESH_MS) {
    const stalePath = state.activePath || meta?.cache || '';
    const stale = openCache(stalePath);
    if (stale) {
      state.db = stale;
      state.activePath = stalePath;
      return state.db;
    }
  }
  const prev = meta?.cache || '';
  const next = decryptToFile(state.srcPath);
  state.lastDecryptMs = Date.now();
  state.activePath = next;
  writeMeta({ cache: next, srcMtime: stat.mtimeMs, srcSize: stat.size, walMtime: wm, walSize: ws < 0 ? 0 : ws });
  sweepStaleCaches([next]);
  if (prev && prev !== next) unlinkCacheFiles(prev);
  state.srcMtimeMs = stat.mtimeMs;
  state.srcSize = stat.size;
  state.walMtimeMs = wm;
  state.walSize = ws;
  const db = openCache(next);
  if (!db) throw new Error('Trae 明文缓存解出来后打不开');
  state.db = db;
  return db;
}

// ── 会话列表 ──────────────────────────────────────────────────────

function listSessions(projectDir: string): SessionInfo[] {
  const db = ensurePlainDb();
  const rows = db.prepare(
    `SELECT s.session_id, s.session_title, s.created_at, s.updated_at, p.absolute_path
     FROM chat_session s
     LEFT JOIN session_project sp ON sp.session_id = s.session_id
     LEFT JOIN project p ON p.project_id = sp.project_id
     WHERE s.deleted_at = 0
     ORDER BY s.updated_at DESC`,
  ).all() as any[];
  const counts = db.prepare(
    `SELECT session_id, count(*) AS c FROM chat_message WHERE deleted_at = 0 GROUP BY session_id`,
  ).all() as any[];
  const countMap = new Map(counts.map((r) => [r.session_id, Number(r.c)]));
  return rows
    .filter((r) => !projectDir || (r.absolute_path && sameDir(r.absolute_path, projectDir)))
    .map((r) => ({
      id: r.session_id,
      label: r.session_title || '',
      file: r.session_id,
      messageCount: countMap.get(r.session_id) || 0,
      // Trae 的时间戳是秒
      createdAt: new Date(Number(r.created_at) * 1000).toISOString(),
      updatedAt: new Date(Number(r.updated_at) * 1000).toISOString(),
      projectDir: r.absolute_path || '',
    }));
}

// ── 探针 ──────────────────────────────────────────────────────────

/** 探针：活跃窗口附近有写入的会话（ts 毫秒）。源库没变时 ensurePlainDb 只是 stat + 小查询 */
function probeSessions(cutoffSec: number): Array<{ id: string; ts: number }> {
  const db = ensurePlainDb();
  const rows = db.prepare(
    `SELECT session_id, updated_at FROM chat_session
     WHERE deleted_at = 0 AND updated_at > ?`,
  ).all(cutoffSec) as any[];
  return rows.map((r) => ({ id: String(r.session_id), ts: Number(r.updated_at) * 1000 }));
}

// ── 历史消息 ──────────────────────────────────────────────────────

interface TraeRawMessage {
  role: string;
  content: Array<{ type: string; text?: string }>;
}

/** 提取真实用户输入：优先 <user_input> 标签，其余剥掉 system-reminder 注入块 */
function extractUserText(raw: TraeRawMessage[]): string {
  const tagged: string[] = [];
  const plain: string[] = [];
  for (const m of raw) {
    if (m.role !== 'user') continue;
    for (const part of m.content || []) {
      const text = part.text || '';
      if (!text) continue;
      const matches = [...text.matchAll(/<user_input>([\s\S]*?)<\/user_input>/g)];
      if (matches.length) {
        for (const match of matches) tagged.push(match[1]);
      } else if (!text.includes('<system-reminder>')) {
        plain.push(text);
      }
    }
  }
  const merged = tagged.length ? tagged.join('\n') : plain.join('\n');
  return merged.trim();
}

function collectToolResult(raw: TraeRawMessage[]): string {
  for (const m of raw) {
    if (m.role !== 'tool') continue;
    for (const part of m.content || []) {
      if (part.text) return part.text;
    }
  }
  return '';
}

function loadSessionMessages(sessionId: string): SerializedMessage[] {
  const db = ensurePlainDb();
  // chat_message 是消息骨架，history_v2 是每步的快照，content_source 记录该步由哪个动作产生
  const skeleton = db.prepare(
    `SELECT message_id, message_role, created_at FROM chat_message
     WHERE session_id = ? AND deleted_at = 0 ORDER BY message_index`,
  ).all(sessionId) as any[];
  const historyRows = db.prepare(
    `SELECT message_id, content_source, messages FROM history_v2
     WHERE session_id = ? AND deleted_at = 0 ORDER BY id`,
  ).all(sessionId) as any[];

  const historyByMessage = new Map<string, Array<{ source: string; raw: TraeRawMessage[] }>>();
  for (const row of historyRows) {
    let raw: TraeRawMessage[];
    try {
      raw = JSON.parse(row.messages)?.raw_messages || [];
    } catch {
      continue;
    }
    const list = historyByMessage.get(row.message_id) || [];
    list.push({ source: String(row.content_source || ''), raw });
    historyByMessage.set(row.message_id, list);
  }

  const out: SerializedMessage[] = [];
  for (const msg of skeleton) {
    const rows = historyByMessage.get(msg.message_id) || [];
    const role = msg.message_role === 'user' ? 'user' : 'assistant';
    const timestamp = Number(msg.created_at) * 1000;

    if (role === 'user') {
      const text = extractUserText(rows[0]?.raw || rows[1]?.raw || []);
      if (!text) continue;
      out.push({ role, content: text, timestamp });
      continue;
    }

    // assistant：把逐步快照拼成"叙述 + 工具序列 + 最终回答"
    const texts: string[] = [];
    const tools: SerializedMessage['tools'] = [];
    for (const row of rows) {
      const isTool = row.source && row.source !== 'user_input' && row.source !== 'llm_default';
      if (isTool) {
        tools.push({ name: row.source, args: '', result: collectToolResult(row.raw), status: 'done' });
      }
      for (const m of row.raw) {
        if (m.role !== 'assistant') continue;
        for (const part of m.content || []) {
          if (part.type === 'text' && part.text?.trim()) {
            const last = texts[texts.length - 1];
            if (last !== part.text) texts.push(part.text); // 连续快照会重复同一段叙述，去重
          }
        }
      }
    }
    const content = texts.join('\n\n');
    if (!content && !tools.length) continue;
    out.push({
      role,
      content,
      tools: tools.length ? tools : undefined,
      timestamp,
    });
  }
  return out;
}

// ── worker 入口 ───────────────────────────────────────────────────

if (parentPort) {
  parentPort.on('message', (msg: { id: number; op: string; args?: any }) => {
    const { id, op, args } = msg;
    try {
      if (op === 'init') {
        state.srcPath = String(args?.srcPath || '');
        state.cachePath = String(args?.cachePath || '');
        state.metaPath = state.cachePath + '.meta.json';
        ensurePlainDb();
        sweepStaleCaches([state.activePath, `${state.cachePath}.meta.json`], true);
        parentPort!.postMessage({ id, result: { ok: true } });
        return;
      }
      if (!state.srcPath) throw new Error('Trae worker 未初始化');
      const result = op === 'list'
        ? listSessions(String(args?.projectDir || ''))
        : op === 'probe'
          ? probeSessions(Number(args?.cutoffSec || 0))
          : loadSessionMessages(String(args?.sessionId || ''));
      parentPort!.postMessage({ id, result });
    } catch (e: any) {
      parentPort!.postMessage({ id, error: String(e?.message || e) });
    }
  });
}
