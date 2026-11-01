import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HubCollector, SerializedMessage, SessionInfo } from '../types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-CLAUDE]', msg, ...args);

interface ClaudeFileInfo {
  cwd: string;
  label: string;
}

/**
 * claude-code 采集：扫 ~/.claude/projects/<encoded-dir>/*.jsonl。
 * cwd/标题从文件头部提取（不解析正文）；消息自包含解析 JSONL。
 */
export class ClaudeCodeCollector implements HubCollector {
  readonly tool = 'claude-code';
  private readonly cache = new Map<string, { mtimeMs: number; size: number; info: ClaudeFileInfo }>();
  /** sessionId → 所在 jsonl 路径（loadMessages 用） */
  private readonly bySession = new Map<string, string>();

  private projectsRoot(): string {
    return path.join(os.homedir(), '.claude', 'projects');
  }

  async listAll(): Promise<SessionInfo[]> {
    const root = this.projectsRoot();
    if (!fs.existsSync(root)) return [];
    const out: SessionInfo[] = [];
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      return [];
    }
    for (const encoded of dirs) {
      const dirPath = path.join(root, encoded);
      let files: string[];
      try {
        files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const full = path.join(dirPath, f);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        const cached = this.cache.get(full);
        let info: ClaudeFileInfo;
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          info = cached.info;
        } else {
          info = this.probeFile(full, stat);
          this.cache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, info });
        }
        if (!info.cwd) continue; // 空壳文件（queue-operation 之类）不采集
        const sessionId = f.replace(/\.jsonl$/, '');
        this.bySession.set(sessionId, full);
        out.push({
          id: sessionId,
          file: sessionId,
          label: info.label,
          messageCount: 0,
          createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
          updatedAt: new Date(stat.mtimeMs).toISOString(),
          projectDir: info.cwd,
        });
      }
    }
    return out;
  }

  /** 只读文件头部：cwd 和 summary 标题一般都在前几 KB；mtime 作为 updated_at */
  private probeFile(full: string, stat: fs.Stats): ClaudeFileInfo {
    const info: ClaudeFileInfo = { cwd: '', label: '' };
    let head: string;
    try {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(Math.min(96 * 1024, stat.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.toString('utf-8');
    } catch {
      return info;
    }
    const cwdMatch = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (cwdMatch) {
      try { info.cwd = JSON.parse(`"${cwdMatch[1]}"`); } catch { info.cwd = ''; }
    }
    const summaryMatch = head.match(/"type"\s*:\s*"summary"[^\n]*?"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (summaryMatch) {
      try { info.label = JSON.parse(`"${summaryMatch[1]}"`); } catch { /* 标题提取失败无所谓 */ }
    }
    return info;
  }

  async loadMessages(session: SessionInfo): Promise<SerializedMessage[]> {
    const file = this.bySession.get(session.id) || this.findFile(session.id);
    if (!file || !fs.existsSync(file)) return [];
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const out: SerializedMessage[] = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let entry: any;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.type !== 'user' && entry?.type !== 'assistant') continue;
        if (entry.isSidechain) continue; // 子代理转写是独立文件，主文件里的 sidechain 行跳过
        const rawMsg = entry.message;
        if (!rawMsg) continue;
        const role = entry.type === 'assistant' ? 'assistant' : 'user';
        const timestamp = Date.parse(rawMsg.timestamp || entry.timestamp) || Date.now();
        const content = rawMsg.content;
        const textParts: string[] = [];
        let thinking = '';
        const tools: SerializedMessage['tools'] = [];
        if (typeof content === 'string') {
          textParts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            switch (block.type || '') {
              case 'text':
                if (block.text) textParts.push(block.text);
                break;
              case 'thinking':
                thinking = (thinking ? thinking + '\n' : '') + (block.thinking || '');
                break;
              case 'tool_use':
                tools.push({ name: block.name || '', args: JSON.stringify(block.input || {}), status: 'done' });
                break;
              // tool_result 不采集（结果挂在后续 user 行）
            }
          }
        }
        if (!textParts.length && !thinking && !tools.length) continue;
        out.push({
          role,
          content: textParts.join('\n'),
          thinking: thinking || undefined,
          tools: tools.length ? tools : undefined,
          timestamp,
        });
      }
      return out;
    } catch (e) {
      LOG('loadMessages error:', e);
      return [];
    }
  }

  /** 轻探针：mtime 在窗口内的 jsonl（文件名即 sessionId），stat 级成本 */
  async probe(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const root = this.projectsRoot();
    if (!fs.existsSync(root)) return out;
    const cutoff = Date.now() - 10 * 60_000;
    try {
      for (const encoded of fs.readdirSync(root)) {
        const dirPath = path.join(root, encoded);
        let files: string[];
        try {
          files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
        } catch {
          continue;
        }
        for (const f of files) {
          const full = path.join(dirPath, f);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(full);
          } catch {
            continue;
          }
          if (stat.mtimeMs > cutoff) {
            out.set(f.replace(/\.jsonl$/, ''), stat.mtimeMs);
          }
        }
      }
    } catch (e) {
      LOG('probe error:', e);
    }
    return out;
  }

  private findFile(sessionId: string): string | null {
    const root = this.projectsRoot();
    if (!fs.existsSync(root)) return null;
    try {
      for (const encoded of fs.readdirSync(root)) {
        const candidate = path.join(root, encoded, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch { /* ignore */ }
    return null;
  }

  async dispose(): Promise<void> {
    this.cache.clear();
    this.bySession.clear();
  }
}
