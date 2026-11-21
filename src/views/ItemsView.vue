<template>
  <div class="page items-page" @click="closeStatusMenu">
    <header class="page-head">
      <div>
        <h1 class="page-title">事项</h1>
        <p class="page-sub">待办与工单混排成一条时间线：要动手的是待办，要跟进的是工单，到点的都会提醒你。</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm btn-secondary" @click="showDone = !showDone">{{ showDone ? '隐藏已完成' : '显示已完成' }}</button>
        <button class="btn btn-sm btn-secondary" title="工单设置（类型/来源/状态枚举与自定义字段）" @click="showTicketSettings = true"><AppIcon name="settings" :size="13" />工单设置</button>
        <button class="btn btn-sm btn-secondary" @click="openTicketCreate"><AppIcon name="clipboard-list" :size="13" />新建工单</button>
        <button class="btn btn-primary btn-sm" @click="createReminder"><AppIcon name="bell" :size="13" />新建提醒</button>
      </div>
    </header>

    <!-- ========== 快速添加待办 ========== -->
    <div class="quick-add panel">
      <AppIcon name="plus" :size="14" />
      <input
        v-model="newTodoTitle"
        class="quick-input"
        type="text"
        placeholder="添加待办，回车确认（会同步写入笔记）"
        @keyup.enter="addTodo"
      >
      <input v-model="newTodoDate" class="quick-date" type="date" title="截止日期（可选）">
      <button class="btn btn-primary btn-sm" :disabled="!newTodoTitle.trim()" @click="addTodo">添加</button>
    </div>

    <!-- ========== 统一时间线：逾期 / 今天 / 稍后 ========== -->
    <div class="sec-label"><AppIcon name="list-checks" :size="13" />时间线<em>待办 {{ openTodoCount }} 项 · 工单 {{ openTicketCount }} 件未关闭</em></div>
    <template v-for="sec in timeline" :key="sec.key">
      <div class="tl-sec-head" :class="{ warm: sec.key === 'overdue' }">
        <AppIcon :name="sec.key === 'overdue' ? 'clock' : 'list-checks'" :size="12" />{{ sec.label }}
        <span class="sec-count">{{ sec.items.length }}</span>
      </div>

      <div class="tl-grid" v-if="sec.items.length">
        <!-- 待办卡 -->
        <div
          v-for="t in sec.todos" :key="'todo-' + t.id"
          class="item-card todo-card"
          :class="{ done: t.status === 'done', overdue: sec.key === 'overdue' }"
        >
          <div class="item-head">
            <button class="todo-box" :title="t.status === 'done' ? '标记为未完成' : '标记完成'" @click="toggleTodo(t)">
              <AppIcon v-if="t.status === 'done'" name="check" :size="11" />
            </button>
            <span class="prio" :class="t.priority"></span>
            <span class="item-title">{{ t.title }}</span>
            <button class="row-del" title="删除待办" @click="removeTodo(t)"><AppIcon name="trash-2" :size="13" /></button>
          </div>
          <div class="item-foot">
            <span class="kind-tag">待办</span>
            <span class="todo-dt" :class="{ warm: sec.key === 'overdue' }">
              <AppIcon v-if="todoDue(t)" name="calendar" :size="11" />{{ todoDue(t) || '无截止日期' }}
            </span>
          </div>
        </div>

        <!-- 工单卡 -->
        <div
          v-for="t in sec.tickets" :key="'ticket-' + t.id"
          class="item-card ticket-card"
          :class="{ overdue: sec.key === 'overdue' }"
          @click="openTicketEdit(t)"
        >
          <div class="item-head">
            <span class="ticket-dot" :class="statusTone(t.状态)"></span>
            <span class="item-title" :class="{ through: isClosed(t['状态']) }">{{ t.标题 || '(无标题)' }}</span>
            <button class="row-del" title="删除工单" @click.stop="removeTicket(t)"><AppIcon name="trash-2" :size="13" /></button>
          </div>
          <div class="item-badges">
            <button class="badge badge-btn" :class="'badge-' + statusTone(t.状态)" title="点击切换状态" @click.stop="openStatusMenu($event, t)">
              {{ t.状态 || '待处理' }}<AppIcon name="chevron-down" :size="10" />
            </button>
            <button class="advance-btn" :title="isClosed(t['状态']) ? '打回处理中' : '推进到 ' + nextStatusOf(t)" @click.stop="advanceStatus(t)">
              {{ advanceLabel(t) }}
            </button>
            <span class="kind-tag" v-if="t.类型">{{ t.类型 }}</span>
            <span class="kind-tag kind-tag-dim" v-if="t.来源">{{ t.来源 }}</span>
            <span class="kind-tag kind-tag-dim" v-if="t.处理人"><AppIcon name="user" :size="10" />{{ t.处理人 }}</span>
            <button
              v-if="linkedCount(t.id)"
              class="kind-tag kind-tag-dim link-btn"
              title="查看关联待办"
              @click.stop="toggleExpand(t.id)"
            ><AppIcon name="link" :size="10" />{{ linkedCount(t.id) }}</button>
          </div>
          <!-- 关联待办（点 🔗 展开） -->
          <div class="card-todos" v-if="linkedCount(t.id) && expandedTodos.has(t.id)">
            <div class="card-todo" v-for="td in linkedTodos" :key="'ct-' + td.id">
              <button
                class="mini-box"
                :class="{ done: td.status === 'done' }"
                :title="td.status === 'done' ? '恢复待办' : '标记完成'"
                @click.stop="flipLinkedTodo(ticketRef(t.id), td)"
              ><AppIcon v-if="td.status === 'done'" name="check" :size="10" /></button>
              <span :class="{ through: td.status === 'done' }">{{ td.title }}</span>
            </div>
          </div>
          <div class="item-desc" v-if="t.内容 || t.备注">{{ truncate(t.内容 || t.备注, 90) }}</div>
          <div class="item-foot">
            <span class="kind-tag kind-tag-dim">工单</span>
            <span class="todo-dt" :class="{ warm: isDueSoon(t) }">
              <AppIcon v-if="promiseOf(t)" name="clock" :size="11" />{{ promiseOf(t) ? fmtPromise(t) : '无承诺时间' }}
            </span>
          </div>
        </div>
      </div>

      <div v-else class="empty-row">{{ sec.empty }}</div>
    </template>

    <!-- ========== 定时提醒 ========== -->
    <div class="sec-label"><AppIcon name="bell" :size="13" />定时提醒<em>已启用 {{ enabledCount }} / {{ reminders.length }} 条</em></div>
    <section class="reminder-grid-wrap">
      <div v-if="reminders.length === 0" class="panel empty-panel">
        <AppIcon name="bell" :size="26" />
        <p>还没有提醒。新建一条，到点会通过系统通知和飞书提醒你。</p>
      </div>
      <div v-else class="reminder-grid">
        <div
          v-for="reminder in reminders"
          :key="reminder.id"
          class="panel reminder-card"
          :class="{ disabled: !reminder.enabled }"
          @click="editReminder(reminder)"
        >
          <div class="reminder-header">
            <span class="reminder-name">{{ reminder.name }}</span>
            <div
              class="reminder-toggle"
              :class="{ on: reminder.enabled }"
              title="启用 / 停用"
              @click.stop="toggleReminder(reminder)"
            ></div>
          </div>
          <div class="reminder-message">{{ reminder.message || '（无备注）' }}</div>
          <div class="reminder-schedule">
            <AppIcon name="clock" :size="12" />{{ getScheduleText(reminder) }}
          </div>
          <div class="reminder-ops">
            <button class="btn btn-secondary btn-xs test-btn" @click.stop="testReminder(reminder)">测试触发</button>
            <button class="row-del" title="删除提醒" @click.stop="openDeleteModal(reminder.id)"><AppIcon name="trash-2" :size="13" /></button>
          </div>
        </div>
      </div>
    </section>

    <!-- 提醒编辑模态框 -->
    <div v-if="showReminderModal" class="modal-overlay" @click="showReminderModal = false">
      <div class="modal-box" @click.stop>
        <div class="modal-header">
          <h3>{{ isEditingReminder ? '编辑提醒' : '新建提醒' }}</h3>
          <button class="icon-btn" @click="showReminderModal = false"><AppIcon name="x" :size="14" /></button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>提醒名称 *</label>
            <input type="text" class="form-control" v-model="editingReminder.name" placeholder="例如：下班日报提醒">
          </div>
          <div class="form-group">
            <label>提醒消息</label>
            <textarea class="form-control" v-model="editingReminder.message" rows="3" placeholder="提醒内容（可选）"></textarea>
          </div>
          <div class="form-group">
            <label>提醒类型 *</label>
            <select class="form-control" v-model="editingReminder.type">
              <option value="daily">每天 - 每天定时提醒</option>
              <option value="once">一次 - 指定日期提醒</option>
              <option value="weekly">每周 - 每周特定星期几提醒</option>
              <option value="monthly">每月 - 每月特定几号提醒</option>
              <option value="yearly">每年 - 每年特定日期提醒</option>
            </select>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>提醒时间 *</label>
              <input type="time" class="form-control" v-model="editingReminder.time" value="09:00">
            </div>
            <div class="form-group" v-if="editingReminder.type === 'weekly'">
              <label>星期几</label>
              <select class="form-control" v-model.number="editingReminder.day_of_week">
                <option :value="1">周一</option>
                <option :value="2">周二</option>
                <option :value="3">周三</option>
                <option :value="4">周四</option>
                <option :value="5">周五</option>
                <option :value="6">周六</option>
                <option :value="7">周日</option>
              </select>
            </div>
            <div class="form-group" v-if="editingReminder.type === 'once'">
              <label>日期</label>
              <input type="date" class="form-control" v-model="editingReminder.date">
            </div>
            <div class="form-group" v-if="editingReminder.type === 'monthly'">
              <label>几号</label>
              <input type="number" class="form-control" v-model.number="editingReminder.day_of_month" min="1" max="31" placeholder="1-31">
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showReminderModal = false">取消</button>
          <button class="btn btn-danger" v-if="isEditingReminder" @click="openDeleteModal(editingReminder.id)">删除</button>
          <button class="btn btn-primary" @click="saveReminder">保存</button>
        </div>
      </div>
    </div>

    <!-- 删除确认模态框 -->
    <div v-if="showDeleteModal" class="modal-overlay" @click="showDeleteModal = false">
      <div class="modal-box" style="width:400px;" @click.stop>
        <div class="modal-header">
          <h3>确认删除</h3>
          <button class="icon-btn" @click="showDeleteModal = false"><AppIcon name="x" :size="14" /></button>
        </div>
        <div class="modal-body">
          <p class="del-tip">确定要删除吗？此操作不可撤销。</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showDeleteModal = false">取消</button>
          <button class="btn btn-danger" @click="confirmDelete">删除</button>
        </div>
      </div>
    </div>

    <!-- 工单表单弹窗 -->
    <TicketFormModal
      :show="showTicketModal"
      :editing-id="editingTicketId"
      :initial="editingTicketInitial"
      @close="showTicketModal = false"
    />

    <!-- 工单设置弹窗（类型/来源/状态枚举与自定义字段管理） -->
    <TicketSettingsModal :show="showTicketSettings" @close="showTicketSettings = false" />

    <!-- 状态快捷切换菜单 -->
    <div
      v-if="statusMenu.open"
      class="status-pop"
      :style="{ left: statusMenu.x + 'px', top: statusMenu.y + 'px' }"
      @click.stop
    >
      <div class="status-pop-head">切换状态</div>
      <button
        v-for="s in statusOptions"
        :key="s"
        class="status-pop-item"
        :class="{ current: s === (statusMenu.ticket && statusMenu.ticket['状态']) }"
        @click="pickStatus(s)"
      >
        <span class="ticket-dot" :class="statusTone(s)"></span>
        <span class="status-pop-label">{{ s }}</span>
        <AppIcon v-if="s === (statusMenu.ticket && statusMenu.ticket['状态'])" name="check" :size="12" />
      </button>
    </div>

    <!-- 流转确认弹窗（快捷切状态 → 选处理节点 + 填处理结果，确认后状态/处理人/结果一次落库） -->
    <div v-if="handlerPick.open" class="hp-mask" @click.self="closeHandlerPick">
      <div class="handler-pick">
        <div class="status-pop-head">流转确认 · {{ handlerPick.status }}</div>
        <p class="hp-hint">「{{ handlerPick.ticket?.标题 || '(无标题)' }}」→「{{ handlerPick.status }}」。选择流转到的处理节点：换了节点（或建单后首次指派）会触发通知到该节点的 webhook。</p>
        <div class="hp-opts" v-if="enabledHandlerNodes.length">
          <button
            v-for="h in enabledHandlerNodes" :key="h.id"
            class="hp-opt" :class="{ sel: handlerPick.picked === h.name }"
            :title="h.webhook_url ? '已配 webhook：指派即通知' : '未配 webhook：指派后不通知'"
            @click="handlerPick.picked = handlerPick.picked === h.name ? '' : h.name"
          ><AppIcon name="user" :size="12" />{{ h.name }}<em v-if="h.webhook_url">🔔</em></button>
        </div>
        <p class="hp-note" v-else>还没有启用的处理人节点：可直接手输名字（通知走全局兜底 webhook），或在「工单设置 → 处理人节点」里配置。</p>
        <input
          v-model="handlerPick.picked"
          class="hp-input" type="text"
          placeholder="点上面节点快选；留空则保持当前处理人…"
          @keyup.enter="confirmHandlerPick"
        >
        <input
          v-model="handlerPick.result"
          class="hp-input hp-result" type="text"
          placeholder="处理结果（可留空）：这一步做了什么、结论…"
          @keyup.enter="confirmHandlerPick"
        >
        <div class="hp-foot">
          <button class="btn btn-secondary btn-sm" @click="closeHandlerPick">取消</button>
          <button class="btn btn-primary btn-sm" @click="confirmHandlerPick">确认流转</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 事项页（ItemsView）：待办 + 工单 + 定时提醒三合一。
 *
 * 融合逻辑：待办（plan_todos）与工单（工单数据集）混排成一条统一时间线，
 * 按逾期/今天/稍后分组——分组只看各自的到期日（待办 scheduled_start，工单承诺时间），
 * 同组内待办在前、工单在后。定时提醒保持卡片网格收在页尾。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import TicketFormModal from '@/components/TicketFormModal.vue';
import TicketSettingsModal from '@/components/TicketSettingsModal.vue';
import { useTickets, isClosed, promiseOf, promiseDateOf, todayStr } from '@/composables/useTickets';

const API = window.electronAPI;

// ========== 待办 ==========
interface Todo {
  id: number;
  title: string;
  status: string;
  priority: string;
  due_date?: string;
  scheduled_start?: string;
}
const todos = ref<Todo[]>([]);
const newTodoTitle = ref('');
const newTodoDate = ref('');
const showDone = ref(false);
const today = todayStr();

function todoDue(t: Todo): string {
  return (t.due_date || (t.scheduled_start || '').slice(0, 10) || '').trim();
}

async function loadTodos() {
  try { todos.value = await API.todo.list(); } catch { todos.value = []; }
}

async function addTodo() {
  const title = newTodoTitle.value.trim();
  if (!title) return;
  try {
    await API.todo.add({
      title,
      status: 'pending',
      priority: 'mid',
      scheduled_start: newTodoDate.value ? newTodoDate.value + ' 09:00' : '',
    });
    newTodoTitle.value = '';
    newTodoDate.value = '';
    await loadTodos();
  } catch (e: any) { alert('添加失败: ' + (e?.message || e)); }
}

async function toggleTodo(t: Todo) {
  const next = t.status === 'done' ? 'pending' : 'done';
  try {
    await API.todo.update(t.id, { status: next });
    t.status = next;
  } catch {}
}

async function removeTodo(t: Todo) {
  if (!confirm('删除待办「' + t.title + '」？')) return;
  try {
    await API.todo.remove(t.id);
    await loadTodos();
  } catch {}
}

// ========== 工单（数据在 useTickets 单例里） ==========
const { tickets, init: initTickets, remove: removeTicketById, setStatus, statusOptions, handlers, loadHandlers, linkedCountsMap, linkedTodos, loadLinkedTodos, toggleTodo: toggleLinkedTodo } = useTickets();

const showTicketModal = ref(false);
const showTicketSettings = ref(false);
const editingTicketId = ref<number | null>(null);
const editingTicketInitial = ref<Record<string, any> | null>(null);

const openTicketCount = computed(() => tickets.value.filter(t => !isClosed(t['状态'])).length);

function openTicketCreate(): void {
  editingTicketId.value = null;
  editingTicketInitial.value = null;
  showTicketModal.value = true;
}
function openTicketEdit(t: any): void {
  editingTicketId.value = t.id;
  editingTicketInitial.value = t;
  showTicketModal.value = true;
}
function removeTicket(t: any): void { void removeTicketById(t); }

/** 工单关联的待办数（卡片上显示 🔗 N） */
function linkedCount(id: number): number {
  return Number(linkedCountsMap.value[String(id)] || 0);
}

// ========== 状态快捷切换 ==========
const statusMenu = ref<{ open: boolean; ticket: any; x: number; y: number }>({ open: false, ticket: null, x: 0, y: 0 });

/** 在徽章下方弹出状态菜单（贴边时改为向上弹） */
function openStatusMenu(e: MouseEvent, t: any): void {
  const el = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const h = statusOptions.value.length * 28 + 40;
  const below = el.bottom + 4;
  const flip = below + h > window.innerHeight - 8;
  statusMenu.value = {
    open: true,
    ticket: t,
    x: Math.max(8, Math.min(el.left, window.innerWidth - 190)),
    y: flip ? Math.max(8, el.top - h - 4) : below,
  };
}
function closeStatusMenu(): void {
  if (statusMenu.value.open) statusMenu.value = { ...statusMenu.value, open: false };
}
/** 选中状态 → 走统一保存通道（主进程记流水 + 触发终态联动）；处理人为空先弹必选 */
async function pickStatus(s: string): Promise<void> {
  const t = statusMenu.value.ticket;
  closeStatusMenu();
  if (t) await changeStatusWithHandler(t, s);
}

/**
 * 快捷推进：一键把工单推到流转链上的下一个状态。
 * 待处理 → 处理中 →（自定义流转态…）→ 已完成；终态按钮变成 ↩ 打回处理中。
 * 同样受「处理人必选」约束（见 changeStatusWithHandler）：为空时先弹选人再切。
 */
const NEXT_FALLBACK: Record<string, string> = { '待处理': '处理中' };
function nextStatusOf(t: any): string {
  const cur = String(t['状态'] || '待处理').trim();
  const list = statusOptions.value;               // 已按流转顺序排好
  const i = list.indexOf(cur);
  for (let j = i + 1; j < list.length; j++) {
    const s = list[j];
    if (!isClosed(s)) return s;                    // 顺序里第一个非终态
  }
  return NEXT_FALLBACK[cur] || '处理中';
}
function advanceLabel(t: any): string {
  const cur = String(t['状态'] || '待处理').trim();
  if (isClosed(cur)) return '↩ 重新打开';
  return `→ ${nextStatusOf(t)}`;
}
async function advanceStatus(t: any): Promise<void> {
  const cur = String(t['状态'] || '待处理').trim();
  const target = isClosed(cur) ? '处理中' : nextStatusOf(t);
  await changeStatusWithHandler(t, target);
}

// ========== 流转确认（快捷切状态：选处理节点 + 处理结果，确认后一次落库） ==========
const handlerPick = ref<{ open: boolean; ticket: any; status: string; picked: string; result: string }>({ open: false, ticket: null, status: '', picked: '', result: '' });
/** 启用中的处理人节点（弹窗里的快选项） */
const enabledHandlerNodes = computed(() => handlers.value.filter((h: any) => h && Number(h.enabled) === 1));

/**
 * 快捷切状态统一入口（下拉菜单 pickStatus / 一键推进 advanceStatus 都走这里）。
 * 每次状态变更都弹「流转确认」：选处理节点（默认带出当前处理人）+ 填处理结果，
 * 确认后状态+处理人+结果合并一次落库 → 钩子开关节点；若换了处理节点即触发
 * 指派通知到该节点的 webhook。
 */
async function changeStatusWithHandler(t: any, status: string): Promise<void> {
  if (!t || !status || String(t['状态'] || '') === status) return;
  handlerPick.value = { open: true, ticket: t, status, picked: String(t['处理人'] || '').trim(), result: '' };
}
function closeHandlerPick(): void {
  if (handlerPick.value.open) handlerPick.value = { open: false, ticket: null, status: '', picked: '', result: '' };
}
/** 确认流转：处理节点（可留空）+ 处理结果（可留空）+ 状态一次保存 */
async function confirmHandlerPick(): Promise<void> {
  const { ticket: t, status, picked, result } = handlerPick.value;
  if (!t) return;
  const name = picked.trim();
  const res = result.trim();
  closeHandlerPick();
  await setStatus(t, status, { handler: name || undefined, result: res || undefined });
}

/** 卡片上的关联待办（点 🔗 展开勾选） */
const expandedTodos = ref<Set<number>>(new Set());
function toggleExpand(id: number): void {
  const s = new Set(expandedTodos.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  expandedTodos.value = s;
  if (s.has(id)) void loadLinkedTodos({ id } as any);
}
/** 模板里给 expand 用的对象包装（避免每行拼对象） */
function ticketRef(id: number): any { return { id }; }
async function flipLinkedTodo(t: any, td: any): Promise<void> {
  await toggleLinkedTodo(t, td.id, td.status !== 'done');
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { closeStatusMenu(); closeHandlerPick(); }
}

function isDueSoon(t: any): boolean {
  const v = promiseOf(t);
  if (!v || isClosed(t['状态'])) return false;
  const ts = Date.parse(v.replace(' ', 'T'));
  if (isNaN(ts)) return false;
  return ts - Date.now() <= 24 * 3600 * 1000;
}
function fmtPromise(t: any): string {
  return promiseOf(t).replace('T', ' ').slice(0, 16);
}
function statusTone(s?: string): string {
  const v = String(s || '').trim();
  if (v === '已完成') return 'green';       // 正向完结
  if (isClosed(v)) return 'gray';           // 已关闭 / 自定义终态
  if (v === '处理中') return 'blue';
  return 'amber';                            // 待处理 / 自定义流转态
}
function truncate(s: any, n: number): string {
  const v = String(s || '').replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n) + '…' : v;
}

// ========== 统一时间线 ==========
interface Section { key: string; label: string; items: any[]; todos: Todo[]; tickets: any[]; empty: string; }

const openTodos = computed(() => todos.value.filter(t => t.status !== 'done'));
const openTodoCount = computed(() => openTodos.value.length);

const timeline = computed<Section[]>(() => {
  const todoPool = showDone.value ? todos.value : openTodos.value;
  // 工单：显示已完成的待办时，也带上已关闭的工单；平时只显示未关闭
  const ticketPool = showDone.value ? tickets.value : tickets.value.filter(t => !isClosed(t['状态']));

  const overdueTodos: Todo[] = []; const todayTodos: Todo[] = []; const laterTodos: Todo[] = []; const doneTodos: Todo[] = [];
  for (const t of todoPool) {
    if (t.status === 'done') { doneTodos.push(t); continue; }
    const due = todoDue(t);
    if (due && due < today) overdueTodos.push(t);
    else if (due && due === today) todayTodos.push(t);
    else laterTodos.push(t);
  }
  const overdueTickets: any[] = []; const todayTickets: any[] = []; const laterTickets: any[] = []; const doneTickets: any[] = [];
  for (const t of ticketPool) {
    if (isClosed(t['状态'])) { doneTickets.push(t); continue; }
    const due = promiseDateOf(t);
    if (due && due < today) overdueTickets.push(t);
    else if (due && due === today) todayTickets.push(t);
    else laterTickets.push(t);
  }

  const secs: Section[] = [
    { key: 'overdue', label: '逾期', items: [...overdueTodos, ...overdueTickets], todos: overdueTodos, tickets: overdueTickets, empty: '没有逾期事项' },
    { key: 'today', label: '今天', items: [...todayTodos, ...todayTickets], todos: todayTodos, tickets: todayTickets, empty: '今天没有到期事项' },
    { key: 'later', label: '稍后', items: [...laterTodos, ...laterTickets], todos: laterTodos, tickets: laterTickets, empty: '没有待办或工单，用上方输入框添加' },
  ];
  if (showDone.value) secs.push({ key: 'done', label: '已完成', items: [...doneTodos, ...doneTickets], todos: doneTodos, tickets: doneTickets, empty: '暂无已完成' });
  return secs;
});

// ========== 提醒 ==========
interface Reminder {
  id: string; name: string; message: string; type: string; time: string; date: string;
  day_of_week: number; day_of_month: number; month_day: string; enabled: boolean; created_at: string;
}
const reminders = ref<Reminder[]>([]);
const enabledCount = computed(() => reminders.value.filter(r => r.enabled).length);

async function loadReminders() {
  try { reminders.value = await API.reminder.list(); } catch { reminders.value = []; }
}

const showReminderModal = ref(false);
const isEditingReminder = ref(false);
const editingReminder = ref<Reminder>({
  id: '', name: '', message: '', type: 'daily', time: '09:00',
  date: '', day_of_week: 1, day_of_month: 1,
  month_day: '', enabled: true, created_at: ''
});

function createReminder() {
  isEditingReminder.value = false;
  editingReminder.value = {
    id: '', name: '', message: '', type: 'daily', time: '09:00',
    date: '', day_of_week: 1, day_of_month: 1,
    month_day: '', enabled: true, created_at: ''
  };
  showReminderModal.value = true;
}

function editReminder(reminder: Reminder) {
  isEditingReminder.value = true;
  editingReminder.value = { ...reminder };
  showReminderModal.value = true;
}

async function saveReminder() {
  if (!editingReminder.value.name.trim()) { alert('请输入提醒名称'); return; }
  const d = editingReminder.value;
  const data = {
    name: d.name, message: d.message, type: d.type, time: d.time,
    day_of_week: d.type === 'weekly' ? d.day_of_week : 0,
    day_of_month: d.type === 'monthly' ? d.day_of_month : 1,
    month_day: d.type === 'yearly' ? d.month_day : '',
    date: d.type === 'once' ? d.date : '',
  };
  try {
    if (isEditingReminder.value) await API.reminder.update(d.id, data);
    else await API.reminder.add(data);
    showReminderModal.value = false;
    await loadReminders();
  } catch (e: any) { alert('操作失败: ' + (e.message || e)); }
}

async function toggleReminder(reminder: Reminder) {
  try {
    await API.reminder.setEnabled(reminder.id, !reminder.enabled);
    reminder.enabled = !reminder.enabled;
  } catch {}
}

async function testReminder(reminder: Reminder) {
  try {
    await API.reminder.test(reminder.id);
    alert('已触发「' + reminder.name + '」通知（系统通知 + 飞书如有配置）');
  } catch (e: any) { alert('触发失败: ' + (e.message || e)); }
}

const showDeleteModal = ref(false);
const deleteId = ref('');
function openDeleteModal(id: string) { deleteId.value = id; showDeleteModal.value = true; }
async function confirmDelete() {
  try {
    await API.reminder.remove(deleteId.value);
    await loadReminders();
  } catch {}
  showDeleteModal.value = false;
}

function getScheduleText(reminder: Reminder): string {
  const time = reminder.time || '09:00';
  switch (reminder.type) {
    case 'daily': return '每天 ' + time;
    case 'once': return '一次 ' + (reminder.date || '') + ' ' + time;
    case 'weekly': {
      const days = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      return '每周' + (days[reminder.day_of_week] || '周一') + ' ' + time;
    }
    case 'monthly': return '每月' + (reminder.day_of_month || 1) + '号 ' + time;
    case 'yearly': return '每年 ' + (reminder.month_day || '1月1日') + ' ' + time;
    default: return time;
  }
}

onMounted(() => {
  loadTodos();
  loadReminders();
  initTickets();
  loadHandlers();   // 处理人必选弹窗的快选项
  window.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<style scoped>
/* ========== 快速添加 ========== */
.quick-add {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  margin-bottom: 4px;
}
.quick-add > svg { color: var(--text-muted); flex-shrink: 0; }
.quick-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--text-primary);
}
.quick-input::placeholder { color: var(--text-muted); }
.quick-date {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  padding: 5px 8px;
}

/* ========== 统一时间线 ========== */
/* ========== 时间线卡片（与提醒卡同一套视觉语言） ========== */
.tl-sec-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 2px 8px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-muted);
}
.tl-sec-head.warm { color: var(--warning); }
.tl-sec-head .sec-count { margin-left: auto; font-weight: 400; }
.tl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
  /* 卡片按自身内容高度自适应：待办卡信息少，不被同行工单卡拉出大片空洞 */
  align-items: start;
}
.item-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 11px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: box-shadow 0.2s, border-color 0.2s;
}
.item-card:hover { box-shadow: var(--shadow-md); border-color: var(--text-muted); }
.ticket-card { cursor: pointer; }
.item-card.overdue { background: var(--danger-soft); border-color: var(--danger); }
.item-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.item-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-title.through { color: var(--text-muted); text-decoration: line-through; }
.item-card.done .item-title { color: var(--text-muted); text-decoration: line-through; }
.item-badges { display: flex; flex-wrap: wrap; gap: 5px; }
.item-desc {
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.item-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding-top: 7px;
  border-top: 1px dashed var(--border);
}
.badge { flex-shrink: 0; padding: 1px 8px; border-radius: 10px; font-size: 11px; }
.badge-gray { background: var(--surface-2); color: var(--text-muted); }
.badge-blue { background: var(--primary-soft); color: var(--primary); }
.badge-amber { background: var(--warning-soft, #fef3c7); color: var(--warning); }
.badge-green { background: var(--success-soft, #dcfce7); color: var(--success, #16a34a); }
/* 状态徽章可点 → 快捷切换状态 */
.badge-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid transparent;
  cursor: pointer;
  font-family: inherit;
  transition: box-shadow 0.15s, border-color 0.15s;
}
.badge-btn:hover { border-color: var(--text-muted); box-shadow: var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.12)); }
/* 快捷推进按钮：一键推到下一个状态 */
.advance-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-family: inherit;
  border: 1px dashed var(--border);
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.advance-btn:hover { color: var(--primary); border-color: var(--primary); background: var(--primary-soft); }
/* 🔗 关联数可点 → 展开卡片上的关联待办 */
.link-btn { cursor: pointer; border: none; font-family: inherit; }
.link-btn:hover { color: var(--primary); }
.card-todos {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.card-todo {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 0;
}
.card-todo > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-todo .through { color: var(--text-muted); text-decoration: line-through; }
.mini-box {
  width: 13px; height: 13px;
  border: 1.5px solid var(--text-muted);
  border-radius: 4px;
  background: none;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: #fff; flex-shrink: 0; padding: 0;
}
.mini-box:hover { border-color: var(--primary); }
.mini-box.done { background: var(--primary); border-color: var(--primary); }
.status-pop {
  position: fixed;
  z-index: 1200;
  min-width: 168px;
  padding: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
}
.status-pop-head {
  font-size: 11px;
  color: var(--text-muted);
  padding: 4px 8px 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.status-pop-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: none;
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: 12.5px;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}
.status-pop-item:hover { background: var(--primary-soft); }
.status-pop-item.current { color: var(--primary); font-weight: 600; }
.status-pop-label { flex: 1; min-width: 0; }

/* ========== 处理人必选弹窗 ========== */
.hp-mask {
  position: fixed; inset: 0; z-index: 1300;
  background: rgba(15, 22, 18, 0.32);
  display: flex; align-items: center; justify-content: center;
}
.handler-pick {
  width: 340px; max-width: calc(100vw - 48px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: 12px 14px;
}
.hp-hint { font-size: 12px; color: var(--text-secondary); line-height: 1.6; margin: 8px 0; }
.hp-opts { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.hp-opt {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px; font: inherit; font-size: 12px;
  border: 1px solid var(--border); border-radius: 999px;
  background: var(--surface); color: var(--text-primary); cursor: pointer;
}
.hp-opt:hover { border-color: var(--primary); color: var(--primary); }
.hp-opt.sel { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); font-weight: 600; }
.hp-opt em { font-style: normal; font-size: 11px; color: var(--text-muted); }
.hp-note { font-size: 12px; color: var(--text-muted); line-height: 1.6; margin: 4px 0 8px; }
.hp-input {
  width: 100%; padding: 6px 10px; font: inherit; font-size: 12.5px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--surface); color: var(--text-primary); outline: none;
}
.hp-input:focus { border-color: var(--primary); }
.hp-result { margin-top: 6px; }
.hp-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.ticket-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.ticket-dot.gray { background: var(--text-muted); opacity: 0.5; }
.ticket-dot.blue { background: var(--primary); }
.ticket-dot.amber { background: var(--warning); }
.ticket-dot.green { background: var(--success, #16a34a); }
.todo-box {
  width: 15px;
  height: 15px;
  border: 1.5px solid var(--text-muted);
  border-radius: 5px;
  background: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
  padding: 0;
}
.todo-box:hover { border-color: var(--primary); }
.todo-card.done .todo-box { background: var(--primary); border-color: var(--primary); }
.prio { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-muted); opacity: 0.6; }
.prio.high { background: var(--danger); opacity: 1; }
.prio.mid { background: var(--warning); opacity: 1; }
.prio.low { background: var(--success); opacity: 1; }
.kind-tag {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 9px;
  background: var(--primary-soft);
  color: var(--primary);
}
.kind-tag-dim { background: var(--surface-2); color: var(--text-muted); }
.todo-dt {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.todo-dt.warm { color: var(--warning); font-weight: 600; }
.row-del {
  width: 24px;
  height: 24px;
  border: none;
  background: none;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}
.item-card:hover .row-del, .reminder-card:hover .row-del { opacity: 1; }
.row-del:hover { color: var(--danger); background: var(--danger-soft); }
.empty-row {
  font-size: 12px;
  color: var(--text-muted);
  padding: 14px;
  margin-bottom: 14px;
  text-align: center;
  border: 1px dashed var(--border);
  border-radius: var(--radius-md);
}

/* ========== 提醒卡片 ========== */
.reminder-grid-wrap { min-height: 120px; }
.reminder-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 12px;
}
.reminder-card {
  padding: 14px;
  cursor: pointer;
  transition: box-shadow 0.2s, border-color 0.2s;
}
.reminder-card:hover { box-shadow: var(--shadow-md); border-color: var(--text-muted); }
.reminder-card.disabled { opacity: 0.55; }
.reminder-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.reminder-name { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
.reminder-toggle {
  width: 36px;
  height: 20px;
  border-radius: 11px;
  background: var(--border);
  cursor: pointer;
  position: relative;
  transition: all 0.2s;
  flex-shrink: 0;
}
.reminder-toggle.on { background: var(--primary); }
.reminder-toggle::after {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--surface);
  top: 2px;
  left: 2px;
  transition: all 0.2s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}
.reminder-toggle.on::after { left: 18px; }
.reminder-message {
  font-size: 12.5px;
  color: var(--text-secondary);
  margin-bottom: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reminder-schedule {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 10px;
}
.reminder-ops { display: flex; align-items: center; justify-content: space-between; }
.test-btn { padding: 4px 10px; font-size: 12px; }
.empty-panel {
  padding: 36px 20px;
  text-align: center;
  color: var(--text-muted);
}
.empty-panel svg { color: var(--text-muted); opacity: 0.6; }
.empty-panel p { font-size: 13px; margin-top: 10px; }

/* ========== 模态框 ========== */
.modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}
.modal-box {
  background: var(--surface);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  max-width: 90%;
  max-height: 90vh;
  overflow-y: auto;
  width: 520px;
}
.modal-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.modal-header h3 { font-size: 16px; font-weight: 600; }
.modal-body { padding: 20px; }
.modal-footer {
  padding: 16px 20px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.del-tip { color: var(--text-secondary); font-size: 13px; }
.form-group { margin-bottom: 16px; }
.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.form-row { display: flex; gap: 12px; }
.form-row .form-group { flex: 1; }
textarea.form-control { resize: vertical; min-height: 80px; }
select.form-control { cursor: pointer; }
.icon-btn { background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 4px; }
</style>
