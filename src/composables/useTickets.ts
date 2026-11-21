/**
 * 工单数据组合式函数（useTickets）
 *
 * 把工单数据集的逻辑从页面里抽出来，供事项页（列表）与工单表单弹窗共用。
 * 模块级状态 = 单例：多个组件引用同一份 tickets / 枚举，避免重复加载数据集。
 *
 * 存储：data_center_datasets 的「工单」数据集，记录在 data_json。
 * 核心字段固定（标题/类型/来源/新建人/处理人/内容/备注/状态/承诺时间/处理时间/完结时间），
 * 自定义字段与类型/来源枚举持久化在 schema_json。
 *
 * 状态模型（2026-11-20 定稿）：
 *   保留状态（不可删除）待处理 → 处理中 → 已完成 → 已关闭，各挂一条流转规则；
 *   中间段可自定义流转态，尾部可自定义终态；
 *   顺序固定为：待处理 → 处理中 → [自定义] → 已完成 → [自定义终态] → 已关闭。
 */
import { ref, computed } from 'vue';

const API = window.electronAPI;

// ========== 核心字段（固定） ==========
const CORE_FIELDS = [
  { name: '标题', type: 'string' },
  { name: '类型', type: 'string' },
  { name: '来源', type: 'string' },
  { name: '新建人', type: 'string' },
  { name: '处理人', type: 'string' },
  { name: '内容', type: 'text' },
  { name: '备注', type: 'text' },
  { name: '承诺时间', type: 'datetime' },
  { name: '处理时间', type: 'datetime' },
  { name: '完结时间', type: 'datetime' },
];
const DEFAULT_TYPES = ['需求', '问题', '咨询', '跟进'];
const DEFAULT_SOURCES = ['微信', '电话', '官网', '邮件', '会议', '其他'];
const TICKET_DS_NAME = '工单';

/**
 * 保留状态（系统级，不可删除、不可改名）。
 * 每个都挂着一条流转规则，删掉就会让对应规则失效：
 *   待处理 —— 新建工单的初始态，也是「处理时间」的计时起点
 *   处理中 —— 进入处理态时自动盖「处理时间」
 *   已完成 —— 终态，正向完结（盖完结时间、停提醒、列表划线）
 *   已关闭 —— 终态，人工关闭（联动提醒靠它判定工单完结）
 */
export const RESERVED_STATUSES = ['待处理', '处理中', '已完成', '已关闭'];
/** 保留状态里的终态 */
const RESERVED_TERMINAL = ['已完成', '已关闭'];
/**
 * 终态关键字兜底：状态名里含这些词就算终态。
 * 用户自定义「已作废 / 已终止」这类状态时不用手动标记，前后端判定保持一致。
 */
const TERMINAL_KEYWORDS = ['已关闭', '已完结', '已完成', '已解决', '已取消', '已终止', '已作废', '已失效', '已废弃', '已退单', '已拒绝', '已放弃'];
/** 历史版本的终态值（老用户自己加的），继续按终态处理，避免老数据回归 */
const LEGACY_TERMINAL = ['已完结', '已解决', '已取消', '已终止', '已作废', '已失效', '已废弃', '已退单', '已拒绝', '已放弃', '已发布'];
/** 默认状态枚举（顺序即流转顺序：待处理 → 处理中 → 已完成 → 已关闭） */
const DEFAULT_STATUS = [...RESERVED_STATUSES];

export interface Ticket { id: number; [k: string]: any; _created_at?: string; }
export interface FieldDef { name: string; type: string; displayName?: string; options?: string[]; placeholder?: string; }

// ========== 单例状态 ==========
const tickets = ref<Ticket[]>([]);
const loading = ref(true);
const loaded = ref(false);
const customFields = ref<FieldDef[]>([]);
const statusOptions = ref<string[]>([...DEFAULT_STATUS]);
/** 终态状态集合（保留终态 + 用户自定义终态），持久化在 schema_json.terminalStatuses */
const terminalStatuses = ref<string[]>([...RESERVED_TERMINAL]);
const typeOptions = ref<string[]>([...DEFAULT_TYPES]);
const sourceOptions = ref<string[]>([...DEFAULT_SOURCES]);
/** 关联待办（ticket_todos 联查出来的） */
const linkedTodos = ref<any[]>([]);
/** 各工单关联的待办数量（卡片上显示 🔗 N） */
const linkedCountsMap = ref<Record<string, number>>({});
/** 处理记录流水 */
const ticketLogs = ref<any[]>([]);
let datasetId: number | null = null;

/** 当前工单数据集 id（处理记录 / 关联待办的 API 要用） */
export function ticketDatasetId(): number | null { return datasetId; }

// ========== 工具 ==========
/** 状态名是否命中终态关键字（自定义「已作废」这类状态也能被认出来） */
function hitsTerminalKeyword(s: string): boolean {
  return TERMINAL_KEYWORDS.some(k => s.includes(k));
}

/** 是否终态：schema 里的终态集合 + 遗留终态值 + 关键字兜底 */
export function isClosed(status?: string): boolean {
  const v = String(status || '').trim();
  if (!v) return false;
  if (terminalStatuses.value.includes(v)) return true;
  if (LEGACY_TERMINAL.includes(v)) return true;
  return hitsTerminalKeyword(v);
}

/**
 * 状态顺序规范化：待处理 → 处理中 → [自定义流转态] → 已完成 → [自定义终态] → 已关闭。
 * 保留状态位置固定（流转规则依赖它们），中间段留给用户自定义。
 */
export function orderStatuses(list: string[], terminals: string[]): string[] {
  const termSet = new Set(terminals);
  const flow: string[] = [];
  const term: string[] = [];
  for (const s of list) {
    if (RESERVED_STATUSES.includes(s)) continue;
    if (termSet.has(s) || LEGACY_TERMINAL.includes(s) || hitsTerminalKeyword(s)) term.push(s);
    else flow.push(s);
  }
  return [
    ...RESERVED_STATUSES.slice(0, 2),
    ...flow,
    ...RESERVED_STATUSES.slice(2, 3),
    ...term,
    ...RESERVED_STATUSES.slice(3),
  ];
}

/** 承诺时间原始值（"YYYY-MM-DD HH:MM"），无则空串 */
export function promiseOf(t: Ticket): string {
  return String(t['承诺时间'] || '').trim();
}
/** 承诺日期部分（YYYY-MM-DD），无承诺时间返回空串 */
export function promiseDateOf(t: Ticket): string {
  return promiseOf(t).slice(0, 10);
}

// ========== 数据集：找到或创建（含核心字段 schema） ==========
async function ensureDataset(): Promise<number> {
  const all = await API.ds.list();
  const found = Array.isArray(all) ? all.find((d: any) => d.name === TICKET_DS_NAME) : null;
  if (found) {
    datasetId = found.id;
    syncSchemaFromDataset(found);
    return found.id;
  }
  const schemaJson = buildSchemaJson([], [...DEFAULT_STATUS], [...DEFAULT_TYPES], [...DEFAULT_SOURCES], [...RESERVED_TERMINAL]);
  await API.ds.add({ name: TICKET_DS_NAME, description: '通用事项：核心字段固定，自定义字段按需添加。填承诺时间到点自动提醒。', schemaJson });
  const all2 = await API.ds.list();
  const made = Array.isArray(all2) ? all2.find((d: any) => d.name === TICKET_DS_NAME) : null;
  datasetId = made ? made.id : null;
  return datasetId!;
}

function buildSchemaJson(custom: FieldDef[], statuses: string[], types: string[], sources: string[], terminals: string[]): string {
  const fields = [...CORE_FIELDS, ...custom].map(f => ({ name: f.name, type: f.type }));
  return JSON.stringify({ fields, statusOptions: statuses, terminalStatuses: terminals, typeOptions: types, sourceOptions: sources });
}

/** 从已有数据集回读：区分核心字段与自定义字段，同步状态/类型/来源枚举 */
function syncSchemaFromDataset(ds: any): void {
  let schema: any = null;
  try { schema = ds.schemaJson ? JSON.parse(ds.schemaJson) : (ds.schema_json ? JSON.parse(ds.schema_json) : null); } catch { schema = null; }
  if (!schema) {
    customFields.value = [];
    statusOptions.value = [...DEFAULT_STATUS];
    terminalStatuses.value = [...RESERVED_TERMINAL];
    typeOptions.value = [...DEFAULT_TYPES];
    sourceOptions.value = [...DEFAULT_SOURCES];
    return;
  }
  const fields: any[] = schema.fields || [];
  const coreNames = new Set(CORE_FIELDS.map(f => f.name));
  customFields.value = fields.filter((f: any) => f && f.name && !coreNames.has(f.name))
    .map((f: any) => ({ name: f.name, type: f.type || 'string', displayName: f.displayName, options: f.options, placeholder: f.placeholder }));
  const mergedEnums = (stored: string[] | undefined, defaults: string[]): string[] => {
    const out = [...defaults];
    for (const s of (stored || [])) if (!out.includes(s)) out.push(s);
    return out;
  };
  typeOptions.value = mergedEnums(schema.typeOptions, DEFAULT_TYPES);
  sourceOptions.value = mergedEnums(schema.sourceOptions, DEFAULT_SOURCES);

  // 状态：终态集合 + 顺序规范化
  // （老 schema 里自定义状态是追加在末尾的，这里统一重排到「处理中」和「已完成」之间）
  const storedStatuses: string[] = Array.isArray(schema.statusOptions) ? schema.statusOptions : [];
  const storedTerminals: string[] = Array.isArray(schema.terminalStatuses) ? schema.terminalStatuses : [];
  const terminals = [...new Set([...RESERVED_TERMINAL, ...storedTerminals])];
  // 迁移：命中终态关键字的旧状态（用户自己加的「已解决」等）纳入终态集合
  for (const s of storedStatuses) {
    if (terminals.includes(s)) continue;
    if (LEGACY_TERMINAL.includes(s) || hitsTerminalKeyword(s)) terminals.push(s);
  }
  terminalStatuses.value = terminals;
  const ordered = orderStatuses(mergedEnums(storedStatuses, DEFAULT_STATUS), terminals);
  statusOptions.value = ordered;
  // 顺序或终态集合有变化 → 写回 schema（把迁移结果落盘，避免每次启动重复排）
  if (ordered.join('|') !== storedStatuses.join('|') || terminals.join('|') !== storedTerminals.join('|')) {
    void persistSchema();
  }
}

/** 把当前自定义字段 + 枚举写回 schema（增删自定义字段或枚举时调用） */
async function persistSchema(): Promise<void> {
  if (!datasetId) return;
  const schemaJson = buildSchemaJson(customFields.value, statusOptions.value, typeOptions.value, sourceOptions.value, terminalStatuses.value);
  // 字段名必须是 schema_json（snake_case）：主进程按这个键取值，传 camelCase 会被静默忽略
  await API.ds.updateMeta(datasetId, { schema_json: schemaJson });
}

// ========== 加载 / 保存 / 删除 ==========
async function reload(): Promise<void> {
  if (!datasetId) return;
  loading.value = true;
  try {
    const res = await API.ds.listRecords(datasetId, { limit: 200 });
    tickets.value = (res && res.rows) || [];
  } catch { tickets.value = []; }
  loading.value = false;
  await loadLinkedCounts();
}

/** 初始化（幂等）：确保数据集存在并加载记录。事项页 onMounted 调用一次。 */
async function init(): Promise<void> {
  const first = !loaded.value;
  loaded.value = true;
  try {
    // 每次进入都回同步一次 schema：枚举可能在「工单设置」或数据中心页被改过
    await ensureDataset();
    if (first) await reload();
  } finally {
    loading.value = false;
  }
}

/** 保存（新建或编辑）。form 为完整字段对象；editingId 为空即新建。 */
async function save(form: Record<string, any>, editingId: number | null): Promise<void> {
  if (!datasetId || !form.标题?.trim()) return;
  const f = { ...form };
  // 状态流转自动盖时间戳：
  //   离开「待处理」进入流转态 → 盖处理时间（处理中 / 自定义流转态都算）
  //   进入终态 → 盖完结时间；离开终态 → 清空完结时间
  const now = nowLocal();
  const st = String(f.状态 || '').trim();
  const terminal = isClosed(st);
  if (!terminal && st && st !== '待处理' && !f.处理时间) f.处理时间 = now;
  if (terminal) { if (!f.完结时间) f.完结时间 = now; }
  else { f.完结时间 = ''; }
  // 承诺时间存成 "YYYY-MM-DD HH:MM"（联动层认这个格式）
  if (f.承诺时间) f.承诺时间 = f.承诺时间.replace('T', ' ');
  try {
    if (editingId) await API.ds.updateRecord(editingId, f);
    else await API.ds.insert(datasetId, f);
    await reload();
  } catch (e: any) { alert('保存失败：' + (e?.message || e)); }
}

async function remove(t: Ticket): Promise<void> {
  if (!confirm('删除这条工单？（关联的自动提醒会一并停用）')) return;
  await API.ds.deleteRecord(t.id);
  await reload();
}

/** 空白表单（含全部核心字段 + 自定义字段） */
function blankForm(): Record<string, any> {
  const f: Record<string, any> = {
    标题: '', 类型: '', 来源: '', 新建人: '', 处理人: '',
    内容: '', 备注: '', 状态: '待处理', 承诺时间: '', 处理时间: '', 完结时间: '',
  };
  for (const cf of customFields.value) f[cf.name] = '';
  return f;
}

// ========== 自定义字段 / 枚举 ==========
function addCustomField(name: string): boolean {
  const n = name.trim();
  if (!n || customFields.value.some(cf => cf.name === n) || CORE_FIELDS.some(cf => cf.name === n)) return false;
  customFields.value.push({ name: n, type: 'string' });
  persistSchema();
  return true;
}
function removeCustomField(name: string): void {
  customFields.value = customFields.value.filter(cf => cf.name !== name);
  persistSchema();
}
/** 枚举管理：类型 / 来源 / 状态三种可配置枚举（状态删除时保护保留状态，否则流转规则失效） */
type EnumKind = 'type' | 'source' | 'status';
const enumList = (which: EnumKind) => which === 'type' ? typeOptions : which === 'source' ? sourceOptions : statusOptions;

function addEnumOption(which: EnumKind, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  const list = enumList(which);
  if (list.value.includes(v)) return false;
  if (which === 'status') {
    // 新状态按性质插入对应区段：流转态进中间段（已完成之前），终态态进尾段（已关闭之前）
    const isTerm = isFixedTerminal(v);
    const anchor = isTerm ? '已关闭' : '已完成';
    const idx = list.value.indexOf(anchor);
    if (idx >= 0) list.value.splice(idx, 0, v);
    else list.value.push(v);
    // 名称含终态词（已作废 / 已终止…）自动纳入终态集合
    if (isTerm && !terminalStatuses.value.includes(v)) terminalStatuses.value.push(v);
  } else {
    list.value.push(v);
  }
  persistSchema();
  return true;
}

function removeEnumOption(which: EnumKind, value: string): boolean {
  // 保留状态不可删：待处理/处理中/已完成/已关闭 都挂着流转规则
  if (which === 'status' && RESERVED_STATUSES.includes(value)) return false;
  const list = enumList(which);
  const i = list.value.indexOf(value);
  if (i < 0) return false;
  list.value.splice(i, 1);
  // 删掉自定义终态时同步摘出终态集合
  if (which === 'status') terminalStatuses.value = terminalStatuses.value.filter(t => t !== value);
  persistSchema();
  return true;
}

/** 切换自定义状态是否为终态（终态 → 盖完结时间、联动清提醒、列表划线） */
function toggleTerminalStatus(value: string): void {
  if (RESERVED_STATUSES.includes(value)) return; // 保留状态的终态性固定
  if (isFixedTerminal(value)) return;           // 名称含终态词的，终态性由名字决定
  const i = terminalStatuses.value.indexOf(value);
  if (i >= 0) terminalStatuses.value.splice(i, 1);
  else terminalStatuses.value.push(value);
  persistSchema();
}

/** 自定义状态是否已被标记为终态 */
function isTerminalStatus(value: string): boolean {
  return terminalStatuses.value.includes(value) || isFixedTerminal(value);
}

/** 状态名本身含终态关键字（终态性固定，用户改不了） */
export function isFixedTerminal(value: string): boolean {
  return LEGACY_TERMINAL.includes(value) || hitsTerminalKeyword(value);
}

function nowLocal(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 今天日期串（本地） */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 未关闭且未完成数量（侧栏徽标等） */
export const openCount = computed(() => tickets.value.filter(t => !isClosed(t['状态'])).length);

/** 只取工单自身的字段（去掉列表附加的 id / _created_at，避免写回时污染 data_json） */
function ticketFields(t: Ticket): Record<string, any> {
  const out: Record<string, any> = {};
  const names = [...CORE_FIELDS.map(f => f.name), ...customFields.value.map(f => f.name)];
  for (const n of names) out[n] = t[n] == null ? '' : String(t[n]);
  return out;
}

/**
 * 快捷改状态（卡片上的状态徽章点一下就用它）。
 * 走同一条 save 通道 → 主进程记录流水 + 触发终态联动，逻辑不分叉。
 */
async function setStatus(ticket: Ticket, status: string): Promise<void> {
  if (!ticket || !status) return;
  if (String(ticket['状态'] || '') === status) return;
  const f = ticketFields(ticket);
  f['状态'] = status;
  await save(f, ticket.id);
}

// ========== 处理记录 / 关联待办 ==========

/** 载入关联数量（卡片上显示 🔗 N） */
async function loadLinkedCounts(): Promise<void> {
  if (!datasetId) { linkedCountsMap.value = {}; return; }
  try { linkedCountsMap.value = (await API.ticket.todoCounts(datasetId)) || {}; }
  catch { linkedCountsMap.value = {}; }
}

/** 载入某工单的处理记录 */
async function loadLogs(ticket: Ticket | null): Promise<void> {
  if (!ticket || !datasetId) { ticketLogs.value = []; return; }
  try { ticketLogs.value = await API.ticket.logList(datasetId, ticket.id); }
  catch { ticketLogs.value = []; }
}

/** 载入某工单关联的待办 */
async function loadLinkedTodos(ticket: Ticket | null): Promise<void> {
  if (!ticket || !datasetId) { linkedTodos.value = []; return; }
  try { linkedTodos.value = await API.ticket.todoList(datasetId, ticket.id); }
  catch { linkedTodos.value = []; }
}

/** 手工补一条处理记录 */
async function addLogNote(ticket: Ticket | null, note: string): Promise<boolean> {
  if (!ticket || !datasetId) return false;
  const ok = await API.ticket.logAdd(datasetId, ticket.id, note);
  await loadLogs(ticket);
  return !!ok;
}

/** 由工单拆一条待办并关联 */
async function createTodo(ticket: Ticket | null, title: string, opts?: { priority?: string; scheduled_start?: string }): Promise<any> {
  if (!ticket || !datasetId) return null;
  const created = await API.ticket.todoCreate(datasetId, ticket.id, { title, ...(opts || {}) });
  await loadLinkedTodos(ticket);
  await loadLinkedCounts();
  return created;
}

/** 关联一条已有待办 */
async function linkTodo(ticket: Ticket | null, todoId: number): Promise<void> {
  if (!ticket || !datasetId) return;
  await API.ticket.todoLink(datasetId, ticket.id, todoId);
  await loadLinkedTodos(ticket);
  await loadLinkedCounts();
}

/** 解除关联 */
async function unlinkTodo(ticket: Ticket | null, todoId: number): Promise<void> {
  if (!ticket || !datasetId) return;
  await API.ticket.todoUnlink(datasetId, ticket.id, todoId);
  await loadLinkedTodos(ticket);
  await loadLinkedCounts();
}

/** 勾掉 / 恢复关联待办 */
async function toggleTodo(ticket: Ticket | null, todoId: number, done: boolean): Promise<void> {
  if (!datasetId) return;
  await API.ticket.todoToggle(todoId, done);
  await loadLinkedTodos(ticket);
}

/** 导出共享状态与操作 */
export function useTickets() {
  return {
    tickets, loading, customFields, statusOptions, terminalStatuses, typeOptions, sourceOptions,
    linkedTodos, ticketLogs, linkedCountsMap,
    init, reload, save, remove, blankForm, setStatus,
    loadLogs, loadLinkedTodos, loadLinkedCounts, addLogNote, createTodo, linkTodo, unlinkTodo, toggleTodo,
    addCustomField, removeCustomField, addEnumOption, removeEnumOption,
    toggleTerminalStatus, isTerminalStatus,
  };
}
