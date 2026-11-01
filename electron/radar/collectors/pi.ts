import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HubCollector, SerializedMessage, SessionInfo } from '../types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-PI]', msg, ...args);

interface PiMeta {
  id: string;
  cwd: string;
  createdAtMs: number;
  label: string;
}

/**
 * pi 采集：直接扫 ~/.pi/agent/sessions/<encoded-cwd>/*.jsonl。
 * 会话元数据在文件首行 {"type":"session",...}，mtime 作 updated_at，标题取首个用户消息。
 * 消息解析自包含（不依赖 pi SDK）。
 * assistant-v2- 前缀是启航工作台自己的会话文件，雷达里已有原生对话页，不重复采集。
 */
export class PiCollector implements HubCollector {
  readonly tool = 'pi';
  private readonly cache = new Map<string, { mtimeMs: number; size: number; meta: PiMeta }>();

  private sessionsRoot(): string {
    return path.join(os.homedir(), '.pi', 'agent', 'sessions');
  }

  private listSessionFiles(dir: string): string[] {
    try {
      return fs.readdirSync(path.join(this.sessionsRoot(), dir))
        .filter((f) => f.endsWith('.jsonl') && !f.startsWith('assistant-v2-'));
    } catch {
      return [];
    }
  }

  async listAll(): Promise<SessionInfo[]> {
    const root = this.sessionsRoot();
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
    const out: SessionInfo[] = [];
    for (const dir of dirs) {
      const files = this.listSessionFiles(dir);
      for (const f of files) {
        const full = path.join(root, dir, f);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        const cached = this.cache.get(full);
        let meta: PiMeta;
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          meta = cached.meta;
        } else {
          meta = this.probeFile(full, stat);
          this.cache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
        }
        if (!meta.id) continue;
        out.push({
          id: meta.id,
          file: full,
          label: meta.label,
          messageCount: 0,
          createdAt: meta.createdAtMs
            ? new Date(meta.createdAtMs).toISOString()
            : new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
          updatedAt: new Date(stat.mtimeMs).toISOString(),
          projectDir: meta.cwd,
        });
      }
    }
    return out;
  }

  /** 只读文件头部：首行 session 元数据 + 顺带扫到首个用户消息当标题 */
  private probeFile(full: string, stat: fs.Stats): PiMeta {
    const meta: PiMeta = { id: '', cwd: '', createdAtMs: 0, label: '' };
    let head: string;
    try {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(Math.min(128 * 1024, stat.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.toString('utf-8');
    } catch {
      return meta;
    }
    const lines = head.split('\n');
    try {
      const first = JSON.parse(lines[0]);
      if (first?.type === 'session') {
        meta.id = String(first.id || '');
        meta.cwd = String(first.cwd || '');
        meta.createdAtMs = Date.parse(first.timestamp) || 0;
      }
    } catch { /* 首行残缺或非会话文件：跳过 */ }
    if (!meta.id) return meta;
    for (const line of lines.slice(1)) {
      try {
        const evt = JSON.parse(line);
        if (evt?.type !== 'message' || evt.message?.role !== 'user') continue;
        const text = (evt.message.content || [])
          .filter((c: any) => c?.type === 'text' && c.text)
          .map((c: any) => c.text)
          .join('\n');
        if (text) meta.label = text.slice(0, 80);
        break;
      } catch { continue; }
    }
    return meta;
  }

  async loadMessages(session: SessionInfo): Promise<SerializedMessage[]> {
    const file = session.file;
    if (!file || !fs.existsSync(file)) return [];
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const out: SerializedMessage[] = [];
      for (const line of lines) {
        try {
          const evt = JSON.parse(line);
          if (evt.type !== 'message' || !evt.message) continue;
          const role = evt.message.role;
          const ts = typeof evt.timestamp === 'number' ? evt.timestamp : Date.parse(evt.timestamp) || Date.now();
          if (role === 'user') {
            const textParts: string[] = [];
            for (const c of (evt.message.content || [])) {
              if (c.type === 'text') textParts.push(c.text);
            }
            if (textParts.length) out.push({ role: 'user', content: textParts.join('\n'), timestamp: ts });
          } else if (role === 'assistant') {
            const textParts: string[] = [];
            let thinking = '';
            const tools: SerializedMessage['tools'] = [];
            for (const c of (evt.message.content || [])) {
              if (c.type === 'text') textParts.push(c.text);
              else if (c.type === 'thinking') thinking = c.thinking || '';
              else if (c.type === 'toolCall') {
                tools.push({
                  name: c.name || '',
                  args: JSON.stringify(c.arguments || {}),
                  status: 'done',
                  result: c.result || '',
                });
              }
            }
            if (textParts.length || thinking || tools.length) {
              out.push({
                role: 'assistant',
                content: textParts.join('\n'),
                thinking: thinking || undefined,
                tools: tools.length ? tools : undefined,
                timestamp: ts,
              });
            }
          }
        } catch { continue; }
      }
      return out;
    } catch (e) {
      LOG('loadMessages error:', e);
      return [];
    }
  }

  /** 轻探针：mtime 在窗口内的 jsonl；sessionId 从缓存取，未缓存的做一次头部探针 */
  async probe(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const root = this.sessionsRoot();
    const cutoff = Date.now() - 10 * 60_000;
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return out;
    }
    for (const dir of dirs) {
      const files = this.listSessionFiles(dir);
      for (const f of files) {
        const full = path.join(root, dir, f);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.mtimeMs <= cutoff) continue;
        const cached = this.cache.get(full);
        let meta: PiMeta;
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          meta = cached.meta;
        } else {
          meta = this.probeFile(full, stat);
          this.cache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
        }
        if (meta.id) out.set(meta.id, stat.mtimeMs);
      }
    }
    return out;
  }

  async dispose(): Promise<void> {
    this.cache.clear();
  }
}
