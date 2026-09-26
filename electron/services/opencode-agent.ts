/**
 * opencode agent 适配层
 *
 * 对外函数面与 pi-agent.ts 对齐（runOc/listOcModels/abortOcSession/disposeOc），
 * 上层（main.ts / agent-runtime.ts）按运行时开关分流，pi 原样保留为回退引擎。
 *
 * 关键事实（POC 实测，scripts/oc-poc.mjs）：
 * - SDK 1.18.x 发消息方法名是 session.prompt（不是 chat），POST 响应直接返回最终 Message
 * - SSE message.part.updated 增量时序可能滞后于 POST 返回 → UI 流式走 SSE，最终文本以 POST 响应为准，
 *   结束时补发 POST 文本与已流出文本的差值，保证 main.ts 累积的 reply 完整
 * - serve 会话不继承默认模型，每轮必须显式传 model:{providerID, modelID}
 * - 工具注入方式是 MCP 常驻（后续 workbench-mcp 接入）；本阶段 customTools 忽略并告警
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import logger from './logger';
import { ensureOcServer, stopOcServer, ocServerStatus } from './opencode-process';
import { ocConfigFile } from './opencode-config';

// ---- SDK 动态导入（ESM-only，同 pi-agent.ts 技巧） ----
let sdkModule: any = null;
let sdkLoading: Promise<any> | null = null;
function loadOcSdk(): Promise<any> {
  if (sdkModule) return Promise.resolve(sdkModule);
  if (!sdkLoading) {
    sdkLoading = new Function('spec', 'return import(spec)')('@opencode-ai/sdk')
      .then((mod: any) => { sdkModule = mod; return mod; })
      .catch((err: Error) => {
        sdkLoading = null;
        logger.error('[OcAgent] SDK load failed: %s', err.message);
        throw err;
      });
  }
  return sdkLoading!;
}

let clientBase = '';
let clientPromise: Promise<any> | null = null;
async function getClient(): Promise<any> {
  const baseUrl = await ensureOcServer();
  if (!clientPromise || clientBase !== baseUrl) {
    clientBase = baseUrl;
    clientPromise = loadOcSdk().then((m) => {
      logger.info('[OcAgent] SDK loaded, client ready: %s', baseUrl);
      return m.createOpencodeClient({ baseUrl });
    });
    clientPromise.catch(() => { clientPromise = null; });
  }
  return clientPromise;
}

const unwrap = (r: any) => (r && typeof r === 'object' && 'data' in r ? r.data : r);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}（${Math.round(ms / 1000)}s 超时）`)), ms))]);
}

// ---- SSE 全局单订阅，按 sessionID 分发 ----
export interface OcCallbacks {
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
  onTool?: (event: { type: 'start' | 'end' | 'thinking'; name?: string; args?: any; error?: boolean; text?: string }) => void;
  onDone?: (finalText: string) => void;
  onError?: (err: string) => void;
}
const listeners = new Map<string, OcCallbacks>(); // ocSessionId → callbacks
const printed = new Map<string, number>(); // `${messageID}:${partID}` → 已打印长度
let sseStarted = false;

function diffText(partId: string, messageID: string, text: string): string {
  const key = `${messageID}:${partId}`;
  const from = printed.get(key) ?? 0;
  if (text.length <= from) return '';
  printed.set(key, text.length);
  return text.slice(from);
}

async function ensureSse(client: any): Promise<void> {
  if (sseStarted) return;
  sseStarted = true;
  try {
    const sub: any = await withTimeout(client.event.subscribe(), 10000, 'opencode 事件订阅失败');
    const stream = sub?.stream ?? sub;
    (async () => {
      for await (const ev of stream) handleEvent(ev);
    })().catch((e) => {
      sseStarted = false;
      logger.warn('[OcAgent] SSE stream ended: %s', e?.message ?? e);
    });
    logger.info('[OcAgent] SSE subscribed');
  } catch (e: any) {
    sseStarted = false;
    logger.warn('[OcAgent] SSE subscribe failed: %s', e?.message ?? e);
  }
}

function handleEvent(ev: any): void {
  if (ev?.type === 'message.part.updated') {
    const part = ev.properties?.part;
    if (!part?.sessionID) return;
    const cb = listeners.get(part.sessionID);
    if (!cb) return;
    if (part.type === 'text') {
      const delta = ev.properties?.delta ?? diffText(part.id, part.messageID, part.text ?? '');
      if (delta) cb.onDelta?.(delta);
    } else if (part.type === 'reasoning') {
      const delta = ev.properties?.delta ?? diffText(part.id, part.messageID, part.text ?? '');
      if (delta) cb.onThinking?.(delta);
    } else if (part.type === 'tool') {
      const status = part?.state?.status ?? part?.status;
      if (status === 'pending' || status === 'running') {
        cb.onTool?.({ type: 'start', name: part.tool ?? part.title, args: part?.state?.input });
      } else {
        cb.onTool?.({ type: 'end', name: part.tool ?? part.title, error: status === 'error' });
      }
    }
    return;
  }
  if (ev?.type === 'session.error') {
    const sid = ev.properties?.sessionID ?? ev.properties?.error?.sessionID;
    const cb = sid ? listeners.get(sid) : undefined;
    const msg = ev.properties?.error?.data?.message ?? ev.properties?.error?.message ?? '未知错误';
    if (cb) cb.onError?.(msg);
    else logger.warn('[OcAgent] session.error: %s', msg);
  }
}

// ---- 会话映射：appSessionId → { ocSessionId, cwd, tail } ----
interface OcSessionEntry {
  ocId: string;
  cwd?: string;
  tail: Promise<void>;
}
const sessions = new Map<string, OcSessionEntry>();

function entryKey(appSessionId: string, cwd?: string): string {
  return `${cwd || ''}::${appSessionId}`;
}

async function getOcSession(client: any, appSessionId: string, cwd?: string): Promise<OcSessionEntry> {
  const key = entryKey(appSessionId, cwd);
  const existing = sessions.get(key);
  if (existing) return existing;
  const created = unwrap(await withTimeout(client.session.create({
    query: cwd ? { directory: cwd } : undefined,
    body: { title: `qihang-${appSessionId.slice(0, 24)}` },
  }), 15000, 'opencode 会话创建失败'));
  const entry: OcSessionEntry = { ocId: created.id, cwd, tail: Promise.resolve() };
  sessions.set(key, entry);
  logger.info('[OcAgent] session mapped %s -> %s (cwd=%s)', appSessionId, entry.ocId, cwd || '-');
  return entry;
}

// ---- 错误文案 ----
function friendlyOcError(message: string | undefined): string {
  const m = (message || '').toString();
  if (/No credentials|API key|apiKey|Unauthorized|401/i.test(m)) {
    return '模型认证失败：请检查「设置 → 对话模型配置」中的 API Key，或重新选择模型后重试';
  }
  if (/No model|model not found|not a valid model/i.test(m)) {
    return '所选模型不可用：请在对话页顶部重新选择模型（opencode 运行时使用下方列表中的模型）';
  }
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|timeout|aborted/i.test(m)) {
    return '模型服务连接失败：请检查网络或服务地址（「设置 → 对话模型配置」）后重试';
  }
  return m || '未知错误';
}

// ---- 消息体构造 ----
function buildParts(prompt: string, images?: Array<{ data: string; mimeType: string }>): any[] {
  const parts: any[] = [];
  for (const img of images || []) {
    if (img?.data && img?.mimeType) {
      parts.push({ type: 'file', mime: img.mimeType, url: `data:${img.mimeType};base64,${img.data}` });
    }
  }
  parts.push({ type: 'text', text: prompt });
  return parts;
}

// ---- 对外：执行一轮 opencode 对话 ----
export interface RunOcOptions extends OcCallbacks {
  prompt: string;
  sessionId: string;
  cwd?: string;
  /** provider/modelId（provider 键与「对话模型配置」及 opencode 模型列表一致） */
  modelPattern?: string;
  images?: Array<{ data: string; mimeType: string }>;
  customTools?: any[];
}

export async function runOc(opts: RunOcOptions): Promise<void> {
  const {
    prompt, sessionId, cwd, modelPattern, images,
    onDelta = () => {}, onThinking = () => {}, onTool = () => {}, onDone = () => {}, onError = () => {},
    customTools,
  } = opts;
  if (customTools?.length) {
    logger.warn('[OcAgent] session %s: %d customTools ignored (tools are provided via MCP)', sessionId, customTools.length);
  }

  const client = await getClient();
  await ensureSse(client);
  const entry = await getOcSession(client, sessionId, cwd);

  // 解析每轮模型：显式 pattern 优先；否则取模型列表第一个可用项
  let pattern = modelPattern;
  if (!pattern) {
    const { models } = await listOcModels();
    pattern = models.find((m) => m.configured)?.pattern;
  }
  if (!pattern) {
    onError('请先设置模型：opencode 运行时未检测到可用模型，请在「设置 → 对话模型配置」配置后重试');
    return;
  }
  const idx = pattern.indexOf('/');
  const providerID = idx >= 0 ? pattern.slice(0, idx) : pattern;
  const modelID = idx >= 0 ? pattern.slice(idx + 1) : '';

  // 同一会话内串行（对齐 pi 的 tail 语义）
  entry.tail = entry.tail.then(async () => {
    listeners.set(entry.ocId, { onDelta, onThinking, onTool, onError });
    const t0 = Date.now();
    logger.info('[OcAgent] prompt start: session=%s model=%s/%s cwd=%s images=%d', entry.ocId, providerID, modelID, cwd || '-', images?.length ?? 0);
    try {
      const promptPromise = client.session.prompt({
        query: cwd ? { directory: cwd } : undefined,
        path: { id: entry.ocId },
        body: { parts: buildParts(prompt, images), model: { providerID, modelID } },
      });
      // 单轮硬超时：到点中止会话并报错，避免 UI 永久转圈
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        logger.warn('[OcAgent] prompt timeout after 180s, aborting session %s', entry.ocId);
        client.session.abort({ path: { id: entry.ocId } }).catch(() => {});
      }, 180000);
      let res: any;
      try {
        res = unwrap(await promptPromise);
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) {
        onError('AI 响应超时（180 秒），已自动中止。请重试或更换模型');
        return;
      }
      const elapsed = Date.now() - t0;
      // 最终文本以 POST 响应为准，补发 SSE 滞后导致的差值
      const finalText = (res?.parts ?? [])
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text ?? '')
        .join('');
      const finish = res?.info?.finish ?? res?.finish;
      logger.info('[OcAgent] prompt done in %dms finish=%s textLen=%d', elapsed, finish, finalText.length);
      const emitted = [...printed.entries()]
        .filter(([k]) => k.startsWith(`${res?.info?.id ?? res?.id ?? ''}:`))
        .reduce((acc, [, v]) => acc + v, 0);
      if (finish === 'error') {
        const errMsg = res?.info?.error?.data?.message ?? res?.error?.data?.message;
        onError(friendlyOcError(errMsg));
        return;
      }
      if (finalText.length > emitted) onDelta(finalText.slice(emitted));
      onDone(finalText);
    } catch (e: any) {
      if (e?.name === 'AbortError' || /abort/i.test(e?.message ?? '')) {
        onDone('');
        return;
      }
      logger.error('[OcAgent] runOc failed after %dms: %s', Date.now() - t0, e?.message ?? e);
      onError(friendlyOcError(e?.message ?? String(e)));
    } finally {
      listeners.delete(entry.ocId);
    }
  });
  await entry.tail;
}

// ---- 对外：模型列表 ----
export interface OcModelInfo {
  provider: string;
  providerLabel: string;
  id: string;
  name: string;
  pattern: string;
  configured: boolean;
}

function providersFromFile(): OcModelInfo[] {
  try {
    const cfg = JSON.parse(fs.readFileSync(ocConfigFile(), 'utf-8'));
    const out: OcModelInfo[] = [];
    for (const [key, p] of Object.entries(cfg.provider || {}) as [string, any]) {
      const hasKey = !!p?.options?.apiKey;
      for (const [mid, mv] of Object.entries(p?.models || {}) as [string, any]) {
        out.push({
          provider: key,
          providerLabel: p?.name || key,
          id: mid,
          name: (mv?.name as string) || mid,
          pattern: `${key}/${mid}`,
          configured: hasKey,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function listOcModels(): Promise<{ models: OcModelInfo[]; error?: string }> {
  try {
    const client = await getClient();
    const res = unwrap(await withTimeout(client.config.providers(), 10000, 'opencode 模型列表获取失败'));
    const list = res?.providers ?? res?.list ?? [];
    const models: OcModelInfo[] = [];
    for (const p of list) {
      const key = p?.id || p?.name;
      if (!key) continue;
      const modelsMap = p?.models ?? {};
      if (Array.isArray(modelsMap)) {
        for (const m of modelsMap) {
          const mid = m?.id ?? m;
          if (mid) models.push({ provider: key, providerLabel: p?.name || key, id: mid, name: m?.name || mid, pattern: `${key}/${mid}`, configured: true });
        }
      } else {
        for (const [mid, mv] of Object.entries(modelsMap) as [string, any]) {
          models.push({ provider: key, providerLabel: p?.name || key, id: mid, name: mv?.name || mid, pattern: `${key}/${mid}`, configured: true });
        }
      }
    }
    if (models.length) {
      models.sort((a, b) => a.providerLabel.localeCompare(b.providerLabel) || a.name.localeCompare(b.name));
      return { models };
    }
    // 服务器返回空 → 回退本地配置文件（含 configured 标记）
    return { models: providersFromFile() };
  } catch (e: any) {
    logger.warn('[OcAgent] listOcModels via server failed: %s', e?.message ?? e);
    return { models: providersFromFile(), error: e?.message };
  }
}

// ---- 对外：中止 / 清理 ----
export async function abortOcSession(appSessionId: string): Promise<void> {
  for (const [key, entry] of sessions.entries()) {
    if (!key.endsWith(`::${appSessionId}`)) continue;
    try {
      const client = await getClient();
      await client.session.abort({ path: { id: entry.ocId } });
      listeners.delete(entry.ocId);
      logger.info('[OcAgent] aborted %s (oc=%s)', appSessionId, entry.ocId);
    } catch (e: any) {
      logger.warn('[OcAgent] abort failed: %s', e?.message ?? e);
    }
  }
}

export function disposeOc(): void {
  listeners.clear();
  printed.clear();
  sessions.clear();
  clientPromise = null;
  clientBase = '';
  sseStarted = false;
  stopOcServer();
}

export function ocStatus(): { running: boolean; baseUrl: string; sessions: number } {
  return { ...ocServerStatus(), sessions: sessions.size };
}

// 供诊断：opencode 全局授权 provider 名单（只读键名）
export function ocAuthProviders(): string[] {
  try {
    const p = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    const auth = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Object.keys(auth || {});
  } catch {
    return [];
  }
}
