/**
 * 问雷达：基于已采集的会话对话做检索问答（一次性的轻量 AI 调用）。
 * 流程：问题拆关键词 → 双通道检索（searchMessages 消息级 + searchSessionsByText 标题/摘要级兜底）→
 * 组装带来源编号（S1/S2…）的上下文（摘要命中的会话排前、摘要直接作素材，同会话不重复收录）→
 * 复用 ai-tools 的 generateWithPi 生成答案 →
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
const MAX_KEYWORDS = 8;         // 最多检索的关键词数
const PER_SESSION_LIMIT = 5;    // 单会话进上下文的消息上限：防高频会话刷屏挤掉其他会话
const SUM_SESSIONS = 5;         // 摘要注入的会话数上限（标题/摘要命中）
const SUM_CHARS = 400;          // 单条摘要截断（四段卡片 8 行内，400 字保住主体）

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

/** 停用字：二字滑窗不识词边界，跨词碎片（如「的电」「存为」）几乎必然混入虚字，含任一即弃 */
const STOP_CHARS_RE = /[的了吗呢吧啊么是和与或也就在有我你他它这那怎什为]/;

/** 从问题里拆出检索关键词：英文/数字整词 + 中文串出完整短语（≤4 字，可被 trigram 精确命中）+
 *  相邻二字滑窗兜底（LIKE 通道吃二字词）。完整词优先、碎片垫底，避免碎片挤掉核心词。 */
export function extractKeywords(question: string): string[] {
  const cleaned = String(question || '').replace(/[，。！？、；：“”‘’（）【】《》,!?;:'"()\[\]{}<>|/\\~`@#$%^&*+=]/g, ' ');
  const raw = cleaned.split(/\s+/).filter(Boolean);
  const primary: string[] = [];
  const secondary: string[] = [];
  for (const tok of raw) {
    // 纯 ASCII（含数字）整词
    if (/^[A-Za-z0-9._-]{2,}$/.test(tok)) { primary.push(tok); continue; }
    // 中文（混合）串：≤4 字整串（短语可精确匹配），更长只出滑窗（长整串要求正文逐字连续，必 0 命中）
    const cjkRuns = tok.match(/[\u4e00-\u9fff]{2,}/g) || [];
    for (const run of cjkRuns) {
      if (run.length <= 4) { primary.push(run); continue; }
      for (let i = 0; i + 1 < run.length && secondary.length < MAX_KEYWORDS + 4; i++) {
        const bi = run.slice(i, i + 2);
        if (STOPWORD_RE.test(bi) || STOP_CHARS_RE.test(bi)) continue;
        secondary.push(bi);
      }
    }
  }
  // 去重 + 滤停用词/单字，先取完整词再补碎片，控制关键词数量
  const seen = new Set<string>();
  const kws: string[] = [];
  for (const k of [...primary, ...secondary]) {
    if (k.length < 2 || STOPWORD_RE.test(k) || seen.has(k)) continue;
    seen.add(k);
    kws.push(k);
    if (kws.length >= MAX_KEYWORDS) break;
  }
  return kws;
}

/** 多关键词检索并按命中次数+时间排序合并（每条消息记录命中了几个关键词）；导出供评测脚本复用真实链路 */
export function searchHits(keywords: string[]): any[] {
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
  const sorted = [...map.values()]
    .sort((a, b) => (b.hits - a.hits) || ((b.row.ts || 0) - (a.row.ts || 0)));
  // 单会话配额后再截总量：一个高频会话最多 PER_SESSION_LIMIT 条，剩下的名额让给别的会话
  const perCount = new Map<string, number>();
  const out: any[] = [];
  for (const x of sorted) {
    const skey = `${x.row.tool}|${x.row.sessionId}`;
    const c = perCount.get(skey) || 0;
    if (c >= PER_SESSION_LIMIT) continue;
    perCount.set(skey, c + 1);
    out.push({ ...x.row, _hits: x.hits });
    if (out.length >= MAX_MESSAGES) break;
  }
  return out;
}

function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 组装带来源编号的上下文片段（S1/S2…）：摘要命中排前（主题相关性最强），消息命中垫后；同会话不重复收录 */
function buildContext(rows: any[], sumHits: any[] = []): { context: string; refs: AskRadarRef[] } {
  const refs: AskRadarRef[] = [];
  const refIdx = new Map<string, number>();
  const lines: string[] = [];
  let budget = MAX_CTX_CHARS;
  const refOf = (r: any): number => {
    const key = `${r.tool}|${r.sessionId}`;
    let idx = refIdx.get(key);
    if (!idx) {
      refs.push({ tool: r.tool, sessionId: r.sessionId, title: r.title || '', projectDir: r.projectDir || '' });
      idx = refs.length;
      refIdx.set(key, idx);
    }
    return idx;
  };
  // 摘要行：标题/摘要命中的会话，摘要本身就是高质量凝练素材，直接可答
  const sumSet = new Set<string>();
  for (const s of sumHits) {
    sumSet.add(`${s.tool}|${s.sessionId}`);
    const summary = String(s.summary || '').replace(/\s+/g, ' ').trim().slice(0, SUM_CHARS);
    const line = summary
      ? `[S${refOf(s)}] ${fmtTime(s.sourceUpdatedAt)} 会话摘要（${s.title || '无标题'}）：${summary}`
      : `[S${refOf(s)}] ${fmtTime(s.sourceUpdatedAt)} 会话（标题命中）：${s.title || '无标题'}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  // 消息行：已被摘要命中的会话跳过（摘要行已覆盖），省预算给别的会话
  for (const r of rows) {
    if (sumSet.has(`${r.tool}|${r.sessionId}`)) continue;
    const content = String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, PER_MSG_CHARS);
    if (!content) continue;
    const line = `[S${refOf(r)}] ${fmtTime(r.ts)} ${r.role === 'user' ? '用户' : 'AI'}：${content}`;
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
  // 会话级兜底（摘要注入）：标题/摘要整串命中直接点名会话，不受消息级刷屏影响
  let sumHits: any[] = [];
  try { sumHits = agentRadar.searchSessionsByText(keywords, SUM_SESSIONS); } catch { /* 检索失败不阻塞消息级 */ }
  if (!rows.length && !sumHits.length) {
    return {
      answer: '没有在已采集的对话中找到相关内容。可以试试：\n- 换个关键词（工具名、项目名、功能名）\n- 先点「立即扫描」确保最新会话已入库',
      refs: [],
      hits: 0,
    };
  }

  const { context, refs } = buildContext(rows, sumHits);
  const prompt = [
    '你是「问雷达」助手。下面是从本机 AI 编码工具（Pi / Claude Code / Codex 等）历史会话中检索到的材料，每段开头的 [S1] [S2] 是来源编号，与来源列表一一对应。以「会话摘要」开头的来源是该会话的 AI 提炼卡片（可信度高，可直接作答），其余是原始对话片段。',
    '',
    '## 检索到的对话片段',
    context,
    '',
    '## 用户问题',
    q,
    '',
    '## 要求',
    '1. 只依据材料内容回答，不要编造；材料不足以回答时明确说明哪些方面缺少信息。',
    '2. 引用材料信息时标注来源编号，如 [S1]；只能引用来源列表中实际存在的编号，不得编造编号。',
    '3. 用简洁的中文 markdown 回答，重点是结论和事实，不要复述检索过程。',
  ].join('\n');

  // 一次性问答：独立会话（不复用上下文，避免历史大 prompt 反复计费）；
  // 2 分钟硬超时快速失败——服务商限流（429）时 pi SDK 会无限退避重试，不设超时会一直挂在「思考中」
  // 模型由用户在问雷达页面显式选择；未选时走 pi 默认模型
  const raw = await generateWithPi({ prompt, sessionId: 'radar_' + Date.now(), modelPattern, timeoutMs: 120_000 });
  // 引用校验：模型偶尔编造 [S99] 这类越界编号（来源列表只有 refs.length 条），剔除防误导跳转
  const valid = new Set(refs.map((_, i) => i + 1));
  const answer = raw.replace(/\[S(\d+)\]/g, (m, n) => (valid.has(Number(n)) ? m : ''));
  return { answer, refs, hits: rows.length + sumHits.length };
}
