/**
 * MCP 数据源管理（mcp-manager.ts）—— 全新模块，独立于 data_center 旧栈
 *
 * 职责：
 * 1. 配置读写：config.json 的 mcpServers 键（JSON 字符串数组），名称自动取服务端握手自报的
 *    serverInfo.name，用户只需填 URL + Token
 * 2. 连接测试：pi-mcp 的 McpClient + StreamableHttpTransport，initialize → listTools
 * 3. 拉取数据：主进程直连 MCP server 调工具（不经 AI、不建 pi 会话），按服务端推荐流程
 *    describe_metrics → count_index → list_* 拉原始记录
 * 4. AI 分类：走 pi 单轮给记录打分类标签，结果缓存在 mcp_ 前缀的新表
 * 5. buildLoadedMcpConfig：把启用的源映射为 pi SDK 的 LoadedMcpConfig，供 createMcpExtension
 *    的 loadConfig 注入（工具以 mcp__<server>__<tool> 进引擎工具面）
 *
 * 安全边界：Token 明文存本机 config.json（与模型 API Key 同水位，已在 .gitignore）；
 * 表结构迁移只涉及 mcp_ 前缀的新表，不触碰 data_center_* 旧表。
 */
import * as crypto from 'crypto';
import logger from './logger';
import { loadConfig, saveConfig } from './app-config';
import { q, qOne, run } from './database';

// ---------- 类型 ----------

export interface McpServerConf {
  /** 稳定 id（生成一次不再变，表缓存与分类记录都挂它） */
  id: string;
  /** 自动：服务端握手自报的 serverInfo.name（用户不填；未测试前为空） */
  name: string;
  url: string;
  /** Bearer Token（可空） */
  token: string;
  enabled: boolean;
  status?: 'ok' | 'error' | 'untested';
  /** 最近一次测试结果摘要（展示用） */
  statusText?: string;
  toolCount?: number;
  lastTestedAt?: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface ProbeResult {
  ok: boolean;
  serverName?: string;
  version?: string;
  instructions?: string;
  tools?: McpToolInfo[];
  error?: string;
}

// ---------- pi-mcp 动态加载（ESM-only，与 pi-agent.ts 的 loadSdk 同机制） ----------

let mcpClientMod: any = null;
let mcpClientLoading: Promise<any> | null = null;
function loadMcpClientModule(): Promise<any> {
  if (mcpClientMod) return Promise.resolve(mcpClientMod);
  if (!mcpClientLoading) {
    mcpClientLoading = new Function('spec', 'return import(spec)')('@earendil-works/pi-mcp')
      .then((mod: any) => { mcpClientMod = mod; return mod; })
      .catch((err: Error) => {
        mcpClientLoading = null;
        logger.error('[McpManager] pi-mcp load failed: %s', err.message);
        throw err;
      });
  }
  return mcpClientLoading!;
}

/**
 * 建一条短连接：connect → 执行 body → close。
 * openGetStream 关掉 server→client 的 GET 流（拉数场景用不到，避免挂着空闲 SSE）。
 */
async function withClient<T>(
  url: string,
  token: string,
  body: (client: any) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const { McpClient, StreamableHttpTransport } = await loadMcpClientModule();
  const client = new McpClient({ name: 'qihang-ai-desktop', version: '1.0.0', requestTimeoutMs: timeoutMs });
  const transport = new StreamableHttpTransport({
    url,
    headers: token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {},
    openGetStream: false,
  });
  await client.connect(transport);
  try {
    return await body(client);
  } finally {
    try { await client.close(); } catch { /* 短连接，关闭失败忽略 */ }
  }
}

/** 把 pi-mcp 的错误翻成用户能看懂的中文 */
function friendlyMcpError(e: any): string {
  const msg = (e && e.message) || String(e);
  if (e && (e.name === 'McpAuthRequiredError' || /401|unauthorized/i.test(msg))) {
    return '认证失败（401）：Token 缺失或无效';
  }
  if (e && e.name === 'McpSessionExpiredError') {
    return '会话过期：请重试';
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)) {
    return `连接不上服务器：${msg}`;
  }
  return msg;
}

// ---------- 连接测试 ----------

/** 握手 + listTools，用于「测试」按钮和保存时的名称自动填充 */
export async function probeServer(url: string, token: string): Promise<ProbeResult> {
  if (!/^https?:\/\//i.test(url || '')) return { ok: false, error: 'URL 必须以 http:// 或 https:// 开头' };
  try {
    return await withClient(url, token, async (client) => {
      const info = client.serverInfo || {};
      let tools: McpToolInfo[] = [];
      try {
        const list = await client.listTools();
        tools = (list || []).map((t: any) => ({
          name: String(t.name || ''),
          description: String(t.description || '').split('\n')[0],
        }));
      } catch (e: any) {
        logger.warn('[McpManager] listTools failed for %s: %s', url, e.message);
      }
      return {
        ok: true,
        serverName: String(info.name || ''),
        version: String(info.version || ''),
        instructions: String(client.instructions || ''),
        tools,
      };
    }, 15_000);
  } catch (e: any) {
    return { ok: false, error: friendlyMcpError(e) };
  }
}

// ---------- 配置读写（config.json 的 mcpServers 键） ----------

function readServers(): McpServerConf[] {
  const raw = loadConfig().mcpServers;
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s: any) => s && typeof s.url === 'string' && s.url.trim())
      .map((s: any) => ({
        id: String(s.id || genId()),
        name: String(s.name || ''),
        url: String(s.url).trim(),
        token: String(s.token || ''),
        enabled: s.enabled !== false,
        status: s.status || 'untested',
        statusText: String(s.statusText || ''),
        toolCount: Number(s.toolCount) || 0,
        lastTestedAt: String(s.lastTestedAt || ''),
      }));
  } catch (e: any) {
    logger.warn('[McpManager] mcpServers 配置解析失败: %s', e.message);
    return [];
  }
}

function writeServers(list: McpServerConf[]): void {
  saveConfig({ mcpServers: JSON.stringify(list) });
}

function genId(): string {
  return 'mcp_' + crypto.randomBytes(4).toString('hex');
}

/** 工具命名空间里的合法名（mcp__<name>__<tool>）：小写、非法字符换 _ */
function sanitizeServerName(raw: string): string {
  const s = (raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'mcp-server';
}

/** 名称去重：与其它启用中的源撞名时加序号 */
function dedupeName(name: string, all: McpServerConf[], selfId?: string): string {
  const taken = new Set(all.filter(s => s.id !== selfId).map(s => sanitizeServerName(s.name)));
  let n = sanitizeServerName(name);
  let i = 2;
  while (taken.has(n)) n = `${sanitizeServerName(name)}_${i++}`;
  return n;
}

export function listServers(): McpServerConf[] {
  return readServers().map(s => ({ ...s, token: s.token }));
}

/**
 * 保存（全量替换）。对「没有名称或 URL/Token 变过」的源先握手拿 serverInfo.name；
 * 任一启用源的 url/token 指纹变化时返回 true，调用方据此重建 pi 会话。
 */
export async function saveServers(
  incoming: Array<Partial<McpServerConf>>,
): Promise<{ ok: boolean; servers: McpServerConf[]; fingerprintChanged: boolean }> {
  const before = readServers();
  const beforeFp = mcpFingerprint();
  const result: McpServerConf[] = [];

  for (const item of incoming) {
    const url = String(item.url || '').trim();
    if (!url) continue;
    const existing = before.find(s => s.id === item.id);
    const token = String(item.token ?? existing?.token ?? '');
    const conf: McpServerConf = {
      id: item.id || existing?.id || genId(),
      name: String(item.name ?? existing?.name ?? ''),
      url,
      token,
      enabled: item.enabled !== false,
      status: existing?.status || 'untested',
      statusText: existing?.statusText || '',
      toolCount: existing?.toolCount || 0,
      lastTestedAt: existing?.lastTestedAt || '',
    };

    // 名称缺失、连接信息变了、或从未握手过（如种子配置）：握手自报名称并确认连通性
    const needProbe = !conf.name || !existing || existing.url !== url || existing.token !== token
      || conf.status === 'untested' || !conf.lastTestedAt;
    if (needProbe) {
      const probe = await probeServer(url, token);
      if (probe.ok) {
        conf.name = dedupeName(probe.serverName || new URL(url).hostname, incoming as McpServerConf[], conf.id);
        conf.status = 'ok';
        conf.statusText = `已连接 · ${probe.tools?.length || 0} 个工具`;
        conf.toolCount = probe.tools?.length || 0;
        conf.lastTestedAt = new Date().toISOString();
      } else if (!conf.name) {
        // 完全拿不到名称时用 host 兜底，保证引擎侧命名空间可用
        conf.name = dedupeName(new URL(url).hostname, incoming as McpServerConf[], conf.id);
        conf.status = 'error';
        conf.statusText = probe.error || '连接失败';
      } else {
        conf.status = 'error';
        conf.statusText = probe.error || '连接失败';
      }
    }
    result.push(conf);
  }

  writeServers(result);
  return { ok: true, servers: result, fingerprintChanged: mcpFingerprint() !== beforeFp };
}

/** 启用中源的连接指纹（url+token），变化即需要重建 pi 会话 */
export function mcpFingerprint(): string {
  const enabled = readServers().filter(s => s.enabled).map(s => `${s.url}::${s.token}`);
  return crypto.createHash('sha1').update(JSON.stringify(enabled)).digest('hex');
}

// ---------- pi SDK 注入 ----------

/**
 * 映射为 SDK 的 LoadedMcpConfig（createMcpExtension 的 loadConfig 返回值）。
 * exposure 必须显式 'direct'——SDK 默认 codemode，工具对模型完全不可见。
 */
export function buildLoadedMcpConfig(): { servers: any[]; errors: string[]; autoEnableCodemode: boolean } {
  const servers = readServers()
    .filter(s => s.enabled && /^https?:\/\//i.test(s.url))
    .map(s => ({
      name: sanitizeServerName(s.name || s.id),
      config: {
        type: 'http',
        url: s.url,
        headers: s.token.trim() ? { Authorization: `Bearer ${s.token.trim()}` } : undefined,
        exposure: 'direct',
      },
      source: 'app-config',
      scope: 'extension',
    }));
  return { servers, errors: [], autoEnableCodemode: false };
}

// ---------- 拉取数据（主进程直连，不经 AI） ----------

function ensureTables(): void {
  run(`CREATE TABLE IF NOT EXISTS mcp_meta (
    server_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
    PRIMARY KEY (server_id, key)
  )`);
  run(`CREATE TABLE IF NOT EXISTS mcp_classifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    record_key TEXT NOT NULL,
    labels_json TEXT,
    model TEXT,
    created_at TEXT DEFAULT (datetime('now', '+8 hours'))
  )`);
  run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_class_key ON mcp_classifications(server_id, tool, record_key)`);
}

function metaGet(serverId: string, key: string): string {
  ensureTables();
  const row = qOne('SELECT value FROM mcp_meta WHERE server_id = ? AND key = ?', serverId, key);
  return row ? String((row as any).value ?? '') : '';
}

function metaSet(serverId: string, key: string, value: string): void {
  ensureTables();
  run(
    `INSERT INTO mcp_meta (server_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')`,
    serverId, key, value,
  );
}

/** CallToolResult → 结构化数据：优先解析 JSON 文本，失败则返回纯文本；信封对象单列 meta */
function parseToolResult(res: any): { rows: any[]; text: string; meta: any } {
  const blocks = (res && res.content) || [];
  const text = blocks
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text ?? '')
    .join('\n');
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return { rows: parsed, text, meta: null };
    if (parsed && typeof parsed === 'object') {
      // 常见包装：{items|records|data|list: [...]}，其余字段（hasMore/total/page…）作为信封 meta
      for (const k of ['items', 'records', 'data', 'list', 'rows']) {
        if (Array.isArray(parsed[k])) {
          const meta = { ...parsed };
          delete meta[k];
          return { rows: parsed[k], text, meta };
        }
      }
      return { rows: [parsed], text, meta: null };
    }
  } catch { /* 非 JSON，按纯文本展示 */ }
  return { rows: [], text, meta: null };
}

/**
 * 展开 payload 字段：不少 MCP server 把正文塞在 payload JSON 字符串里
 * （如 qihang-site 的线索 {name, company, message, product}），
 * 不展开的话表格全是稀疏空列。扁平对象直接合并进行（键冲突以行字段优先）。
 */
function expandPayload(row: any): any {
  if (!row || typeof row !== 'object') return row;
  const raw = row.payload;
  if (raw === undefined || raw === null) return row;
  let obj: any;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return row; }
  } else if (typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw;
  } else {
    return row;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return row;
  const out = { ...row };
  for (const [k, v] of Object.entries(obj)) {
    if (out[k] === undefined || out[k] === null || out[k] === '') out[k] = v;
  }
  delete out.payload;
  return out;
}

function findTool(tools: McpToolInfo[], keyword: string): McpToolInfo | undefined {
  return tools.find(t => t.name === keyword) || tools.find(t => t.name.includes(keyword));
}

/**
 * 源概览：工具清单 + 服务端说明 + 域统计（describe_metrics → count_index，30 天窗）。
 * 结果缓存进 mcp_meta，refresh=true 强制重拉。
 */
export async function sourceOverview(
  serverId: string,
  refresh = false,
): Promise<{ ok: boolean; error?: string; instructions?: string; tools?: McpToolInfo[]; metrics?: any; counts?: any }> {
  const conf = readServers().find(s => s.id === serverId);
  if (!conf) return { ok: false, error: '数据源不存在' };

  if (!refresh) {
    const cachedTools = metaGet(serverId, 'tools');
    if (cachedTools) {
      try {
        return {
          ok: true,
          instructions: metaGet(serverId, 'instructions'),
          tools: JSON.parse(cachedTools),
          metrics: JSON.parse(metaGet(serverId, 'metrics') || 'null'),
          counts: JSON.parse(metaGet(serverId, 'counts') || 'null'),
        };
      } catch { /* 缓存坏了走重拉 */ }
    }
  }

  try {
    const result = await withClient(conf.url, conf.token, async (client) => {
      const tools: McpToolInfo[] = (await client.listTools() || []).map((t: any) => ({
        name: String(t.name || ''),
        description: String(t.description || '').split('\n')[0],
      }));
      let metrics: any = null;
      let counts: any = null;
      const describeTool = findTool(tools, 'describe_metrics');
      if (describeTool) {
        const res = await client.callTool(describeTool.name, {});
        metrics = parseToolResult(res).rows[0] ?? parseToolResult(res).text;
      }
      const countTool = findTool(tools, 'count_index');
      if (countTool) {
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
        const res = await client.callTool(countTool.name, { from, to });
        // count_index 返回每域一行的数组（[{domain, rows, table}]），整体保留
        const parsed = parseToolResult(res);
        counts = parsed.rows.length ? parsed.rows : parsed.text;
      }
      return { instructions: String(client.instructions || ''), tools, metrics, counts };
    }, 60_000);

    metaSet(serverId, 'tools', JSON.stringify(result.tools));
    metaSet(serverId, 'instructions', result.instructions);
    metaSet(serverId, 'metrics', JSON.stringify(result.metrics));
    metaSet(serverId, 'counts', JSON.stringify(result.counts));
    return { ok: true, ...result };
  } catch (e: any) {
    return { ok: false, error: friendlyMcpError(e) };
  }
}

/**
 * 拉某个工具（业务域）的记录。时间参数仅在工具 schema 支持时由服务端忽略，
 * 默认近 30 天 + 分页续拉（page 从 1 起）。
 */
export async function fetchRecords(
  serverId: string,
  toolName: string,
  opts: { from?: string; to?: string; page?: number } = {},
): Promise<{ ok: boolean; error?: string; rows?: any[]; text?: string; hasMore?: boolean; total?: number }> {
  const conf = readServers().find(s => s.id === serverId);
  if (!conf) return { ok: false, error: '数据源不存在' };
  const to = opts.to || new Date().toISOString().slice(0, 10);
  const from = opts.from || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const page = Math.max(1, Number(opts.page) || 1);
  try {
    return await withClient(conf.url, conf.token, async (client) => {
      const res = await client.callTool(toolName, { from, to, page });
      const { rows, text, meta } = parseToolResult(res);
      // payload 展开后再注键（recordKey 用 id 字段，展开不影响；正文字段进了行，AI 分类也更省截断）
      const expanded = rows.map(r => expandPayload(r));
      // 给每行注上与 AI 分类一致的稳定键，前端据此匹配 mcp_classifications 的标签
      for (const r of expanded) {
        if (r && typeof r === 'object' && !Array.isArray(r)) (r as any)._mcp_key = recordKey(r);
      }
      return {
        ok: true,
        rows: expanded,
        text,
        hasMore: meta ? meta.hasMore === true : false,
        total: meta && Number.isFinite(Number(meta.total)) ? Number(meta.total) : undefined,
      };
    }, 60_000);
  } catch (e: any) {
    return { ok: false, error: friendlyMcpError(e) };
  }
}

// ---------- AI 分类 ----------

/** 记录稳定键：优先业务 id 字段，否则整条 JSON 的 sha1（内容变了视为新记录） */
function recordKey(rec: any): string {
  const idFields = ['id', 'uuid', 'leadId', 'companyId', 'orderNo', 'sessionUuid'];
  for (const f of idFields) {
    if (rec && rec[f] !== undefined && rec[f] !== null && String(rec[f]).trim()) return String(rec[f]);
  }
  return crypto.createHash('sha1').update(JSON.stringify(rec)).digest('hex');
}

/** 压缩记录给 AI：长文本截断，控制 token 体积 */
function compactRecord(rec: any): any {
  const out: any = {};
  for (const [k, v] of Object.entries(rec || {})) {
    if (v === null || v === undefined) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    out[k] = s.length > 200 ? s.slice(0, 200) + '…' : v;
  }
  return out;
}

/**
 * 对一个业务域的记录跑 AI 分类：
 * 1) AI 根据字段与内容提出 2~4 个分类维度（如「意图：报价/产品/售后」）
 * 2) 逐条打标，结果按 (server_id, tool, record_key) upsert 进 mcp_classifications
 * force=true 或记录未缓存时才调 AI；其余直接走缓存。
 */
export async function classifyRecords(
  serverId: string,
  toolName: string,
  opts: { limit?: number; force?: boolean } = {},
): Promise<{
  ok: boolean; error?: string; dimensions?: any[]; labeled?: number; cached?: number;
}> {
  const conf = readServers().find(s => s.id === serverId);
  if (!conf) return { ok: false, error: '数据源不存在' };
  ensureTables();

  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 60));
  const fetched = await fetchRecords(serverId, toolName, { page: 1 });
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const records = (fetched.rows || []).slice(0, limit);
  if (!records.length) return { ok: true, dimensions: [], labeled: 0, cached: 0 };

  // 已缓存的直接跳过（force 时全部重打）
  const pending: Array<{ key: string; rec: any }> = [];
  let cached = 0;
  for (const rec of records) {
    const key = recordKey(rec);
    const hit = opts.force ? null : qOne(
      'SELECT id FROM mcp_classifications WHERE server_id = ? AND tool = ? AND record_key = ?',
      serverId, toolName, key,
    );
    if (hit) cached++;
    else pending.push({ key, rec });
  }

  let dimensions: any[] = [];
  if (pending.length) {
    // 分类维度假定复用：同源同工具上一轮的维度作为参考传入，保持口径稳定
    const prevDims = metaGet(serverId, `dims:${toolName}`);
    const samples = pending.map(p => ({ key: p.key, ...compactRecord(p.rec) }));
    const prompt = [
      '你是数据分类引擎。下面是一批业务记录（JSON）。请：',
      '1. 根据字段名与内容设计 2~4 个对业务有价值的分类维度（如「意图」「优先级」「客户阶段」），每个维度给出 2~5 个互斥取值；',
      prevDims ? `2. 尽量沿用上一轮已使用的维度口径：${prevDims}` : '2. 维度命名用中文、简短；',
      '3. 为每条记录在每个维度上标注一个取值。',
      '只输出 JSON，不要输出任何其他文字，也不要调用任何工具。格式：',
      '{"dimensions":[{"name":"维度名","values":["取值1","取值2"]}],"labels":[{"key":"记录key","labels":{"维度名":"取值"}}]}',
      '',
      `记录（共 ${samples.length} 条）：`,
      JSON.stringify(samples),
    ].join('\n');

    // 懒加载避免与 pi-agent 的静态依赖成环
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runPi } = require('./pi-agent') as typeof import('./pi-agent');
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const finalText = await new Promise<string>((resolve, reject) => {
      let out = '';
      runPi({
        prompt,
        sessionId: `mcp-classify-${day}`,
        timeoutMs: 180_000,
        onDone: (t) => resolve(t),
        onError: (e) => reject(new Error(e)),
        onDelta: (d) => { out += d; },
      }).catch(reject);
      void out;
    }).catch((e: any) => { throw new Error(`AI 分类失败：${e.message}`); });

    const jsonStr = finalText.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim();
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr.slice(jsonStr.indexOf('{'), jsonStr.lastIndexOf('}') + 1));
    } catch {
      return { ok: false, error: 'AI 未返回有效 JSON，请重试' };
    }
    dimensions = Array.isArray(parsed.dimensions) ? parsed.dimensions : [];
    const labels: any[] = Array.isArray(parsed.labels) ? parsed.labels : [];
    for (const item of labels) {
      if (!item || !item.key) continue;
      run(
        `INSERT INTO mcp_classifications (server_id, tool, record_key, labels_json, model, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now', '+8 hours'))
         ON CONFLICT(server_id, tool, record_key) DO UPDATE SET
           labels_json = excluded.labels_json, model = excluded.model,
           created_at = datetime('now', '+8 hours')`,
        serverId, toolName, String(item.key), JSON.stringify(item.labels || {}), 'pi',
      );
    }
    if (dimensions.length) metaSet(serverId, `dims:${toolName}`, JSON.stringify(dimensions));
    return { ok: true, dimensions, labeled: labels.length, cached };
  }

  // 全部命中缓存：维度从 meta 里取
  try { dimensions = JSON.parse(metaGet(serverId, `dims:${toolName}`) || '[]'); } catch { dimensions = []; }
  return { ok: true, dimensions, labeled: 0, cached };
}

/** 读某域的已缓存分类标签（页面表格渲染用） */
export function listClassifications(serverId: string, toolName: string): { key: string; labels: any; created_at: string }[] {
  ensureTables();
  return q(
    'SELECT record_key, labels_json, created_at FROM mcp_classifications WHERE server_id = ? AND tool = ? ORDER BY id DESC',
    serverId, toolName,
  ).map((r: any) => ({ key: String(r.record_key), labels: JSON.parse(r.labels_json || '{}'), created_at: String(r.created_at) }));
}
