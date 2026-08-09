<template>
  <div class="reminders-view">
    <div class="content-header">
      <h1 class="content-title">提醒</h1>
      <button class="btn btn-primary btn-sm" @click="createReminder">新建提醒</button>
    </div>

    <div class="content-body">
      <div class="card">
        <div class="card-header">
          <h3 class="card-title">全部提醒</h3>
          <span class="card-subtitle">已启用 {{ enabledCount }} / {{ reminders.length }} 条</span>
        </div>

        <div v-if="reminders.length === 0" class="empty-state">
          <div class="empty-icon">⏰</div>
          <div class="empty-text">还没有提醒，点击右上角「新建提醒」创建一条</div>
        </div>

        <div v-else class="reminder-grid">
          <div
            v-for="reminder in reminders"
            :key="reminder.id"
            class="reminder-card"
            :class="{ disabled: !reminder.enabled }"
            @click="editReminder(reminder)"
          >
            <div class="reminder-header">
              <span class="reminder-name">{{ reminder.name }}</span>
              <div
                class="reminder-toggle"
                :class="{ on: reminder.enabled }"
                @click.stop="toggleReminder(reminder)"
              ></div>
            </div>
            <div class="reminder-message">{{ reminder.message }}</div>
            <div class="reminder-schedule">⏰ {{ getScheduleText(reminder) }}</div>
            <button class="btn btn-secondary btn-xs test-btn" @click.stop="testReminder(reminder)">测试触发</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 提醒编辑模态框 -->
    <div v-if="showReminderModal" class="modal-overlay" @click="showReminderModal = false">
      <div class="modal-box" @click.stop>
        <div class="modal-header">
          <h3>{{ isEditingReminder ? '编辑提醒' : '新建提醒' }}</h3>
          <button class="btn btn-secondary" @click="showReminderModal = false">✕</button>
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
              <option value="daily">📅 每天 - 每天定时提醒</option>
              <option value="once">🔔 一次 - 指定日期提醒</option>
              <option value="weekly">📆 每周 - 每周特定星期几提醒</option>
              <option value="monthly">📅 每月 - 每月特定几号提醒</option>
              <option value="yearly">🎂 每年 - 每年特定日期提醒</option>
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
          <button class="btn btn-danger" v-if="isEditingReminder" @click="openDeleteModal(editingReminder.id)">🗑️ 删除</button>
          <button class="btn btn-primary" @click="saveReminder">保存</button>
        </div>
      </div>
    </div>

    <!-- 删除确认模态框 -->
    <div v-if="showDeleteModal" class="modal-overlay" @click="showDeleteModal = false">
      <div class="modal-box" style="width:400px;" @click.stop>
        <div class="modal-header">
          <h3>确认删除</h3>
          <button class="btn btn-secondary" @click="showDeleteModal = false">✕</button>
        </div>
        <div class="modal-body">
          <p style="color:#94a3b8;font-size:13px;">确定要删除吗？此操作不可撤销。</p>
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

const reminders = ref<Reminder[]>([]);
const enabledCount = computed(() => reminders.value.filter(r => r.enabled).length);

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
    case 'weekly':
      const days = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
      return '每周' + (days[reminder.day_of_week] || '周一') + ' ' + time;
    case 'monthly': return '每月' + (reminder.day_of_month || 1) + '号 ' + time;
    case 'yearly': return '每年 ' + (reminder.month_day || '1月1日') + ' ' + time;
    default: return time;
  }
}

onMounted(loadReminders);
</script>

<style scoped>
.reminders-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.content-header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  background: white;
}

.content-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.content-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.card {
  background: white;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  padding: 24px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.card-subtitle {
  font-size: 12px;
  color: var(--text-muted);
}

.empty-state {
  text-align: center;
  padding: 48px 0;
}

.empty-icon {
  font-size: 40px;
  margin-bottom: 12px;
}

.empty-text {
  font-size: 14px;
  color: var(--text-muted);
}

.reminder-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}

.reminder-card {
  background: white;
  border-radius: var(--radius-md);
  padding: 16px;
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all 0.2s;
}

.reminder-card:hover {
  box-shadow: var(--shadow-md);
}

.reminder-card.disabled {
  opacity: 0.55;
}

.reminder-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.reminder-name {
  font-size: 14px;
  font-weight: 600;
}

.reminder-toggle {
  width: 40px;
  height: 22px;
  border-radius: 11px;
  background: #e2e8f0;
  cursor: pointer;
  position: relative;
  transition: all 0.2s;
  flex-shrink: 0;
}

.reminder-toggle.on {
  background: var(--primary);
}

.reminder-toggle::after {
  content: '';
  position: absolute;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: white;
  top: 2px;
  left: 2px;
  transition: all 0.2s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.reminder-toggle.on::after {
  left: 20px;
}

.reminder-message {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.reminder-schedule {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 12px;
}

.test-btn {
  padding: 4px 10px;
  font-size: 12px;
}

/* 模态框 */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.modal-box {
  background: white;
  border-radius: var(--radius-md);
  box-shadow: 0 10px 25px rgba(0,0,0,0.1);
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

.modal-header h3 {
  font-size: 16px;
  font-weight: 600;
}

.modal-body {
  padding: 20px;
}

.modal-footer {
  padding: 16px 20px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.form-control {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 14px;
  outline: none;
  background: white;
}

.form-control:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(99,102,241,0.1);
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-row .form-group {
  flex: 1;
}

textarea.form-control {
  resize: vertical;
  min-height: 80px;
}

select.form-control {
  cursor: pointer;
}
</style>
