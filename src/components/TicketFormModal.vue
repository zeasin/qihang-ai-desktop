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
            <label>处理人 <em class="hint">与「处理人节点」同名即触发 webhook 通知</em></label>
            <input v-model="form.处理人" class="form-control" type="text" list="handlerNames" placeholder="谁跟进">
            <datalist id="handlerNames">
              <option v-for="h in handlers" :key="h.id" :value="h.name">{{ h.webhook_url ? '已配通知' : '未配通知' }}</option>
            </datalist>
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
        <!-- 处理结果：编辑时改了状态，带上本次处理结果（写入流转节点账） -->
        <div class="form-group" v-if="editingId && statusChanged">
          <label>处理结果 <em class="hint">随状态变化记入流转账，会随通知一起发出</em></label>
          <input v-model="flowResult" class="form-control" type="text" placeholder="这一步做了什么、结论是什么（可留空）">
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

        <!-- 流转历史（ticket_flow_nodes 时间轴：每个节点一行，可回放整个生命周期） -->
        <div class="form-group" v-if="editingId">
          <label>流转历史 <em class="hint">每个节点一行：状态 · 处理人 · 停留时长 · 处理结果</em></label>
          <div class="flow-list" v-if="flowNodes.length">
            <div class="flow-item" v-for="(n, i) in flowNodes" :key="n.id">
              <div class="flow-rail" :class="{ last: i === flowNodes.length - 1 }"><span class="flow-dot" :class="{ open: !n.exited_at }"></span></div>
              <div class="flow-main">
                <div class="flow-head">
                  <span class="flow-status">{{ n.status || '（空）' }}</span>
                  <span class="flow-handler" v-if="n.handler_name">· {{ n.handler_name }}</span>
                  <span class="flow-open" v-if="!n.exited_at">当前节点</span>
                  <span class="flow-time">{{ n.entered_at }}</span>
                </div>
                <div class="flow-meta">
                  <span v-if="n.exited_at && n.duration_minutes != null">停留 {{ durationText(n.duration_minutes) }}</span>
                  <span v-if="n.exited_at && n.result">结果：{{ n.result }}</span>
                  <span v-if="!n.exited_at">进入节点至今</span>
                </div>
                <div class="flow-notify" v-if="n.notified === 1">已通知 {{ n.handler_name || '' }}</div>
                <div class="flow-notify fail" v-else-if="n.notified === -1" :title="n.notify_error">通知失败：{{ n.notify_error || '未知原因' }}</div>
              </div>
            </div>
          </div>
          <div class="log-empty" v-else>还没有流转记录</div>
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
import { ref, watch, computed } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { useTickets } from '@/composables/useTickets';

const props = defineProps<{ show: boolean; editingId: number | null; initial?: Record<string, any> | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const {
  customFields, statusOptions, typeOptions, sourceOptions,
  save: saveTicket, blankForm,
  ticketLogs, linkedTodos, loadLogs, loadLinkedTodos,
  flowNodes, loadFlowNodes, handlers, loadHandlers,
  addLogNote: addLogNoteApi, createTodo, unlinkTodo, toggleTodo,
} = useTickets();

const form = ref<Record<string, any>>(blankForm());
const newLogNote = ref('');
const newTodoTitle = ref('');
/** 处理结果：随状态变化一起写入库 + 发通知 */
const flowResult = ref('');
/** 打开表单时记下原状态，用于检测「本次编辑改了状态」 */
const origStatus = ref('');

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

/** 本次编辑是否改了状态（决定「处理结果」输入框是否出现） */
const statusChanged = computed(() => props.editingId != null && String(form.value.状态 || '').trim() !== origStatus.value);

/** 停留时长文案 */
function durationText(m: number): string {
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  if (h < 48) return h + ' 小时';
  return Math.round(h / 24) + ' 天';
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
  flowResult.value = '';
  origStatus.value = String(base['状态'] || '').trim();
  void loadHandlers();   // 处理人 datalist 需要
  if (props.editingId) {
    const t = currentTicket();
    void loadLogs(t);
    void loadLinkedTodos(t);
    void loadFlowNodes(t);
  }
});

function close(): void { emit('close'); }

async function save(): Promise<void> {
  if (!form.value.标题?.trim()) return;
  // 状态变了 → 把「处理结果」并进备注尾部，供流转引擎写节点账 + 随通知发出
  if (props.editingId && statusChanged.value && flowResult.value.trim()) {
    const remark = String(form.value.备注 || '').trim();
    form.value.备注 = remark ? remark + '；结果：' + flowResult.value.trim() : '结果：' + flowResult.value.trim();
  }
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

/* ========== 流转历史（节点时间轴） ========== */
.flow-list {
  display: flex; flex-direction: column;
  max-height: 260px; overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 8px 10px;
}
.flow-item { display: flex; gap: 8px; }
.flow-rail { display: flex; flex-direction: column; align-items: center; width: 12px; flex-shrink: 0; }
.flow-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-muted); flex-shrink: 0; margin-top: 5px;
}
.flow-dot.open { background: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.flow-rail::after { content: ''; flex: 1; width: 1px; background: var(--border); margin-top: 2px; }
.flow-rail.last::after { display: none; }
.flow-main { flex: 1; min-width: 0; padding-bottom: 10px; }
.flow-head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.flow-status { font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
.flow-handler { font-size: 11.5px; color: var(--text-secondary); }
.flow-open { font-size: 10px; color: var(--primary); border: 1px solid var(--primary); border-radius: 8px; padding: 0 6px; }
.flow-time { font-size: 10.5px; color: var(--text-muted); font-family: var(--font-mono); margin-left: auto; }
.flow-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11.5px; color: var(--text-tertiary); margin-top: 2px; }
.flow-notify { font-size: 10.5px; color: var(--success, #16a34a); margin-top: 1px; }
.flow-notify.fail { color: var(--danger); word-break: break-all; }
</style>
