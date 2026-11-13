import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as zlib from 'node:zlib';
import * as readline from 'node:readline';
import type { TranscriptEntry } from './types';

/**
 * 本机真实会话扫描（只读镜像，从 qihang-code-approver 移植）：
 * - Claude Code: ~/.claude/projects/<munged-cwd>/<session-uuid>.jsonl
 * - DSH: ~/.dsh/sessions/<munged-cwd>/session-<uuid>/session.v4.jsonl.zstd
 *   DSH 转录是「多帧 zstd 追加」的 JSONL（Node 的 zstd API 只解第一帧，需按帧边界手工切分）。
 */
export interface LocalSession {
  id: string;
  agent: 'claude' | 'dsh';
  cwd: string;
  projectDir: string;
  title: string;
  mtime: string;
  sizeBytes: number;
}

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DSH_SESSIONS_DIR = path.join(os.homedir(), '.dsh', 'sessions');
const LIST_LIMIT = 50;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;
const PREVIEW_CAP = 200;

function cleanText(s: string): string {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<command-name>[\s\S]*?(?:<\/command-args>|$)/g, '')
    .replace(/^Caveat:.*$/gm, '')
    .trim();
}

function contentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

// ---- Claude Code（明文 JSONL）----

function parseHead(file: string): { cwd: string; title: string } {
  let cwd = '';
  let firstUser = '';
  let summary = '';
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let j: any;
      try { j = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof j.cwd === 'string') cwd = j.cwd;
      if (!summary && j.type === 'summary' && typeof j.summary === 'string') summary = j.summary;
      if (!firstUser && j.type === 'user' && !j.isMeta && !j.isSidechain) {
        const t = cleanText(contentToText(j.message?.content));
        if (t) firstUser = t.slice(0, 100);
      }
      if (cwd && (summary || firstUser)) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { cwd, title: summary || firstUser || '未命名会话' };
}

export interface ClaudeTaskTail {
  cwd: string;
  task: string;
  durationMs: number;
  /** 转录尾部检测到的回合错误（API 报错等）；正常收口为 undefined */
  error?: string;
}

/**
 * Claude Code 的 API 错误在转录里是「整条即报错」的 assistant 消息（以 API Error 开头）。
 * 特征收窄到报错开头形态，避免把讨论 429/超时的正常任务文本误判成失败。
 */
export function detectClaudeErrorText(text: string): string | null {
  const t = (text || '').trim();
  if (!t) return null;
  if (/^API Error[: ]/i.test(t)) return t.slice(0, 200);
  if (/^(Error|错误)[:：]\s/.test(t) && /rate.?limit|429|overloaded|invalid|auth|credit|billing|quota/i.test(t)) {
    return t.slice(0, 200);
  }
  return null;
}

/**
 * Stop 钩子只给路径不给任务，回读转录尾部还原「这一回合在做什么」：
 * 从后往前找最后一条真实用户输入（工具结果 / meta / sidechain 都不算任务），
 * 耗时按该条时间戳到现在算。只允许读 ~/.claude/projects 下的 .jsonl。
 */
export async function readClaudeTaskTail(transcriptPath: string): Promise<ClaudeTaskTail> {
  const empty: ClaudeTaskTail = { cwd: '', task: '', durationMs: 0 };
  if (!transcriptPath || !transcriptPath.endsWith('.jsonl')) return empty;
  const file = path.resolve(transcriptPath);
  const root = path.resolve(PROJECTS_DIR) + path.sep;
  if (!file.startsWith(root)) return empty;

  let buf: Buffer;
  try {
    const fd = await fs.promises.open(file, 'r');
    try {
      const { size } = await fd.stat();
      const len = Math.min(size, TAIL_BYTES);
      buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, size - len);
    } finally {
      await fd.close();
    }
  } catch {
    return empty;
  }

  let cwd = '';
  // 尾部最后一条 assistant 消息文本：API 报错时整条即错误信息，做失败判定用
  let lastAssistantText = '';
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    if (!cwd && typeof j.cwd === 'string') cwd = j.cwd;
    if (!lastAssistantText && j.type === 'assistant' && !j.isSidechain) {
      const t = cleanText(contentToText(j.message?.content));
      if (t) lastAssistantText = t;
    }
    if (j.type !== 'user' || j.isMeta || j.isSidechain) continue;
    const text = cleanText(contentToText(j.message?.content));
    if (!text) continue;
    const at = Date.parse(typeof j.timestamp === 'string' ? j.timestamp : '');
    return {
      cwd,
      task: text.slice(0, 500),
      durationMs: Number.isFinite(at) ? Math.max(0, Date.now() - at) : 0,
      error: detectClaudeErrorText(lastAssistantText) || undefined,
    };
  }
  // 长会话里原始任务可能已被挤出尾窗：回退读文件头部，取第一条真实用户消息当任务
  try {
    const fd = await fs.promises.open(file, 'r');
    try {
      const head = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fd.read(head, 0, head.length, 0);
      for (const line of head.subarray(0, bytesRead).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let j: any;
        try { j = JSON.parse(line); } catch { continue; }
        if (!cwd && typeof j.cwd === 'string') cwd = j.cwd;
        if (j.type !== 'user' || j.isMeta || j.isSidechain) continue;
        const text = cleanText(contentToText(j.message?.content));
        if (!text) continue;
        const at = Date.parse(typeof j.timestamp === 'string' ? j.timestamp : '');
        return {
          cwd,
          task: text.slice(0, 500),
          durationMs: Number.isFinite(at) ? Math.max(0, Date.now() - at) : 0,
        };
      }
    } finally {
      await fd.close();
    }
  } catch { /* 头部读不到就维持空 */ }
  return { cwd, task: '', durationMs: 0 };
}

function scanClaudeSessions(): LocalSession[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const candidates: { file: string; dir: string; stat: fs.Stats }[] = [];
  for (const dir of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(PROJECTS_DIR, dir.name);
    for (const f of fs.readdirSync(dirPath)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dirPath, f);
      let stat: fs.Stats;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      candidates.push({ file, dir: dir.name, stat });
    }
  }
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return candidates.slice(0, LIST_LIMIT).map((c) => {
    const head = parseHead(c.file);
    return {
      id: path.basename(c.file).replace(/\.jsonl$/, ''),
      agent: 'claude' as const,
      cwd: head.cwd || c.dir,
      projectDir: c.dir,
      title: head.title,
      mtime: c.stat.mtime.toISOString(),
      sizeBytes: c.stat.size,
    };
  });
}

// ---- DSH（多帧 zstd JSONL）----

/** 按帧边界切分多帧 zstd 文件；尾帧截断（进程中断的残尾）直接丢弃 */
function splitZstdFrames(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length
    && buf[pos] === 0x28 && buf[pos + 1] === 0xB5 && buf[pos + 2] === 0x2F && buf[pos + 3] === 0xFD) {
    const start = pos;
    pos += 4;
    const fhd = buf[pos++];
    const singleSeg = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    if (!singleSeg) pos += 1;
    pos += [0, 1, 2, 4][dictFlag];
    pos += (singleSeg ? [1, 2, 4, 8] : [0, 2, 4, 8])[(fhd >> 6) & 3];
    let last = false;
    while (!last) {
      if (pos + 3 > buf.length) return frames;
      const bh = buf.readUIntLE(pos, 3);
      pos += 3;
      last = (bh & 1) === 1;
      const type = (bh >> 1) & 3;
      pos += type === 1 ? 1 : bh >>> 3;
    }
    if (checksum) pos += 4;
    if (pos > buf.length) return frames;
    frames.push(buf.subarray(start, pos));
  }
  return frames;
}

function readDshEvents(file: string): any[] {
  let buf: Buffer;
  try { buf = fs.readFileSync(file); } catch { return []; }
  const events: any[] = [];
  for (const frame of splitZstdFrames(buf)) {
    let text: string;
    try { text = zlib.zstdDecompressSync(frame).toString('utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* 忽略坏行 */ }
    }
  }
  return events;
}

function parseDshHead(file: string): { cwd: string; title: string } {
  let cwd = '';
  let firstUser = '';
  let title = '';
  for (const j of readDshEvents(file)) {
    if (!cwd && j.type === 'session' && typeof j.cwd === 'string') cwd = j.cwd;
    if (!firstUser && j.type === 'user/message' && j.data?.source?.kind === 'user') {
      const t = cleanText(contentToText(j.data?.content));
      if (t) firstUser = t.slice(0, 100);
    }
    if (j.type === 'session/title' && typeof j.data?.title === 'string' && j.data.title) title = j.data.title;
    if (cwd && title && firstUser) break;
  }
  return { cwd, title: title || firstUser || '未命名会话' };
}

function scanDshSessions(): LocalSession[] {
  if (!fs.existsSync(DSH_SESSIONS_DIR)) return [];
  const candidates: { file: string; id: string; dir: string; stat: fs.Stats }[] = [];
  for (const dir of fs.readdirSync(DSH_SESSIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(DSH_SESSIONS_DIR, dir.name);
    for (const s of fs.readdirSync(dirPath)) {
      if (!s.startsWith('session-')) continue;
      const file = path.join(dirPath, s, 'session.v4.jsonl.zstd');
      let stat: fs.Stats;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      candidates.push({ file, id: s, dir: dir.name, stat });
    }
  }
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return candidates.slice(0, LIST_LIMIT).map((c) => {
    const head = parseDshHead(c.file);
    return {
      id: c.id,
      agent: 'dsh' as const,
      cwd: head.cwd || c.dir,
      projectDir: c.dir,
      title: head.title,
      mtime: c.stat.mtime.toISOString(),
      sizeBytes: c.stat.size,
    };
  });
}

export function scanLocalSessions(): LocalSession[] {
  const merged = [...scanClaudeSessions(), ...scanDshSessions()];
  merged.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
  return merged.slice(0, LIST_LIMIT);
}

export function findLocalSessionFile(id: string): string | null {
  // DSH id 是目录名 session-<uuid>（含非 hex 字符，单独校验）
  if (id.startsWith('session-')) {
    if (!/^session-[0-9a-fA-F-]{8,64}$/.test(id)) return null;
    if (!fs.existsSync(DSH_SESSIONS_DIR)) return null;
    for (const dir of fs.readdirSync(DSH_SESSIONS_DIR)) {
      const file = path.join(DSH_SESSIONS_DIR, dir, id, 'session.v4.jsonl.zstd');
      if (fs.existsSync(file)) return file;
    }
    return null;
  }
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return null;
  if (!fs.existsSync(PROJECTS_DIR)) return null;
  for (const dir of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(PROJECTS_DIR, dir.name, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function readDshTranscript(file: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const j of readDshEvents(file)) {
    const ts = typeof j.time === 'number' ? new Date(j.time).toISOString() : '';
    const push = (kind: TranscriptEntry['kind'], text: string) => {
      if (!text) return;
      entries.push({ ts, kind, text });
      if (entries.length > PREVIEW_CAP) entries.shift();
    };
    if (j.type === 'user/message' && j.data?.source?.kind === 'user') {
      const t = cleanText(contentToText(j.data?.content)).slice(0, 2000);
      if (t) push('text', `用户：${t}`);
    } else if (j.type === 'assistant/message') {
      const blocks = j.data?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (b?.type === 'text' && b.text) push('text', b.text);
        else if (b?.type === 'reasoning' && b.text) push('thinking', b.text);
      }
    } else if (j.type === 'tool/call') {
      push('tool', `▶ ${j.data?.name || 'tool'} ${String(j.data?.arguments || '').slice(0, 300)}`);
    }
  }
  return entries;
}

export async function readLocalTranscript(id: string): Promise<TranscriptEntry[]> {
  const file = findLocalSessionFile(id);
  if (!file) throw new Error(`找不到会话文件: ${id}`);
  if (id.startsWith('session-')) return readDshTranscript(file);
  const entries: TranscriptEntry[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.isMeta || j.isSidechain) continue;
    const ts = typeof j.timestamp === 'string' ? j.timestamp : '';
    const push = (kind: TranscriptEntry['kind'], text: string) => {
      if (!text) return;
      entries.push({ ts, kind, text });
      if (entries.length > PREVIEW_CAP) entries.shift();
    };
    if (j.type === 'user') {
      const t = cleanText(contentToText(j.message?.content)).slice(0, 2000);
      if (t) push('text', `用户：${t}`);
    } else if (j.type === 'assistant') {
      const content = j.message?.content;
      if (typeof content === 'string') { push('text', content); continue; }
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === 'text' && b.text) push('text', b.text);
        else if (b?.type === 'thinking' && b.thinking) push('thinking', b.thinking);
        else if (b?.type === 'tool_use') push('tool', `▶ ${b.name} ${JSON.stringify(b.input ?? {}).slice(0, 300)}`);
      }
    }
  }
  return entries;
}
