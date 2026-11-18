/**
 * 知识库 MCP server（kb-server.ts）
 *
 * 把本地知识资产以 MCP 工具形式提供给外部 agent（Claude Code / Codex / ZCode / opencode / Trae…），
 * 同时本应用 agent 经 mcp-manager.buildLoadedMcpConfig 注入同一端点（后续阶段接）。
 *
 * 实现要点（详见 docs/知识库MCP设计方案.md §2）：
 *   - node:http 监听 127.0.0.1:8792（可配 kbMcpPort），仅路由 /mcp；公网入口一律不走这里
 *   - 官方 @modelcontextprotocol/sdk：stateless 模式（sessionIdGenerator: undefined + enableJsonResponse），
 *     每个新建请求一套 McpServer+transport，无会话表、无悬挂 SSE；SDK 为 ESM-only，
 *     用 new Function 动态 import（同 mcp-manager.ts 的 pi-mcp 加载机制）
 *   - Bearer token 鉴权（kbMcpToken，首次启动自动生成），sha256 + timingSafeEqual 恒时比较
 *   - 生命周期仿 mobile gateway：结构化 {ok, port, error?} 返回，EADDRINUSE 转中文提示；
 *     main.ts whenReady 自启（kbMcpEnabled !== '0'），stopAllServices 统一停止
 */
import * as http from 'http';
import * as crypto from 'crypto';
import * as appConfig from '../services/app-config';
import logger from '../services/logger';
import { registerKbTools } from './kb-tools';
import { refreshIndex, reindexNotes, stopWatchers, countNotes, ensureChatIndex } from './kb-index';

const SERVER_NAME = 'qihang-kb';
const SERVER_VERSION = '0.1.0';
const DEFAULT_PORT = 8792;

let server: http.Server | null = null;
let listenPort = 0;
let lastError = '';

// ========== SDK 动态加载（ESM-only） ==========
let sdkMod: any = null;
let trMod: any = null;
let sdkLoading: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (sdkMod && trMod) return Promise.resolve();
  if (!sdkLoading) {
    sdkLoading = Promise.all([
      // 子路径必须带 .js：SDK 的 exports "./*" 映射不做扩展名推断
      new Function('s', 'return import(s)')('@modelcontextprotocol/sdk/server/mcp.js'),
      new Function('s', 'return import(s)')('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    ]).then(([m, t]) => {
      sdkMod = m;
      trMod = t;
      logger.info('[KbMcp] MCP SDK 加载完成');
    }).catch((e: any) => {
      sdkLoading = null; // 允许下次重试
      throw e;
    });
  }
  return sdkLoading;
}

// ========== token ==========

function getOrCreateToken(): string {
  const existing = appConfig.getConfig('kbMcpToken');
  if (existing) return existing;
  const generated = crypto.randomBytes(32).toString('base64url');
  appConfig.saveConfig({ kbMcpToken: generated });
  logger.info('[KbMcp] 已生成访问 token 并写入 config.json');
  return generated;
}

/** 重置 token（UI「重新生成」用）：立即生效，旧 token 失效 */
export function regenKbToken(): string {
  const generated = crypto.randomBytes(32).toString('base64url');
  appConfig.saveConfig({ kbMcpToken: generated });
  logger.info('[KbMcp] 访问 token 已重新生成');
  return generated;
}

/** 恒时比较，避免逐字节比较的时序侧信道（同 mobile/gateway.ts 的 isAuthorized 模式） */
function tokenMatches(presented: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// ========== HTTP 处理 ==========

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req: http.IncomingMessage, limitBytes = 1024 * 1024): Promise<unknown | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > limitBytes) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {}); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

/** 无状态处理：每请求新建 McpServer + transport（SDK 官方 stateless 模式），响应完即回收 */
async function handleMcpPost(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> {
  const transport = new trMod.StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const mcpServer = new sdkMod.McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerKbTools(mcpServer);
  await mcpServer.connect(transport);
  res.on('close', () => {
    try { void transport.close(); mcpServer.close(); } catch {}
  });
  await transport.handleRequest(req, res, body);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp') { sendJson(res, 404, { error: 'not found' }); return; }

    const auth = String(req.headers['authorization'] || '');
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m || !tokenMatches(m[1].trim(), getOrCreateToken())) {
      sendJson(res, 401, { error: 'unauthorized：需要 Authorization: Bearer <kbMcpToken>' });
      return;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) { sendJson(res, 400, { error: 'invalid JSON body' }); return; }
      await handleMcpPost(req, res, body);
      return;
    }
    if (req.method === 'DELETE') { res.statusCode = 200; res.end(); return; }
    // stateless 模式不提供 server→client 的 GET SSE 流，明确 405 让客户端走纯 JSON
    sendJson(res, 405, { error: 'GET stream not supported (stateless mode)' });
  } catch (e: any) {
    logger.error('[KbMcp] 请求处理失败: %s', e?.message || e);
    if (!res.headersSent) sendJson(res, 500, { error: e?.message || String(e) });
    else res.end();
  }
}

// ========== 生命周期 ==========

/** 启动。幂等：已在运行则直接返回当前端口 */
export async function startKbMcpServer(portOverride?: number): Promise<{ ok: boolean; port?: number; error?: string }> {
  if (server) return { ok: true, port: listenPort };
  const port = Math.trunc(Number(portOverride ?? appConfig.getConfig('kbMcpPort'))) || DEFAULT_PORT;
  getOrCreateToken();
  try {
    await loadSdk();
  } catch (e: any) {
    lastError = '加载 MCP SDK 失败: ' + (e?.message || e);
    logger.error('[KbMcp] %s', lastError);
    return { ok: false, port, error: lastError };
  }

  return new Promise((resolve) => {
    const created = http.createServer((req, res) => { void handleRequest(req, res); });
    created.once('error', (err: any) => {
      server = null;
      const msg = err?.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : (err?.message || String(err));
      lastError = msg;
      logger.error('[KbMcp] 启动失败: %s', msg);
      resolve({ ok: false, port, error: msg });
    });
    created.listen(port, '127.0.0.1', () => {
      server = created;
      listenPort = port;
      lastError = '';
      logger.info('[KbMcp] 知识库 MCP 已启动: http://127.0.0.1:%d/mcp', port);
      // 首次差量同步 + 文件监听放后台，不阻塞启动返回
      void refreshIndex().then((r) => {
        logger.info('[KbMcp] 笔记索引就绪：%d 个项目 / %d 篇', r.projects, r.total);
        // 应用内对话 FTS 回填：只做一次，再延后 2s 让启动高峰过去
        setTimeout(() => {
          try { ensureChatIndex(); } catch (e: any) { logger.error('[KbMcp] 对话索引回填失败: %s', e?.message || e); }
        }, 2000);
      }).catch((e: any) => logger.error('[KbMcp] 首次索引失败: %s', e?.message || e));
      resolve({ ok: true, port });
    });
  });
}

export async function stopKbMcpServer(): Promise<void> {
  stopWatchers();
  if (!server) return;
  const s = server;
  server = null;
  listenPort = 0;
  await new Promise<void>((resolve) => {
    try {
      s.close(() => resolve());
      (s as any).closeAllConnections?.();
      setTimeout(resolve, 2000); // 兜底：连接杀不干净也别卡退出
    } catch { resolve(); }
  });
  logger.info('[KbMcp] 知识库 MCP 已停止');
}

export function kbServerStatus() {
  return {
    running: !!server,
    port: listenPort,
    enabled: appConfig.getConfig('kbMcpEnabled') !== '0',
    token: appConfig.getConfig('kbMcpToken'),
    url: server ? `http://127.0.0.1:${listenPort}/mcp` : '',
    lastError,
    notesIndexed: countNotes(),
    tools: ['search', 'get_note', 'list_notes', 'get_session', 'recent_activity'],
  };
}

/** 手动重建索引（UI 按钮 / IPC 用） */
export async function manualReindex(): Promise<{ projects: number; indexed: number; removed: number; total: number }> {
  return reindexNotes();
}
