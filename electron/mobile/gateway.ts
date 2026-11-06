/**
 * 移动端本机网关
 *
 * 手机浏览器 → frps/nginx → 127.0.0.1:<port>（本模块）。
 * 只提供最小能力：健康检查、配对鉴权、会话列表/历史、发消息（复用主进程的 runChatTurn）、SSE 事件流。
 * 不监听 0.0.0.0：公网入口交给 frp + nginx，避免本机端口直接暴露。
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { app } from 'electron';
import * as db from '../services/database';
import { listPiModels } from '../services/pi-agent';
import logger from '../services/logger';

const BIND_HOST = '127.0.0.1';
const DEVICE_FILE = path.join(os.homedir(), '.qihang-ai-desktop', 'mobile-devices.json');
const MAX_BODY = 1024 * 1024;
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 15 * 1000;
const PAIR_FAIL_WINDOW_MS = 60 * 1000;
const PAIR_FAIL_LIMIT = 10;

export interface MobileChatTurnPayload {
  question: string;
  sessionId: string;
  projectDir?: string;
  images?: any[];
  agent?: string;
  modelName?: string;
}

export interface MobileGatewayDeps {
  /** 复用主进程的 runChatTurn；其 emit 固定走 emitChatEvent（桌面 + 手机双播） */
  runTurn: (payload: MobileChatTurnPayload) => Promise<void>;
  /** 桌面端即时提示：移动端发来一条消息 */
  notifyDesktop?: (sessionId: string, title: string, text: string) => void;
}

interface DeviceRecord {
  id: string;
  name: string;
  hash: string;
  createdAt: string;
}

let server: http.Server | null = null;
let listenPort = 0;
let deps: MobileGatewayDeps | null = null;
const sseClients = new Set<http.ServerResponse>();
const runningSessions = new Set<string>();

let pairCode: { code: string; expiresAt: number } | null = null;
let pairFailWindow = 0;
let pairFailCount = 0;

let devices: DeviceRecord[] | null = null;

function loadDevices(): DeviceRecord[] {
  if (devices) return devices;
  try {
    if (!fs.existsSync(DEVICE_FILE)) {
      devices = [];
      return devices;
    }
    const raw = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf-8'));
    devices = Array.isArray(raw?.devices) ? raw.devices : [];
  } catch (e: any) {
    logger.warn('[Mobile] 读取设备文件失败: %s', e?.message || e);
    devices = [];
  }
  return devices || [];
}

function saveDevices(list: DeviceRecord[]): void {
  devices = list;
  try {
    const dir = path.dirname(DEVICE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DEVICE_FILE, JSON.stringify({ devices: list }, null, 2), 'utf-8');
  } catch (e: any) {
    logger.warn('[Mobile] 保存设备文件失败: %s', e?.message || e);
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function isAuthorized(req: http.IncomingMessage): boolean {
  const header = String(req.headers.authorization || '');
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const hash = sha256(m[1].trim());
  return loadDevices().some((d) => safeEqual(hash, String(d.hash || '')));
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 会话形状统一成移动端字段（旧中继三端约定的 sessionId） */
function toSession(row: any) {
  return {
    sessionId: row.session_id,
    title: row.title || '新对话',
    source: row.source || 'ui',
    projectId: row.project_id === null || row.project_id === undefined ? null : Number(row.project_id),
    agent: row.active_agent || 'pi',
    modelId: row.model_id || '',
    lastMessage: row.last_message || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function toMessage(row: any) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    thinking: row.thinking || '',
    images: row.images || null,
    durationMs: Number(row.duration_ms) || 0,
    createdAt: row.created_at || '',
  };
}

/** SSE 广播：所有在线手机 */
export function broadcastMobileEvent(channel: string, data: any): void {
  if (!sseClients.size) return;
  const payload = `event: ${channel}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function tooManyPairFailures(): boolean {
  return pairFailCount >= PAIR_FAIL_LIMIT && Date.now() - pairFailWindow < PAIR_FAIL_WINDOW_MS;
}

function notePairFailure(): void {
  if (Date.now() - pairFailWindow >= PAIR_FAIL_WINDOW_MS) {
    pairFailWindow = Date.now();
    pairFailCount = 0;
  }
  pairFailCount += 1;
}

function serveMobilePage(res: http.ServerResponse): void {
  const file = path.join(app.getAppPath(), 'resources', 'mobile', 'index.html');
  try {
    const html = fs.readFileSync(file, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch (e: any) {
    logger.warn('[Mobile] 读取手机页面失败: %s', e?.message || e);
    sendJson(res, 500, { ok: false, error: '移动端页面缺失' });
  }
}

async function handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (tooManyPairFailures()) {
    return sendJson(res, 429, { ok: false, error: '尝试次数过多，请 1 分钟后再试' });
  }
  const body = await readBody(req);
  const code = String(body?.code || '').trim();
  const name = String(body?.name || '').trim().slice(0, 40) || '未命名手机';
  if (!pairCode || Date.now() > pairCode.expiresAt) {
    return sendJson(res, 410, { ok: false, error: '配对码已失效，请在桌面端重新生成' });
  }
  if (!code || !safeEqual(code, pairCode.code)) {
    notePairFailure();
    return sendJson(res, 400, { ok: false, error: '配对码不正确' });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const record: DeviceRecord = {
    id: crypto.randomBytes(8).toString('hex'),
    name,
    hash: sha256(token),
    createdAt: new Date().toISOString(),
  };
  const list = loadDevices().concat(record);
  saveDevices(list);
  pairCode = null;
  pairFailCount = 0;
  logger.info('[Mobile] 新设备已配对: %s', name);
  sendJson(res, 200, { ok: true, token, deviceId: record.id, name });
}

async function handleCreateSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);
  const title = String(body?.title || '').trim().slice(0, 60) || '新对话';
  // 移动端新建对话时选定项目与模型：项目决定 AI 的工作目录/可用工具，模型决定这一轮用哪个接入点
  const projectNum = Number(body?.projectId);
  const projectId = Number.isFinite(projectNum) ? Math.trunc(projectNum) : null;
  const modelId = String(body?.modelId || '').trim();
  const sid = 'mobile_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  db.chat.createSession(sid, projectId, title, 'general', 'pi', 'mobile');
  if (modelId) db.chat.updateSessionModel(sid, modelId);
  sendJson(res, 200, { ok: true, session: toSession(db.chat.getSession(sid)) });
}

async function handleSendMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawSessionId: string,
): Promise<void> {
  const sid = decodeURIComponent(rawSessionId);
  const body = await readBody(req);
  const text = String(body?.question ?? body?.text ?? '').trim();
  if (!text) return sendJson(res, 400, { ok: false, error: '消息内容为空' });

  const row: any = db.chat.getSession(sid);
  if (!row) return sendJson(res, 404, { ok: false, error: '会话不存在，请在手机上重新创建' });
  if (runningSessions.has(sid)) return sendJson(res, 409, { ok: false, error: '这一轮还在回答中，请稍候' });

  runningSessions.add(sid);
  const projectId = row.project_id === null || row.project_id === undefined ? null : Number(row.project_id);
  const project: any = projectId === null || !Number.isFinite(projectId) ? null : db.project.get(projectId);
  const projectDir = project && project.dir ? String(project.dir) : '';

  try {
    deps?.notifyDesktop?.(sid, row.title || '新对话', text);
  } catch (e: any) {
    logger.warn('[Mobile] 桌面提示失败: %s', e?.message || e);
  }

  sendJson(res, 202, { ok: true, accepted: true });

  void (async () => {
    try {
      await deps?.runTurn({
        question: text,
        sessionId: sid,
        projectDir: projectDir || undefined,
        images: Array.isArray(body?.images) ? body.images : undefined,
        agent: row.active_agent || 'pi',
        modelName: row.model_id || undefined,
      });
    } catch (e: any) {
      broadcastMobileEvent('chat:error', { sessionId: sid, text: e?.message || String(e) });
    } finally {
      runningSessions.delete(sid);
    }
  })();
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  // 公开端点：页面、健康检查、配对
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveMobilePage(res);
  }
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      app: '启航AI工作台',
      version: app.getVersion(),
      time: new Date().toISOString(),
    });
  }
  if (req.method === 'POST' && pathname === '/api/pair') {
    return handlePair(req, res);
  }

  if (pathname.startsWith('/api/') && !isAuthorized(req)) {
    return sendJson(res, 401, { ok: false, error: '未配对或凭证已失效' });
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': hb\n\n');
      } catch {
        /* 断开由 close 处理 */
      }
    }, HEARTBEAT_MS);
    res.on('close', () => {
      sseClients.delete(res);
      clearInterval(heartbeat);
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/projects') {
    const projects = db.project.list().map((p: any) => ({
      id: Number(p.id),
      name: p.name,
      dir: p.dir || '',
      isDefault: !!p.is_default,
    }));
    return sendJson(res, 200, { ok: true, projects });
  }
  if (req.method === 'GET' && pathname === '/api/models') {
    const result = await listPiModels();
    const models = (result.models || []).map((m: any) => ({
      pattern: m.pattern,
      name: m.name,
      providerLabel: m.providerLabel || m.provider || '',
    }));
    return sendJson(res, 200, { ok: true, models, error: result.error });
  }
  if (req.method === 'GET' && pathname === '/api/sessions') {
    return sendJson(res, 200, { ok: true, sessions: db.chat.sessions(undefined).map(toSession) });
  }
  if (req.method === 'POST' && pathname === '/api/sessions') {
    return handleCreateSession(req, res);
  }

  const messagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (messagesMatch) {
    const sid = decodeURIComponent(messagesMatch[1]);
    if (req.method === 'GET') {
      if (!db.chat.getSession(sid)) return sendJson(res, 404, { ok: false, error: '会话不存在' });
      return sendJson(res, 200, { ok: true, messages: db.chat.messages(sid).map(toMessage) });
    }
    if (req.method === 'POST') return handleSendMessage(req, res, messagesMatch[1]);
  }

  sendJson(res, 404, { ok: false, error: '接口不存在' });
}

export async function startMobileGateway(
  port: number,
  gatewayDeps: MobileGatewayDeps,
): Promise<{ ok: boolean; port: number; error?: string }> {
  if (server) {
    if (port === listenPort) {
      deps = gatewayDeps;
      return { ok: true, port: listenPort };
    }
    await stopMobileGateway();
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, port: listenPort, error: '端口不合法' };
  }

  deps = gatewayDeps;
  const created = http.createServer((req, res) => {
    void handle(req, res).catch((e: any) => {
      logger.warn('[Mobile] 请求处理失败: %s', e?.message || e);
      try {
        if (!res.headersSent) sendJson(res, 400, { ok: false, error: e?.message || '请求失败' });
        else res.end();
      } catch {
        /* 连接可能已断开 */
      }
    });
  });

  const result = await new Promise<{ ok: boolean; port: number; error?: string }>((resolve) => {
    const onError = (err: any) => {
      created.removeListener('listening', onListening);
      deps = null;
      resolve({
        ok: false,
        port,
        error: err?.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : (err?.message || String(err)),
      });
    };
    const onListening = () => {
      created.removeListener('error', onError);
      server = created;
      listenPort = port;
      logger.info('[Mobile] 网关已启动 http://%s:%d', BIND_HOST, port);
      resolve({ ok: true, port });
    };
    created.once('error', onError);
    created.once('listening', onListening);
    created.listen(port, BIND_HOST);
  });

  return result;
}

export async function stopMobileGateway(): Promise<void> {
  for (const res of sseClients) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  sseClients.clear();
  runningSessions.clear();
  const current = server;
  server = null;
  listenPort = 0;
  deps = null;
  if (!current) return;
  await new Promise<void>((resolve) => {
    current.close(() => resolve());
    try {
      (current as any).closeAllConnections?.();
    } catch {
      /* ignore */
    }
  });
  logger.info('[Mobile] 网关已停止');
}

export function mobileGatewayStatus() {
  return {
    running: !!server,
    port: listenPort,
    address: server ? `http://${BIND_HOST}:${listenPort}` : '',
    devices: loadDevices().length,
    clients: sseClients.size,
  };
}

/** 设置页生成 6 位一次性配对码；5 分钟内有效，配对成功即失效 */
export function requestMobilePairCode(): { code: string; expiresAt: number } {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  pairCode = { code, expiresAt: Date.now() + PAIR_CODE_TTL_MS };
  pairFailWindow = Date.now();
  pairFailCount = 0;
  return { code, expiresAt: pairCode.expiresAt };
}
