/**
 * 摘要落盘（提炼层②的导出副本）：高价值会话摘要生成后写入默认笔记库
 * 「AI活动/会话/YYYY-MM-DD-<工具>-<标题>-<会话短id>.md」。
 * radar.db 里的 summary 仍是事实源（雷达页/问雷达/日报/简报都读它），落盘只是导出副本——
 * 让摘要回到「数据主体」：AI 对话 read/grep 直读、笔记全文搜索命中、今天页提炼看板可见；
 * 文件丢了不要紧，补摘要跑一轮即可重新生成。
 * 幂等：按会话短 id 在目录里找已有文件，找到就覆盖（标题/日期漂移也不产生第二份），
 * 找不到才按当前信息新建。失败只记日志，绝不影响摘要主链路。
 * 文件名不与 note-digest 的日志锚点（严格 YYYY-MM-DD.md）相撞，不会刷今天页工作日志板块。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as db from '../services/database';
import logger from '../services/logger';

const SAVE_DIR = 'AI活动/会话';
const TITLE_CHARS = 40;   // 文件名里标题段的上限
const skipLogged = new Set<string>();   // 同一跳过原因只提示一次，避免补摘要刷屏

/** 本地日期键 YYYY-MM-DD（本机时区，不用 toISOString） */
function dateKey(ts: number): string {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtTs(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return dateKey(ts) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 文件名清洗：非法字符替换、压空白、去首尾标点、限长 */
export function sanitizeName(s: string): string {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\- ]+|[.\- ]+$/g, '')
    .slice(0, TITLE_CHARS)
    .replace(/[.\- ]+$/g, '');
}

/** 会话短 id：取字母数字前 8 位，作文件锚（重摘要覆盖同一文件的依据） */
export function sessionTag(sessionId: string): string {
  return String(sessionId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
}

/** 按会话短 id 找目录里已有的落盘文件（存在即覆盖，保证幂等）；目录不存在返回 null */
function findExisting(dir: string, tag: string): string | null {
  if (!tag) return null;
  try {
    const hit = fs.readdirSync(dir).find((f) => f.endsWith(`-${tag}.md`));
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

export interface SummaryNoteInfo {
  tool: string;
  sessionId: string;
  title: string;
  projectDir: string;
  sourceUpdatedAt: number;
}

/**
 * 把一条会话摘要写入默认笔记库。返回 { ok, rel?, skipped?, error? }：
 * ok=true 落盘成功（rel 为笔记库内相对路径）；skipped 为环境性跳过原因（无笔记库等）；
 * error 为写文件失败。调用方（radar-digest）只记日志，不重试——下次收口或补摘要自然重来。
 */
export function saveSummaryNote(info: SummaryNoteInfo, summary: string): { ok: boolean; rel?: string; skipped?: string; error?: string } {
  const s = String(summary || '').trim();
  if (!s) return { ok: false, skipped: '空摘要' };
  let proj: any = null;
  try {
    proj = db.project.getDefault() || (db.project.list() as any[])[0] || null;
  } catch { /* 数据库不可用时按无笔记库跳过 */ }
  if (!proj?.dir || !fs.existsSync(proj.dir)) return { ok: false, skipped: '没有可用的笔记库' };

  const root = path.resolve(proj.dir);
  const dir = path.resolve(root, SAVE_DIR);
  if (!dir.startsWith(root)) return { ok: false, error: '非法路径' };

  const tag = sessionTag(info.sessionId);
  const existing = findExisting(dir, tag);
  const file = existing || path.join(dir, [
    dateKey(info.sourceUpdatedAt),
    sanitizeName(info.tool),
    sanitizeName(info.title) || '会话',
    tag || 'nosid',
  ].filter(Boolean).join('-') + '.md');

  const body = [
    `# ${String(info.title || '（无标题）').trim()}`,
    '',
    `> 智能体雷达自动归档 · 工具：${info.tool} · 项目：${info.projectDir || '未知'}`,
    `> 会话更新：${fmtTs(info.sourceUpdatedAt)} · 摘要提炼：${fmtTs(Date.now())}（会话有新内容时自动重新提炼并覆盖本文件）`,
    '',
    s,
    '',
  ].join('\n');

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, body, 'utf-8');
    const rel = path.relative(root, file).replace(/\\/g, '/');
    return { ok: true, rel };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** digest 收尾的落盘接线：只做日志汇报，结果不影响摘要主链路 */
export function reportSummaryNote(info: SummaryNoteInfo, summary: string): void {
  const r = saveSummaryNote(info, summary);
  if (r.ok) {
    logger.info('[RadarDigest] 摘要已落盘笔记库: %s', r.rel);
  } else if (r.error) {
    logger.warn('[RadarDigest] 摘要落盘失败: %s', r.error);
  } else if (r.skipped && !skipLogged.has(r.skipped)) {
    skipLogged.add(r.skipped);
    logger.info('[RadarDigest] 摘要落盘跳过（%s），本原因不再重复提示', r.skipped);
  }
}
