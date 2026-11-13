/**
 * 雷达提炼层②：AI 会话摘要（主进程）。
 * 触发：worker 转发的会话收口（idle 跃迁）→ 门槛检查（规则价值分 ≥3、未摘要或有足够新内容）
 * → 延迟一会儿让 ingest 把最后的消息采完 → 取消息组装精简对话稿 → generateWithPi 一次性提炼
 * → 结果经 worker 写回 radar_session.summary。
 * 摘要串行执行（一个队列），限流环境下失败静默丢弃，下次收口自然重试。
 * 门槛挡掉了大部分水会话（一两轮的问答），AI 调用量极小。
 */
import { agentRadar } from '../services/agent-radar';
import { generateWithPi } from '../services/ai-tools';
import logger from '../services/logger';

const MIN_SCORE = 3;          // 价值分门槛（computeValueScore 0-5）
const MIN_NEW_MSGS = 4;       // 已有摘要时，新消息数达到该值才重新提炼
const PROCESS_DELAY_MS = 20_000;  // 收口后延迟：给 ingest 一轮时间把末尾消息采完
const USER_CHARS = 300;       // 对话稿里用户消息截断（用户输入是摘要的核心素材，给足）
const AI_CHARS = 160;         // AI 输出截断（长篇流水账对摘要无用）
const MAX_TRANS_CHARS = 12000;

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
  logger.info('[RadarDigest] 摘要编排器已启动（价值分门槛 %s）', MIN_SCORE);
}

function pump(): Promise<void> {
  chain = chain.then(processNext).catch(() => {});
  return chain;
}

/** 入队（去重 + 唤醒队列） */
function enqueue(tool: string, sessionId: string): void {
  const key = `${tool}/${sessionId}`;
  if (queued.has(key)) return;
  queued.add(key);
  queue.push({ tool, sessionId, at: Date.now() });
}

/**
 * 存量补摘要：把「高价值但还没摘要」的历史会话全部排队提炼。
 * 供雷达页手动触发（功能上线前收口的老会话永远不会走 idle 事件，只能这样补）。
 * 返回本次入队的数量。
 */
export function backfillSummaries(): number {
  if (!agentRadar.isEnabled()) return 0;
  const rows = agentRadar.sessionsNeedingSummary(MIN_SCORE, 200);
  for (const r of rows) enqueue(r.tool, r.sessionId);
  if (queue.length) void pump();
  if (rows.length) logger.info('[RadarDigest] 存量补摘要入队 %s 个会话', rows.length);
  return rows.length;
}

async function processNext(): Promise<void> {
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

async function digestOne(tool: string, sessionId: string): Promise<void> {
  const info: any = agentRadar.sessionInfo(tool, sessionId);
  if (!info || info.frozen) return;
  if ((info.valueScore ?? 0) < MIN_SCORE) return;
  // 已摘要过且新内容不多：跳过（会话被用户捡起来续聊且聊够了才重新提炼）
  if (info.summary && (info.messageCount || 0) - (info.summaryMsgCount || 0) < MIN_NEW_MSGS) return;

  const msgs: any[] = agentRadar.getMessages(tool, sessionId) || [];
  if (!msgs.length) return;

  const transcript: string[] = [];
  let budget = MAX_TRANS_CHARS;
  for (const m of msgs) {
    const isUser = m.role === 'user';
    const text = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, isUser ? USER_CHARS : AI_CHARS);
    if (!text) continue;
    const line = `${isUser ? '用户' : 'AI'}：${text}`;
    if (line.length > budget) break;
    budget -= line.length;
    transcript.push(line);
  }
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

  const summary = (await generateWithPi({ prompt, sessionId: 'radar_digest_' + Date.now(), timeoutMs: 120_000 })).trim();
  if (!summary) return;
  agentRadar.saveSummary(tool, sessionId, summary.slice(0, 2000), info.messageCount || 0);
  logger.info('[RadarDigest] 摘要完成: %s/%s %s字', tool, sessionId.slice(0, 24), summary.length);
}
