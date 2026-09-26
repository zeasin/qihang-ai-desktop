<template>
  <div class="notes-gate" :class="{ compact }">
    <div class="gate-card">
      <div class="gate-icon">📚</div>
      <div class="gate-title">请先配置笔记库</div>
      <div class="gate-desc">
        <template v-if="desc">{{ desc }}</template>
        <template v-else>
          笔记库是本应用所有 AI 功能的数据基础。<br />
          未配置时，AI 对话、任务执行、日报生成、知识库浏览均不可用。
        </template>
      </div>
      <div class="gate-actions">
        <button class="btn btn-primary" :disabled="saving" @click="setupNotesDir">
          {{ saving ? '正在保存...' : '📂 选择笔记库目录' }}
        </button>
        <button class="btn btn-secondary" @click="goConfig">⚙️ 前往设置</button>
      </div>
      <div class="gate-note" v-if="!compact">数据集、提醒、日志等功能不受影响；配置后立即生效，无需重启</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const API = window.electronAPI;
const router = useRouter();

withDefaults(defineProps<{ compact?: boolean; desc?: string }>(), {
  compact: false,
  desc: '',
});

const emit = defineEmits<{ (e: 'ready', dir: string): void }>();

const saving = ref(false);

async function setupNotesDir() {
  try {
    const dir = await API.dialog.openDirectory();
    if (!dir) return;
    saving.value = true;
    await API.kb.setDir(dir);
    emit('ready', dir);
  } catch (e: any) {
    alert('配置失败: ' + (e.message || e));
  } finally {
    saving.value = false;
  }
}

function goConfig() {
  router.push('/config');
}
</script>

<style scoped>
.notes-gate {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: var(--bg-main);
}

.gate-card {
  width: 100%;
  max-width: 480px;
  text-align: center;
  background: #ffffff;
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 36px 32px 26px;
  box-shadow: 0 4px 20px rgba(15, 23, 42, 0.06);
}

.notes-gate.compact {
  flex: none;
  padding: 0;
  background: transparent;
}

.notes-gate.compact .gate-card {
  max-width: none;
  padding: 24px 20px 18px;
  border-radius: 12px;
}

.notes-gate.compact .gate-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.notes-gate.compact .gate-title {
  font-size: 15px;
}

.notes-gate.compact .gate-desc {
  margin-bottom: 16px;
}

.gate-icon {
  font-size: 44px;
  margin-bottom: 12px;
}

.gate-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 10px;
}

.gate-desc {
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-muted);
  margin-bottom: 22px;
}

.gate-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  margin-bottom: 16px;
}

.gate-note {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
