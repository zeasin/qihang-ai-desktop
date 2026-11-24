/**
 * 雷达提炼层②：AI 会话摘要（主进程）。
 * 触发：worker 转发的会话收口（idle 跃迁）→ 门槛检查（规则价值分 ≥3、未摘要或有足够新内容）
 * → 延迟一会儿让 ingest 把最后的消息采完 → 取消息拼对话稿（清洗工具标记 + 头尾双窗口：开头保意图、结尾保结论） → generateWithPi 一次性提炼
 * → 结果经 worker 写回 radar_session.summary。
 * 摘要串行执行（一个队列），限流环境下失败静默丢弃，下次收口自然重试。
 * 门槛挡掉了大部分水会话（一两轮的问答），AI 调用量极小。
 * 存量补摘自动化：启动 90 秒后跑一次 + 每 6 小时兜底，覆盖 App 关闭期间错过的收口、
 * 以及源被重采缩水的会话（摘要比消息还多时强制重摘）。
 */
import { agentRadar } from '../services/agent-radar';
import { generateWithPi } from '../services/ai-tools';
import { reportSummaryNote } from './radar-note-save';
import logger from '../services/logger';
import * as appConfig from '../services/app-config';

const MIN_SCORE = 3;          // 价值分门槛（computeValueScore 0-5）
const MIN_NEW_MSGS = 4;       // 已有摘要时，新消息数达到该值才重新提炼
const PROCESS_DELAY_MS = 20_000;  // 收口后延迟：给 ingest 一轮时间把末尾消息采完
const BACKFILL_STARTUP_DELAY_MS = 90_000;  // 启动补摘延迟：等 worker 首轮采集写完最新会话
const BACKFILL_INTERVAL_MS = 6 * 3_600_000;  // 兜底补摘间隔
const USER_CHARS = 300;       // 对话稿里用户消息截断（用户输入是摘要的核心素材，给足）
const AI_CHARS = 400;         // AI 输出截断：太短会把结论拦腰截掉，总量由 MAX_TRANS_CHARS 兜住
const MAX_TRANS_CHARS = 12000;
const TAIL_BUDGET_CHARS = 4000;   // 尾部窗口预算：结论/结果几乎都在会话末尾，必须进稿

interface DigestTask { tool: string; sessionId: string; at: number; }

const queue: DigestTask[] = [];
let queued = new Set<string>();
let chain: Promise<void> = Promise.resolve();
let started = false;

export function startRadarDigest(): void {
  if (started) return;
  started = true;
  agentRadar.onStateEvents((events) => {
    if (!agentRadar.isEnabled()) return;
    for (const e of events) {
      if (e.state !== 'idle') continue;
      enqueue(e.tool, e.sessionId);
    }
    if (queue.length) void pump();
  });
  // 存量补摘自动化：App 关闭期间错过的收口、重采缩水的会话都靠这里兜底；
  // 无事可做时只是一次廉价 SQL 查询
  setTimeout(() => runBackfill('启动'), BACKFILL_STARTUP_DELAY_MS);
  setInterval(() => runBackfill('定时'), BACKFILL_INTERVAL_MS);
  logger.info('[RadarDigest] 摘要编排器已启动（价值分门槛 %s；补摘：启动%ss 后 + 每 %sh）', MIN_SCORE, BACKFILL_STARTUP_DELAY_MS / 1000, BACKFILL_INTERVAL_MS / 3_600_000);
}

function runBackfill(reason: string): void {
  try {
    const n = backfillSummaries();
    if (n) logger.info('[RadarDigest] 自动补摘入队 %s 个会话（%s）', n, reason);
  } catch (e: any) {
    logger.warn('[RadarDigest] 自动补摘失败（%s）: %s', reason, e?.message || e);
  }
}

function pump(): Promise<void> {
  chain = chain.then(processNext).catch(() => {});
  return chain;
}

/** 入队（去重 + 唤醒队列）；immediate=true 免 20s 延迟（补摘时数据早已采完，没必要等） */
function enqueue(tool: string, sessionId: string, immediate = false): void {
  const key = `${tool}/${sessionId}`;
  if (queued.has(key)) return;
  queued.add(key);
  queue.push({ tool, sessionId, at: Date.now() - (immediate ? PROCESS_DELAY_MS : 0) });
}

/**
 * 存量补摘要：把「高价值但没摘要 / 摘要已过期 / 源被重采缩水」的历史会话全部排队提炼。
 * 供雷达页手动触发 + 启动/定时自动触发（功能上线前收口的老会话永远不会走 idle 事件，只能这样补）。
 * 返回本次入队的数量。
 */
export function backfillSummaries(): number {
  if (!agentRadar.isEnabled()) return 0;
  const rows = agentRadar.sessionsNeedingSummary(MIN_SCORE, 200);
  for (const r of rows) enqueue(r.tool, r.sessionId, true);
  if (queue.length) void pump();
  if (rows.length) logger.info('[RadarDigest] 存量补摘要入队 %s 个会话', rows.length);
  return rows.length;
}

/** 循环消化队列直到取空；处理中新入队的任务也会被顺带取走，调用方 pump 一次即可 */
async function processNext(): Promise<void> {
  for (;;) {
    const task = queue.shift();
    if (!task) { queued.clear(); return; }
    const key = `${task.tool}/${task.sessionId}`;
    queued.delete(key);
    try {
      // 延迟到 ingest 把末尾消息采完再读数据（补摘要的场景也顺延 20s，无伤大雅）
      const wait = PROCESS_DELAY_MS - (Date.now() - task.at);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      await digestOne(task.tool, task.sessionId);
    } catch (e: any) {
      logger.warn('[RadarDigest] 摘要失败 %s/%s: %s', task.tool, task.sessionId.slice(0, 24), String(e?.message || e).slice(0, 120));
    }
  }
}

/**
 * 正文清洗：剥离混进消息正文的结构性标记——工具调用标记碎片（trae/codex 等会把
 * <tool_call>/<arg_value> 残留在 content 里）、claude-code 的 /命令包装
 * （<command-name>/compact</command-name> 之类，剥壳后保留命令本身）。
 * AI 会把这些原样照抄进摘要；只剥标记，不动正文语义。
 */
const NOISE_TAG_RE = /<\/?(?:tool_call|tool_result|tool_use|arg_value|arg_key|function|function_results|invoke|parameter|command-name|command-message|command-args|command-contents|local-command-stdout|local-command-stderr|antml:[a-z_]+|le:[a-z_]+)\b[^>]*>/gi;

export function cleanContent(s: string): string {
  return String(s || '').replace(NOISE_TAG_RE, '');
}

interface TransLine { text: string; len: number; }

function toLines(msgs: any[]): TransLine[] {
  const lines: TransLine[] = [];
  for (const m of msgs) {
    const isUser = m.role === 'user';
    const text = cleanContent(m.content).replace(/\s+/g, ' ').trim().slice(0, isUser ? USER_CHARS : AI_CHARS);
    if (!text) continue;
    const line = `${isUser ? '用户' : 'AI'}：${text}`;
    lines.push({ text: line, len: line.length });
  }
  return lines;
}

/**
 * 头尾双窗口取材：预算装不下全部对话时，头部保「用户要干什么」，
 * 尾部保「最后干成了什么」（结论几乎都在末尾），中间以省略标记代替。
 * 旧逻辑从头顺序拼、预算用尽即停，长会话的后半段（结论）完全进不了摘要。
 */
export function buildTranscript(msgs: any[]): string[] {
  const lines = toLines(msgs);
  const totalLen = lines.reduce((a, l) => a + l.len + 1, 0);
  if (totalLen <= MAX_TRANS_CHARS) return lines.map((l) => l.text);

  let headEnd = 0;
  let used = 0;
  while (headEnd < lines.length && used + lines[headEnd].len + 1 <= MAX_TRANS_CHARS - TAIL_BUDGET_CHARS) {
    used += lines[headEnd].len + 1;
    headEnd++;
  }
  let tailStart = lines.length;
  let tailUsed = 0;
  while (tailStart > headEnd && tailUsed + lines[tailStart - 1].len + 1 <= TAIL_BUDGET_CHARS) {
    tailUsed += lines[tailStart - 1].len + 1;
    tailStart--;
  }
  const out = lines.slice(0, headEnd).map((l) => l.text);
  if (tailStart > headEnd) {
    out.push(`（……中间省略 ${tailStart - headEnd} 条……）`);
    out.push(...lines.slice(tailStart).map((l) => l.text));
  }
  return out;
}

/** 单会话摘要提炼（供存量补摘队列与调试点射用；幂等门槛在函数内自行判断） */
export async function digestOne(tool: string, sessionId: string): Promise<void> {
  const info: any = agentRadar.sessionInfo(tool, sessionId);
  // 冻结只停采集（源长期无动静），会话数据已采全在本地，摘要照常提炼——否则冻结会话永远没有摘要
  if (!info) return;
  if ((info.valueScore ?? 0) < MIN_SCORE) return;
  // 已摘要过：新内容够多（≥ MIN_NEW_MSGS）才重新提炼；摘要比消息还多（delta<0）
  // 说明源被重采缩水、摘要是旧素材留底，也必须重摘
  const delta = (info.messageCount || 0) - (info.summaryMsgCount || 0);
  if (info.summary && delta < MIN_NEW_MSGS && delta >= 0) return;

  const msgs: any[] = agentRadar.getMessages(tool, sessionId) || [];
  if (!msgs.length) return;

  const transcript = buildTranscript(msgs);
  if (transcript.length < 3) return;

  const prompt = [
    '下面是一场 AI 编码工具会话的对话稿（用户/AI 交替）。请提炼成一张「会话卡片」，严格按以下格式输出（markdown，不超过 8 行）：',
    '',
    '**做了什么**：一句话概括本次会话完成的事',
    '**关键决策/结论**：重要方案选择、发现的根因、达成的结论（没有就写「无」）',
    '**涉及文件/模块**：对话中明确提到的文件、模块或功能点（没有就写「未提及」）',
    '**结果与遗留**：完成/失败/进行中，以及待跟进的事项（没有就写「无」）',
    '',
    '要求：只依据对话稿，不要编造；语言精炼，每项一行。',
    '',
    '## 会话信息',
    `项目：${info.projectDir || '未知'}`,
    `标题：${info.title || '（无标题）'}`,
    '',
    '## 对话稿',
    transcript.join('\n'),
  ].join('\n');

  // 会话摘要使用设置页「会话摘要模型」（digestModel，简报同级的独立专项），未设置时明确记录回落到 pi 默认模型
  const digestModel = String(appConfig.getConfig('digestModel') || '').trim() || undefined;
  logger.info('[RadarDigest] 会话摘要使用模型: %s', digestModel || '(pi 默认)');
  const summary = (await generateWithPi({ prompt, sessionId: 'radar_digest_' + Date.now(), modelPattern: digestModel, timeoutMs: 120_000 })).trim();
  if (!summary) return;
  agentRadar.saveSummary(tool, sessionId, summary.slice(0, 2000), info.messageCount || 0);
  const title = upgradeTitle(tool, sessionId, summary, info.title || '');
  // 落盘导出副本（默认笔记库 AI活动/会话/）：让摘要回到数据主体，AI 对话/笔记搜索/今天页提炼可见
  reportSummaryNote(
    { tool, sessionId, title, projectDir: info.projectDir || '', sourceUpdatedAt: info.sourceUpdatedAt || 0 },
    summary,
  );
  logger.info('[RadarDigest] 摘要完成: %s/%s %s字', tool, sessionId.slice(0, 24), summary.length);
}

const MIN_TITLE_CHARS = 6;  // 标题少于该字数视为低质（「你好」「继续任务」），摘要完成后升级
const TITLE_CHARS = 30;     // 生成标题的截断长度

/** 从摘要「做了什么」段生成短标题；提取不到就退回摘要首行 */
export function buildTitleFromSummary(summary: string): string {
  const s = String(summary || '');
  const m = s.match(/\*\*做了什么\*\*[：:]?\s*(.+)/);
  const raw = (m ? m[1] : s.split('\n')[0] || '').replace(/\*\*/g, '').replace(/^[：:\s]+/, '').trim();
  return raw.slice(0, TITLE_CHARS);
}

/** 低质标题升级：空/占位/过短的标题用摘要生成的新标题写回（标题同时参与会话级检索，升级即检索面变好）。
 *  返回生效标题（升级成功为新标题，否则原标题），供落盘文件使用统一口径。 */
function upgradeTitle(tool: string, sessionId: string, summary: string, oldTitle: string): string {
  const t = String(oldTitle || '').trim();
  if (t.length >= MIN_TITLE_CHARS && !/^(?:（无标题）|\(无标题\))$/.test(t)) return t;
  const next = buildTitleFromSummary(summary);
  if (next.length < 4) return t;
  agentRadar.updateTitle(tool, sessionId, next);
  logger.info('[RadarDigest] 标题升级: %s/%s 「%s」→「%s」', tool, sessionId.slice(0, 16), t, next);
  return next;
}
