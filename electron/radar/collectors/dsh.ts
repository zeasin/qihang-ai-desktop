import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fzstd from 'fzstd';
import type { HubCollector, SerializedMessage, SessionInfo } from '../types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-DSH]', msg, ...args);

type ZstdDecompress = (buf: Buffer) => Promise<Uint8Array> | Uint8Array;

let nativeZstd: ZstdDecompress | null = null;
let nativeChecked = false;

/** 原生 zstd 是可选加速（~100MB/s+），没装就用纯 JS 的 fzstd 兜底（慢但可用） */
async function getZstd(): Promise<ZstdDecompress> {
  if (!nativeChecked) {
    nativeChecked = true;
    try {
      // 可选依赖未安装（变量 specifier 让 tsc 跳过模块解析），失败走 fzstd 兜底
      const specifier = '@mongodb-js/zstd';
      const mod: any = await import(specifier);
      if (mod?.decompress) nativeZstd = mod.decompress as ZstdDecompress;
    } catch {
      LOG('native zstd not installed, using fzstd fallback');
    }
  }
  return (buf: Buffer) => (nativeZstd ? nativeZstd(buf) : fzstd.decompress(buf));
}

/**
 * 解压会话日志：dsh 的日志是逐条 flush 的多帧 zstd，Node 内置 zlib 只解第一帧。
 * dsh 会话根：~/.dsh/sessions/<cwd-slug>/session-xxx/session.vN.jsonl.zstd
 */
export class DshCollector implements HubCollector {
  readonly tool = 'dsh';
  private readonly metaCache = new Map<string, { mtimeMs: number; parsed: ParsedLog }>();

  private sessionsRoot(): string {
    return path.join(os.homedir(), '.dsh', 'sessions');
  }

  private sessionLogPaths(): string[] {
    const root = this.sessionsRoot();
    if (!fs.existsSync(root)) return [];
    const out: string[] = [];
    const SESSION_LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd'];
    for (const dir of fs.readdirSync(root)) {
      const dirPath = path.join(root, dir);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(dirPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const sess of fs.readdirSync(dirPath)) {
        const sessDir = path.join(dirPath, sess);
        // 会话目录有两种命名：老版 `session-<uuid>`，新版直接用裸 UUID。
        // 两种都收——日志内容里的 id 才是权威值，目录名只用来定位文件。
        if (!/^(session-)?[0-9a-f-]{36}$/.test(sess)) continue;
        // 同一会话可能同时留有 v3/v4 文件，取最新版本
        const found = SESSION_LOG_NAMES.map((n) => path.join(sessDir, n)).find((p) => fs.existsSync(p));
        if (found) out.push(found);
      }
    }
    return out;
  }

  /** 只解到能拿到 meta/title/messageCount 为止（标题一般在文件前部，读到即停） */
  private async parseLogMeta(file: string): Promise<ParsedLog> {
    const stat = fs.statSync(file);
    const cached = this.metaCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.parsed;

    const parsed: ParsedLog = { meta: null, title: '', messageCount: 0 };
    try {
      const decompress = await getZstd();
      const raw = await decompress(fs.readFileSync(file));
      const lines = Buffer.from(raw).toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        let evt: DshSessionEvent;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type === 'session') {
          // session 元信息在事件顶层：{"type":"session","id":...,"cwd":...,"createdAt":...}
          const meta = evt.data || evt;
          parsed.meta = {
            id: String(meta.id || ''),
            cwd: String(meta.cwd || ''),
            createdAt: Number(meta.createdAt || stat.birthtimeMs),
          };
        } else if (evt.type === 'session/title' && evt.data?.title && !parsed.title) {
          parsed.title = String(evt.data.title);
        } else if (evt.type === 'user/message') {
          parsed.messageCount += 1;
          if (!parsed.title) {
            const firstText = (evt.data?.content || []).find((c: any) => c.type === 'text')?.text;
            if (firstText) parsed.title = String(firstText).slice(0, 200);
          }
        }
        if (parsed.meta?.id && parsed.title) break;
      }
    } catch (e) {
      LOG('parseLogMeta error:', file, e);
    }
    this.metaCache.set(file, { mtimeMs: stat.mtimeMs, parsed });
    return parsed;
  }

  async listAll(): Promise<SessionInfo[]> {
    const out: SessionInfo[] = [];
    for (const file of this.sessionLogPaths()) {
      const parsed = await this.parseLogMeta(file);
      if (!parsed.meta?.id) continue;
      if (parsed.messageCount === 0) continue; // 空会话（开了没说话）不进列表
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch {}
      out.push({
        id: parsed.meta.id,
        label: parsed.title || '',
        file,
        messageCount: parsed.messageCount,
        createdAt: new Date(parsed.meta.createdAt).toISOString(),
        updatedAt: new Date(mtimeMs).toISOString(),
        projectDir: parsed.meta.cwd || '',
      });
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out;
  }

  async loadMessages(session: SessionInfo): Promise<SerializedMessage[]> {
    let file = session.file;
    if (!fs.existsSync(file)) {
      const found = (await this.listAll()).find((s) => s.id === session.id);
      if (!found) return [];
      file = found.file;
    }
    const messages: SerializedMessage[] = [];
    const pendingTools: { name: string; args?: string; result?: string; status?: string; callId?: string }[] = [];
    try {
      const decompress = await getZstd();
      const raw = await decompress(fs.readFileSync(file));
      const lines = Buffer.from(raw).toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        let evt: DshSessionEvent;
        try { evt = JSON.parse(line); } catch { continue; }
        const ts = Number(evt.time || Date.now());
        if (evt.type === 'user/message') {
          const content = evt.data?.content || [];
          const text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
          messages.push({ role: 'user', content: text, timestamp: ts });
        } else if (evt.type === 'assistant/message') {
          const content = evt.data?.message?.content || [];
          const text = content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
          const thinking = content.filter((c: any) => c.type === 'reasoning').map((c: any) => c.text).join('\n');
          messages.push({
            role: 'assistant',
            content: text,
            thinking: thinking || undefined,
            tools: pendingTools.length ? [...pendingTools] as SerializedMessage['tools'] : undefined,
            timestamp: ts,
          });
          pendingTools.length = 0;
        } else if (evt.type === 'tool/call') {
          pendingTools.push({
            name: String(evt.data?.name || ''),
            args: String(evt.data?.arguments || ''),
            status: 'running',
            callId: String(evt.data?.callId || ''),
          });
        } else if (evt.type === 'tool/result') {
          const callId = evt.data?.message?.source?.callId || evt.data?.message?.toolCallId || '';
          const result = textOf(evt.data?.message?.content || []);
          const isError = !!evt.data?.message?.isError;
          const target = (callId && pendingTools.find((t) => t.callId === callId))
            || [...pendingTools].reverse().find((t) => t.status === 'running');
          if (target) {
            target.result = result;
            target.status = isError ? 'error' : 'done';
          }
        }
      }
    } catch (e) {
      LOG('loadMessages error:', e);
    }
    return messages;
  }

  /** 轻探针：mtime 在窗口内的会话文件；id 走 meta 缓存（首次一个文件解压一次） */
  async probe(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const cutoff = Date.now() - 10 * 60_000;
    try {
      for (const file of this.sessionLogPaths()) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (stat.mtimeMs <= cutoff) continue;
        const parsed = await this.parseLogMeta(file);
        if (parsed.meta?.id) out.set(parsed.meta.id, stat.mtimeMs);
      }
    } catch (e) {
      LOG('probe error:', e);
    }
    return out;
  }

  async dispose(): Promise<void> {
    this.metaCache.clear();
  }
}

interface DshSessionEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: any;
}

interface ParsedLog {
  meta: { id: string; cwd: string; createdAt: number } | null;
  title: string;
  messageCount: number;
}

function textOf(content: any[]): string {
  return (content || [])
    .filter((c) => c && (c.type === 'text' || c.type === 'reasoning') && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}
