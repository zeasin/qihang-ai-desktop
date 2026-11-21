<template>
  <div v-if="show" class="modal-overlay" @click="close">
    <div class="modal-box modal-box-ticket" @click.stop>
      <div class="modal-header">
        <h3>{{ editingId ? '编辑工单' : '新建工单' }}</h3>
        <button class="icon-btn" @click="close"><AppIcon name="x" :size="16" /></button>
      </div>
      <div class="modal-body">
        <!-- 核心字段（固定） -->
        <div class="form-group">
          <label>标题 <em class="req">*</em></label>
          <input v-model="form.标题" class="form-control" type="text" placeholder="一句话说清这件事" @keyup.enter="save">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>类型</label>
            <select v-model="form.类型" class="form-control">
              <option value="">未指定</option>
              <option v-for="t in typeOptions" :key="t" :value="t">{{ t }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>来源</label>
            <select v-model="form.来源" class="form-control">
              <option value="">未指定</option>
              <option v-for="s in sourceOptions" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>新建人</label>
            <input v-model="form.新建人" class="form-control" type="text" placeholder="谁提的">
          </div>
          <div class="form-group">
            <label>处理人</label>
            <input v-model="form.处理人" class="form-control" type="text" placeholder="谁跟进">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>状态</label>
            <select v-model="form.状态" class="form-control">
              <option v-for="s in statusOptions" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>承诺时间 <em class="hint">到点自动提醒</em></label>
            <input v-model="form.承诺时间" class="form-control" type="datetime-local">
          </div>
        </div>
        <div class="form-group">
          <label>内容</label>
          <textarea v-model="form.内容" class="form-control" rows="3" placeholder="描述、背景、诉求…"></textarea>
        </div>
        <div class="form-group">
          <label>备注</label>
          <textarea v-model="form.备注" class="form-control" rows="2" placeholder="处理进展、跟进记录（可追加）"></textarea>
        </div>

        <!-- 关联待办（工单 ↔ 待办联动） -->
        <div class="form-group" v-if="editingId">
          <label>关联待办 <em class="hint">工单进入终态时自动收尾；退回流转态自动复活</em></label>
          <div class="linked-list" v-if="linkedTodos.length">
            <div class="linked-item" v-for="td in linkedTodos" :key="td.id">
              <button
                class="todo-box"
                :class="{ done: td.status === 'done' }"
                :title="td.status === 'done' ? '标记为未完成' : '标记完成'"
                @click="toggleLinkedTodo(td)"
              >
                <AppIcon v-if="td.status === 'done'" name="check" :size="11" />
              </button>
              <span class="linked-title" :class="{ through: td.status === 'done' }">{{ td.title }}</span>
              <button class="linked-x" title="解除关联" @click="unlinkLinkedTodo(td)"><AppIcon name="x" :size="11" /></button>
            </div>
          </div>
          <div class="linked-add">
            <input
              v-model="newTodoTitle"
              class="form-control"
              type="text"
              placeholder="拆一条待办（回车新增）…"
              @keyup.enter="addLinkedTodo"
            >
            <button class="btn btn-secondary btn-sm" :disabled="!newTodoTitle.trim()" @click="addLinkedTodo">新增待办</button>
          </div>
        </div>

        <!-- 处理记录（新建/状态变化/流转自动留痕） -->
        <div class="form-group" v-if="editingId">
          <label>处理记录 <em class="hint">新建、状态变化、流转自动留痕</em></label>
          <div class="log-add">
            <input
              v-model="newLogNote"
              class="form-control"
              type="text"
              placeholder="补一条处理说明（回车记录）…"
              @keyup.enter="addLogNote"
            >
            <button class="btn btn-secondary btn-sm" :disabled="!newLogNote.trim()" @click="addLogNote">记录</button>
          </div>
          <div class="log-list" v-if="ticketLogs.length">
            <div class="log-item" v-for="lg in ticketLogs" :key="lg.id">
              <span class="log-dot" :class="'log-' + lg.action"></span>
              <div class="log-main">
                <div class="log-title">{{ logText(lg) }}</div>
                <div class="log-time">{{ lg.created_at }}</div>
              </div>
            </div>
          </div>
          <div class="log-empty" v-else>还没有处理记录</div>
        </div>

        <!-- 自定义字段（在「工单设置」里增删，这里只填写） -->
        <div class="custom-fields" v-if="customFields.length">
          <div class="cf-label">自定义字段 <em class="hint">在右上角「工单设置」里管理</em></div>
          <div class="form-row" v-for="cf in customFields" :key="cf.name">
            <div class="form-group">
              <label>{{ cf.displayName || cf.name }}</label>
              <input v-model="form[cf.name]" class="form-control" type="text" :placeholder="cf.placeholder || ''">
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" @click="close">取消</button>
        <button class="btn btn-primary" :disabled="!form.标题?.trim()" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 工单表单弹窗（TicketFormModal）
 * 新建/编辑工单的统一入口。数据与 schema 逻辑在 useTickets 组合式函数里，
 * 这里只管表单状态与弹窗开关。
 */
import { ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { useTickets } from '@/composables/useTickets';

const props = defineProps<{ show: boolean; editingId: number | null; initial?: Record<string, any> | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const {
  customFields, statusOptions, typeOptions, sourceOptions,
  save: saveTicket, blankForm,
  ticketLogs, linkedTodos, loadLogs, loadLinkedTodos,
  addLogNote: addLogNoteApi, createTodo, unlinkTodo, toggleTodo,
} = useTickets();

const form = ref<Record<string, any>>(blankForm());
const newLogNote = ref('');
const newTodoTitle = ref('');

/** 当前编辑的工单（日志/关联待办都挂在它身上） */
function currentTicket(): any {
  return props.initial ? { id: props.editingId, ...props.initial } : null;
}

/** 处理记录一行文案（与主进程 ticket-tracker 的 action 对齐） */
function logText(lg: any): string {
  const from = String(lg.from_value || '');
  const to = String(lg.to_value || '');
  switch (lg.action) {
    case 'create': return to ? `新建工单「${to}」` : '新建工单';
    case 'delete': return from ? `删除工单（原「${from}」）` : '删除工单';
    case 'status': return `状态变化：${from || '（空）'} → ${to}`;
    case 'note': return String(lg.note || '备注');
    case 'link_todo': return `关联待办：${to}`;
    case 'unlink_todo': return `解除关联待办：${from}`;
    default: return lg.field ? `${lg.field}变更：${from || '（空）'} → ${to}` : String(lg.note || '更新');
  }
}

// 打开时同步表单：editingId 为空 → 空白新建；有 initial → 复制编辑 + 载入日志/关联待办
watch(() => props.show, (v) => {
  if (!v) return;
  const base = blankForm();
  if (props.initial) {
    for (const k of Object.keys(base)) base[k] = props.initial[k] != null ? String(props.initial[k]) : '';
  }
  form.value = base;
  newLogNote.value = '';
  newTodoTitle.value = '';
  if (props.editingId) {
    const t = currentTicket();
    void loadLogs(t);
    void loadLinkedTodos(t);
  }
});

function close(): void { emit('close'); }

async function save(): Promise<void> {
  if (!form.value.标题?.trim()) return;
  await saveTicket(form.value, props.editingId);
  close();
}

async function addLogNote(): Promise<void> {
  const t = currentTicket();
  const note = newLogNote.value.trim();
  if (!t || !note) return;
  const ok = await addLogNoteApi(t, note);
  if (!ok) { alert('记录失败'); return; }
  newLogNote.value = '';
}

async function addLinkedTodo(): Promise<void> {
  const t = currentTicket();
  const title = newTodoTitle.value.trim();
  if (!t || !title) return;
  await createTodo(t, title, { priority: 'mid' });
  newTodoTitle.value = '';
}

async function unlinkLinkedTodo(td: any): Promise<void> {
  await unlinkTodo(currentTicket(), td.id);
}

async function toggleLinkedTodo(td: any): Promise<void> {
  await toggleTodo(currentTicket(), td.id, td.status !== 'done');
}
</script>

<style scoped>
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
.modal-box-ticket { width: 620px; }
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
.icon-btn { background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 4px; }
.cf-label .hint { font-size: 11px; color: var(--text-muted); font-style: normal; margin-left: 6px; }

.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 13px; font-weight: 500; color: var(--text-secondary); margin-bottom: 4px; }
.form-group .req { color: #dc2626; }
.form-group .hint { color: var(--text-tertiary); font-style: normal; margin-left: 6px; font-weight: 400; }
.form-row { display: flex; gap: 12px; }
.form-row .form-group { flex: 1; }
textarea.form-control { resize: vertical; }

.custom-fields { border-top: 1px dashed var(--border); padding-top: 10px; margin-top: 6px; }
.cf-label { font-size: 12px; color: var(--text-tertiary); margin-bottom: 8px; }

/* ========== 关联待办 ========== */
.linked-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.linked-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
.linked-title { flex: 1; min-width: 0; font-size: 12.5px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.linked-title.through { color: var(--text-muted); text-decoration: line-through; }
.linked-x { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 2px; flex-shrink: 0; }
.linked-x:hover { color: var(--danger); }
.linked-add { display: flex; gap: 8px; }
.linked-add .form-control { flex: 1; }
.todo-box {
  width: 15px; height: 15px;
  border: 1.5px solid var(--text-muted);
  border-radius: 5px;
  background: none;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: #fff; flex-shrink: 0; padding: 0;
}
.todo-box:hover { border-color: var(--primary); }
.todo-box.done { background: var(--primary); border-color: var(--primary); }

/* ========== 处理记录（日志流） ========== */
.log-add { display: flex; gap: 8px; margin-bottom: 8px; }
.log-add .form-control { flex: 1; }
.log-list {
  display: flex; flex-direction: column;
  max-height: 220px; overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.log-item { display: flex; align-items: flex-start; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--border); }
.log-item:last-child { border-bottom: none; }
.log-dot {
  width: 7px; height: 7px; border-radius: 50%;
  margin-top: 5px; flex-shrink: 0;
  background: var(--text-muted);
}
.log-dot.log-create { background: var(--primary); }
.log-dot.log-status { background: var(--warning); }
.log-dot.log-note { background: var(--success, #16a34a); }
.log-dot.log-link_todo { background: var(--primary); }
.log-dot.log-unlink_todo { background: var(--text-muted); }
.log-dot.log-delete { background: var(--danger); }
.log-main { flex: 1; min-width: 0; }
.log-title { font-size: 12px; color: var(--text-primary); line-height: 1.45; word-break: break-all; }
.log-time { font-size: 10.5px; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px; }
.log-empty { font-size: 12px; color: var(--text-muted); padding: 10px; text-align: center; border: 1px dashed var(--border); border-radius: var(--radius-sm); }
</style>
