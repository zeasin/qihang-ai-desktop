<template>
  <div class="page todo-view">
    <header class="page-head">
      <div>
        <h1 class="page-title">待办</h1>
        <p class="page-sub">需要你动手的事：本地待办与定时提醒都在这里，也可交给引擎执行。</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-sm btn-secondary" @click="toggleDoneShow">{{ showDone ? '隐藏已完成' : '显示已完成' }}</button>
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

    <!-- ========== 待办清单 ========== -->
    <div class="sec-label"><AppIcon name="list-checks" :size="13" />待办清单<em>{{ openTodoCount }} 项未完成</em></div>
    <section class="panel">
      <template v-for="sec in todoSections" :key="sec.key">
        <div class="sec-row" :class="{ warm: sec.key === 'overdue' }">
          <AppIcon :name="sec.key === 'overdue' ? 'clock' : 'list-checks'" :size="12" />{{ sec.label }}
          <span class="sec-count">{{ sec.items.length }}</span>
        </div>
        <div v-for="t in sec.items" :key="t.id" class="todo-row" :class="{ done: t.status === 'done', overdue: sec.key === 'overdue' }">
          <button class="todo-box" :title="t.status === 'done' ? '标记为未完成' : '标记完成'" @click="toggleTodo(t)">
            <AppIcon v-if="t.status === 'done'" name="check" :size="11" />
          </button>
          <span class="prio" :class="t.priority"></span>
          <span class="todo-tx">{{ t.title }}</span>
          <span v-if="todoDue(t)" class="todo-dt" :class="{ warm: sec.key === 'overdue' }">{{ todoDue(t) }}</span>
          <button class="row-del" title="删除待办" @click="removeTodo(t)"><AppIcon name="trash-2" :size="13" /></button>
        </div>
        <div v-if="!sec.items.length" class="empty-row">{{ sec.empty }}</div>
      </template>
    </section>

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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import AppIcon from '@/components/AppIcon.vue';

const API = window.electronAPI;

interface Reminder {
  id: string;
  name: string;
  message: string;
  type: string;
  time: string;
  date: string;
  day_of_week: number;
  day_of_month: number;
  month_day: string;
  enabled: boolean;
  created_at: string;
}

// ========== 提醒 ==========
const reminders = ref<Reminder[]>([]);
const enabledCount = computed(() => reminders.value.filter(r => r.enabled).length);

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
const todayStr = (() => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
})();

function todoDue(t: Todo): string {
  return (t.due_date || (t.scheduled_start || '').slice(0, 10) || '').trim();
}

const openTodos = computed(() => todos.value.filter(t => t.status !== 'done'));
const openTodoCount = computed(() => openTodos.value.length);

const todoSections = computed(() => {
  const pool = showDone.value ? todos.value : openTodos.value;
  const overdue: Todo[] = [];
  const today: Todo[] = [];
  const later: Todo[] = [];
  const done: Todo[] = [];
  for (const t of pool) {
    if (t.status === 'done') { done.push(t); continue; }
    const due = todoDue(t);
    if (due && due < todayStr) overdue.push(t);
    else if (due && due === todayStr) today.push(t);
    else later.push(t);
  }
  const secs = [
    { key: 'overdue', label: '逾期', items: overdue, empty: '没有逾期事项' },
    { key: 'today', label: '今天', items: today, empty: '今天没有到期事项' },
    { key: 'later', label: '稍后', items: later, empty: '没有待办，用上方输入框添加一条' },
  ];
  if (showDone.value) secs.push({ key: 'done', label: '已完成', items: done, empty: '暂无已完成' });
  return secs;
});

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

// ========== 模态框状态 ==========
const showReminderModal = ref(false);
const isEditingReminder = ref(false);
const editingReminder = ref<Reminder>({
  id: '', name: '', message: '', type: 'daily', time: '09:00',
  date: '', day_of_week: 1, day_of_month: 1,
  month_day: '', enabled: true, created_at: ''
});

const showDeleteModal = ref(false);
const deleteId = ref('');

// ========== 提醒 CRUD ==========
async function loadReminders() {
  try { reminders.value = await API.reminder.list(); } catch { reminders.value = []; }
}

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
  if (!editingReminder.value.name.trim()) {
    alert('请输入提醒名称');
    return;
  }
  const data = {
    name: editingReminder.value.name,
    message: editingReminder.value.message,
    type: editingReminder.value.type,
    time: editingReminder.value.time,
    day_of_week: editingReminder.value.type === 'weekly' ? editingReminder.value.day_of_week : 0,
    day_of_month: editingReminder.value.type === 'monthly' ? editingReminder.value.day_of_month : 1,
    month_day: editingReminder.value.type === 'yearly' ? editingReminder.value.month_day : '',
  };
  try {
    if (isEditingReminder.value) {
      await API.reminder.update(editingReminder.value.id, data);
    } else {
      await API.reminder.add(data);
    }
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

// ========== 删除确认 ==========
function openDeleteModal(id: string) {
  deleteId.value = id;
  showDeleteModal.value = true;
}

async function confirmDelete() {
  try {
    await API.reminder.remove(deleteId.value);
    await loadReminders();
  } catch {}
  showDeleteModal.value = false;
}

// ========== 工具函数 ==========
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

function toggleDoneShow() {
  showDone.value = !showDone.value;
}

onMounted(() => {
  loadReminders();
  loadTodos();
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

/* ========== 待办清单 ========== */
.sec-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--surface-2);
  border-top: 1px solid var(--border);
}
.sec-row:first-child { border-top: none; }
.sec-row.warm { color: var(--warning); }
.sec-count { margin-left: auto; font-weight: 400; }
.todo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
}
.todo-row:hover { background: var(--primary-soft); }
.todo-row:first-of-type { border-top: none; }
.todo-row.done .todo-tx { color: var(--text-muted); text-decoration: line-through; }
.todo-row.overdue { background: var(--danger-soft); }
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
.todo-row.done .todo-box { background: var(--primary); border-color: var(--primary); }
.prio { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-muted); opacity: 0.6; }
.prio.high { background: var(--danger); opacity: 1; }
.prio.mid { background: var(--warning); opacity: 1; }
.prio.low { background: var(--success); opacity: 1; }
.todo-tx { flex: 1; min-width: 0; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-dt { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
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
.todo-row:hover .row-del, .reminder-card:hover .row-del { opacity: 1; }
.row-del:hover { color: var(--danger); background: var(--danger-soft); }
.empty-row { font-size: 12px; color: var(--text-muted); padding: 13px 14px; text-align: center; }

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
</style>
