/**
 * 问雷达：基于已采集的会话对话做检索问答（一次性的轻量 AI 调用）。
 * 流程：问题拆关键词 → searchMessages 多关键词检索命中消息 →
 * 组装带来源编号（S1/S2…）的上下文 → 复用 ai-tools 的 generateWithPi 生成答案 →
 * 返回 { answer, refs }，refs 为命中的会话列表（前端可点击跳转详情页）。
 * 上下文有字数预算，防止 prompt 爆炸；未开启雷达或无命中时不调 AI。
 */
import { agentRadar } from '../services/agent-radar';
import { generateWithPi } from '../services/ai-tools';
import logger from '../services/logger';

const MAX_MESSAGES = 32;        // 带入上下文的最大消息条数
const MAX_CTX_CHARS = 14000;    // 检索片段总字数预算
const PER_MSG_CHARS = 500;      // 单条消息截断
const PER_QUERY_LIMIT = 30;     // 每个关键词检索条数
const MAX_KEYWORDS = 6;         // 最多检索的关键词数

export interface AskRadarRef {
  tool: string;
  sessionId: string;
  title: string;
  projectDir: string;
}

export interface AskRadarResult {
  answer: string;
  refs: AskRadarRef[];
  hits: number;
}

/** 常见疑问词/虚词：拆词与过滤时剔除，不作为检索关键词 */
const STOPWORD_RE = /^(?:的|了|吗|呢|吧|啊|么|哪些|什么|怎么|怎样|如何|为什么|为啥|多少|几|是不是|有没有|有没有可能|哪个|帮忙|帮我|请|查|查下|查一下|看看|看下|一下|这些|这个|那个|以及|还有|和|与|或|在|是|有|个|我|你|他|它|地|得|着|过|会|要|能|可以|应该|需要|现在|告诉|说说|讲讲)$/;

/** 从问题里拆出检索关键词：英文/数字整词 + 中文串拆相邻二字词（trigram/LIKE 双通道都吃得下） */
export function extractKeywords(question: string): string[] {
  const cleaned = String(question || '').replace(/[，。！？、；：“”‘’（）【】《》,!?;:'"()\[\]{}<>|/\\~`@#$%^&*+=]/g, ' ');
  const raw = cleaned.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const tok of raw) {
    // 纯 ASCII（含数字）整词
    if (/^[A-Za-z0-9._-]{2,}$/.test(tok)) { out.push(tok); continue; }
    // 中文（混合）串：整串作为精确短语候选，再拆相邻二字词兜底
    const cjkRuns = tok.match(/[\u4e00-\u9fff]{2,}/g) || [];
    for (const run of cjkRuns) {
      if (run.length <= 3) { out.push(run); continue; }
      out.push(run); // 整串（trigram 短语可精确匹配）
      for (let i = 0; i + 1 < run.length && out.length < MAX_KEYWORDS + 4; i++) {
        const bi = run.slice(i, i + 2);
        if (!STOPWORD_RE.test(bi)) out.push(bi);
      }
    }
  }
  // 去重 + 滤停用词/单字，控制关键词数量
  const seen = new Set<string>();
  const kws: string[] = [];
  for (const k of out) {
    if (k.length < 2 || STOPWORD_RE.test(k) || seen.has(k)) continue;
    seen.add(k);
    kws.push(k);
    if (kws.length >= MAX_KEYWORDS) break;
  }
  return kws;
}

/** 多关键词检索并按命中次数+时间排序合并（每条消息记录命中了几个关键词） */
function searchHits(keywords: string[]): any[] {
  const map = new Map<string, { row: any; hits: number }>();
  for (const kw of keywords) {
    let rows: any[] = [];
    try { rows = agentRadar.searchMessages(kw, PER_QUERY_LIMIT); } catch { continue; }
    for (const r of rows) {
      const key = `${r.tool}|${r.sessionId}|${r.seq}`;
      const prev = map.get(key);
      if (prev) prev.hits += 1;
      else map.set(key, { row: r, hits: 1 });
    }
  }
  return [...map.values()]
    .sort((a, b) => (b.hits - a.hits) || ((b.row.ts || 0) - (a.row.ts || 0)))
    .slice(0, MAX_MESSAGES)
    .map((x) => ({ ...x.row, _hits: x.hits }));
}

function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 组装带来源编号的上下文片段（S1/S2… 按会话聚合，控制总字数） */
function buildContext(rows: any[]): { context: string; refs: AskRadarRef[] } {
  const refs: AskRadarRef[] = [];
  const refIdx = new Map<string, number>();
  const lines: string[] = [];
  let budget = MAX_CTX_CHARS;
  for (const r of rows) {
    const key = `${r.tool}|${r.sessionId}`;
    let idx = refIdx.get(key);
    if (!idx) {
      refs.push({ tool: r.tool, sessionId: r.sessionId, title: r.title || '', projectDir: r.projectDir || '' });
      idx = refs.length;
      refIdx.set(key, idx);
    }
    const content = String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, PER_MSG_CHARS);
    if (!content) continue;
    const line = `[S${idx}] ${fmtTime(r.ts)} ${r.role === 'user' ? '用户' : 'AI'}：${content}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  return { context: lines.join('\n\n'), refs };
}

/**
 * 问雷达主入口。返回 answer + refs（命中会话，前端跳详情用）。
 * 雷达没开/无命中时不调 AI，直接给可操作的提示。
 * modelPattern 可选（provider/modelId），缺省用 pi 默认模型。
 */
export async function askRadar(question: string, modelPattern?: string): Promise<AskRadarResult> {
  const q = String(question || '').trim();
  if (!q) throw new Error('请输入要问的问题');

  const keywords = extractKeywords(q);
  if (!keywords.length) throw new Error('没能从问题里提取出可检索的关键词，换个具体些的问法试试');
  logger.info('[RadarAsk] 关键词: %s', keywords.join(', '));

  const rows = searchHits(keywords);
  if (!rows.length) {
    return {
      answer: '没有在已采集的对话中找到相关内容。可以试试：\n- 换个关键词（工具名、项目名、功能名）\n- 先点「立即扫描」确保最新会话已入库',
      refs: [],
      hits: 0,
    };
  }

  const { context, refs } = buildContext(rows);
  const prompt = [
    '你是「问雷达」助手。下面是从本机 AI 编码工具（Pi / Claude Code / Codex 等）历史会话中检索到的对话片段，每段开头的 [S1] [S2] 是来源编号，与来源列表一一对应。',
    '',
    '## 检索到的对话片段',
    context,
    '',
    '## 用户问题',
    q,
    '',
    '## 要求',
    '1. 只依据片段内容回答，不要编造；片段不足以回答时明确说明哪些方面缺少信息。',
    '2. 引用片段信息时标注来源编号，如 [S1]。',
    '3. 用简洁的中文 markdown 回答，重点是结论和事实，不要复述检索过程。',
  ].join('\n');

  // 一次性问答：独立会话（不复用上下文，避免历史大 prompt 反复计费）；
  // 2 分钟硬超时快速失败——服务商限流（429）时 pi SDK 会无限退避重试，不设超时会一直挂在「思考中」
  const answer = await generateWithPi({ prompt, sessionId: 'radar_' + Date.now(), modelPattern, timeoutMs: 120_000 });
  return { answer, refs, hits: rows.length };
}
