/**
 * 中继服务客户端（移动端远程连接）
 *
 * 拓扑：桌面端与移动端都躲在 NAT 后面，彼此无法直连。
 * 两者各自出站拨到同一个中继，中继按 deviceId 把两条 socket 对接起来。
 * 因此桌面端只作为 WS 客户端，不监听任何端口；笔记本关机时移动端读的是
 * 中继里由 sync.* 事件维护的镜像（能看不能发）。
 *
 * 协议对齐 relay-server：
 *   REST  POST /relay/device/register|password|claim|exchange|revoke
 *         GET  /relay/health、/relay/device/{id}/clients
 *   WS    /relay/ws/device?deviceId=..&token=..
 *   信封  { id, type: request|response|error|event, method, params, result, error, event, data }
 */
import WebSocket from 'ws';
import { q, chat, project, task } from './database';
import logger from './logger';
import * as deviceStore from './relay-device';
import type { RelayDeviceInfo, RelayDeviceInfoView } from './relay-device';

const TAG = '[RELAY]';
const LOG = (msg: string, ...args: unknown[]) => logger.info(TAG + ' ' + msg, ...args);

interface RelayMessage {
  id?: string;
  type: 'request' | 'response' | 'error' | 'event';
  method?: string;
  params?: any;
  result?: any;
  error?: string;
  event?: string;
  data?: any;
  timestamp?: number;
}

type RpcHandler = (params: any) => any | Promise<any>;

/** 中继按 WS 会话记录的移动端客户端 */
export interface MobileClientView {
  sessionId: string;
  clientId: string;
  name: string;
  platform: string;
  connectedAt: number;
  lastActiveAt: number;
}

/**
 * 保存地址前的探活：GET {relayUrl}/relay/health 必须是中继自己回的 JSON。
 * 拿回 HTML（nginx 没转发／指向别的站点）或 service 字段不符一律判失败。
 */
export async function probeRelayHealth(relayUrl: string): Promise<{ ok: boolean; error?: string; devicesOnline?: number }> {
  const base = relayUrl.replace(/\/+$/, '');
  let resp: Response;
  try {
    resp = await fetch(`${base}/relay/health`, { signal: AbortSignal.timeout(6000) });
  } catch (e: any) {
    return { ok: false, error: `连不上 ${base}/relay/health：${e && e.message ? e.message : String(e)}` };
  }
  if (!resp.ok) return { ok: false, error: `/relay/health 返回 HTTP ${String(resp.status)}` };
  let data: any;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, error: '/relay/health 返回的不是 JSON：nginx 没转发到中继，或地址指向了别的站点' };
  }
  if (data?.service !== 'relay-server') return { ok: false, error: '应答者不是中继服务（service 字段不匹配）' };
  if (data.ok !== true) return { ok: false, error: `中继已连通但自检未通过：dbStatus=${String(data.dbStatus ?? 'unknown')}` };
  return { ok: true, devicesOnline: Number(data.devicesOnline ?? 0) };
}

/** 本地时间文本（datetime('now','+8 hours') 写的 'YYYY-MM-DD HH:mm:ss'）→ epoch 毫秒 */
function toEpoch(text: unknown): number {
  const s = String(text || '').trim();
  if (!s) return 0;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 8, Number(m[5]), Number(m[6]));
  return Number.isFinite(t) ? t : 0;
}

export class RelayClient {
  private device: RelayDeviceInfo | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private connected = false;
  private lastError = '';
  private handlers = new Map<string, RpcHandler>();
  /** 中继推来的事件旁路（test:message / mobile:connected 等），供主进程转渲染层 */
  private eventListener: ((event: string, data: any) => void) | null = null;

  // ===== 状态与控制 =====

  isStarted(): boolean {
    return !!this.device;
  }

  isConnected(): boolean {
    return this.connected;
  }

  lastFailure(): string {
    return this.lastError;
  }

  getDeviceInfo(): RelayDeviceInfoView | null {
    return this.device ? deviceStore.toView(this.device) : null;
  }

  /** 设备名（移动端配对页显示「已连接 XXX」） */
  getDeviceName(): string {
    return this.device?.name || deviceStore.hostName();
  }

  isRemoteEnabled(): boolean {
    return this.device?.remoteEnabled === true;
  }

  /** 设置页展示用：不要求已 start，存量设备文件读得到就报出去 */
  status(): { connected: boolean; error: string; device: RelayDeviceInfoView | null } {
    const info = this.device || deviceStore.load();
    return {
      connected: this.connected,
      error: this.lastError,
      device: info ? deviceStore.toView(info) : null,
    };
  }

  onRelayEvent(cb: (event: string, data: any) => void): () => void {
    this.eventListener = cb;
    return () => { this.eventListener = null; };
  }

  registerHandler(method: string, fn: RpcHandler): void {
    this.handlers.set(method, fn);
  }

  private baseUrl(): string {
    return (this.device?.relayUrl || '').replace(/\/+$/, '');
  }

  /** 开关打开且已设连接密码才允许移动端接入；未显式开启（含存量缺字段）一律视为关闭 */
  private mobileAllowed(): boolean {
    return this.device?.remoteEnabled === true && !!this.device?.password;
  }

  /** 启动：先 HTTP 注册，再按需建 WS；开关关闭时只上报状态 */
  async start(relayUrl?: string): Promise<void> {
    const url = relayUrl || this.device?.relayUrl || '';
    this.device = deviceStore.getOrCreate(url);
    await this.registerDevice();
    if (this.mobileAllowed() && !this.connected) this.connect();
  }

  stop(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.removeAllListeners(); ws.close(); } catch {}
    }
    this.connected = false;
  }

  /** 改中继地址并立即重连（deviceId/token 不变，移动端已存的配对不失效） */
  async setRelayUrl(relayUrl: string): Promise<RelayDeviceInfoView> {
    const normalized = deviceStore.normalizeRelayUrl(relayUrl);
    if (!normalized) throw new Error('中继地址请只填到域名或 IP:端口（不要带 /relay 等路径）');
    this.device = deviceStore.patch({ relayUrl: normalized });
    this.lastError = '';
    this.stop();
    await this.start(normalized);
    return deviceStore.toView(this.device);
  }

  /**
   * 点「开启」的一键动作：先把密码提交中继校验（全库唯一），
   * 通过后才一次性落库「开启状态 + 密码」并注册、建 WS。
   * 密码被拒时本机什么都不改，开关保持关闭。
   */
  /**
   * 落定本次要用的中继地址：面板传了新地址就覆盖已保存的，没传则沿用设备文件里的。
   * @returns false = 从没配过地址，此时任何外连都无从发起
   */
  private adoptRelayUrl(relayUrl?: string): boolean {
    const incoming = String(relayUrl || '').trim();
    if (incoming) {
      const normalized = deviceStore.normalizeRelayUrl(incoming);
      if (!normalized) throw new Error('中继地址请只填到域名或 IP:端口（不要带 /relay 等路径）');
      this.device = deviceStore.patch({ relayUrl: normalized });
      return true;
    }
    const stored = String(this.device?.relayUrl || deviceStore.load()?.relayUrl || '');
    if (!stored) return false;
    this.device = deviceStore.getOrCreate(stored);
    return true;
  }

  async enableWithPassword(password: string, relayUrl?: string): Promise<RelayDeviceInfoView> {
    const value = this.assertPasswordFormat(password);
    if (!this.adoptRelayUrl(relayUrl)) throw new Error('请先填写中继服务地址');
    const rejected = await this.postPassword(value);
    if (rejected !== null && rejected !== 'device not found') throw new Error(rejected);
    this.device = deviceStore.patch({ password: value, remoteEnabled: true });
    this.lastError = '';
    const err = await this.registerDevice();
    if (err && rejected === 'device not found') {
      this.device = deviceStore.patch({ password: undefined, remoteEnabled: false });
      throw new Error(err);
    }
    if (!this.connected) this.connect();
    return deviceStore.toView(this.device);
  }

  /** 关闭开关：先上报中继（中继随即拒绝新握手并踢掉在线移动端），再断开本机 WS */
  async setRemoteEnabled(enabled: boolean): Promise<RelayDeviceInfoView> {
    if (enabled && !this.device?.password) throw new Error('请先设置移动端连接密码');
    if (!this.adoptRelayUrl()) {
      // 从没配过中继地址：本地记个关闭状态即可，没有上游可通知
      return deviceStore.toView(deviceStore.patch({ remoteEnabled: false }));
    }
    this.device = deviceStore.patch({ remoteEnabled: enabled });
    this.lastError = '';
    await this.registerDevice();
    if (enabled) {
        if (!this.connected) this.connect();
    } else {
      this.stop();
    }
    return deviceStore.toView(this.device!);
  }

  private assertPasswordFormat(raw: string): string {
    const value = String(raw || '').trim();
    if (value.length < 6) throw new Error('密码至少 6 位');
    if (value.length > 64) throw new Error('密码最长 64 位');
    return value;
  }

  /** 保存后实测 WS 握手；超时返回失败原因 */
  async waitForConnected(timeoutMs = 8000): Promise<{ connected: boolean; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connected) return { connected: true };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { connected: false, error: this.lastError || `${Math.round(timeoutMs / 1000)} 秒内未完成 WebSocket 握手` };
  }

  // ===== 设备注册与客户端管理 =====

  private async registerDevice(): Promise<string | null> {
    if (!this.device) return 'device not found';
    try {
      const resp = await fetch(`${this.baseUrl()}/relay/device/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: this.device.deviceId,
          token: this.device.token,
          name: this.device.name,
          password: this.device.password || undefined,
          remoteEnabled: this.device.remoteEnabled === true,
        }),
      });
      const data = await resp.json().catch(() => null) as any;
      if (data?.ok) {
        LOG(`device registered: ${this.device.deviceId}`);
        return null;
      }
      if (!data) return `中继 /relay/device/register 返回 HTTP ${String(resp.status)}（响应不是 JSON），请确认中继服务已启动`;
      LOG(`registration failed: ${String(data?.error)}`);
      return String(data?.error || '注册失败');
    } catch (e: any) {
      this.lastError = `注册请求失败：${e && e.message ? e.message : String(e)}`;
      LOG(`register error: ${this.lastError}`);
      return this.lastError;
    }
  }

  /** @returns null=成功；'device not found'=中继还没有这台设备（由随后的注册建行） */
  private async postPassword(password: string): Promise<string | null> {
    if (!this.device) return 'device not found';
    let status = 0;
    let data: any;
    try {
      const resp = await fetch(`${this.baseUrl()}/relay/device/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: this.device.deviceId, token: this.device.token, password }),
      });
      status = resp.status;
      data = await resp.json().catch(() => null);
    } catch (e: any) {
      throw new Error(`连不上中继：${e && e.message ? e.message : String(e)}`);
    }
    if (!data) throw new Error(`中继 /relay/device/password 返回 HTTP ${String(status)}（响应不是 JSON），请确认中继服务已启动`);
    if (data?.ok) return null;
    if (status === 404) return '中继服务还是旧版本，请更新并重启中继后再设置密码';
    return String(data?.error || `保存失败（HTTP ${String(status)}）`);
  }

  /** 当前接入本机的移动端：以中继会话表为准（本机 socket 可能已在重连间隙断开） */
  async listMobileClients(): Promise<{ ok: boolean; clients: MobileClientView[]; error?: string }> {
    if (!this.device || !this.mobileAllowed()) return { ok: true, clients: [] };
    try {
      const resp = await fetch(`${this.baseUrl()}/relay/device/${this.device.deviceId}/clients`, {
        headers: { 'X-Relay-Token': this.device.token },
        signal: AbortSignal.timeout(6000),
      });
      const data = await resp.json() as any;
      if (!resp.ok || !data?.ok) return { ok: false, clients: [], error: String(data?.error || `HTTP ${String(resp.status)}`) };
      return { ok: true, clients: (data.clients || []) as MobileClientView[] };
    } catch (e: any) {
      return { ok: false, clients: [], error: `查询失败：${e && e.message ? e.message : String(e)}` };
    }
  }

  /** 把某个移动端客户端踢下线（移动端收到 close reason=kicked 后停止自动重连） */
  async kickMobileClient(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.device) return { ok: false, error: '尚未初始化设备信息' };
    try {
      const resp = await fetch(
        `${this.baseUrl()}/relay/device/${this.device.deviceId}/clients/${encodeURIComponent(sessionId)}/kick`,
        { method: 'POST', headers: { 'X-Relay-Token': this.device.token }, signal: AbortSignal.timeout(6000) },
      );
      const data = await resp.json() as any;
      if (!resp.ok || !data?.ok) return { ok: false, error: String(data?.error || `HTTP ${String(resp.status)}`) };
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: `请求失败：${e && e.message ? e.message : String(e)}` };
    }
  }

  // ===== WebSocket =====

  private connect(): void {
    if (!this.device) return;
    const wsUrl = this.baseUrl().replace(/^http/, 'ws').replace(/^https/, 'wss');
    const url = `${wsUrl}/relay/ws/device?deviceId=${this.device.deviceId}&token=${this.device.token}`;
    LOG(`connecting to ${wsUrl}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e: any) {
      // 地址不合法时构造函数直接抛，不兜住重连循环就死了
      this.lastError = `连接失败：${e && e.message ? e.message : String(e)}`;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.lastError = '';
      this.lastPongAt = Date.now();
      this.startHeartbeat();
      LOG('connected');
      this.syncFull().catch((e: any) => LOG(`syncFull error: ${e && e.message ? e.message : e}`));
    });
    ws.on('pong', () => { this.lastPongAt = Date.now(); });
    ws.on('message', (raw: WebSocket.RawData) => { this.handleMessage(String(raw)); });
    ws.on('close', (code: number, reason: Buffer) => {
      this.connected = false;
      this.stopHeartbeat();
      const r = String(reason || '');
      this.lastError = `连接被断开（code=${String(code)}${r ? `，${r}` : ''}）`;
      LOG(`disconnected (code=${String(code)} reason=${r})`);
      this.scheduleReconnect();
    });
    ws.on('error', (err: Error) => {
      this.lastError = `连接失败：${err.message}${(err as any).code ? `（${String((err as any).code)}）` : ''}`;
      LOG(`ws error: ${err.message}`);
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 20_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /** 文本心跳给中继数入站活动用，WS ping 的 pong 用来自己判链路死活 */
  private sendHeartbeat(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastPongAt > 60_000) {
      LOG('heartbeat timeout (no pong within 60s), forcing reconnect');
      this.stopHeartbeat();
      ws.terminate();
      return;
    }
    this.send({ type: 'event', event: 'heartbeat', data: { ts: Date.now() } });
    ws.ping();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.mobileAllowed()) return;
      // 中继的 token 表可能是内存态，它重启后握手会被 invalid token 拒绝，故每次重连前先重新注册
      void (async () => {
        await this.registerDevice();
        this.connect();
      })();
    }, 5000);
  }

  private handleMessage(raw: string): void {
    let msg: RelayMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      LOG(`invalid JSON frame ignored`);
      return;
    }
    if (msg.event === 'heartbeat:ack') { this.lastPongAt = Date.now(); return; }
    if (msg.type === 'request' && msg.method) {
      void this.dispatch(msg);
    } else if (msg.type === 'event') {
      if (msg.event === 'test:message' || msg.event === 'test:ack' || msg.event === 'mobile:connected') {
        this.eventListener?.(msg.event, msg.data);
      }
    }
  }

  private async dispatch(msg: RelayMessage): Promise<void> {
    const handler = this.handlers.get(msg.method || '');
    if (!handler) {
      this.send({ id: msg.id, type: 'error', error: `unknown method: ${String(msg.method)}` });
      return;
    }
    try {
      const result = await handler(msg.params);
      this.send({ id: msg.id, type: 'response', result });
    } catch (e: any) {
      const text = e && e.message ? e.message : String(e);
      LOG(`handler ${String(msg.method)} failed: ${text}`);
      this.send({ id: msg.id, type: 'error', error: text });
    }
  }

  /** @returns 是否真的写进了已打开的 socket（未连接时这帧直接丢弃） */
  private send(msg: RelayMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** 推送事件给移动端（chat.* 流式回传走这里） */
  pushEvent(event: string, data: any): boolean {
    return this.send({ type: 'event', event, data });
  }

  // ===== 数据同步（中继据此落 MySQL 镜像，移动端离线也能浏览） =====

  private sendSync(event: string, data: any): boolean {
    return this.send({ type: 'event', event, data });
  }

  /** 项目快照：description 带本机目录，移动端只展示不解释 */
  private projectPayload(p: any): any {
    return {
      projectId: String(p.id),
      name: p.name,
      description: p.dir || p.description || '',
      status: 'active',
    };
  }

  private sessionPayload(s: any): any {
    return {
      sessionId: s.session_id,
      projectId: s.project_id === null || s.project_id === undefined ? null : String(s.project_id),
      title: s.title || '新对话',
      adapterId: s.active_agent || 'pi',
      modelId: s.model_id || null,
      status: 'active',
      kind: 'chat',
      taskId: null,
      runId: null,
      ended: 0,
      lastActiveAt: toEpoch(s.updated_at) || Date.now(),
    };
  }

  private messagePayload(sessionId: string, m: any): any {
    return {
      sessionId,
      messageUid: `${sessionId}_${m.id}`,
      role: m.role,
      content: m.content || '',
      thinking: m.thinking || '',
      status: 'done',
      modelId: null,
      tokens: 0,
      durationMs: Number(m.duration_ms) || 0,
      createdAt: toEpoch(m.created_at) || Date.now(),
    };
  }

  private taskPayload(t: any): any {
    const schedule = t.cycle_type
      ? JSON.stringify({ cycleType: t.cycle_type, cycleValue: t.cycle_value, cycleTime: t.cycle_time, cycleEnd: t.cycle_end })
      : null;
    const priority = t.priority === 'mid' ? 'medium' : (t.priority || 'medium');
    return {
      taskId: String(t.id),
      projectId: t.project_id === null || t.project_id === undefined ? null : String(t.project_id),
      title: t.title,
      description: t.description || t.prompt || '',
      status: t.status || 'pending',
      priority,
      assignee: null,
      scheduleJson: schedule,
      nextRunAt: toEpoch(t.scheduled_start) || 0,
    };
  }

  /** 镜像范围含代码库：project.list() 会滤掉 type='code'，移动端要的是全部项目 */
  private allProjects(): any[] {
    return q('SELECT * FROM prj_projects ORDER BY sort_order ASC, created_at DESC');
  }

  syncProject(projectId: string | number): void {
    const p = project.get(Number(projectId));
    if (p) this.sendSync('sync.project', this.projectPayload(p));
  }

  syncProjectDeleted(projectId: string | number): void {
    this.sendSync('sync.projectDeleted', { projectId: String(projectId) });
  }

  syncSession(sessionId: string): void {
    const s = chat.getSession(sessionId);
    if (s) this.sendSync('sync.chatSession', this.sessionPayload(s));
  }

  syncSessionDeleted(sessionId: string): void {
    this.sendSync('sync.chatSessionDeleted', { sessionId });
  }

  syncTask(taskId: string | number): void {
    const t = task.get(Number(taskId));
    if (t) this.sendSync('sync.task', this.taskPayload(t));
  }

  /** 增量同步会话末尾的若干条消息（中继按 messageUid upsert，重复推送幂等） */
  syncRecentMessages(sessionId: string, count: number): void {
    const rows = chat.messages(sessionId).slice(-count);
    for (const m of rows) this.sendSync('sync.chatMessage', this.messagePayload(sessionId, m));
  }

  /** 全量同步：连接建立时推送全部数据；消息按会话整段替换，桌面为唯一事实来源 */
  async syncFull(): Promise<void> {
    if (!this.connected) return;
    const projects = this.allProjects();
    const sessions: any[] = [];
    const messages: Record<string, any[]> = {};
    for (const p of projects) {
      this.sendSync('sync.project', this.projectPayload(p));
      for (const s of chat.sessions(p.id)) {
        sessions.push(s);
        this.sendSync('sync.chatSession', this.sessionPayload(s));
        messages[s.session_id] = chat.messages(s.session_id).map((m) => this.messagePayload(s.session_id, m));
      }
    }
    // 挂在库外的历史会话（如飞书会话未绑 project_id）也要进镜像
    for (const s of chat.sessions(null)) {
      if (s.project_id === null || s.project_id === undefined) {
        this.sendSync('sync.chatSession', this.sessionPayload(s));
        messages[s.session_id] = chat.messages(s.session_id).map((m) => this.messagePayload(s.session_id, m));
      }
    }
    const tasks = q('SELECT * FROM plan_tasks ORDER BY id DESC LIMIT 1000');
    for (const t of tasks) this.sendSync('sync.task', this.taskPayload(t));

    const msgCount = Object.values(messages).reduce((n, l) => n + l.length, 0);
    this.sendSync('sync.full', { messages });
    LOG(`full sync pushed: projects=${projects.length} sessions=${sessions.length} messages=${msgCount} tasks=${tasks.length}`);
    await this.reconcileRelay();
  }

  /**
   * 收敛离线期间漏掉的删除：拉中继现有项目/会话清单，本地已不存在的补发 deleted。
   * 中继没有「不在全量清单里就删」的语义，漏掉这一条移动端会点进幽灵会话发消息。
   */
  private async reconcileRelay(): Promise<void> {
    if (!this.device) return;
    const headers = { 'X-Relay-Token': this.device.token };
    const base = `${this.baseUrl()}/relay/mobile/${this.device.deviceId}`;
    try {
      const [relayProjects, relaySessions] = await Promise.all([
        fetch(`${base}/projects`, { headers, signal: AbortSignal.timeout(8000) }).then((r) => r.json()) as Promise<any[]>,
        fetch(`${base}/sessions`, { headers, signal: AbortSignal.timeout(8000) }).then((r) => r.json()) as Promise<any[]>,
      ]);
      if (!Array.isArray(relayProjects) || !Array.isArray(relaySessions)) return;
      const localProjectIds = new Set(this.allProjects().map((p) => String(p.id)));
      const localSessionIds = new Set(chat.sessions(null).map((s) => s.session_id));
      let pruned = 0;
      for (const rp of relayProjects) {
        const pid = String(rp?.projectId ?? '');
        if (pid && !localProjectIds.has(pid)) { this.sendSync('sync.projectDeleted', { projectId: pid }); pruned++; }
      }
      for (const rs of relaySessions) {
        const sid = String(rs?.sessionId ?? '');
        if (sid && !localSessionIds.has(sid)) { this.sendSync('sync.chatSessionDeleted', { sessionId: sid }); pruned++; }
      }
      if (pruned) LOG(`reconciled stale relay rows: ${pruned}`);
    } catch (e: any) {
      LOG(`reconcile skipped: ${e && e.message ? e.message : String(e)}`);
    }
  }

  // ===== 渲染层事件 → 中继事件 =====

  /** 渲染层通道 → 中继事件名（chat:delta → chat.delta）推给移动端；桌面窗口由调用方自己广播 */
  mirrorRendererEvent(channel: string, data: any): void {
    if (!this.connected || !channel.startsWith('chat:')) return;
    const event = 'chat.' + channel.slice(5);
    this.send({ type: 'event', event, data });
    // 回答收口/新建会话时把会话与消息推上镜像
    if (event === 'chat.done' && data?.sessionId) {
      this.syncSession(data.sessionId);
      this.syncRecentMessages(data.sessionId, 2);
    }
  }

}

export const relayClient = new RelayClient();
