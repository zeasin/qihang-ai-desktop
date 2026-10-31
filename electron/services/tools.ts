import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as db from './database';
import { normalizeDatasetRecord } from './dataset-normalize';
import logger from './logger';

// typebox 是 ESM-only 包，而本文件编译为 CJS，用 Function 构造器保留运行时真正的动态 import()
let cachedType: any = null;
async function ensureT() {
  if (!cachedType) cachedType = await new Function('spec', 'return import(spec)')('typebox');
  return cachedType;
}

// LLM 可能传数字或字符串，统一转换为数字
const toNumber = (v: any, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache', 'dist', 'build', 'target', '.idea', '.vscode', 'release', 'out', 'tmp', 'temp']);

function projectRoot(projectDir) {
  return projectDir || process.cwd();
}

function safePath(fullPath, projectDir) {
  const root = projectRoot(projectDir);
  const rootNorm = path.resolve(root);
  const fullNorm = path.resolve(fullPath);
  if (!fullNorm.startsWith(rootNorm) && !fullNorm.startsWith(os.homedir())) return null;
  return fullNorm;
}

// ========== 外网工具 (多引擎聚合 + API 通道，见 ./search) ==========

import { webSearch as _webSearch, fetchPage as _fetchPage, getSearchConfig } from './search';

async function webSearchTool({ query, maxResults }) {
  try {
    return await _webSearch(String(query || ''), maxResults, getSearchConfig());
  } catch (e) {
    return '搜索失败: ' + (e && e.message ? e.message : e);
  }
}

async function webFetchTool({ url, maxLength }) {
  return await _fetchPage(String(url || ''), maxLength);
}
// ========== 路径安全 ==========
// 笔记 CRUD 工具（list_notes/read_note/write_note/edit_note/delete_note）已按新设计移除：
// 项目库的检索与读写交给 pi agent 用自己的 read/bash/write 直接完成，工作台不再提供笔记层工具。
// 这里只保留路径越权校验，供待办自动落盘等内部逻辑使用。

function safeNotePath(noteDir, p) {
  const full = path.isAbsolute(p) ? p : path.join(noteDir, p);
  const norm = path.resolve(full);
  return norm.startsWith(path.resolve(noteDir)) ? norm : null;
}

// 在 rootDir 中按文件名相似度搜索，返回相对路径候选（用于读取失败时的纠错引导）
function findSimilarFiles(rootDir, relTarget, max = 5) {
  const target = String(relTarget || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  const targetBase = path.basename(target, path.extname(target)).toLowerCase();
  const targetTokens = targetBase.replace(/[^\w\u4e00-\u9fa5]+/g, ' ').split(' ').filter(t => t.length >= 2);
  if (!targetTokens.length) return [];
  const hits: any[] = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(full);
      } else {
        const rel = path.relative(rootDir, full).replace(/\\/g, '/');
        const relLower = rel.toLowerCase();
        let score = 0;
        for (const t of targetTokens) if (relLower.includes(t)) score += t.length;
        if (score > 0) hits.push({ rel, score });
      }
    }
  };
  walk(rootDir);
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, max).map(h => h.rel);
}

function notFoundHint(rootDir, relPath) {
  const similar = findSimilarFiles(rootDir, relPath);
  const hint = similar.length
    ? ` 目录中相似的文件:\n${similar.map(s => '  - ' + s).join('\n')}\n`
    : '';
  return `文件不存在: ${relPath}。\n${hint}请先用 bash（ls/find）查看目录结构，确认准确的文件路径后重试。`;
}

// ========== 待办落笔记（方案：新建待办自动追加到项目根 待办.md，笔记保持事实超集） ==========

const TODO_NOTE_NAME = '待办.md';
const TODO_NOTE_HEADER = '# 待办\n\n> 本文件由应用自动同步：新建待办会追加一行 `- [ ] 标题`；勾掉即完成。\n';

function appendTodoNote(projectId: any, title: string): { ok: boolean; rel?: string; error?: string } {
  try {
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    if (!t) return { ok: false, error: '标题为空' };
    const n = Number(projectId);
    const pid = Number.isFinite(n) ? Math.trunc(n) : 0;
    let proj: any = pid ? db.project.get(pid) : null;
    if (!proj || !proj.dir || !fs.existsSync(proj.dir)) {
      const d = db.project.getDefault() || db.project.list()[0] || null;
      proj = d && d.dir && fs.existsSync(d.dir) ? d : null;
    }
    if (!proj) return { ok: false, error: '没有可用的项目目录' };
    const target = safeNotePath(proj.dir, TODO_NOTE_NAME);
    if (!target) return { ok: false, error: '待办文件路径越权' };
    const line = `- [ ] ${t}`;
    let text = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
    if (text.split(/\r?\n/).some((l: string) => l.trim() === line)) {
      return { ok: true, rel: path.relative(proj.dir, target) };
    }
    if (!text) text = TODO_NOTE_HEADER;
    if (!text.endsWith('\n')) text += '\n';
    fs.writeFileSync(target, text + line + '\n', 'utf-8');
    return { ok: true, rel: path.relative(proj.dir, target) };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ========== 本地数据工具 ==========

async function queryDatasetTool({ datasetName, conditions, limit }, projectDir) {
  const all = db.ds.list();
  const ds = all.find(d => d.name === datasetName || d.id === datasetName);
  if (!ds) {
    const names = all.map(d => d.name).join(', ');
    return `数据集 "${datasetName}" 不存在。可用数据集: ${names || '无'}`;
  }
  const rows = db.ds.query(ds.id, conditions || '');
  const limited = rows.slice(0, limit || 20);
  logger.info('[Tools] query_dataset: %s → %d records', datasetName, limited.length);
  return JSON.stringify(limited, null, 2);
}

async function listDatasetsTool() {
  const all = db.ds.list();
  return all.length ? all.map(d => `- ${d.name} (${d.id}): ${d.schema_json}`).join('\n') : '暂无数据集';
}

function resolveDataset(datasetName) {
  const all = db.ds.list();
  return all.find(d => d.name === datasetName || d.id === datasetName) || null;
}

function parseJsonArg(raw, label) {
  try { return JSON.parse(raw); } catch { return { error: `${label} 不是合法 JSON 对象` }; }
}

async function createDatasetTool({ name, description, schemaJson }) {
  if (!name || !name.trim()) return '请提供数据集名称（name）';
  db.ds.add({ name: name.trim(), description: description || '', schemaJson: schemaJson || '{}' });
  const ds = resolveDataset(name.trim());
  return `已创建数据集 "${name.trim()}" (id: ${ds ? ds.id : '?'})。可用 insert_dataset_record 写入记录。`;
}

async function insertDatasetRecordTool({ datasetName, data }) {
  const ds = resolveDataset(datasetName);
  if (!ds) {
    const names = db.ds.list().map(d => d.name).join(', ');
    return `数据集 "${datasetName}" 不存在。可用数据集: ${names || '无'}。`;
  }
  const obj = parseJsonArg(data, 'data');
  if (obj.error) return obj.error;
  db.ds.insert(ds.id, normalizeDatasetRecord(ds.id, obj));
  const r = db.qOne("SELECT id FROM data_center_records WHERE dataset_id = ? ORDER BY id DESC LIMIT 1", String(ds.id));
  logger.info('[Tools] insert_dataset_record: %s → id %s', datasetName, r ? r.id : '?');
  return `已向数据集 "${ds.name}" 插入一条记录 (id: ${r ? r.id : '?'})`;
}

async function updateDatasetRecordTool({ id, data }) {
  const exists = db.qOne("SELECT dataset_id FROM data_center_records WHERE id = ?", id);
  if (!exists) return `记录 id=${id} 不存在。可先用 query_dataset 查询记录 id。`;
  const obj = parseJsonArg(data, 'data');
  if (obj.error) return obj.error;
  db.ds.updateRecord(id, normalizeDatasetRecord(exists.dataset_id, obj));
  return `已更新数据集记录 id=${id}`;
}

async function readProjectFileTool({ filePath }, projectDir) {
  const root = projectRoot(projectDir);
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  const checked = safePath(fullPath, projectDir);
  if (!checked) return '无权访问该路径';
  try {
    const content = fs.readFileSync(checked, 'utf-8');
    return content.length > 10000 ? content.slice(0, 10000) + '\n... (截断)' : content;
  } catch (e) {
    if (e.code === 'ENOENT') return notFoundHint(root, filePath);
    return `读取失败: ${e.message}`;
  }
}

// ========== 日报工具 ==========

function getChinaDate(offsetDays = 0) {
  const d = new Date();
  const china = new Date(d.getTime() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return china.toISOString().slice(0, 10);
}

async function addReminderTool({ name, message, type, time, day_of_week, day_of_month, date }) {
  if (!name || !name.trim()) return '请提供提醒名称（name）';
  const r = db.reminder.add({
    name: name.trim(),
    message: message || '',
    type: type || 'daily',
    time: time || '09:00',
    day_of_week: day_of_week || 0,
    day_of_month: day_of_month || 1,
    date: date || '',
  });
  logger.info('[Tools] add_reminder: %s → id %s', name, r.id);
  return `已创建提醒 "${name}" (id: ${r.id}, 类型: ${type || 'daily'}, 时间: ${time || '09:00'})`;
}

async function updateReminderTool({ id, name, message, time, enabled, type, day_of_week, day_of_month, date }) {
  const exists = db.reminder.get(id);
  if (!exists) return `提醒 id=${id} 不存在。可先用 query_reminders 查询提醒 id。`;
  const patch: any = {};
  if (name !== undefined && name !== null) patch.name = name;
  if (message !== undefined && message !== null) patch.message = message;
  if (time !== undefined && time !== null) patch.time = time;
  if (enabled !== undefined && enabled !== null) patch.enabled = enabled === 'true' || enabled === true;
  if (type !== undefined && type !== null) patch.type = type;
  if (day_of_week !== undefined && day_of_week !== null) patch.day_of_week = Number(day_of_week);
  if (day_of_month !== undefined && day_of_month !== null) patch.day_of_month = Number(day_of_month);
  if (date !== undefined && date !== null) patch.date = date;
  if (!Object.keys(patch).length) return '没有需要更新的字段';
  db.reminder.update(id, patch);
  return `已更新提醒 id=${id}：${Object.keys(patch).join(', ')}`;
}

async function queryMessagesTool({ date_from, date_to, role, limit }) {
  let sql = "SELECT id, session_id, role, substr(content, 1, 200) as content, created_at FROM prj_messages WHERE 1=1";
  const p: any[] = [];
  if (role) { sql += ' AND role = ?'; p.push(role); }
  if (date_from) { sql += ' AND created_at >= ?'; p.push(date_from); }
  if (date_to) { sql += ' AND created_at <= ?'; p.push(date_to); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  p.push(limit || 20);
  const rows = db.q(sql, ...p);
  return rows.length ? JSON.stringify(rows, null, 2) : '暂无对话数据';
}

async function queryDocumentsTool({ date_from, date_to, limit }) {
  let sql = "SELECT id, path, substr(content, 1, 300) as content, file_mtime FROM kb_documents WHERE 1=1";
  const p: any[] = [];
  if (date_from) { sql += ' AND file_mtime >= ?'; p.push(date_from); }
  if (date_to) { sql += ' AND file_mtime <= ?'; p.push(date_to); }
  sql += " AND path NOT LIKE '%node_modules%' AND path NOT LIKE '%.git%' ORDER BY file_mtime DESC LIMIT ?";
  p.push(limit || 20);
  const rows = db.q(sql, ...p);
  return rows.length ? JSON.stringify(rows, null, 2) : '暂无文档更新';
}

async function queryDataRecordsTool({ dataset_name, date_from, date_to, limit }) {
  let sql = "SELECT r.*, d.name as dataset_name FROM data_center_records r LEFT JOIN data_center_datasets d ON r.dataset_id = d.id WHERE 1=1";
  const p: any[] = [];
  if (dataset_name) {
    sql += ' AND (d.name LIKE ? OR r.dataset_id IN (SELECT id FROM data_center_datasets WHERE name LIKE ?))';
    p.push('%' + dataset_name + '%', '%' + dataset_name + '%');
  }
  if (date_from) { sql += ' AND r.created_at >= ?'; p.push(date_from); }
  if (date_to) { sql += ' AND r.created_at <= ?'; p.push(date_to); }
  sql += ' ORDER BY r.created_at DESC LIMIT ?';
  p.push(limit || 20);
  const rows = db.q(sql, ...p);
  return rows.length ? JSON.stringify(rows, null, 2) : '暂无数据中心记录';
}

async function queryRemindersTool() {
  const rows = db.q("SELECT * FROM plan_reminders WHERE enabled = 1 ORDER BY created_at DESC");
  return rows.length ? JSON.stringify(rows, null, 2) : '暂无提醒';
}

async function getTodayInfoTool({}, kbId) {
  const projectName = kbId ? (db.qOne("SELECT name FROM prj_projects WHERE id = ?", kbId) || {}).name || '项目' : '项目';
  return JSON.stringify({ today: getChinaDate(), yesterday: getChinaDate(-1), weekAgo: getChinaDate(-7), projectId: kbId || null, projectName }, null, 2);
}

// ========== AI 任务工具 ==========

function resolveProjectId(project_name?: string): { id: number | null; type: string; name: string } | string {
  const projects = db.project.list();
  if (!project_name) return { id: null, type: '', name: '' };
  const match = projects.find((p: any) => p.name && (p.name.includes(project_name) || project_name.includes(p.name)));
  if (!match) return `未找到项目"${project_name}"，可用项目：${projects.map((p: any) => p.name).join('、') || '（无）'}`;
  return { id: match.id, type: match.type || '', name: match.name };
}

async function queryTasksTool({ status, limit }) {
  const rows = db.task.list(status || undefined).slice(0, limit || 20);
  return rows.length ? JSON.stringify(rows.map((r: any) => ({
    id: r.id, title: r.title, status: r.status, priority: r.priority, task_type: r.task_type, project_id: r.project_id,
    trigger_type: r.trigger_type, scheduled_start: r.scheduled_start,
    cycle_type: r.cycle_type, cycle_value: r.cycle_value, cycle_time: r.cycle_time,
    last_status: r.last_status, last_run_at: r.last_run_at, prompt: String(r.prompt || '').slice(0, 200),
  })), null, 2) : '暂无任务';
}

async function createTaskTool({ title, prompt, project_name, trigger_type, scheduled_start, cycle_type, cycle_value, cycle_time, notify_feishu, output_target }) {
  if (!title || !title.trim()) return '请提供任务标题（title）';
  const proj = resolveProjectId(project_name);
  if (typeof proj === 'string') return proj;
  const r = db.task.add({
    title: title.trim(),
    prompt: prompt || '',
    priority: 'mid',
    status: 'pending',
    task_type: 'note',
    project_id: proj.id,
    source: 'ai',
    trigger_type: trigger_type || 'now',
    scheduled_start: scheduled_start || '',
    cycle_type: cycle_type || '',
    cycle_value: cycle_value || '',
    cycle_time: cycle_time || '',
    notify_feishu: notify_feishu ? 1 : 0,
    output_target: output_target || '',
  });
  try {
    const scheduler = require('./scheduler');
    if (scheduler.reloadTasks) scheduler.reloadTasks();
    if ((trigger_type || 'now') === 'now' && scheduler.executeTaskNow) scheduler.executeTaskNow(r.id);
  } catch (e) { logger.warn('[Tools] create_task reload failed: ' + e.message); }
  const note = appendTodoNote(proj.id, String(title).trim());
  if (!note.ok) logger.warn('[Tools] create_task 待办落笔记失败: ' + note.error);
  logger.info('[Tools] create_task: %s → id %s', title, r.id);
  const where = proj.id ? `项目「${proj.name}」` : '（未指定项目，仅记录）';
  const sync = note.ok ? `已同步到笔记 ${note.rel}` : `笔记同步失败（${note.error}），可手动补记`;
  const trigger = (trigger_type || 'now') === 'now' ? '已开始执行。' : '到点将自动执行。';
  return '已创建任务 "' + title + '" (id: ' + r.id + ', 归属: ' + where + ', 触发: ' + (trigger_type || 'now')
    + (scheduled_start ? ' @ ' + scheduled_start : '') + ')。' + trigger + ' ' + sync + '。';
}

async function updateTaskTool({ id, title, prompt, status, trigger_type, scheduled_start, cycle_type, cycle_value, cycle_time }) {
  const exists = db.task.get(id);
  if (!exists) return `任务 id=${id} 不存在。可先用 query_tasks 查询任务 id。`;
  const patch: any = {};
  if (title !== undefined && title !== null) patch.title = title;
  if (prompt !== undefined && prompt !== null) patch.prompt = prompt;
  if (status !== undefined && status !== null) patch.status = status;
  if (trigger_type !== undefined && trigger_type !== null) patch.trigger_type = trigger_type;
  if (scheduled_start !== undefined && scheduled_start !== null) patch.scheduled_start = scheduled_start;
  if (cycle_type !== undefined && cycle_type !== null) patch.cycle_type = cycle_type;
  if (cycle_value !== undefined && cycle_value !== null) patch.cycle_value = cycle_value;
  if (cycle_time !== undefined && cycle_time !== null) patch.cycle_time = cycle_time;
  if (!Object.keys(patch).length) return '没有需要更新的字段';
  db.task.update(id, patch);
  try {
    const scheduler = require('./scheduler');
    if (scheduler.reloadTasks) scheduler.reloadTasks();
  } catch (e) { logger.warn('[Tools] update_task reload failed: ' + e.message); }
  return `已更新任务 id=${id}：${Object.keys(patch).join(', ')}`;
}

// ========== 组装 ==========
// 输出格式与 pi SDK 的 ToolDefinition 兼容：{ name, label, description, parameters, execute }
// execute 返回 AgentToolResult：{ content: [{ type: 'text', text }], details: {} }

const exec = (fn) => async (_toolCallId, params) => ({
  content: [{ type: 'text', text: String(await fn(params) ?? '') }],
  details: {},
});

async function buildDataToolDefs(projectDir, opts: { noWeb?: boolean } = {}) {
  const { Type } = await ensureT();
  const optStr = (description?: string) => Type.Optional(Type.Union([Type.String({ description }), Type.Null()]));
  const optNum = (description?: string) => Type.Optional(Type.Union([Type.Number({ description }), Type.String(), Type.Null()]));
  const bind = (fn) => (args) => fn(args, projectDir);
  const defs = [
    { name: 'query_dataset', label: 'query_dataset', description: '查询本地数据集中的记录。数据集用于存储结构化信息，如代办事项、客户信息、项目、Bug等。', parameters: Type.Object({ datasetName: Type.String({ description: '数据集名称，如 todos, customers, projects, bugs' }), conditions: optStr('查询条件关键字'), limit: optNum('返回条数上限，默认20') }), execute: exec((args) => queryDatasetTool({ ...args, limit: toNumber(args.limit, 20) }, projectDir)) },
    { name: 'list_datasets', label: 'list_datasets', description: '列出所有可用的数据集及其结构。', parameters: Type.Object({}), execute: exec(() => listDatasetsTool()) },
    { name: 'create_dataset', label: 'create_dataset', description: '创建一个新的数据集，用于存储结构化信息（如待办、客户、项目、Bug 等）。创建后可用 insert_dataset_record 写入记录。', parameters: Type.Object({ name: Type.String({ description: '数据集名称，如 todos, customers' }), description: Type.Optional(Type.String({ description: '数据集说明' })), schemaJson: Type.Optional(Type.String({ description: '可选的 Schema JSON 字符串，如 {"fields":[{"name":"title"}]}' })) }), execute: exec(createDatasetTool) },
    { name: 'insert_dataset_record', label: 'insert_dataset_record', description: '向数据集插入一条记录。data 参数为 JSON 对象字符串，字段须与数据集 schema 匹配。', parameters: Type.Object({ datasetName: Type.String({ description: '数据集名称或 id' }), data: Type.String({ description: '记录内容 JSON 对象，如 {"title":"季度总结","status":"进行中"}' }) }), execute: exec(insertDatasetRecordTool) },
    { name: 'update_dataset_record', label: 'update_dataset_record', description: '更新数据集中的一条记录（整体替换 data_json）。先调用 query_dataset 获取记录 id。', parameters: Type.Object({ id: Type.Number({ description: '记录 id（query_dataset 返回结果中的 id 字段）' }), data: Type.String({ description: '更新后的完整记录 JSON 对象' }) }), execute: exec(updateDatasetRecordTool) },
    { name: 'read_project_file', label: 'read_project_file', description: '读取项目目录下的文件内容。若文件不存在会返回相似文件名建议，可据此用 bash（ls/find）确认准确路径。', parameters: Type.Object({ filePath: Type.String({ description: '相对于项目根目录的文件路径，或绝对路径' }) }), execute: exec(bind(readProjectFileTool)) },
    { name: 'web_search', label: 'web_search', description: '搜索外网资料，通过搜索引擎获取与查询词相关的网页标题、链接和摘要。适合查询最新资讯、技术文档、百科知识等。', parameters: Type.Object({ query: Type.String({ description: '搜索关键词，尽量精确' }), maxResults: optNum('返回结果条数上限，默认8，最大15') }), execute: exec((args) => webSearchTool({ ...args, maxResults: toNumber(args.maxResults, 8) })) },
    { name: 'web_fetch', label: 'web_fetch', description: '读取外部 URL 的文本内容，自动去除 HTML 标签和脚本，返回纯文本。适合阅读网页文章、API 文档、新闻等。', parameters: Type.Object({ url: Type.String({ description: '要读取的完整 URL（须以 http:// 或 https:// 开头）' }), maxLength: optNum('返回内容最大字符数，默认8000，最大50000') }), execute: exec((args) => webFetchTool({ ...args, maxLength: toNumber(args.maxLength, 8000) })) },
  ];
  return opts.noWeb ? defs.filter(d => d.name !== 'web_search' && d.name !== 'web_fetch') : defs;
}

async function buildReportToolDefs(kbId) {
  const { Type } = await ensureT();
  const optStr = (description?: string) => Type.Optional(Type.Union([Type.String({ description }), Type.Null()]));
  const optNum = (description?: string) => Type.Optional(Type.Union([Type.Number({ description }), Type.String(), Type.Null()]));
  return [
    { name: 'query_messages', label: 'query_messages', description: '查询聊天/对话记录（prj_messages）。可过滤日期范围、角色( user / assistant )。', parameters: Type.Object({ date_from: optStr('起始日期 YYYY-MM-DD'), date_to: optStr('结束日期 YYYY-MM-DD'), role: optStr('角色: user / assistant'), limit: optNum('返回条数上限，默认20') }), execute: exec((args) => queryMessagesTool({ ...args, limit: toNumber(args.limit, 20) })) },
    { name: 'query_documents', label: 'query_documents', description: '查询知识库中文档更新记录（kb_documents）。可过滤日期范围。', parameters: Type.Object({ date_from: optStr('起始日期 YYYY-MM-DD'), date_to: optStr('结束日期 YYYY-MM-DD'), limit: optNum('返回条数上限，默认20') }), execute: exec((args) => queryDocumentsTool({ ...args, limit: toNumber(args.limit, 20) })) },
    { name: 'query_data_records', label: 'query_data_records', description: '查询数据中心记录（data_center_records）。可过滤数据集名称、日期范围。', parameters: Type.Object({ dataset_name: optStr('数据集名称关键词（模糊匹配）'), date_from: optStr('起始日期 YYYY-MM-DD'), date_to: optStr('结束日期 YYYY-MM-DD'), limit: optNum('返回条数上限，默认20') }), execute: exec((args) => queryDataRecordsTool({ ...args, limit: toNumber(args.limit, 20) })) },
    { name: 'query_reminders', label: 'query_reminders', description: '查询已启用的提醒事项（plan_reminders）。', parameters: Type.Object({}), execute: exec(() => queryRemindersTool()) },
    { name: 'add_reminder', label: 'add_reminder', description: '创建一条定时提醒。类型: daily(每天)/weekly(每周，需 day_of_week 0=周日)/monthly(每月，需 day_of_month)/once(一次性，需 date YYYY-MM-DD)。', parameters: Type.Object({ name: Type.String({ description: '提醒名称，如 "喝水"' }), message: optStr('提醒内容'), type: optStr('类型: daily / weekly / monthly / once，默认 daily'), time: optStr('时间 HH:MM，默认 09:00'), day_of_week: optNum('weekly 用: 0-6，0=周日'), day_of_month: optNum('monthly 用: 1-31'), date: optStr('once 用: 日期 YYYY-MM-DD') }), execute: exec(addReminderTool) },
    { name: 'update_reminder', label: 'update_reminder', description: '更新提醒（名称、内容、时间、启用状态等）。先调用 query_reminders 获取提醒 id。', parameters: Type.Object({ id: Type.String({ description: '提醒 id（如 R1712345678901）' }), name: optStr('新名称'), message: optStr('新内容'), time: optStr('时间 HH:MM'), enabled: optStr('是否启用: true / false'), type: optStr('类型: daily / weekly / monthly / once'), day_of_week: optNum('weekly 用: 0-6'), day_of_month: optNum('monthly 用: 1-31'), date: optStr('once 用: YYYY-MM-DD') }), execute: exec(updateReminderTool) },
    { name: 'query_tasks', label: 'query_tasks', description: '查询任务（plan_tasks），可按状态( pending / in_progress / done )、优先级过滤。', parameters: Type.Object({ status: optStr('过滤状态: pending / in_progress / done'), priority: optStr('过滤优先级: high / mid / low'), limit: optNum('返回条数上限，默认20') }), execute: exec((args) => queryTasksTool({ ...args, limit: toNumber(args.limit, 20) })) },
    { name: 'create_task', label: 'create_task', description: '创建一条任务（挂在笔记库下）。当用户要求"定时执行/自动执行/记录一件事"（如每天生成日报、每周总结、定时整理数据）时应调用本工具。trigger_type: now(立即执行)/once(一次性定时，需 scheduled_start YYYY-MM-DD HH:MM)/cycle(循环，需 cycle_type+cycle_time)。', parameters: Type.Object({ title: Type.String({ description: '任务标题' }), prompt: optStr('任务详细说明，AI 将据此自主执行'), project_name: optStr('项目名称（笔记库名），不传则用当前上下文'), trigger_type: optStr('触发类型: now / once / cycle，默认 now'), scheduled_start: optStr('once 用: 执行时间 YYYY-MM-DD HH:MM'), cycle_type: optStr('cycle 用: daily / weekly / monthly / cron'), cycle_value: optStr('cycle 用: weekly 为星期(逗号分隔)或 cron 表达式；daily 可为空'), cycle_time: optStr('cycle 用: 执行时间 HH:MM，如 09:00'), notify_feishu: optNum('是否推送飞书通知: 1 / 0'), output_target: optStr('结果保存路径（相对笔记库），默认存到 任务输出/ 目录') }), execute: exec(createTaskTool) },
    { name: 'update_task', label: 'update_task', description: '更新任务（标题、说明、触发配置、状态）。先调用 query_tasks 获取任务 id。', parameters: Type.Object({ id: Type.Number({ description: '任务 id' }), title: optStr('新标题'), prompt: optStr('新说明'), status: optStr('状态: pending / in_progress / done'), trigger_type: optStr('触发类型: now / once / cycle'), scheduled_start: optStr('once 用: YYYY-MM-DD HH:MM'), cycle_type: optStr('cycle 用: daily / weekly / monthly / cron'), cycle_value: optStr('cycle 用'), cycle_time: optStr('cycle 用: HH:MM') }), execute: exec(updateTaskTool) },
    { name: 'get_today_info', label: 'get_today_info', description: '获取当前日期信息（今天的中国日期、项目/知识库名称等）。', parameters: Type.Object({}), execute: exec((args) => getTodayInfoTool(args, kbId)) },
  ];
}

export { buildDataToolDefs, buildReportToolDefs, getChinaDate, appendTodoNote };

