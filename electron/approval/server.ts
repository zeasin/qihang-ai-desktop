import * as http from 'node:http';
import type { BusEvent } from './types';
import logger from '../services/logger';

/**
 * 审批通道本地 HTTP 服务（从 qihang-code-approver web/server.ts 移植，去掉静态面板）。
 * 对外端点（127.0.0.1）：
 *   POST /api/hooks/permission-request  Claude Code PermissionRequest hook（外部会话审批）
 *   POST /api/hooks/dsh-approval        DSH dsh-approver 插件审批转发（外部会话审批）
 *   POST /api/hooks/pi-approval         pi pi-approver-gate 扩展审批转发（外部会话审批）
 *   POST /api/hooks/task-done           外部 agent 回合结束上报（Claude Stop / DSH turn/end）
 *   POST /api/hooks/claude-stop         Claude Code Stop 快速通道：task-done 上报 + 挂起长轮询「继续」追问，
 *                                       取到返回 {"decision":"block","reason":...} 让终端原会话继续跑
 *   GET  /api/hooks/dsh-followup        DSH 插件长轮询「接着问」追问
 *   POST /api/hooks/dsh-followup        直接暂存一条追问（调试）
 *   GET  /api/hooks/pi-followup         pi 扩展长轮询「接着问」追问（与 dsh-followup 共用暂存 Map）
 *   POST /api/hooks/debug               插件侧诊断打点透传
 *   GET  /health                        健康检查
 *   GET/POST /api/sessions*、/api/approvals*、/api/local-sessions*  调试/面板用 REST
 */

export interface ApproverServerDeps {
  port: number;
  health(): Record<string, any>;
  listSessions(): any[];
  createSession(body: any): Promise<any>;
  prompt(id: string, text: string): Promise<void>;
  abortSession(id: string): Promise<void>;
  transcript(id: string): any[];
  approvals(): any[];
  decide(id: string, decision: string, by: string): 'ok' | 'not_pending';
  listChats(): Promise<any[]>;
  listLocalSessions(): any[];
  localTranscript(id: string): Promise<any[]>;
  hookPermissionRequest(body: any): Promise<any>;
  dshApprovalRequest(body: any): Promise<any>;
  piApprovalRequest(body: any): Promise<any>;
  /** 外部 agent 回合结束上报：内部发完通知即返回，不等飞书 */
  taskDone(body: any): Promise<void>;
  /** Claude Code Stop 快速通道：task-done 上报后挂起等追问，返回 Stop hook 决策（block=继续跑 / 空=正常收尾） */
  claudeStop(body: any): Promise<any>;
  /** DSH 插件长轮询「接着问」追问：无追问等 waitMs 后返回 {} */
  dshFollowupPoll(sessionId: string): Promise<{ text?: string }>;
  /** 测试用：直接暂存一条追问（免飞书卡片回调） */
  stashDshFollowup(sessionId: string, text: string): void;
  subscribe(fn: (e: BusEvent) => void): () => void;
}

function sendJson(res: http.ServerResponse, code: number, data: any): void {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

export function startApproverServer(deps: ApproverServerDeps): Promise<http.Server> {
  const sseClients = new Set<http.ServerResponse>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    try {
      // SSE 事件流
      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(':ok\n\n');
        sseClients.add(res);
        const unsubscribe = deps.subscribe((e) => {
          try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch { /* 客户端断开由 close 处理 */ }
        });
        const heartbeat = setInterval(() => {
          try { res.write(':hb\n\n'); } catch { /* ignore */ }
        }, 15000);
        res.on('close', () => {
          sseClients.delete(res);
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }

      if (pathname === '/health' && req.method === 'GET') return sendJson(res, 200, deps.health());

      // 会话（调试/REST）
      if (pathname === '/api/sessions' && req.method === 'GET') return sendJson(res, 200, deps.listSessions());
      if (pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        const session = await deps.createSession(body);
        return sendJson(res, 200, session);
      }
      let m = pathname.match(/^\/api\/sessions\/([^/]+)\/prompt$/);
      if (m && req.method === 'POST') {
        const body = await readBody(req);
        await deps.prompt(decodeURIComponent(m[1]), String(body?.text || ''));
        return sendJson(res, 200, { ok: true });
      }
      m = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
      if (m && req.method === 'POST') {
        await deps.abortSession(decodeURIComponent(m[1]));
        return sendJson(res, 200, { ok: true });
      }
      m = pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
      if (m && req.method === 'GET') return sendJson(res, 200, deps.transcript(decodeURIComponent(m[1])));

      // 审批（REST 决策通道，飞书不可用时的兜底）
      if (pathname === '/api/approvals' && req.method === 'GET') return sendJson(res, 200, deps.approvals());
      m = pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
      if (m && req.method === 'POST') {
        const body = await readBody(req);
        const result = deps.decide(decodeURIComponent(m[1]), String(body?.decision || ''), String(body?.by || 'web'));
        return sendJson(res, result === 'ok' ? 200 : 409, { result });
      }

      // 本机真实 Claude Code / DSH 会话（只读镜像）
      if (pathname === '/api/local-sessions' && req.method === 'GET') return sendJson(res, 200, deps.listLocalSessions());
      m = pathname.match(/^\/api\/local-sessions\/([^/]+)\/transcript$/);
      if (m && req.method === 'GET') return sendJson(res, 200, await deps.localTranscript(decodeURIComponent(m[1])));

      // Claude Code PermissionRequest hook 入口：挂起等决策，返回 hookSpecificOutput JSON
      if (pathname === '/api/hooks/permission-request' && req.method === 'POST') {
        const body = await readBody(req);
        const out = await deps.hookPermissionRequest(body);
        return sendJson(res, 200, out ?? {});
      }

      // DSH 审批转发入口：挂起等决策，返回 { decision }
      if (pathname === '/api/hooks/dsh-approval' && req.method === 'POST') {
        const body = await readBody(req);
        // 兼容老 dsh-approver 插件：它把 turn/end 回合收口也 POST 到本端点
        // （body 带 source=dsh + reason、无 toolName/callId），转交 task-done 处理
        if (body?.source === 'dsh' && body?.reason && !body?.toolName && !body?.callId) {
          logger.info('[Approver] task-done 到达(dsh-approval 兼容): session=%s reason=%s',
            String(body?.sessionId || '?').slice(0, 24), body?.reason);
          void deps.taskDone(body);
          return sendJson(res, 200, {});
        }
        const out = await deps.dshApprovalRequest(body);
        return sendJson(res, 200, out ?? {});
      }

      // pi 审批转发入口：pi-approver-gate 扩展阻塞等决策，返回 { decision }
      if (pathname === '/api/hooks/pi-approval' && req.method === 'POST') {
        const body = await readBody(req);
        const out = await deps.piApprovalRequest(body);
        return sendJson(res, 200, out ?? {});
      }

      // 任务回合结束通知入口：立即 200，通知异步发（钩子侧不能等）
      if (pathname === '/api/hooks/task-done' && req.method === 'POST') {
        const body = await readBody(req);
        logger.info('[Approver] task-done 到达: source=%s session=%s reason=%s',
          body?.source || body?.hook_event_name || '?',
          String(body?.sessionId || body?.session_id || '?').slice(0, 24),
          body?.reason || '?');
        void deps.taskDone(body);
        return sendJson(res, 200, {});
      }

      // Claude Code Stop 快速通道：task-done 上报 + 挂起等「继续」追问（窗口内不返回提示符属预期）
      if (pathname === '/api/hooks/claude-stop' && req.method === 'POST') {
        const body = await readBody(req);
        const out = await deps.claudeStop(body);
        return sendJson(res, 200, out ?? {});
      }

      // pi 扩展长轮询「接着问」追问：与 dsh-followup 共用同一暂存 Map（takeFollowup），语义一致
      if (pathname === '/api/hooks/pi-followup' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') || '';
        const out = await deps.dshFollowupPoll(sessionId);
        return sendJson(res, 200, out);
      }

      // DSH 插件长轮询「接着问」追问
      if (pathname === '/api/hooks/dsh-followup') {
        if (req.method === 'GET') {
          const sessionId = url.searchParams.get('sessionId') || '';
          const out = await deps.dshFollowupPoll(sessionId);
          return sendJson(res, 200, out);
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const sessionId = String(body?.sessionId || '');
          const text = String(body?.text || '');
          if (!sessionId || !text) return sendJson(res, 400, { error: '需要 sessionId 和 text' });
          deps.stashDshFollowup(sessionId, text);
          return sendJson(res, 200, { ok: true });
        }
      }

      // 调试透传：插件侧诊断打点，原样落日志
      if (pathname === '/api/hooks/debug' && req.method === 'POST') {
        const body = await readBody(req);
        logger.info('[Approver][debug] %s', JSON.stringify(body).slice(0, 300));
        return sendJson(res, 200, {});
      }

      // 飞书会话列表（选择卡片接收群用）
      if (pathname === '/api/feishu/chats' && req.method === 'GET') {
        return sendJson(res, 200, await deps.listChats());
      }

      sendJson(res, 404, { error: `no route: ${req.method} ${pathname}` });
    } catch (e: any) {
      sendJson(res, 500, { error: String(e?.message || e) });
    }
  });

  // 挂起等决策最长 HOOK_WAIT_MS(540s)：放开 Node 默认请求超时（requestTimeout 默认 300s 会掐断挂起响应）
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, '127.0.0.1', () => {
      logger.info('[Approver] http://127.0.0.1:%s 已就绪', deps.port);
      resolve(server);
    });
  });
}
