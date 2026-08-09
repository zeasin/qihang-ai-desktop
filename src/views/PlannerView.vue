<template>
  <div class="planner-view">
    <!-- ========== 笔记任务视图 ========== -->
    <div class="planner-body">
      <!-- 左：任务列表 -->
      <div class="task-list-pane">
        <div class="list-pane-header">
          <span class="list-pane-title">任务列表</span>
          <div class="list-pane-actions">
            <button class="btn btn-primary btn-xs" @click="createTask">+ 新建任务</button>
          </div>
        </div>
        <div class="list-scroll">
          <div v-if="visibleNoteTasks.length === 0" class="list-empty">
            暂无任务，点击「新建任务」创建
          </div>
          <div
            v-for="t in visibleNoteTasks"
            :key="t.id"
            class="list-item"
            :class="{ active: selectedTaskId === t.id, running: t.status === 'in_progress' }"
            @click="selectTask(t)"
          >
            <div class="list-item-head">
              <span class="list-item-title">{{ t.title }}</span>
              <span :class="['status-badge', 'status-' + t.status]">{{ statusText(t.status) }}</span>
              <span v-if="t.status === 'in_progress'" class="running-dot"></span>
            </div>
            <div class="list-item-meta">
              <span class="list-item-project">📚 {{ projectNameById(t.project_id) || '未关联' }}</span>
              <span class="list-item-trigger">{{ getTriggerText(t) }}</span>
            </div>
            <div v-if="t.last_run_at" class="list-item-meta list-item-last">
              最近执行：{{ t.last_run_at }}（{{ t.last_status === 'SUCCESS' ? '成功' : t.last_status === 'FAILED' ? '失败' : t.last_status || '未执行' }}）
            </div>
          </div>
        </div>
      </div>

      <!-- 右：任务详情 -->
      <div class="task-detail-pane">
        <div v-if="!selectedTask" class="detail-empty">
          <div class="empty-icon">🗂️</div>
          <div class="empty-text">选择左侧任务查看详情</div>
        </div>
        <template v-else>
          <div class="detail-header">
            <div class="detail-title-wrap">
              <h2 class="detail-title">{{ selectedTask.title }}</h2>
              <div class="detail-badges">
                <span :class="['status-badge', 'status-' + selectedTask.status]">{{ statusText(selectedTask.status) }}</span>
                <span v-if="selectedTask.last_status === 'FAILED'" class="status-badge status-FAILED">执行失败</span>
                <span v-if="selectedTask.status === 'in_progress'" class="running-dot"></span>
              </div>
            </div>
            <div class="detail-actions">
              <button
                v-if="selectedTask.trigger_type !== 'now'"
                class="btn btn-primary btn-sm"
                :disabled="selectedTask.status === 'in_progress' || selectedTask.followupRunning"
                @click="runTask(selectedTask)"
              >{{ selectedTask.status === 'in_progress' ? '执行中…' : '▶ 立即执行' }}</button>
              <button
                v-if="selectedTask.trigger_type !== 'now'"
                class="btn btn-secondary btn-sm"
                :disabled="selectedTask.source === 'feishu' || !!selectedTask.last_run_at"
                @click="editTask(selectedTask)"
              >编辑</button>
              <router-link :to="'/task/' + selectedTask.id" class="btn btn-secondary btn-sm">全屏</router-link>
              <button class="btn btn-danger btn-sm" @click="openDeleteModal(selectedTask)">删除</button>
            </div>
          </div>

          <div class="detail-scroll">
            <div class="detail-info">
              <span class="di-item">📦 {{ projectNameById(selectedTask.project_id) || '未关联' }}</span>
              <span class="di-item">⏱ {{ getTriggerText(selectedTask) }}</span>
              <span class="di-item">🕐 {{ selectedTask.created_at || '-' }}</span>
              <span v-if="selectedTask.output_target" class="di-item">📄 {{ selectedTask.output_target }}</span>
            </div>

            <div v-if="selectedTask.prompt" class="detail-section">
              <div class="section-title">任务诉求</div>
              <div class="prompt-text">{{ selectedTask.prompt }}</div>
            </div>

            <div class="detail-section">
              <div class="section-title">对话记录</div>
              <div v-if="selectedMessages.length === 0" class="empty-sub">暂无对话记录</div>
              <div v-for="(msg, idx) in selectedMessages" :key="idx" class="message" :class="msg.role">
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

            <div v-if="selectedTask.trigger_type !== 'now'" class="detail-section">
              <div class="section-title">执行记录</div>
              <div v-if="selectedExecutions.length === 0" class="empty-sub">暂无执行记录</div>
              <div v-for="ex in selectedExecutions" :key="ex.id" class="execution-card">
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

            <div class="detail-section">
              <div class="section-title">追问</div>
              <div v-if="selectedTask.followupDone" class="followup-reply markdown-body" v-html="renderMarkdown(selectedTask.followupReply)"></div>
              <div v-if="selectedTask.followupRunning" class="followup-reply markdown-body followup-streaming" v-html="renderMarkdown(selectedTask.followupReply)"></div>
              <div class="followup-input-row">
                <textarea
                  v-model="selectedTask.followupText"
                  class="followup-input"
                  rows="2"
                  placeholder="输入追问内容，将沿用该任务的原对话上下文继续执行…"
                  @keydown.enter.exact.prevent="sendFollowup(selectedTask)"
                ></textarea>
                <button class="btn btn-primary btn-sm" :disabled="!(selectedTask.followupText || '').trim() || selectedTask.followupRunning" @click="sendFollowup(selectedTask)">{{ selectedTask.followupRunning ? '执行中…' : '发送' }}</button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- 新建项目模态框 -->
      <div v-if="showProjectModal" class="modal-overlay" @click="showProjectModal = false">
        <div class="modal-box" style="width:420px;" @click.stop>
          <div class="modal-header">
            <h3>新建项目</h3>
            <button class="btn btn-secondary" @click="showProjectModal = false">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>项目名称 *</label>
              <input type="text" class="form-control" v-model="projectForm.name" placeholder="如 CRM系统">
            </div>
            <div class="form-group">
              <label>项目类型</label>
              <select class="form-control" v-model="projectForm.type">
                <option value="note">📚 笔记库</option>
                <option value="code">💻 代码库</option>
              </select>
            </div>
            <div class="form-group">
              <label>目录路径</label>
              <div style="display:flex;gap:8px;">
                <input type="text" class="form-control" v-model="projectForm.dir" placeholder="选择目录..." readonly>
                <button class="btn btn-secondary" @click="selectDir">选择</button>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="showProjectModal = false">取消</button>
            <button class="btn btn-primary" :disabled="!projectForm.name.trim()" @click="saveProject">保存</button>
          </div>
        </div>
      </div>

      <!-- 新建/编辑任务模态框 -->
      <div v-if="showTaskModal" class="modal-overlay" @click="showTaskModal = false">
        <div class="modal-box modal-box-lg" @click.stop>
          <div class="modal-header">
            <h3>{{ isEditing ? '编辑任务' : '新建任务' }}</h3>
            <button class="btn btn-secondary" @click="showTaskModal = false">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group" v-if="noteProjects.length > 1">
              <label>归属项目 *</label>
              <select class="form-control" v-model="editing.project_id" :disabled="isEditing">
                <option :value="null" disabled>请选择项目</option>
                <optgroup label="📚 笔记库">
                  <option v-for="p in noteProjects" :key="p.id" :value="p.id">{{ p.name }}</option>
                </optgroup>
              </select>
            </div>
            <div class="form-group">
              <label>任务标题 *</label>
              <input type="text" class="form-control" v-model="editing.title" placeholder="例如：每日数据总结 / 修复登录超时">
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
            <button class="btn btn-danger" v-if="isEditing" @click="openDeleteModal(editing)">🗑️ 删除</button>
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
            <p style="color:#94a3b8;font-size:13px;">确定要删除{{ deletingTask ? '任务' : '项目' }}「{{ deletingTask?.title || deletingProject?.name }}」吗？此操作不可撤销。</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="showDeleteModal = false">取消</button>
            <button class="btn btn-danger" @click="confirmDelete">删除</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { marked } from 'marked';

const API = window.electronAPI;

interface AiTask {
  id: number; title: string; prompt: string; description: string; priority: string;
  status: string; task_type: string; project_id: number | null; source: string;
  trigger_type: string; scheduled_start: string; cycle_type: string; cycle_value: string;
  cycle_time: string; output_target: string; notify_feishu: boolean;
  last_result: string; last_run_at: string; last_status: string; session_id: string;
  created_at?: string;
  executions?: any[]; showHistory?: boolean; showFollowup?: boolean;
  followupText?: string; followupReply?: string; followupRunning?: boolean; followupDone?: boolean;
}

interface Project { id: number; name: string; type: string; dir: string; }

const tasks = ref<AiTask[]>([]);
const projects = ref<Project[]>([]);

const noteProjects = computed(() => projects.value.filter(p => p.type === 'note'));

// ========== 左栏：任务列表 ==========
const noteTaskFilter = ref<number | null>(null);

const visibleNoteTasks = computed(() => {
  const noteIds = new Set(noteProjects.value.map(p => p.id));
  return tasks.value
    .filter(t => noteIds.has(Number(t.project_id)))
    .filter(t => noteTaskFilter.value === null || Number(t.project_id) === Number(noteTaskFilter.value))
    .sort((a, b) => {
      const ta = a.created_at || '';
      const tb = b.created_at || '';
      if (ta !== tb) return ta < tb ? 1 : -1;
      return (b.id || 0) - (a.id || 0);
    });
});

function projectNameById(pid: number | null): string {
  if (pid == null) return '';
  const p = projects.value.find(x => x.id === Number(pid));
  return p ? p.name : '';
}

// ========== 右栏：任务详情 ==========
const selectedTaskId = ref<number | null>(null);
const selectedMessages = ref<any[]>([]);
const selectedExecutions = ref<any[]>([]);

const selectedTask = computed(() => {
  if (selectedTaskId.value === null) return null;
  return tasks.value.find(t => t.id === selectedTaskId.value) || null;
});

function selectTask(t: AiTask) {
  selectedTaskId.value = t.id;
  if (t.followupText === undefined) t.followupText = '';
  if (t.followupReply === undefined) t.followupReply = '';
  if (t.followupRunning === undefined) t.followupRunning = false;
  if (t.followupDone === undefined) t.followupDone = false;
  loadSelectedDetail();
}

async function loadSelectedDetail() {
  const t = selectedTask.value;
  if (!t) { selectedMessages.value = []; selectedExecutions.value = []; return; }
  if (t.session_id) {
    try { selectedMessages.value = await API.chat.getMessages(t.session_id); } catch { selectedMessages.value = []; }
  } else {
    selectedMessages.value = [];
  }
  if (t.trigger_type !== 'now') {
    try { selectedExecutions.value = await API.task.executions(t.id); } catch { selectedExecutions.value = []; }
  } else {
    selectedExecutions.value = [];
  }
}

function ensureSelectedTask() {
  const list = visibleNoteTasks.value;
  if (list.length === 0) {
    selectedTaskId.value = null;
    selectedMessages.value = [];
    selectedExecutions.value = [];
    return;
  }
  if (selectedTaskId.value === null || !list.some(t => t.id === selectedTaskId.value)) {
    selectedTaskId.value = list[0].id;
  }
  loadSelectedDetail();
}

watch(noteTaskFilter, () => { ensureSelectedTask(); });

// ========== 模态框状态 ==========
const showTaskModal = ref(false);
const isEditing = ref(false);
const editing = ref<AiTask>(emptyTask());
const editingWeekDays = ref<number[]>([]);
const editingMonthDays = ref<number | string>(1);
const showDeleteModal = ref(false);
const deletingTask = ref<AiTask | null>(null);
const deletingProject = ref<Project | null>(null);
const showProjectModal = ref(false);
const projectForm = ref({ name: '', dir: '', type: 'note' });

const weekDays = [
  { label: '周一', value: 1 }, { label: '周二', value: 2 }, { label: '周三', value: 3 },
  { label: '周四', value: 4 }, { label: '周五', value: 5 }, { label: '周六', value: 6 },
  { label: '周日', value: 0 },
];

function emptyTask(): AiTask {
  return {
    id: 0, title: '', prompt: '', description: '', priority: 'mid', status: 'pending',
    task_type: 'note', project_id: null, source: '', trigger_type: 'now', scheduled_start: '',
    cycle_type: 'daily', cycle_value: '', cycle_time: '09:00', output_target: '',
    notify_feishu: false, last_result: '', last_run_at: '', last_status: '', session_id: ''
  };
}

// ========== 数据加载 ==========
async function loadTasks() {
  try {
    tasks.value = (await API.task.list()).map((t: any) => ({ ...t, notify_feishu: !!t.notify_feishu, showHistory: false }));
  } catch { tasks.value = []; }
  ensureSelectedTask();
}

async function loadProjects() {
  try { projects.value = (await API.project.list()) || []; } catch { projects.value = []; }
  ensureSelectedTask();
}

// ========== 项目 CRUD ==========
function createProject() {
  projectForm.value = { name: '', dir: '', type: 'note' };
  showProjectModal.value = true;
}

async function selectDir() {
  try { const dir = await API.dialog.openDirectory(); if (dir) projectForm.value.dir = dir; } catch {}
}

async function saveProject() {
  if (!projectForm.value.name.trim()) return;
  try {
    await API.project.add(projectForm.value.name.trim(), projectForm.value.type, projectForm.value.dir || '', '', '');
    showProjectModal.value = false;
    projectForm.value = { name: '', dir: '', type: 'note' };
    await loadProjects();
  } catch (e: any) { alert('创建项目失败: ' + (e.message || e)); }
}

function deleteProject(p: Project) {
  deletingProject.value = p;
  deletingTask.value = null;
  showDeleteModal.value = true;
}

// ========== 任务 CRUD ==========
function createTask() {
  isEditing.value = false;
  editing.value = emptyTask();
  editing.value.project_id =
    noteTaskFilter.value ??
    selectedTask.value?.project_id ??
    (noteProjects.value[0]?.id ?? null);
  editingWeekDays.value = [];
  editingMonthDays.value = 1;
  showTaskModal.value = true;
}

function editTask(task: AiTask) {
  isEditing.value = true;
  editing.value = { ...task };
  editingWeekDays.value = String(task.cycle_value || '').split(',').filter(Boolean).map(Number);
  editingMonthDays.value = task.cycle_value || 1;
  showTaskModal.value = true;
}

async function saveTask() {
  const t = editing.value;
  if (!t.project_id) { alert('请选择归属项目'); return; }
  if (!t.title.trim()) { alert('请输入任务标题'); return; }
  if (t.trigger_type === 'once' && !t.scheduled_start) { alert('指定时间任务请选择执行时间'); return; }
  const proj = projects.value.find(p => p.id === Number(t.project_id));
  let cycleValue = t.cycle_value || '';
  if (t.cycle_type === 'weekly') cycleValue = editingWeekDays.value.join(',');
  if (t.cycle_type === 'monthly') cycleValue = String(editingMonthDays.value || 1);
  const data = {
    title: t.title, prompt: t.prompt,
    task_type: proj && proj.type === 'code' ? 'coding' : 'note',
    project_id: t.project_id,
    trigger_type: t.trigger_type,
    scheduled_start: t.trigger_type === 'once' ? t.scheduled_start : '',
    cycle_type: t.trigger_type === 'cycle' ? t.cycle_type : '',
    cycle_value: t.trigger_type === 'cycle' ? cycleValue : '',
    cycle_time: t.trigger_type === 'cycle' ? t.cycle_time : '',
    output_target: t.output_target,
    notify_feishu: t.notify_feishu ? 1 : 0,
    status: 'pending',
  };
  try {
    let createdId: number | null = null;
    if (isEditing.value) {
      await API.task.update(t.id, data);
    } else {
      const r = await API.task.add(data);
      createdId = r && r.id;
      if (data.trigger_type === 'now') await API.task.execute(r.id);
    }
    showTaskModal.value = false;
    await loadTasks();
    if (createdId !== null) selectedTaskId.value = createdId;
    ensureSelectedTask();
  } catch (e: any) { alert('操作失败: ' + (e.message || e)); }
}

async function runTask(task: AiTask) {
  try {
    await API.task.execute(task.id);
    await loadTasks();
    await loadSelectedDetail();
  } catch (e: any) { alert('执行失败: ' + (e.message || e)); }
}

function openDeleteModal(task: AiTask) {
  deletingTask.value = task;
  deletingProject.value = null;
  showDeleteModal.value = true;
}

async function confirmDelete() {
  if (deletingTask.value) {
    try { await API.task.remove(deletingTask.value.id); await loadTasks(); } catch {}
  } else if (deletingProject.value) {
    try { await API.project.delete(deletingProject.value.id); await loadProjects(); await loadTasks(); } catch {}
  }
  showDeleteModal.value = false;
}

// ========== 追问 ==========
async function sendFollowup(task: AiTask) {
  const q = (task.followupText || '').trim();
  if (!q || task.followupRunning) return;
  task.followupText = ''; task.followupRunning = true; task.followupDone = false;
  task.followupReply = '> ' + q + '\n\n';
  try {
    const ok = await API.task.followup(task.id, q);
    if (!ok) { task.followupRunning = false; task.followupReply += '\n❌ 追问失败：任务不存在或正在执行中'; }
  } catch (e: any) { task.followupRunning = false; task.followupDone = true; task.followupReply += '\n❌ ' + (e.message || e); }
}

function handleFollowupDelta(payload: any) {
  const t = tasks.value.find((x: any) => x.id === payload.taskId);
  if (t && t.followupRunning) t.followupReply += payload.delta;
}

function handleFollowupDone(payload: any) {
  const t = tasks.value.find((x: any) => x.id === payload.taskId);
  if (t) { t.followupRunning = false; t.followupDone = true; t.followupReply = payload.text || t.followupReply; }
  loadTasks();
}

function handleFollowupError(payload: any) {
  const t = tasks.value.find((x: any) => x.id === payload.taskId);
  if (t) { t.followupRunning = false; t.followupDone = true; t.followupReply += '\n\n❌ ' + (payload.error || '执行出错'); }
  loadTasks();
}

// ========== 渲染工具 ==========
const renderMarkdown = (content: string) => {
  if (!content) return '';
  return marked(content, { async: false }) as string;
};

const escHtml = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const formatUserMessage = (s: string) => escHtml(s).replace(/\n/g, '<br>');

function statusText(status: string): string {
  switch (status) {
    case 'pending': return '待执行';
    case 'in_progress': return '执行中';
    case 'done': return '已完成';
    default: return status;
  }
}

function getTriggerText(task: AiTask): string {
  const type = task.task_type === 'coding' ? '💻 编程' : '📚 知识';
  if (task.trigger_type === 'once') return type + ' · 指定时间：' + (task.scheduled_start || '未设置');
  if (task.trigger_type === 'cycle') {
    switch (task.cycle_type) {
      case 'weekly': return type + ' · 每周' + (task.cycle_value || '') + ' ' + (task.cycle_time || '');
      case 'monthly': return type + ' · 每月' + (task.cycle_value || '') + '号 ' + (task.cycle_time || '');
      case 'cron': return type + ' · Cron：' + (task.cycle_value || '');
      default: return type + ' · 每天 ' + (task.cycle_time || '');
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

function onTaskChanged() { loadTasks(); }

onMounted(async () => {
  await Promise.all([loadProjects(), loadTasks()]);
  ensureSelectedTask();
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
.planner-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.planner-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

/* ========== 左：任务列表 ========== */
.task-list-pane {
  width: 320px;
  min-width: 320px;
  background: white;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.list-pane-header {
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.list-pane-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.list-pane-actions { display: flex; gap: 6px; align-items: center; }

.list-pane-filter {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.filter-select {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  outline: none;
  background: white;
  cursor: pointer;
  color: var(--text-secondary);
}

.list-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.list-empty {
  padding: 32px 16px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

.list-item {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  margin-bottom: 2px;
  transition: background 0.15s;
  border: 1px solid transparent;
}

.list-item:hover { background: rgba(99,102,241,0.05); }
.list-item.active { background: rgba(99,102,241,0.1); border-color: rgba(99,102,241,0.25); }
.list-item.running { border-color: var(--primary); }

.list-item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.list-item-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list-item-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-muted);
}

.list-item-project { color: var(--text-secondary); }

/* ========== 右：任务详情 ========== */
.task-detail-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #f8fafc;
}

.detail-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-muted);
}

.detail-header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  background: white;
  gap: 12px;
  flex-wrap: wrap;
}

.detail-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.detail-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.detail-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.detail-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.detail-info {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--text-secondary);
}

.detail-section {
  background: white;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  padding: 16px 20px;
  margin-bottom: 16px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-primary);
}

.prompt-text {
  font-size: 13px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  background: #f8fafc;
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  line-height: 1.6;
}

.empty-sub { font-size: 13px; color: var(--text-muted); }

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

.message.user .message-avatar { background: rgba(99, 102, 241, 0.1); }
.message.assistant .message-avatar { background: rgba(34, 197, 94, 0.1); }

.message-body { flex: 1; min-width: 0; }
.message-header { margin-bottom: 4px; }
.message-role { font-size: 12px; font-weight: 500; color: var(--text-muted); }

.message-content {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.6;
  padding: 10px 14px;
  background: #f8fafc;
  border-radius: var(--radius-sm);
  word-break: break-word;
}

.message.assistant .message-content { background: #f0fdf4; }

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

.exec-trigger, .exec-time { font-size: 12px; color: var(--text-muted); }

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

@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }

.followup-input-row { display: flex; gap: 8px; align-items: flex-end; }
.followup-input { flex: 1; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; outline: none; resize: vertical; font-family: inherit; }
.followup-input:focus { border-color: var(--primary); }

/* ========== 通用 ========== */
.btn-xs { padding: 4px 10px; font-size: 12px; }

.running-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #3b82f6; animation: pulse 1s infinite;
  flex-shrink: 0;
}

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

.status-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
  flex-shrink: 0;
}

.status-pending { background: rgba(251, 146, 60, 0.1); color: #fb923c; }
.status-in_progress { background: rgba(59, 130, 246, 0.1); color: #3b82f6; }
.status-done { background: rgba(34, 197, 94, 0.1); color: #22c55e; }
.status-SUCCESS { background: rgba(34, 197, 94, 0.1); color: #22c55e; }
.status-FAILED { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
.status-RUNNING { background: rgba(59, 130, 246, 0.1); color: #3b82f6; }

/* ========== 模态框 ========== */
.modal-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000;
}
.modal-box {
  background: white; border-radius: var(--radius-md); box-shadow: 0 10px 25px rgba(0,0,0,0.1);
  max-width: 90%; max-height: 90vh; overflow-y: auto; width: 520px;
}
.modal-box-lg { width: 640px; }
.modal-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.modal-header h3 { font-size: 16px; font-weight: 600; }
.modal-body { padding: 20px; }
.modal-footer { padding: 16px 20px; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: flex-end; gap: 8px; }

.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-size: 13px; font-weight: 500; color: var(--text-secondary); margin-bottom: 6px; }
.form-control { width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; outline: none; background: white; }
.form-control:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(99,102,241,0.1); }
.form-row { display: flex; gap: 12px; }
.form-row .form-group { flex: 1; }
textarea.form-control { resize: vertical; min-height: 80px; }
select.form-control { cursor: pointer; }
.check-item { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); padding: 10px 0; cursor: pointer; }
.week-select { display: flex; gap: 8px; flex-wrap: wrap; }
.week-chip { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 10px; cursor: pointer; user-select: none; }
.week-chip:hover { border-color: var(--primary); }

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
