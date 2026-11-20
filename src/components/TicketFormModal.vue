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

const { customFields, statusOptions, typeOptions, sourceOptions, save: saveTicket, blankForm } = useTickets();

const form = ref<Record<string, any>>(blankForm());

// 打开时同步表单：editingId 为空 → 空白新建；有 initial → 复制编辑
watch(() => props.show, (v) => {
  if (!v) return;
  const base = blankForm();
  if (props.initial) {
    for (const k of Object.keys(base)) base[k] = props.initial[k] != null ? String(props.initial[k]) : '';
  }
  form.value = base;
});

function close(): void { emit('close'); }

async function save(): Promise<void> {
  if (!form.value.标题?.trim()) return;
  await saveTicket(form.value, props.editingId);
  close();
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
</style>
