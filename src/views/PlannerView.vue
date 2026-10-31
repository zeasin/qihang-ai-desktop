<template>
  <div class="planner-view">
    <!-- 一个项目都没有：AI 功能门禁 -->
    <NotesGate v-if="notesLoaded && !projectOptions.length" @ready="onGateReady" />

    <!-- ========== 笔记任务视图 ========== -->
    <div v-if="!notesLoaded || projectOptions.length" class="planner-body planner-col">

      <!-- ========== 综合页 ========== -->
      <template v-if="viewMode === 'overview'">
        <div class="ov-scroll">
          <div class="page-head">
            <div>
              <h1 class="page-title">任务中心</h1>
              <p class="page-sub">AI 任务的计划、执行与运行记录，每次运行都会留档。</p>
            </div>
            <div class="page-actions">
              <button class="btn btn-primary btn-sm" @click="createTask">+ 新建任务</button>
            </div>
          </div>

          <div class="statline">
            <span>任务 <b class="acc">{{ taskCount }}</b></span>
            <span>已开启循环 <b>{{ activeCycleCount }}</b></span>
            <span>累计执行 <b>{{ execTotal }}</b> 次</span>
            <span class="warm">近期失败 <b>{{ recentFailedCount }}</b></span>
          </div>

          <div class="sec-label"><AppIcon name="clock" :size="13" />最近运行<em>每次执行都有记录</em></div>
          <div class="panel list-panel">
            <div v-for="ex in recentRuns" :key="ex.id" class="file-row" @click="openTaskById(ex.task_id)">
              <span :class="['status-badge', 'status-' + ex.status]">{{ execStatusText(ex.status) }}</span>
              <span class="plan-tx">
                <b>{{ ex.task_title }}</b>
                <small>{{ ex.start_time }} · {{ triggerLabel(ex.trigger_type) }}{{ briefText(ex.error_message || ex.result_text) ? ' · ' + briefText(ex.error_message || ex.result_text) : '' }}</small>
              </span>
            </div>
            <div v-if="!recentRuns.length" class="empty-row">还没有执行记录：点任务卡片的「立即执行」，或等定时任务到点自动跑</div>
          </div>

          <div class="sec-label"><AppIcon name="workflow" :size="13" />任务卡片<em>{{ visibleNoteTasks.length }}</em></div>
          <div class="task-grid">
            <div
              v-for="t in visibleNoteTasks"
              :key="t.id"
              class="task-card"
              :class="{ running: t.status === 'in_progress' }"
              @click="openTask(t)"
            >
              <div class="tc-head">
                <span class="tc-title">{{ t.title }}</span>
                <span :class="['status-badge', 'status-' + t.status]">{{ taskBadgeText(t) }}</span>
                <span v-if="t.status === 'in_progress'" class="running-dot"></span>
              </div>
              <div class="tc-meta">
                <span>📚 {{ projectNameById(t.project_id) || '未关联' }}</span>
                <span>⏱ {{ getTriggerText(t) }}</span>
              </div>
              <div v-if="t.last_run_at" class="tc-last">
                最近：{{ t.last_run_at }}（{{ t.last_status === 'SUCCESS' ? '成功' : t.last_status === 'FAILED' ? '失败' : t.last_status || '未执行' }}）
              </div>
              <div class="tc-actions">
                <button
                  v-if="t.trigger_type === 'cycle'"
                  class="btn btn-xs"
                  :class="isTaskOn(t) ? 'btn-secondary' : 'btn-primary'"
                  :disabled="t.status === 'in_progress'"
                  @click.stop="toggleTask(t)"
                >{{ isTaskOn(t) ? '⏸ 暂停' : '▶ 开启' }}</button>
                <button
                  v-if="canRun(t)"
                  class="btn btn-secondary btn-xs"
                  :disabled="t.status === 'in_progress'"
                  @click.stop="runTask(t)"
                >{{ t.status === 'in_progress' ? '执行中…' : '▶ 立即执行' }}</button>
                <button
                  class="btn btn-secondary btn-xs"
                  :disabled="!!t.last_run_at && t.task_type !== 'daily_report'"
                  @click.stop="editTask(t)"
                >编辑</button>
              </div>
            </div>
            <div v-if="!visibleNoteTasks.length" class="empty-row">暂无任务，点击右上角「+ 新建任务」创建</div>
          </div>
        </div>
      </template>

      <!-- ========== 任务详情 ========== -->
      <div v-else-if="selectedTask" class="task-detail-pane">
          <div class="detail-header">
            <button class="btn btn-secondary btn-sm" @click="backToOverview">← 返回任务中心</button>
            <div class="detail-title-wrap">
              <h2 class="detail-title">{{ selectedTask.title }}</h2>
              <div class="detail-badges">
                <span :class="['status-badge', 'status-' + selectedTask.status]">{{ taskBadgeText(selectedTask) }}</span>
                <span v-if="selectedTask.last_status === 'FAILED'" class="status-badge status-FAILED">执行失败</span>
                <span v-if="selectedTask.status === 'in_progress'" class="running-dot"></span>
              </div>
            </div>
            <div class="detail-actions">
              <button
                v-if="selectedTask.trigger_type === 'cycle'"
                class="btn btn-sm"
                :class="isTaskOn(selectedTask) ? 'btn-secondary' : 'btn-primary'"
                :disabled="selectedTask.status === 'in_progress'"
                @click="toggleTask(selectedTask)"
              >{{ isTaskOn(selectedTask) ? '⏸ 暂停调度' : '▶ 开启' }}</button>
              <button
                v-if="canRun(selectedTask)"
                class="btn btn-secondary btn-sm"
                :disabled="selectedTask.status === 'in_progress'"
                @click="runTask(selectedTask)"
              >{{ selectedTask.status === 'in_progress' ? '执行中…' : '▶ 立即执行' }}</button>
              <button
                v-if="selectedTask.trigger_type !== 'now'"
                class="btn btn-secondary btn-sm"
                :disabled="!!selectedTask.last_run_at && selectedTask.task_type !== 'daily_report'"
                @click="editTask(selectedTask)"
              >编辑</button>
              <router-link :to="'/task/' + selectedTask.id" class="btn btn-secondary btn-sm">全屏</router-link>
              <button v-if="selectedTask.task_type !== 'daily_report'" class="btn btn-danger btn-sm" @click="openDeleteModal(selectedTask)">删除</button>
            </div>
          </div>

          <div class="detail-scroll">
            <div class="detail-section">
              <div class="section-title">执行计划</div>
              <div class="plan-grid">
                <div class="plan-item"><span class="plan-k">所属项目</span><span class="plan-v">{{ projectNameById(selectedTask.project_id) || '未关联' }}</span></div>
                <div class="plan-item"><span class="plan-k">执行方式</span><span class="plan-v">{{ triggerWayText(selectedTask) }}</span></div>
                <div v-if="selectedTask.trigger_type === 'cycle'" class="plan-item"><span class="plan-k">重复规则</span><span class="plan-v">{{ cycleRuleText(selectedTask) }}</span></div>
                <div v-if="selectedTask.cycle_end" class="plan-item"><span class="plan-k">循环结束</span><span class="plan-v">{{ selectedTask.cycle_end }}</span></div>
                <div v-if="selectedTask.last_cycle_run" class="plan-item"><span class="plan-k">上次循环触发</span><span class="plan-v">{{ selectedTask.last_cycle_run }}</span></div>
                <div class="plan-item"><span class="plan-k">创建时间</span><span class="plan-v">{{ selectedTask.created_at || '-' }}</span></div>
                <div v-if="selectedTask.output_target" class="plan-item"><span class="plan-k">输出位置</span><span class="plan-v">{{ selectedTask.output_target }}</span></div>
                <div class="plan-item"><span class="plan-k">飞书推送</span><span class="plan-v">{{ selectedTask.notify_feishu ? '开启' : '关闭' }}</span></div>
              </div>
            </div>

            <div v-if="selectedTask.trigger_type !== 'now'" class="detail-section">
              <div class="section-title">执行记录</div>
              <div v-if="selectedExecutions.length === 0" class="empty-sub">暂无执行记录</div>
              <div v-for="ex in selectedExecutions" :key="ex.id" class="execution-card">
                <div class="exec-header" @click="toggleExecOpen(ex)">
                  <span :class="['status-badge', 'status-' + ex.status]">{{ execStatusText(ex.status) }}</span>
                  <span class="exec-trigger">{{ triggerLabel(ex.trigger_type) }}</span>
                  <span class="exec-time">{{ ex.start_time }}</span>
                  <span v-if="ex.end_time" class="exec-time">→ {{ ex.end_time }}</span>
                  <span v-if="ex.result_text || ex.error_message" class="exec-expand">{{ ex._open ? '▲ 收起' : '▼ 运行结果' }}</span>
                </div>
                <div v-if="ex.error_message" class="exec-error">❌ {{ ex.error_message }}</div>
                <div v-if="ex._open && ex.result_text" class="exec-result markdown-body" v-html="renderMarkdown(ex.result_text)"></div>
                <div v-else-if="!ex._open && ex.result_text" class="exec-brief">{{ briefText(ex.result_text) }}</div>
              </div>
            </div>
          </div>
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
            <div class="form-group">
              <label>所属项目 *</label>
              <select class="form-control" v-model="editing.project_id">
                <option :value="null" disabled>请选择项目</option>
                <option v-for="p in projectOptions" :key="p.id" :value="p.id">{{ p.name }}{{ p.is_default ? '（默认）' : '' }}</option>
              </select>
            </div>
            <div class="form-group">
              <label>任务标题 *</label>
              <input type="text" class="form-control" v-model="editing.title" :readonly="isSystemTask(editing)" placeholder="例如：每日数据总结 / 整理本周笔记">
            </div>
            <div class="form-group">
              <label>{{ isSystemTask(editing) ? '日报提示词（留空使用内置默认格式）' : '任务诉求（AI 将据此执行）' }}</label>
              <textarea class="form-control" v-model="editing.prompt" rows="4" :placeholder="isSystemTask(editing) ? '可自定义日报板块、评分规则等；留空则使用内置日报格式' : '描述要让 AI 做什么'"></textarea>
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
              <div class="form-group" v-if="!isSystemTask(editing)">
                <label>结果保存位置（相对项目目录，留空自动保存）</label>
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
            <button class="btn btn-danger" v-if="isEditing && !isSystemTask(editing)" @click="openDeleteModal(editing)">🗑️ 删除</button>
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
            <p style="color:var(--text-muted);font-size:13px;">确定要删除{{ deletingTask ? '任务' : '项目' }}「{{ deletingTask?.title || deletingProject?.name }}」吗？此操作不可撤销。</p>
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
import NotesGate from '@/components/NotesGate.vue';
import AppIcon from '@/components/AppIcon.vue';

const API = window.electronAPI;

interface AiTask {
  id: number; title: string; prompt: string; description: string; priority: string;
  status: string; task_type: string; project_id: number | null; source: string;
  trigger_type: string; scheduled_start: string; cycle_type: string; cycle_value: string;
  cycle_time: string; cycle_end?: string; output_target: string; notify_feishu: boolean;
  last_result: string; last_run_at: string; last_status: string; session_id: string;
  last_cycle_run?: string;
  created_at?: string;
}

interface Project { id: number; name: string; type: string; dir: string; is_default?: number; }

const tasks = ref<AiTask[]>([]);
const projects = ref<Project[]>([]);
const notesLoaded = ref(false);

const projectOptions = computed(() => projects.value);

// ========== 左栏：任务列表 ==========
const noteTaskFilter = ref<number | null>(null);

const visibleNoteTasks = computed(() => {
  const noteIds = new Set(projectOptions.value.map(p => p.id));
  return tasks.value
    // 内置日报任务未绑定笔记库时也显示（未开启状态，等用户选库开启）
    .filter(t => noteIds.has(Number(t.project_id)) || t.task_type === 'daily_report')
    // 飞书一次性消息不是任务（2026-10-31 会话化，启动时已迁移为纯会话），
    // 这里兜底过滤，防旧库迁移失败或外部写入把问答混进任务列表
    .filter(t => !(t.source === 'feishu' && t.trigger_type === 'now'))
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

// ========== 综合页 ==========
const viewMode = ref<'overview' | 'detail'>('overview');
const recentRuns = ref<any[]>([]);
const execTotal = ref(0);

async function loadRecentRuns() {
  try {
    const r = await API.task.executionList(1, 8);
    recentRuns.value = (r?.rows || []).map((x: any) => ({ ...x, _open: false }));
    execTotal.value = r?.total || 0;
  } catch { recentRuns.value = []; }
}

const taskCount = computed(() => visibleNoteTasks.value.length);
const activeCycleCount = computed(() => visibleNoteTasks.value.filter(t => t.trigger_type === 'cycle' && isTaskOn(t)).length);
const recentFailedCount = computed(() => recentRuns.value.filter((x: any) => x.status === 'FAILED').length);

function execStatusText(s: string): string {
  if (s === 'SUCCESS') return '成功';
  if (s === 'FAILED') return '失败';
  if (s === 'RUNNING') return '运行中';
  return s || '排队';
}

/** 文本摘要（最近运行行 / 执行记录折叠态共用） */
function briefText(s: any): string {
  return String(s || '').replace(/\s+/g, ' ').slice(0, 80);
}

function toggleExecOpen(ex: any) { ex._open = !ex._open; }

// ========== 任务详情 ==========
const selectedTaskId = ref<number | null>(null);
const selectedExecutions = ref<any[]>([]);

const selectedTask = computed(() => {
  if (selectedTaskId.value === null) return null;
  return tasks.value.find(t => t.id === selectedTaskId.value) || null;
});

/** 从综合页进入任务详情 */
function openTask(t: AiTask) {
  selectedTaskId.value = t.id;
  viewMode.value = 'detail';
  loadSelectedDetail();
}

function openTaskById(id: number) {
  const t = tasks.value.find(x => x.id === Number(id));
  if (t) openTask(t);
}

function backToOverview() {
  viewMode.value = 'overview';
  selectedTaskId.value = null;
  selectedExecutions.value = [];
}

async function loadSelectedDetail() {
  const t = selectedTask.value;
  if (!t) { selectedExecutions.value = []; return; }
  if (t.trigger_type !== 'now') {
    try { selectedExecutions.value = (await API.task.executions(t.id)).map((x: any) => ({ ...x, _open: false })); } catch { selectedExecutions.value = []; }
  } else {
    selectedExecutions.value = [];
  }
}

// ========== 模态框状态 ==========
const showTaskModal = ref(false);
const isEditing = ref(false);
const editing = ref<AiTask>(emptyTask());
const editingWeekDays = ref<number[]>([]);
const editingMonthDays = ref<number | string>(1);
// 内置日报任务从「未开启」点开启时走编辑弹窗选库，保存成功后置为待执行
const enableAfterSave = ref(false);
watch(showTaskModal, (v) => { if (!v) enableAfterSave.value = false; });

const showDeleteModal = ref(false);
const deletingTask = ref<AiTask | null>(null);
const deletingProject = ref<Project | null>(null);
const showProjectModal = ref(false);
const projectForm = ref({ name: '', dir: '' });

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
    tasks.value = (await API.task.list()).map((t: any) => ({ ...t, notify_feishu: !!t.notify_feishu }));
  } catch { tasks.value = []; }
}

async function loadProjects() {
  try { projects.value = (await API.project.list()) || []; } catch { projects.value = []; }
}

// ========== 项目 CRUD ==========
function createProject() {
  projectForm.value = { name: '', dir: '' };
  showProjectModal.value = true;
}

async function selectDir() {
  try { const dir = await API.dialog.openDirectory(); if (dir) projectForm.value.dir = dir; } catch {}
}

async function saveProject() {
  if (!projectForm.value.name.trim()) return;
  try {
    await API.project.add(projectForm.value.name.trim(), 'note', projectForm.value.dir || '', '', '');
    showProjectModal.value = false;
    projectForm.value = { name: '', dir: '' };
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
    (projectOptions.value.find(p => p.is_default) ?? projectOptions.value[0])?.id ?? null;
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
  if (!t.project_id) { alert('请选择所属项目'); return; }
  if (!t.title.trim()) { alert('请输入任务标题'); return; }
  if (t.trigger_type === 'once' && !t.scheduled_start) { alert('指定时间任务请选择执行时间'); return; }
  let cycleValue = t.cycle_value || '';
  if (t.cycle_type === 'weekly') cycleValue = editingWeekDays.value.join(',');
  if (t.cycle_type === 'monthly') cycleValue = String(editingMonthDays.value || 1);
  const data: any = {
    title: t.title, prompt: t.prompt,
    task_type: isSystemTask(t) ? 'daily_report' : 'note',
    project_id: t.project_id,
    trigger_type: t.trigger_type,
    scheduled_start: t.trigger_type === 'once' ? t.scheduled_start : '',
    cycle_type: t.trigger_type === 'cycle' ? t.cycle_type : '',
    cycle_value: t.trigger_type === 'cycle' ? cycleValue : '',
    cycle_time: t.trigger_type === 'cycle' ? t.cycle_time : '',
    output_target: t.output_target,
    notify_feishu: t.notify_feishu ? 1 : 0,
  };
  // 内置日报任务保存不改状态（保持未开启/已暂停）；仅当本次编辑来自「开启」动作时置为待执行
  if (!isSystemTask(t) || enableAfterSave.value) data.status = 'pending';
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
    await loadRecentRuns();
    if (createdId !== null) selectedTaskId.value = createdId;
  } catch (e: any) { alert('操作失败: ' + (e.message || e)); }
}

async function runTask(task: AiTask) {
  try {
    await API.task.execute(task.id);
    await loadTasks();
    await loadRecentRuns();
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
    if (selectedTaskId.value === deletingTask.value.id) backToOverview();
    try { await API.task.remove(deletingTask.value.id); await loadTasks(); await loadRecentRuns(); } catch {}
  } else if (deletingProject.value) {
    try { await API.project.delete(deletingProject.value.id); await loadProjects(); await loadTasks(); } catch {}
  }
  showDeleteModal.value = false;
}

// ========== 渲染工具 ==========
const renderMarkdown = (content: string) => {
  if (!content) return '';
  return marked(content, { async: false }) as string;
};

const isSystemTask = (t: AiTask) => t.task_type === 'daily_report';
const isTaskOn = (t: AiTask) => t.status === 'pending' || t.status === 'in_progress';
/** 立即执行入口：循环/定时任务随时可手动跑；now 型任务最近一次失败后可重跑 */
const canRun = (t: AiTask) => t.trigger_type !== 'now' || t.last_status === 'FAILED';

function taskBadgeText(t: AiTask): string {
  if (isSystemTask(t) && !t.project_id) return '未开启';
  return statusText(t.status);
}

function statusText(status: string): string {
  switch (status) {
    case 'pending': return '待执行';
    case 'in_progress': return '执行中';
    case 'paused': return '已暂停';
    case 'done': return '已完成';
    default: return status;
  }
}

/**
 * 开启/暂停循环任务。内置日报任务未绑定笔记库时不允许直接开启，
 * 转入编辑弹窗选库，保存（enableAfterSave）后自动纳入调度。
 */
async function toggleTask(t: AiTask) {
  try {
    if (isTaskOn(t)) {
      await API.task.update(t.id, { status: 'paused' });
    } else if (isSystemTask(t) && !t.project_id) {
      enableAfterSave.value = true;
      editTask(t);
      return;
    } else {
      await API.task.update(t.id, { status: 'pending' });
    }
  } catch (e: any) { alert('操作失败: ' + (e.message || e)); return; }
  await loadTasks();
}

function getTriggerText(task: AiTask): string {
  const type = '📚 知识';
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
    case 'followup': return '追问';
    default: return type;
  }
}

/** 详情「执行计划」：执行方式 */
function triggerWayText(t: AiTask): string {
  if (t.trigger_type === 'once') return '指定时间执行一次';
  if (t.trigger_type === 'cycle') return '定时循环执行';
  return '立即执行';
}

/** 详情「执行计划」：循环规则（每周几 / 每月几号 / Cron / 每天） */
function cycleRuleText(t: AiTask): string {
  const time = t.cycle_time ? ' ' + t.cycle_time : '';
  if (t.cycle_type === 'weekly') return '每周' + weekDaysText(t.cycle_value) + time;
  if (t.cycle_type === 'monthly') return '每月 ' + (t.cycle_value || '') + ' 号' + time;
  if (t.cycle_type === 'cron') return 'Cron：' + (t.cycle_value || '');
  return '每天' + time;
}

function weekDaysText(v: any): string {
  const names: Record<string, string> = { '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六', '0': '日' };
  return String(v || '').split(',').filter(Boolean).map((d: string) => names[d] || d).join('、');
}

function onTaskChanged() { loadTasks(); loadRecentRuns(); }

async function onGateReady() {
  await loadProjects();
}

onMounted(async () => {
  await Promise.all([loadProjects(), loadTasks()]);
  notesLoaded.value = true;
  loadRecentRuns();
  window.electronAPI?.on?.('task:changed', onTaskChanged);
});

onBeforeUnmount(() => {
  window.electronAPI?.removeAllListeners?.('task:changed');
});
</script>

<style scoped>
.planner-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.planner-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

/* ========== 综合页 ========== */
.ov-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 22px;
}
.ov-scroll .sec-label { margin: 18px 0 8px; }
.statline {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.statline b { color: var(--text-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.statline b.acc { color: var(--primary); }
.statline .warm b { color: var(--warning); }

.list-panel { display: flex; flex-direction: column; }
.file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
  cursor: pointer;
}
.file-row:first-child { border-top: none; }
.file-row > svg { color: var(--primary); flex-shrink: 0; }
.file-row > .status-badge { flex-shrink: 0; }
.file-row:hover { background: var(--primary-soft); }
.plan-tx { flex: 1; min-width: 0; }
.plan-tx b { display: block; font-size: 12.5px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-tx small { display: block; font-size: 11px; color: var(--text-muted); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty-row { font-size: 12px; color: var(--text-muted); padding: 14px; text-align: center; }

/* 任务卡片网格 */
.task-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 12px;
}
.task-grid .empty-row { grid-column: 1 / -1; background: var(--surface); border: 1px dashed var(--border); border-radius: var(--radius-md); }
.task-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.task-card:hover { border-color: rgba(var(--primary-rgb), 0.4); box-shadow: var(--shadow-sm); }
.task-card.running { border-color: var(--primary); }
.tc-head { display: flex; align-items: center; gap: 8px; }
.tc-title { flex: 1; min-width: 0; font-size: 13.5px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-meta { display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; color: var(--text-muted); }
.tc-last { font-size: 11px; color: var(--text-muted); border-top: 1px dashed var(--border); padding-top: 6px; }
.tc-actions { display: flex; gap: 6px; flex-wrap: wrap; }


/* ========== 右：任务详情 ========== */
.task-detail-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-main);
  overflow: hidden;
}

.detail-header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex-shrink: 0;
  background: var(--surface);
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

.detail-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }

.detail-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

/* 执行计划（循环信息）网格 */
.plan-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 18px;
}
.plan-item { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.plan-k { font-size: 11px; color: var(--text-muted); }
.plan-v { font-size: 13px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.detail-section {
  background: var(--surface);
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

.empty-sub { font-size: 13px; color: var(--text-muted); }

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
  cursor: pointer;
}

.exec-expand { margin-left: auto; font-size: 11px; color: var(--primary); flex-shrink: 0; }

.exec-brief {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.exec-trigger, .exec-time { font-size: 12px; color: var(--text-muted); }

.exec-error {
  font-size: 13px;
  color: var(--danger);
  margin-bottom: 8px;
  white-space: pre-wrap;
  word-break: break-all;
}

.exec-result {
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--bg-main);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  max-height: 400px;
  overflow-y: auto;
  line-height: 1.6;
}

/* ========== 通用 ========== */
.btn-xs { padding: 4px 10px; font-size: 12px; }

.running-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--primary); animation: pulse 1s infinite;
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

.status-pending { background: rgba(251, 146, 60, 0.1); color: var(--warning); }
.status-in_progress { background: rgba(59, 130, 246, 0.1); color: var(--primary); }
.status-done { background: rgba(34, 197, 94, 0.1); color: var(--success); }
.status-paused { background: rgba(148, 163, 184, 0.15); color: var(--text-muted); }
.status-SUCCESS { background: rgba(34, 197, 94, 0.1); color: var(--success); }
.status-FAILED { background: rgba(239, 68, 68, 0.1); color: var(--danger); }
.status-RUNNING { background: rgba(59, 130, 246, 0.1); color: var(--primary); }

/* ========== 模态框 ========== */
.modal-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000;
}
.modal-box {
  background: var(--surface); border-radius: var(--radius-md); box-shadow: 0 10px 25px rgba(0,0,0,0.1);
  max-width: 90%; max-height: 90vh; overflow-y: auto; width: 520px;
}
.modal-box-lg { width: 640px; }
.modal-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
.modal-header h3 { font-size: 16px; font-weight: 600; }
.modal-body { padding: 20px; }
.modal-footer { padding: 16px 20px; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: flex-end; gap: 8px; }

.form-group { margin-bottom: 16px; }
.form-group label { display: block; font-size: 13px; font-weight: 500; color: var(--text-secondary); margin-bottom: 6px; }
.form-control { width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 14px; outline: none; background: var(--surface); }
.form-control:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(var(--primary-rgb),0.1); }
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
:deep(.markdown-body code) { background: var(--hover); padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
:deep(.markdown-body pre) { background: var(--code-bg); color: var(--code-fg); padding: 12px 16px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
:deep(.markdown-body pre code) { background: none; padding: 0; color: inherit; }
:deep(.markdown-body blockquote) { border-left: 3px solid var(--primary); padding-left: 12px; color: var(--text-secondary); margin: 8px 0; }
:deep(.markdown-body strong) { font-weight: 600; }
:deep(.markdown-body a) { color: var(--primary); text-decoration: none; }
:deep(.markdown-body a:hover) { text-decoration: underline; }
:deep(.markdown-body h1), :deep(.markdown-body h2), :deep(.markdown-body h3), :deep(.markdown-body h4) { margin: 12px 0 6px; font-weight: 600; }
:deep(.markdown-body h1) { font-size: 1.3em; }
:deep(.markdown-body h2) { font-size: 1.15em; }
:deep(.markdown-body h3) { font-size: 1.05em; }
:deep(.markdown-body table) { border-collapse: collapse; margin: 8px 0; width: 100%; }
:deep(.markdown-body th), :deep(.markdown-body td) { border: 1px solid var(--border); padding: 6px 10px; text-align: left; font-size: 13px; }
:deep(.markdown-body th) { background: var(--bg-main); font-weight: 600; }
:deep(.markdown-body hr) { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
</style>
