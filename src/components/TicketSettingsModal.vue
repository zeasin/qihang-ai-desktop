<template>
  <div v-if="show" class="modal-overlay" @click="close">
    <div class="modal-box modal-box-settings" @click.stop>
      <div class="modal-header">
        <h3>工单设置</h3>
        <button class="icon-btn" @click="close"><AppIcon name="x" :size="16" /></button>
      </div>
      <div class="modal-body">
        <!-- 类型枚举 -->
        <div class="set-sec">
          <div class="set-title">类型</div>
          <div class="chip-row">
            <span v-for="t in typeOptions" :key="t" class="chip">
              {{ t }}
              <button class="chip-x" title="删除" @click="removeEnum('type', t)"><AppIcon name="x" :size="10" /></button>
            </span>
            <input v-model="newType" class="chip-input" type="text" placeholder="加类型…" @keyup.enter="addEnum('type')">
          </div>
        </div>

        <!-- 来源枚举 -->
        <div class="set-sec">
          <div class="set-title">来源</div>
          <div class="chip-row">
            <span v-for="s in sourceOptions" :key="s" class="chip">
              {{ s }}
              <button class="chip-x" title="删除" @click="removeEnum('source', s)"><AppIcon name="x" :size="10" /></button>
            </span>
            <input v-model="newSource" class="chip-input" type="text" placeholder="加来源…" @keyup.enter="addEnum('source')">
          </div>
        </div>

        <!-- 状态枚举 -->
        <div class="set-sec">
          <div class="set-title">状态 <em class="hint">「待处理 / 处理中 / 已完成 / 已关闭」是保留状态，不可删除——流转规则都挂在它们身上</em></div>
          <div class="chip-row">
            <span v-for="s in statusOptions" :key="s" class="chip" :class="{ locked: isReserved(s), terminal: isTerminal(s) }">
              {{ s }}
              <span v-if="isReserved(s)" class="chip-lock" title="保留状态，不可删除">🔒</span>
              <template v-else>
                <button
                  v-if="!isFixedTerminal(s)"
                  class="chip-flag"
                  :class="{ on: isTerminal(s) }"
                  :title="isTerminal(s) ? '终态：盖完结时间、停止提醒（点一下取消）' : '标记为终态：盖完结时间、停止提醒'"
                  @click="toggleTerminal(s)"
                >{{ isTerminal(s) ? '终' : '流' }}</button>
                <span v-else class="chip-flag on" title="名称含终态词，默认按终态处理">终</span>
                <button class="chip-x" title="删除" @click="removeEnum('status', s)"><AppIcon name="x" :size="10" /></button>
              </template>
            </span>
            <input v-model="newStatus" class="chip-input" type="text" placeholder="加状态…" @keyup.enter="addEnum('status')">
          </div>
          <p class="set-note">流转顺序：待处理 → 处理中 →（自定义）→ 已完成 → 已关闭。自定义状态填在中间就是流转态；点「流」变「终」即终态（结束后盖完结时间、停止承诺提醒）。</p>
        </div>

        <!-- 处理人节点（人=名字+webhook一体；流转/指派到该节点时触发通知） -->
        <div class="set-sec">
          <div class="set-title">处理人节点 <em class="hint">流转/指派到某节点时，通知到该节点的 webhook；名字与工单「处理人」字段对齐</em></div>
          <div class="handler-list" v-if="handlers.length">
            <div class="handler-row" v-for="h in handlers" :key="h.id" :class="{ off: !h.enabled }">
              <input v-model="h.name" class="handler-name" type="text" placeholder="节点名（如 张三 / 售前组）" @blur="saveHandler(h)">
              <input v-model="h.webhook_url" class="handler-webhook" type="text" placeholder="webhook url（飞书/钉钉/企微…）" @blur="saveHandler(h)">
              <button class="handler-toggle" :class="{ on: !!h.enabled }" :title="h.enabled ? '停用该节点' : '启用该节点'" @click="toggleHandler(h)">{{ h.enabled ? '开' : '关' }}</button>
              <button class="chip-x" title="删除节点（历史节点账不受影响）" @click="removeHandlerRow(h)"><AppIcon name="trash-2" :size="12" /></button>
            </div>
          </div>
          <div class="handler-add">
            <input v-model="newHandlerName" class="chip-input handler-input" type="text" placeholder="节点名…" @keyup.enter="addHandlerRow">
            <input v-model="newHandlerWebhook" class="chip-input handler-input handler-webhook-new" type="text" placeholder="webhook url（可选）" @keyup.enter="addHandlerRow">
            <button class="btn btn-secondary btn-sm" :disabled="!newHandlerName.trim()" @click="addHandlerRow">添加节点</button>
          </div>
          <p class="set-note">「处理人」字段填了/改了谁，匹配到这里的节点且有 webhook 就通知谁——与状态无关。删掉节点不影响已有工单的流转历史（历史靠名字冗余留存）。</p>
        </div>

        <!-- 自定义字段 -->
        <div class="set-sec">
          <div class="set-title">自定义字段 <em class="hint">核心字段（标题/内容/状态等）固定不可改</em></div>
          <div class="chip-row">
            <span v-for="cf in customFields" :key="cf.name" class="chip">
              {{ cf.displayName || cf.name }}
              <button class="chip-x" title="删除" @click="removeField(cf.name)"><AppIcon name="x" :size="10" /></button>
            </span>
            <input v-model="newField" class="chip-input" type="text" placeholder="加字段…" @keyup.enter="addField">
          </div>
          <p class="set-note">删除枚举或字段不会改动已有工单记录里的值，只影响新建/编辑时的可选项。</p>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" @click="close">完成</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 工单设置弹窗（TicketSettingsModal）
 * 集中管理工单的类型 / 来源 / 状态枚举与自定义字段。
 * 改动即时写入数据集 schema（persistSchema），工单表单下次打开即生效。
 */
import { ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { useTickets, RESERVED_STATUSES, isFixedTerminal } from '@/composables/useTickets';

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { typeOptions, sourceOptions, statusOptions, customFields, addEnumOption, removeEnumOption, addCustomField, removeCustomField, toggleTerminalStatus, isTerminalStatus, handlers, loadHandlers, addHandler, updateHandler, removeHandler } = useTickets();

const newType = ref('');
const newSource = ref('');
const newStatus = ref('');
const newField = ref('');
const newHandlerName = ref('');
const newHandlerWebhook = ref('');

watch(() => props.show, (v) => {
  if (!v) return;
  newType.value = ''; newSource.value = ''; newStatus.value = ''; newField.value = '';
  newHandlerName.value = ''; newHandlerWebhook.value = '';
  void loadHandlers();
});

/** 保留状态：不可删除 */
function isReserved(s: string): boolean { return RESERVED_STATUSES.includes(s); }
/** 是否终态 */
function isTerminal(s: string): boolean { return isTerminalStatus(s); }

function addEnum(which: 'type' | 'source' | 'status'): void {
  const input = which === 'type' ? newType : which === 'source' ? newSource : newStatus;
  if (addEnumOption(which, input.value)) input.value = '';
}

function removeEnum(which: 'type' | 'source' | 'status', v: string): void {
  removeEnumOption(which, v);
}

/** 切换自定义状态的终态标记 */
function toggleTerminal(v: string): void {
  toggleTerminalStatus(v);
}

function addField(): void {
  if (addCustomField(newField.value)) newField.value = '';
}

function removeField(name: string): void { removeCustomField(name); }

// ========== 处理人节点 ==========

async function addHandlerRow(): Promise<void> {
  const name = newHandlerName.value.trim();
  if (!name) return;
  const r = await addHandler({ name, webhook_url: newHandlerWebhook.value.trim() });
  if (r && r.ok) {
    newHandlerName.value = '';
    newHandlerWebhook.value = '';
  } else {
    alert((r && r.error) || '添加失败');
  }
}

async function saveHandler(h: any): Promise<void> {
  await updateHandler(h.id, { name: String(h.name || '').trim(), webhook_url: String(h.webhook_url || '') });
}

async function toggleHandler(h: any): Promise<void> {
  await updateHandler(h.id, { enabled: !h.enabled });
}

async function removeHandlerRow(h: any): Promise<void> {
  if (!confirm('删除处理人节点「' + h.name + '」？（历史流转账不受影响）')) return;
  await removeHandler(h.id);
}

function close(): void { emit('close'); }
</script>

<style scoped>
.modal-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5);
  display: flex; justify-content: center; align-items: center;
  z-index: 1000;
}
.modal-box {
  background: var(--surface);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  max-width: 90%;
  max-height: 90vh;
  overflow-y: auto;
  width: 560px;
}
.modal-box-settings { width: 560px; }
.modal-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
}
.modal-header h3 { font-size: 16px; font-weight: 600; }
.modal-body { padding: 20px; }
.modal-footer {
  padding: 16px 20px;
  border-top: 1px solid var(--border);
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
}
.icon-btn { background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 4px; }

.set-sec { margin-bottom: 18px; }
.set-title { font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
.set-title .hint { font-size: 11.5px; font-weight: 400; color: var(--text-muted); margin-left: 8px; }
.set-note { font-size: 11.5px; color: var(--text-muted); margin-top: 8px; }

.chip-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 4px 10px;
  border-radius: 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-size: 12.5px; color: var(--text-primary);
}
.chip.locked { opacity: 0.85; }
.chip.terminal { border-color: var(--primary); }
.chip-flag {
  background: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 10px;
  line-height: 1;
  padding: 2px 4px;
  color: var(--text-muted);
  cursor: pointer;
}
.chip-flag:hover { color: var(--primary); border-color: var(--primary); }
.chip-flag.on { border-color: var(--primary); color: var(--primary); }
.chip-x {
  background: none; border: none; cursor: pointer; padding: 0;
  color: var(--text-muted); display: flex; align-items: center;
}
.chip-x:hover { color: var(--danger); }
.chip-lock { font-size: 10px; }
.chip-input {
  border: 1px dashed var(--border);
  border-radius: 12px;
  background: none;
  font: inherit; font-size: 12.5px;
  color: var(--text-primary);
  padding: 4px 10px;
  width: 100px;
  outline: none;
}
.chip-input:focus { border-color: var(--primary); }

/* ========== 处理人节点 ========== */
.handler-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.handler-row {
  display: grid;
  grid-template-columns: 120px 1fr auto auto;
  gap: 6px;
  align-items: center;
}
.handler-row.off { opacity: 0.55; }
.handler-name, .handler-webhook {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
  padding: 5px 8px;
  outline: none;
  min-width: 0;
}
.handler-name:focus, .handler-webhook:focus { border-color: var(--primary); }
.handler-add { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
.handler-input { width: 110px; }
.handler-webhook-new { flex: 1; min-width: 220px; }
.handler-toggle {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: 11px;
  padding: 3px 8px;
  cursor: pointer;
  flex-shrink: 0;
}
.handler-toggle.on { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); }
</style>
