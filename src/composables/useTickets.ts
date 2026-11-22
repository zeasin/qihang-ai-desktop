/**
 * 工单数据组合式函数（useTickets）
 *
 * 把工单数据的逻辑从页面里抽出来，供事项页（列表）与工单表单弹窗共用。
 * 模块级状态 = 单例：多个组件引用同一份 tickets / 枚举，避免重复加载。
 *
 * 存储（2026-11-21）：tickets 专表（中文列名 + extra_json 自定义字段），
 * 枚举/字段定义存 ticket_settings。待办已并入工单（类型='待办'），
 * data_center 通用层与独立待办表已退役。
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
  { name: '项目', type: 'string' },
  { name: '新建人', type: 'string' },
  { name: '处理人', type: 'string' },
  { name: '内容', type: 'text' },
  { name: '备注', type: 'text' },
  { name: '承诺时间', type: 'datetime' },
  { name: '处理时间', type: 'datetime' },
  { name: '完结时间', type: 'datetime' },
];
const DEFAULT_TYPES = ['待办', '需求', '问题', '咨询', '跟进'];
const DEFAULT_SOURCES = ['微信', '电话', '官网', '邮件', '会议', '其他'];
const DEFAULT_PROJECTS = ['金箔雲'];

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
const customFields = ref<FieldDef[]>([]);
const statusOptions = ref<string[]>([...DEFAULT_STATUS]);
/** 终态状态集合（保留终态 + 用户自定义终态），持久化在 ticket_settings.schema_json */
const terminalStatuses = ref<string[]>([...RESERVED_TERMINAL]);
const typeOptions = ref<string[]>([...DEFAULT_TYPES]);
const sourceOptions = ref<string[]>([...DEFAULT_SOURCES]);
/** 项目枚举（与类型/来源同机制：ticket_settings.projectOptions，工单设置页管理） */
const projectOptions = ref<string[]>([...DEFAULT_PROJECTS]);
/** 关联待办（ticket_todos 联查出来的，待办本身是类型'待办'的工单） */
const linkedTodos = ref<any[]>([]);
/** 各工单关联的待办数量（卡片上显示 🔗 N） */
const linkedCountsMap = ref<Record<string, number>>({});
/** 处理记录流水 */
const ticketLogs = ref<any[]>([]);
/** 流转节点时间轴（ticket_flow_nodes 查出的有序行） */
const flowNodes = ref<any[]>([]);
/** 处理人节点（工单设置页管理） */
const handlers = ref<any[]>([]);

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

// ========== 设置：枚举/字段定义（ticket_settings 单行） ==========
async function loadSettings(): Promise<void> {
  const schema = await API.ticket.settings.get();
  syncSchema(schema);
}

function buildSchemaObject(custom: FieldDef[], statuses: string[], types: string[], sources: string[], terminals: string[], projects: string[]): any {
  const fields = [...CORE_FIELDS, ...custom].map(f => ({ name: f.name, type: f.type }));
  // 各数组浅拷贝成普通数组再过 IPC（ref 深层是 reactive 代理，直接传会报 An object could not be cloned）
  return {
    fields,
    statusOptions: [...statuses],
    terminalStatuses: [...terminals],
    typeOptions: [...types],
    sourceOptions: [...sources],
    projectOptions: [...projects],
  };
}

/** 从设置回读：区分核心字段与自定义字段，同步状态/类型/来源枚举 */
function syncSchema(schema: any): void {
  if (!schema) {
    customFields.value = [];
    statusOptions.value = [...DEFAULT_STATUS];
    terminalStatuses.value = [...RESERVED_TERMINAL];
    typeOptions.value = [...DEFAULT_TYPES];
    sourceOptions.value = [...DEFAULT_SOURCES];
    projectOptions.value = [...DEFAULT_PROJECTS];
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
  projectOptions.value = mergedEnums(schema.projectOptions, DEFAULT_PROJECTS);

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

/** 把当前自定义字段 + 枚举写回设置（增删自定义字段或枚举时调用） */
async function persistSchema(): Promise<void> {
  await API.ticket.settings.save(buildSchemaObject(customFields.value, statusOptions.value, typeOptions.value, sourceOptions.value, terminalStatuses.value, projectOptions.value));
}

// ========== 加载 / 保存 / 删除 ==========
async function reload(): Promise<void> {
  loading.value = true;
  try {
    tickets.value = (await API.ticket.data.list()) || [];
  } catch { tickets.value = []; }
  loading.value = false;
  await loadLinkedCounts();
}

/** 初始化：同步枚举设置并加载工单。事项页 onMounted 调用，每次进入都拉最新数据。 */
async function init(): Promise<void> {
  try {
    // 每次进入都回同步一次设置：枚举可能在「工单设置」里被改过（主进程侧已有默认值 bootstrap）
    await loadSettings();
    await reload();
    bindTicketsChanged();
  } finally {
    loading.value = false;
  }
}

/** 外部写入（AI / 飞书 / 移动端）→ 主进程广播 tickets:changed → 防抖刷新本页数据 */
let ticketsListenerBound = false;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
function bindTicketsChanged(): void {
  if (ticketsListenerBound || typeof API.on !== 'function') return;
  ticketsListenerBound = true;
  try {
    API.on('tickets:changed', () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { void reload(); }, 300);
    });
  } catch {}
}

/** 保存（新建或编辑）。form 为完整字段对象；editingId 为空即新建。
 *  状态流转时间戳（处理时间/完结时间）与承诺时间归一由主进程 tickets 服务统一盖章。 */
async function save(form: Record<string, any>, editingId: number | null): Promise<void> {
  if (!form.标题?.trim()) return;
  // 浅拷贝成普通对象再过 IPC：编辑弹窗的 form 是 reactive 代理，
  // 直接传给 invoke 会报「An object could not be cloned」
  const payload: Record<string, any> = { ...form };
  try {
    if (editingId) await API.ticket.data.update(editingId, payload);
    else await API.ticket.data.create(payload);
    await reload();
  } catch (e: any) { alert('保存失败：' + (e?.message || e)); }
}

async function remove(t: Ticket): Promise<void> {
  if (!confirm('删除这条工单？（关联的自动提醒会一并停用）')) return;
  await API.ticket.data.remove(t.id);
  await reload();
}

/** 空白表单（含全部核心字段 + 自定义字段） */
function blankForm(): Record<string, any> {
  const f: Record<string, any> = {
    标题: '', 类型: '', 来源: '', 项目: '', 新建人: '', 处理人: '',
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
type EnumKind = 'type' | 'source' | 'project' | 'status';
const enumList = (which: EnumKind) => which === 'type' ? typeOptions : which === 'source' ? sourceOptions : which === 'project' ? projectOptions : statusOptions;

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
 * extra.handler：顺手带上处理人（流转到某节点）；extra.result：本次处理结果
 * （并入备注尾部，流转引擎写进节点账、随指派通知一起发出）。
 */
async function setStatus(ticket: Ticket, status: string, extra?: { handler?: string; result?: string }): Promise<void> {
  if (!ticket || !status) return;
  if (String(ticket['状态'] || '') === status && !(extra && extra.handler)) return;
  const f = ticketFields(ticket);
  f['状态'] = status;
  const handler = String(extra?.handler || '').trim();
  if (handler) f['处理人'] = handler;
  const result = String(extra?.result || '').trim();
  if (result) {
    const remark = String(f['备注'] || '').trim();
    f['备注'] = remark ? `${remark}；结果：${result}` : `结果：${result}`;
  }
  await save(f, ticket.id);
}

// ========== 处理记录 / 关联待办 ==========

/** 载入关联数量（卡片上显示 🔗 N） */
async function loadLinkedCounts(): Promise<void> {
  try { linkedCountsMap.value = (await API.ticket.todoCounts()) || {}; }
  catch { linkedCountsMap.value = {}; }
}

/** 载入某工单的处理记录 */
async function loadLogs(ticket: Ticket | null): Promise<void> {
  if (!ticket) { ticketLogs.value = []; return; }
  try { ticketLogs.value = await API.ticket.logList(ticket.id); }
  catch { ticketLogs.value = []; }
}

/** 载入某工单关联的待办 */
async function loadLinkedTodos(ticket: Ticket | null): Promise<void> {
  if (!ticket) { linkedTodos.value = []; return; }
  try { linkedTodos.value = await API.ticket.todoList(ticket.id); }
  catch { linkedTodos.value = []; }
}

/** 手工补一条处理记录 */
async function addLogNote(ticket: Ticket | null, note: string): Promise<boolean> {
  if (!ticket) return false;
  const ok = await API.ticket.logAdd(ticket.id, note);
  await loadLogs(ticket);
  return !!ok;
}

/** 由工单拆一条待办并关联 */
async function createTodo(ticket: Ticket | null, title: string, opts?: { priority?: string; scheduled_start?: string }): Promise<any> {
  if (!ticket) return null;
  const created = await API.ticket.todoCreate(ticket.id, { title, ...(opts || {}) });
  await loadLinkedTodos(ticket);
  await loadLinkedCounts();
  return created;
}

/** 关联一条已有待办 */
async function linkTodo(ticket: Ticket | null, todoId: number): Promise<void> {
  if (!ticket) return;
  await API.ticket.todoLink(ticket.id, todoId);
  await loadLinkedTodos(ticket);
  await loadLinkedCounts();
}

/** 解除关联 */
async function unlinkTodo(ticket: Ticket | null, todoId: number): Promise<void> {
  if (!ticket) return;
  await API.ticket.todoUnlink(ticket.id, todoId);
  await loadLinkedTodos(ticket);
  await loadLinkedCounts();
}

/** 勾掉 / 恢复关联待办 */
async function toggleTodo(ticket: Ticket | null, todoId: number, done: boolean): Promise<void> {
  await API.ticket.todoToggle(todoId, done);
  await loadLinkedTodos(ticket);
}

// ========== 流转：处理人节点 + 节点时间轴 ==========

/** 载入某工单的流转节点时间轴（按 node_index 正序） */
async function loadFlowNodes(ticket: Ticket | null): Promise<void> {
  if (!ticket) { flowNodes.value = []; return; }
  try { flowNodes.value = await API.ticket.flowNodes.list(ticket.id); }
  catch { flowNodes.value = []; }
}

/** 载入处理人节点（工单设置页管理；保存/编辑页用来下拉选人） */
async function loadHandlers(): Promise<void> {
  try { handlers.value = await API.ticket.handler.list(); }
  catch { handlers.value = []; }
}

/** 处理人节点 CRUD（设置页用） */
async function addHandler(data: { name: string; webhook_url?: string; remark?: string }): Promise<any> {
  const r = await API.ticket.handler.add(data);
  await loadHandlers();
  return r;
}
async function updateHandler(id: number, data: { name?: string; webhook_url?: string; remark?: string; enabled?: boolean }): Promise<void> {
  await API.ticket.handler.update(id, data);
  await loadHandlers();
}
async function removeHandler(id: number): Promise<void> {
  await API.ticket.handler.remove(id);
  await loadHandlers();
}

/** 导出共享状态与操作 */
export function useTickets() {
  return {
    tickets, loading, customFields, statusOptions, terminalStatuses, typeOptions, sourceOptions, projectOptions,
    linkedTodos, ticketLogs, linkedCountsMap, flowNodes, handlers,
    init, reload, save, remove, blankForm, setStatus,
    loadLogs, loadLinkedTodos, loadLinkedCounts, addLogNote, createTodo, linkTodo, unlinkTodo, toggleTodo,
    loadFlowNodes, loadHandlers, addHandler, updateHandler, removeHandler,
    addCustomField, removeCustomField, addEnumOption, removeEnumOption,
    toggleTerminalStatus, isTerminalStatus,
  };
}
