/**
 * 昨日简报：雷达 AI 简报（替代今天页原规则「引擎简报」）。
 * 内容三块：昨日 AI 工具动态（昨日采集会话聚合）+ 昨日笔记库动态（昨天更新的文档）+ 今日待办（实时）。
 * 笔记库内容由笔记库子助手读原文摘录提炼，不进会话分片；子助手失败时原文摘录直接降级给主汇总。
 * 策略：按「昨日日期」缓存（内存 + 重启后从落盘文件恢复）；当天首次生成后落盘笔记库「日报/AI活动/<昨日日期>.md」并推送飞书一次；
 * 手动刷新重新生成并覆盖落盘文件（不重推，防刷屏）。昨日无任何 AI 会话与文档更新时不调 AI。
 * 所有时间取本机本地时间（禁止 UTC 转换）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as appConfig from '../services/app-config';
import * as db from '../services/database';
import * as feishu from '../services/feishu';
import * as projectScan from '../services/project-scan';
import { agentRadar } from '../services/agent-radar';
import { extractDigest } from '../services/note-digest';
import { generateWithPi } from '../services/ai-tools';
import { pickTodayTodos, renderTodoCandidates, type PickedTodo, type TodoContextDoc } from './todo-picker';
import logger from '../services/logger';

const SHARD_THRESHOLD = 20;    // 昨日会话超过该数量后分片（文档走笔记库子助手，不计入分片）
const SHARD_SIZE = 10;
const MAX_PARALLEL = 3;
const NOTE_PER_FILE_CHARS = 1500;   // 笔记摘录单篇上限
const NOTE_TOTAL_CHARS = 16_000;    // 笔记摘录总预算（篇数极多时按篇均摊，下限 200）
const NOTE_SUMMARY_CHARS = 4000;    // 笔记库子助手输出并入主汇总的上限
const PER_MSG_CHARS = 200;     // 会话首条用户消息截断
const BRIEF_TIMEOUT_MS = 120_000;
const SAVE_DIR = '日报/AI活动';

let cacheDate = '';
let cacheBrief = '';
let cacheGeneratedAt = '';
let pushedDate = '';
let inflight: Promise<any> | null = null;
let inflightDate = '';

/** 本地日期键 YYYY-MM-DD（本机时区，不用 toISOString） */
function dateKey(d = new Date()): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function timeLabel(d = new Date()): string {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function startOfDayTs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** 昨日区间（本地时间 0 点 ~ 24 点）与日期键 */
function yesterdayRange(): { start: number; end: number; key: string } {
  const s = new Date();
  s.setDate(s.getDate() - 1);
  s.setHours(0, 0, 0, 0);
  const e = new Date(s);
  e.setDate(e.getDate() + 1);
  return { start: s.getTime(), end: e.getTime(), key: dateKey(s) };
}
function fmtTs(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 昨日 AI 会话聚合：标题 + 摘要 + 首条用户消息（廉价探针，每会话只取头部几条） */
function collectAiSide(range: { start: number; end: number }): { lines: string[]; count: number; docs: TodoContextDoc[] } {
  const result = agentRadar.sessionsByRange(range.start, range.end, null);
  const lines: string[] = [];
  const docs: TodoContextDoc[] = [];
  for (const s of result.rows) {
    let firstAsk = '';
    try {
      const msgs = agentRadar.sessionMessages(String(s.tool), String(s.sessionId)) || [];
      const u = msgs.find((m: any) => String(m.role) === 'user' && String(m.content || '').trim());
      if (u) firstAsk = String(u.content).replace(/\s+/g, ' ').trim().slice(0, PER_MSG_CHARS);
    } catch { /* 单会话取消息失败不影响整体 */ }
    const title = String(s.title || '（无标题）');
    const seg = [`- [${s.tool}] ${title}（${fmtTs(s.sourceUpdatedAt)}）`];
    if (s.summary) seg.push(`  摘要：${String(s.summary).replace(/\s+/g, ' ').trim().slice(0, 300)}`);
    if (firstAsk) seg.push(`  首条请求：${firstAsk}`);
    lines.push(seg.join('\n'));
    // 主题索引用：会话标题 + 摘要 + 首条请求，用于判断待办是否与昨日在做的事相关
    docs.push({ title, text: [s.summary ? String(s.summary) : '', firstAsk].filter(Boolean).join(' ') });
  }
  return { lines, count: result.total, docs };
}

/** 昨日笔记库动态：当天更新的文档；待办/跟进为实时状态（归「今日待办」节） */
function collectNoteSide(range: { start: number; end: number }, digest: any): {
  lines: string[]; pendingTodos: number; followups: number; dayFiles: string[];
  excerpts: Array<{ label: string; content: string }>;
  dayDocs: TodoContextDoc[];
} {
  const lines: string[] = [];
  let pendingTodos = 0;
  let followups = 0;
  try {
    const d: any = digest;
    pendingTodos = (d?.todos || []).filter((t: any) => !t.done).length;
    followups = (d?.followups || []).filter((f: any) => !f.done).length;
    if (followups) lines.push(`- 跟进事项 ${followups} 条`);
  } catch { /* 笔记库未配置时跳过 */ }
  const files = projectScan.collectRecentFiles(null, range) || [];
  const dayFiles = files.map((f: any) => `${f.rel}（${f.projectName}，${fmtTs(f.mtime)}）`);
  const allotment = Math.min(NOTE_PER_FILE_CHARS, Math.max(200, Math.floor(NOTE_TOTAL_CHARS / Math.max(files.length, 1))));
  const excerpts = files
    .map((f: any) => ({ label: `${f.rel}（${f.projectName}）`, content: readDocExcerpt(f.full, allotment) }))
    .filter((x: any) => x.content);
  // 主题索引：文档名 + 摘录正文（用于判断待办是否与昨天更新的文档相关）
  // 标题用「文件名（上级目录）」而不是整条路径：路径会自我命中（"商丘爱松桐"必然出现在自己的路径里）
  const excerptByLabel = new Map(excerpts.map((x: any) => [x.label, x.content]));
  const dayDocs: TodoContextDoc[] = files.map((f: any) => {
    const segs = String(f.rel || '').split('/');
    const base = (segs.pop() || '').replace(/\.md$/i, '');
    const parent = segs[segs.length - 1] || '';
    const title = parent ? `${base}（${parent}）` : base;
    return { title, text: String(excerptByLabel.get(`${f.rel}（${f.projectName}）`) || '').slice(0, 800) };
  });
  return { lines, pendingTodos, followups, dayFiles, excerpts, dayDocs };
}

/** 单篇文档摘录：剥 frontmatter 后按 allotment 截断；读取失败返回空（该篇不进子助手） */
function readDocExcerpt(full: string, allotment: number): string {
  try {
    return fs.readFileSync(full, 'utf-8')
      .replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
      .trim()
      .slice(0, allotment);
  } catch {
    return '';
  }
}

/**
 * 今日待办（实时）：笔记库待办/跟进 + 应用手动待办，过四道闸（已完结、已过时、归档、重复），
 * 再按「与昨日动态的相关度」排序，只把候选交给 AI，避免整条待办都是陈年旧账。
 */
function collectTodayTodos(digest: any, contextDocs: TodoContextDoc[], activeSince: number): { items: PickedTodo[]; dropped: number } {
  let localTasks: any[] = [];
  try { localTasks = db.todo.list() as any[]; } catch { localTasks = []; }
  // 时效窗口默认 14 天，可在 config.json 里用 briefTodoWindowDays 调整
  let windowDays = 0;
  try { windowDays = Number(appConfig.getConfig('briefTodoWindowDays') || 0); } catch { windowDays = 0; }
  const picked = pickTodayTodos({
    digest: digest || { todos: [], followups: [], logs: [] },
    localTasks,
    contextDocs,
    activeSince,
    windowDays: windowDays > 0 ? windowDays : undefined,
  });
  const s = picked.stats;
  const dropped = s.droppedDone + s.droppedStale + s.droppedArchive + s.droppedDup;
  logger.info(
    '[RadarBrief] 今日待办筛选：扫描 %s 条未完成条目 → 保留 %s 条（剔除 已完结 %s / 过时 %s / 归档 %s / 重复 %s），取前 %s 条给 AI',
    s.total, s.kept, s.droppedDone, s.droppedStale, s.droppedArchive, s.droppedDup, picked.items.length,
  );
  return { items: picked.items, dropped };
}

/** 落盘：默认笔记库「日报/AI活动/YYYY-MM-DD.md」，路径收敛在项目目录内 */
function saveToNote(brief: string, dk: string): { ok: boolean; rel?: string; error?: string } {
  try {
    const proj = db.project.getDefault() || (db.project.list() as any[])[0] || null;
    if (!proj?.dir || !fs.existsSync(proj.dir)) return { ok: false, error: '没有可用的笔记库' };
    const abs = path.resolve(proj.dir, SAVE_DIR, `${dk}.md`);
    if (!abs.startsWith(path.resolve(proj.dir))) return { ok: false, error: '非法路径' };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `# 昨日简报 · ${dk}\n\n> 由 AI 汇总生成于 ${dateKey()} ${timeLabel()}；刷新今天页会重新生成并覆盖本文件。\n\n${brief}\n`, 'utf-8');
    const rel = path.relative(proj.dir, abs).replace(/\\/g, '/');
    return { ok: true, rel };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 飞书推送（10 秒超时保护，进程内每 Natural 日只推一次） */
async function pushFeishu(brief: string, dk: string): Promise<{ ok: boolean; error?: string }> {
  if (pushedDate === dk) return { ok: true, skipped: true } as any;
  const url = String(appConfig.getConfig('feishuWebhookUrl') || '');
  if (!url) return { ok: false, error: 'Webhook URL 未配置' };
  feishu.setWebhook(url); // 重启后 feishu 模块内部 webhook 为空，推送前主动注入
  const plain = brief.replace(/[#*`>\-]{1,3}/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const text = `📋 昨日简报 · ${dk}\n\n${plain.length > 1500 ? plain.slice(0, 1500) + '…' : plain}`;
  try {
    const r = await Promise.race([
      feishu.sendViaWebhook(url, text),
      new Promise((_, rej) => setTimeout(() => rej(new Error('推送超时')), 10_000)),
    ]) as any;
    if (r?.ok) pushedDate = dk;
    return { ok: !!r?.ok, error: r?.error };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * 从落盘文件恢复缓存（App 重启后内存缓存清空，避免重复调 AI）。
 * 文件格式：首行 `# 标题`，引用行 `> ...生成于 <时间>...`，其后为简报正文。
 */
function loadBriefFromFile(dk: string): { brief: string; generatedAt: string } | null {
  try {
    const proj = db.project.getDefault() || (db.project.list() as any[])[0] || null;
    if (!proj?.dir || !fs.existsSync(proj.dir)) return null;
    const abs = path.resolve(proj.dir, SAVE_DIR, `${dk}.md`);
    if (!abs.startsWith(path.resolve(proj.dir)) || !fs.existsSync(abs)) return null;
    const lines = fs.readFileSync(abs, 'utf-8').split('\n');
    let genAt = '';
    let i = 0;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('# ')) continue;
      if (line.startsWith('>')) {
        const m = line.match(/生成于\s*([\d-]+ [\d:]+)/);
        if (m) genAt = m[1];
        continue;
      }
      if (!line.trim()) continue;
      break;
    }
    const brief = lines.slice(i).join('\n').trim();
    if (!brief) return null;
    return { brief, generatedAt: genAt };
  } catch {
    return null;
  }
}

/** 有界并发任务池：结果按提交顺序返回；任务自身负责兜底，不得 reject */
async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

/**
 * 笔记库子助手：把昨天更新的文档内容摘录提炼成清单，供主汇总合并。
 * 摘录由代码确定性读取（完整性由枚举保证，子助手只负责提炼）；失败时原文摘录降级给主汇总，内容不丢。
 */
async function runNoteSubAgent(dk: string, excerpts: Array<{ label: string; content: string }>, runId: number): Promise<string> {
  const source = excerpts.map((x) => `### ${x.label}\n${x.content}`).join('\n\n');
  try {
    const text = await generateWithPi({
      prompt: [
        '你是「昨日简报」笔记库子助手。昨天是 ' + dk + '，以下是笔记库中昨天更新的 ' + excerpts.length + ' 篇文档的内容摘录（超出预算的部分被截断）。',
        '逐篇提炼：更新了什么主题与内容，给出关键结论、决定或新增待办。保留每篇文档名；不同文档不得合并或漏掉；截断处不要推测补全；不要编造。只输出精炼清单。',
        '',
        source,
      ].join('\n'),
      sessionId: `brief_${dk}_${runId}_note`,
      timeoutMs: BRIEF_TIMEOUT_MS,
    });
    return text.trim().slice(0, NOTE_SUMMARY_CHARS);
  } catch (e: any) {
    logger.warn('[RadarBrief] 笔记库子助手提炼失败，原始摘录直接并入主汇总: %s', e?.message || e);
    return '【笔记库子助手提炼失败，以下为原始摘录，主汇总必须覆盖】\n' + source;
  }
}

async function generateBrief(
  dk: string,
  ai: { lines: string[]; count: number; docs: TodoContextDoc[] },
  note: { lines: string[]; pendingTodos: number; followups: number; dayFiles: string[]; excerpts: Array<{ label: string; content: string }>; dayDocs: TodoContextDoc[] },
  todoItems: PickedTodo[],
  todoDropped: number,
): Promise<string> {
  const runId = Date.now();
  const noteList = [...note.lines, ...note.dayFiles.map((file) => `- ${file}`)];
  const noteHeading = '## 昨日笔记库动态（昨天更新文档 ' + note.dayFiles.length + ' 篇；今日待办候选 ' + todoItems.length + ' 项，已剔除过时或已完成 ' + todoDropped + ' 项）';
  const requirements = [
    '## 要求',
    '1. 只依据提供的内容，不要编造；某方面没有信息就不要写；所有会话与文档时间均为昨天（' + dk + '），标题和正文不得出现其他日期。',
    '2. 结构：先一段 2-3 句的总体概述，再用「### 昨日动态」与「### 今日待办」两个小节分点陈述。',
    '3. 「今日待办」只能取自下面的候选清单，最多 5 条，按「现在就需要处理」的程度排序；每条一行，写成 `- 事项 —— 为什么现在做：<一句话，25 字以内>`。',
    '4. 「为什么现在做」只能依据候选清单给出的来源、时效、昨日关联，或事项原文里已有的表述；没有依据就只写事项本身，不要编造理由。候选清单为空时写「（暂无需要立即处理的待办）」。',
    '5. 语言精炼（全文 600 字以内），突出做了什么、有什么值得注意的，不复述原始细节。',
  ].join('\n');
  const todoBlock = [
    '## 今日待办（候选清单，已剔除过时/已完成）',
    renderTodoCandidates(todoItems),
  ].join('\n');

  if (ai.lines.length <= SHARD_THRESHOLD) {
    const noteSummary = note.excerpts.length ? await runNoteSubAgent(dk, note.excerpts, runId) : '';
    const ctx = [
      '## 昨日 AI 工具动态（共 ' + ai.count + ' 个会话）',
      ai.lines.join('\n') || '（无）',
      '',
      noteHeading,
      noteSummary || noteList.join('\n') || '（无）',
      '',
      todoBlock,
    ].join('\n');
    const prompt = [
      '你是「昨日简报」助手。今天是 ' + dateKey() + '，昨天是 ' + dk + '。以下是从本机采集的 AI 工具会话与笔记库提炼的昨日动态，以及今日待办候选清单，请汇总成一份简洁的中文 markdown 简报。',
      '', ctx, '', requirements,
    ].join('\n');
    return generateWithPi({ prompt, sessionId: 'brief_' + dk, timeoutMs: BRIEF_TIMEOUT_MS });
  }

  // 会话分片 + 笔记库子助手同池竞争，并发上限 MAX_PARALLEL
  const shards: string[][] = [];
  for (let i = 0; i < ai.lines.length; i += SHARD_SIZE) shards.push(ai.lines.slice(i, i + SHARD_SIZE));
  const tasks: Array<() => Promise<string>> = shards.map((lines, index) => async () => {
    const source = lines.join('\n');
    try {
      return await generateWithPi({
        prompt: [
          '你是「昨日简报」分片提炼助手。昨天是 ' + dk + '，这是第 ' + (index + 1) + '/' + shards.length + ' 个分片。',
          '逐条提炼每项的核心动作、结果、关键决策和待办，保留工具、项目或文档名称；不同事项不得合并或漏掉，不要编造。只输出本分片的精炼清单。',
          '', source,
        ].join('\n'),
        sessionId: `brief_${dk}_${runId}_shard_${index + 1}`,
        timeoutMs: BRIEF_TIMEOUT_MS,
      });
    } catch (e: any) {
      logger.warn('[RadarBrief] 分片 %s 提炼失败，保留原文参与主汇总: %s', index + 1, e?.message || e);
      return '【本分片提炼失败，以下为原始内容，主汇总必须覆盖】\n' + source;
    }
  });
  if (note.excerpts.length) tasks.push(() => runNoteSubAgent(dk, note.excerpts, runId));

  const results = await runPool(tasks, MAX_PARALLEL);
  const shardResults = results.slice(0, shards.length);
  const noteSummary = note.excerpts.length ? results[shards.length] : '';
  const degraded = shardResults.filter((r) => r.startsWith('【本分片提炼失败')).length;

  const prompt = [
    '你是「昨日简报」主汇总助手。今天是 ' + dateKey() + '，昨天是 ' + dk + '。下面是覆盖昨日全部 ' + ai.count + ' 个会话的 ' + shards.length + ' 份分片结果，以及笔记库子助手对昨天更新文档的提炼。',
    '综合全部分片：重复事项去重，不同项目、工具或文档的独立事项不得错误合并；失败分片附带的原文也必须纳入。不要只关注前几个分片。',
    '输出中不要提及分片、并行、数据来源或统计口径等过程性说明。',
    '',
    '## 分片结果',
    ...shardResults.map((text, index) => `### 分片 ${index + 1}/${shards.length}\n${text}`),
    '',
    noteHeading,
    noteSummary || noteList.join('\n') || '（无）',
    '',
    todoBlock,
    '', requirements,
  ].join('\n');
  logger.info('[RadarBrief] 自适应分片: %s 个会话 → %s 片 + 笔记库子助手 %s 篇摘录，最多 %s 路并行，失败降级 %s 片', ai.lines.length, shards.length, note.excerpts.length, MAX_PARALLEL, degraded);
  return generateWithPi({ prompt, sessionId: `brief_${dk}_${runId}`, timeoutMs: BRIEF_TIMEOUT_MS });
}

/**
 * 昨日简报主入口。force=true 手动刷新（重新生成并覆盖落盘，不重推）。
 * 回顾昨日 AI/笔记动态，附今日待办（实时）。
 * 缓存两级：内存 → 落盘文件恢复（重启后）→ 生成。同一天生成中并发请求复用同一任务。
 * 返回 { ok, brief?, generatedAt?, fromCache?, empty?, error? }；brief 为空且 empty=true 表示昨日无活动。
 */
export async function getBrief(force = false): Promise<any> {
  const range = yesterdayRange();
  const dk = range.key; // 缓存/落盘/推送都按「昨日」日期键
  if (!force && cacheDate === dk && cacheBrief) {
    return { ok: true, brief: cacheBrief, generatedAt: cacheGeneratedAt, fromCache: true };
  }
  if (!force && inflightDate === dk && inflight) {
    return inflight;
  }
  if (!force) {
    const fromFile = loadBriefFromFile(dk);
    if (fromFile) {
      cacheDate = dk;
      cacheBrief = fromFile.brief;
      cacheGeneratedAt = fromFile.generatedAt;
      logger.info('[RadarBrief] 从落盘文件恢复缓存: %s', dk);
      return { ok: true, brief: fromFile.brief, generatedAt: fromFile.generatedAt, fromCache: true };
    }
  }
  const job = (async () => {
    try {
      const ai = collectAiSide(range);
      // digest 只采集一次：待办筛选与笔记动态共用同一份口径
      let digest: any = null;
      try { digest = extractDigest(); } catch { digest = null; }
      const note = collectNoteSide(range, digest);
      const todos = collectTodayTodos(digest, [...ai.docs, ...note.dayDocs], range.start);
      if (!ai.count && !note.dayFiles.length) {
        return { ok: true, empty: true, brief: '' };
      }

      const brief = await generateBrief(dk, ai, note, todos.items, todos.dropped);
      const generatedAt = dateKey() + ' ' + timeLabel();
      cacheDate = dk;
      cacheBrief = brief;
      cacheGeneratedAt = generatedAt;

      const saved = saveToNote(brief, dk);
      const pushed = await pushFeishu(brief, dk);
      if (saved.ok) logger.info('[RadarBrief] 落盘成功: %s（推送: %s）', saved.rel, pushed.ok ? '是' : '否(' + (pushed.error || '') + ')');
      else logger.warn('[RadarBrief] 落盘失败: ' + saved.error);
      return { ok: true, brief, generatedAt, fromCache: false, savedRel: saved.rel || '', savedError: saved.error || '', pushed: !!pushed.ok };
    } catch (e: any) {
      logger.warn('[RadarBrief] 生成失败: ' + (e?.message || e));
      return { ok: false, error: e?.message || String(e) };
    }
  })();
  inflight = job;
  inflightDate = dk;
  // 手动刷新会顶掉 inflight，旧任务结束时不得清掉新任务的登记
  void job.then(() => {
    if (inflight === job) { inflight = null; inflightDate = ''; }
  });
  return job;
}
