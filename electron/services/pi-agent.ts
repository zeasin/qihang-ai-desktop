/**
 * pi agent SDK 原生集成层
 *
 * 在 Electron main 进程内直接使用官方 SDK（@earendil-works/pi-coding-agent）：
 * - 不再 spawn pi CLI 子进程，消除每次约 4.5s 的启动开销
  * - createAgentSession + subscribe 事件流，取代 JSON 行解析
  * - SessionManager.open 精确控制会话续接（与 CLI --session <path> 同机制）
 */
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

EventEmitter.defaultMaxListeners = 30;
import * as fs from 'fs';
import logger from './logger';

// ---- SDK 动态导入 ----
// SDK 是 ESM-only（package.json "type": "module"），而 Electron main 是 CJS。
// TS 在 CommonJS 目标下会把 import() 编译成 require()，会因 ESM 包无法 require 而失败，
// 因此用 Function 构造器保留运行时真正的动态 import()。
let sdkModule: any = null;
let sdkLoading: Promise<any> | null = null;
function loadSdk(): Promise<any> {
  if (sdkModule) return Promise.resolve(sdkModule);
  if (!sdkLoading) {
    sdkLoading = new Function('spec', 'return import(spec)')('@earendil-works/pi-coding-agent')
      .then((mod: any) => { sdkModule = mod; return mod; })
      .catch((err: Error) => {
        sdkLoading = null;
        logger.error('[PiAgent] SDK load failed: %s', err.message);
        throw err;
      });
  }
  return sdkLoading!;
}

// ---- 运行时组件缓存（按 cwd 复用，避免每个会话重复建服务） ----
interface RuntimeBundle {
  authStorage: any;
  modelRegistry: any;
}
const runtimeCache = new Map<string, Promise<RuntimeBundle>>();
function getAgentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent');
}
async function getRuntime(): Promise<RuntimeBundle> {
  const agentDir = getAgentDir();
  if (!runtimeCache.has(agentDir)) {
    const p = loadSdk().then((sdk) => {
      const authStorage = sdk.AuthStorage.create(path.join(agentDir, 'auth.json'));
      const modelRegistry = sdk.ModelRegistry.create(authStorage, path.join(agentDir, 'models.json'));
      return { authStorage, modelRegistry };
    });
    runtimeCache.set(agentDir, p);
    p.catch(() => runtimeCache.delete(agentDir));
  }
  return runtimeCache.get(agentDir)!;
}

// ---- 会话缓存：sessionId -> AgentSession ----
interface SessionHandle {
  session: any;
  modelRegistry: any;
  currentModelPattern?: string;
  customTools: any[];
  tail: Promise<void>; // 同一会话内的串行链，保证 prompt 不并发
}
const sessions = new Map<string, SessionHandle>();

/** 固定系统提示词（硬编码，不允许用户修改；不依赖 ~/.pi/agent/SYSTEM.md） */
export const QIHANG_SYSTEM_PROMPT = `你是「启航 AI 助手」，一个运行在本地的智能办公助手，集成在启航 AI 工作台中。

你的特点：
- 使用中文交流，回复简洁、专业、可执行
- 熟悉工作台提供的数据查询、笔记读写、文件与代码操作等工具，需要时主动查询数据后再回答
- 回答问题时先理解用户意图，必要时用工具核实数据，不编造

行为准则：
- 回复始终使用简体中文（用户用其他语言提问时，用对应语言回复）
- 语气友好自然，但不要过度客套，不要每轮都说自我介绍
- 涉及文件或代码时，明确给出路径与改动点
- 数据为空时如实说明，不要编造`;

function sessionFilePath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getAgentDir(), 'sessions', `assistant-v2-${safe}.jsonl`);
}

async function getSession(opts: {
  sessionId: string;
  cwd?: string;
  modelPattern?: string;
  customTools?: any[];
}): Promise<SessionHandle> {
  const sdk = await loadSdk();
  const { sessionId, cwd, modelPattern, customTools = [] } = opts;
  let handle = sessions.get(sessionId);
  if (handle) {
    // 会话已缓存：工具集在创建时固定，后续调用若请求不同工具集，沿用已注册的并告警
    if (customTools.length && handle.customTools.length !== customTools.length) {
      logger.warn('[PiAgent] session %s already created with %d tools, ignoring new %d tools', sessionId, handle.customTools.length, customTools.length);
    }
    // 会话已缓存但请求的模型不同：立即 resolve 并 setModel，更新 currentModelPattern，避免后面再重复 set
    if (modelPattern && modelPattern !== handle.currentModelPattern) {
      try {
        const idx = modelPattern.indexOf('/');
        if (idx >= 0) {
          const model = (await getRuntime()).modelRegistry.find(modelPattern.slice(0, idx), modelPattern.slice(idx + 1));
          if (model) {
            await handle.session.setModel(model);
            handle.currentModelPattern = modelPattern;
          }
        }
      } catch (e: any) {
        logger.warn('[PiAgent] setModel on cached session failed: %s', e.message);
      }
    }
    return handle;
  }

  const bundle = await getRuntime();
  const sm = sdk.SessionManager.open(sessionFilePath(sessionId));
  let model: any;
  let modelFallbackMessage: string | undefined;
  if (modelPattern) {
    const idx = modelPattern.indexOf('/');
    const provider = idx >= 0 ? modelPattern.slice(0, idx) : undefined;
    const modelId = idx >= 0 ? modelPattern.slice(idx + 1) : modelPattern;
    if (provider) model = bundle.modelRegistry.find(provider, modelId);
    if (!model) modelFallbackMessage = `model ${modelPattern} not found, using default`;
  }

  const settingsManager = sdk.SettingsManager.create(cwd || process.cwd(), getAgentDir());
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: cwd || process.cwd(),
    agentDir: getAgentDir(),
    settingsManager,
    systemPrompt: QIHANG_SYSTEM_PROMPT,
  });
  await resourceLoader.reload();
  const { session } = await sdk.createAgentSession({
    cwd: cwd || process.cwd(),
    agentDir: getAgentDir(),
    authStorage: bundle.authStorage,
    modelRegistry: bundle.modelRegistry,
    model,
    sessionManager: sm,
    thinkingLevel: 'off',
    customTools,
    settingsManager,
    resourceLoader,
  });
  if (modelFallbackMessage) logger.warn('[PiAgent] %s', modelFallbackMessage);

  handle = { session, modelRegistry: bundle.modelRegistry, customTools, tail: Promise.resolve() };
  sessions.set(sessionId, handle);
  return handle;
}

/** 按应用模型档案映射的 pattern 解析为 SDK Model；返回 null 表示用默认模型 */
export async function resolvePiModel(modelPattern: string | undefined): Promise<any | null> {
  if (!modelPattern) return null;
  const bundle = await getRuntime();
  const idx = modelPattern.indexOf('/');
  if (idx < 0) return null;
  return bundle.modelRegistry.find(modelPattern.slice(0, idx), modelPattern.slice(idx + 1)) || null;
}

export interface PiModelInfo {
  provider: string;
  providerLabel: string;
  id: string;
  name: string;
  pattern: string;
  configured: boolean;
}

/**
 * 把 pi SDK 的原始错误信息转换为对用户友好的中文提示。
 * 主要是把「未配置 API Key / 认证失败 / 无可用模型」等机器可读报错
 * 转成「请设置模型」这类可操作提示，其余错误保留原信息。
 */
function friendlyPiError(message: string | undefined): string {
  const m = (message || '').toString();
  if (/No API key found/i.test(m)) {
    return '请先设置模型：当前模型未配置 API Key，请在「设置 → 对话模型配置」中填写服务地址与 API Key 后重试';
  }
  if (/No model selected/i.test(m)) {
    return '请先设置模型：请在「设置 → 对话模型配置」中选择一个可用模型后重试';
  }
  if (/No models available/i.test(m)) {
    return '请先设置模型：当前没有可用的模型，请在「设置 → 对话模型配置」中配置后重试';
  }
  if (/Authentication failed/i.test(m)) {
    return '模型认证失败：凭据可能已过期或网络不可用，请检查「设置 → 对话模型配置」中的配置后重试';
  }
  return m || '未知错误';
}

/**
 * 列出 pi agent 可用的模型（来自 ~/.pi/agent 的 ModelRegistry）。
 * 优先返回已配置认证的模型（getAvailable），一个都没有时兜底列出全部内置模型。
 */
export async function listPiModels(): Promise<{ models: PiModelInfo[]; error?: string }> {
  try {
    const bundle = await getRuntime();
    const registry = bundle.modelRegistry;
    const available = (registry.getAvailable() || []) as any[];
    const configured = available.length > 0;
    const list = (configured ? available : (registry.getAll() || [])) as any[];

    // 读取用户实际在 models.json 中配置的 provider/model 集合，
    // 过滤掉 pi SDK 内置的默认模型（如 deepseek-v4-pro），
    // 只展示用户自己配置的模型。
    const userConfig = readModelsJson();
    const userModelKeys = new Set<string>();
    for (const [provKey, provVal] of Object.entries(userConfig.providers || {})) {
      const models = (provVal as any)?.models;
      if (Array.isArray(models)) {
        for (const m of models) {
          if (m && m.id) userModelKeys.add(`${provKey}/${m.id}`);
        }
      }
    }

    const models: PiModelInfo[] = list
      .filter((m: any) => {
        const provider: string = m.provider || '';
        const id: string = m.id || '';
        const key = `${provider}/${id}`;
        // 如果用户有配置，只显示用户配置的模型；如果用户没有任何配置，显示全部
        return userModelKeys.size === 0 || userModelKeys.has(key);
      })
      .map((m: any) => {
        const provider: string = m.provider || '';
        const id: string = m.id || '';
        let providerLabel = provider;
        try { providerLabel = registry.getProviderDisplayName(provider) || provider; } catch {}
        return {
          provider,
          providerLabel,
          id,
          name: m.name || id,
          pattern: provider && id ? `${provider}/${id}` : id,
          configured,
        };
      });
    models.sort(
      (a, b) => a.providerLabel.localeCompare(b.providerLabel) || a.name.localeCompare(b.name),
    );
    return { models };
  } catch (e: any) {
    logger.warn('[PiAgent] listPiModels failed: %s', e && e.message ? e.message : e);
    return { models: [], error: (e && e.message) || String(e) };
  }
}

// ---- 事件回调类型 ----
export interface RunPiCallbacks {
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
  onTool?: (event: { type: 'start' | 'end' | 'thinking'; name?: string; args?: any; error?: boolean; text?: string }) => void;
  onDone?: (finalText: string) => void;
  onError?: (err: string) => void;
}

export interface RunPiOptions extends RunPiCallbacks {
  prompt: string;
  sessionId: string;
  cwd?: string;
  modelPattern?: string;
  images?: Array<{ data: string; mimeType: string }>;
  timeoutMs?: number;
  /** 注入的自定义工具定义（pi SDK ToolDefinition[]，参见 ./tools） */
  customTools?: any[];
}

/**
 * 使用官方 SDK 执行一轮 pi agent 对话。
 * 事件与旧的 CLI JSON 流语义保持一致（start/end/thinking），前端无需改动。
 */
export async function runPi(opts: RunPiOptions): Promise<void> {
  const {
    prompt,
    sessionId,
    cwd,
    modelPattern,
    images,
    timeoutMs = 0,
    onDelta = () => {},
    onThinking = () => {},
    onTool = () => {},
    onDone = () => {},
    onError = () => {},
    customTools,
  } = opts;

  let handle: SessionHandle;
  try {
    handle = await getSession({ sessionId, cwd, modelPattern, customTools });
  } catch (e: any) {
    onError(`会话初始化失败：${friendlyPiError(e.message)}`);
    return;
  }
  const { session } = handle;

  // 模型切换：与上次不同的 pattern 才 setModel
  try {
    if (modelPattern && modelPattern !== handle.currentModelPattern) {
      const model = await resolvePiModel(modelPattern);
      if (model) {
        await session.setModel(model);
        handle.currentModelPattern = modelPattern;
      }
    }
  } catch (e: any) {
    logger.warn('[PiAgent] setModel failed: %s', e.message);
  }

  let finalText = '';
  let settled = false;
  const settle = () => { settled = true; };

  const unsubscribe = session.subscribe((evt: any) => {
    if (settled) return;
    switch (evt.type) {
      case 'message_update': {
        const aev = evt.assistantMessageEvent;
        if (!aev) break;
        if (aev.type === 'text_delta' && aev.delta) {
          finalText += aev.delta;
          onDelta(aev.delta);
        } else if (aev.type === 'thinking_delta' && aev.delta) {
          onThinking(aev.delta);
        }
        break;
      }
      case 'tool_execution_start':
        onTool({ type: 'start', name: evt.toolName, args: evt.args });
        break;
      case 'tool_execution_end':
        onTool({ type: 'end', name: evt.toolName, args: evt.args, error: !!evt.isError });
        break;
      default:
        break;
    }
  });

  let hardTimeout: NodeJS.Timeout | null = null;
  if (timeoutMs > 0) {
    hardTimeout = setTimeout(() => {
      logger.warn('[PiAgent] timeout %sms, aborting session %s', timeoutMs, sessionId);
      settle();
      void session.abort().catch(() => {});
      if (finalText) onDone(finalText);
      else onError('pi 处理超时');
    }, timeoutMs);
  }

  try {
    const promptOptions: any = {
      expandPromptTemplates: false,
      source: 'interactive',
    };
    if (images && images.length) {
      promptOptions.images = images.map((img) => ({
        type: 'image',
        source: { type: 'base64', mediaType: img.mimeType || 'image/png', data: img.data },
      }));
    }
    await handle.tail; // 等上一个 prompt 完成（串行化）
    handle.tail = session.prompt(prompt, promptOptions).then(
      () => {},
      (err: Error) => {
        if (settled) return; // 超时/中止已处理
        logger.error('[PiAgent] prompt error: %s', err.message);
        onError(friendlyPiError(err.message));
      },
    );
    await handle.tail;
    // prompt 正常结束（含工具调用链）
    if (!settled) {
      settle();
      const msgs = session.agent?.state?.messages || [];
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant' && last.stopReason === 'error') {
        onError(last.errorMessage ? friendlyPiError(last.errorMessage) : 'pi 处理出错');
      } else if (!finalText && last && last.role === 'assistant') {
        const textParts = (last.content || [])
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('');
        if (textParts) finalText = textParts;
        onDelta(finalText);
      }
      onDone(finalText);
    }
  } catch (e: any) {
    if (!settled) {
      settle();
      onError(friendlyPiError(e.message));
    }
  } finally {
    if (hardTimeout) clearTimeout(hardTimeout);
    unsubscribe();
  }
}

/**
 * 使用 pi agent 生成日报（非流式，返回完整文本，过滤思考过程）
 * 注入日报查询工具（待办/对话/文档/数据记录/提醒/日期），供 AI 自行查数生成。
 */
export async function generateDailyReport(sessionId: string, prompt: string): Promise<string> {
  const { buildReportToolDefs } = require('./tools');
  const customTools = await buildReportToolDefs(undefined);
  return new Promise((resolve, reject) => {
    let done = false;
    runPi({
      prompt,
      sessionId: sessionId + '_report',
      customTools,
      onDone: (finalText) => {
        done = true;
        const result = (finalText || '').trim().split('\n').filter(l => !l.trim().startsWith('数据来源')).join('\n').trim();
        resolve(result);
      },
      onError: (err) => {
        done = true;
        reject(new Error(err));
      },
    });
  });
}

/** 中止指定会话的当前运行 */
export async function abortSession(sessionId: string): Promise<void> {
  const handle = sessions.get(sessionId);
  if (!handle) return;
  try {
    await handle.session.abort();
  } catch (e: any) {
    logger.warn('[PiAgent] abort failed for %s: %s', sessionId, e.message);
  }
}

/** 释放全部会话（应用退出时调用） */
export async function disposeAll(): Promise<void> {
  for (const [, handle] of sessions) {
    try { handle.session.dispose(); } catch {}
  }
  sessions.clear();
}

// ---- 应用对话模型配置（读写 ~/.pi/agent/models.json，支持多条 provider） ----

export interface BuiltinModelConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

export interface BuiltinModelEntry {
  id: string;
  name?: string;
  [k: string]: any;
}

export interface BuiltinModelProviderConfig {
  /** provider 键（models.json 中的键名） */
  name: string;
  /** provider 显示名 */
  displayName: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  models: BuiltinModelEntry[];
}

function modelsJsonPath(): string {
  return path.join(getAgentDir(), 'models.json');
}

/** Strip line and block comments from JSON content (state machine, handles strings correctly) */
function stripJsonComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let inStr = false;
  let esc = false;
  while (i < n) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; i++; continue; }
    if (ch === '/' && i + 1 < n && src[i + 1] === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && i + 1 < n && src[i + 1] === '*') {
      i += 2;
      while (i + 1 < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 读取 models.json 全部 provider（容错解析，兼容注释格式） */
function readModelsJson(): any {
  const p = modelsJsonPath();
  if (!fs.existsSync(p)) return { providers: {} };
  try {
    const content = fs.readFileSync(p, 'utf-8');
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = JSON.parse(stripJsonComments(content));
    }
    if (!parsed || typeof parsed !== 'object') return { providers: {} };
    if (!parsed.providers) parsed.providers = {};
    return parsed;
  } catch (e: any) {
    logger.warn('[PiAgent] models.json parse failed: %s', e && e.message ? e.message : e);
    return { providers: {} };
  }
}

/** 列出 models.json 中的全部 provider 配置 */
export function listBuiltinModelConfigs(): { providers: BuiltinModelProviderConfig[] } {
  const cfg = readModelsJson();
  const providers = Object.entries(cfg.providers || {}).map(([key, p]: [string, any]) => ({
    name: key,
    displayName: (p && p.name) || '',
    baseUrl: (p && p.baseUrl) || '',
    apiKey: (p && p.apiKey) || '',
    api: (p && p.api) || '',
    models: (p && Array.isArray(p.models) ? p.models : []) as BuiltinModelEntry[],
  }));
  return { providers };
}

/**
 * 保存对话模型配置（全量替换 providers，保留每条的 api/compat 等其他字段）。
 * 写入后热重载 ModelRegistry，立即生效。
 */
export async function saveBuiltinModelConfigs(providers: {
  name: string;
  displayName?: string;
  baseUrl: string;
  apiKey: string;
  api?: string;
  modelNames: string[];
  models?: any[];
}[]): Promise<void> {
  const current = readModelsJson();
  const next: any = {};
  for (const p of providers) {
    const key = p.name.trim();
    if (!key) continue;
    const existing = current.providers[key] || {};
    let models: any[];
    if (Array.isArray(p.models) && p.models.length) {
      models = p.models
        .filter((m: any) => m && m.id && String(m.id).trim())
        .map((m: any) => {
          const entry: any = { id: String(m.id).trim() };
          if (m.name) entry.name = String(m.name).trim();
          if (m.reasoning) entry.reasoning = true;
          if (Array.isArray(m.input) && m.input.length) entry.input = m.input;
          else entry.input = ['text'];
          if (m.contextWindow) entry.contextWindow = Number(m.contextWindow);
          if (m.maxTokens) entry.maxTokens = Number(m.maxTokens);
          if (m.compat) entry.compat = m.compat;
          return entry;
        });
    } else {
      const modelNames = p.modelNames.map((id: string) => id.trim()).filter(Boolean);
      models = modelNames.map((id: string) => {
        const old = Array.isArray(existing.models) ? existing.models.find((m: any) => m && m.id === id) : undefined;
        if (old) {
          const { id: _omit, ...rest } = old;
          return { ...rest, id };
        }
        return { id, input: ['text'] };
      });
    }
    next[key] = {
      ...existing,
      baseUrl: p.baseUrl.replace(/\/+$/, ''),
      apiKey: p.apiKey.trim(),
      api: p.api || existing.api || 'openai-completions',
      models,
    };
  }
  current.providers = next;
  fs.writeFileSync(modelsJsonPath(), JSON.stringify(current, null, 2), 'utf-8');
  await reloadModelRegistry();
}

/** 热重载 ModelRegistry（配置变更后立即生效，无需重启） */
export async function reloadModelRegistry(): Promise<void> {
  try {
    const bundle = await getRuntime();
    if (bundle.modelRegistry && typeof bundle.modelRegistry.refresh === 'function') {
      bundle.modelRegistry.refresh();
    }
  } catch (e: any) {
    logger.warn('[PiAgent] reloadModelRegistry failed: %s', e && e.message ? e.message : e);
  }
}

/** 测试 OpenAI 兼容对话端点连通性 */
export async function testBuiltinModelConnection(cfg: BuiltinModelConfig): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  if (!base || !cfg.modelName.trim()) return { ok: false, error: '请填写服务地址与模型名称' };
  const url = base.includes('/chat/completions') ? base : base + '/chat/completions';
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey.trim() ? { Authorization: 'Bearer ' + cfg.apiKey.trim() } : {}),
      },
      body: JSON.stringify({ model: cfg.modelName.trim(), messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      let reason = text.slice(0, 300);
      try { reason = JSON.parse(text)?.error?.message || reason; } catch {}
      return { ok: false, error: `HTTP ${res.status}: ${reason}`, latencyMs };
    }
    return { ok: true, latencyMs };
  } catch (e: any) {
    return { ok: false, error: (e && e.message) || String(e), latencyMs: Date.now() - started };
  }
}
