import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApprovalRequest } from './types';

type HistoryEvent =
  | { type: 'submitted'; at: string; request: ApprovalRequest }
  | { type: 'decided'; at: string; id: string; decision: string; by: string }
  | { type: 'expired'; at: string; id: string; by: string };

/**
 * JSONL 追加审计（从 qihang-code-approver 移植）：
 * 重启后 replay() 重建审批列表；残留 pending 一律置 expired（权威句柄已随进程死）。
 */
export class History {
  private file: string;

  constructor(file: string) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  append(ev: HistoryEvent): void {
    try {
      fs.appendFileSync(this.file, JSON.stringify(ev) + '\n', 'utf8');
    } catch { /* 审计失败不阻断审批主流程 */ }
  }

  /** 重建审批列表；进程重启前的 pending 无处可决，标 expired */
  replay(): ApprovalRequest[] {
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const list = new Map<string, ApprovalRequest>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev: HistoryEvent;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'submitted') {
        list.set(ev.request.id, ev.request);
      } else if (ev.type === 'decided') {
        const req = list.get(ev.id);
        if (req) {
          req.status = 'decided';
          req.decision = ev.decision as ApprovalRequest['decision'];
          req.decidedAt = ev.at;
          req.decidedBy = ev.by;
        }
      } else if (ev.type === 'expired') {
        const req = list.get(ev.id);
        if (req) {
          req.status = 'expired';
          req.decidedAt = ev.at;
          req.decidedBy = ev.by;
        }
      }
    }
    for (const req of list.values()) {
      if (req.status === 'pending') {
        req.status = 'expired';
        req.decidedAt = new Date().toISOString();
        req.decidedBy = 'restart';
      }
    }
    return [...list.values()];
  }
}
