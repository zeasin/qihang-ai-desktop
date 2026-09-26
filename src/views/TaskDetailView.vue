<template>
  <div class="task-detail-view">
    <!-- 未配置笔记库：AI 功能门禁 -->
    <NotesGate v-if="notesLoaded && !notesDir" @ready="loadNotesDir" />

    <div v-if="!notesLoaded || notesDir" class="content-header">
      <button class="btn btn-secondary btn-sm" @click="$router.push('/planner')">← 返回任务中心</button>
      <div class="header-actions">
        <span v-if="task" :class="['status-badge', 'status-' + task.status]">{{ statusText(task.status) }}</span>
        <span v-if="task && task.last_status === 'FAILED'" class="status-badge status-FAILED">执行失败</span>
        <button v-if="task && task.trigger_type !== 'now'" class="btn btn-primary btn-sm" :disabled="task.status === 'in_progress' || task.followupRunning" @click="runTask">▶ 立即执行</button>
        <button v-if="task && task.trigger_type !== 'now'" class="btn btn-secondary btn-sm" :disabled="isFeishuTask || hasBeenExecuted" @click="editTask">编辑</button>
        <button class="btn btn-danger btn-sm" @click="openDeleteModal">删除</button>
      </div>
    </div>

    <div v-if="(!notesLoaded || notesDir) && !task" class="content-body">
      <div class="empty-state">加载中...</div>
    </div>

    <div v-else-if="!notesLoaded || notesDir" class="content-body">
      <!-- 基本信息 -->
      <div class="detail-section">
        <h3 class="section-title">基本信息</h3>
        <div class="info-grid">
          <div class="info-item">
            <span class="info-label">标题</span>
            <span class="info-value">{{ task.title }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">任务类型</span>
            <span class="info-value">📚 知识</span>
          </div>
          <div class="info-item">
            <span class="info-label">归属项目</span>
            <span class="info-value">{{ projectName || '未关联' }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">触发方式</span>
            <span class="info-value">{{ getTriggerText(task) }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">创建时间</span>
            <span class="info-value">{{ task.created_at || '-' }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">最近执行</span>
            <span class="info-value">{{ task.last_run_at || '-' }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">最近状态</span>
            <span class="info-value">{{ task.last_status === 'SUCCESS' ? '✅ 成功' : task.last_status === 'FAILED' ? '❌ 失败' : task.last_status || '-' }}</span>
          </div>
          <div class="info-item" v-if="task.output_target">
            <span class="info-label">输出路径</span>
            <span class="info-value">{{ task.output_target }}</span>
          </div>
        </div>
      </div>

      <!-- 对话记录 -->
      <div class="detail-section">
        <h3 class="section-title">对话记录</h3>
        <div v-if="messages.length === 0" class="empty-sub">暂无对话记录</div>
        <div v-for="(msg, idx) in messages" :key="idx" class="message" :class="msg.role">
          <div class="message-avatar">
            <span v-if="msg.role === 'user'">👤</span>
            <span v-else-if="msg.role === 'assistant'">🤖</span>
            <span v-else>🔧</span>
          </div>
          <div class="message-body">
            <div class="message-header">
              <span class="message-role">{{ msg.role === 'user' ? '我' : msg.role === 'assistant' ? 'AI 助理' : msg.role === 'tool' ? '工具' : '系统' }}</span>
            </div>
            <div class="message-content" :class="{ 'markdown-body': msg.role === 'assistant' }">
              <div v-html="msg.role === 'user' ? formatUserMessage(msg.content) : renderMarkdown(msg.content)"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 执行记录 -->
      <div v-if="task && task.trigger_type !== 'now'" class="detail-section">
        <h3 class="section-title">执行记录</h3>
        <div v-if="!executions || executions.length === 0" class="empty-sub">暂无执行记录</div>
        <div v-for="ex in executions" :key="ex.id" class="execution-card">
          <div class="exec-header">
            <span :class="['status-badge', 'status-' + ex.status]">{{ ex.status }}</span>
            <span class="exec-trigger">{{ triggerLabel(ex.trigger_type) }}</span>
            <span class="exec-time">{{ ex.start_time }}</span>
            <span v-if="ex.end_time" class="exec-time">→ {{ ex.end_time }}</span>
          </div>
          <div v-if="ex.error_message" class="exec-error">❌ {{ ex.error_message }}</div>
          <div v-if="ex.result_text" class="exec-result markdown-body" v-html="renderMarkdown(ex.result_text)"></div>
        </div>
      </div>

      <!-- 追问 -->
      <div class="detail-section">
        <h3 class="section-title">追问</h3>
        <div v-if="task.followupDone" class="followup-reply markdown-body" v-html="renderMarkdown(task.followupReply)"></div>
        <div v-if="task.followupRunning" class="followup-reply markdown-body" v-html="renderMarkdown(task.followupReply)"></div>
        <div class="followup-toolbar">
          <select class="model-selector" v-model="runtime" :disabled="task.followupRunning" title="AI 引擎" @change="onRuntimeChange">
            <option value="pi">pi 引擎</option>
            <option value="opencode">opencode</option>
          </select>
          <select class="model-selector" v-model="selectedModel" :disabled="task.followupRunning" title="选择模型">
            <option value="">默认模型</option>
            <option v-for="m in followupModels" :key="m.pattern" :value="m.pattern">{{ m.providerLabel }} · {{ m.name }}</option>
          </select>
          <span v-if="runtime === 'opencode'" class="followup-engine-hint">opencode 引擎暂无本地工具，追问为纯对话</span>
        </div>
        <div class="followup-input-row">
          <textarea
            v-model="task.followupText"
            class="followup-input"
            rows="2"
            placeholder="输入追问内容，将沿用该任务的原对话上下文继续执行…"
            @keydown.enter.exact.prevent="sendFollowup"
          ></textarea>
          <button class="btn btn-primary btn-sm" :disabled="!(task.followupText || '').trim() || task.followupRunning" @click="sendFollowup">{{ task.followupRunning ? '执行中…' : '发送' }}</button>
        </div>
      </div>
    </div>

    <!-- 编辑模态框 -->
    <div v-if="showTaskModal" class="modal-overlay" @click="showTaskModal = false">
      <div class="modal-box modal-box-lg" @click.stop>
        <div class="modal-header">
          <h3>编辑任务</h3>
          <button class="btn btn-secondary" @click="showTaskModal = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>归属项目 *</label>
            <select class="form-control" v-model="editing.project_id" disabled>
              <option :value="null" disabled>请选择项目</option>
              <optgroup label="📚 笔记库">
                <option v-for="p in noteProjects" :key="p.id" :value="p.id">{{ p.name }}</option>
              </optgroup>
            </select>
          </div>
          <div class="form-group">
            <label>任务标题 *</label>
            <input type="text" class="form-control" v-model="editing.title" placeholder="例如：每日数据总结 / 整理本周笔记">
          </div>
          <div class="form-group">
            <label>任务诉求（AI 将据此执行）</label>
            <textarea class="form-control" v-model="editing.prompt" rows="4" placeholder="描述要让 AI 做什么"></textarea>
          </div>
          <div class="form-group">
            <label>执行方式</label>
            <select class="form-control" v-model="editing.trigger_type">
              <option value="now">⚡ 立即执行 - 创建后马上运行</option>
              <option value="once">⏰ 指定时间 - 到点执行一次</option>
              <option value="cycle">🔁 定时循环 - 按周期自动执行</option>
            </select>
          </div>
          <div class="form-row" v-if="editing.trigger_type === 'once'">
            <div class="form-group">
              <label>执行时间 *</label>
              <input type="datetime-local" class="form-control" v-model="editing.scheduled_start">
            </div>
          </div>
          <template v-if="editing.trigger_type === 'cycle'">
            <div class="form-row">
              <div class="form-group">
                <label>循环类型</label>
                <select class="form-control" v-model="editing.cycle_type">
                  <option value="daily">📅 每天</option>
                  <option value="weekly">📆 每周</option>
                  <option value="monthly">🗓️ 每月</option>
                  <option value="cron">⚙️ Cron 表达式</option>
                </select>
              </div>
              <div class="form-group" v-if="editing.cycle_type !== 'cron'">
                <label>执行时间</label>
                <input type="time" class="form-control" v-model="editing.cycle_time">
              </div>
            </div>
            <div class="form-group" v-if="editing.cycle_type === 'weekly'">
              <label>星期几（可多选）</label>
              <div class="week-select">
                <label v-for="d in weekDays" :key="d.value" class="week-chip">
                  <input type="checkbox" :value="d.value" v-model="editingWeekDays">
                  {{ d.label }}
                </label>
              </div>
            </div>
            <div class="form-group" v-if="editing.cycle_type === 'monthly'">
              <label>每月几号</label>
              <input type="number" class="form-control" v-model.number="editingMonthDays" min="1" max="31" placeholder="如 1 或 1,15">
            </div>
            <div class="form-group" v-if="editing.cycle_type === 'cron'">
              <label>Cron 表达式</label>
              <input type="text" class="form-control" v-model="editing.cycle_value" placeholder="如 0 9 * * *（每天早上 9 点）">
            </div>
          </template>
          <div class="form-row">
            <div class="form-group">
              <label>结果保存位置（相对笔记库，留空自动保存）</label>
              <input type="text" class="form-control" v-model="editing.output_target" placeholder="如 任务输出/日报.md">
            </div>
            <div class="form-group">
              <label>&nbsp;</label>
              <label class="check-item">
                <input type="checkbox" v-model="editing.notify_feishu">
                完成后推送飞书
              </label>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showTaskModal = false">取消</button>
          <button class="btn btn-primary" @click="saveTask">保存</button>
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
          <p style="color:#94a3b8;font-size:13px;">确定要删除任务「{{ task?.title }}」吗？此操作不可撤销。</p>
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
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { marked } from 'marked';
import NotesGate from '@/components/NotesGate.vue';

const API = window.electronAPI;
const route = useRoute();
const router = useRouter();

const task = ref<any>(null);
const projects = ref<any[]>([]);
const executions = ref<any[]>([]);
const messages = ref<any[]>([]);
const notesDir = ref('');
const notesLoaded = ref(false);

const showTaskModal = ref(false);
const editing = ref<any>({});
const editingWeekDays = ref<number[]>([]);
const editingMonthDays = ref<number | string>(1);
const showDeleteModal = ref(false);

const weekDays = [
  { label: '周一', value: 1 }, { label: '周二', value: 2 }, { label: '周三', value: 3 },
  { label: '周四', value: 4 }, { label: '周五', value: 5 }, { label: '周六', value: 6 },
  { label: '周日', value: 0 },
];

const noteProjects = computed(() => projects.value.filter(p => p.type === 'note'));

const projectName = computed(() => {
  if (!task.value || !task.value.project_id) return '';
  const p = projects.value.find((x: any) => x.id === Number(task.value.project_id));
  return p ? p.name : '';
});

const isFeishuTask = computed(() => task.value?.source === 'feishu');
const hasBeenExecuted = computed(() => !!task.value?.last_run_at);

const renderMarkdown = (content: string) => {
  if (!content) return '';
  return marked(content, { async: false }) as string;
};

const escHtml = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const formatUserMessage = (s: string) => escHtml(s).replace(/\n/g, '<br>');

async function loadTask() {
  const id = Number(route.params.id);
  try {
    const all = await API.task.list();
    task.value = all.find((t: any) => t.id === id);
    if (task.value) {
      task.value.notify_feishu = !!task.value.notify_feishu;
      task.value.followupText = '';
      task.value.followupReply = '';
      task.value.followupRunning = false;
      task.value.followupDone = false;
    }
  } catch {}
}

async function loadProjects() {
  try { projects.value = await API.project.list(); } catch { projects.value = []; }
}

async function loadExecutions() {
  const id = Number(route.params.id);
  try { executions.value = await API.task.executions(id); } catch { executions.value = []; }
}

async function loadMessages() {
  if (!task.value || !task.value.session_id) { messages.value = []; return; }
  try {
    messages.value = await API.chat.getMessages(task.value.session_id);
  } catch { messages.value = []; }
}

function statusText(status: string): string {
  switch (status) {
    case 'pending': return '待执行';
    case 'in_progress': return '执行中';
    case 'done': return '已完成';
    default: return status;
  }
}

function getTriggerText(t: any): string {
  const type = '📚 知识';
  if (t.trigger_type === 'once') return type + ' · 指定时间：' + (t.scheduled_start || '未设置');
  if (t.trigger_type === 'cycle') {
    switch (t.cycle_type) {
      case 'weekly': return type + ' · 每周' + (t.cycle_value || '') + ' ' + (t.cycle_time || '');
      case 'monthly': return type + ' · 每月' + (t.cycle_value || '') + '号 ' + (t.cycle_time || '');
      case 'cron': return type + ' · Cron：' + (t.cycle_value || '');
      default: return type + ' · 每天 ' + (t.cycle_time || '');
    }
  }
  return type + ' · 立即执行';
}

function triggerLabel(type: string): string {
  switch (type) {
    case 'manual': return '立即';
    case 'scheduled': return '定时';
    default: return type;
  }
}

// ========== 操作 ==========
async function runTask() {
  if (!task.value) return;
  try {
    await API.task.execute(task.value.id);
    await loadTask();
  } catch (e: any) { alert('执行失败: ' + (e.message || e)); }
}

function editTask() {
  if (!task.value) return;
  editing.value = { ...task.value };
  editingWeekDays.value = String(task.value.cycle_value || '').split(',').filter(Boolean).map(Number);
  editingMonthDays.value = task.value.cycle_value || 1;
  showTaskModal.value = true;
}

async function saveTask() {
  const t = editing.value;
  if (!t.project_id) { alert('请选择归属项目'); return; }
  if (!t.title.trim()) { alert('请输入任务标题'); return; }
  if (t.trigger_type === 'once' && !t.scheduled_start) { alert('指定时间任务请选择执行时间'); return; }
  let cycleValue = t.cycle_value || '';
  if (t.cycle_type === 'weekly') cycleValue = editingWeekDays.value.join(',');
  if (t.cycle_type === 'monthly') cycleValue = String(editingMonthDays.value || 1);
  const data = {
    title: t.title,
    prompt: t.prompt,
    task_type: 'note',
    project_id: t.project_id,
    trigger_type: t.trigger_type,
    scheduled_start: t.trigger_type === 'once' ? t.scheduled_start : '',
    cycle_type: t.trigger_type === 'cycle' ? t.cycle_type : '',
    cycle_value: t.trigger_type === 'cycle' ? cycleValue : '',
    cycle_time: t.trigger_type === 'cycle' ? t.cycle_time : '',
    output_target: t.output_target,
    notify_feishu: t.notify_feishu ? 1 : 0,
    status: t.status,
  };
  try {
    await API.task.update(t.id, data);
    showTaskModal.value = false;
    await loadTask();
  } catch (e: any) { alert('操作失败: ' + (e.message || e)); }
}

function openDeleteModal() {
  showDeleteModal.value = true;
}

async function confirmDelete() {
  if (!task.value) return;
  try {
    await API.task.remove(task.value.id);
    router.push('/planner');
  } catch {}
  showDeleteModal.value = false;
}

// ========== 追问 ==========
// 引擎与模型选择（与对话页一致：引擎为全局运行时，切换同步后端）
const runtime = ref<'pi' | 'opencode'>('pi');
const followupModels = ref<any[]>([]);
const selectedModel = ref('');

async function loadRuntime() {
  try {
    const s = await API.agent.runtimeGet();
    if (s?.runtime === 'opencode') runtime.value = 'opencode';
  } catch { /* 保持默认 pi */ }
}

async function loadFollowupModels() {
  try {
    const res = await API.pi.models();
    followupModels.value = (res?.models || []).filter((m: any) => m.pattern);
    if (!selectedModel.value && followupModels.value.some((m: any) => m.configured)) {
      const first = followupModels.value.find((m: any) => m.configured);
      if (first) selectedModel.value = first.pattern;
    }
  } catch { followupModels.value = []; }
}

async function onRuntimeChange() {
  try {
    const s = await API.agent.runtimeSet(runtime.value);
    if (s?.runtime) runtime.value = s.runtime as 'pi' | 'opencode';
  } catch { /* 切换失败保持本地选择 */ }
  selectedModel.value = '';
  followupModels.value = [];
  await loadFollowupModels();
}

async function sendFollowup() {
  if (!task.value) return;
  const q = (task.value.followupText || '').trim();
  if (!q || task.value.followupRunning) return;
  task.value.followupText = '';
  task.value.followupRunning = true;
  task.value.followupDone = false;
  task.value.followupReply = '> ' + q + '\n\n';
  try {
    const ok = await API.task.followup(task.value.id, q, runtime.value, selectedModel.value || undefined);
    if (!ok) {
      task.value.followupRunning = false;
      task.value.followupReply += '\n❌ 追问失败：任务不存在或正在执行中';
    }
  } catch (e: any) {
    task.value.followupRunning = false;
    task.value.followupDone = true;
    task.value.followupReply += '\n❌ 追问失败：' + (e.message || e);
  }
}

// ========== 事件处理 ==========
function handleFollowupDelta(payload: any) {
  if (task.value && payload.taskId === task.value.id && task.value.followupRunning) {
    task.value.followupReply += payload.delta;
  }
}

function handleFollowupDone(payload: any) {
  if (task.value && payload.taskId === task.value.id) {
    task.value.followupRunning = false;
    task.value.followupDone = true;
    task.value.followupReply = payload.text || task.value.followupReply;
  }
  refresh();
}

function handleFollowupError(payload: any) {
  if (task.value && payload.taskId === task.value.id) {
    task.value.followupRunning = false;
    task.value.followupDone = true;
    task.value.followupReply += '\n\n❌ ' + (payload.error || '执行出错');
  }
  refresh();
}

function onTaskChanged() {
  refresh();
}

async function refresh() {
  await loadTask();
  await loadExecutions();
  await loadMessages();
}

async function loadNotesDir() {
  try { notesDir.value = await API.kb.getDir(); } catch { notesDir.value = ''; }
  notesLoaded.value = true;
}

onMounted(async () => {
  await loadRuntime();
  await Promise.all([loadTask(), loadProjects(), loadExecutions(), loadNotesDir(), loadFollowupModels()]);
  await loadMessages();
  window.electronAPI?.on?.('task:changed', onTaskChanged);
  window.electronAPI?.on?.('task:followup:delta', handleFollowupDelta);
  window.electronAPI?.on?.('task:followup:done', handleFollowupDone);
  window.electronAPI?.on?.('task:followup:error', handleFollowupError);
});

onBeforeUnmount(() => {
  window.electronAPI?.removeAllListeners?.('task:changed');
  window.electronAPI?.removeAllListeners?.('task:followup:delta');
  window.electronAPI?.removeAllListeners?.('task:followup:done');
  window.electronAPI?.removeAllListeners?.('task:followup:error');
});
</script>

<style scoped>
.task-detail-view {
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

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.content-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  max-width: 960px;
  margin: 0 auto;
  width: 100%;
}

.empty-state {
  text-align: center;
  padding: 64px 0;
  color: var(--text-muted);
}

.detail-section {
  background: white;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  padding: 20px 24px;
  margin-bottom: 24px;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--text-primary);
}

.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 24px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-label {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 500;
}

.info-value {
  font-size: 14px;
  color: var(--text-secondary);
  word-break: break-all;
}

.empty-sub {
  font-size: 13px;
  color: var(--text-muted);
}

/* ========== 对话气泡 ========== */
.message {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}

.message-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: #f1f5f9;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}

.message.user .message-avatar {
  background: rgba(99, 102, 241, 0.1);
}

.message.assistant .message-avatar {
  background: rgba(34, 197, 94, 0.1);
}

.message-body {
  flex: 1;
  min-width: 0;
}

.message-header {
  margin-bottom: 4px;
}

.message-role {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
}

.message-content {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.6;
  padding: 10px 14px;
  background: #f8fafc;
  border-radius: var(--radius-sm);
  word-break: break-word;
}

.message.assistant .message-content {
  background: #f0fdf4;
}

/* ========== 执行记录 ========== */
.execution-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
  margin-bottom: 12px;
}

.exec-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.exec-trigger, .exec-time {
  font-size: 12px;
  color: var(--text-muted);
}

.exec-error {
  font-size: 13px;
  color: #ef4444;
  margin-bottom: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.exec-result {
  font-size: 13px;
  color: var(--text-secondary);
  background: #f8fafc;
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  max-height: 400px;
  overflow-y: auto;
  line-height: 1.6;
}

/* ========== 追问 ========== */
.followup-reply {
  font-size: 13px;
  color: var(--text-secondary);
  background: #f8fafc;
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-bottom: 10px;
  max-height: 300px;
  overflow-y: auto;
}

.followup-streaming::after {
  content: '▋';
  color: var(--primary);
  animation: blink 1s infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; }
}

.followup-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.followup-toolbar .model-selector {
  font-size: 12px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #f8fafc;
  color: var(--text-primary);
  max-width: 180px;
  outline: none;
  cursor: pointer;
  transition: all 0.2s;
}

.followup-engine-hint {
  font-size: 11px;
  color: var(--text-muted, #94a3b8);
}

.followup-input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}

.followup-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 13px;
  outline: none;
  resize: vertical;
  font-family: inherit;
}

.followup-input:focus {
  border-color: var(--primary);
}

/* ========== 通用 ========== */
.status-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
}

.status-pending { background: rgba(251, 146, 60, 0.1); color: #fb923c; }
.status-in_progress { background: rgba(59, 130, 246, 0.1); color: #3b82f6; }
.status-done { background: rgba(34, 197, 94, 0.1); color: #22c55e; }
.status-SUCCESS { background: rgba(34, 197, 94, 0.1); color: #22c55e; }
.status-FAILED { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
.status-RUNNING { background: rgba(59, 130, 246, 0.1); color: #3b82f6; }

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

.modal-box-lg {
  width: 640px;
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

.check-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
  padding: 10px 0;
  cursor: pointer;
}

.week-select {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.week-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
}

.week-chip:hover {
  border-color: var(--primary);
}

/* markdown-body 样式引用 */
:deep(.markdown-body p) { margin: 0 0 8px; }
:deep(.markdown-body p:last-child) { margin-bottom: 0; }
:deep(.markdown-body ul), :deep(.markdown-body ol) { padding-left: 20px; margin: 4px 0; }
:deep(.markdown-body li) { margin: 2px 0; }
:deep(.markdown-body code) { background: #e8e8e8; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
:deep(.markdown-body pre) { background: #1e293b; color: #e2e8f0; padding: 12px 16px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
:deep(.markdown-body pre code) { background: none; padding: 0; color: inherit; }
:deep(.markdown-body blockquote) { border-left: 3px solid var(--primary); padding-left: 12px; color: #64748b; margin: 8px 0; }
:deep(.markdown-body strong) { font-weight: 600; }
:deep(.markdown-body a) { color: var(--primary); text-decoration: none; }
:deep(.markdown-body a:hover) { text-decoration: underline; }
:deep(.markdown-body h1), :deep(.markdown-body h2), :deep(.markdown-body h3), :deep(.markdown-body h4) { margin: 12px 0 6px; font-weight: 600; }
:deep(.markdown-body h1) { font-size: 1.3em; }
:deep(.markdown-body h2) { font-size: 1.15em; }
:deep(.markdown-body h3) { font-size: 1.05em; }
:deep(.markdown-body table) { border-collapse: collapse; margin: 8px 0; width: 100%; }
:deep(.markdown-body th), :deep(.markdown-body td) { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; font-size: 13px; }
:deep(.markdown-body th) { background: #f8fafc; font-weight: 600; }
:deep(.markdown-body hr) { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
</style>