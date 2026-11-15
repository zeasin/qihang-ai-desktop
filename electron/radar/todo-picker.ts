/**
 * 今日待办挑选：把笔记库/应用里的未完成条目过一遍，选出「今天还值得关注」的候选，
 * 供昨日简报的「今日待办」小节使用。
 *
 * 为什么不能直接用 digest.todos：
 *   digest.todos 是「全库所有未勾复选框」，里面混着几个月前写下、后来没人再碰的条目，
 *   直接截前 N 条会得到一串过时内容（用户实际反馈过：待办里全是要紧的旧账）。
 *   这里加五道闸：
 *   1) 完结闸：正文自己写了「已处理/已上线/可勾销」的条目直接剔除——它已经在事实上做完了，
 *      只是没人回去勾框；
 *   2) 时效闸：条目按「内容日期」算龄期（日期命名的日志用文件名里的日期，其余用文件 mtime），
 *      超过窗口（默认 14 天）视为过时；
 *   3) 结构闸：标题里写死了月份的小节（如「ERP开发（10月，…）」）整块按那个月算龄期，
 *      归档目录与历史快照不进候选；
 *   4) 旧账闸：更近的记录里已经把同一件事勾掉了（老文件没回勾），也算过时；
 *   5) 相关闸：条目与「昨日动态」的主题重合度越高越靠前——正在推进的事优先。
 *
 * 纯函数，不碰 IO，便于单测与回归。
 */
import type { DigestResult } from '../services/note-digest';

export interface TodoContextDoc {
  title: string;   // 主题名（会话标题 / 文档名）
  text: string;    // 主题正文（摘要 / 首条请求），参与主题匹配
}

export interface PickedTodo {
  text: string;        // 待办原文（截断）
  origin: string;      // 来源标签：跟进 / 待办 / TODO / 日报 / 笔记 / 应用
  file: string;        // 来源文件（相对路径，应用任务为「应用任务」）
  days: number;        // 距今天数
  score: number;
  topics: string[];    // 与之相关的昨日主题名
  evidence: string[];  // 给 AI 的判断依据
}

export interface TodoPickResult {
  items: PickedTodo[];
  stats: {
    total: number;         // 扫描到的未完成条目总数
    droppedDone: number;   // 被完结闸剔除
    droppedStale: number;  // 被时效/结构闸剔除
    droppedArchive: number;// 归档目录剔除
    droppedDup: number;    // 重复剔除
    kept: number;          // 通过全部闸门的条目数
  };
  rejected: Array<{ text: string; file: string; reason: string }>;  // 剔除明细（诊断用）
}

export interface TodoPickOptions {
  digest: DigestResult;
  localTasks: any[];
  contextDocs: TodoContextDoc[];
  now?: number;
  windowDays?: number;
  maxItems?: number;
  activeSince?: number;   // 「活跃」起点：文件在这个时间点之后被改过，说明正在推进
}

export const TODO_WINDOW_DAYS = 14;
const MAX_ITEMS = 8;

// 完结标记：正文自己承认已经做完（勾没勾都算），出现在待办里就是噪音
const DONE_MARK_RE = /(✅|✔️|☑)|已(?:经|全部)?(?:完成|处理|上线|交付|结清|勾销|解决|修复|申报|关闭|归档|实现|做完|办妥|办完|建好|搭好|落地|发布)|(?:可|可以|待)勾销|搞定|办妥/;
// 归档/存档目录：历史沉淀，不该出现在今日待办
const ARCHIVE_RE = /归档|存档|archive/i;
// 日期命名的文件：内容日期取文件名里的日期，而不是文件 mtime（老日志会被后来批量改动）
const DATE_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/;
// 标题里写死的月份：整块内容按那个月算龄期
const MONTH_RE = /(20\d{2})?\s*[-/年]?\s*(\d{1,2})\s*月/;
// 紧迫度信号
const URGENT_RE = /(待提单|待提交|待确认|待回访|待上线|待部署|待联调|待回签|待回款|待跟进|待处理|阻塞|卡住|紧急|必须|催|截止|今天|明天|本周|尽快|优先)/;
// 过于通用的词，参与主题匹配时没有区分度
const STOP_TERMS = new Set([
  '项目', '需求', '功能', '系统', '开发', '上线', '处理', '相关', '问题', '方案', '完成', '支持',
  '实现', '优化', '测试', '部署', '修复', '改造', '合并', '页面', '数据', '接口', '代码', '文档',
  '任务', '内容', '文件', '方式', '情况', '部分', '整体', '当前', '之后', '之前', '以及', '进行',
  '可以', '需要', '已经', '还是', '这个', '那个', '我们', '他们', '客户', '订单', '商品', '售后',
]);

/** 主题词：拉丁标识符 + 中文 2~4 字 n-gram */
function extractTerms(text: string): string[] {
  const out: string[] = [];
  const lower = String(text || '').toLowerCase();
  for (const w of lower.match(/[a-z][a-z0-9_.\-]{2,}/g) || []) out.push(w);
  for (const run of String(text || '').match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= run.length; i++) out.push(run.slice(i, i + n));
    }
  }
  return out;
}

/** 主题索引：哪些词有区分度（文档频次低），以及每个主题各自覆盖哪些词 */
interface TopicIndex { docs: Array<{ title: string; text: string; terms: Set<string> }>; df: Map<string, number>; n: number; }

/** 词的权重：中文 2 字词太泛（"平台""同步"到处都是），不参与主题命中 */
function termWeight(term: string): number {
  if (/^[a-z0-9]/.test(term)) return term.length >= 4 ? 1.3 : 0.8;
  if (term.length < 3) return 0;
  return term.length >= 4 ? 1.3 : 1.0;
}

function buildTopicIndex(docs: TodoContextDoc[]): TopicIndex {
  const docTerms = docs.map((d) => {
    const s = new Set<string>();
    for (const t of extractTerms(d.title + ' ' + (d.text || ''))) {
      if (STOP_TERMS.has(t)) continue;
      s.add(t);
    }
    return { title: d.title, text: d.text || '', terms: s };
  });
  const df = new Map<string, number>();
  for (const d of docTerms) {
    for (const t of d.terms) df.set(t, (df.get(t) || 0) + 1);
  }
  // 出现在半数以上主题里的词是通用词，不参与匹配
  const maxDf = Math.max(1, Math.ceil(docTerms.length * 0.34));
  const out = docTerms.map((d) => {
    const terms = new Set<string>();
    for (const t of d.terms) {
      if ((df.get(t) || 0) > maxDf) continue;
      terms.add(t);
    }
    return { title: d.title, text: d.text, terms };
  });
  return { docs: out, df, n: docTerms.length };
}

/** 词的区分度权重（idf）：越少见越具体 */
function idf(index: TopicIndex, term: string): number {
  return Math.log(1 + index.n / Math.max(1, index.df.get(term) || 1));
}

/** 标签取命中词附近的一小段（会话标题常常是整句提问，直接当标签没法看） */
function labelAround(doc: { title: string; text?: string }, term: string): string {
  const title = String(doc.title || '');
  const text = String(doc.text || '');
  const inTitle = title.indexOf(term);
  const inText = inTitle < 0 ? text.indexOf(term) : -1;
  const src = inTitle >= 0 ? title : text;
  const idx = inTitle >= 0 ? inTitle : inText;
  if (idx < 0) return title.replace(/\s+/g, ' ').trim().slice(0, 30);
  const start = Math.max(0, idx - 10);
  const end = Math.min(src.length, idx + term.length + 14);
  let label = src.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) label = '…' + label;
  if (end < src.length) label = label + '…';
  return label.length > 40 ? label.slice(0, 40) + '…' : label;
}

/** 候选文本命中的主题（按加权分值排序，取最相关的两三个） */
function matchTopics(text: string, index: TopicIndex): { topics: string[]; score: number } {
  const hits: Array<{ label: string; score: number }> = [];
  for (const d of index.docs) {
    // 长的词优先：命中「打印模板」就不再重复计「模板」
    const matched = [...d.terms]
      .filter((t) => text.includes(t))
      .sort((a, b) => b.length - a.length);
    const kept: string[] = [];
    for (const t of matched) {
      if (kept.some((k) => k.includes(t))) continue;
      kept.push(t);
    }
    let score = 0;
    let best = '';
    for (const t of kept) {
      const w = idf(index, t) * termWeight(t);
      score += w;
      if (!best || t.length > best.length) best = t;
    }
    // 门槛：噪声匹配（"平台""同步"这类）不足以算相关
    if (score >= 1.8 && best) hits.push({ label: labelAround(d, best), score });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, 3);
  return { topics: top.map((h) => h.label), score: Math.min(30, top.reduce((s, h) => s + h.score, 0)) };
}

/** 条目的内容日期：日期命名文件用文件名日期，其余用文件 mtime */
function contentDate(file: string, mtime: number): number {
  const base = String(file || '').split('/').pop() || '';
  const m = base.match(DATE_FILE_RE);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return mtime || 0;
}

/**
 * 「这份记录比 X 新吗」的比较基准：日期命名的日报记录的是当天结束时的状态，
 * 所以比较新旧时取当天末尾；否则 11-05 的日报会显得比 11-05 下午写的项目日志还旧。
 */
function supersedeDate(file: string, mtime: number): number {
  const base = String(file || '').split('/').pop() || '';
  const m = base.match(DATE_FILE_RE);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return mtime || 0;
}

/** 标题里写死的月份 → 该月末时间戳（没有则 null） */
function sectionMonthEnd(section: string, now: number): number | null {
  const m = String(section || '').match(MONTH_RE);
  if (!m) return null;
  const year = m[1] ? Number(m[1]) : new Date(now).getFullYear();
  const month = Number(m[2]);
  if (!(month >= 1 && month <= 12)) return null;
  return new Date(year, month, 0, 23, 59, 59, 999).getTime(); // month=0 → 该月最后一天
}

/** 来源文件 → 来源标签与权重（活清单优先于历史快照） */
function originOf(file: string): { origin: string; weight: number } {
  const base = String(file || '').split('/').pop() || '';
  if (/^(跟进|跟进事项)\.md$/i.test(base)) return { origin: '跟进', weight: 20 };
  if (/^待办\.md$/i.test(base)) return { origin: '待办', weight: 20 };
  if (/^TODO\.md$/i.test(base)) return { origin: 'TODO', weight: 10 };
  if (/^日报/.test(base) || /\/日报\//.test(file)) return { origin: '日报', weight: 2 };
  return { origin: '笔记', weight: 8 };
}

// 目录段里这些词不构成项目线索（"项目""客户""经营"之类的通用层级）
const GENERIC_SEGMENTS = new Set([
  '日报', '工作', '产品', '客户', '项目', '专题', '经营', '记录', '知识', '存档', '资料', '文档',
  '脚本', '开发资料', '售前', '营销', '笔记', '日志', '归档', '文章', '已发', '跟进专题', '根目录',
]);

/**
 * 项目线索：待办所在文件的上级目录里，哪个名字在「昨日动态」里出现过。
 * 「10-经营/项目/商丘爱松桐/项目日志.md」→ 昨日笔记提到过「爱松桐」→ 这条待办属于当下在推进的客户，
 * 比任何文本相似度都可靠，也最容易向用户解释「为什么现在要做」。
 */
function projectClue(file: string, contextText: string): string | null {
  const segs = String(file || '').split('/').filter(Boolean).slice(0, -1);
  for (const seg of segs) {
    if (GENERIC_SEGMENTS.has(seg)) continue;
    if (/^\d/.test(seg)) continue;                    // 编号目录（10-经营 / 90-归档）
    for (let len = seg.length; len >= 3; len--) {
      for (let i = 0; i + len <= seg.length; i++) {
        const sub = seg.slice(i, i + len);
        if (contextText.includes(sub)) return sub;
      }
    }
  }
  return null;
}

/** 归一化去重键：去掉空白与标点，只留文字 */
function dedupeKey(text: string): string {
  return String(text || '').toLowerCase().replace(/[\s，。、；：,.;:!?！？"'“”‘’()（）\-—_/\\|]+/g, '');
}

/** 最长公共子串长度（用于判断两条待办是不是同一件事） */
function lcsLen(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    }
    prev.splice(0, prev.length, ...cur);
  }
  return best;
}

/**
 * 旧账判定：更近的记录里已经出现「同一件事已完成」，说明老文件里的这条只是没回勾。
 * 例：项目日志里 `推进系统部署收尾` 还没勾，但 11-06 日报里已写 `跟进爱松桐系统部署收尾 [x]`。
 */
function shadowedByDone(text: string, date: number, doneItems: Array<{ text: string; date: number }>): boolean {
  const a = dedupeKey(text);
  if (a.length < 4) return false;
  for (const d of doneItems) {
    if (d.date <= date) continue;                 // 只有更近的记录才算数
    const b = dedupeKey(d.text);
    if (!b) continue;
    if (b.includes(a) || a.includes(b)) return true;
    // 六字以上重合，且两边只差少量修饰（「推进系统部署收尾」vs「推进爱松桐系统部署收尾」），
    // 才算同一件事；只是共用一个产品前缀（"启航电商ERP"）不算
    const l = lcsLen(a, b);
    if (l >= 6 && (a.length + b.length - 2 * l) <= 8) return true;
  }
  return false;
}

/**
 * 挑选今日待办候选。
 * 返回按相关度排序的候选项（最多 maxItems 条），以及各道闸的剔除统计。
 */
export function pickTodayTodos(opts: TodoPickOptions): TodoPickResult {
  const now = opts.now ?? Date.now();
  const windowDays = opts.windowDays ?? TODO_WINDOW_DAYS;
  const maxItems = opts.maxItems ?? MAX_ITEMS;
  const activeSince = opts.activeSince ?? now - 2 * 86_400_000;
  const index = buildTopicIndex(opts.contextDocs || []);
  const windowMs = windowDays * 86_400_000;
  // 昨日动态全文：用于判断待办所在项目昨天是否被推进过
  const contextText = (opts.contextDocs || []).map((d) => d.title + ' ' + (d.text || '')).join('\n');

  const stats = { total: 0, droppedDone: 0, droppedStale: 0, droppedArchive: 0, droppedDup: 0, kept: 0 };
  const rejected: Array<{ text: string; file: string; reason: string }> = [];
  const seen = new Set<string>();
  const pool: PickedTodo[] = [];
  // 已完成项（用于判定「更近的记录里已经做完」的旧账）；优先用未去重的全量已勾项
  const doneSource: any[] = (opts.digest as any)?.doneItems?.length
    ? (opts.digest as any).doneItems
    : (opts.digest?.todos || []).filter((t: any) => t.done);
  const doneItems = doneSource.map((t: any) => ({ text: t.text, date: supersedeDate(t.file, t.mtime) }));

  const push = (text: string, origin: string, file: string, date: number, mtime: number, weight: number, section: string) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    stats.total++;
    // 闸 1：正文自称已完成
    if (DONE_MARK_RE.test(clean)) { stats.droppedDone++; rejected.push({ text: clean, file, reason: '正文已标记完成' }); return; }
    // 闸 2：归档目录
    if (ARCHIVE_RE.test(file)) { stats.droppedArchive++; rejected.push({ text: clean, file, reason: '归档目录' }); return; }
    // 闸 3：时效（日期命名文件用内容日期；标题写死月份的小节按那个月算）
    let ageDate = date;
    const monthEnd = sectionMonthEnd(section, now);
    if (monthEnd !== null && monthEnd < ageDate) ageDate = monthEnd;
    if (now - ageDate > windowMs) {
      stats.droppedStale++;
      rejected.push({ text: clean, file, reason: `超过 ${windowDays} 天未更新（${Math.floor((now - ageDate) / 86_400_000)} 天）` });
      return;
    }
    const ageDays = Math.max(0, Math.floor((now - ageDate) / 86_400_000));
    // 闸 4：更近的记录里已经做过同一件事（旧账没回勾）
    if (shadowedByDone(clean, supersedeDate(file, mtime), doneItems)) {
      stats.droppedStale++;
      rejected.push({ text: clean, file, reason: '更近的记录里已标记完成' });
      return;
    }
    // 去重（同一件事在多份笔记里出现，只留最新那份）
    const key = dedupeKey(clean);
    if (seen.has(key)) { stats.droppedDup++; rejected.push({ text: clean, file, reason: '重复条目' }); return; }
    seen.add(key);

    const topics = matchTopics(clean, index);
    // 文件最近被改过 = 正在推进的活儿，比任何文本相似度都可靠
    const fileActive = mtime >= activeSince;
    // 待办所在项目昨天有更新 = 该客户/项目当下正被推进
    const clue = projectClue(file, contextText);
    let score = weight + Math.max(0, 12 - ageDays) + topics.score;
    if (fileActive) score += 18;
    if (clue) score += 22;
    if (URGENT_RE.test(clean)) score += 8;

    const evidence: string[] = [];
    const ageText = ageLabel(mtime, now);
    evidence.push(`来源：${file}（${origin}，${ageText}）`);
    if (clue) evidence.push(`所属项目昨日有更新：${clue}`);
    if (topics.topics.length) evidence.push('昨日涉及：' + topics.topics.join('、'));
    pool.push({ text: clean.slice(0, 80), origin, file, days: ageDays, score, topics: topics.topics, evidence });
  };

  // 笔记库待办（未勾选）
  for (const t of opts.digest?.todos || []) {
    if (t.done) continue;
    const { origin, weight } = originOf(t.file);
    push(t.text, origin, t.file, contentDate(t.file, t.mtime), t.mtime, weight, t.section || '');
  }
  // 笔记库跟进项（跟进.md 是用户专门维护的「今天页」清单，之前从未进过待办）
  for (const f of opts.digest?.followups || []) {
    const { origin, weight } = originOf(f.file);
    push(f.text, origin, f.file, contentDate(f.file, f.mtime), f.mtime, weight, f.section || '');
  }
  // 应用内手动待办
  for (const t of opts.localTasks || []) {
    if (t.status === 'done') continue;
    const created = parseTs(t.created_at);
    push(String(t.title || t.content || ''), '应用', '应用任务', created, created, 22, '');
  }

  stats.kept = pool.length;
  pool.sort((a, b) => b.score - a.score || a.days - b.days);
  return { items: pool.slice(0, maxItems), stats, rejected };
}

/** 文件最近修改的相对说法 */
function ageLabel(mtime: number, now: number): string {
  const diff = now - mtime;
  if (diff < 20 * 3_600_000) return '今天有更新';
  if (diff < 48 * 3_600_000) return '昨天有更新';
  return Math.floor(diff / 86_400_000) + ' 天前更新';
}

/** 解析 'YYYY-MM-DD HH:mm:ss'（本地时区） */
function parseTs(v: any): number {
  if (!v) return Date.now();
  const s = String(v).trim().replace(' ', 'T');
  const d = new Date(s);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

/** 把候选渲染成给 AI 的清单（含依据），空时返回提示语 */
export function renderTodoCandidates(items: PickedTodo[]): string {
  if (!items.length) return '（无候选：库里的未完成条目都已过时或已标记完成）';
  return items.map((it) => {
    const ev = it.evidence.join('；');
    return `- [${it.origin}] ${it.text}（${ev}）`;
  }).join('\n');
}
