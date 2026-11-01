import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HubCollector, SerializedMessage, SessionInfo } from '../types';

const LOG = (msg: string, ...args: any[]) => console.log('[RADAR-CODEX]', msg, ...args);

interface CodexMeta {
  sessionId: string;
  cwd: string;
  createdAtMs: number;
  label: string;
}

interface PendingTool {
  callId: string;
  name: string;
  args?: string;
  result?: string;
  status?: string;
}

interface TurnGroup {
  thinking: string[];
  assistant: string[];
  tools: PendingTool[];
}

/**
 * codex 采集：直接扫 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl。
 * 首行 session_meta 混着巨型 base_instructions，只能探头部正则提取，不能整行 JSON.parse。
 * 消息只认 response_item 条目（event_msg 是 UI 事件，与 response_item 重复）：
 * message(user/assistant) / reasoning(summary→thinking) /
 * function_call + function_call_output（按 call_id 配对成 tools）。
 */
export class CodexCollector implements HubCollector {
  readonly tool = 'codex';
  private readonly cache = new Map<string, { mtimeMs: number; size: number; meta: CodexMeta }>();

  private sessionsRoot(): string {
    return path.join(os.homedir(), '.codex', 'sessions');
  }

  async listAll(): Promise<SessionInfo[]> {
    const files = this.listRolloutFiles(this.sessionsRoot());
    const out: SessionInfo[] = [];
    for (const full of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      const cached = this.cache.get(full);
      let meta: CodexMeta;
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        meta = cached.meta;
      } else {
        meta = this.probeFile(full, stat);
        this.cache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
      }
      if (!meta.sessionId) continue;
      out.push({
        id: meta.sessionId,
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
    return out;
  }

  /** 年/月/日三层目录；目录结构变化时靠深度上限兜住 */
  private listRolloutFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth > 0) walk(full, depth - 1);
        } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
          out.push(full);
        }
      }
    };
    walk(root, 3);
    return out;
  }

  /** 只读文件头部：session_meta 字段正则提取 + 首个真人输入的用户消息当标题 */
  private probeFile(full: string, stat: fs.Stats): CodexMeta {
    const meta: CodexMeta = { sessionId: '', cwd: '', createdAtMs: 0, label: '' };
    let head: string;
    try {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(Math.min(256 * 1024, stat.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.toString('utf-8');
    } catch {
      return meta;
    }
    // session_meta 是首行且 cwd/session_id 排在 base_instructions 之前，取首个匹配即安全
    const idMatch = head.match(/"session_id"\s*:\s*"([0-9a-fA-F-]{8,})"/);
    if (idMatch) meta.sessionId = idMatch[1];
    const cwdMatch = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (cwdMatch) {
      try { meta.cwd = JSON.parse(`"${cwdMatch[1]}"`); } catch { /* 保空 */ }
    }
    const tsMatch = head.match(/"timestamp"\s*:\s*"([^"]+)"/);
    if (tsMatch) meta.createdAtMs = Date.parse(tsMatch[1]) || 0;
    if (!meta.sessionId) return meta;
    const labelRe = /"type"\s*:\s*"message","role"\s*:\s*"user","content"\s*:\s*\[\{"type"\s*:\s*"input_text","text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    for (const m of head.matchAll(labelRe)) {
      try {
        const text = JSON.parse(`"${m[1]}"`);
        if (text && !isInjectedUserText(text)) {
          meta.label = text.slice(0, 80);
          break;
        }
      } catch { continue; }
    }
    return meta;
  }

  async loadMessages(session: SessionInfo): Promise<SerializedMessage[]> {
    let raw: string;
    try {
      raw = fs.readFileSync(session.file, 'utf-8');
    } catch {
      return [];
    }
    const messages: SerializedMessage[] = [];
    let group: TurnGroup | null = null;
    let groupTs = 0;

    const ensureGroup = (): TurnGroup => (group ??= { thinking: [], assistant: [], tools: [] });
    const flushGroup = () => {
      if (!group) return;
      const g = group;
      if (g.assistant.length || g.thinking.length || g.tools.length) {
        messages.push({
          role: 'assistant',
          content: g.assistant.join('\n\n'),
          thinking: g.thinking.length ? g.thinking.join('\n') : undefined,
          tools: g.tools as SerializedMessage['tools'],
          timestamp: groupTs || Date.now(),
        });
      }
      group = null;
    };

    for (const line of raw.split('\n')) {
      if (!line) continue;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt?.type !== 'response_item' || !evt.payload) continue;
      const p = evt.payload;
      const ts = Date.parse(evt.timestamp) || Date.now();

      if (p.type === 'message') {
        if (p.role === 'user') {
          const text = messageText(p);
          if (!text || isInjectedUserText(text)) continue;
          flushGroup();
          messages.push({ role: 'user', content: text, timestamp: ts });
        } else if (p.role === 'assistant') {
          const text = messageText(p);
          if (!text) continue;
          ensureGroup().assistant.push(text);
          groupTs = ts;
        }
        // developer/system 是注入的环境指令（含巨型权限/AGENTS 说明），不采集
      } else if (p.type === 'reasoning') {
        const parts = (p.summary || [])
          .map((x: any) => (typeof x?.text === 'string' ? x.text : ''))
          .filter(Boolean);
        if (parts.length) {
          ensureGroup().thinking.push(...parts);
          groupTs = ts;
        }
      } else if (p.type === 'function_call') {
        ensureGroup().tools.push({
          callId: String(p.call_id || ''),
          name: String(p.name || ''),
          args: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments || {}),
        });
        groupTs = ts;
      } else if (p.type === 'function_call_output') {
        const result = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
        const status = /^Exit code: [1-9]/.test(result) ? 'error' : 'done';
        this.attachOutput(messages, group, String(p.call_id || ''), result, status);
      }
    }
    flushGroup();
    return messages;
  }

  /** 输出配对：先找当前轮的工具，找不到再回溯已产出的消息（防御乱序文件） */
  private attachOutput(
    messages: SerializedMessage[],
    group: TurnGroup | null,
    callId: string,
    result: string,
    status: string,
  ): void {
    if (!callId) return;
    if (group) {
      const t = group.tools.find((x) => x.callId === callId && x.result === undefined);
      if (t) {
        t.result = result;
        t.status = status;
        return;
      }
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const tools = messages[i].tools as PendingTool[] | undefined;
      const t = tools?.find((x) => x.callId === callId && x.result === undefined);
      if (t) {
        t.result = result;
        t.status = status;
        return;
      }
    }
  }

  /** 轻探针：mtime 在窗口内的 rollout 文件；sessionId 从缓存取，未缓存的做一次头部探针 */
  async probe(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const cutoff = Date.now() - 10 * 60_000;
    for (const full of this.listRolloutFiles(this.sessionsRoot())) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs <= cutoff) continue;
      const cached = this.cache.get(full);
      let meta: CodexMeta;
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        meta = cached.meta;
      } else {
        meta = this.probeFile(full, stat);
        this.cache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
      }
      if (meta.sessionId) out.set(meta.sessionId, stat.mtimeMs);
    }
    return out;
  }

  async dispose(): Promise<void> {
    this.cache.clear();
  }
}

/** rollout 里的注入型用户消息（AGENTS.md/环境上下文/权限说明），不是真人输入 */
function isInjectedUserText(text: string): boolean {
  return text.startsWith('# AGENTS.md instructions for')
    || text.startsWith('<environment_context>')
    || text.startsWith('<user_instructions>')
    || text.startsWith('<permissions')
    || text.startsWith('<turn_context');
}

function messageText(p: any): string {
  return (p.content || [])
    .filter((c: any) => typeof c?.text === 'string' && c.text)
    .map((c: any) => c.text)
    .join('\n');
}
