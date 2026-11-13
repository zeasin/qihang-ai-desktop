import { randomUUID } from 'node:crypto';
import type { AgentKind, ApprovalRequest, Decision } from './types';
import { DECISIONS } from './types';
import type { Bus } from './bus';
import type { History } from './history';
import logger from '../services/logger';

interface PendingEntry {
  req: ApprovalRequest;
  resolve: (d: Decision) => void;
}

export interface ApprovalDeps {
  bus: Bus;
  history: History;
  /** 发审批卡到飞书，返回 message_id（失败不影响决策通道） */
  sendCard?: (req: ApprovalRequest) => Promise<string | undefined>;
  /** 决策后原位更新飞书卡片 */
  patchCard?: (req: ApprovalRequest) => Promise<void>;
}

const SUMMARY_MAX = 200;
const DETAIL_MAX = 2000;

/**
 * 挂起 TTL：各 agent 侧等待窗口（claude hook 540s、DSH/pi 插件 ≤61 分钟）都不超过 1 小时，
 * 超过即请求方已超时离开，继续挂着只会堆积「僵尸待审批」。到点按 expired 收口。
 */
const PENDING_TTL_MS = 60 * 60_000;

/**
 * 审批状态机（从 qihang-code-approver 移植）。
 * 决策不设人工超时——挂起一直等，直到有人决策或会话死亡按拒绝收口；
 * 但挂起超过 PENDING_TTL_MS 仍无人处理时按 expired 自动收口（请求方早已放弃等待）。
 * 挂起 = 一个未决 Promise；resolve() 先删 pending 再 resolve，天然幂等（双击第二次拿到 not_pending）。
 */
export class ApprovalCenter {
  private pending = new Map<string, PendingEntry>();
  private all = new Map<string, ApprovalRequest>();

  constructor(private deps: ApprovalDeps) {
    for (const r of deps.history.replay()) this.all.set(r.id, r);
  }

  /** 全量/按状态过滤的历史审批（新→旧）。无参 = 全量，保持既有调用方语义 */
  list(opts?: { status?: 'pending' | 'decided' | 'expired' }): ApprovalRequest[] {
    const all = [...this.all.values()];
    const filtered = opts?.status ? all.filter((r) => r.status === opts.status) : all;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 当前挂起待决策的审批（新→旧）。只给桌面端列表用，避开历史噪声。读时顺带清扫过时项 */
  listPending(): ApprovalRequest[] {
    this.expireStale();
    return [...this.pending.values()]
      .map((e) => e.req)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  pendingCount(): number {
    this.expireStale();
    return this.pending.size;
  }

  /** 过时审批清扫：挂起超过 TTL 的按 expired 收口（列表/计数读取时自动触发，也可手动调） */
  expireStale(): void {
    const now = Date.now();
    for (const [id, entry] of [...this.pending]) {
      const created = Date.parse(entry.req.createdAt) || 0;
      if (now - created < PENDING_TTL_MS) continue;
      this.pending.delete(id);
      const req = entry.req;
      req.status = 'expired';
      req.decidedAt = new Date().toISOString();
      req.decidedBy = 'ttl-expired';
      this.deps.history.append({ type: 'expired', at: req.decidedAt, id, by: 'ttl-expired' });
      this.deps.bus.emit({ type: 'approval.decided', request: req });
      if (req.feishuMessageId && this.deps.patchCard) {
        this.deps.patchCard(req).catch((e: any) => logger.error('[Approver] 过期卡片更新失败: %s', e?.message || e));
      }
      // 请求方若还在挂起等决策（窗口内）：按 deny 收口（fail-closed 口径），让其尽快继续
      entry.resolve('deny');
      logger.info('[Approver] 过时审批已过期收口 %s（挂起超 60 分钟无人处理）', id.slice(0, 8));
    }
  }

  /** adapter / 外部 hook 调用：挂起等待决策。发卡失败不影响决策通道 */
  async request(input: {
    agent: AgentKind;
    sessionId: string;
    cwd: string;
    tool: string;
    inputSummary: string;
    detail: string;
  }): Promise<Decision> {
    const req: ApprovalRequest = {
      id: randomUUID(),
      agent: input.agent,
      sessionId: input.sessionId,
      cwd: input.cwd,
      tool: input.tool,
      inputSummary: input.inputSummary.slice(0, SUMMARY_MAX),
      detail: input.detail.slice(0, DETAIL_MAX),
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    this.all.set(req.id, req);
    this.deps.history.append({ type: 'submitted', at: req.createdAt, request: req });
    this.deps.bus.emit({ type: 'approval.required', request: req });
    logger.info('[Approver] 审批挂起 %s %s/%s %s', req.id.slice(0, 8), req.agent, req.tool, req.inputSummary.slice(0, 80));

    if (this.deps.sendCard) {
      this.deps.sendCard(req)
        .then((mid) => { if (mid) req.feishuMessageId = mid; })
        .catch((e: any) => logger.error('[Approver] 发卡失败: %s', e?.message || e));
    }

    return new Promise<Decision>((resolve) => {
      this.pending.set(req.id, { req, resolve });
    });
  }

  /** 决策统一入口（飞书按钮 / REST）；幂等 */
  resolve(id: string, decision: Decision, by: string): 'ok' | 'not_pending' {
    if (!DECISIONS.includes(decision)) return 'not_pending';
    const entry = this.pending.get(id);
    if (!entry) return 'not_pending';
    this.pending.delete(id);
    const req = entry.req;
    req.status = 'decided';
    req.decision = decision;
    req.decidedAt = new Date().toISOString();
    req.decidedBy = by;
    this.deps.history.append({ type: 'decided', at: req.decidedAt, id, decision, by });
    this.deps.bus.emit({ type: 'approval.decided', request: req });
    logger.info('[Approver] 审批决策 %s → %s（by %s）', req.id.slice(0, 8), decision, by);
    if (this.deps.patchCard) {
      this.deps.patchCard(req).catch((e: any) => logger.error('[Approver] 卡片更新失败: %s', e?.message || e));
    }
    entry.resolve(decision);
    return 'ok';
  }

  /** 会话死亡/中止：该会话挂起中的审批按拒绝收口 */
  cancelBySession(sessionId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.req.sessionId === sessionId) this.resolve(id, 'deny', 'session-closed');
    }
  }

  /** dsh 会话级放行（allowlist）命中的自动应答：不挂起，直接落一条已决记录供审计 */
  recordAutoAllowed(input: { agent: AgentKind; sessionId: string; cwd: string; tool: string; inputSummary: string; detail: string }): void {
    const now = new Date().toISOString();
    const req: ApprovalRequest = {
      id: randomUUID(),
      agent: input.agent,
      sessionId: input.sessionId,
      cwd: input.cwd,
      tool: input.tool,
      inputSummary: input.inputSummary.slice(0, SUMMARY_MAX),
      detail: input.detail.slice(0, DETAIL_MAX),
      createdAt: now,
      status: 'decided',
      decision: 'allow_session',
      decidedAt: now,
      decidedBy: 'session-allowlist',
    };
    this.all.set(req.id, req);
    this.deps.history.append({ type: 'submitted', at: now, request: req });
    this.deps.history.append({ type: 'decided', at: now, id: req.id, decision: 'allow_session', by: 'session-allowlist' });
  }
}
