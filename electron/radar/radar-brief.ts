/**
 * 昨日简报：雷达 AI 简报（替代今天页原规则「引擎简报」）。
 * 内容三块：昨日 AI 工具动态（昨日采集会话聚合）+ 昨日笔记库动态（昨天更新的文档）+ 今日待办（实时）。
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
import logger from '../services/logger';

const SHARD_THRESHOLD = 20;    // 会话与文档合计超过该数量后分片
const SHARD_SIZE = 10;
const MAX_PARALLEL = 3;
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
function collectAiSide(range: { start: number; end: number }): { lines: string[]; count: number; included: number } {
  const result = agentRadar.sessionsByRange(range.start, range.end, MAX_SESSIONS);
  const sessions = result.rows;
  const lines: string[] = [];
  for (const s of sessions) {
    let firstAsk = '';
    try {
      const msgs = agentRadar.sessionMessages(String(s.tool), String(s.sessionId)) || [];
      const u = msgs.find((m: any) => String(m.role) === 'user' && String(m.content || '').trim());
      if (u) firstAsk = String(u.content).replace(/\s+/g, ' ').trim().slice(0, PER_MSG_CHARS);
    } catch { /* 单会话取消息失败不影响整体 */ }
    const seg = [`- [${s.tool}] ${s.title || '（无标题）'}（${fmtTs(s.sourceUpdatedAt)}）`];
    if (s.summary) seg.push(`  摘要：${String(s.summary).replace(/\s+/g, ' ').trim().slice(0, 300)}`);
    if (firstAsk) seg.push(`  首条请求：${firstAsk}`);
    lines.push(seg.join('\n'));
  }
  return { lines, count: result.total, included: sessions.length };
}

/** 昨日笔记库动态：当天更新的文档；待办/跟进为实时状态（归「今日待办」节） */
function collectNoteSide(range: { start: number; end: number }): { lines: string[]; pendingTodos: number; followups: number; dayFiles: string[] } {
  const lines: string[] = [];
  let pendingTodos = 0;
  let followups = 0;
  try {
    const d: any = extractDigest();
    pendingTodos = (d?.todos || []).filter((t: any) => !t.done).length;
    followups = (d?.followups || []).filter((f: any) => !f.done).length;
    if (followups) lines.push(`- 跟进事项 ${followups} 条`);
  } catch { /* 笔记库未配置时跳过 */ }
  const dayFiles = (projectScan.collectRecentFiles(null, range) || [])
    .map((f: any) => `${f.rel}（${f.projectName}，${fmtTs(f.mtime)}）`);
  if (dayFiles.length) lines.push(`- 昨天更新的文档 ${dayFiles.length} 篇：` + dayFiles.slice(0, 8).join('；'));
  return { lines, pendingTodos, followups, dayFiles };
}

/** 今日待办（实时状态）：本地待办 + 笔记库提炼待办 */
function collectTodayTodos(): string[] {
  const lines: string[] = [];
  try {
    const local = (db.task.listTodos() as any[]).filter((t: any) => t.status !== 'done').slice(0, 8);
    for (const t of local) lines.push('- [本地] ' + String(t.content || t.title || '').replace(/\s+/g, ' ').trim().slice(0, 50));
  } catch { /* 忽略 */ }
  try {
    const d: any = extractDigest();
    const pending = (d?.todos || []).filter((t: any) => !t.done).slice(0, 8);
    for (const t of pending) lines.push('- [笔记] ' + String(t.text || '').replace(/\s+/g, ' ').trim().slice(0, 50) + (t.file ? `（${String(t.file).replace(/\\/g, '/')}）` : ''));
  } catch { /* 忽略 */ }
  return lines;
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
      const note = collectNoteSide(range);
      const todos = collectTodayTodos();
      if (!ai.count && !note.dayFiles.length) {
        return { ok: true, empty: true, brief: '' };
      }

      const ctx = [
        '## 昨日 AI 工具动态（共 ' + ai.count + ' 个会话' + (ai.included < ai.count ? '，以下最近 ' + ai.included + ' 个' : '') + '）',
        ai.lines.join('\n') || '（无）',
        '',
        '## 昨日笔记库动态（当前未勾待办 ' + note.pendingTodos + ' 项，跟进 ' + note.followups + ' 条）',
        note.lines.join('\n') || '（无）',
        '',
        '## 今日待办（实时）',
        todos.join('\n') || '（无）',
      ].join('\n');

      const prompt = [
        '你是「昨日简报」助手。今天是 ' + dateKey() + '，昨天是 ' + dk + '。以下是从本机采集的 AI 工具会话与笔记库提炼的昨日动态，以及今日待办清单，请汇总成一份简洁的中文 markdown 简报。',
        '',
        ctx,
        '',
        '## 要求',
        '1. 只依据提供的内容，不要编造；某方面没有信息就不要写；所有会话与文档时间均为昨天（' + dk + '），标题和正文不得出现其他日期。',
        '2. 结构：先一段 2-3 句的总体概述，再用「### 昨日动态」与「### 今日待办」两个小节分点陈述；待办清单原样列出（可精简文字），不要总结成一句话。',
        '3. 语言精炼（全文 400 字以内），突出做了什么、有什么值得注意的，不复述原始细节。',
      ].join('\n');

      const brief = await generateWithPi({ prompt, sessionId: 'brief_' + dk, timeoutMs: BRIEF_TIMEOUT_MS });
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
